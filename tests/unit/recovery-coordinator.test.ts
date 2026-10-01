// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { MessageKey, MessageParams } from '../../common/index';
import { BackupCoordinator } from '../../src/backup/backup-coordinator';
import type { ProtectionState, RecoveryCheck } from '../../src/backup/backup-coordinator';
import { BackupStore } from '../../src/backup/backup-store';
import { RecoveryCoordinator } from '../../src/backup/recovery-coordinator';
import type { RecoveryReopenResult } from '../../src/backup/recovery-coordinator';
import type { SourceResolution } from '../../src/save/save-coordinator';
import { createMemoryBackupHost } from './helpers/memory-backup-host';
import type { MemoryBackupHost } from './helpers/memory-backup-host';

const DOCUMENT_URI = 'file:///workspace/a.html';
const PROTECTION_PARENT = 'memory:/preservation';

// A set where the merge base, source, and old full text each change the same line differently. The conflict region
// places the view side's line after the source side's line.
const BASE_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>first</p>\n</body>\n</html>\n';
const SOURCE_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>FIRST</p>\n</body>\n</html>\n';
const STALE_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>first!</p>\n</body>\n</html>\n';
const MERGED_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>FIRST</p>\n<p>first!</p>\n</body>\n</html>\n';
const OTHER_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>other</p>\n</body>\n</html>\n';

interface Harness {
  readonly recovery: RecoveryCoordinator;
  readonly backup: BackupCoordinator;
  readonly store: BackupStore;
  readonly backupFiles: MemoryBackupHost;
  readonly notifications: MessageKey[];
  /** Values passed to the placeholders of notification bodies, in the same order as the notifications. */
  readonly notificationParams: (MessageParams | undefined)[];
  /** Full texts written to the file. */
  readonly writes: string[];
  /** Copies of the protection state at the time of each write. */
  readonly recordsAtWrite: { status: string; check: RecoveryCheck | undefined }[];
  readonly reopenCalls: number[];
  /** How many times the latest protection reference was released. */
  releaseCalls: number;
  /** How many times the old document's backups were handed to the discard port. */
  discardCalls: number;
  /** Whether releasing the latest protection reference fails. */
  failLatestProtectionRelease: boolean;
  isProtected: boolean;
  fileText: string;
  source: SourceResolution;
  /** How the next write behaves. */
  nextWrite: 'writes' | 'fails' | 'writesOther';
  /** The remaining number of reads to fail. */
  failingReads: number;
  reopenResult: () => Promise<RecoveryReopenResult>;
  readonly runQueue: number[];
}

function createHarness(): Harness {
  const backupFiles = createMemoryBackupHost();
  const store = new BackupStore(backupFiles, { reportInternalError: () => undefined }, () => 'token');
  const notifications: MessageKey[] = [];
  const notificationParams: (MessageParams | undefined)[] = [];
  const reportUserAction = (
    key: MessageKey,
    _actions?: unknown,
    _cause?: string,
    params?: MessageParams,
  ): Promise<undefined> => {
    notifications.push(key);
    notificationParams.push(params);
    return Promise.resolve(undefined);
  };
  const backup = new BackupCoordinator(
    {
      documentUri: DOCUMENT_URI,
      protectionParentUri: PROTECTION_PARENT,
      readContentInput: () => ({ documentUri: DOCUMENT_URI, retainedCopy: STALE_TEXT, mergeBase: BASE_TEXT }),
      reportUserAction,
      reportUserInformation: (key) => reportUserAction(key),
      reportInternalError: () => undefined,
      runUserAction: () => undefined,
      updateLatestProtection: () => Promise.resolve(undefined),
      discardReplaced: () => undefined,
    },
    store,
  );

  const harness: Harness = {
    backup,
    store,
    backupFiles,
    notifications,
    notificationParams,
    writes: [],
    recordsAtWrite: [],
    reopenCalls: [],
    releaseCalls: 0,
    discardCalls: 0,
    failLatestProtectionRelease: false,
    runQueue: [],
    isProtected: true,
    fileText: SOURCE_TEXT,
    source: { kind: 'resolved', text: SOURCE_TEXT, lineEnding: 'lf' },
    nextWrite: 'writes',
    failingReads: 0,
    reopenResult: () => Promise.resolve('shown'),
    recovery: new RecoveryCoordinator(
      {
        isProtected: () => harness.isProtected,
        runRecovery: async (operation) => {
          harness.runQueue.push(harness.runQueue.length + 1);
          const value = await operation({
            resolveSource: () => Promise.resolve(harness.source),
            readFile: () => {
              if (harness.failingReads > 0) {
                harness.failingReads -= 1;
                return Promise.reject(new Error('could not read'));
              }
              return Promise.resolve(harness.fileText);
            },
            writeText: (text) => {
              const record = harness.backup.protection;
              harness.recordsAtWrite.push({ status: record?.status ?? 'none', check: record?.recoveryCheck });
              harness.writes.push(text);
              if (harness.nextWrite === 'fails') {
                return Promise.reject(new Error('could not write'));
              }
              // The read-back returns different content, as if another writer wrote at the same time.
              harness.fileText = harness.nextWrite === 'writesOther' ? OTHER_TEXT : text;
              return Promise.resolve();
            },
          });
          return { ran: true, value };
        },
        reopenRecoveredDocument: () => {
          harness.reopenCalls.push(harness.reopenCalls.length + 1);
          return harness.reopenResult();
        },
        reportUserAction,
        reportUserInformation: (key) => reportUserAction(key),
        reportInternalError: () => undefined,
        runUserAction: () => undefined,
        releaseLatestProtection: () => {
          harness.releaseCalls += 1;
          return Promise.resolve(!harness.failLatestProtectionRelease);
        },
        discardRecoveredBackups: () => {
          harness.discardCalls += 1;
        },
      },
      backup,
    ),
  };
  return harness;
}

/** Prepares a protection backup whose read-back was verified. */
async function protect(harness: Harness): Promise<ProtectionState> {
  await harness.backup.protect({ staleText: STALE_TEXT, pointId: 1, reason: 'forced' });
  const state = harness.backup.protection;
  if (state === undefined) {
    throw new Error('the protection record was not created');
  }
  return state;
}

/** Fails a write to prepare a record in the reconciling state. */
async function leaveReconciling(harness: Harness): Promise<ProtectionState> {
  const state = await protect(harness);
  harness.nextWrite = 'fails';
  await harness.recovery.recover();
  harness.nextWrite = 'writes';
  return state;
}

function protectionBackupExists(harness: Harness, state: ProtectionState): boolean {
  return state.backupUri !== undefined && harness.backupFiles.list(state.backupUri).includes('1.done');
}

describe('first recovery', () => {
  it('holds the first conflict-merged full text and the pre-write source as the recovery check before writing', async () => {
    const harness = createHarness();
    await protect(harness);

    await expect(harness.recovery.recover()).resolves.toBe('completed');

    expect(harness.recordsAtWrite).toEqual([
      { status: 'recoveryReconciling', check: { sourceBefore: SOURCE_TEXT, recoveredText: MERGED_TEXT } },
    ]);
    expect(harness.writes).toEqual([MERGED_TEXT]);
  });

  it('does not recover a document that is not under protection', async () => {
    const harness = createHarness();
    await protect(harness);
    harness.isProtected = false;

    await expect(harness.recovery.recover()).resolves.toBe('ignored');

    expect([harness.runQueue, harness.reopenCalls]).toEqual([[], []]);
  });

  it('does not recover while the protection backup is being created', async () => {
    const harness = createHarness();
    harness.backupFiles.interceptWrite = () => new Promise<void>(() => undefined);
    void harness.backup.protect({ staleText: STALE_TEXT, pointId: 1, reason: 'forced' });
    await vi.waitFor(() => expect(harness.backup.protection?.status).toBe('preserving'));

    await expect(harness.recovery.recover()).resolves.toBe('ignored');

    expect(harness.runQueue).toEqual([]);
  });

  it('adds no I/O when recovery is requested again while running', async () => {
    const harness = createHarness();
    await protect(harness);
    let finishReopen = (_result: RecoveryReopenResult): void => undefined;
    harness.reopenResult = () => new Promise<RecoveryReopenResult>((resolve) => {
      finishReopen = resolve;
    });

    const first = harness.recovery.recover();
    await vi.waitFor(() => expect(harness.reopenCalls).toHaveLength(1));
    const second = await harness.recovery.recover();
    finishReopen('shown');

    expect([second, await first, harness.writes.length, harness.runQueue.length]).toEqual(['ignored', 'completed', 1, 1]);
  });

  it('aborts recovery and keeps the protection state when retrying the protection backup fails', async () => {
    const harness = createHarness();
    harness.backupFiles.interceptWrite = () => Promise.reject(new Error('disk full'));
    void harness.backup.protect({ staleText: STALE_TEXT, pointId: 1, reason: 'forced' });
    await vi.waitFor(() => expect(harness.backup.protection?.status).toBe('failed'));

    await expect(harness.recovery.recover()).resolves.toBe('aborted');

    expect([harness.backup.protection?.status, harness.writes]).toEqual(['failed', []]);
    // Does not say a backup "remains" when there is none; like the first time, reports the backup failure and
    // guides to Save As.
    expect(harness.notifications).toEqual([
      'protection.preservationFailed.message',
      'protection.preservationFailed.message',
    ]);
  });

  it('does not write and keeps the protection backup when the source is dirty on the first recovery', async () => {
    const harness = createHarness();
    const state = await protect(harness);
    harness.source = { kind: 'dirty' };

    await expect(harness.recovery.recover()).resolves.toBe('aborted');

    expect([harness.writes, state.status, protectionBackupExists(harness, state)]).toEqual([[], 'verified', true]);
  });

  it('does not write and keeps the protection backup when the source cannot be read on the first recovery', async () => {
    const harness = createHarness();
    const state = await protect(harness);
    harness.source = { kind: 'unreadable', cause: 'missing' };

    await expect(harness.recovery.recover()).resolves.toBe('aborted');

    expect([harness.writes, state.status, protectionBackupExists(harness, state)]).toEqual([[], 'verified', true]);
  });
});

describe('checking the recovery write', () => {
  it('keeps the recovery check and the reconciling state even when the recovery write fails', async () => {
    const harness = createHarness();

    const state = await leaveReconciling(harness);

    expect([state.status, state.recoveryCheck]).toEqual([
      'recoveryReconciling',
      { sourceBefore: SOURCE_TEXT, recoveredText: MERGED_TEXT },
    ]);
  });

  it('keeps the recovery check even when the read-back fails after the recovery write', async () => {
    const harness = createHarness();
    const state = await protect(harness);
    harness.failingReads = 1;

    await expect(harness.recovery.recover()).resolves.toBe('aborted');

    expect([state.status, state.recoveryCheck]).toEqual([
      'recoveryReconciling',
      { sourceBefore: SOURCE_TEXT, recoveredText: MERGED_TEXT },
    ]);
  });

  it('does not re-merge with the original set even when the read-back after the recovery write does not match', async () => {
    const harness = createHarness();
    const state = await protect(harness);
    harness.nextWrite = 'writesOther';
    await harness.recovery.recover();
    harness.source = { kind: 'resolved', text: OTHER_TEXT, lineEnding: 'lf' };

    await expect(harness.recovery.recover()).resolves.toBe('aborted');

    expect([harness.writes, state.recoveryCheck?.recoveredText]).toEqual([[MERGED_TEXT], MERGED_TEXT]);
  });

  it('proceeds to closing without re-merging or rewriting when the retry read-back is the recovered full text', async () => {
    const harness = createHarness();
    await protect(harness);
    harness.failingReads = 1;
    await harness.recovery.recover();

    await expect(harness.recovery.recover()).resolves.toBe('completed');

    expect([harness.writes, harness.reopenCalls.length, harness.discardCalls]).toEqual([[MERGED_TEXT], 1, 1]);
  });

  it('rewrites only the same recovered full text when the file and the clean source are still as before the write', async () => {
    const harness = createHarness();
    await leaveReconciling(harness);

    await expect(harness.recovery.recover()).resolves.toBe('completed');

    expect(harness.writes).toEqual([MERGED_TEXT, MERGED_TEXT]);
  });

  it('does not overwrite when a source change differing from both check values occurs while reconciling', async () => {
    const harness = createHarness();
    await leaveReconciling(harness);
    harness.fileText = OTHER_TEXT;

    await expect(harness.recovery.recover()).resolves.toBe('aborted');

    expect([harness.writes, harness.notifications]).toEqual([
      [MERGED_TEXT],
      ['protection.preserved.message', 'recovery.aborted.message', 'recovery.sourceChanged.message'],
    ]);
  });

  it('does not rewrite when the retry source is dirty, even if the file is as before the write', async () => {
    const harness = createHarness();
    await leaveReconciling(harness);
    harness.source = { kind: 'dirty' };

    await expect(harness.recovery.recover()).resolves.toBe('aborted');

    expect(harness.writes).toEqual([MERGED_TEXT]);
  });

  it('does not overwrite when the file cannot be read on retry', async () => {
    const harness = createHarness();
    await leaveReconciling(harness);
    harness.failingReads = 1;

    await expect(harness.recovery.recover()).resolves.toBe('aborted');

    expect(harness.writes).toEqual([MERGED_TEXT]);
  });
});

describe('closing the old document and displaying the new document', () => {
  it('retries closing from the written state without rereading or rewriting the file, and does not delete the backup on a display failure', async () => {
    const harness = createHarness();
    const state = await protect(harness);
    harness.reopenResult = () => Promise.resolve('oldDocumentKept');
    await harness.recovery.recover();
    const queueRunsAfterWrite = harness.runQueue.length;

    await expect(harness.recovery.recover()).resolves.toBe('aborted');

    expect([harness.runQueue.length, harness.writes.length, harness.reopenCalls.length])
      .toEqual([queueRunsAfterWrite, 1, 2]);
    expect([state.status, protectionBackupExists(harness, state)]).toEqual(['recoveryWritten', true]);
  });

  it('keeps the written state and the protection backup when the old document cannot be closed', async () => {
    const harness = createHarness();
    const state = await protect(harness);
    harness.reopenResult = () => Promise.resolve('oldDocumentKept');

    await expect(harness.recovery.recover()).resolves.toBe('aborted');

    expect([state.status, state.recoveryCheck?.recoveredText, protectionBackupExists(harness, state)])
      .toEqual(['recoveryWritten', MERGED_TEXT, true]);
    expect(harness.notifications.at(-1)).toBe('recovery.aborted.message');
  });

  it('reports the protection backup location without offering a retry, and keeps the backup, when display fails after closing the old document', async () => {
    const harness = createHarness();
    const state = await protect(harness);
    harness.reopenResult = () => Promise.resolve('oldDocumentClosed');

    await expect(harness.recovery.recover()).resolves.toBe('aborted');

    expect([harness.notifications.at(-1), harness.notificationParams.at(-1)])
      .toEqual(['recovery.reopenFailed.message', { location: state.backupUri }]);
    expect(protectionBackupExists(harness, state)).toBe(true);
  });

  it('reports recovery completion with a success notification distinct from errors', async () => {
    const harness = createHarness();
    const informations: MessageKey[] = [];
    await protect(harness);
    const recovery = new RecoveryCoordinator(
      {
        isProtected: () => true,
        runRecovery: async (operation) => ({
          ran: true,
          value: await operation({
            resolveSource: () => Promise.resolve(harness.source),
            readFile: () => Promise.resolve(harness.fileText),
            writeText: (text) => {
              harness.fileText = text;
              return Promise.resolve();
            },
          }),
        }),
        reopenRecoveredDocument: () => Promise.resolve('shown'),
        reportUserAction: () => Promise.reject(new Error('failure notifications are not used')),
        reportUserInformation: (key) => {
          informations.push(key);
          return Promise.resolve(undefined);
        },
        reportInternalError: () => undefined,
        runUserAction: () => undefined,
        releaseLatestProtection: () => Promise.resolve(true),
        discardRecoveredBackups: () => undefined,
      },
      harness.backup,
    );

    await expect(recovery.recover()).resolves.toBe('completed');

    expect(informations).toEqual(['recovery.completed.message']);
  });
});

describe('releasing the latest protection reference and discarding backups', () => {
  it('releases the latest protection reference after verifying the write and before closing the old document', async () => {
    const harness = createHarness();
    await protect(harness);
    // Record that the release has finished by the time of the reopen.
    let releaseCallsAtReopen = -1;
    harness.reopenResult = () => {
      releaseCallsAtReopen = harness.releaseCalls;
      return Promise.resolve('shown');
    };

    await expect(harness.recovery.recover()).resolves.toBe('completed');

    expect([harness.writes, releaseCallsAtReopen]).toEqual([[MERGED_TEXT], 1]);
  });

  it('aborts without closing the old document when the latest protection reference cannot be released', async () => {
    const harness = createHarness();
    await protect(harness);
    harness.failLatestProtectionRelease = true;

    await expect(harness.recovery.recover()).resolves.toBe('aborted');

    expect([harness.reopenCalls, harness.discardCalls]).toEqual([[], 0]);
    expect(harness.notifications).toContain('recovery.aborted.message');
  });

  it('hands the backups of the old document to the discard port on display completion instead of deleting the protection backup directly', async () => {
    const harness = createHarness();
    const state = await protect(harness);

    await expect(harness.recovery.recover()).resolves.toBe('completed');

    expect([harness.discardCalls, protectionBackupExists(harness, state)]).toEqual([1, true]);
  });
});
