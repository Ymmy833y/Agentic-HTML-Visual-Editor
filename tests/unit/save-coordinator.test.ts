// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DOCUMENT_REPLACE_TIMEOUT_MS,
  HOST_TO_VIEW_MESSAGE_TYPE,
  RESPONSE_TIMEOUT_MS,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import type {
  BodyOutputResponseMessage,
  DocumentApplyOutcome,
  DocumentReplacedMessage,
  HostToViewMessage,
  LineEnding,
  MessageKey,
} from '../../common/index';
import { EditHistoryCoordinator } from '../../src/history/edit-history-coordinator';
import { BUFFER_FOLLOW_POLL_MS, BUFFER_FOLLOW_TIMEOUT_MS } from '../../src/save/buffer-follow';
import { DocumentSyncState } from '../../src/save/document-sync-state';
import { SaveCoordinator } from '../../src/save/save-coordinator';
import type {
  DocumentState,
  SaveHost,
  SaveOutcome,
  SourceChangeTrigger,
} from '../../src/save/save-coordinator';

const DOCUMENT_URI = 'file:///workspace/a.html';
const DESTINATION_URI = 'file:///workspace/b.html';

const DISK_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>a</p>\n</body>\n</html>\n';
const VIEW_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>ab</p>\n</body>\n</html>\n';
// Source modified outside the extension. It differs from both the written full text and the previous source.
const EXTERNAL_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>external</p>\n</body>\n</html>\n';

// Three merge inputs. Place a line between the two paragraphs so that these cases stay about changes that are apart.
const BASE_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>first</p>\n<hr>\n<p>second</p>\n</body>\n</html>\n';
const SOURCE_EDITED_TEXT = BASE_TEXT.replace('<p>first</p>', '<p>FIRST</p>');
const VIEW_EDITED_TEXT = BASE_TEXT.replace('<p>second</p>', '<p>SECOND</p>');
const MERGED_TEXT = SOURCE_EDITED_TEXT.replace('<p>second</p>', '<p>SECOND</p>');

/**
 * Replaces line endings with CRLF.
 *
 * @param text LF-delimited text.
 */
function asCrlf(text: string): string {
  return text.replace(/\n/g, '\r\n');
}

/** How the view answers output requests and document replacements, imitating a real view's behavior. */
type ViewBehavior =
  // Returns output and accepts the replacement.
  | 'responds'
  // Cannot produce output and cannot replace the document.
  | 'unavailable'
  // Return output but reject full-document application because of unsaved content.
  | 'rejectsUnsaved'
  // Return output but do not respond to full-document application, simulating a lost response.
  | 'applyStalls'
  // The output response carries a value that is neither a string nor null.
  | 'invalidOutput'
  // Sending the output request itself fails.
  | 'sendFails'
  // Returns nothing: the view has stopped responding.
  | 'silent';

/** The record of one write. */
interface WriteRecord {
  readonly uri: string;
  readonly text: string;
}

interface Harness {
  readonly coordinator: SaveCoordinator;
  /** Record of the history port, which is always installed, as in production. */
  readonly history: HistoryPortRecord;
  /** The messages sent to the view, in send order. */
  readonly sent: HostToViewMessage[];
  /** The destinations written to and their content, in write order. */
  readonly written: WriteRecord[];
  /** The lines emitted to the diagnostic log. */
  readonly logLines: string[];
  /** The message keys used for notifications. */
  readonly notifications: MessageKey[];
  /** Message keys used for success notices. */
  readonly informations: MessageKey[];
  /** The causes handed to the dirty text buffer notice, in order. */
  readonly dirtyNotices: string[];
  /** Closes every dirty text buffer notice that is still open. */
  closeDirtyNotices(): void;
  /** How many times a change event was fired. */
  readChangeCount(): number;
  /** How many times the text buffer was read. */
  readBufferReadCount(): number;
  readonly state: DocumentState;
  /** Document sync state. */
  readonly syncState: DocumentSyncState;
  /** Kinds and full text received in full-document application requests, in receive order. */
  readonly applied: { kind: string; text: string }[];
  /**
   * Returns, in receive order, the full text carried by application requests of the specified kind.
   *
   * @param kind Application kind to retrieve.
   */
  appliedOfKind(kind: string): string[];
  setViewBehavior(behavior: ViewBehavior): void;
  setViewText(text: string): void;
  setBuffer(text: string, isDirty: boolean): void;
  setWriteFailing(failing: boolean): void;
  setBufferReadable(readable: boolean): void;
  /** Installs an observation point called immediately before writing. */
  setWriteObserver(observe: () => void): void;
  /** Installs an interceptor called on every text buffer read. */
  setBufferReadObserver(observe: () => void): void;
  /** Toggles whether file reads fail. */
  setFileReadable(readable: boolean): void;
  /** Replaces the full text of the file read next. */
  setFileText(text: string): void;
  /** Holds the save committed or save released send until it is released. */
  holdRoundTripEnd(): () => void;
  /** Enqueues one change notification and waits for its reconciliation to finish. */
  reconcile(trigger: SourceChangeTrigger): Promise<void>;
}

/**
 * Assembles the save coordinator together with stand-ins for the view, the disk, and the text buffer.
 *
 * The stand-in view answers differently depending on the type of message it receives. Having no such
 * branch would diverge further from the real environment, so this one branch lives in the stand-in.
 */
function createHarness(): Harness {
  const sent: HostToViewMessage[] = [];
  const written: WriteRecord[] = [];
  const logLines: string[] = [];
  const notifications: MessageKey[] = [];
  const informations: MessageKey[] = [];
  const dirtyNotices: string[] = [];
  // A real notification settles only when the user closes it, so each notice stays open until the test closes it.
  const dirtyNoticeClosers: (() => void)[] = [];

  let changeCount = 0;
  let bufferReadCount = 0;
  let behavior: ViewBehavior = 'responds';
  let viewText = VIEW_TEXT;
  let bufferText = DISK_TEXT;
  let bufferDirty = false;
  let bufferReadable = true;
  let writeFailing = false;
  let observeWrite = (): void => undefined;
  let observeBufferRead = (): void => undefined;
  let fileReadable = true;
  let fileText = DISK_TEXT;
  let releaseRoundTripEnd: (() => void) | undefined;

  let lastKnownContent: string | undefined;
  let lineEnding: LineEnding = 'lf';
  const syncState = new DocumentSyncState();
  const applied: { kind: string; text: string }[] = [];

  const state: DocumentState = {
    syncState,
    get lastKnownContent(): string | undefined {
      return lastKnownContent;
    },
    retainUnsavedContent: (text) => {
      lastKnownContent = text;
    },
    clearUnsavedContent: () => {
      lastKnownContent = undefined;
    },
    get lineEnding(): LineEnding {
      return lineEnding;
    },
    set lineEnding(value: LineEnding) {
      lineEnding = value;
    },
  };

  let coordinator: SaveCoordinator | undefined;

  const host: SaveHost = {
    writeFile: (uri, text) => {
      observeWrite();
      if (writeFailing) {
        return Promise.reject(new Error('The file could not be written'));
      }
      written.push({ uri, text });
      fileText = text;
      return Promise.resolve();
    },
    readFile: () => (fileReadable
      ? Promise.resolve(fileText)
      : Promise.reject(new Error('The file could not be read'))),
    readTextBuffer: () => {
      bufferReadCount += 1;
      observeBufferRead();
      if (!bufferReadable) {
        return Promise.reject(new Error('The text buffer could not be opened'));
      }
      return Promise.resolve({ text: bufferText, isDirty: bufferDirty });
    },
    postToView: async (message) => {
      sent.push(message);

      if (
        message.type === HOST_TO_VIEW_MESSAGE_TYPE.saveCommitted
        || message.type === HOST_TO_VIEW_MESSAGE_TYPE.saveReleased
      ) {
        await new Promise<void>((resolve) => {
          if (releaseRoundTripEnd === undefined) {
            resolve();
            return;
          }
          releaseRoundTripEnd = resolve;
        });
        return;
      }

      if (behavior === 'silent') {
        return;
      }

      if (message.type === HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput) {
        if (behavior === 'sendFails') {
          throw new Error('The webview could not be reached');
        }
        // A real view can send values that violate the type, so carry the out-of-contract value as is.
        const text: unknown = behavior === 'invalidOutput' ? 42 : behavior === 'unavailable' ? null : viewText;
        const response = {
          type: VIEW_TO_HOST_MESSAGE_TYPE.bodyOutputResponse,
          requestId: message.requestId,
          text,
        } as BodyOutputResponseMessage;
        queueMicrotask(() => coordinator?.settleResponse(response));
        return;
      }

      if (message.type === HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument) {
        applied.push({ kind: message.kind, text: message.text });
        if (behavior === 'applyStalls') {
          return;
        }
        const outcome: DocumentApplyOutcome = behavior === 'responds'
          ? 'applied'
          : behavior === 'rejectsUnsaved'
            ? 'rejectedUnsaved'
            : 'failed';
        const response: DocumentReplacedMessage = {
          type: VIEW_TO_HOST_MESSAGE_TYPE.documentReplaced,
          requestId: message.requestId,
          outcome,
        };
        queueMicrotask(() => coordinator?.settleResponse(response));
      }
    },
    notifyDocumentChanged: () => {
      changeCount += 1;
    },
    reportInternalError: (detail) => {
      logLines.push(detail);
    },
    reportUserError: (key) => {
      notifications.push(key);
      return Promise.resolve();
    },
    reportUserInformation: (key) => {
      informations.push(key);
      return Promise.resolve();
    },
    reportDirtyTextBuffer: (cause) => {
      dirtyNotices.push(cause);
      return new Promise<void>((resolve) => {
        dirtyNoticeClosers.push(resolve);
      });
    },
  };

  coordinator = new SaveCoordinator(DOCUMENT_URI, state, host);
  // Production wiring always installs it before any save entry point runs, so install it by default too.
  const history = installHistoryPort(coordinator);

  return {
    coordinator,
    history,
    sent,
    written,
    logLines,
    notifications,
    informations,
    dirtyNotices,
    closeDirtyNotices: () => {
      for (const close of dirtyNoticeClosers.splice(0)) {
        close();
      }
    },
    readChangeCount: () => changeCount,
    readBufferReadCount: () => bufferReadCount,
    state,
    syncState,
    applied,
    appliedOfKind: (kind) =>
      applied.filter((request) => request.kind === kind).map((request) => request.text),
    setViewBehavior: (value) => {
      behavior = value;
    },
    setViewText: (text) => {
      viewText = text;
    },
    setBuffer: (text, isDirty) => {
      bufferText = text;
      bufferDirty = isDirty;
    },
    setWriteFailing: (failing) => {
      writeFailing = failing;
    },
    setBufferReadable: (readable) => {
      bufferReadable = readable;
    },
    setWriteObserver: (observe) => {
      observeWrite = observe;
    },
    setBufferReadObserver: (observe) => {
      observeBufferRead = observe;
    },
    setFileReadable: (readable) => {
      fileReadable = readable;
    },
    setFileText: (text) => {
      fileText = text;
    },
    reconcile: async (trigger) => {
      coordinator?.receiveSourceChangeNotice(trigger);
      // Reconciliation is enqueued and has no return value. One turn after enqueueing, a path with no remaining wait
      // reaches completion.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    holdRoundTripEnd: () => {
      // A marker until the real releaser is installed; it is swapped on every send.
      releaseRoundTripEnd = () => undefined;
      return () => {
        const release = releaseRoundTripEnd;
        releaseRoundTripEnd = undefined;
        release?.();
      };
    },
  };
}

/** Stands in for a token that has not been cancelled. */
const notCancelled = (): boolean => false;

/** Stands in for a token that has already been cancelled. */
const alreadyCancelled = (): boolean => true;

/**
 * Picks out only the messages of the given type.
 *
 * @param sent The messages that were sent.
 * @param type The type to pick out.
 */
function messagesOfType(sent: readonly HostToViewMessage[], type: string): HostToViewMessage[] {
  return sent.filter((message) => message.type === type);
}

describe('requesting output', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('overwrites the last known content with the whole text of a body output response', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);

    await harness.coordinator.save(notCancelled);

    expect(harness.state.lastKnownContent).toBe(VIEW_TEXT);
  });

  it('writes nothing and leaves the last known content unchanged when no response arrives in time', async () => {
    const harness = createHarness();
    harness.setViewBehavior('silent');

    const saving = harness.coordinator.save(notCancelled);
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS);

    expect([await saving, harness.written, harness.state.lastKnownContent]).toEqual([
      'failed',
      [],
      undefined,
    ]);
  });
});

describe('writing to the file', () => {
  it('fails without writing when the operation is already cancelled just before the write', async () => {
    const harness = createHarness();

    const outcome = await harness.coordinator.save(alreadyCancelled);

    expect([outcome, harness.written]).toEqual(['failed', []]);
  });

  it('records one line in the diagnostic log with the cause when the write fails', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.setWriteFailing(true);

    await harness.coordinator.save(notCancelled);

    expect(harness.logLines).toEqual([
      `Failed to write ${DOCUMENT_URI}: Error: The file could not be written`,
    ]);
  });

  it('restores a candidate to CRLF when the resolved source uses CRLF', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.setBuffer(DISK_TEXT.replace(/\n/g, '\r\n'), false);

    await harness.coordinator.save(notCancelled);

    expect(harness.written).toEqual([
      { uri: DOCUMENT_URI, text: VIEW_TEXT.replace(/\n/g, '\r\n') },
    ]);
  });

  it('does not write and retains the save retry base when canceled immediately before writing', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    // Cancellation is checked immediately before view application and immediately before writing. Make it canceled
    // from the second check onward because cancellation before application would not set the save retry base.
    let checks = 0;
    const cancelledBeforeWrite = (): boolean => {
      checks += 1;
      return checks > 1;
    };

    const outcome = await harness.coordinator.save(cancelledBeforeWrite);

    expect([outcome, harness.written, harness.syncState.saveRetryBase]).toEqual([
      'failed',
      [],
      DISK_TEXT,
    ]);
  });

  it('keeps the sync base and write reconcile unchanged and retains the retry base when writing fails', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.setWriteFailing(true);

    await harness.coordinator.save(notCancelled);

    expect([
      harness.syncState.syncBase,
      harness.syncState.writeReconcile,
      harness.syncState.saveRetryBase,
    ]).toEqual([DISK_TEXT, undefined, DISK_TEXT]);
  });

  it('sets the write reconcile to the written full text and previous source after a successful write', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);

    await harness.coordinator.save(notCancelled);

    const reconcile = harness.syncState.writeReconcile;
    expect([reconcile?.writtenBody, reconcile?.previousSource]).toEqual([VIEW_TEXT, DISK_TEXT]);
  });
});

describe('signalling the end of a round trip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends exactly one save committed message carrying no written body when the write succeeds', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);

    await harness.coordinator.save(notCancelled);

    expect(messagesOfType(harness.sent, HOST_TO_VIEW_MESSAGE_TYPE.saveCommitted)).toEqual([
      { type: HOST_TO_VIEW_MESSAGE_TYPE.saveCommitted },
    ]);
  });

  it('sends a save released message carrying a resend instruction when it ends without receiving the output', async () => {
    const harness = createHarness();
    harness.setViewBehavior('unavailable');

    await harness.coordinator.save(notCancelled);

    expect(messagesOfType(harness.sent, HOST_TO_VIEW_MESSAGE_TYPE.saveReleased)).toEqual([
      { type: HOST_TO_VIEW_MESSAGE_TYPE.saveReleased, resendUnsavedContent: true },
    ]);
  });

  it('puts no resend instruction on the save released message sent after a failed write', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.setWriteFailing(true);

    await harness.coordinator.save(notCancelled);

    expect(messagesOfType(harness.sent, HOST_TO_VIEW_MESSAGE_TYPE.saveReleased)).toEqual([
      { type: HOST_TO_VIEW_MESSAGE_TYPE.saveReleased, resendUnsavedContent: false },
    ]);
  });
});

describe('the queued unit of a save', () => {
  it('returns the outcome without waiting for the save committed send, and ends the queued unit afterwards', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    const release = harness.holdRoundTripEnd();

    const outcome = await harness.coordinator.save(notCancelled);
    // Queue the next save before the save committed send has finished. While the unit is still
    // running, no output is requested yet.
    const following = harness.coordinator.save(notCancelled);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const requestsDuringCommit = messagesOfType(
      harness.sent,
      HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput,
    ).length;

    release();
    await following;

    expect([outcome, requestsDuringCommit, messagesOfType(harness.sent, HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput).length])
      .toEqual(['completed', 1, 2]);
  });
});

describe('save as', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes the same path as a save and sends a save committed message when the destination is the original file', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);

    const outcome = await harness.coordinator.saveAs(DOCUMENT_URI, notCancelled);

    expect([outcome, harness.written, messagesOfType(harness.sent, HOST_TO_VIEW_MESSAGE_TYPE.saveCommitted).length])
      .toEqual(['completed', [{ uri: DOCUMENT_URI, text: VIEW_TEXT }], 1]);
  });

  it('sends only a save released message, not a save committed one, on success to a different URI', async () => {
    const harness = createHarness();

    await harness.coordinator.saveAs(DESTINATION_URI, notCancelled);

    expect([
      messagesOfType(harness.sent, HOST_TO_VIEW_MESSAGE_TYPE.saveCommitted),
      messagesOfType(harness.sent, HOST_TO_VIEW_MESSAGE_TYPE.saveReleased),
    ]).toEqual([[], [{ type: HOST_TO_VIEW_MESSAGE_TYPE.saveReleased, resendUnsavedContent: false }]]);
  });

  it('never records a last written body on success to a different URI, because the original file is not written', async () => {
    const harness = createHarness();

    await harness.coordinator.saveAs(DESTINATION_URI, notCancelled);

    expect(harness.written).toEqual([{ uri: DESTINATION_URI, text: VIEW_TEXT }]);
  });

  it('closes the queue after success to a different URI, so the next save fails without running', async () => {
    const harness = createHarness();
    await harness.coordinator.saveAs(DESTINATION_URI, notCancelled);
    const requestsBefore = messagesOfType(
      harness.sent,
      HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput,
    ).length;

    const outcome = await harness.coordinator.save(notCancelled);

    expect([
      outcome,
      messagesOfType(harness.sent, HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput).length,
    ]).toEqual(['failed', requestsBefore]);
  });
});

describe('Revert', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the last known content and re-detects the line ending when the ack arrives', async () => {
    const harness = createHarness();
    harness.coordinator.receiveUnsavedContent(VIEW_TEXT, false);
    harness.setBuffer(DISK_TEXT.replace(/\n/g, '\r\n'), false);

    const outcome = await harness.coordinator.revert(notCancelled);

    expect([outcome, harness.state.lastKnownContent, harness.state.lineEnding]).toEqual([
      'completed',
      undefined,
      'crlf',
    ]);
  });

  it('sends the whole re-read text on the replace document message', async () => {
    const harness = createHarness();
    harness.setBuffer(DISK_TEXT.replace(/\n/g, '\r\n'), false);

    await harness.coordinator.revert(notCancelled);

    expect(
      messagesOfType(harness.sent, HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument).map((message) =>
        'text' in message ? message.text : undefined,
      ),
    ).toEqual([DISK_TEXT]);
  });

  it('fails on an ack saying nothing was applied, keeping the last known content', async () => {
    const harness = createHarness();
    harness.state.retainUnsavedContent(VIEW_TEXT);
    harness.setBuffer(DISK_TEXT.replace(/\n/g, '\r\n'), false);
    harness.setViewBehavior('unavailable');

    const outcome = await harness.coordinator.revert(notCancelled);

    expect([outcome, harness.state.lastKnownContent, harness.readChangeCount()]).toEqual([
      'failed',
      VIEW_TEXT,
      0,
    ]);
    expect(harness.history.reverts).toEqual([{ succeeded: false, text: VIEW_TEXT }]);
  });

  it('reads the file on disk instead of the dirty text buffer and completes the revert with its content', async () => {
    const harness = createHarness();
    harness.setBuffer(VIEW_TEXT, true);
    harness.setFileText(EXTERNAL_TEXT);

    const outcome = await harness.coordinator.revert(notCancelled);

    expect([
      outcome,
      messagesOfType(harness.sent, HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument).map((message) =>
        'text' in message ? message.text : undefined,
      ),
      harness.notifications,
      harness.history.reverts,
    ]).toEqual(['completed', [EXTERNAL_TEXT], [], [{ succeeded: true, text: EXTERNAL_TEXT }]]);
  });

  it('normalizes a CRLF file on disk and re-detects the line ending when the text buffer is dirty', async () => {
    const harness = createHarness();
    harness.setBuffer(VIEW_TEXT, true);
    harness.setFileText(DISK_TEXT.replace(/\n/g, '\r\n'));

    await harness.coordinator.revert(notCancelled);

    expect([harness.appliedOfKind('revert'), harness.state.lineEnding]).toEqual([[DISK_TEXT], 'crlf']);
  });

  it('fails without sending the replacement when the text buffer is dirty and the file on disk cannot be read', async () => {
    const harness = createHarness();
    harness.setBuffer(DISK_TEXT, true);
    harness.setFileReadable(false);

    const outcome = await harness.coordinator.revert(notCancelled);

    expect([
      outcome,
      messagesOfType(harness.sent, HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument),
      harness.notifications,
      harness.readChangeCount(),
      harness.history.reverts.length,
    ]).toEqual(['failed', [], ['revertFailed.message'], 0, 1]);
  });

  it('fails and sends no replace document message when the text buffer cannot be read', async () => {
    const harness = createHarness();
    harness.setBufferReadable(false);

    const outcome = await harness.coordinator.revert(notCancelled);

    expect([outcome, messagesOfType(harness.sent, HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument)]).toEqual([
      'failed',
      [],
    ]);
  });

  it('fails without sending the replacement when the revert is already cancelled just before it', async () => {
    const harness = createHarness();

    const outcome = await harness.coordinator.revert(alreadyCancelled);

    expect([outcome, messagesOfType(harness.sent, HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument)]).toEqual([
      'failed',
      [],
    ]);
  });

  it('keeps re-reading until the buffer matches while a last written body is still held', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    await harness.coordinator.save(notCancelled);
    const readsAfterSave = harness.readBufferReadCount();

    const reverting = harness.coordinator.revert(notCancelled);
    await vi.advanceTimersByTimeAsync(BUFFER_FOLLOW_POLL_MS * 3);
    const readsWhileWaiting = harness.readBufferReadCount();
    harness.setBuffer(VIEW_TEXT, false);
    await vi.advanceTimersByTimeAsync(BUFFER_FOLLOW_POLL_MS * 2);

    expect([await reverting, readsWhileWaiting > readsAfterSave + 1]).toEqual(['completed', true]);
  });

  it('notifies recovery steps and retains the write reconcile when the previous source remains until timeout', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    await harness.coordinator.save(notCancelled);

    const reverting = harness.coordinator.revert(notCancelled);
    await vi.advanceTimersByTimeAsync(BUFFER_FOLLOW_TIMEOUT_MS + BUFFER_FOLLOW_POLL_MS);

    expect([
      await reverting,
      harness.notifications,
      harness.syncState.writeReconcile !== undefined,
    ]).toEqual(['failed', ['bufferFollowTimeout.message'], true]);
  });
});

describe('receiving messages from the view', () => {
  it('fires no change event for a view edited message arriving between accepting a revert and its ack', async () => {
    const harness = createHarness();

    const reverting = harness.coordinator.revert(notCancelled);
    harness.coordinator.receiveEditNotice();
    await reverting;

    expect(harness.readChangeCount()).toBe(0);
  });

  it('fires a view edited message arriving after the ack again once the outcome has been returned', async () => {
    const harness = createHarness();
    await harness.coordinator.revert(notCancelled);

    harness.coordinator.receiveEditNotice();
    const beforeSettling = harness.readChangeCount();
    await Promise.resolve();
    await Promise.resolve();

    expect([beforeSettling, harness.readChangeCount()]).toEqual([0, 1]);
  });

  it('only retains unsaved content carrying a resend marker, firing no change event', () => {
    const harness = createHarness();

    harness.coordinator.receiveUnsavedContent(VIEW_TEXT, true);

    expect([harness.state.lastKnownContent, harness.readChangeCount()]).toEqual([VIEW_TEXT, 0]);
  });

  it('retains unmarked unsaved content and then fires a change event', () => {
    const harness = createHarness();

    harness.coordinator.receiveUnsavedContent(VIEW_TEXT, false);

    expect([harness.state.lastKnownContent, harness.readChangeCount()]).toEqual([VIEW_TEXT, 1]);
  });

  it('discards a body output response tied to no current request and adds one line to the diagnostic log', () => {
    const harness = createHarness();

    const settled = harness.coordinator.settleResponse({
      type: VIEW_TO_HOST_MESSAGE_TYPE.bodyOutputResponse,
      requestId: '99',
    });

    expect([settled, harness.logLines.length]).toEqual([false, 1]);
  });
});

describe('disposing the save coordinator', () => {
  it('releases pending requests and fails the operations left in the queue when disposed mid round trip', async () => {
    const harness = createHarness();
    harness.setViewBehavior('silent');

    const running = harness.coordinator.save(notCancelled);
    const queued = harness.coordinator.save(notCancelled);
    harness.coordinator.dispose();

    expect([await running, await queued]).toEqual(['failed', 'failed']);
  });

  it('does nothing on a second dispose', () => {
    const harness = createHarness();

    harness.coordinator.dispose();

    expect(() => harness.coordinator.dispose()).not.toThrow();
  });
});

describe('accepting source change triggers', () => {
  it('does not begin reconciling a change notice received during Save until Save completes', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    const release = harness.holdRoundTripEnd();

    await harness.coordinator.save(notCancelled);
    const readsWhileSaving = harness.readBufferReadCount();
    harness.coordinator.receiveSourceChangeNotice('textBufferChange');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const readsBeforeRelease = harness.readBufferReadCount();

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect([readsBeforeRelease, harness.readBufferReadCount() > readsWhileSaving]).toEqual([
      readsWhileSaving,
      true,
    ]);
  });

  it('does not read the buffer or leave a pending wait for a change notice after disposal', async () => {
    const harness = createHarness();
    harness.coordinator.dispose();
    const readsBefore = harness.readBufferReadCount();

    harness.coordinator.receiveSourceChangeNotice('textBufferChange');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.readBufferReadCount()).toBe(readsBefore);
  });
});

describe('source-change reconciliation', () => {
  it('clears the write reconcile without requesting replacement when the source matches the written full text', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    await harness.coordinator.save(notCancelled);
    harness.setBuffer(VIEW_TEXT, false);

    await harness.reconcile('textBufferChange');

    expect([harness.appliedOfKind('externalChange'), harness.syncState.writeReconcile]).toEqual([
      [],
      undefined,
    ]);
  });

  it('requests nothing when the source matches the sync base and is therefore a duplicate', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);

    await harness.reconcile('textBufferChange');

    expect(harness.applied).toEqual([]);
  });

  it('clears the write reconcile and accepts a source differing from both texts as a later external change', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    await harness.coordinator.save(notCancelled);
    harness.setBuffer(EXTERNAL_TEXT, false);

    await harness.reconcile('textBufferChange');

    expect([harness.appliedOfKind('externalChange'), harness.syncState.writeReconcile]).toEqual([
      [EXTERNAL_TEXT],
      undefined,
    ]);
  });

  it('does not replace, save, or add a diagnostic log entry when the text buffer is dirty', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.setBuffer(EXTERNAL_TEXT, true);

    // This path receives a notification for every keystroke. Recording each one would hide real failures in the
    // diagnostic log.
    await harness.reconcile('textBufferChange');
    await harness.reconcile('textBufferChange');

    expect([harness.applied, harness.logLines]).toEqual([[], []]);
  });

  it('sends one notification without changing the sync base when the buffer cannot be read', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.setBufferReadable(false);

    await harness.reconcile('textBufferChange');

    expect([harness.notifications, harness.syncState.syncBase]).toEqual([
      ['syncFailed.message'],
      DISK_TEXT,
    ]);
  });

  it('updates only the current line ending without requesting replacement when only line endings differ', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.setBuffer(asCrlf(DISK_TEXT), false);

    await harness.reconcile('textBufferChange');

    expect([harness.applied, harness.state.lineEnding]).toEqual([[], 'crlf']);
  });
});

describe('text buffer while waiting for buffer follow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reverts to the just-written full text from disk without accepting later buffer text when the buffer becomes dirty while waiting', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    await harness.coordinator.save(notCancelled);
    const written = harness.written[harness.written.length - 1].text;

    const reverting = harness.coordinator.revert(notCancelled);
    await vi.advanceTimersByTimeAsync(0);
    harness.setBuffer(EXTERNAL_TEXT, true);
    await vi.advanceTimersByTimeAsync(BUFFER_FOLLOW_POLL_MS);

    expect([
      await reverting,
      harness.appliedOfKind('revert'),
      harness.notifications,
    ]).toEqual(['completed', [written], []]);
  });

  it('clears the write reconcile once a revert that found the buffer dirty while waiting has applied the disk content', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    await harness.coordinator.save(notCancelled);

    const reverting = harness.coordinator.revert(notCancelled);
    await vi.advanceTimersByTimeAsync(0);
    harness.setBuffer(DISK_TEXT, true);
    await vi.advanceTimersByTimeAsync(BUFFER_FOLLOW_POLL_MS);
    await reverting;

    expect(harness.syncState.writeReconcile).toBeUndefined();
  });
});

// A write empties the file before writing the content, so a buffer reloaded in between holds only the start of it.
describe('a source read mid-write', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits past an empty source and clears the write reconcile without replacing the view or entering protection', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    await harness.coordinator.save(notCancelled);
    harness.setBuffer('', false);
    // A view cannot open an empty document, so taking it as an external change would fail and enter protection.
    harness.setViewBehavior('unavailable');

    harness.coordinator.receiveSourceChangeNotice('textBufferChange');
    await vi.advanceTimersByTimeAsync(BUFFER_FOLLOW_POLL_MS);
    harness.setBuffer(VIEW_TEXT, false);
    await vi.advanceTimersByTimeAsync(BUFFER_FOLLOW_POLL_MS);

    expect([
      harness.appliedOfKind('externalChange'),
      harness.history.protections,
      harness.syncState.writeReconcile,
    ]).toEqual([[], [], undefined]);
  });

  it('waits past an empty source after a save that rewrites the same content', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.setViewText(DISK_TEXT);
    await harness.coordinator.save(notCancelled);
    harness.setBuffer('', false);
    harness.setViewBehavior('unavailable');

    harness.coordinator.receiveSourceChangeNotice('textBufferChange');
    await vi.advanceTimersByTimeAsync(BUFFER_FOLLOW_POLL_MS);
    harness.setBuffer(DISK_TEXT, false);
    await vi.advanceTimersByTimeAsync(BUFFER_FOLLOW_POLL_MS);

    expect([
      harness.appliedOfKind('externalChange'),
      harness.history.protections,
      harness.syncState.writeReconcile,
    ]).toEqual([[], [], undefined]);
  });

  it('merges the written full text, not a mid-write source, as the source of the next save', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    await harness.coordinator.save(notCancelled);
    const nextViewText = VIEW_TEXT.replace('<p>ab</p>', '<p>abc</p>');
    harness.setViewText(nextViewText);
    harness.setBuffer(VIEW_TEXT.slice(0, VIEW_TEXT.indexOf('</body>')), false);

    const saving = harness.coordinator.save(notCancelled);
    await vi.advanceTimersByTimeAsync(BUFFER_FOLLOW_POLL_MS);
    harness.setBuffer(VIEW_TEXT, false);
    await vi.advanceTimersByTimeAsync(BUFFER_FOLLOW_POLL_MS);

    expect([await saving, harness.written.map((record) => record.text)]).toEqual([
      'completed',
      [VIEW_TEXT, nextViewText],
    ]);
  });

  it('takes a source still mid-write at the timeout as a later external change', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    await harness.coordinator.save(notCancelled);
    harness.setBuffer('', false);

    harness.coordinator.receiveSourceChangeNotice('textBufferChange');
    await vi.advanceTimersByTimeAsync(BUFFER_FOLLOW_TIMEOUT_MS + BUFFER_FOLLOW_POLL_MS);

    expect([harness.appliedOfKind('externalChange'), harness.syncState.writeReconcile]).toEqual([
      [''],
      undefined,
    ]);
  });
});

describe('polling delayed buffer follow', () => {
  it('does not poll the buffer during initial reconciliation when no notification was missed', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);

    await harness.reconcile('initialReconcile');

    expect(harness.readBufferReadCount()).toBe(1);
  });

  it('does not poll for a file change at the same sync base after confirming buffer follow for a write', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    await harness.coordinator.save(notCancelled);
    harness.setBuffer(VIEW_TEXT, false);
    await harness.reconcile('textBufferChange');
    const readsAfterFollow = harness.readBufferReadCount();

    await harness.reconcile('fileChange');

    expect(harness.readBufferReadCount()).toBe(readsAfterFollow + 1);
  });

  describe('when a notification was missed', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('polls delayed buffer follow during initial reconciliation and catches a later external change', async () => {
      const harness = createHarness();
      // A notification received while the sync base is uninitialized cannot be reconciled because it has no comparison
      // base.
      harness.coordinator.receiveSourceChangeNotice('fileChange');
      await vi.advanceTimersByTimeAsync(0);
      harness.syncState.initialize(DISK_TEXT);

      harness.coordinator.receiveSourceChangeNotice('initialReconcile');
      await vi.advanceTimersByTimeAsync(0);
      harness.setBuffer(EXTERNAL_TEXT, false);
      await vi.advanceTimersByTimeAsync(BUFFER_FOLLOW_POLL_MS);

      expect(harness.appliedOfKind('externalChange')).toEqual([EXTERNAL_TEXT]);
    });
  });
});

describe('conditional replacement of an unedited view', () => {
  it('does not send a request to the view when the replacement-blocked flag is set', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.syncState.blockReplacement();
    harness.setBuffer(EXTERNAL_TEXT, false);

    await harness.reconcile('textBufferChange');

    expect(harness.applied).toEqual([]);
  });

  it('does not send a request for an external change after receiving an edit notice', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.coordinator.receiveEditNotice();
    harness.setBuffer(EXTERNAL_TEXT, false);

    await harness.reconcile('textBufferChange');

    expect(harness.applied).toEqual([]);
  });

  it('does not send a request to the view when a save retry base exists', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.syncState.beginSaveRetry(DISK_TEXT);
    harness.setBuffer(EXTERNAL_TEXT, false);

    await harness.reconcile('textBufferChange');

    expect(harness.applied).toEqual([]);
  });

  it('does not advance the sync base and sets the replacement-blocked flag after rejection for unsaved content', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.setViewBehavior('rejectsUnsaved');
    harness.setBuffer(EXTERNAL_TEXT, false);

    await harness.reconcile('textBufferChange');

    expect([harness.syncState.syncBase, harness.syncState.isReplacementBlocked]).toEqual([
      DISK_TEXT,
      true,
    ]);
  });

  it('sends one notification and reports to the history side on application failure', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.setViewBehavior('unavailable');
    harness.setBuffer(EXTERNAL_TEXT, false);

    await harness.reconcile('textBufferChange');

    expect([
      harness.notifications,
      harness.readChangeCount(),
      harness.history.protections.length,
    ]).toEqual([['documentApplyFailed.message'], 0, 1]);
  });

  it('updates the sync base and last known content and sends one release when applied', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.setBuffer(EXTERNAL_TEXT, false);

    await harness.reconcile('textBufferChange');

    expect([
      harness.syncState.syncBase,
      harness.state.lastKnownContent,
      messagesOfType(harness.sent, HOST_TO_VIEW_MESSAGE_TYPE.saveReleased),
    ]).toEqual([
      EXTERNAL_TEXT,
      EXTERNAL_TEXT,
      [{ type: HOST_TO_VIEW_MESSAGE_TYPE.saveReleased, resendUnsavedContent: false }],
    ]);
  });
});

describe('save candidate merge', () => {
  it('includes both changes when another source line changes during Save', async () => {
    const harness = createHarness();
    harness.syncState.initialize(BASE_TEXT);
    harness.setBuffer(SOURCE_EDITED_TEXT, false);
    harness.setViewText(VIEW_EDITED_TEXT);

    await harness.coordinator.save(notCancelled);

    expect(harness.written).toEqual([{ uri: DOCUMENT_URI, text: MERGED_TEXT }]);
  });

  it('uses the save retry base as the common ancestor without duplicating a region', async () => {
    const harness = createHarness();
    harness.syncState.initialize(BASE_TEXT);
    // Create the state in which the previous save applied to the view but only the write did not complete.
    harness.syncState.beginSaveRetry(SOURCE_EDITED_TEXT);
    harness.setBuffer(SOURCE_EDITED_TEXT, false);
    harness.setViewText(MERGED_TEXT);

    await harness.coordinator.save(notCancelled);

    expect(harness.written).toEqual([{ uri: DOCUMENT_URI, text: MERGED_TEXT }]);
  });

  it('fails without building a candidate or writing when the sync base is uninitialized', async () => {
    const harness = createHarness();

    const outcome = await harness.coordinator.save(notCancelled);

    expect([outcome, harness.written, harness.applied]).toEqual(['failed', [], []]);
  });

  it('fails without building a candidate or writing when the text buffer is dirty', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.setBuffer(DISK_TEXT, true);

    const outcome = await harness.coordinator.save(notCancelled);

    expect([outcome, harness.written, harness.applied]).toEqual(['failed', [], []]);
    // VS Code shows only its generic save failure, so the reason is told through the dirty text buffer notice.
    expect(harness.dirtyNotices).toEqual(['Skipped saving because the text buffer has unsaved edits']);
  });

  it('does not raise a second dirty text buffer notice while one is open, but still records the cause', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.setBuffer(DISK_TEXT, true);

    await harness.coordinator.save(notCancelled);
    await harness.coordinator.save(notCancelled);

    expect([harness.dirtyNotices.length, harness.logLines]).toEqual([
      1,
      ['Skipped saving because the text buffer has unsaved edits'],
    ]);
  });

  it('raises the dirty text buffer notice again once the previous one has closed', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.setBuffer(DISK_TEXT, true);

    await harness.coordinator.save(notCancelled);
    harness.closeDirtyNotices();
    // The closed notice is forgotten in a continuation of its promise, which runs after this turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.coordinator.save(notCancelled);

    expect(harness.dirtyNotices).toHaveLength(2);
  });
});

describe('the declared encoding of a saved document', () => {
  const SHIFT_JIS_DISK_TEXT = DISK_TEXT.replace('<html>\n', '<html>\n<head><meta charset="shift_jis"></head>\n');
  const SHIFT_JIS_VIEW_TEXT = VIEW_TEXT.replace('<html>\n', '<html>\n<head><meta charset="shift_jis"></head>\n');
  const UTF8_VIEW_TEXT = VIEW_TEXT.replace('<html>\n', '<html>\n<head><meta charset="utf-8"></head>\n');

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('declares UTF-8 in both the candidate applied to the view and the text written on a save', async () => {
    const harness = createHarness();
    harness.syncState.initialize(SHIFT_JIS_DISK_TEXT);
    harness.setBuffer(SHIFT_JIS_DISK_TEXT, false);
    harness.setViewText(SHIFT_JIS_VIEW_TEXT);

    await harness.coordinator.save(notCancelled);

    expect([harness.appliedOfKind('saveCandidate'), harness.written])
      .toEqual([[UTF8_VIEW_TEXT], [{ uri: DOCUMENT_URI, text: UTF8_VIEW_TEXT }]]);
  });

  it('declares UTF-8 in the text written by a save as to a different URI', async () => {
    const harness = createHarness();
    harness.setViewText(SHIFT_JIS_VIEW_TEXT);

    await harness.coordinator.saveAs(DESTINATION_URI, notCancelled);

    expect(harness.written).toEqual([{ uri: DESTINATION_URI, text: UTF8_VIEW_TEXT }]);
  });

  it('writes the retained copy of an unresponsive view without rewriting its declaration', async () => {
    const harness = createHarness();
    harness.syncState.initialize(SHIFT_JIS_DISK_TEXT);
    harness.setBuffer(SHIFT_JIS_DISK_TEXT, false);
    harness.state.retainUnsavedContent(SHIFT_JIS_VIEW_TEXT);
    harness.setViewBehavior('silent');
    connectHistory(harness);

    await runWhileViewSilent(() => harness.coordinator.save(notCancelled));

    expect(harness.written).toEqual([{ uri: DOCUMENT_URI, text: SHIFT_JIS_VIEW_TEXT }]);
  });
});

describe('applying a save candidate to the view', () => {
  it('does not write the file or change the sync base when the view returns application failure', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.setViewBehavior('unavailable');

    const outcome = await harness.coordinator.save(notCancelled);

    expect([outcome, harness.written, harness.syncState.syncBase]).toEqual([
      'failed',
      [],
      DISK_TEXT,
    ]);
  });

  it('sets the save retry base before writing after receiving applied', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    let retryBaseAtWrite: string | undefined;
    harness.setWriteObserver(() => {
      retryBaseAtWrite = harness.syncState.saveRetryBase;
    });

    await harness.coordinator.save(notCancelled);

    expect(retryBaseAtWrite).toBe(DISK_TEXT);
  });

  it('retains a merged save candidate as the last known content after a successful write', async () => {
    const harness = createHarness();
    harness.syncState.initialize(BASE_TEXT);
    harness.setBuffer(SOURCE_EDITED_TEXT, false);
    harness.setViewText(VIEW_EDITED_TEXT);

    await harness.coordinator.save(notCancelled);

    expect(harness.state.lastKnownContent).toBe(MERGED_TEXT);
  });

  it('retains a merged save candidate as the last known content when writing fails after application', async () => {
    const harness = createHarness();
    harness.syncState.initialize(BASE_TEXT);
    harness.setBuffer(SOURCE_EDITED_TEXT, false);
    harness.setViewText(VIEW_EDITED_TEXT);
    harness.setWriteFailing(true);

    await harness.coordinator.save(notCancelled);

    expect(harness.state.lastKnownContent).toBe(MERGED_TEXT);
  });
});

describe('full-document application outcome reconciliation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries the same request id and full text when no response arrives before timeout', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.setViewBehavior('applyStalls');

    const saving = harness.coordinator.save(notCancelled);
    await vi.advanceTimersByTimeAsync(0);
    harness.setViewBehavior('responds');
    await vi.advanceTimersByTimeAsync(DOCUMENT_REPLACE_TIMEOUT_MS);
    await saving;

    const requests = harness.sent.flatMap((message) =>
      message.type === HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument
        ? [{ requestId: message.requestId, text: message.text }]
        : [],
    );
    expect([requests.length, requests[0]]).toEqual([2, requests[1]]);
  });

  it('returns not applied and fails the operation when view ready arrives before the outcome is final', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.setViewBehavior('applyStalls');

    const saving = harness.coordinator.save(notCancelled);
    await vi.advanceTimersByTimeAsync(0);
    harness.coordinator.notifyViewRestarted();

    expect([await saving, harness.written]).toEqual(['failed', []]);
  });

  it('stops retrying and settles the wait when disposed during application', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.setViewBehavior('applyStalls');

    const saving = harness.coordinator.save(notCancelled);
    await vi.advanceTimersByTimeAsync(0);
    harness.coordinator.dispose();
    const requestsAtDispose = harness.applied.length;
    await vi.advanceTimersByTimeAsync(DOCUMENT_REPLACE_TIMEOUT_MS * 3);

    expect([await saving, harness.applied.length]).toEqual(['failed', requestsAtDispose]);
  });
});

/** Record of calls received by the history port, plus switches for the values it returns. */
interface HistoryPortRecord {
  /** Full texts passed to the pre-save check. */
  readonly confirmations: string[];
  /** Full texts passed as successful saves. */
  readonly saved: string[];
  readonly reverts: { succeeded: boolean; text: string | undefined }[];
  readonly protections: { reason: string; staleText: string | undefined }[];
  setConfirm(result: boolean): void;
  setHistoryEventDriven(driven: boolean): void;
}

/**
 * Installs a history port that only records.
 *
 * @param coordinator Save coordinator to install it on.
 * @returns Record of received calls.
 */
function installHistoryPort(coordinator: SaveCoordinator): HistoryPortRecord {
  const confirmations: string[] = [];
  const saved: string[] = [];
  const reverts: { succeeded: boolean; text: string | undefined }[] = [];
  const protections: { reason: string; staleText: string | undefined }[] = [];
  let confirm = true;
  let driven = false;

  coordinator.setHistoryPort({
    isHistoryEventDriven: () => driven,
    prepareSaveEndpoint: (text) => {
      confirmations.push(text);
      return Promise.resolve(confirm);
    },
    confirmSaveEndpoint: (text) => {
      confirmations.push(text);
      return confirm;
    },
    notifySaveSucceeded: (text) => saved.push(text),
    notifyRevertResult: (succeeded, text) => reverts.push({ succeeded, text }),
    reportProtection: (reason, staleText) => protections.push({ reason, staleText }),
  });

  return {
    confirmations,
    saved,
    reverts,
    protections,
    setConfirm: (value) => {
      confirm = value;
    },
    setHistoryEventDriven: (value) => {
      driven = value;
    },
  };
}

const RECORDED_SELECTION = {
  start: { line: 3, column: 0 },
  end: { line: 3, column: 4 },
};

// Only paths whose responses return in a microtask and never wait for buffer follow are covered, so these run on
// real time.
describe('connection to history', () => {
  it('does not write and returns a failure for a save that fails the history endpoint check', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.history.setConfirm(false);

    await expect(harness.coordinator.save(notCancelled)).resolves.toBe('failed');

    expect([harness.written, harness.history.confirmations]).toEqual([[], [VIEW_TEXT]]);
  });

  it('does not fire a history-less event from an edit notice while history events are enabled', () => {
    const harness = createHarness();
    harness.history.setHistoryEventDriven(true);

    harness.coordinator.receiveEditNotice();

    expect(harness.readChangeCount()).toBe(0);
  });

  it('advances the last known content to the candidate full text when the candidate is applied', async () => {
    const harness = createHarness();
    harness.syncState.initialize(BASE_TEXT);
    harness.setBuffer(BASE_TEXT, false);
    harness.setViewText(VIEW_EDITED_TEXT);

    const result = await harness.coordinator.applyHistoryTransition('undo', {
      before: { text: BASE_TEXT, selection: null },
      after: { text: VIEW_EDITED_TEXT, selection: null },
    });

    expect(result).toEqual({ kind: 'applied', text: BASE_TEXT });
    expect(harness.state.lastKnownContent).toBe(BASE_TEXT);
  });

  it('sends no request and leaves the sync state unchanged when source resolution fails', async () => {
    const harness = createHarness();
    harness.syncState.initialize(BASE_TEXT);
    harness.setViewText(VIEW_EDITED_TEXT);
    harness.setBufferReadable(false);

    const result = await harness.coordinator.applyHistoryTransition('undo', {
      before: { text: BASE_TEXT, selection: null },
      after: { text: VIEW_EDITED_TEXT, selection: null },
    });

    expect(result.kind).toBe('failed');
    expect([harness.appliedOfKind('editHistory'), harness.syncState.syncBase])
      .toEqual([[], BASE_TEXT]);
  });

  it('sends a target endpoint and edit range only with history application requests', async () => {
    const harness = createHarness();
    harness.syncState.initialize(BASE_TEXT);
    harness.setBuffer(BASE_TEXT, false);
    harness.setViewText(VIEW_EDITED_TEXT);

    await harness.coordinator.applyHistoryTransition('undo', {
      before: { text: BASE_TEXT, selection: RECORDED_SELECTION },
      after: { text: VIEW_EDITED_TEXT, selection: null },
    });
    await harness.coordinator.save(notCancelled);

    const replacements = messagesOfType(
      harness.sent,
      HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument,
    );
    expect(replacements[0]).toMatchObject({
      kind: 'editHistory',
      targetText: BASE_TEXT,
      targetSelection: RECORDED_SELECTION,
    });
    expect(Object.keys(replacements[1])).not.toContain('targetText');
  });

  it('hands a Revert failure to history-side protection instead of compensating with a history-less event', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    harness.history.setHistoryEventDriven(false);
    // A dirty text buffer sends the revert to the disk, and an unreadable file there is what makes it fail.
    harness.setBuffer(DISK_TEXT, true);
    harness.setFileReadable(false);

    await expect(harness.coordinator.revert(notCancelled)).resolves.toBe('failed');

    expect([harness.readChangeCount(), harness.history.reverts])
      .toEqual([0, [{ succeeded: false, text: undefined }]]);
  });

  it('hands an external replacement application failure to protection, but not a rejection due to unsaved edits', async () => {
    const rejecting = createHarness();
    rejecting.syncState.initialize(DISK_TEXT);
    rejecting.setBuffer(EXTERNAL_TEXT, false);
    rejecting.setViewBehavior('rejectsUnsaved');
    await rejecting.reconcile('fileChange');

    const failing = createHarness();
    failing.syncState.initialize(DISK_TEXT);
    failing.setBuffer(EXTERNAL_TEXT, false);
    failing.setViewBehavior('unavailable');
    await failing.reconcile('fileChange');

    expect(rejecting.history.protections).toEqual([]);
    expect(failing.history.protections).toHaveLength(1);
    expect(failing.readChangeCount()).toBe(0);
  });
});

/** A real edit history coordinator and the record of save successes passed to it. */
interface ConnectedHistory {
  readonly history: EditHistoryCoordinator;
  /** Full texts passed as save point updates. */
  readonly savePoints: string[];
}

/**
 * Connects a real edit history coordinator to the save side to verify the save endpoint confirmation conditions for real.
 *
 * @param harness The harness to connect to.
 */
function connectHistory(harness: Harness): ConnectedHistory {
  const savePoints: string[] = [];
  const history = new EditHistoryCoordinator(
    {
      notifyDocumentChanged: () => undefined,
      recordEditNotice: () => undefined,
      lastKnownText: () => harness.state.lastKnownContent,
      flushEditTransactions: () => Promise.resolve(true),
      applyHistoryTransition: () => Promise.resolve({ kind: 'failed', reason: 'unused', liveText: undefined }),
      unblockReplacement: () => undefined,
      blockReplacement: () => undefined,
      notifyReturnedToSavePoint: () => undefined,
      protectView: () => undefined,
      reportUserError: () => Promise.resolve(),
      reportInternalError: () => undefined,
    },
    { protect: () => new Promise<void>(() => undefined) },
  );
  harness.coordinator.setHistoryPort({
    isHistoryEventDriven: () => true,
    prepareSaveEndpoint: (text) => history.prepareSaveEndpoint(text),
    confirmSaveEndpoint: (text) => history.confirmSaveEndpoint(text),
    notifySaveSucceeded: (text) => {
      savePoints.push(text);
      history.notifySaveSucceeded(text);
    },
    notifyRevertResult: (succeeded, text) => history.notifyRevertResult(succeeded, text),
    reportProtection: (reason, staleText) => history.reportProtection(reason, staleText),
  });
  return { history, savePoints };
}

/**
 * Advances a save with an unresponsive view past the response timeout.
 *
 * @param run A function that calls the save entry point.
 * @param extraMs Additional time to advance after the timeout.
 */
async function runWhileViewSilent(run: () => Promise<SaveOutcome>, extraMs = 0): Promise<SaveOutcome> {
  const saving = run();
  await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS + extraMs);
  return saving;
}

/**
 * Sets up a state where saving the retained copy to the original URI meets every condition. Each case breaks exactly
 * one condition from here.
 *
 * @returns A save coordinator that holds a retained copy, whose source is clean and still equal to the merge base,
 *   and whose view does not respond.
 */
function createUnresponsiveHarness(): { harness: Harness; connected: ConnectedHistory } {
  const harness = createHarness();
  harness.syncState.initialize(DISK_TEXT);
  harness.setBuffer(DISK_TEXT, false);
  harness.state.retainUnsavedContent(VIEW_TEXT);
  harness.setViewBehavior('silent');
  return { harness, connected: connectHistory(harness) };
}

describe('distinguishing output request results', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats a null output response as unavailable and does not write through the fallback', async () => {
    const { harness } = createUnresponsiveHarness();
    harness.setViewBehavior('unavailable');

    await expect(harness.coordinator.save(notCancelled)).resolves.toBe('failed');

    expect(harness.written).toEqual([]);
  });

  it('treats an output response that is neither a string nor null as unavailable and does not update the retained copy', async () => {
    const { harness } = createUnresponsiveHarness();
    harness.setViewBehavior('invalidOutput');

    await expect(harness.coordinator.save(notCancelled)).resolves.toBe('failed');

    expect([harness.written, harness.state.lastKnownContent]).toEqual([[], VIEW_TEXT]);
  });

  it('does not fall back by treating an exception while sending the output request as unresponsive', async () => {
    const { harness } = createUnresponsiveHarness();
    harness.setViewBehavior('sendFails');

    await expect(harness.coordinator.save(notCancelled)).resolves.toBe('failed');

    expect(harness.written).toEqual([]);
  });
});

describe('save fallback when unresponsive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a qualifying retained copy to the original URI without applying it to the view, and advances the sync base and save point', async () => {
    const { harness, connected } = createUnresponsiveHarness();

    const outcome = await runWhileViewSilent(() => harness.coordinator.save(notCancelled));

    expect([outcome, harness.written, harness.applied]).toEqual([
      'completed',
      [{ uri: DOCUMENT_URI, text: VIEW_TEXT }],
      [],
    ]);
    expect([harness.syncState.syncBase, connected.savePoints]).toEqual([VIEW_TEXT, [VIEW_TEXT]]);
    expect(messagesOfType(harness.sent, HOST_TO_VIEW_MESSAGE_TYPE.saveCommitted)).toHaveLength(1);
    // A success is not shown as an error notification.
    expect([harness.informations, harness.notifications])
      .toEqual([['backup.savedFromRetainedCopy.message'], []]);
  });

  it('writes the retained copy on a save to another URI with an unresponsive view, without changing the original document\'s sync base or save point', async () => {
    const { harness, connected } = createUnresponsiveHarness();

    const outcome = await runWhileViewSilent(() => harness.coordinator.saveAs(DESTINATION_URI, notCancelled));

    expect([outcome, harness.written]).toEqual(['completed', [{ uri: DESTINATION_URI, text: VIEW_TEXT }]]);
    expect([harness.syncState.syncBase, harness.syncState.writeReconcile, connected.savePoints])
      .toEqual([DISK_TEXT, undefined, []]);
    expect(messagesOfType(harness.sent, HOST_TO_VIEW_MESSAGE_TYPE.saveCommitted)).toEqual([]);
  });

  it('does not write through the fallback when there is no retained copy', async () => {
    const { harness } = createUnresponsiveHarness();
    harness.state.clearUnsavedContent();

    await expect(runWhileViewSilent(() => harness.coordinator.save(notCancelled))).resolves.toBe('failed');

    expect(harness.written).toEqual([]);
  });

  it('does not write the retained copy while an edit unit is awaiting settlement', async () => {
    const { harness, connected } = createUnresponsiveHarness();
    connected.history.receiveEditUnitSignal({
      kind: 'start',
      unitId: 'u1',
      start: { text: VIEW_TEXT, selection: null },
    });

    await expect(runWhileViewSilent(() => harness.coordinator.save(notCancelled))).resolves.toBe('failed');

    expect(harness.written).toEqual([]);
  });

  it('does not write the retained copy when the start endpoint is missing', async () => {
    const { harness, connected } = createUnresponsiveHarness();
    connected.history.receiveEditNotice();

    await expect(runWhileViewSilent(() => harness.coordinator.save(notCancelled))).resolves.toBe('failed');

    expect(harness.written).toEqual([]);
  });

  it('does not write the retained copy under protection', async () => {
    const { harness, connected } = createUnresponsiveHarness();
    connected.history.reportProtection('forced', VIEW_TEXT);

    await expect(runWhileViewSilent(() => harness.coordinator.save(notCancelled))).resolves.toBe('failed');

    expect(harness.written).toEqual([]);
  });

  it('does not write when the retained copy differs from the settled full text', async () => {
    const { harness, connected } = createUnresponsiveHarness();
    connected.history.receiveEditUnitSignal({
      kind: 'settled',
      transaction: {
        unitId: 'u1',
        before: { text: DISK_TEXT, selection: null },
        after: { text: EXTERNAL_TEXT, selection: null },
      },
    });

    await expect(runWhileViewSilent(() => harness.coordinator.save(notCancelled))).resolves.toBe('failed');

    expect(harness.written).toEqual([]);
  });

  it('does not write the retained copy when the original URI\'s source is dirty', async () => {
    const { harness } = createUnresponsiveHarness();
    harness.setBuffer(DISK_TEXT, true);

    await expect(runWhileViewSilent(() => harness.coordinator.save(notCancelled))).resolves.toBe('failed');

    expect(harness.written).toEqual([]);
  });

  it('raises the dirty text buffer notice when the original URI\'s source is dirty', async () => {
    const { harness } = createUnresponsiveHarness();
    harness.setBuffer(DISK_TEXT, true);

    await runWhileViewSilent(() => harness.coordinator.save(notCancelled));

    expect(harness.dirtyNotices).toEqual(['Skipped saving the retained copy because the text buffer has unsaved edits']);
  });

  it('does not write the retained copy when the original URI\'s source cannot be read', async () => {
    const { harness } = createUnresponsiveHarness();
    harness.setBufferReadable(false);

    await expect(runWhileViewSilent(() => harness.coordinator.save(notCancelled))).resolves.toBe('failed');

    expect(harness.written).toEqual([]);
  });

  it('does not write the retained copy when following the original URI times out', async () => {
    const { harness } = createUnresponsiveHarness();
    // The previous write never reached the buffer, which stays at the pre-write source.
    harness.syncState.retainWriteReconcile(EXTERNAL_TEXT, DISK_TEXT);

    const outcome = await runWhileViewSilent(
      () => harness.coordinator.save(notCancelled),
      BUFFER_FOLLOW_TIMEOUT_MS + BUFFER_FOLLOW_POLL_MS,
    );

    expect([outcome, harness.written]).toEqual(['failed', []]);
  });

  it('does not write the retained copy when the original URI\'s source differs from the merge base', async () => {
    const { harness } = createUnresponsiveHarness();
    harness.setBuffer(EXTERNAL_TEXT, false);

    await expect(runWhileViewSilent(() => harness.coordinator.save(notCancelled))).resolves.toBe('failed');

    expect(harness.written).toEqual([]);
  });

  it('rejects right before writing and does not advance the save point when the retained copy changes after the check', async () => {
    const { harness, connected } = createUnresponsiveHarness();
    harness.setBufferReadObserver(() => harness.state.retainUnsavedContent(EXTERNAL_TEXT));

    await expect(runWhileViewSilent(() => harness.coordinator.save(notCancelled))).resolves.toBe('failed');

    expect([harness.written, connected.savePoints, harness.syncState.syncBase]).toEqual([[], [], DISK_TEXT]);
  });

  it('rejects right before writing when an endpoint becomes unsettled after the check', async () => {
    const { harness, connected } = createUnresponsiveHarness();
    harness.setBufferReadObserver(() => connected.history.receiveEditNotice());

    await expect(runWhileViewSilent(() => harness.coordinator.save(notCancelled))).resolves.toBe('failed');

    expect(harness.written).toEqual([]);
  });

  it('does not write the file when cancelled right before writing', async () => {
    const { harness } = createUnresponsiveHarness();

    await expect(runWhileViewSilent(() => harness.coordinator.save(alreadyCancelled))).resolves.toBe('failed');

    expect(harness.written).toEqual([]);
  });

  it('does not advance the sync state or save point on a write failure, and fails the save with a release requesting a resend', async () => {
    const { harness, connected } = createUnresponsiveHarness();
    harness.setWriteFailing(true);

    const outcome = await runWhileViewSilent(() => harness.coordinator.save(notCancelled));

    expect([outcome, harness.syncState.syncBase, harness.syncState.writeReconcile, connected.savePoints])
      .toEqual(['failed', DISK_TEXT, undefined, []]);
    expect(messagesOfType(harness.sent, HOST_TO_VIEW_MESSAGE_TYPE.saveReleased)).toEqual([
      { type: HOST_TO_VIEW_MESSAGE_TYPE.saveReleased, resendUnsavedContent: true },
    ]);
  });
});

describe('serializing recovery reads and writes', () => {
  it('does not start recovery reads and writes until the preceding write finishes, and aborts if the queue has closed', async () => {
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    const releaseSave = harness.holdRoundTripEnd();
    const events: string[] = [];

    const saving = harness.coordinator.save(notCancelled).then((outcome) => events.push(`save ${outcome}`));
    const recovering = harness.coordinator.runRecovery(async (port) => {
      events.push(`recovery read ${await port.readFile() === VIEW_TEXT}`);
      return 'recovered';
    });
    await saving;
    const eventsBeforeRelease = [...events];
    releaseSave();
    const recovered = await recovering;

    const secondRelease = harness.holdRoundTripEnd();
    void harness.coordinator.save(notCancelled);
    const abandoned = harness.coordinator.runRecovery(() => {
      events.push('abandoned recovery ran');
      return Promise.resolve('unexpected');
    });
    harness.coordinator.dispose();
    secondRelease();

    expect(eventsBeforeRelease).toEqual(['save completed']);
    expect(recovered).toEqual({ ran: true, value: 'recovered' });
    await expect(abandoned).resolves.toEqual({ ran: false });
    expect(events).toEqual(['save completed', 'recovery read true']);
  });
});

describe('source resolution for restore and abandoned Revert', () => {
  it('resolves after the earlier write completes and leaves the sync base and the retained copy unchanged', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.syncState.initialize(DISK_TEXT);
    await harness.coordinator.save(notCancelled);
    const syncBaseBeforeResolve = harness.syncState.syncBase;
    const retainedBeforeResolve = harness.state.lastKnownContent;
    const writesBeforeResolve = harness.written.length;

    const resolving = harness.coordinator.resolveSourceForRestore();
    await vi.advanceTimersByTimeAsync(BUFFER_FOLLOW_POLL_MS * 2);
    // The buffer caught up with the written content.
    harness.setBuffer(VIEW_TEXT, false);
    await vi.advanceTimersByTimeAsync(BUFFER_FOLLOW_POLL_MS * 2);

    await expect(resolving).resolves.toEqual({ kind: 'resolved', text: VIEW_TEXT, lineEnding: 'lf' });
    expect([harness.syncState.syncBase, harness.state.lastKnownContent, harness.written.length])
      .toEqual([syncBaseBeforeResolve, retainedBeforeResolve, writesBeforeResolve]);
    vi.useRealTimers();
  });

  it('returns abandoned without reporting a failure when disposing the document abandons the apply', async () => {
    const harness = createHarness();
    harness.setViewBehavior('applyStalls');

    const reverting = harness.coordinator.revert(notCancelled);
    await vi.waitFor(() => expect(harness.applied).toHaveLength(1));
    harness.coordinator.dispose();

    await expect(reverting).resolves.toBe('abandoned');
    expect([harness.notifications, harness.history.reverts]).toEqual([[], []]);
  });

  it('returns failed when the text side is dirty and the file on disk cannot be read', async () => {
    const harness = createHarness();
    harness.setBuffer(DISK_TEXT, true);
    harness.setFileReadable(false);

    const outcome = await harness.coordinator.revert(notCancelled);

    expect([outcome, harness.notifications]).toEqual(['failed', ['revertFailed.message']]);
  });
});

describe('writing a skeleton to a blank document', () => {
  const SKELETON = '<!DOCTYPE html>\n<html>\n<head>\n<title>a</title>\n</head>\n<body>\n</body>\n</html>\n';

  it('writes the skeleton over a blank, clean source and sends no replacement for the change notice it causes', async () => {
    const harness = createHarness();
    harness.setBuffer('\n', false);
    harness.setFileText('\n');
    harness.syncState.initialize('\n');
    // The buffer follows the write at once, as it does when the text tab is clean.
    harness.setWriteObserver(() => harness.setBuffer(SKELETON, false));

    const outcome = await harness.coordinator.writeSkeleton(SKELETON);
    await harness.reconcile('textBufferChange');

    expect([outcome, harness.written, harness.applied]).toEqual([
      { kind: 'written' },
      [{ uri: DOCUMENT_URI, text: SKELETON }],
      [],
    ]);
  });

  it('writes nothing when the source is no longer blank', async () => {
    const harness = createHarness();
    harness.setBuffer('<p>a</p>\n', false);
    harness.syncState.initialize('');

    const outcome = await harness.coordinator.writeSkeleton(SKELETON);

    expect([outcome.kind, harness.written]).toEqual(['notWritten', []]);
  });

  it('writes nothing when the file on disk is no longer blank although the text buffer still is', async () => {
    const harness = createHarness();
    harness.setBuffer('', false);
    harness.syncState.initialize('');
    harness.setFileText('<p>written outside</p>\n');

    const outcome = await harness.coordinator.writeSkeleton(SKELETON);

    expect([outcome.kind, harness.written]).toEqual(['notWritten', []]);
  });

  it('writes nothing when the text buffer has unsaved edits', async () => {
    const harness = createHarness();
    harness.setBuffer('', true);
    harness.syncState.initialize('');

    const outcome = await harness.coordinator.writeSkeleton(SKELETON);

    expect([outcome.kind, harness.written]).toEqual(['notWritten', []]);
  });
});
