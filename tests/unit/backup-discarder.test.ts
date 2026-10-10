// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { MessageKey, MessageParams } from '../../common/index';
import { BACKUP_CONTENT_VERSION } from '../../src/backup/backup-content';
import type { BackupContent } from '../../src/backup/backup-content';
import { BackupDiscarder } from '../../src/backup/backup-discarder';
import { BackupStore } from '../../src/backup/backup-store';
import { RestoreRecordStore } from '../../src/backup/restore-record-store';
import { createMemoryBackupHost } from './helpers/memory-backup-host';
import type { MemoryBackupHost } from './helpers/memory-backup-host';

const BACKUP_PARENT = 'memory:/preservation';
const RECORD_PARENT = 'memory:/preservation/records';
const DOCUMENT_URI = 'file:///workspace/a.html';

const BASE_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>a</p>\n</body>\n</html>\n';
const BACKUP_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>ab</p>\n</body>\n</html>\n';

/** A single notification. */
interface Notification {
  readonly key: MessageKey;
  readonly params: MessageParams;
}

interface Harness {
  readonly discarder: BackupDiscarder;
  readonly store: BackupStore;
  readonly records: RestoreRecordStore;
  readonly files: MemoryBackupHost;
  readonly notifications: Notification[];
  readonly logLines: string[];
  /** The order of record writes and deletions. `record` means the discard record and `backup` the backup location. */
  readonly operations: string[];
}

function content(): BackupContent {
  return { version: BACKUP_CONTENT_VERSION, documentUri: DOCUMENT_URI, fullText: BACKUP_TEXT, mergeBase: BASE_TEXT };
}

function createHarness(): Harness {
  const files = createMemoryBackupHost();
  const notifications: Notification[] = [];
  const logLines: string[] = [];
  const operations: string[] = [];
  const errorSink = { reportInternalError: (detail: string) => logLines.push(detail) };
  let token = 0;
  const store = new BackupStore(files, errorSink, () => {
    token += 1;
    return `t${token}`;
  });
  const records = new RestoreRecordStore(files, RECORD_PARENT, errorSink);

  // Records only the order of operations on discard records and backup locations. Does not change call results.
  const label = (uri: string): string => (uri.startsWith(RECORD_PARENT) ? 'record' : 'backup');
  const writeFile = files.writeFile.bind(files);
  files.writeFile = async (uri, bytes) => {
    operations.push(`write:${label(uri)}`);
    await writeFile(uri, bytes);
  };
  const remove = files.delete.bind(files);
  files.delete = async (uri) => {
    operations.push(`delete:${label(uri)}`);
    await remove(uri);
  };

  return {
    store,
    records,
    files,
    notifications,
    logLines,
    operations,
    discarder: new BackupDiscarder(
      {
        exists: (uri) => files.exists(uri),
        notifyFailure: (key, cause, params) => {
          notifications.push({ key, params });
          logLines.push(cause);
        },
        reportInternalError: (detail) => logLines.push(detail),
      },
      store,
      records,
    ),
  };
}

/** Creates a backup with one complete generation. */
async function createBackup(harness: Harness): Promise<string> {
  const backupUri = await harness.store.create(BACKUP_PARENT, 'protection');
  await harness.store.writeGeneration(backupUri, content());
  return backupUri;
}

/** Returns the number of discard records. */
function recordCount(harness: Harness): number {
  return harness.files.list(RECORD_PARENT).filter((name) => name.startsWith('discard-')).length;
}

describe('discarding adopted backups', () => {
  it('writes the discard record before deleting, and deletes the record after confirming the backup is gone', async () => {
    const harness = createHarness();
    const backupUri = await createBackup(harness);
    harness.operations.length = 0;

    const unrecorded = await harness.discarder.discard(DOCUMENT_URI, [backupUri]);

    expect(unrecorded).toEqual([]);
    await vi.waitFor(() => expect(recordCount(harness)).toBe(0));
    expect(harness.operations).toEqual(['write:record', 'delete:backup', 'delete:record']);
    expect(await harness.files.exists(backupUri)).toBe(false);
  });

  it('does not delete a backup location whose discard cannot be recorded, and reports and returns the location', async () => {
    const harness = createHarness();
    const backupUri = await createBackup(harness);
    harness.files.writeFile = (uri) => Promise.reject(new Error(`cannot write ${uri}`));

    const unrecorded = await harness.discarder.discard(DOCUMENT_URI, [backupUri]);

    expect(unrecorded).toEqual([backupUri]);
    expect(harness.notifications).toEqual([
      { key: 'restore.discardRecordFailed.message', params: { location: backupUri } },
    ]);
    expect(await harness.files.exists(backupUri)).toBe(true);
  });

  it('releases the latest protection reference only when it points to the target backup location', async () => {
    const harness = createHarness();
    const discarded = await createBackup(harness);
    const referenced = await createBackup(harness);
    await harness.records.updateLatestProtection(DOCUMENT_URI, referenced);

    await harness.discarder.discard(DOCUMENT_URI, [discarded]);

    await expect(harness.records.readLatestProtection(DOCUMENT_URI)).resolves.toBe(referenced);
  });
});

describe('deleting backups that have a discard record', () => {
  it('keeps the discard record and reports the location when the deletion fails', async () => {
    const harness = createHarness();
    const backupUri = await createBackup(harness);
    harness.files.failDeleteOf = (uri) => uri === backupUri;

    await harness.discarder.discard(DOCUMENT_URI, [backupUri]);

    await vi.waitFor(() => expect(harness.notifications).toEqual([
      { key: 'restore.deleteFailed.message', params: { location: backupUri } },
    ]));
    expect(recordCount(harness)).toBe(1);
  });

  it('treats a backup location that no longer exists as deleted and deletes its record', async () => {
    const harness = createHarness();
    const backupUri = `${BACKUP_PARENT}/protection-already-deleted`;
    await harness.records.recordDiscard(DOCUMENT_URI, backupUri);

    await harness.discarder.deleteRecorded(DOCUMENT_URI, backupUri);

    expect([recordCount(harness), harness.notifications]).toEqual([0, []]);
  });

  it('deletes backups that have a discard record at startup and deletes their records', async () => {
    const harness = createHarness();
    const first = await createBackup(harness);
    const second = await createBackup(harness);
    await harness.records.recordDiscard(DOCUMENT_URI, first);
    await harness.records.recordDiscard(DOCUMENT_URI, second);

    await harness.discarder.retryPendingDeletions();

    expect([await harness.files.exists(first), await harness.files.exists(second)]).toEqual([false, false]);
    expect([recordCount(harness), harness.notifications]).toEqual([0, []]);
  });
});
