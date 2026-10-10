// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { BACKUP_CONTENT_VERSION } from '../../src/backup/backup-content';
import type { BackupContent } from '../../src/backup/backup-content';
import { BackupStore } from '../../src/backup/backup-store';
import type { BackupPurpose } from '../../src/backup/backup-store';
import { loadRestoreCandidate } from '../../src/backup/restore-candidate';
import type { RestoreCandidate } from '../../src/backup/restore-candidate';
import { RestoreRecordStore } from '../../src/backup/restore-record-store';
import { createMemoryBackupHost } from './helpers/memory-backup-host';
import type { MemoryBackupHost } from './helpers/memory-backup-host';

const BACKUP_PARENT = 'memory:/preservation';
const RECORD_PARENT = 'memory:/preservation/records';
const DOCUMENT_URI = 'file:///workspace/a.html';
const OTHER_DOCUMENT_URI = 'file:///workspace/b.html';

const BASE_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>a</p>\n</body>\n</html>\n';
const BACKUP_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>ab</p>\n</body>\n</html>\n';
const LATEST_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>abc</p>\n</body>\n</html>\n';

interface Harness {
  readonly store: BackupStore;
  readonly records: RestoreRecordStore;
  readonly files: MemoryBackupHost;
  readonly logLines: string[];
  load(backupId?: string): Promise<RestoreCandidate>;
}

function content(fullText: string, documentUri: string = DOCUMENT_URI): BackupContent {
  return { version: BACKUP_CONTENT_VERSION, documentUri, fullText, mergeBase: BASE_TEXT };
}

function createHarness(): Harness {
  const files = createMemoryBackupHost();
  const logLines: string[] = [];
  const errorSink = { reportInternalError: (detail: string) => logLines.push(detail) };
  let token = 0;
  const store = new BackupStore(files, errorSink, () => {
    token += 1;
    return `t${token}`;
  });
  const records = new RestoreRecordStore(files, RECORD_PARENT, errorSink);

  return {
    store,
    records,
    files,
    logLines,
    load: (backupId) => loadRestoreCandidate({ store, files, records, errorSink }, DOCUMENT_URI, backupId),
  };
}

/** Creates a backup with one complete generation. */
async function createBackup(
  harness: Harness,
  purpose: BackupPurpose,
  ...generations: readonly BackupContent[]
): Promise<string> {
  const backupUri = await harness.store.create(BACKUP_PARENT, purpose);
  for (const generation of generations) {
    await harness.store.writeGeneration(backupUri, generation);
  }
  return backupUri;
}

/** Replaces the latest protection reference record with bytes that cannot be parsed as JSON. */
function corruptLatestRecord(harness: Harness): void {
  const name = harness.files.list(RECORD_PARENT).find((entry) => entry.startsWith('latest-')) ?? '';
  harness.files.files.set(`${RECORD_PARENT}/${name}`, new TextEncoder().encode('{'));
}

describe('restore candidate selection', () => {
  it('selects the given backup when there is a backup id, and includes the latest protection backup of the same URI in the adopted list', async () => {
    const harness = createHarness();
    const designated = await createBackup(harness, 'hotExit', content(BACKUP_TEXT));
    const protection = await createBackup(harness, 'protection', content(LATEST_TEXT));
    await harness.records.updateLatestProtection(DOCUMENT_URI, protection);

    const candidate = await harness.load(designated);

    expect(candidate).toEqual({
      kind: 'selected',
      backupUri: designated,
      purpose: 'hotExit',
      content: content(BACKUP_TEXT),
      adoptedBackupUris: [designated, protection],
    });
  });

  it('selects the latest complete generation of the protection backup the latest protection reference points to when there is no id', async () => {
    const harness = createHarness();
    const protection = await createBackup(harness, 'protection', content(BACKUP_TEXT), content(LATEST_TEXT));
    await harness.records.updateLatestProtection(DOCUMENT_URI, protection);

    const candidate = await harness.load();

    expect(candidate).toEqual({
      kind: 'selected',
      backupUri: protection,
      purpose: 'protection',
      content: content(LATEST_TEXT),
      adoptedBackupUris: [protection],
    });
  });

  it('returns no candidate when there is neither an id nor a latest protection reference', async () => {
    const harness = createHarness();

    await expect(harness.load()).resolves.toEqual({ kind: 'none' });
  });

  it('returns no candidate without reading a given backup that has a discard record', async () => {
    const harness = createHarness();
    const designated = await createBackup(harness, 'hotExit', content(BACKUP_TEXT));
    await harness.records.recordDiscard(DOCUMENT_URI, designated);
    // Make any read attempt fail, to confirm the contents were not read.
    harness.files.readFile = (uri) => uri.startsWith(designated)
      ? Promise.reject(new Error('must not be read'))
      : Promise.reject(new Error(`missing ${uri}`));

    await expect(harness.load(designated)).resolves.toEqual({ kind: 'none' });
  });

  it('returns no candidate, not a failure, for a given backup whose location does not exist', async () => {
    const harness = createHarness();

    await expect(harness.load(`${BACKUP_PARENT}/hotExit-deleted`)).resolves.toEqual({ kind: 'none' });
  });

  it('fails for a backup with a different target URI and includes that backup location in the adopted list', async () => {
    const harness = createHarness();
    const designated = await createBackup(harness, 'hotExit', content(BACKUP_TEXT, OTHER_DOCUMENT_URI));

    const candidate = await harness.load(designated);

    expect(candidate.kind).toBe('failed');
    expect(candidate).toMatchObject({ backupUri: designated, adoptedBackupUris: [designated] });
  });

  it('returns a failure when reading the backup ends with an exception', async () => {
    const harness = createHarness();
    const designated = await createBackup(harness, 'hotExit', content(BACKUP_TEXT));
    harness.files.readDirectory = () => Promise.reject(new Error('storage is unavailable'));

    const candidate = await harness.load(designated);

    expect(candidate).toMatchObject({ kind: 'failed', backupUri: designated });
  });

  it('returns a failure when there is no id and the latest protection reference cannot be read', async () => {
    const harness = createHarness();
    const protection = await createBackup(harness, 'protection', content(LATEST_TEXT));
    await harness.records.updateLatestProtection(DOCUMENT_URI, protection);
    corruptLatestRecord(harness);

    const candidate = await harness.load();

    expect(candidate).toMatchObject({ kind: 'failed', backupUri: undefined, adoptedBackupUris: [] });
  });

  it('selects the given backup when there is an id even if the latest protection reference cannot be read, and does not adopt the referenced location', async () => {
    const harness = createHarness();
    const designated = await createBackup(harness, 'hotExit', content(BACKUP_TEXT));
    const protection = await createBackup(harness, 'protection', content(LATEST_TEXT));
    await harness.records.updateLatestProtection(DOCUMENT_URI, protection);
    corruptLatestRecord(harness);

    const candidate = await harness.load(designated);

    expect(candidate).toMatchObject({ kind: 'selected', backupUri: designated, adoptedBackupUris: [designated] });
    expect(harness.logLines).toHaveLength(1);
  });
});
