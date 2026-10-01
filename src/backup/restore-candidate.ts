import type { InternalErrorSink } from '../diagnostics/error-reporter';
import type { BackupContent } from './backup-content';
import type { BackupFileHost, BackupPurpose, BackupStore } from './backup-store';
import type { RestoreRecordStore } from './restore-record-store';

/** The stores and the file host used to load the candidate. */
export interface RestoreCandidateSources {
  readonly store: BackupStore;
  readonly files: BackupFileHost;
  readonly records: RestoreRecordStore;
  /** Where to record facts the user cannot act on. */
  readonly errorSink: InternalErrorSink;
}

/**
 * The result of selecting a restore candidate.
 *
 * No candidate and failure are distinct. No candidate only hands over to a normal startup, while a failure
 * keeps the backup and shows it to the user.
 */
export type RestoreCandidate =
  /** There is no backup to restore and no backup to adopt. */
  | { readonly kind: 'none' }
  | {
    readonly kind: 'selected';
    readonly backupUri: string;
    readonly purpose: BackupPurpose;
    readonly content: BackupContent;
    /**
     * The backup locations this document adopts. Holds the selected backup and the readable latest protection
     * reference of the same URI, without duplicates.
     */
    readonly adoptedBackupUris: readonly string[];
  }
  | {
    readonly kind: 'failed';
    /** The cause to leave in the diagnostic log. */
    readonly cause: string;
    /** The backup location that could not be read, or `undefined` if the latest protection reference itself could not be read. */
    readonly backupUri: string | undefined;
    readonly adoptedBackupUris: readonly string[];
  };

/**
 * Reads the single restore target from the given backup or from the latest protection reference.
 *
 * Does not compare or choose among other backups. Only the given backup or the single latest protection
 * backup is restored, and even if it was discarded or has disappeared, older backups are not searched.
 *
 * @param sources The stores and the file host.
 * @param documentUri The canonical form of the source URI.
 * @param backupId The backup id VS Code passed, or `undefined` if none.
 * @returns No candidate, the selected backup, or a failure.
 */
export async function loadRestoreCandidate(
  sources: RestoreCandidateSources,
  documentUri: string,
  backupId: string | undefined,
): Promise<RestoreCandidate> {
  let latestProtectionUri: string | undefined;
  try {
    latestProtectionUri = await sources.records.readLatestProtection(documentUri);
  } catch (error) {
    if (backupId === undefined) {
      return {
        kind: 'failed',
        cause: `Could not read the latest protection reference ${documentUri}: ${String(error)}`,
        backupUri: undefined,
        adoptedBackupUris: [],
      };
    }
    // With a given backup the restore can continue. The referenced location is unknown, so it is not adopted
    // and only the fact is recorded.
    sources.errorSink.reportInternalError(
      `Selected the given backup without being able to read the latest protection reference ${documentUri}: ${String(error)}`,
    );
  }

  const targetUri = backupId ?? latestProtectionUri;
  if (targetUri === undefined) {
    return { kind: 'none' };
  }
  const adoptedBackupUris = latestProtectionUri === undefined || latestProtectionUri === targetUri
    ? [targetUri]
    : [targetUri, latestProtectionUri];

  try {
    if (await sources.records.isDiscarded(targetUri)) {
      return { kind: 'none' };
    }
    // VS Code can pass the id of a deleted backup on the next startup. Treating it as a failure would make
    // that source file impossible to open in the WYSIWYG editor.
    if (!(await sources.files.exists(targetUri))) {
      return { kind: 'none' };
    }

    const content = await sources.store.readLatest(targetUri, documentUri);
    if (content === undefined) {
      return {
        kind: 'failed',
        cause: `The backup has no complete generation or its target URI does not match ${targetUri}`,
        backupUri: targetUri,
        adoptedBackupUris,
      };
    }
    return {
      kind: 'selected',
      backupUri: targetUri,
      // A given backup is a hot exit backup, and one selected from the reference is a protection backup. Only a
      // hot exit backup becomes the tracked backup after the restore, so which path selected it is kept.
      purpose: targetUri === backupId ? 'hotExit' : 'protection',
      content,
      adoptedBackupUris,
    };
  } catch (error) {
    return {
      kind: 'failed',
      cause: `Could not read the backup ${targetUri}: ${String(error)}`,
      backupUri: targetUri,
      adoptedBackupUris,
    };
  }
}
