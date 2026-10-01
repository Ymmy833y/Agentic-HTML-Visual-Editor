import type { MessageKey, MessageParams } from '../../common/index';
import type {
  HistoryProtectionReport,
  HistoryProtectionSink,
} from '../history/edit-history-coordinator';
import { assembleBackupContent, isSameBackupContent } from './backup-content';
import type { BackupContent, BackupContentInput } from './backup-content';
import type { BackupStore } from './backup-store';

/** Actions selectable from a notification. */
export type BackupUserAction = Extract<MessageKey, 'recovery.recover' | 'recovery.saveAs'>;

/** The VS Code-independent host used by the backup coordinator. */
export interface BackupCoordinatorHost {
  /** The canonical form of the target document's URI. */
  readonly documentUri: string;

  /** The URI of the parent directory for protection backups. */
  readonly protectionParentUri: string;

  /**
   * Reads the retained copy and the merge base.
   *
   * Both are read in the same synchronous call. Awaiting in between would pair a full text and a merge base from
   * different points in time.
   */
  readContentInput(): BackupContentInput;

  /**
   * Reports a result and returns the selected action.
   *
   * @param key The message key of the notification body.
   * @param actions The actions to offer.
   * @param cause The cause to record in the diagnostic log.
   * @param params Values for the placeholders in the body.
   */
  reportUserAction(
    key: MessageKey,
    actions: readonly BackupUserAction[],
    cause?: string,
    params?: MessageParams,
  ): Promise<BackupUserAction | undefined>;

  /**
   * Reports a success and returns the selected action. Showing it as an error notification would make a successful
   * backup look like a failure.
   *
   * @param key The message key of the notification body.
   * @param actions The actions to offer.
   */
  reportUserInformation(key: MessageKey, actions: readonly BackupUserAction[]): Promise<BackupUserAction | undefined>;

  /** Records a fact the user cannot act on in the diagnostic log. */
  reportInternalError(detail: string): void;

  /**
   * Runs the action selected in a notification.
   *
   * @param action The selected action.
   */
  runUserAction(action: BackupUserAction): void;

  /**
   * Makes a verified protection backup the latest protection reference of the source URI.
   *
   * @param backupUri The backup location to reference from now on.
   * @returns The previously referenced location, or `undefined` if there was none. Throws if the update fails.
   */
  updateLatestProtection(backupUri: string): Promise<string | undefined>;

  /**
   * Hands backups replaced by a successor backup over to discard. Does not wait.
   *
   * @param backupUris The replaced backup locations.
   */
  discardReplaced(backupUris: readonly string[]): void;
}

/**
 * The state of an adopted backup.
 *
 * Kept as a state so that a discard-confirmed backup never becomes active again. Making a backup that should be
 * gone the tracked backup or a restore candidate again would bring back content the user discarded.
 */
type AdoptedBackupState = 'active' | 'discarded';

/** A hot exit backup returned to VS Code. */
export interface HotExitBackup {
  /** The backup directory URI. VS Code passes it back on resume. */
  readonly id: string;
  /** The delete handle VS Code calls when it decides the backup is no longer needed. */
  readonly delete: () => void;
}

/** How far protection backup verification and the recovery that uses it have progressed. */
export type ProtectionStatus =
  | 'preserving'
  | 'verified'
  | 'failed'
  | 'recoveryReconciling'
  | 'recoveryWritten';

/** The recovery check used to verify the result of the recovery write. Both values are LF. */
export interface RecoveryCheck {
  /** The full source text before the write. */
  readonly sourceBefore: string;
  /** The recovered full text written to the file. */
  readonly recoveredText: string;
}

/**
 * A record of the old full text and the progress of protection and recovery.
 *
 * The old full text and the merge base are fixed at the moment protection begins. Reading them again later would
 * run the backup or the recovery merge with values changed after the failed application.
 */
export interface ProtectionState {
  readonly staleText: string | undefined;
  readonly mergeBase: string | undefined;
  readonly reason: string;
  status: ProtectionStatus;
  /** The location of the protection backup whose read-back was verified. */
  backupUri: string | undefined;
  /** The recovery check, held only while recovery is reconciling or written. */
  recoveryCheck: RecoveryCheck | undefined;
  /** True while recovery is running. The record stays in use after the old document closes until display is confirmed. */
  recovering: boolean;
}

/** The result of catching up a new backup. */
type CatchUpResult =
  | { readonly ok: true; readonly last: BackupContent }
  | { readonly ok: false; readonly reason: string };

/** The state of rewrites to a tracked backup. */
interface RefreshSlot {
  running: boolean;
  /** The latest content to write next. Intermediate content is superseded by the last, so only one is kept. */
  pending: BackupContent | undefined;
}

/**
 * The backup coordinator for one document.
 *
 * Creating, rewriting, and deleting hot exit backups and verifying protection backups live in the same place. Both
 * read the same retained copy and merge base, and both must stop together when the document is disposed.
 */
export class BackupCoordinator implements HistoryProtectionSink {
  // The tracked backup: the last one whose creation succeeded through catching up, and whose deletion was not requested.
  private tracked: string | undefined;

  // The backup locations this document adopted and their states. Kept even after the document is disposed.
  // Completing a recovery discards the old document's backups, so dropping them on close would leave no way
  // to know what to delete.
  private readonly adoptedBackups = new Map<string, AdoptedBackupState>();

  // The given backup that was loaded by the restore and made the tracked backup. It is the only backup
  // discarded when a successor backup completes.
  private restoredBackupUri: string | undefined;

  private readonly refreshSlots = new Map<string, RefreshSlot>();

  private protectionState: ProtectionState | undefined;

  private readonly protectionWaiters: (() => void)[] = [];

  // The tail of backup requests. Running requests concurrently could let an older request received first take the
  // tracked backup back afterwards.
  private backupTail: Promise<void> = Promise.resolve();

  private disposed = false;

  /**
   * @param host The VS Code-independent host.
   * @param store The store that writes, reads, and deletes backup generations.
   */
  constructor(
    private readonly host: BackupCoordinatorHost,
    private readonly store: BackupStore,
  ) {}

  /** The location of the tracked backup. */
  get trackedBackupUri(): string | undefined {
    return this.tracked;
  }

  /** The protection state. `undefined` when not under protection. */
  get protection(): ProtectionState | undefined {
    return this.protectionState;
  }

  /** A copy of the active adopted backup locations. Used only for inspection and never changes the state. */
  get adoptedBackupUris(): readonly string[] {
    return [...this.adoptedBackups]
      .filter(([, state]) => state === 'active')
      .map(([backupUri]) => backupUri);
  }

  /**
   * Registers a backup selected by the restore as a backup this document adopted.
   *
   * @param backupUri The backup location to adopt.
   */
  adoptBackup(backupUri: string): void {
    // Registered and discard-confirmed locations are left unchanged. Making a discard-confirmed one active again
    // would track a backup that should be gone.
    if (this.adoptedBackups.has(backupUri)) {
      return;
    }
    this.adoptedBackups.set(backupUri, 'active');
  }

  /**
   * Starts tracking the loaded hot exit backup.
   *
   * Called only by the restore connection. The restored content is still as written in the backup, so the backup
   * is rewritten with the current retained copy and merge base as soon as tracking starts.
   *
   * @param backupUri The location of the given backup to track.
   */
  trackRestoredBackup(backupUri: string): void {
    if (this.disposed || this.adoptedBackups.get(backupUri) === 'discarded') {
      return;
    }
    this.adoptBackup(backupUri);
    this.tracked = backupUri;
    this.restoredBackupUri = backupUri;
    this.refresh();
  }

  /**
   * Marks the adopted backups that are active at the discard trigger as discard-confirmed and stops tracking them.
   *
   * The targets are fixed within the synchronous part of the call. Including backups created while waiting would
   * also delete backups holding edits made after the trigger.
   *
   * @returns The backup locations marked as discard-confirmed.
   */
  takeDiscardTargets(): readonly string[] {
    const targets: string[] = [];

    for (const [backupUri, state] of this.adoptedBackups) {
      if (state !== 'active') {
        continue;
      }
      this.adoptedBackups.set(backupUri, 'discarded');
      targets.push(backupUri);

      if (this.tracked === backupUri) {
        this.tracked = undefined;
      }
      if (this.restoredBackupUri === backupUri) {
        this.restoredBackupUri = undefined;
      }
      // Also drop a pending rewrite. Writing to a discard-confirmed backup would bring back content that should be
      // gone as a new generation.
      const slot = this.refreshSlots.get(backupUri);
      if (slot !== undefined) {
        slot.pending = undefined;
        this.refreshSlots.delete(backupUri);
      }
    }

    return targets;
  }

  /**
   * Makes backups whose discard record could not be persisted active again.
   *
   * Tracking does not resume. The content remains in the backup, and targeting it again at a later discard
   * trigger is enough.
   *
   * @param backupUris The backup locations whose discard could not be recorded.
   */
  returnDiscardTargets(backupUris: readonly string[]): void {
    for (const backupUri of backupUris) {
      if (this.adoptedBackups.get(backupUri) === 'discarded') {
        this.adoptedBackups.set(backupUri, 'active');
      }
    }
  }

  /**
   * Creates a new hot exit backup and returns it once the updates made during creation are reflected.
   *
   * Nothing is awaited between the moment the written content matches the current values and returning the
   * identifier. Accepting an update in between would let VS Code record a backup that lacks the latest edit as a
   * success.
   *
   * @param parentUri The parent URI under which the backup directory is created.
   * @param isCancelled A function that checks for cancellation.
   * @returns The backup identifier and delete handle. Rejects on failure, cancellation, or document disposal.
   */
  backup(parentUri: string, isCancelled: () => boolean): Promise<HotExitBackup> {
    const result = this.backupTail.then(() => this.createBackup(parentUri, isCancelled));
    this.backupTail = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Handles one backup request.
   *
   * @param parentUri The parent URI under which the backup directory is created.
   * @param isCancelled A function that checks for cancellation.
   */
  private async createBackup(parentUri: string, isCancelled: () => boolean): Promise<HotExitBackup> {
    const first = this.assembleForCreation();
    if (first === undefined) {
      throw new Error('There is no content to back up');
    }
    if (isCancelled() || this.disposed) {
      throw new Error('Backup creation was cancelled before it started');
    }

    const backupUri = await this.store.create(parentUri, 'hotExit');
    try {
      let last = await this.store.writeGeneration(backupUri, first);
      for (;;) {
        this.throwIfAbandoned(isCancelled);
        const caughtUp = await this.catchUp(backupUri, last);
        if (!caughtUp.ok) {
          throw new Error(caughtUp.reason);
        }
        last = caughtUp.last;

        // From here until the switch, proceed synchronously.
        const current = this.assembleForCreation();
        if (current === undefined || !isSameBackupContent(current, last)) {
          continue;
        }
        this.throwIfAbandoned(isCancelled);
        const previous = this.tracked;
        this.tracked = backupUri;
        this.adoptBackup(backupUri);
        // When switching away from the tracked given backup, hand the previous backup over to discard. VS Code
        // does not delete the backup it passed on open, and its content lives on in the successor backup, so
        // unless it is deleted here a backup reachable from nowhere remains.
        if (previous !== undefined && previous === this.restoredBackupUri) {
          this.restoredBackupUri = undefined;
          this.host.discardReplaced([previous]);
        }
        return { id: backupUri, delete: () => this.deleteBackup(backupUri) };
      }
    } catch (error) {
      // The tracked backup was not switched, so only the partially created new backup needs deleting.
      this.store.delete(backupUri).catch((deleteError: unknown) => {
        this.host.reportInternalError(`Could not delete a partially created backup ${backupUri}: ${String(deleteError)}`);
      });
      throw error;
    }
  }

  /**
   * Deletes a backup on VS Code's delete instruction.
   *
   * Untracking happens synchronously. Waiting for the deletion to finish would let updates in the meantime be
   * written to the backup that is about to be deleted.
   *
   * @param backupUri The location of the backup to delete.
   */
  deleteBackup(backupUri: string): void {
    // An instruction for the old backup that arrives after the switch must not untrack the new backup.
    if (this.tracked === backupUri) {
      this.tracked = undefined;
    }
    this.refreshSlots.delete(backupUri);
    // A discard-confirmed backup is deleted by the side that holds the discard record. Deleting it here as well
    // would make the deletion of a vanished location fail and leave only a log entry no one can act on.
    if (this.adoptedBackups.get(backupUri) === 'discarded') {
      return;
    }
    this.store.delete(backupUri).catch((error: unknown) => {
      this.host.reportInternalError(`Could not delete backup ${backupUri}: ${String(error)}`);
    });
  }

  /**
   * Reflects an update of the retained copy or the merge base in the tracked backup.
   *
   * VS Code takes a backup again only after a change event, and edit events fire only once per edit unit. Without
   * rewriting, everything after the middle of the same edit unit would be lost on hot exit.
   */
  refresh(): void {
    const backupUri = this.tracked;
    if (this.disposed || backupUri === undefined) {
      return;
    }
    // No content happens right after a Revert, for example. Emptying the existing backup would lose the content to
    // restore.
    const content = this.assembleCurrent();
    if (content === undefined) {
      return;
    }

    let slot = this.refreshSlots.get(backupUri);
    if (slot === undefined) {
      slot = { running: false, pending: undefined };
      this.refreshSlots.set(backupUri, slot);
    }
    slot.pending = content;
    if (!slot.running) {
      void this.drainRefresh(backupUri, slot);
    }
  }

  /**
   * Writes the old full text to an independent protection backup and resolves after verifying the read-back matches.
   *
   * On failure it neither resolves nor rejects. Returning the failure response would allow leaving protection, and
   * editing could proceed without the content being preserved. Only when the document is closed does it resolve,
   * because no one remains to be kept waiting.
   *
   * @param report The old full text, version, and cause.
   * @returns A Promise that resolves on verification or document disposal.
   */
  protect(report: HistoryProtectionReport): Promise<void> {
    const waiting = new Promise<void>((resolve) => {
      this.protectionWaiters.push(resolve);
    });
    if (this.disposed) {
      this.releaseProtectionWaiters();
      return waiting;
    }
    if (this.protectionState !== undefined) {
      this.host.reportInternalError(`Ignored a second protection request: ${report.reason}`);
      return waiting;
    }

    const input = this.host.readContentInput();
    this.protectionState = {
      staleText: report.staleText,
      mergeBase: input.mergeBase,
      reason: report.reason,
      status: 'preserving',
      backupUri: undefined,
      recoveryCheck: undefined,
      recovering: false,
    };
    void this.preserve(this.protectionState, true);
    return waiting;
  }

  /**
   * Rewrites a failed protection backup to a new location with the same old full text and merge base.
   *
   * On success it also releases the initial protection wait. It returns this attempt's result without waiting for
   * that initial wait to resolve.
   *
   * @returns Whether this rewrite was verified.
   */
  async retryProtection(): Promise<boolean> {
    const state = this.protectionState;
    if (state === undefined || state.status !== 'failed') {
      return false;
    }
    return this.preserve(state, false);
  }

  /**
   * Stops tracking and releases pending protection waits when the document is disposed.
   *
   * Backups are not deleted. Even after the document closes, they remain as the content for a hot exit resume or
   * for when protection could not be left.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.refreshSlots.clear();

    const state = this.protectionState;
    if (state !== undefined && !state.recovering) {
      this.announceClosedWhileProtected(state);
    }
    this.releaseProtectionWaiters();
  }

  /**
   * Rewrites a backup under creation until it catches up with the current values.
   *
   * Ordinary rewrites keep flowing to the old tracked backup, so the new backup is caught up here regardless of
   * whether a tracked backup exists.
   *
   * @param backupUri The location of the backup under creation.
   * @param last The content last written there.
   */
  private async catchUp(backupUri: string, last: BackupContent): Promise<CatchUpResult> {
    let written = last;
    for (;;) {
      const current = this.assembleForCreation();
      if (current === undefined) {
        return { ok: false, reason: 'The content disappeared while creating the backup' };
      }
      if (isSameBackupContent(current, written)) {
        return { ok: true, last: written };
      }
      try {
        written = await this.store.writeGeneration(backupUri, current);
      } catch (error) {
        return { ok: false, reason: `Could not bring the new backup up to date: ${String(error)}` };
      }
    }
  }

  /**
   * Keeps writing the latest content to the tracked backup, with only one write at a time.
   *
   * @param backupUri The write destination.
   * @param slot The state of that destination.
   */
  private async drainRefresh(backupUri: string, slot: RefreshSlot): Promise<void> {
    slot.running = true;
    try {
      while (slot.pending !== undefined && !this.disposed) {
        const content = slot.pending;
        slot.pending = undefined;
        try {
          await this.store.writeGeneration(backupUri, content);
        } catch (error) {
          // A write to a backup whose deletion was requested is expected to be rejected, so the user is not told.
          if (this.tracked !== backupUri) {
            continue;
          }
          void this.host.reportUserAction(
            'backup.refreshFailed.message',
            [],
            `Could not rewrite backup ${backupUri}: ${String(error)}`,
          );
        }
      }
    } finally {
      slot.running = false;
    }
  }

  /**
   * Writes and reads back the protection backup, and advances the record with the result.
   *
   * @param state The protection state.
   * @param announce Whether to report the result to the user. On a retry from recovery, the recovery side reports
   *   everything together.
   * @returns Whether it was verified.
   */
  private async preserve(state: ProtectionState, announce: boolean): Promise<boolean> {
    state.status = 'preserving';
    const content = assembleBackupContent(
      { documentUri: this.host.documentUri, retainedCopy: undefined, mergeBase: state.mergeBase },
      { staleText: state.staleText },
    );

    let failure: string | undefined;
    if (content === undefined) {
      failure = 'The old full text or the merge base is missing';
    } else {
      try {
        const backupUri = await this.store.create(this.host.protectionParentUri, 'protection');
        await this.store.writeGeneration(backupUri, content);
        const readBack = await this.store.readLatest(backupUri, this.host.documentUri);
        if (readBack !== undefined && isSameBackupContent(readBack, content)) {
          // Verification includes updating the reference. If the reference stayed stale, the next open could not
          // select this protection backup, and the content would be kept yet impossible to restore.
          const previous = await this.host.updateLatestProtection(backupUri);
          state.backupUri = backupUri;
          this.adoptBackup(backupUri);
          if (previous !== undefined && previous !== backupUri) {
            // The successor backup is complete, so hand the previous backup, no longer referenced, over to discard.
            this.host.discardReplaced([previous]);
          }
        } else {
          failure = `The read-back of the protection backup does not match what was written: ${backupUri}`;
        }
      } catch (error) {
        failure = `Could not write the protection backup: ${String(error)}`;
      }
    }

    if (failure !== undefined) {
      state.status = 'failed';
      if (announce) {
        this.announceAction('protection.preservationFailed.message', 'recovery.saveAs', failure);
      } else {
        this.host.reportInternalError(failure);
      }
      return false;
    }

    state.status = 'verified';
    this.releaseProtectionWaiters();
    if (announce) {
      this.runSelectedAction(this.host.reportUserInformation('protection.preserved.message', ['recovery.recover']));
    }
    return true;
  }

  /**
   * Reports a failure with an action and runs the action if selected. Does not wait for the selection.
   *
   * @param key The notification body.
   * @param action The action to offer.
   * @param cause The cause to record in the diagnostic log.
   */
  private announceAction(key: MessageKey, action: BackupUserAction, cause: string | undefined): void {
    this.runSelectedAction(this.host.reportUserAction(key, [action], cause));
  }

  /**
   * Runs the action selected in a notification.
   *
   * @param selection A Promise that waits for the notification selection.
   */
  private runSelectedAction(selection: Promise<BackupUserAction | undefined>): void {
    void selection.then((selected) => {
      // If the document was closed before the notification was dismissed, there is nothing to act on.
      if (selected !== undefined && !this.disposed) {
        this.host.runUserAction(selected);
      }
    });
  }

  /**
   * Reports that the document was closed during protection, and whether a backup remains.
   *
   * @param state The protection state.
   */
  private announceClosedWhileProtected(state: ProtectionState): void {
    if (state.backupUri !== undefined) {
      // A discard-confirmed protection backup no longer remains. Announcing that it remains would read as if
      // discarded content were still there.
      if (this.adoptedBackups.get(state.backupUri) === 'discarded') {
        this.host.reportInternalError(
          `Closed a document under protection whose protection backup was already discarded: ${state.backupUri}`,
        );
        return;
      }
      void this.host.reportUserAction(
        'protection.closedWithBackup.message',
        [],
        `Closed a document under protection. The protection backup remains at ${state.backupUri}`,
        { location: state.backupUri },
      );
      return;
    }
    void this.host.reportUserAction(
      'protection.closedWithoutBackup.message',
      [],
      `Closed a document under protection without a verified protection backup: ${this.host.documentUri}`,
    );
  }

  private releaseProtectionWaiters(): void {
    for (const resolve of this.protectionWaiters.splice(0)) {
      resolve();
    }
  }

  private assembleCurrent(): BackupContent | undefined {
    return assembleBackupContent(this.host.readContentInput());
  }

  /**
   * Assembles the current content to write to a backup under creation.
   *
   * If no retained copy has been received yet, the view still holds the sync base content, so the merge base is
   * used as the full text. VS Code's backup request can arrive before the first unsaved content, and after a failure
   * it does not ask again until the next change event. Edit events fire once per edit unit, so failing here would
   * leave no backup for the rest of that unit. Content that arrives later is reflected by rewrites of the tracked
   * backup.
   */
  private assembleForCreation(): BackupContent | undefined {
    const input = this.host.readContentInput();
    return assembleBackupContent(
      input.retainedCopy === undefined ? { ...input, retainedCopy: input.mergeBase } : input,
    );
  }

  /**
   * Aborts creation on cancellation or document disposal.
   *
   * @param isCancelled A function that checks for cancellation.
   */
  private throwIfAbandoned(isCancelled: () => boolean): void {
    if (isCancelled()) {
      throw new Error('Backup creation was cancelled');
    }
    if (this.disposed) {
      throw new Error('The document was disposed while creating the backup');
    }
  }
}
