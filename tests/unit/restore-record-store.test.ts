// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { RestoreRecordStore } from '../../src/backup/restore-record-store';
import { createMemoryBackupHost } from './helpers/memory-backup-host';
import type { MemoryBackupHost } from './helpers/memory-backup-host';

const RECORD_PARENT = 'memory:/preservation/records';
const DOCUMENT_URI = 'file:///workspace/a.html';
const OTHER_DOCUMENT_URI = 'file:///workspace/b.html';
const BACKUP_URI = 'memory:/preservation/protection-1';
const OTHER_BACKUP_URI = 'memory:/preservation/protection-2';

interface Harness {
  readonly store: RestoreRecordStore;
  readonly files: MemoryBackupHost;
  readonly logLines: string[];
}

function createHarness(): Harness {
  const files = createMemoryBackupHost();
  const logLines: string[] = [];
  return {
    files,
    logLines,
    store: new RestoreRecordStore(files, RECORD_PARENT, {
      reportInternalError: (detail) => logLines.push(detail),
    }),
  };
}

/**
 * Returns the names of records under the records' parent that match a prefix. Used so the tests do not copy how
 * record names are built.
 */
function findRecordNames(harness: Harness, prefix: string): string[] {
  return harness.files.list(RECORD_PARENT).filter((name) => name.startsWith(prefix));
}

/** Replaces a record's contents with bytes that cannot be parsed as JSON. */
function corruptRecord(harness: Harness, name: string): void {
  harness.files.files.set(`${RECORD_PARENT}/${name}`, new TextEncoder().encode('{'));
}

describe('latest protection reference', () => {
  it('returns the previous location on update, and later reads return the new backup location', async () => {
    const harness = createHarness();

    const first = await harness.store.updateLatestProtection(DOCUMENT_URI, BACKUP_URI);
    const second = await harness.store.updateLatestProtection(DOCUMENT_URI, OTHER_BACKUP_URI);

    expect([first, second]).toEqual([undefined, BACKUP_URI]);
    await expect(harness.store.readLatestProtection(DOCUMENT_URI)).resolves.toBe(OTHER_BACKUP_URI);
  });

  it('fails the update when the read-back of the written reference does not match', async () => {
    const harness = createHarness();
    // Simulates storage that keeps different content from what was written.
    harness.files.writeFile = (uri) => {
      harness.files.files.set(uri, new TextEncoder().encode(
        JSON.stringify({ version: 1, documentUri: DOCUMENT_URI, backupUri: OTHER_BACKUP_URI }),
      ));
      return Promise.resolve();
    };

    await expect(harness.store.updateLatestProtection(DOCUMENT_URI, BACKUP_URI)).rejects.toThrow();
  });

  it('does not let references of different source URIs overwrite each other', async () => {
    const harness = createHarness();

    await harness.store.updateLatestProtection(DOCUMENT_URI, BACKUP_URI);
    await harness.store.updateLatestProtection(OTHER_DOCUMENT_URI, OTHER_BACKUP_URI);

    await expect(Promise.all([
      harness.store.readLatestProtection(DOCUMENT_URI),
      harness.store.readLatestProtection(OTHER_DOCUMENT_URI),
    ])).resolves.toEqual([BACKUP_URI, OTHER_BACKUP_URI]);
  });

  it('fails to read a malformed reference record', async () => {
    const harness = createHarness();
    await harness.store.updateLatestProtection(DOCUMENT_URI, BACKUP_URI);
    corruptRecord(harness, findRecordNames(harness, 'latest-')[0]);

    await expect(harness.store.readLatestProtection(DOCUMENT_URI)).rejects.toThrow();
  });

  it('does not release when the reference has already been updated to another backup location', async () => {
    const harness = createHarness();
    await harness.store.updateLatestProtection(DOCUMENT_URI, BACKUP_URI);
    await harness.store.updateLatestProtection(DOCUMENT_URI, OTHER_BACKUP_URI);

    await harness.store.releaseLatestProtection(DOCUMENT_URI, BACKUP_URI);

    await expect(harness.store.readLatestProtection(DOCUMENT_URI)).resolves.toBe(OTHER_BACKUP_URI);
  });
});

describe('discard record', () => {
  it('treats a discard record whose contents cannot be read as a discard record', async () => {
    const harness = createHarness();
    await harness.store.recordDiscard(DOCUMENT_URI, BACKUP_URI);
    corruptRecord(harness, findRecordNames(harness, 'discard-')[0]);

    await expect(harness.store.isDiscarded(BACKUP_URI)).resolves.toBe(true);
  });

  it('excludes an unreadable discard record from the list, logs it, and does not delete it', async () => {
    const harness = createHarness();
    await harness.store.recordDiscard(DOCUMENT_URI, BACKUP_URI);
    await harness.store.recordDiscard(OTHER_DOCUMENT_URI, OTHER_BACKUP_URI);
    const names = findRecordNames(harness, 'discard-');
    corruptRecord(harness, names[0]);

    const listed = await harness.store.listDiscards();

    expect(listed).toHaveLength(1);
    expect(harness.logLines).toHaveLength(1);
    expect(findRecordNames(harness, 'discard-')).toEqual(names);
  });
});
