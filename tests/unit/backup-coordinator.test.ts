// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { BACKUP_CONTENT_VERSION } from '../../src/backup/backup-content';
import type { BackupContent } from '../../src/backup/backup-content';
import { BackupCoordinator } from '../../src/backup/backup-coordinator';
import type { BackupUserAction } from '../../src/backup/backup-coordinator';
import { BackupStore } from '../../src/backup/backup-store';
import { createMemoryBackupHost } from './helpers/memory-backup-host';
import type { MemoryBackupHost } from './helpers/memory-backup-host';

const DOCUMENT_URI = 'file:///workspace/a.html';
const HOT_EXIT_PARENT = 'memory:/hot-exit';
const PROTECTION_PARENT = 'memory:/preservation';

const BASE_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>a</p>\n</body>\n</html>\n';
const TEXT_1 = '<!DOCTYPE html>\n<html>\n<body>\n<p>ab</p>\n</body>\n</html>\n';
const TEXT_2 = '<!DOCTYPE html>\n<html>\n<body>\n<p>abc</p>\n</body>\n</html>\n';
const TEXT_3 = '<!DOCTYPE html>\n<html>\n<body>\n<p>abcd</p>\n</body>\n</html>\n';
const STALE_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>stale</p>\n</body>\n</html>\n';

function content(fullText: string, mergeBase: string = BASE_TEXT): BackupContent {
  return { version: BACKUP_CONTENT_VERSION, documentUri: DOCUMENT_URI, fullText, mergeBase };
}

interface Harness {
  readonly coordinator: BackupCoordinator;
  readonly store: BackupStore;
  readonly files: MemoryBackupHost;
  /** Message keys of notifications. Success notices are prefixed with `info:`. */
  readonly notifications: string[];
  readonly logLines: string[];
  readonly executedActions: BackupUserAction[];
  /** The backup locations handed to the discard port. */
  readonly discardedReplaced: string[];
  retained: string | undefined;
  mergeBase: string | undefined;
  /** The latest protection reference. */
  latestProtection: string | undefined;
  /** Whether updating the latest protection reference fails. */
  failLatestProtectionUpdate: boolean;
}

/**
 * Assembles a backup coordinator with a real store and an in-memory backup file host.
 *
 * @param store A replacement store. When omitted, a real store writing to the in-memory backup file host.
 */
function createHarness(createStore?: (files: MemoryBackupHost) => BackupStore): Harness {
  const files = createMemoryBackupHost();
  let token = 0;
  const store = createStore?.(files) ?? new BackupStore(
    files,
    { reportInternalError: () => undefined },
    () => {
      token += 1;
      return `t${token}`;
    },
  );
  const notifications: string[] = [];
  const logLines: string[] = [];
  const executedActions: BackupUserAction[] = [];
  const discardedReplaced: string[] = [];

  const harness: Harness = {
    store,
    files,
    notifications,
    logLines,
    executedActions,
    discardedReplaced,
    retained: TEXT_1,
    mergeBase: BASE_TEXT,
    latestProtection: undefined,
    failLatestProtectionUpdate: false,
    coordinator: new BackupCoordinator(
      {
        documentUri: DOCUMENT_URI,
        protectionParentUri: PROTECTION_PARENT,
        readContentInput: () => ({
          documentUri: DOCUMENT_URI,
          retainedCopy: harness.retained,
          mergeBase: harness.mergeBase,
        }),
        reportUserAction: (key, _actions, cause) => {
          notifications.push(key);
          if (cause !== undefined) {
            logLines.push(cause);
          }
          return Promise.resolve(undefined);
        },
        // Success notices go into the same list with a prefix so they can be told apart.
        reportUserInformation: (key) => {
          notifications.push(`info:${key}`);
          return Promise.resolve(undefined);
        },
        reportInternalError: (detail) => logLines.push(detail),
        runUserAction: (action) => executedActions.push(action),
        updateLatestProtection: (backupUri) => {
          if (harness.failLatestProtectionUpdate) {
            return Promise.reject(new Error('cannot update the latest protection reference'));
          }
          const previous = harness.latestProtection;
          harness.latestProtection = backupUri;
          return Promise.resolve(previous);
        },
        discardReplaced: (backupUris) => discardedReplaced.push(...backupUris),
      },
      store,
    ),
  };
  return harness;
}

const notCancelled = (): boolean => false;

/** Counts the complete generations in the given backup directory. */
function completedGenerations(harness: Harness, backupUri: string): number {
  return harness.files.list(backupUri).filter((name) => name.endsWith('.done')).length;
}

/** A gate that holds writes. Returns the number of held writes and a function that releases them. */
function holdWrites(harness: Harness, matches: (uri: string) => boolean): { held: () => number; release: () => void } {
  const releases: (() => void)[] = [];
  harness.files.interceptWrite = (uri) => {
    if (!matches(uri)) {
      return undefined;
    }
    return new Promise<void>((resolve) => releases.push(resolve));
  };
  return {
    held: () => releases.length,
    release: () => {
      harness.files.interceptWrite = () => undefined;
      for (const release of releases.splice(0)) {
        release();
      }
    },
  };
}

describe('creating a hot exit backup', () => {
  it('reflects full text and merge base updates made during creation in the new backup before returning the identifier', async () => {
    const harness = createHarness();
    const gate = holdWrites(harness, (uri) => uri.endsWith('/1.json'));

    const creating = harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);
    await vi.waitFor(() => expect(gate.held()).toBe(1));
    harness.retained = TEXT_2;
    harness.mergeBase = TEXT_1;
    gate.release();
    const created = await creating;

    await expect(harness.store.readLatest(created.id, DOCUMENT_URI)).resolves.toEqual(content(TEXT_2, TEXT_1));
    expect(harness.coordinator.trackedBackupUri).toBe(created.id);
  });

  it('succeeds with the sync base as the full text for a backup request before any retained copy, and reflects later content in the tracked backup', async () => {
    const harness = createHarness();
    harness.retained = undefined;

    const created = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);
    await expect(harness.store.readLatest(created.id, DOCUMENT_URI)).resolves.toEqual(content(BASE_TEXT));

    harness.retained = TEXT_1;
    harness.coordinator.refresh();

    await vi.waitFor(async () => {
      await expect(harness.store.readLatest(created.id, DOCUMENT_URI)).resolves.toEqual(content(TEXT_1));
    });
    expect(harness.coordinator.trackedBackupUri).toBe(created.id);
  });

  it('fails the backup request when the merge base has not been obtained, regardless of the retained copy', async () => {
    const harness = createHarness();
    harness.retained = undefined;
    harness.mergeBase = undefined;

    await expect(harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled)).rejects.toThrow();

    expect([harness.coordinator.trackedBackupUri, harness.files.list(HOT_EXIT_PARENT)]).toEqual([undefined, []]);
  });

  it('keeps the old tracked backup and returns no identifier when creating the new backup fails', async () => {
    const harness = createHarness();
    const first = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);
    harness.files.exists = () => Promise.reject(new Error('the storage is unavailable'));

    await expect(harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled)).rejects.toThrow();

    expect(harness.coordinator.trackedBackupUri).toBe(first.id);
  });

  it('deletes only the new backup and keeps the old tracked backup when catching up the new backup fails', async () => {
    const harness = createHarness();
    const first = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);
    harness.files.interceptWrite = (uri) => {
      if (uri.startsWith(first.id)) {
        return undefined;
      }
      if (uri.endsWith('/1.done')) {
        // An update arrives just before the first generation finishes, and the write reflecting it fails.
        harness.retained = TEXT_2;
        return undefined;
      }
      return uri.endsWith('/2.json') ? Promise.reject(new Error('disk full')) : undefined;
    };

    await expect(harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled)).rejects.toThrow();

    await vi.waitFor(() => expect(harness.files.list(HOT_EXIT_PARENT)).toEqual([first.id.slice(HOT_EXIT_PARENT.length + 1)]));
    expect(harness.coordinator.trackedBackupUri).toBe(first.id);
  });

  it('creates no new backup and keeps the old tracked backup when cancelled before creation', async () => {
    const harness = createHarness();
    const first = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);

    await expect(harness.coordinator.backup(HOT_EXIT_PARENT, () => true)).rejects.toThrow();

    expect(harness.files.list(HOT_EXIT_PARENT)).toHaveLength(1);
    expect(harness.coordinator.trackedBackupUri).toBe(first.id);
  });

  it('deletes only the new backup after the write completes when cancelled while writing the new backup', async () => {
    const harness = createHarness();
    const first = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);
    let cancelled = false;
    const gate = holdWrites(harness, (uri) => !uri.startsWith(first.id) && uri.endsWith('/1.json'));

    const creating = harness.coordinator.backup(HOT_EXIT_PARENT, () => cancelled);
    await vi.waitFor(() => expect(gate.held()).toBe(1));
    cancelled = true;
    gate.release();

    await expect(creating).rejects.toThrow();
    await vi.waitFor(() => expect(harness.files.list(HOT_EXIT_PARENT)).toHaveLength(1));
    expect(harness.coordinator.trackedBackupUri).toBe(first.id);
  });

  it('returns no identifier and keeps the old tracked backup when cancelled right before the switch', async () => {
    const harness = createHarness();
    const first = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);
    let checks = 0;
    // Cancellation is checked before starting, before catching up, and right before the switch. Only the third cancels.
    const cancelledAtSwitch = (): boolean => {
      checks += 1;
      return checks >= 3;
    };

    await expect(harness.coordinator.backup(HOT_EXIT_PARENT, cancelledAtSwitch)).rejects.toThrow();

    expect([checks, harness.coordinator.trackedBackupUri]).toEqual([3, first.id]);
  });
});

describe('deleting a hot exit backup', () => {
  it('does not untrack the new backup on a delete instruction for the old backup that arrives after the switch', async () => {
    const harness = createHarness();
    const first = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);
    harness.retained = TEXT_2;
    const second = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);

    first.delete();

    expect(harness.coordinator.trackedBackupUri).toBe(second.id);
    await vi.waitFor(() => expect(harness.files.list(HOT_EXIT_PARENT)).toHaveLength(1));
  });
});

describe('rewriting the tracked backup', () => {
  it('writes no file on update when there is no tracked backup', async () => {
    const harness = createHarness();

    harness.retained = TEXT_2;
    harness.coordinator.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect([...harness.files.files.keys()]).toEqual([]);
  });

  it('does not empty the existing backup on an update where the retained copy disappeared', async () => {
    const harness = createHarness();
    const created = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);

    harness.retained = undefined;
    harness.coordinator.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(completedGenerations(harness, created.id)).toBe(1);
    await expect(harness.store.readLatest(created.id, DOCUMENT_URI)).resolves.toEqual(content(TEXT_1));
  });

  it('rewrites the tracked backup even for an update where only the merge base changed', async () => {
    const harness = createHarness();
    const created = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);

    harness.mergeBase = TEXT_2;
    harness.coordinator.refresh();

    await vi.waitFor(async () => {
      await expect(harness.store.readLatest(created.id, DOCUMENT_URI)).resolves.toEqual(content(TEXT_1, TEXT_2));
    });
  });

  it('coalesces consecutive updates into the latest one, keeps concurrent writes to one, and preserves the last update', async () => {
    const harness = createHarness();
    const created = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);
    const gate = holdWrites(harness, (uri) => uri.endsWith('.json'));

    harness.retained = TEXT_2;
    harness.coordinator.refresh();
    await vi.waitFor(() => expect(gate.held()).toBe(1));
    harness.retained = TEXT_3;
    harness.coordinator.refresh();
    harness.retained = TEXT_1;
    harness.coordinator.refresh();
    harness.retained = TEXT_3;
    harness.coordinator.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const heldWhileRunning = gate.held();
    gate.release();

    // Only two generations are written: the first update and the last update coalesced while waiting.
    await vi.waitFor(() => expect(harness.files.list(created.id)).toContain('3.done'));
    expect(heldWhileRunning).toBe(1);
    expect(harness.files.list(created.id)).not.toContain('4.json');
    await expect(harness.store.readLatest(created.id, DOCUMENT_URI)).resolves.toEqual(content(TEXT_3));
  });

  it('reports a failed tracked write and retries with the latest content on the next update', async () => {
    const harness = createHarness();
    const created = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);
    harness.files.interceptWrite = () => Promise.reject(new Error('disk full'));

    harness.retained = TEXT_2;
    harness.coordinator.refresh();
    await vi.waitFor(() => expect(harness.notifications).toEqual(['backup.refreshFailed.message']));
    harness.files.interceptWrite = () => undefined;
    harness.retained = TEXT_3;
    harness.coordinator.refresh();

    await vi.waitFor(async () => {
      await expect(harness.store.readLatest(created.id, DOCUMENT_URI)).resolves.toEqual(content(TEXT_3));
    });
  });
});

describe('protection backup', () => {
  const report = { staleText: STALE_TEXT, pointId: 1, reason: 'the view refused' };

  it('keeps the Promise pending until the protected content reads back matching, then resolves it exactly once', async () => {
    const harness = createHarness();
    const gate = holdWrites(harness, (uri) => uri.startsWith(PROTECTION_PARENT) && uri.endsWith('.done'));
    let resolvedTimes = 0;

    void harness.coordinator.protect(report).then(() => {
      resolvedTimes += 1;
    });
    await vi.waitFor(() => expect(gate.held()).toBe(1));
    const resolvedBeforeVerification = resolvedTimes;
    gate.release();

    await vi.waitFor(() => expect(resolvedTimes).toBe(1));
    expect(resolvedBeforeVerification).toBe(0);
    expect(harness.coordinator.protection?.status).toBe('verified');
    expect(harness.notifications).toEqual(['info:protection.preserved.message']);
  });

  it('reports a failure and does not release the protection wait when there is no old full text', async () => {
    const harness = createHarness();
    let resolved = false;

    void harness.coordinator.protect({ ...report, staleText: undefined }).then(() => {
      resolved = true;
    });

    await vi.waitFor(() => expect(harness.notifications).toEqual(['protection.preservationFailed.message']));
    expect([resolved, harness.coordinator.protection?.status]).toEqual([false, 'failed']);
  });

  it('does not treat the protection backup as successful when there is no merge base', async () => {
    const harness = createHarness();
    harness.mergeBase = undefined;
    let resolved = false;

    void harness.coordinator.protect(report).then(() => {
      resolved = true;
    });

    await vi.waitFor(() => expect(harness.coordinator.protection?.status).toBe('failed'));
    expect(resolved).toBe(false);
  });

  it('does not release the protection wait when writing the protection backup fails', async () => {
    const harness = createHarness();
    harness.files.interceptWrite = () => Promise.reject(new Error('disk full'));
    let resolved = false;

    void harness.coordinator.protect(report).then(() => {
      resolved = true;
    });

    await vi.waitFor(() => expect(harness.coordinator.protection?.status).toBe('failed'));
    expect(resolved).toBe(false);
  });

  it('does not release the protection wait when the protection backup read-back does not match', async () => {
    // A store that reads back content different from the written generation, failing only the read-back check.
    class DivergingStore extends BackupStore {
      override readLatest(): Promise<BackupContent | undefined> {
        return Promise.resolve(content(TEXT_2));
      }
    }
    const harness = createHarness((files) => new DivergingStore(files, { reportInternalError: () => undefined }, () => 'x'));
    let resolved = false;

    void harness.coordinator.protect(report).then(() => {
      resolved = true;
    });

    await vi.waitFor(() => expect(harness.coordinator.protection?.status).toBe('failed'));
    expect(resolved).toBe(false);
  });

  it('retries with the same old full text and merge base, and on success also releases the initial protection wait', async () => {
    const harness = createHarness();
    harness.files.interceptWrite = () => Promise.reject(new Error('disk full'));
    let resolved = false;
    void harness.coordinator.protect(report).then(() => {
      resolved = true;
    });
    await vi.waitFor(() => expect(harness.coordinator.protection?.status).toBe('failed'));
    harness.files.interceptWrite = () => undefined;
    harness.retained = TEXT_3;
    harness.mergeBase = TEXT_2;

    const retried = await harness.coordinator.retryProtection();

    const backupUri = harness.coordinator.protection?.backupUri ?? '';
    await expect(harness.store.readLatest(backupUri, DOCUMENT_URI)).resolves.toEqual(content(STALE_TEXT, BASE_TEXT));
    await vi.waitFor(() => expect([retried, resolved]).toEqual([true, true]));
  });

  it('does not delete backups when the document is disposed under protection, and releases the pending protection wait', async () => {
    const harness = createHarness();
    const created = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);
    harness.files.interceptWrite = () => Promise.reject(new Error('disk full'));
    let resolved = false;
    void harness.coordinator.protect(report).then(() => {
      resolved = true;
    });
    await vi.waitFor(() => expect(harness.coordinator.protection?.status).toBe('failed'));

    harness.coordinator.dispose();

    await vi.waitFor(() => expect(resolved).toBe(true));
    expect(completedGenerations(harness, created.id)).toBe(1);
    expect(harness.notifications).toContain('protection.closedWithoutBackup.message');
  });
});

describe('updating the latest protection reference', () => {
  const report = { staleText: STALE_TEXT, pointId: 1, reason: 'the view refused' };

  it('updates the latest protection reference after verifying the protection backup and hands the previous location to the discard port', async () => {
    const harness = createHarness();
    harness.latestProtection = `${PROTECTION_PARENT}/protection-old`;

    await harness.coordinator.protect(report);

    const backupUri = harness.coordinator.protection?.backupUri;
    expect(harness.latestProtection).toBe(backupUri);
    expect(harness.discardedReplaced).toEqual([`${PROTECTION_PARENT}/protection-old`]);
  });

  it('fails the protection backup and keeps the protection wait when the latest protection reference cannot be updated', async () => {
    const harness = createHarness();
    harness.failLatestProtectionUpdate = true;
    let resolved = false;

    void harness.coordinator.protect(report).then(() => {
      resolved = true;
    });

    await vi.waitFor(() => expect(harness.coordinator.protection?.status).toBe('failed'));
    expect([resolved, harness.notifications]).toEqual([false, ['protection.preservationFailed.message']]);
  });
});

describe('tracking adopted backups and confirming their discard', () => {
  const designated = 'memory:/hot-exit/hotExit-designated';

  it('rewrites a given backup that started being tracked with the current retained copy and merge base', async () => {
    const harness = createHarness();
    harness.coordinator.adoptBackup(designated);
    harness.retained = TEXT_2;
    harness.mergeBase = TEXT_1;

    harness.coordinator.trackRestoredBackup(designated);

    await vi.waitFor(async () => {
      await expect(harness.store.readLatest(designated, DOCUMENT_URI)).resolves.toEqual(content(TEXT_2, TEXT_1));
    });
    expect(harness.coordinator.trackedBackupUri).toBe(designated);
  });

  it('hands the given backup to the discard port when switching from it to a new backup', async () => {
    const harness = createHarness();
    harness.coordinator.adoptBackup(designated);
    harness.coordinator.trackRestoredBackup(designated);

    const created = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);

    expect(harness.discardedReplaced).toEqual([designated]);
    expect(harness.coordinator.trackedBackupUri).toBe(created.id);
  });

  it('does not call the discard port when switching from a backup it created itself', async () => {
    const harness = createHarness();
    await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);
    harness.retained = TEXT_2;

    await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);

    expect(harness.discardedReplaced).toEqual([]);
  });

  it('does not include backups created after the call in the targets', async () => {
    const harness = createHarness();
    const first = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);

    const targets = harness.coordinator.takeDiscardTargets();
    harness.retained = TEXT_2;
    const second = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);

    expect(targets).toEqual([first.id]);
    expect(harness.coordinator.takeDiscardTargets()).toEqual([second.id]);
  });

  it('does not rewrite later updates to a tracked backup that became a target', async () => {
    const harness = createHarness();
    const created = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);

    harness.coordinator.takeDiscardTargets();
    harness.retained = TEXT_2;
    harness.coordinator.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(completedGenerations(harness, created.id)).toBe(1);
    await expect(harness.store.readLatest(created.id, DOCUMENT_URI)).resolves.toEqual(content(TEXT_1));
  });

  it('makes a returned backup a target again at the next discard trigger', async () => {
    const harness = createHarness();
    const created = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);
    const targets = harness.coordinator.takeDiscardTargets();

    harness.coordinator.returnDiscardTargets(targets);

    expect(harness.coordinator.adoptedBackupUris).toEqual([created.id]);
    expect(harness.coordinator.takeDiscardTargets()).toEqual([created.id]);
  });

  it('does not announce that a discard-confirmed protection backup remains when closing', async () => {
    const harness = createHarness();
    await harness.coordinator.protect({ staleText: STALE_TEXT, pointId: 1, reason: 'the view refused' });
    harness.notifications.length = 0;
    harness.coordinator.takeDiscardTargets();

    harness.coordinator.dispose();

    expect(harness.notifications).toEqual([]);
  });
});

describe('delete instruction for a discard-confirmed backup', () => {
  it('does not call the backup store on a delete instruction for a discard-confirmed backup', async () => {
    const harness = createHarness();
    const created = await harness.coordinator.backup(HOT_EXIT_PARENT, notCancelled);
    harness.coordinator.takeDiscardTargets();
    let deletes = 0;
    harness.files.delete = () => {
      deletes += 1;
      return Promise.resolve();
    };

    created.delete();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect([deletes, harness.coordinator.trackedBackupUri]).toEqual([0, undefined]);
  });
});
