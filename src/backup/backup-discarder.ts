import type { MessageKey, MessageParams } from '../../common/index';
import type { BackupStore } from './backup-store';
import type { RestoreDiscardRecord, RestoreRecordStore } from './restore-record-store';

/** The environment-independent port the backup discarder uses. */
export interface BackupDiscarderHost {
  /** Returns whether anything exists at the backup location. Checks with the same URI string as the file host. */
  exists(uri: string): Promise<boolean>;

  /**
   * Tells the user that a backup remains.
   *
   * Does not wait. A notification does not resolve until the user closes it, so including it in the discard
   * result would keep the discard from finishing.
   *
   * @param key The message key of the notification body.
   * @param cause The cause to leave in the diagnostic log.
   * @param params The placeholder values for the body.
   */
  notifyFailure(key: MessageKey, cause: string, params: MessageParams): void;

  /** Leaves a fact the user cannot act on in the diagnostic log. */
  reportInternalError(detail: string): void;
}

/**
 * Reliably removes adopted backups.
 *
 * Persists the discard record before deleting. Deleting alone would restore a backup whose deletion failed
 * again on the next startup, bringing back content the user meant to discard.
 */
export class BackupDiscarder {
  // The backup locations being deleted. If redeletion at startup and a discard trigger overlapped, the same
  // location would be deleted twice concurrently.
  private readonly deleting = new Set<string>();

  /**
   * @param host The environment-independent port.
   * @param store The store that deletes in series with the writes of each backup location.
   * @param records The store of discard records and latest protection references.
   */
  constructor(
    private readonly host: BackupDiscarderHost,
    private readonly store: BackupStore,
    private readonly records: RestoreRecordStore,
  ) {}

  /**
   * Starts deleting after recording the discard and releasing the latest protection reference.
   *
   * Does not wait for the deletion to finish. The caller can confirm the discard once it is recorded, and a failed
   * physical deletion can be left to redeletion at startup.
   *
   * @param documentUri The canonical form of the source URI.
   * @param backupUris The backup locations to discard.
   * @returns The backup locations whose discard could not be recorded.
   */
  async discard(documentUri: string, backupUris: readonly string[]): Promise<readonly string[]> {
    const unrecorded: string[] = [];

    for (const backupUri of backupUris) {
      try {
        await this.records.recordDiscard(documentUri, backupUri);
      } catch (error) {
        // Deleting without a record would show a backup left undeleted as an "unreadable backup" failure on the
        // next startup.
        unrecorded.push(backupUri);
        this.host.notifyFailure(
          'restore.discardRecordFailed.message',
          `Could not persist the discard record ${backupUri}: ${String(error)}`,
          { location: backupUri },
        );
        continue;
      }

      await this.releaseLatestProtection(documentUri, backupUri);
      void this.deleteRecorded(documentUri, backupUri);
    }

    return unrecorded;
  }

  /**
   * Deletes a backup that has a discard record, and deletes the record after confirming the backup is gone.
   *
   * @param documentUri The canonical form of the source URI.
   * @param backupUri The backup location that has a discard record.
   */
  async deleteRecorded(documentUri: string, backupUri: string): Promise<void> {
    if (this.deleting.has(backupUri)) {
      return;
    }
    this.deleting.add(backupUri);

    try {
      // The real file API throws when asked to delete a location that is already gone, so check existence first.
      if (await this.host.exists(backupUri)) {
        // Wait for writes in progress before deleting. Deleting without waiting would let a later write recreate
        // the location.
        await this.store.delete(backupUri);
        if (await this.host.exists(backupUri)) {
          throw new Error('The backup location still exists after deletion');
        }
      }
      await this.records.clearDiscard(backupUri);
    } catch (error) {
      // The discard record is kept. Deleting the record of a backup that is not gone would make it a restore
      // candidate again on the next open.
      this.host.notifyFailure(
        'restore.deleteFailed.message',
        `Could not delete the backup ${documentUri} ${backupUri}: ${String(error)}`,
        { location: backupUri },
      );
    } finally {
      this.deleting.delete(backupUri);
    }
  }

  /**
   * Redeletes every backup that has a discard record.
   *
   * The extension activates when any WYSIWYG editor opens, so backups of source files that are never reopened
   * are also removed here.
   */
  async retryPendingDeletions(): Promise<void> {
    let records: readonly RestoreDiscardRecord[];
    try {
      records = await this.records.listDiscards();
    } catch (error) {
      this.host.reportInternalError(`Could not list the discard records: ${String(error)}`);
      return;
    }

    for (const record of records) {
      await this.releaseLatestProtection(record.documentUri, record.backupUri);
      await this.deleteRecorded(record.documentUri, record.backupUri);
    }
  }

  /**
   * Releases the latest protection reference that matches the target.
   *
   * The backup deletion proceeds even if the release fails. Even if only the reference remains, it yields no
   * candidate on the next startup once what it points to is gone.
   *
   * @param documentUri The canonical form of the source URI.
   * @param backupUri The backup location to discard.
   */
  private async releaseLatestProtection(documentUri: string, backupUri: string): Promise<void> {
    try {
      await this.records.releaseLatestProtection(documentUri, backupUri);
    } catch (error) {
      this.host.reportInternalError(`Could not release the latest protection reference ${documentUri} ${backupUri}: ${String(error)}`);
    }
  }
}
