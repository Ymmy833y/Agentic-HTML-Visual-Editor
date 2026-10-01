// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { HOST_TO_VIEW_MESSAGE_TYPE, VIEW_TO_HOST_MESSAGE_TYPE, createLocalizer } from '../../common/index';
import type {
  CopyHtmlResponseMessage,
  HostToViewMessage,
  InitializeMessage,
  ResponseMessage,
  RestoreAction,
  ViewToHostMessage,
} from '../../common/index';
import { ErrorReporter } from '../../src/diagnostics/error-reporter';
import { handleViewMessage } from '../../src/editor/view-message-handler';
import type { ViewMessageContext } from '../../src/editor/view-message-handler';

const CATALOG = {
  'documentUnreadable.message': 'Could not read the file.',
  'errorReport.showDetails': 'Show Details',
};

const INITIALIZE_MESSAGE: InitializeMessage = {
  type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
  text: '<html><body><p>a</p></body></html>',
  // This layer covers dispatching, and the base URI values do not change the outcome.
  documentUri: '',
  resourceRootUri: '',
};

interface Harness {
  readonly context: ViewMessageContext;
  readonly reporter: ErrorReporter;
  /** The messages sent to the view, in send order. */
  readonly sent: HostToViewMessage[];
  /** The number of view edited messages passed to the save coordinator. */
  readonly readEditNoticeCount: () => number;
  /** Events passed to the save coordinator, in their original order. */
  readonly trace: string[];
  /** The unsaved content passed to the save coordinator: the whole text and the resend marker, in receipt order. */
  readonly received: { text: string; resent: boolean }[];
  /** The responses passed to the save coordinator, in receipt order. */
  readonly settled: ResponseMessage[];
  readonly historyMessages: unknown[];
  /** The restore choices passed to the receiver. */
  readonly restoreActions: RestoreAction[];
  /** How many times the text editor switch receiver was called. */
  readonly readTextEditorSwitchCount: () => number;
  /** How many times the save request receiver was called, and the arguments it was passed. */
  readonly saveRequestCalls: unknown[][];
  /** The arguments passed to the relative link receiver, in the order received. */
  readonly relativeLinkCalls: unknown[][];
  /** The arguments passed each time the copy request receiver was called. */
  readonly copyRequestCalls: unknown[][];
  /** The responses passed to the copy HTML response receiver, in the order received. */
  readonly copyHtmlResponses: CopyHtmlResponseMessage[];
  /** The arguments passed each time the code block copy request receiver was called. */
  readonly codeBlockCopyCalls: unknown[][];
  /** Creates no initialize message (the restore coordinator has already sent one or is waiting for settlement). */
  setInitializeMissing(missing: boolean): void;
}

/**
 * Creates a harness with handler dependencies whose behavior is determined entirely by values.
 *
 * @param unreadable Whether creating the initialize message fails.
 */
function createHarness(unreadable = false): Harness {
  const sent: HostToViewMessage[] = [];
  const restoreActions: RestoreAction[] = [];
  let initializeMissing = false;
  const received: { text: string; resent: boolean }[] = [];
  const settled: ResponseMessage[] = [];
  const trace: string[] = [];
  const historyMessages: unknown[] = [];
  let editNoticeCount = 0;
  let textEditorSwitchCount = 0;
  const saveRequestCalls: unknown[][] = [];
  const relativeLinkCalls: unknown[][] = [];
  const copyRequestCalls: unknown[][] = [];
  const copyHtmlResponses: CopyHtmlResponseMessage[] = [];
  const codeBlockCopyCalls: unknown[][] = [];
  const reporter = new ErrorReporter(
    { appendLine: (): void => undefined, show: (): void => undefined },
    {
      showMessage: (): PromiseLike<string | undefined> => Promise.resolve(undefined),
      showInformation: (): PromiseLike<string | undefined> => Promise.resolve(undefined),
    },
    createLocalizer(CATALOG),
    true,
  );

  return {
    reporter,
    sent,
    received,
    settled,
    historyMessages,
    trace,
    restoreActions,
    setInitializeMissing: (missing) => {
      initializeMissing = missing;
    },
    readEditNoticeCount: () => editNoticeCount,
    readTextEditorSwitchCount: () => textEditorSwitchCount,
    saveRequestCalls,
    relativeLinkCalls,
    copyRequestCalls,
    copyHtmlResponses,
    codeBlockCopyCalls,
    context: {
      createInitializeMessage: () => {
        trace.push('createInitializeMessage');
        if (unreadable) {
          return Promise.reject(new Error('Failed to read the document'));
        }
        return Promise.resolve(initializeMissing ? undefined : INITIALIZE_MESSAGE);
      },
      notifyViewRestarted: () => trace.push('notifyViewRestarted'),
      receiveEditTransaction: (message) => historyMessages.push(message),
      receiveEditTransactionFlushResult: (message) => historyMessages.push(message),
      receiveEditUnitStart: (message) => historyMessages.push(message),
      receiveEditUnitUnchanged: (message) => historyMessages.push(message),
      postToView: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
      receiveEditNotice: () => {
        editNoticeCount += 1;
      },
      receiveUnsavedContent: (text, resent) => received.push({ text, resent }),
      receiveRestoreAction: (action) => restoreActions.push(action),
      receiveTextEditorSwitchRequest: () => {
        textEditorSwitchCount += 1;
      },
      receiveSaveRequest: (...args: unknown[]) => {
        saveRequestCalls.push(args);
      },
      receiveRelativeLinkRequest: (...args: unknown[]) => {
        relativeLinkCalls.push(args);
      },
      receiveCopyRequest: (...args: unknown[]) => {
        copyRequestCalls.push(args);
      },
      receiveCopyHtmlResponse: (response) => copyHtmlResponses.push(response),
      receiveCodeBlockCopyRequest: (...args: unknown[]) => {
        codeBlockCopyCalls.push(args);
      },
      settleResponse: (response) => settled.push(response),
      errorReporter: reporter,
    },
  };
}

const UNSAVED_CONTENT = '<html><body><p>ab</p></body></html>';

// Unsaved content whose text is not a string. The type system rejects this, but the view can send any
// runtime value.
const NON_STRING_UNSAVED_CONTENT = {
  type: VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent,
  text: 1,
} as unknown as ViewToHostMessage;

// A message type outside the contract. It cannot exist in the type system, but a view can send any
// runtime value. Keep the assertion to the contract type here while reproducing such a value.
const OUTSIDE_CONTRACT = { type: 'not-in-the-contract' } as unknown as ViewToHostMessage;

describe('view message handling', () => {
  it('adds one diagnostic log line for a message type outside the contract', async () => {
    const harness = createHarness();

    await handleViewMessage(OUTSIDE_CONTRACT, harness.context);

    expect(harness.reporter.readInspection().logLines).toHaveLength(1);
  });

  it('sends nothing to the view for a message type outside the contract', async () => {
    const harness = createHarness();

    await handleViewMessage(OUTSIDE_CONTRACT, harness.context);

    expect(harness.sent).toEqual([]);
  });

  it('adds one diagnostic log line identified as view-originated for a view diagnostic message', async () => {
    const harness = createHarness();

    await handleViewMessage(
      { type: VIEW_TO_HOST_MESSAGE_TYPE.viewDiagnostic, detail: 'Discarded an unsupported type' },
      harness.context,
    );

    const [line] = harness.reporter.readInspection().logLines;
    expect(line).toBe('View: Discarded an unsupported type');
  });

  it('does not send to the view when the initialize message cannot be created', async () => {
    const harness = createHarness(true);

    await handleViewMessage({ type: VIEW_TO_HOST_MESSAGE_TYPE.viewReady }, harness.context);

    expect(harness.sent).toEqual([]);
  });

  it('adds one notification and diagnostic log line when the initialize message cannot be created', async () => {
    const harness = createHarness(true);

    await handleViewMessage({ type: VIEW_TO_HOST_MESSAGE_TYPE.viewReady }, harness.context);

    const inspection = harness.reporter.readInspection();
    expect([inspection.notifications.length, inspection.logLines.length]).toEqual([1, 1]);
  });

  it('sends one initialize message after receiving a view ready message', async () => {
    const harness = createHarness();

    await handleViewMessage({ type: VIEW_TO_HOST_MESSAGE_TYPE.viewReady }, harness.context);

    expect(harness.sent).toEqual([INITIALIZE_MESSAGE]);
  });

  it('notifies the save coordinator of a restart before creating initialization on view ready', async () => {
    const harness = createHarness();

    await handleViewMessage({ type: VIEW_TO_HOST_MESSAGE_TYPE.viewReady }, harness.context);

    expect(harness.trace).toEqual(['notifyViewRestarted', 'createInitializeMessage']);
  });

  it('adds no notification or diagnostic log line after receiving a view ready message', async () => {
    const harness = createHarness();

    await handleViewMessage({ type: VIEW_TO_HOST_MESSAGE_TYPE.viewReady }, harness.context);

    expect(harness.reporter.readInspection()).toEqual({ notifications: [], logLines: [] });
  });
});

describe('receiving dirty-state messages', () => {
  it('passes a view edited message to the save coordinator and passes no content', async () => {
    const harness = createHarness();

    await handleViewMessage({ type: VIEW_TO_HOST_MESSAGE_TYPE.viewEdited }, harness.context);

    expect([harness.readEditNoticeCount(), harness.received]).toEqual([1, []]);
  });

  it('passes unsaved content to the save coordinator as one unmarked item', async () => {
    const harness = createHarness();

    await handleViewMessage(
      { type: VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent, text: UNSAVED_CONTENT },
      harness.context,
    );

    expect(harness.received).toEqual([{ text: UNSAVED_CONTENT, resent: false }]);
  });

  it('passes unsaved content carrying a resend marker to the save coordinator with the marker intact', async () => {
    const harness = createHarness();

    await handleViewMessage(
      { type: VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent, text: UNSAVED_CONTENT, resent: true },
      harness.context,
    );

    expect(harness.received).toEqual([{ text: UNSAVED_CONTENT, resent: true }]);
  });

  it('records a diagnostic without retaining or firing when unsaved content text is not a string', async () => {
    const harness = createHarness();

    await handleViewMessage(NON_STRING_UNSAVED_CONTENT, harness.context);

    expect([
      harness.received,
      harness.readEditNoticeCount(),
      harness.reporter.readInspection().logLines.length,
    ]).toEqual([[], 0, 1]);
  });
});

describe('handing over responses', () => {
  it('passes a body output response to the save coordinator and fires no change event', async () => {
    const harness = createHarness();
    const response = {
      type: VIEW_TO_HOST_MESSAGE_TYPE.bodyOutputResponse,
      requestId: '1',
      text: UNSAVED_CONTENT,
    } as const;

    await handleViewMessage(response, harness.context);

    expect([harness.settled, harness.readEditNoticeCount()]).toEqual([[response], 0]);
  });

  it('passes an ack to the save coordinator and fires no change event', async () => {
    const harness = createHarness();
    const response = {
      type: VIEW_TO_HOST_MESSAGE_TYPE.documentReplaced,
      requestId: '2',
      outcome: 'applied',
    } as const;

    await handleViewMessage(response, harness.context);

    expect([harness.settled, harness.readEditNoticeCount()]).toEqual([[response], 0]);
  });

  it('passes edit transactions only to the edit transaction bridge', async () => {
    const harness = createHarness();
    const message = {
      type: VIEW_TO_HOST_MESSAGE_TYPE.editTransaction,
      transaction: {
        unitId: 'u1',
        before: { text: '<p>a</p>', selection: null },
        after: { text: '<p>b</p>', selection: null },
      },
    } as const;

    await handleViewMessage(message, harness.context);

    expect([harness.historyMessages, harness.settled]).toEqual([[message], []]);
  });

  it('passes edit transaction flush results only to the edit transaction bridge', async () => {
    const harness = createHarness();
    const message = {
      type: VIEW_TO_HOST_MESSAGE_TYPE.editTransactionFlushResult,
      requestId: '1',
      success: true,
    } as const;

    await handleViewMessage(message, harness.context);

    expect([harness.historyMessages, harness.settled]).toEqual([[message], []]);
  });

  it('passes an edit unit start and unchanged terminator to the bridge once each', async () => {
    const harness = createHarness();
    const startMessage = {
      type: VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart,
      unitId: 'u1',
      start: { text: '<p>a</p>', selection: null },
    } as const;
    const unchangedMessage = {
      type: VIEW_TO_HOST_MESSAGE_TYPE.editUnitUnchanged,
      unitId: 'u1',
    } as const;

    await handleViewMessage(startMessage, harness.context);
    await handleViewMessage(unchangedMessage, harness.context);

    expect([harness.historyMessages, harness.readEditNoticeCount()])
      .toEqual([[startMessage, unchangedMessage], 0]);
  });
});

describe('restore decision and choice', () => {
  it('sends nothing on the view ready message when there is no initialize message', async () => {
    const harness = createHarness();
    harness.setInitializeMissing(true);

    await handleViewMessage({ type: VIEW_TO_HOST_MESSAGE_TYPE.viewReady }, harness.context);

    expect(harness.sent).toEqual([]);
    expect(harness.trace).toEqual(['notifyViewRestarted', 'createInitializeMessage']);
  });

  it('passes the restore choice to the receiver', async () => {
    const harness = createHarness();

    await handleViewMessage(
      { type: VIEW_TO_HOST_MESSAGE_TYPE.restoreActionSelected, action: 'discard' },
      harness.context,
    );

    expect(harness.restoreActions).toEqual(['discard']);
  });

  it('leaves a restore choice outside the contract in the diagnostic log instead of passing it to the receiver', async () => {
    const harness = createHarness();
    // The type fixes the spelling of the choice, but any value can arrive at runtime.
    const outOfContract = {
      type: VIEW_TO_HOST_MESSAGE_TYPE.restoreActionSelected,
      action: 'delete',
    } as unknown as ViewToHostMessage;

    await handleViewMessage(outOfContract, harness.context);

    expect(harness.restoreActions).toEqual([]);
    expect(harness.reporter.readInspection().logLines).toHaveLength(1);
  });
});

describe('text editor switch requests', () => {
  it('calls the switch receiver once and leaves nothing in the diagnostic log when an editor switch request is received', async () => {
    const harness = createHarness();

    await handleViewMessage({ type: VIEW_TO_HOST_MESSAGE_TYPE.textEditorSwitchRequested }, harness.context);

    expect([harness.readTextEditorSwitchCount(), harness.reporter.readInspection().logLines])
      .toEqual([1, []]);
  });
});

describe('the save request', () => {
  it('calls the receiver exactly once, with no argument', async () => {
    const harness = createHarness();

    await handleViewMessage({ type: VIEW_TO_HOST_MESSAGE_TYPE.saveRequested }, harness.context);

    expect(harness.saveRequestCalls).toEqual([[]]);
  });
});

describe('the relative link request', () => {
  const HREF = 'sub/b.html';

  it('routes the request to the receiver without recording it as outside the contract', async () => {
    const harness = createHarness();

    await handleViewMessage(
      { type: VIEW_TO_HOST_MESSAGE_TYPE.relativeLinkRequested, href: HREF },
      harness.context,
    );

    expect([harness.relativeLinkCalls, harness.reporter.readInspection().logLines])
      .toEqual([[[HREF]], []]);
  });

  it('passes only the href to the receiver even when other values accompany it', async () => {
    const harness = createHarness();
    // Values absent from the type can still accompany the message at runtime. They must not reach the receiver.
    const withExtraValues = {
      type: VIEW_TO_HOST_MESSAGE_TYPE.relativeLinkRequested,
      href: HREF,
      requestId: '1',
      documentUri: 'file:///elsewhere/a.html',
    } as unknown as ViewToHostMessage;

    await handleViewMessage(withExtraValues, harness.context);

    expect(harness.relativeLinkCalls).toEqual([[HREF]]);
  });

  it('records one line without calling the receiver when the href is not a string', async () => {
    const harness = createHarness();
    // The type requires a string, but the view can send any value at runtime.
    const nonStringHref = {
      type: VIEW_TO_HOST_MESSAGE_TYPE.relativeLinkRequested,
      href: 1,
    } as unknown as ViewToHostMessage;

    await handleViewMessage(nonStringHref, harness.context);

    expect([harness.relativeLinkCalls, harness.reporter.readInspection().logLines.length])
      .toEqual([[], 1]);
  });
});

describe('the Copy as HTML messages', () => {
  it('calls the receiver exactly once with no arguments on a copy request and logs nothing', async () => {
    const harness = createHarness();

    await handleViewMessage({ type: VIEW_TO_HOST_MESSAGE_TYPE.copyRequested }, harness.context);

    expect([harness.copyRequestCalls, harness.reporter.readInspection().logLines]).toEqual([[[]], []]);
  });

  it('passes a copy HTML response to the receiver as is and logs nothing', async () => {
    const harness = createHarness();
    const response: CopyHtmlResponseMessage = {
      type: VIEW_TO_HOST_MESSAGE_TYPE.copyHtmlResponse,
      requestId: '1',
      html: '<p>a</p>',
    };

    await handleViewMessage(response, harness.context);

    expect([
      harness.copyHtmlResponses.length,
      harness.copyHtmlResponses[0] === response,
      harness.reporter.readInspection().logLines,
    ]).toEqual([1, true, []]);
  });
});

describe('the code block copy request', () => {
  it('passes the text to the receiver exactly once and logs nothing', async () => {
    const harness = createHarness();

    await handleViewMessage(
      { type: VIEW_TO_HOST_MESSAGE_TYPE.codeBlockCopyRequested, text: 'a\n  b' },
      harness.context,
    );

    expect([harness.codeBlockCopyCalls, harness.reporter.readInspection().logLines]).toEqual([[['a\n  b']], []]);
  });

  it('records one line without calling the receiver when the text is not a string', async () => {
    const harness = createHarness();
    // The type requires a string, but the view can send any value at runtime.
    const nonStringText = {
      type: VIEW_TO_HOST_MESSAGE_TYPE.codeBlockCopyRequested,
      text: 1,
    } as unknown as ViewToHostMessage;

    await handleViewMessage(nonStringText, harness.context);

    expect([harness.codeBlockCopyCalls, harness.reporter.readInspection().logLines.length]).toEqual([[], 1]);
  });
});
