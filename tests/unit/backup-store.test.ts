// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { BACKUP_CONTENT_VERSION, encodeBackupContent } from '../../src/backup/backup-content';
import type { BackupContent } from '../../src/backup/backup-content';
import { BackupStore } from '../../src/backup/backup-store';
import { createMemoryBackupHost } from './helpers/memory-backup-host';
import type { MemoryBackupHost } from './helpers/memory-backup-host';

const DOCUMENT_URI = 'file:///workspace/a.html';
const PARENT_URI = 'memory:/backups';

const CONTENT_A = content('<!DOCTYPE html>\n<html>\n<body>\n<p>a</p>\n</body>\n</html>\n');
const CONTENT_B = content('<!DOCTYPE html>\n<html>\n<body>\n<p>b</p>\n</body>\n</html>\n');
const CONTENT_C = content('<!DOCTYPE html>\n<html>\n<body>\n<p>c</p>\n</body>\n</html>\n');

function content(fullText: string): BackupContent {
  return { version: BACKUP_CONTENT_VERSION, documentUri: DOCUMENT_URI, fullText, mergeBase: '' };
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A backup file host with lines recording collection failures. */
type MemoryHost = MemoryBackupHost & { readonly logLines: string[] };

function createMemoryHost(): MemoryHost {
  return Object.assign(createMemoryBackupHost(), { logLines: [] as string[] });
}

function createStore(host: MemoryHost): BackupStore {
  let token = 0;
  return new BackupStore(
    host,
    { reportInternalError: (detail) => host.logLines.push(detail) },
    () => {
      token += 1;
      return `token${token}`;
    },
    () => 0,
  );
}

/** Prepares a backup with one generation fully written. */
async function createBackupWith(host: MemoryHost, first: BackupContent): Promise<{ store: BackupStore; uri: string }> {
  const store = createStore(host);
  const uri = await store.create(PARENT_URI, 'hotExit');
  await store.writeGeneration(uri, first);
  return { store, uri };
}

describe('reading the latest generation', () => {
  it('returns the previous complete generation when the new generation has no completion marker', async () => {
    const host = createMemoryHost();
    const { store, uri } = await createBackupWith(host, CONTENT_A);
    host.files.set(`${uri}/2.json`, encodeBackupContent(CONTENT_B));

    await expect(store.readLatest(uri, DOCUMENT_URI)).resolves.toEqual(CONTENT_A);
  });

  it('returns the previous complete generation when the new generation\'s completion marker is truncated', async () => {
    const host = createMemoryHost();
    const { store, uri } = await createBackupWith(host, CONTENT_A);
    const bytes = encodeBackupContent(CONTENT_B);
    host.files.set(`${uri}/2.json`, bytes);
    host.files.set(`${uri}/2.done`, utf8(`${BACKUP_CONTENT_VERSION} 2 ${bytes.length}`));

    await expect(store.readLatest(uri, DOCUMENT_URI)).resolves.toEqual(CONTENT_A);
  });

  it('returns the previous complete generation when the new generation\'s byte length differs from its completion marker', async () => {
    const host = createMemoryHost();
    const { store, uri } = await createBackupWith(host, CONTENT_A);
    const bytes = encodeBackupContent(CONTENT_B);
    host.files.set(`${uri}/2.json`, bytes);
    host.files.set(`${uri}/2.done`, utf8(`${BACKUP_CONTENT_VERSION} 2 ${bytes.length + 1}\n`));

    await expect(store.readLatest(uri, DOCUMENT_URI)).resolves.toEqual(CONTENT_A);
  });

  it('returns the previous complete generation when the new generation has an invalid format', async () => {
    const host = createMemoryHost();
    const { store, uri } = await createBackupWith(host, CONTENT_A);
    const bytes = utf8('{"version":1,"documentUri":"file:///workspace/a.html"}');
    host.files.set(`${uri}/2.json`, bytes);
    host.files.set(`${uri}/2.done`, utf8(`${BACKUP_CONTENT_VERSION} 2 ${bytes.length}\n`));

    await expect(store.readLatest(uri, DOCUMENT_URI)).resolves.toEqual(CONTENT_A);
  });
});

describe('writing a new generation', () => {
  it('can read the previous complete generation even after exiting in the middle of writing the new generation\'s JSON', async () => {
    const host = createMemoryHost();
    const { store, uri } = await createBackupWith(host, CONTENT_A);
    host.interceptWrite = (target, bytes) => {
      host.files.set(target, bytes.slice(0, Math.floor(bytes.length / 2)));
      return new Promise<void>(() => undefined);
    };

    void store.writeGeneration(uri, CONTENT_B);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // An extension host restarted after the exit has no state from the previous run.
    await expect(createStore(host).readLatest(uri, DOCUMENT_URI)).resolves.toEqual(CONTENT_A);
  });

  it('can read the previous complete generation even after exiting in the middle of writing the new generation\'s completion marker', async () => {
    const host = createMemoryHost();
    const { store, uri } = await createBackupWith(host, CONTENT_A);
    host.interceptWrite = (target, bytes) => {
      if (!target.endsWith('.done')) {
        return undefined;
      }
      host.files.set(target, bytes.slice(0, bytes.length - 2));
      return new Promise<void>(() => undefined);
    };

    void store.writeGeneration(uri, CONTENT_B);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(createStore(host).readLatest(uri, DOCUMENT_URI)).resolves.toEqual(CONTENT_A);
  });

  it('keeps the latest and previous complete generations even if deleting old generations fails after publishing the latest', async () => {
    const host = createMemoryHost();
    const { store, uri } = await createBackupWith(host, CONTENT_A);
    await store.writeGeneration(uri, CONTENT_B);
    host.failDeleteOf = () => true;

    await store.writeGeneration(uri, CONTENT_C);

    expect(host.list(uri).sort()).toEqual(['1.done', '1.json', '2.done', '2.json', '3.done', '3.json']);
    expect(host.logLines).toHaveLength(2);
    await expect(store.readLatest(uri, DOCUMENT_URI)).resolves.toEqual(CONTENT_C);
  });

  it('keeps the latest and the previous valid complete generation when updating after a partial completion marker write failed', async () => {
    const host = createMemoryHost();
    const { store, uri } = await createBackupWith(host, CONTENT_A);
    host.interceptWrite = (target, bytes) => {
      if (target !== `${uri}/2.done`) {
        return undefined;
      }
      host.files.set(target, bytes.slice(0, bytes.length - 2));
      return Promise.reject(new Error('The completion marker write was cut off'));
    };
    await expect(store.writeGeneration(uri, CONTENT_B)).rejects.toThrow('The completion marker write was cut off');
    host.interceptWrite = () => undefined;

    await store.writeGeneration(uri, CONTENT_C);

    expect(host.list(uri).sort()).toEqual(['1.done', '1.json', '3.done', '3.json']);
    await expect(store.readLatest(uri, DOCUMENT_URI)).resolves.toEqual(CONTENT_C);
    // Confirm that the kept old generation can still be read even when the latest generation is unusable.
    host.files.delete(`${uri}/3.done`);
    await expect(createStore(host).readLatest(uri, DOCUMENT_URI)).resolves.toEqual(CONTENT_A);
  });

  it.each([
    {
      condition: 'a completion marker missing its trailing newline',
      bytes: encodeBackupContent(CONTENT_B),
      marker: `${BACKUP_CONTENT_VERSION} 2 ${encodeBackupContent(CONTENT_B).length}`,
    },
    {
      condition: 'a completion marker byte length mismatch',
      bytes: encodeBackupContent(CONTENT_B),
      marker: `${BACKUP_CONTENT_VERSION} 2 ${encodeBackupContent(CONTENT_B).length + 1}\n`,
    },
    {
      condition: 'an invalid backup format',
      bytes: utf8('{}'),
      marker: `${BACKUP_CONTENT_VERSION} 2 2\n`,
    },
  ])('excludes an old generation with $condition during collection after a restart and keeps the valid complete generation', async ({ bytes, marker }) => {
    const host = createMemoryHost();
    const { uri } = await createBackupWith(host, CONTENT_A);
    host.files.set(`${uri}/2.json`, bytes);
    host.files.set(`${uri}/2.done`, utf8(marker));
    const restarted = createStore(host);

    await restarted.writeGeneration(uri, CONTENT_C);

    expect(host.list(uri).sort()).toEqual(['1.done', '1.json', '3.done', '3.json']);
    await expect(restarted.readLatest(uri, DOCUMENT_URI)).resolves.toEqual(CONTENT_C);
  });

  it('skips collection and records to the diagnostic log when reading an old generation fails, while publishing the new generation succeeds', async () => {
    const host = createMemoryHost();
    const { store, uri } = await createBackupWith(host, CONTENT_A);
    await store.writeGeneration(uri, CONTENT_B);
    const readFile = host.readFile;
    host.readFile = (target) => target === `${uri}/2.done`
      ? Promise.reject(new Error('Cannot read the old generation completion marker'))
      : readFile(target);

    await expect(store.writeGeneration(uri, CONTENT_C)).resolves.toEqual(CONTENT_C);

    expect(host.list(uri).sort()).toEqual(['1.done', '1.json', '2.done', '2.json', '3.done', '3.json']);
    expect(host.logLines).toHaveLength(1);
    expect(host.logLines[0]).toContain('Cannot read the old generation completion marker');
    await expect(store.readLatest(uri, DOCUMENT_URI)).resolves.toEqual(CONTENT_C);
  });
});

describe('deleting a backup', () => {
  it('stops later writes on a delete during a write, deletes after the running write completes, and does not recreate', async () => {
    const host = createMemoryHost();
    const store = createStore(host);
    const uri = await store.create(PARENT_URI, 'hotExit');
    let releaseWrite = (): void => undefined;
    const events: string[] = [];
    host.interceptWrite = (target) => {
      events.push(`write ${target.slice(uri.length + 1)}`);
      if (!target.endsWith('1.json')) {
        return undefined;
      }
      return new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
    };

    const running = store.writeGeneration(uri, CONTENT_A);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const deleting = store.delete(uri).then(() => events.push('deleted'));
    const following = store.writeGeneration(uri, CONTENT_B);
    releaseWrite();

    await expect(running).resolves.toEqual(CONTENT_A);
    await expect(following).rejects.toThrow();
    await deleting;
    expect(events).toEqual(['write 1.json', 'write 1.done', 'deleted']);
    expect(host.list(PARENT_URI)).toEqual([]);
  });
});
