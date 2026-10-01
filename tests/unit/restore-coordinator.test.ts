// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOST_TO_VIEW_MESSAGE_TYPE, RESTORE_ACTION } from '../../common/index';
import type { HostToViewMessage, InitializeMessage, RestoreAction } from '../../common/index';
import { BACKUP_CONTENT_VERSION } from '../../src/backup/backup-content';
import { RestoreCoordinator } from '../../src/backup/restore-coordinator';
import type { RestoreBasis } from '../../src/backup/restore-coordinator';
import type { RestoreCandidate } from '../../src/backup/restore-candidate';
import type { SourceResolution } from '../../src/save/save-coordinator';

const BACKUP_URI = 'memory:/preservation/protection-1';
const DOCUMENT_URI = 'file:///workspace/a.html';

// A set where the merge base, the source, and the backup each change the same line differently. In the conflict
// region the backup side's line follows the source side's line.
const BASE_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>first</p>\n</body>\n</html>\n';
const SOURCE_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>FIRST</p>\n</body>\n</html>\n';
const BACKUP_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>first!</p>\n</body>\n</html>\n';
const MERGED_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>FIRST</p>\n<p>first!</p>\n</body>\n</html>\n';

const NORMAL_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>normal</p>\n</body>\n</html>\n';

/** A single notification. */
interface FailureNotification {
  readonly location: string | undefined;
  readonly cause: string;
}

interface Harness {
  readonly coordinator: RestoreCoordinator;
  /** The messages sent to the view. */
  readonly posted: HostToViewMessage[];
  /** The bases passed to the connection. */
  readonly connected: RestoreBasis[];
  /** The backup locations that started being tracked. */
  readonly tracked: string[];
  readonly notifications: FailureNotification[];
  readonly dirtyStateKept: string[];
  readonly logLines: string[];
  /** The call order of clearing the dirty state and the normal initialization. */
  readonly operations: string[];
  loadCalls: number;
  discardCalls: number;
  releaseCalls: number;
  candidate: RestoreCandidate;
  source: SourceResolution | undefined;
  retainedCopy: string | undefined;
  connectResult: boolean;
  discardResult: boolean;
  releaseResult: boolean;
  clearDirtyResult: boolean;
  reloadCalls: number;
  /** The action the user chooses in the failure notification. */
  selection: RestoreAction | undefined;
}

function selectedCandidate(fullText: string, purpose: 'hotExit' | 'protection' = 'protection'): RestoreCandidate {
  return {
    kind: 'selected',
    backupUri: BACKUP_URI,
    purpose,
    content: {
      version: BACKUP_CONTENT_VERSION,
      documentUri: DOCUMENT_URI,
      fullText,
      mergeBase: BASE_TEXT,
    },
    adoptedBackupUris: [BACKUP_URI],
  };
}

function createHarness(backupId?: string): Harness {
  const posted: HostToViewMessage[] = [];
  const connected: RestoreBasis[] = [];
  const tracked: string[] = [];
  const notifications: FailureNotification[] = [];
  const dirtyStateKept: string[] = [];
  const logLines: string[] = [];
  const operations: string[] = [];

  const harness: Harness = {
    posted,
    connected,
    tracked,
    notifications,
    dirtyStateKept,
    logLines,
    operations,
    loadCalls: 0,
    discardCalls: 0,
    releaseCalls: 0,
    candidate: selectedCandidate(BACKUP_TEXT),
    source: { kind: 'resolved', text: SOURCE_TEXT, lineEnding: 'lf' },
    retainedCopy: undefined,
    connectResult: true,
    discardResult: true,
    releaseResult: true,
    clearDirtyResult: true,
    reloadCalls: 0,
    selection: undefined,
    coordinator: new RestoreCoordinator(
      {
        loadCandidate: () => {
          harness.loadCalls += 1;
          return Promise.resolve(harness.candidate);
        },
        resolveSource: () => Promise.resolve(harness.source),
        readRetainedCopy: () => harness.retainedCopy,
        createNormalInitialization: () => {
          operations.push('normalInitialization');
          return Promise.resolve(initialize(NORMAL_TEXT));
        },
        buildRestoreInitialization: (text) => Promise.resolve(initialize(text)),
        postToView: (message) => {
          posted.push(message);
          return Promise.resolve();
        },
        connect: (basis) => {
          connected.push(basis);
          if (harness.connectResult) {
            // In the real environment the connection sets the retained copy. Set the same value so the decision on
            // the next view ready message does not drift from the real environment.
            harness.retainedCopy = basis.restoredText;
          }
          return harness.connectResult;
        },
        startTracking: (backupUri) => tracked.push(backupUri),
        discardAdoptedBackups: () => {
          harness.discardCalls += 1;
          operations.push('discard');
          return Promise.resolve(harness.discardResult);
        },
        releaseLatestProtection: () => {
          harness.releaseCalls += 1;
          return Promise.resolve(harness.releaseResult);
        },
        clearDirtyState: () => {
          operations.push('clearDirty');
          return Promise.resolve(harness.clearDirtyResult);
        },
        reloadView: () => {
          harness.reloadCalls += 1;
        },
        notifyFailure: (location, cause) => {
          notifications.push({ location, cause });
          return Promise.resolve(harness.selection);
        },
        notifyDirtyStateKept: (cause) => dirtyStateKept.push(cause),
        reportInternalError: (detail) => logLines.push(detail),
      },
      backupId,
    ),
  };
  return harness;
}

function initialize(text: string): InitializeMessage {
  return { type: HOST_TO_VIEW_MESSAGE_TYPE.initialize, text, documentUri: '', resourceRootUri: '' };
}

/** Extracts the initialize messages sent to the view. */
function readInitializations(harness: Harness): InitializeMessage[] {
  return harness.posted.filter((message): message is InitializeMessage =>
    message.type === HOST_TO_VIEW_MESSAGE_TYPE.initialize);
}

/** Returns the types of the sent messages in send order. */
function readPostedTypes(harness: Harness): string[] {
  return harness.posted.map((message) => message.type);
}

/**
 * Waits until the initialization id of the restoring display arrives, then returns the display result with that id.
 *
 * @param harness The harness.
 * @param success Whether the mount reached an editable state.
 */
async function respondToDisplay(harness: Harness, success: boolean): Promise<void> {
  await vi.waitFor(() => expect(readInitializations(harness)).toHaveLength(1));
  const initializationId = readInitializations(harness)[0].initializationId ?? '';
  harness.coordinator.receiveDocumentInitialized(initializationId, success);
}

/** Drains microtasks so the test can confirm that a wait has not been released. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('loading and merging the candidate', () => {
  it('returns a normal initialization and sets the progress to normal when there is no candidate', async () => {
    const harness = createHarness();
    harness.candidate = { kind: 'none' };

    const message = await harness.coordinator.runRestore();

    expect(message?.text).toBe(NORMAL_TEXT);
    expect(harness.coordinator.progress).toBe('normal');
  });

  it('places the backup side after the source side in a conflict region without the merge base or markers', async () => {
    const harness = createHarness();

    const basis = await harness.coordinator.mergeWithSource({
      kind: 'selected',
      backupUri: BACKUP_URI,
      purpose: 'protection',
      content: {
        version: BACKUP_CONTENT_VERSION,
        documentUri: DOCUMENT_URI,
        fullText: BACKUP_TEXT,
        mergeBase: BASE_TEXT,
      },
      adoptedBackupUris: [BACKUP_URI],
    });

    expect(basis).toEqual({
      backupUri: BACKUP_URI,
      purpose: 'protection',
      mergeBase: BASE_TEXT,
      sourceText: SOURCE_TEXT,
      restoredText: MERGED_TEXT,
      lineEnding: 'lf',
    });
  });

  it('does not merge when the source is dirty, and notifies the backup location with retry and discard and sends the failure', async () => {
    const harness = createHarness();
    harness.source = { kind: 'dirty' };

    const message = await harness.coordinator.runRestore();

    expect(message).toBeUndefined();
    expect(harness.connected).toEqual([]);
    expect(harness.notifications).toEqual([{ location: BACKUP_URI, cause: expect.any(String) }]);
    expect(harness.posted).toEqual([
      { type: HOST_TO_VIEW_MESSAGE_TYPE.restoreFailed, cause: 'sourceUnavailable' },
    ]);
  });
});

describe('display and connection with differences', () => {
  it('sends the restoring display with restoring and an initialization id, and does not connect until the display succeeds', async () => {
    const harness = createHarness();

    const running = harness.coordinator.runRestore();
    await vi.waitFor(() => expect(readInitializations(harness)).toHaveLength(1));
    const sent = readInitializations(harness)[0];
    const connectedBeforeResponse = harness.connected.length;
    await respondToDisplay(harness, true);
    await running;

    expect(sent).toMatchObject({ text: MERGED_TEXT, restoring: true });
    expect(sent.initializationId).toEqual(expect.any(String));
    expect(connectedBeforeResponse).toBe(0);
  });

  it('sends the restore completion and sets the progress to restored when the connection succeeds', async () => {
    const harness = createHarness();

    const running = harness.coordinator.runRestore();
    await respondToDisplay(harness, true);
    await running;

    expect(readPostedTypes(harness)).toEqual([
      HOST_TO_VIEW_MESSAGE_TYPE.initialize,
      HOST_TO_VIEW_MESSAGE_TYPE.restoreCompleted,
    ]);
    expect(harness.coordinator.progress).toBe('restored');
  });

  it('starts tracking the given backup after the connection when restoring a hot exit backup', async () => {
    const harness = createHarness('memory:/hot-exit/hotExit-1');
    harness.candidate = selectedCandidate(BACKUP_TEXT, 'hotExit');

    const running = harness.coordinator.runRestore();
    await respondToDisplay(harness, true);
    await running;

    expect([harness.connected.length, harness.tracked]).toEqual([1, [BACKUP_URI]]);
  });

  it('does not start tracking when restoring a protection backup', async () => {
    const harness = createHarness();

    const running = harness.coordinator.runRestore();
    await respondToDisplay(harness, true);
    await running;

    expect(harness.tracked).toEqual([]);
  });

  it('does not connect on a display failure response, and fails while keeping the backup', async () => {
    const harness = createHarness();

    const running = harness.coordinator.runRestore();
    await respondToDisplay(harness, false);
    await running;

    expect([harness.connected, harness.discardCalls]).toEqual([[], 0]);
    expect(harness.coordinator.progress).toBe('failed');
    expect(harness.posted).toContainEqual({
      type: HOST_TO_VIEW_MESSAGE_TYPE.restoreFailed,
      cause: 'displayFailed',
    });
  });

  it('does not connect on a success for an old initialization id that arrives after the deadline', async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    const running = harness.coordinator.runRestore();
    await vi.waitFor(() => expect(readInitializations(harness)).toHaveLength(1));
    const initializationId = readInitializations(harness)[0].initializationId ?? '';
    await vi.advanceTimersByTimeAsync(10000);
    await running;
    const accepted = harness.coordinator.receiveDocumentInitialized(initializationId, true);

    expect([accepted, harness.connected]).toEqual([false, []]);
    expect(harness.coordinator.progress).toBe('failed');
  });

  it('leaves no deadline timer when display confirmation settles first', async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    const running = harness.coordinator.runRestore();
    await respondToDisplay(harness, true);
    await running;

    expect([vi.getTimerCount(), harness.coordinator.progress]).toEqual([0, 'restored']);
  });

  it('settles the restore as a failure when the view restarts during display confirmation', async () => {
    const harness = createHarness();

    const running = harness.coordinator.runRestore();
    await vi.waitFor(() => expect(readInitializations(harness)).toHaveLength(1));
    harness.coordinator.notifyViewRestarted();
    await running;

    expect([harness.connected, harness.coordinator.progress]).toEqual([[], 'failed']);
  });

  it('fails without sending the restore completion when the connection fails', async () => {
    const harness = createHarness();
    harness.connectResult = false;

    const running = harness.coordinator.runRestore();
    await respondToDisplay(harness, true);
    await running;

    expect(readPostedTypes(harness)).toEqual([
      HOST_TO_VIEW_MESSAGE_TYPE.initialize,
      HOST_TO_VIEW_MESSAGE_TYPE.restoreFailed,
    ]);
    expect(harness.posted).toContainEqual({
      type: HOST_TO_VIEW_MESSAGE_TYPE.restoreFailed,
      cause: 'connectionFailed',
    });
  });
});

describe('discard with no difference and normal startup', () => {
  it('returns a normal initialization after recording the discard of the adopted backups, without notifying', async () => {
    const harness = createHarness();
    harness.candidate = selectedCandidate(SOURCE_TEXT);

    const message = await harness.coordinator.runRestore();

    expect(message?.text).toBe(NORMAL_TEXT);
    expect(harness.operations).toEqual(['discard', 'normalInitialization']);
    expect([harness.notifications, harness.posted]).toEqual([[], []]);
    expect(harness.coordinator.progress).toBe('normal');
  });

  it('does not clear the dirty state for a document that received no backup id', async () => {
    const harness = createHarness();
    harness.candidate = selectedCandidate(SOURCE_TEXT);

    await harness.coordinator.runRestore();

    expect(harness.operations).not.toContain('clearDirty');
  });

  it('clears the dirty state before returning the normal initialization for a document that received a backup id', async () => {
    const harness = createHarness('memory:/hot-exit/hotExit-1');
    harness.candidate = selectedCandidate(SOURCE_TEXT, 'hotExit');

    await harness.coordinator.runRestore();

    expect(harness.operations).toEqual(['discard', 'clearDirty', 'normalInitialization']);
  });

  it('shows the failure instead of returning a normal initialization when the discard cannot be recorded', async () => {
    const harness = createHarness();
    harness.candidate = selectedCandidate(SOURCE_TEXT);
    harness.discardResult = false;

    const message = await harness.coordinator.runRestore();

    expect(message).toBeUndefined();
    expect(harness.operations).toEqual(['discard']);
    expect(harness.coordinator.progress).toBe('failed');
    expect(harness.posted).toEqual([
      { type: HOST_TO_VIEW_MESSAGE_TYPE.restoreFailed, cause: 'discardFailed' },
    ]);
  });

  it('notifies when the dirty state cannot be cleared, and still returns the normal initialization', async () => {
    const harness = createHarness('memory:/hot-exit/hotExit-1');
    harness.candidate = selectedCandidate(SOURCE_TEXT, 'hotExit');
    harness.clearDirtyResult = false;

    const message = await harness.coordinator.runRestore();

    expect(message?.text).toBe(NORMAL_TEXT);
    expect(harness.dirtyStateKept).toHaveLength(1);
    expect(harness.coordinator.progress).toBe('normal');
  });
});

describe('view ready', () => {
  it('sends only the failure again on a view ready message while failed, without repeating the notification', async () => {
    const harness = createHarness();
    harness.source = { kind: 'dirty' };
    await harness.coordinator.runRestore();
    harness.posted.length = 0;

    const message = await harness.coordinator.initializeView();

    expect(message).toBeUndefined();
    expect(harness.notifications).toHaveLength(1);
    expect(harness.posted).toEqual([
      { type: HOST_TO_VIEW_MESSAGE_TYPE.restoreFailed, cause: 'sourceUnavailable' },
    ]);
  });

  it('does not reload the candidate on a view ready message while running, and decides only once after settlement', async () => {
    const harness = createHarness();

    const running = harness.coordinator.runRestore();
    await vi.waitFor(() => expect(readInitializations(harness)).toHaveLength(1));
    const initializing = harness.coordinator.initializeView();
    await flush();
    const operationsWhileRunning = [...harness.operations];
    await respondToDisplay(harness, true);
    await running;

    // It waits for settlement before deciding again, so there is only one decision, made against restored.
    await expect(initializing).resolves.toMatchObject({ text: NORMAL_TEXT });
    expect([harness.loadCalls, operationsWhileRunning]).toEqual([1, []]);
    expect(harness.operations).toEqual(['normalInitialization']);
  });

  it('returns a normal initialization on a view ready message after restored, without connecting again', async () => {
    const harness = createHarness();
    const running = harness.coordinator.runRestore();
    await respondToDisplay(harness, true);
    await running;

    const message = await harness.coordinator.initializeView();

    expect(message?.text).toBe(NORMAL_TEXT);
    expect(harness.connected).toHaveLength(1);
  });
});

describe('choice while failed', () => {
  /** Settles as a failure to resolve the source. */
  async function failRestore(harness: Harness): Promise<void> {
    harness.source = { kind: 'dirty' };
    await harness.coordinator.runRestore();
    harness.source = { kind: 'resolved', text: SOURCE_TEXT, lineEnding: 'lf' };
    harness.posted.length = 0;
  }

  it('resets the progress to not started and reloads the view on retry', async () => {
    const harness = createHarness();
    await failRestore(harness);

    await harness.coordinator.selectAction(RESTORE_ACTION.retry);

    expect([harness.coordinator.progress, harness.reloadCalls]).toEqual(['notStarted', 1]);
    expect(harness.discardCalls).toBe(0);
  });

  it('sets the progress to normal after recording and reloads the view on discard', async () => {
    const harness = createHarness();
    await failRestore(harness);

    await harness.coordinator.selectAction(RESTORE_ACTION.discard);

    expect([harness.coordinator.progress, harness.reloadCalls]).toEqual(['normal', 1]);
    expect(harness.discardCalls).toBe(1);
  });

  it('stays failed and sends the failure again when the discard cannot be recorded', async () => {
    const harness = createHarness();
    await failRestore(harness);
    harness.discardResult = false;

    await harness.coordinator.selectAction(RESTORE_ACTION.discard);

    expect([harness.coordinator.progress, harness.reloadCalls]).toEqual(['failed', 0]);
    expect(harness.posted).toEqual([
      { type: HOST_TO_VIEW_MESSAGE_TYPE.restoreFailed, cause: 'discardFailed' },
    ]);
  });

  it('also releases the reference when discard is chosen after a failure to read the latest protection reference', async () => {
    const harness = createHarness();
    harness.candidate = {
      kind: 'failed',
      cause: 'cannot read the latest protection reference',
      backupUri: undefined,
      adoptedBackupUris: [],
    };
    await harness.coordinator.runRestore();

    await harness.coordinator.selectAction(RESTORE_ACTION.discard);

    expect([harness.releaseCalls, harness.coordinator.progress]).toEqual([1, 'normal']);
  });
});

describe('save and Revert restrictions', () => {
  it('waits for settlement while running and does not let the save proceed when it settles as a failure', async () => {
    const harness = createHarness();
    const running = harness.coordinator.runRestore();
    await vi.waitFor(() => expect(readInitializations(harness)).toHaveLength(1));

    let gate: boolean | undefined;
    void harness.coordinator.waitForSaveGate().then((allowed) => {
      gate = allowed;
    });
    await flush();
    const gateWhileRunning = gate;
    await respondToDisplay(harness, false);
    await running;
    await flush();

    expect([gateWhileRunning, gate]).toEqual([undefined, false]);
  });

  it('does not treat prepared or failed as complete', async () => {
    const harness = createHarness();
    const running = harness.coordinator.runRestore();
    await vi.waitFor(() => expect(readInitializations(harness)).toHaveLength(1));
    const completeWhilePrepared = harness.coordinator.isComplete();
    await respondToDisplay(harness, false);
    await running;

    expect([completeWhilePrepared, harness.coordinator.isComplete()]).toEqual([false, false]);
  });
});
