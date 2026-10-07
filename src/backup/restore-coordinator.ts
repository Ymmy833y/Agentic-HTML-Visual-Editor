import {
  HOST_TO_VIEW_MESSAGE_TYPE,
  RESTORE_ACTION,
  RESTORE_FAILURE_CAUSE,
  decideRestoreMount,
} from '../../common/index';
import type {
  HostToViewMessage,
  InitializeMessage,
  LineEnding,
  RestoreAction,
  RestoreFailureCause,
  RestoreProgress,
} from '../../common/index';
import type { SourceResolution } from '../save/save-coordinator';
import { mergeSaveCandidate } from '../save/save-merge';
import type { BackupPurpose } from './backup-store';
import type { RestoreCandidate } from './restore-candidate';

// setTimeout and clearTimeout are globals in both extension hosts, but this layer has no DOM types.
declare const setTimeout: (handler: () => void, timeoutMs: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;

// The upper limit on waiting for display confirmation. Keeps the restore from staying unsettled because of a
// view that does not respond.
const DISPLAY_CONFIRM_TIMEOUT_MS = 10000;

/** A selected candidate. */
type SelectedCandidate = Extract<RestoreCandidate, { readonly kind: 'selected' }>;

/** Why the wait for display confirmation ended. */
type DisplayOutcome =
  | 'shown'
  /** The view responded that it could not display, or did not respond in time. */
  | 'displayFailed'
  /** The view was reloaded during display confirmation. */
  | 'restarted'
  /** The document was disposed, so there is no one left to wait for. */
  | 'abandoned';

/**
 * The basis of this restore. Kept from selection until settlement, and on failure until retry or discard
 * is chosen.
 */
export interface RestoreBasis {
  readonly backupUri: string;
  readonly purpose: BackupPurpose;
  /** The merge base attached to the backup (LF). */
  readonly mergeBase: string;
  /** The current clean source full text used for the merge (LF). */
  readonly sourceText: string;
  /** The restored full text after the merge (LF). */
  readonly restoredText: string;
  readonly lineEnding: LineEnding;
}

/**
 * What became of the backup whose id made the document dirty, told to the user when the mark could not be cleared.
 *
 * With no candidate nothing was discarded, so the notification must not say that a backup was.
 */
export type KeptDirtyStateReason = 'backupDiscarded' | 'noCandidate';

/** The VS Code-independent port the restore coordinator uses. */
export interface RestoreHost {
  /**
   * Reads the restore candidate.
   *
   * @param backupId The backup id VS Code passed, or `undefined` if none.
   */
  loadCandidate(backupId: string | undefined): Promise<RestoreCandidate>;

  /**
   * Resolves the current source without writing, as one unit of the document operation queue.
   *
   * @returns The resolution, or `undefined` if the queue was closed and it did not run.
   */
  resolveSource(): Promise<SourceResolution | undefined>;

  /** The latest full text of the view held by the host, or `undefined` if none has been received yet. */
  readRetainedCopy(): string | undefined;

  /**
   * Creates the existing initialization message that does not involve restore. The sync base initialization and
   * the initial reconcile also happen here.
   */
  createNormalInitialization(): Promise<InitializeMessage>;

  /**
   * Builds an initialization message carrying the given full text, without changing the sync base.
   *
   * @param text The full text to mount (LF).
   */
  buildRestoreInitialization(text: string): Promise<InitializeMessage>;

  /**
   * Sends to the view.
   *
   * @param message The message to send.
   */
  postToView(message: HostToViewMessage): Promise<void>;

  /**
   * Connects the retained copy, the sync base, and the restore entry.
   *
   * @param basis The basis of this restore.
   * @returns Whether the connection succeeded.
   */
  connect(basis: RestoreBasis): boolean;

  /**
   * Starts tracking the loaded hot exit backup.
   *
   * @param backupUri The backup location to track.
   */
  startTracking(backupUri: string): void;

  /**
   * Discards the adopted backups.
   *
   * @returns Whether the discard records could be persisted.
   */
  discardAdoptedBackups(): Promise<boolean>;

  /**
   * Releases the latest protection reference without checking what it references.
   *
   * @returns Whether it could be released.
   */
  releaseLatestProtection(): Promise<boolean>;

  /**
   * Clears the dirty state that came from the backup, with a save that does not write to the file.
   *
   * @returns Whether the dirty state could be cleared.
   */
  clearDirtyState(): Promise<boolean>;

  /**
   * Reports whether a text editor of this file is open in any group.
   *
   * A save named by URI goes to the text editor whenever one is open, so the save that clears the dirty state would
   * not reach the view, and a text editor with unsaved edits would be written to the file.
   */
  isTextEditorOpen(): boolean;

  /** Makes the view reload. */
  reloadView(): void;

  /**
   * Notifies with the backup location and the retry and discard actions. Does not wait.
   *
   * @param location The remaining backup location, or `undefined` if unknown.
   * @param cause The cause to leave in the diagnostic log.
   * @returns The action the user chose, or `undefined` if none was chosen.
   */
  notifyFailure(location: string | undefined, cause: string): Promise<RestoreAction | undefined>;

  /**
   * Notifies that the dirty mark that came from the backup could not be cleared.
   *
   * @param reason Whether the backup was discarded or there was none, so that the notification does not claim a
   *   discard that did not happen.
   * @param cause The cause to leave in the diagnostic log.
   */
  notifyDirtyStateKept(reason: KeptDirtyStateReason, cause: string): void;

  /** Leaves a fact the user cannot act on in the diagnostic log. */
  reportInternalError(detail: string): void;
}

/** What is kept while failed. Kept until retry or discard is chosen. */
interface RestoreFailureState {
  readonly cause: RestoreFailureCause;
  readonly location: string | undefined;
  /** Whether to also release the latest protection reference, without checking it, when discard is chosen. */
  readonly releaseLatestProtection: boolean;
}

/** A wait for display confirmation. */
interface DisplayWait {
  readonly initializationId: string;
  readonly settle: (outcome: DisplayOutcome) => void;
}

/**
 * The restore coordinator of a single document.
 *
 * Holds everything from loading the candidate through merge, display, connection, and discard in one place.
 * The progress and the basis live in the same holder because view recreation, save, Revert, and backup
 * requests all decide whether they may proceed by looking at this progress alone.
 */
export class RestoreCoordinator {
  private restoreProgress: RestoreProgress = 'notStarted';

  private basis: RestoreBasis | undefined;

  // The running restore. Kept so that callers can wait for it to settle and then decide again.
  private running: Promise<void> | undefined;

  private displayWait: DisplayWait | undefined;

  private failure: RestoreFailureState | undefined;

  // The sequence number for initialization ids attached to display confirmation. Only the newest display of each
  // document is accepted, so uniqueness within the document is enough.
  private nextInitializationId = 1;

  private disposed = false;

  /**
   * @param host The VS Code-independent port.
   * @param backupId The backup id VS Code passed in the open context, or `undefined` if none.
   */
  constructor(
    private readonly host: RestoreHost,
    private readonly backupId: string | undefined,
  ) {}

  /** The restore progress of the document. */
  get progress(): RestoreProgress {
    return this.restoreProgress;
  }

  /**
   * On view ready, decides whether to redisplay, start the restore, wait for settlement, or show the failure again.
   *
   * @returns The initialization message to send, or `undefined` if it sent one itself or sends nothing.
   */
  async initializeView(): Promise<InitializeMessage | undefined> {
    for (;;) {
      const running = this.running;
      const decision = decideRestoreMount({
        kind: 'viewReady',
        retainedCopy: this.host.readRetainedCopy(),
        // Treated as prepared while running. Reloading the candidate while running would merge the same backup twice.
        progress: running === undefined ? this.restoreProgress : 'prepared',
      });

      switch (decision.kind) {
        case 'redisplay':
        case 'initializeNormally':
          return this.host.createNormalInitialization();
        case 'startRestore':
          return this.runRestore();
        case 'awaitSettlement':
          if (running === undefined) {
            this.host.reportInternalError('Sent no initialization because the restore is prepared but nothing is running');
            return undefined;
          }
          await running;
          continue;
        case 'showFailure':
          // Notifications are not repeated. Notifying on every recreation would pile up notifications for as long
          // as the failure lasts.
          await this.sendFailure();
          return undefined;
        default:
          this.host.reportInternalError(`Received a decision that is not for view ready: ${decision.kind}`);
          return undefined;
      }
    }
  }

  /**
   * Loads the candidate, merges it, and proceeds to display or discard depending on whether there are differences.
   *
   * Uses the backup id received at construction.
   *
   * @returns A normal initialization message when there is no candidate or no difference; otherwise `undefined`.
   */
  async runRestore(): Promise<InitializeMessage | undefined> {
    let settle = (): void => undefined;
    this.running = new Promise<void>((resolve) => {
      settle = resolve;
    });
    try {
      return await this.restore();
    } finally {
      // Clear the marker before releasing the wait so that waiters decide again with the settled progress.
      this.running = undefined;
      settle();
    }
  }

  /**
   * Merges the backup of the selected candidate with the merge base and the current source.
   *
   * @param candidate The selected candidate.
   * @returns The restore basis, or `sourceUnavailable` if the source could not be resolved.
   */
  async mergeWithSource(candidate: SelectedCandidate): Promise<RestoreBasis | 'sourceUnavailable'> {
    const resolution = await this.host.resolveSource();
    if (resolution === undefined || resolution.kind !== 'resolved') {
      return 'sourceUnavailable';
    }

    // The backup takes the view side. In a conflict region the backup side follows the source side, and neither
    // the merge base nor markers are output.
    const merged = mergeSaveCandidate(candidate.content.mergeBase, resolution.text, candidate.content.fullText);
    return {
      backupUri: candidate.backupUri,
      purpose: candidate.purpose,
      mergeBase: candidate.content.mergeBase,
      sourceText: resolution.text,
      restoredText: merged.text,
      lineEnding: resolution.lineEnding,
    };
  }

  /**
   * Displays the restored full text with input stopped, confirms the display, and then connects it to the dirty
   * state and the history.
   *
   * @param basis The basis of this restore.
   */
  async displayRestored(basis: RestoreBasis): Promise<void> {
    this.basis = basis;
    const initializationId = `restore-${this.nextInitializationId}`;
    this.nextInitializationId += 1;

    let base: InitializeMessage;
    try {
      base = await this.host.buildRestoreInitialization(basis.restoredText);
    } catch (error) {
      await this.fail(
        RESTORE_FAILURE_CAUSE.displayFailed,
        `Could not build the restoring display initialization: ${String(error)}`,
      );
      return;
    }

    // Register the wait before sending. In the reverse order, a display result that arrives first would have
    // no one to receive it.
    const confirmed = new Promise<DisplayOutcome>((resolve) => {
      this.displayWait = { initializationId, settle: resolve };
    });
    await this.host.postToView({ ...base, initializationId, restoring: true });

    const expiry = startExpiry(DISPLAY_CONFIRM_TIMEOUT_MS);
    let outcome: DisplayOutcome;
    try {
      outcome = await Promise.race([confirmed, expiry.expired]);
    } finally {
      // The timer remains even if display confirmation settles first. Avoids leaving one pending until the
      // deadline on every restore.
      expiry.cancel();
    }
    this.displayWait = undefined;

    if (outcome === 'abandoned') {
      // There is simply no one left to wait for, so the backups and records stay unchanged and nothing is notified.
      return;
    }
    if (outcome !== 'shown') {
      await this.fail(
        RESTORE_FAILURE_CAUSE.displayFailed,
        `Could not display the restored full text ${basis.backupUri}: ${outcome}`,
      );
      return;
    }

    if (!this.host.connect(basis)) {
      await this.fail(
        RESTORE_FAILURE_CAUSE.connectionFailed,
        `Could not connect the restored full text as unsaved ${basis.backupUri}`,
      );
      return;
    }

    // Start tracking before letting input resume. In the reverse order, an edit right after resuming would not be
    // written to a backup because there is no tracked backup yet.
    if (basis.purpose === 'hotExit') {
      this.host.startTracking(basis.backupUri);
    }
    this.restoreProgress = 'restored';
    await this.host.postToView({ type: HOST_TO_VIEW_MESSAGE_TYPE.restoreCompleted });
  }

  /**
   * Passes an initialization result to the wait for display confirmation.
   *
   * @param initializationId The initialization id the view returned.
   * @param success Whether the mount reached an editable state.
   * @returns Whether it matched the current wait.
   */
  receiveDocumentInitialized(initializationId: string, success: boolean): boolean {
    const wait = this.displayWait;
    if (wait === undefined || wait.initializationId !== initializationId) {
      // Results that arrive after the deadline or belong to an old display are dropped. Accepting them would
      // connect a restore that has already settled.
      return false;
    }
    this.displayWait = undefined;
    wait.settle(success ? 'shown' : 'displayFailed');
    return true;
  }

  /** Settles a view reload during display confirmation as a display failure. */
  notifyViewRestarted(): void {
    const wait = this.displayWait;
    if (wait === undefined) {
      return;
    }
    this.displayWait = undefined;
    wait.settle('restarted');
  }

  /**
   * Receives the action the user chose while the restore has failed.
   *
   * @param action Retry or discard.
   */
  async selectAction(action: RestoreAction): Promise<void> {
    if (this.restoreProgress !== 'failed' || this.running !== undefined) {
      this.host.reportInternalError(`Received ${action} while the restore cannot accept a choice: ${this.restoreProgress}`);
      return;
    }

    if (action === RESTORE_ACTION.retry) {
      // Reacquire the candidate and the current source. Reloading the view starts loading the candidate from its
      // view ready.
      this.restoreProgress = 'notStarted';
      this.basis = undefined;
      this.failure = undefined;
      this.host.reloadView();
      return;
    }

    const failure = this.failure;
    if (failure?.releaseLatestProtection === true && !(await this.host.releaseLatestProtection())) {
      // Even if only the reference remains, discarding what it points to leaves no candidate on the next startup.
      // The discard continues.
      this.host.reportInternalError('Could not release the latest protection reference when discard was chosen');
    }

    if (!(await this.host.discardAdoptedBackups())) {
      // Backups whose discard could not be recorded remain. Stay failed and show retry and discard again.
      this.failure = {
        cause: RESTORE_FAILURE_CAUSE.discardFailed,
        location: failure?.location,
        releaseLatestProtection: failure?.releaseLatestProtection ?? false,
      };
      await this.sendFailure();
      return;
    }

    this.restoreProgress = 'normal';
    this.basis = undefined;
    this.failure = undefined;
    await this.clearDirtyStateIfAdopted('backupDiscarded');
    this.host.reloadView();
  }

  /**
   * Waits for the restore to settle and returns whether a save may proceed.
   *
   * @returns `true` if restored or started normally.
   */
  async waitForSaveGate(): Promise<boolean> {
    await this.running;
    return this.isComplete();
  }

  /**
   * Returns, without waiting, whether the restore has settled into an editable state.
   *
   * @returns `true` if restored or started normally.
   */
  isComplete(): boolean {
    return this.restoreProgress === 'restored' || this.restoreProgress === 'normal';
  }

  /** Releases the wait for display confirmation on document disposal. Leaves the backups and records unchanged. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const wait = this.displayWait;
    if (wait !== undefined) {
      this.displayWait = undefined;
      wait.settle('abandoned');
    }
  }

  /**
   * Proceeds from loading the candidate to settlement.
   *
   * @returns A normal initialization message when there is no candidate or no difference; otherwise `undefined`.
   */
  private async restore(): Promise<InitializeMessage | undefined> {
    const candidate = await this.host.loadCandidate(this.backupId);

    if (candidate.kind === 'none') {
      this.restoreProgress = 'normal';
      // VS Code opens a document it passed a backup id for as dirty. With nothing to restore, the view shows the
      // source as is, so the mark would claim edits that do not exist.
      await this.clearDirtyStateIfAdopted('noCandidate');
      return this.host.createNormalInitialization();
    }
    if (candidate.kind === 'failed') {
      await this.fail(RESTORE_FAILURE_CAUSE.backupUnreadable, candidate.cause, {
        location: candidate.backupUri,
        // The only failure with an unknown backup location is when the latest protection reference itself could not
        // be read. If discard is chosen, the unreadable reference must also be released; otherwise neither retry
        // nor discard escapes the same failure.
        releaseLatestProtection: candidate.backupUri === undefined,
      });
      return undefined;
    }

    const basis = await this.mergeWithSource(candidate);
    if (basis === 'sourceUnavailable') {
      await this.fail(
        RESTORE_FAILURE_CAUSE.sourceUnavailable,
        `Could not resolve the current source ${candidate.backupUri}`,
        { location: candidate.backupUri, releaseLatestProtection: false },
      );
      return undefined;
    }

    this.basis = basis;
    this.restoreProgress = 'prepared';

    const decision = decideRestoreMount({
      kind: 'merged',
      sourceText: basis.sourceText,
      restoredText: basis.restoredText,
    });
    if (decision.kind === 'mountRestored') {
      await this.displayRestored(basis);
      return undefined;
    }

    // With no difference, discard silently and start normally with the source.
    if (!(await this.host.discardAdoptedBackups())) {
      await this.fail(
        RESTORE_FAILURE_CAUSE.discardFailed,
        `Could not record the discard of a backup with no difference ${basis.backupUri}`,
      );
      return undefined;
    }
    this.restoreProgress = 'normal';
    this.basis = undefined;
    await this.clearDirtyStateIfAdopted('backupDiscarded');
    return this.host.createNormalInitialization();
  }

  /**
   * Settles as a failure, notifies the backup location with retry and discard once, and sends the failure to the view.
   *
   * @param cause The failure cause to tell the view.
   * @param detail The cause to leave in the diagnostic log.
   * @param candidate For a failure before the basis is obtained, the backup location and whether to release the
   * latest protection reference.
   */
  private async fail(
    cause: RestoreFailureCause,
    detail: string,
    candidate?: { readonly location: string | undefined; readonly releaseLatestProtection: boolean },
  ): Promise<void> {
    this.restoreProgress = 'failed';
    // For a failure after the basis is obtained, the backup location comes from the basis. Failures in loading the
    // candidate and resolving the source have no basis yet.
    const location = this.basis?.backupUri ?? candidate?.location;
    this.failure = {
      cause,
      location,
      releaseLatestProtection: candidate?.releaseLatestProtection ?? false,
    };

    // The notification is not awaited. It does not resolve until the user closes it, so awaiting it would keep the
    // restore from settling.
    void this.host.notifyFailure(location, detail).then((selected) => {
      if (selected !== undefined) {
        void this.selectAction(selected);
      }
    });
    await this.sendFailure();
  }

  /** Sends the held failure to the view. Also used to show the failure again. */
  private async sendFailure(): Promise<void> {
    const failure = this.failure;
    if (failure === undefined) {
      this.host.reportInternalError('Asked to show the failure without holding its contents');
      return;
    }
    await this.host.postToView({ type: HOST_TO_VIEW_MESSAGE_TYPE.restoreFailed, cause: failure.cause });
  }

  /**
   * Clears the dirty state that came from the backup, only for a document that received a backup id.
   *
   * The dirty mark of a document that received no id did not come from a backup, so clearing it would make the
   * user's edits look saved.
   *
   * @param reason What became of the backup, told to the user when the mark stays.
   */
  private async clearDirtyStateIfAdopted(reason: KeptDirtyStateReason): Promise<void> {
    if (this.backupId === undefined) {
      return;
    }
    if (this.host.isTextEditorOpen()) {
      // The save that clears the mark is named by URI and would go to the text editor instead of the view. It would
      // leave the mark and, with unsaved edits in the text editor, write them to the file without the user asking.
      this.host.notifyDirtyStateKept(
        reason,
        'The text editor of this file is open, so the save that clears the dirty state from the backup was not run',
      );
      return;
    }
    if (!(await this.host.clearDirtyState())) {
      // The discard is not undone. The dirty mark remains, but having started normally with the source is correct.
      this.host.notifyDirtyStateKept(
        reason,
        'The save to clear the dirty state that came from the backup did not succeed',
      );
    }
  }
}

/**
 * Starts a timer that settles as a display failure after the given time.
 *
 * @param ms The milliseconds to wait.
 * @returns A promise that resolves on expiry, and a way to cancel it.
 */
function startExpiry(ms: number): { readonly expired: Promise<DisplayOutcome>; readonly cancel: () => void } {
  let handle: unknown;
  const expired = new Promise<DisplayOutcome>((resolve) => {
    handle = setTimeout(() => resolve('displayFailed'), ms);
  });
  return { expired, cancel: () => clearTimeout(handle) };
}
