import { EDIT_UNIT_SIGNAL_KIND, HISTORY_DIRECTION } from '../../common/index';
import type {
  EditSnapshot,
  EditTransaction,
  EditUnitId,
  EditUnitSignal,
  HistoryDirection,
  MessageKey,
} from '../../common/index';
import { EDIT_UNIT_OUTCOME, EditUnitTracker } from './edit-unit-tracker';
import { HISTORY_EVENTS_ENABLED } from './history-availability';
import { DocumentHistoryState } from './history-state';
import type { HistoryPointId } from './history-state';

// The edit unit id of the restore entry. Ids issued by the view are a hexadecimal prefix plus a sequence
// number, so they never collide with this spelling.
const RESTORE_ENTRY_UNIT_ID = 'restore';

/** Operations that can be delegated to a standard command. */
export const STANDARD_COMMAND_KIND = {
  save: 'save',
  undo: 'undo',
  redo: 'redo',
} as const;

/** Kind of operation to delegate. */
export type StandardCommandKind =
  (typeof STANDARD_COMMAND_KIND)[keyof typeof STANDARD_COMMAND_KIND];

/** Before and after endpoints of a recorded history entry. */
export interface RecordedEndpoints {
  readonly before: EditSnapshot;
  readonly after: EditSnapshot;
}

/**
 * A registered history entry.
 *
 * Its before and after endpoints are kept equal to the actual state at registration. When registered ahead of
 * time only the start endpoint is known, so the endpoints of the same object are replaced once the settlement
 * arrives. VS Code holds a reference to this object, so recreating it would run undo with the stale endpoints.
 */
export interface HistoryEntryRecord {
  readonly unitId: EditUnitId;
  readonly pointId: HistoryPointId;
  readonly previousPointId: HistoryPointId;
  before: EditSnapshot;
  after: EditSnapshot;
}

/** Result of applying history to the view. */
export type HistoryApplyResult =
  | { readonly kind: 'applied'; readonly text: string }
  | {
    readonly kind: 'failed';
    /** Cause to write to the diagnostic log. */
    readonly reason: string;
    /** Actual old full text read just before applying, or `undefined` if it could not be read. */
    readonly liveText: string | undefined;
  };

/** The set handed to preservation as the trigger for entering protection. */
export interface HistoryProtectionReport {
  /** Actual old full text just before applying, or `undefined` if it could not be read. */
  readonly staleText: string | undefined;
  /** History point that full text belongs to. Used to judge whether preserved copies are the same. */
  readonly pointId: HistoryPointId;
  /** Cause of entering protection. */
  readonly reason: string;
}

/**
 * Entry point that preserves the old full text independently.
 *
 * Does not resolve until the backup has been read back and verified, or the document is closed. Resolving
 * without verifying the backup would return the failure response without preserving the content, opening a
 * path for the user to leave protection.
 */
export interface HistoryProtectionSink {
  /**
   * Preserves the old full text and resolves once read-back has been confirmed.
   *
   * @param report Old full text, version, and cause.
   */
  protect(report: HistoryProtectionReport): Promise<void>;
}

/**
 * Host interface used by the edit history coordinator, independent of `vscode`.
 *
 * It has no VS Code types, so the coordinator's behavior can be verified without launching VS Code.
 */
export interface HistoryHost {
  /**
   * Fires one custom document edit event.
   *
   * @param entry Registered history entry. The same reference comes back on undo/redo.
   */
  notifyDocumentChanged(entry: HistoryEntryRecord): void;

  /** Passes an edit notice to the save side so it updates the dirty state and the replacement-blocked flag. */
  recordEditNotice(): void;

  /**
   * Reads the last known full text held by the save side.
   *
   * On the path that enters protection without complete endpoints, there is no chance to query the view. The old
   * full text handed to preservation is taken from this value.
   *
   * @returns Last known full text, or `undefined` if none has been received yet.
   */
  lastKnownText(): string | undefined;

  /**
   * Finalizes the view's pending transaction immediately.
   *
   * @returns Whether everything targeted has arrived.
   */
  flushEditTransactions(): Promise<boolean>;

  /**
   * Decides a history candidate and applies it to the view.
   *
   * @param direction Direction of the history transition.
   * @param recorded Recorded before and after endpoints.
   * @returns Result of applying.
   */
  applyHistoryTransition(
    direction: HistoryDirection,
    recorded: RecordedEndpoints,
  ): Promise<HistoryApplyResult>;

  /** Back at the save boundary, so external change replacement is allowed again. */
  unblockReplacement(): void;

  /**
   * Reports that applying history returned to the save point.
   *
   * Once there is at least one history entry, VS Code decides the dirty mark solely by whether the current point
   * matches the save point, so returning to the save point lets the tab close without confirmation. Reported to
   * line up with the moment VS Code itself deletes the hot exit backup. Does not make the caller wait.
   */
  notifyReturnedToSavePoint(): void;

  /** Moved away from the save boundary, so external change replacement is stopped. */
  blockReplacement(): void;

  /** Locks the old DOM into protection and stops input in the view. */
  protectView(): void;

  /**
   * Notifies the user of a failure and writes the cause to the diagnostic log.
   *
   * @param key Message key of the notification.
   * @param cause One line to write to the diagnostic log.
   */
  reportUserError(key: MessageKey, cause?: string): Promise<void>;

  /**
   * Writes to the diagnostic log a fact the user cannot act on.
   *
   * @param detail One line for maintainers.
   */
  reportInternalError(detail: string): void;
}

/**
 * The edit history coordinator for one tab.
 *
 * Gathers edit unit tracking, history entry registration, undo/redo application, save boundary updates, and
 * protection on failure in one place. These all read and write the same three states, so splitting them across
 * separate owners would make it possible for only one of them to advance.
 */
export class EditHistoryCoordinator {
  private readonly tracker = new EditUnitTracker();

  private readonly historyState = new DocumentHistoryState();

  private readonly entries = new Map<EditUnitId, HistoryEntryRecord>();

  // Full text the view came to hold through a successful save, Revert, or history application. The pre-save check
  // compares against it. Some paths replace the view without going through an edit unit, so the full text of the
  // last settled edit unit alone would go stale.
  private confirmedText: string | undefined;

  // Whether the restore entry has been registered. Registering it each time the view is recreated would stack the
  // same restore in the history many times.
  private restoreEntryRegistered = false;

  // Promise used to wait for preservation to complete. Already resolved when not protected.
  private protectionCompleted: Promise<void> = Promise.resolve();

  private protectionSettled = false;

  private disposed = false;

  /**
   * @param host Interface bundling event firing, notifications, and requests to the save side.
   * @param protectionSink Entry point that preserves the old full text.
   */
  constructor(
    private readonly host: HistoryHost,
    // No default. Silently wiring a placeholder that never resolves would make protection inescapable in the
    // build where history is enabled.
    private readonly protectionSink: HistoryProtectionSink,
  ) {}

  /**
   * Receives one edit unit signal and advances history entry registration and settlement.
   *
   * @param signal A start, a pair, or an unchanged terminator.
   */
  receiveEditUnitSignal(signal: EditUnitSignal): void {
    if (this.disposed) {
      return;
    }

    const outcome = this.tracker.receiveSignal(signal);
    if (outcome === EDIT_UNIT_OUTCOME.discarded) {
      // A unit from an old view, or a terminator without a start. Log it without adding an entry.
      this.host.reportInternalError(
        `Discarded an edit unit signal with no matching unit: ${signal.kind}`,
      );
      return;
    }

    if (signal.kind === EDIT_UNIT_SIGNAL_KIND.start) {
      this.registerEntry(signal.unitId, signal.start);
      return;
    }
    if (signal.kind === EDIT_UNIT_SIGNAL_KIND.settled) {
      this.settleEntry(signal.transaction);
      return;
    }

    // Unchanged terminator. The entry registered ahead of time stays as reversible history to the same full text,
    // and no new entry is added.
    this.confirmedText = this.tracker.settledText();
  }

  /**
   * Receives an edit notice that carries no endpoint.
   *
   * The view sends the edit notice before the start signal, so a missing endpoint at notice time happens even for
   * normal edits. Entering protection here would stop saving on the very first edit, so a missing endpoint stays in
   * the tracking state while waiting for the start endpoint. When a save or history application is requested with
   * the endpoint still missing, that entry point enters protection.
   */
  receiveEditNotice(): void {
    if (this.disposed) {
      return;
    }
    this.tracker.receiveEditNotice();
    this.host.recordEditNotice();
  }

  /**
   * Decides from the settlement status of history endpoints whether saving may proceed.
   *
   * @param text Full text of the view output the save candidate was built from.
   * @returns `true` if writing may proceed.
   */
  confirmSaveEndpoint(text: string): boolean {
    if (this.historyState.isProtected()) {
      this.host.reportInternalError('Rejected a save because the document is protected');
      return false;
    }
    if (this.tracker.hasUnsettledUnit()) {
      this.host.reportInternalError('Rejected a save because an edit unit is not settled yet');
      return false;
    }
    if (this.confirmedText !== undefined && this.confirmedText !== text) {
      // The view has edits newer than the confirmed content. Those edits have no history entry, so writing them
      // would put content into the file that undo cannot revert.
      this.host.reportInternalError(
        'Rejected a save because the view output does not match the last confirmed content',
      );
      return false;
    }
    return true;
  }

  /**
   * Closes the pending transaction at every save entry point and checks the received output against the history
   * endpoints.
   *
   * @param text Full text of the view output the save candidate was built from.
   * @returns `true` only when both the flush and the check succeed.
   */
  async prepareSaveEndpoint(text: string): Promise<boolean> {
    if (this.disposed || this.historyState.isProtected()) {
      return this.confirmSaveEndpoint(text);
    }
    if (!(await this.host.flushEditTransactions())) {
      await this.host.reportUserError(
        'historyFlushFailed.message',
        'Could not flush the pending edit before saving',
      );
      return false;
    }
    if (this.tracker.hasUnsettledUnit()) {
      await this.host.reportUserError(
        'historyFlushFailed.message',
        'The flush before saving left an unsettled edit unit',
      );
      return false;
    }
    return this.confirmSaveEndpoint(text);
  }

  /**
   * Decides whether delegating to a standard command is allowed.
   *
   * @param kind Operation to delegate.
   * @returns `true` if delegation is allowed.
   */
  async prepareStandardCommand(kind: StandardCommandKind): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    if (this.historyState.isProtected()) {
      await this.host.reportUserError(
        'historyProtected.message',
        `Skipped delegating ${kind} because the document is protected`,
      );
      return false;
    }
    if (kind !== STANDARD_COMMAND_KIND.save && !HISTORY_EVENTS_ENABLED) {
      // In a build that does not fire edit events, VS Code has no history entry to go back to.
      return false;
    }

    if (!(await this.host.flushEditTransactions())) {
      if (kind === STANDARD_COMMAND_KIND.save) {
        // When the view does not respond the flush fails too. Stopping here would keep the save key from reaching
        // a save of the retained copy. The save path's check decides whether writing is allowed and reports its
        // own result, so nothing is reported here.
        this.host.reportInternalError('Could not flush pending edits, but delegated the save');
        return true;
      }
      await this.host.reportUserError(
        'historyFlushFailed.message',
        `Could not flush the pending edit before ${kind}`,
      );
      return false;
    }
    if (this.tracker.hasUnsettledUnit()) {
      await this.host.reportUserError(
        'historyFlushFailed.message',
        `The flush before ${kind} left an unsettled edit unit`,
      );
      return false;
    }
    return true;
  }

  /**
   * Body of the undo/redo callbacks.
   *
   * Neither a flush nor a new event registration happens here. Settling inside the callback would add another
   * entry behind the one VS Code is currently reverting.
   *
   * @param direction Direction of the history transition.
   * @param entry Registered entry passed by VS Code.
   * @returns Whether it was applied. On failure, resolves only after preservation completes.
   */
  async runHistoryTransition(
    direction: HistoryDirection,
    entry: HistoryEntryRecord,
  ): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    if (this.historyState.isProtected()) {
      // Do not apply old history. It would overwrite the protected content with full text from an untrusted position.
      this.host.reportInternalError('Skipped a history transition because the document is protected');
      await this.protectionCompleted;
      return false;
    }
    if (this.tracker.hasUnsettledUnit()) {
      this.reportProtection(
        'A history transition arrived while an edit unit was unsettled',
        this.host.lastKnownText(),
      );
      await this.protectionCompleted;
      return false;
    }

    const applied = await this.host.applyHistoryTransition(direction, {
      before: entry.before,
      after: entry.after,
    });
    if (applied.kind === 'failed') {
      await this.host.reportUserError('historyApplyFailed.message', applied.reason);
      this.reportProtection(applied.reason, applied.liveText);
      await this.protectionCompleted;
      return false;
    }

    this.historyState.markTransitionApplied(direction, entry);
    this.confirmedText = applied.text;
    if (this.historyState.isAtSavePoint()) {
      this.host.unblockReplacement();
      this.host.notifyReturnedToSavePoint();
    } else {
      this.host.blockReplacement();
    }
    return true;
  }

  /**
   * Registers the restore from a backup itself as one settled history entry.
   *
   * If only the new edits after the restore were in the history, undoing them would treat the restored content
   * as saved and let the tab close without confirmation. Undoing this entry returns to the current source.
   *
   * @param sourceText The current source full text before the restore (LF).
   * @param restoredText The restored full text after the merge (LF).
   * @returns Whether it was registered.
   */
  registerRestoreEntry(sourceText: string, restoredText: string): boolean {
    if (this.disposed || this.restoreEntryRegistered) {
      return false;
    }
    const point = this.historyState.registerEntry();
    if (point === undefined) {
      return false;
    }

    const record: HistoryEntryRecord = {
      unitId: RESTORE_ENTRY_UNIT_ID,
      pointId: point.pointId,
      previousPointId: point.previousPointId,
      before: { text: sourceText, selection: null },
      after: { text: restoredText, selection: null },
    };
    this.entries.set(record.unitId, record);
    this.restoreEntryRegistered = true;
    // The restored full text is settled. It is what the view has finished displaying, so the next save is
    // checked against this full text.
    this.confirmedText = restoredText;
    this.fireHistoryEvent(record);
    return true;
  }

  /**
   * Updates the save point after a successful save. History entries are kept.
   *
   * @param text Full text that was written.
   */
  notifySaveSucceeded(text: string): void {
    if (this.disposed || this.historyState.isProtected()) {
      return;
    }
    this.historyState.markSaved();
    this.confirmedText = text;
  }

  /**
   * Receives the result of a Revert.
   *
   * @param succeeded Whether the Revert succeeded.
   * @param text Full text after the Revert, or on failure the actual old full text just before applying.
   */
  notifyRevertResult(succeeded: boolean, text: string | undefined): void {
    if (this.disposed) {
      return;
    }
    if (!succeeded) {
      // Do not restore the dirty mark with a plain change event. It would create an entry whose before state
      // differs from the actual state.
      this.reportProtection('The revert failed', text);
      return;
    }
    if (this.historyState.isProtected()) {
      return;
    }
    this.historyState.markReverted();
    this.confirmedText = text;
  }

  /**
   * Stops editing, saving, and history on the old DOM and hands the old full text and cause to the protection sink.
   *
   * No compensating history entry is registered. An entry whose before state is the rejected candidate differs from
   * the actual state, and its undo would open the rejected content once more.
   *
   * @param reason Cause of entering protection.
   * @param staleText Actual old full text, or `undefined` if it could not be read.
   */
  reportProtection(reason: string, staleText: string | undefined): void {
    if (this.disposed) {
      return;
    }
    if (this.historyState.isProtected()) {
      this.host.reportInternalError(`Ignored a protection trigger while already protected: ${reason}`);
      return;
    }

    const pointId = this.historyState.currentPoint();
    this.historyState.enterProtection();
    this.host.protectView();
    this.protectionSettled = false;
    this.protectionCompleted = this.protectionSink
      .protect({ staleText, pointId, reason })
      .then(() => {
        this.protectionSettled = true;
      });
    void this.host.reportUserError('historyProtected.message', reason);
  }

  /**
   * Receives recovery completion exactly once and starts history and the save boundary from a new baseline.
   *
   * @param text Saved full text of the new document.
   */
  completeRecovery(text: string): void {
    if (this.disposed || !this.historyState.isProtected()) {
      return;
    }
    if (!this.protectionSettled) {
      // Read-back of the preserved copy has not been confirmed. Lifting protection here would resume editing on top of
      // content that was never kept.
      this.host.reportInternalError('Refused to complete recovery before the protection was settled');
      return;
    }

    this.historyState.completeRecovery();
    this.entries.clear();
    this.tracker.reset();
    this.confirmedText = text;
    this.protectionCompleted = Promise.resolve();
    this.protectionSettled = false;
  }

  /**
   * Returns whether protection is active.
   *
   * @returns The value read alike by delegation, application, and the save check.
   */
  isProtected(): boolean {
    return this.historyState.isProtected();
  }

  /**
   * Selects and applies, according to the direction, the same entry VS Code would undo or redo next.
   *
   * The extension host cannot trigger key input in the webview, and in a build with history events disabled
   * VS Code's undo does not arrive either. This is the entry point for integration tests to drive the production
   * application path, and it has no dedicated branches.
   *
   * @param direction Direction of the history transition.
   * @returns Whether it was applied. `false` if there is no target entry.
   */
  runHistoryTransitionForTest(direction: HistoryDirection): Promise<boolean> {
    const entry = this.findTransitionEntry(direction);
    if (entry === undefined) {
      return Promise.resolve(false);
    }
    return this.runHistoryTransition(direction, entry);
  }

  /** Resets only the tracking state on a view restart. The history point, save point, and protection carry over. */
  notifyViewRestarted(): void {
    if (!this.disposed) {
      this.tracker.reset();
      if (this.historyState.isProtected()) {
        this.host.protectView();
      }
    }
  }

  /** Drops references to registered entries when the tab is disposed. Later calls do nothing. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.entries.clear();
  }

  /**
   * Selects the entry to undo or redo next from the current history point.
   *
   * @param direction Direction of the history transition.
   * @returns Target entry, or `undefined` if there is none.
   */
  private findTransitionEntry(direction: HistoryDirection): HistoryEntryRecord | undefined {
    const current = this.historyState.currentPoint();
    let found: HistoryEntryRecord | undefined;
    for (const record of this.entries.values()) {
      // Undo takes the entry that created the current point; redo takes an entry that moves on from the current
      // point. There can be several of the latter, so pick the last registered. VS Code also discards the old redo
      // branch on a new edit.
      if (direction === HISTORY_DIRECTION.undo ? record.pointId === current : record.previousPointId === current) {
        found = record;
      }
    }
    return found;
  }

  /**
   * Registers one history entry from the start endpoint alone.
   *
   * @param unitId Edit unit id.
   * @param start Start endpoint.
   */
  private registerEntry(unitId: EditUnitId, start: EditSnapshot): void {
    const point = this.historyState.registerEntry();
    if (point === undefined) {
      return;
    }

    // Until settlement arrives, keep it as a reversible entry to the same full text. Registering only after the pair
    // arrives would leave an edit whose tab closed in the meantime not treated as unsaved.
    const record: HistoryEntryRecord = {
      unitId,
      pointId: point.pointId,
      previousPointId: point.previousPointId,
      before: start,
      after: start,
    };
    this.entries.set(unitId, record);
    this.fireHistoryEvent(record);
  }

  /**
   * With a settled pair, closes the entry registered ahead of time or registers a standalone entry.
   *
   * @param transaction Settled before-and-after pair.
   */
  private settleEntry(transaction: EditTransaction): void {
    this.confirmedText = this.tracker.settledText();

    const existing = this.entries.get(transaction.unitId);
    if (existing !== undefined) {
      // VS Code holds this reference, so replace the endpoints of the same object with the actual state.
      existing.before = transaction.before;
      existing.after = transaction.after;
      return;
    }

    const point = this.historyState.registerEntry();
    if (point === undefined) {
      return;
    }
    const record: HistoryEntryRecord = {
      unitId: transaction.unitId,
      pointId: point.pointId,
      previousPointId: point.previousPointId,
      before: transaction.before,
      after: transaction.after,
    };
    this.entries.set(transaction.unitId, record);
    this.fireHistoryEvent(record);
  }

  /**
   * Fires a custom document edit event.
   *
   * Not fired in a build with history events disabled. In that build the dirty mark is driven by edit notices, and
   * firing here as well would give one edit two drivers.
   *
   * @param record Registered history entry.
   */
  private fireHistoryEvent(record: HistoryEntryRecord): void {
    if (HISTORY_EVENTS_ENABLED) {
      this.host.notifyDocumentChanged(record);
    }
  }
}
