import {
  DOCUMENT_APPLY_OUTCOME,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import type {
  DocumentApplyKind,
  DocumentApplyOutcome,
  EditSnapshot,
  EditTransaction,
  EditUnitId,
  EncodedSelection,
  RequestId,
} from '../../common/index';
import type { HostChannel } from '../messaging/host-channel';
import type { DeliveryFailureController } from '../messaging/delivery-failure-controller';
import { createEditUnitIdFactory } from './edit-unit-id';
import {
  TRANSACTION_IDLE_MS,
  classifyEditKind,
  decideEditBoundary,
} from './edit-grouping';
import type {
  EditBoundaryDecision,
  EditClassification,
  EditGroupKind,
} from './edit-grouping';

/**
 * The pair of ranges to record at the start and end endpoints of a standalone edit. `null` is recorded as no
 * selection captured.
 *
 * Each range is encoded against the tree at the time its endpoint is captured. A live range keeps pointing at the
 * same position even when the edit changes the tree.
 */
export interface EditEndpointSelections {
  readonly start: Range | null;
  readonly end: Range | null;
}

/** Minimal snapshot capture contract used by the controller. */
export interface EditSnapshotSource {
  captureStart(): EditSnapshot | undefined;
  captureEnd(): EditSnapshot | undefined;
  /**
   * Turns a range into an encoded selection for the current tree, using the same rules as the live selection. Does
   * not change the current endpoint.
   *
   * @param range The range. If `null`, nothing is captured.
   * @returns The encoded selection. `null` for a `null` range and for a range that cannot be encoded.
   */
  encodeSelection(range: Range | null): EncodedSelection | null;
  dispose(): void;
}

/** Minimal transaction control contract used by edit producers. */
export interface EditTransactionLifecycle {
  /**
   * @param editKind The input type or command name.
   * @param endpoints The selections to record at the endpoints of the standalone edit. If omitted, the selections
   *   captured at the endpoints are recorded.
   */
  beginEdit(editKind: string, endpoints?: EditEndpointSelections): boolean;
  completeEdit(): void;
  abortEdit(): void;
}

interface PendingTransaction {
  readonly unitId: EditUnitId;
  readonly before: EditSnapshot;
  readonly groupKind: EditGroupKind | undefined;
  readonly deadline: number | undefined;
  /**
   * Whether the start message was successfully sent to the host.
   *
   * A unit whose start was not sent has nothing to close on the host, so no terminator is sent even when it
   * closes unchanged.
   */
  readonly startSent: boolean;
}

interface EditAttempt {
  readonly classification: EditClassification;
  readonly decision: EditBoundaryDecision;
  readonly boundary: EditSnapshot | undefined;
  /** Edit unit id issued for a new pending transaction or a standalone edit. Absent for a continuing attempt. */
  readonly unitId: EditUnitId | undefined;
  /**
   * The endpoints of a standalone edit that was given selections. The start pairs the full text of the captured or
   * reused start endpoint with the encoding of the given start range. The end range is encoded against the tree at
   * the time the edit attempt closes. `undefined` if no selections were given.
   */
  readonly endpoints: { readonly start: EditSnapshot; readonly end: Range | null } | undefined;
}

/** One settled item to send. Each edit unit sends exactly one of a pair or an unchanged terminator. */
type SettledUnit =
  | { readonly kind: 'settled'; readonly transaction: EditTransaction }
  | { readonly kind: 'unchanged'; readonly unitId: EditUnitId };

interface FlushRequest {
  readonly requestId: RequestId;
  readonly generation: number;
  readonly result: Promise<boolean>;
}

interface IsolatedHistoryState {
  readonly attempt: EditAttempt | undefined;
  readonly pending: PendingTransaction | undefined;
  readonly unsent: SettledUnit[];
}

/** Result of processing the history boundary before applying a document. */
export type DocumentApplyPreparation =
  | { readonly ready: false; readonly outcome: DocumentApplyOutcome }
  | { readonly ready: true; readonly finish: (applied: boolean) => void };

function isGroupKind(classification: EditClassification): classification is EditGroupKind {
  return classification !== 'single';
}

/**
 * Closes a pending transaction at its end endpoint and decides the one item to send.
 *
 * @param pending Pending transaction to close.
 * @param after End endpoint.
 * @returns A pair if the full text changed, an unchanged terminator if it did not and the start was sent, or
 *   `undefined` if there is nothing to send.
 */
function closeUnit(pending: PendingTransaction, after: EditSnapshot): SettledUnit | undefined {
  if (pending.before.text !== after.text) {
    return {
      kind: 'settled',
      transaction: { unitId: pending.unitId, before: pending.before, after },
    };
  }
  return pending.startSent ? { kind: 'unchanged', unitId: pending.unitId } : undefined;
}

/**
 * Builds a pending transaction, for a unit whose start was not sent, solely to close it on the spot.
 *
 * @param unitId Issued edit unit id.
 * @param before Start endpoint.
 * @returns Pending transaction that neither groups nor sends an unchanged terminator.
 */
function standaloneUnit(unitId: EditUnitId, before: EditSnapshot): PendingTransaction {
  return { unitId, before, groupKind: undefined, deadline: undefined, startSent: false };
}

/** Owns edit attempts, finalization boundaries, the unsent queue, and flushes for one editing session. */
export class EditTransactionController {
  private attempt: EditAttempt | undefined;

  private pending: PendingTransaction | undefined;

  private unsent: SettledUnit[] = [];

  private readonly nextEditUnitId = createEditUnitIdFactory();

  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  private attemptWaiters: (() => void)[] = [];

  private flushRequest: FlushRequest | undefined;

  private flushGeneration = 0;

  private isolated: IsolatedHistoryState | undefined;

  private disposed = false;

  constructor(
    private readonly snapshots: EditSnapshotSource,
    private readonly channel: HostChannel,
    private readonly failureController: DeliveryFailureController,
  ) {}

  /**
   * Starts an edit attempt before changing the tree.
   *
   * @param editKind The input type or command name.
   * @param endpoints The selections to record at the endpoints of the standalone edit. Not used for edits that are
   *   not standalone.
   * @returns Whether editing may proceed.
   */
  beginEdit(editKind: string, endpoints?: EditEndpointSelections): boolean {
    if (
      this.disposed
      || this.isolated !== undefined
      || this.attempt !== undefined
      || this.unsent.length > 0
    ) {
      return false;
    }

    const classification = classifyEditKind(editKind);
    const currentGroup = this.pending?.groupKind === undefined || this.pending.deadline === undefined
      ? undefined
      : { kind: this.pending.groupKind, deadline: this.pending.deadline };
    const decision = decideEditBoundary(currentGroup, classification, Date.now());
    const boundary = decision === 'continue' ? undefined : this.snapshots.captureStart();
    if (decision !== 'continue' && boundary === undefined) {
      this.handleCaptureFailure('Could not capture the history endpoint before the edit started.');
      return false;
    }

    this.attempt = {
      classification,
      decision,
      boundary,
      // A continuation issues no id. If one edit unit had two ids, the host would count it as two different units.
      unitId: decision === 'continue' ? undefined : this.nextEditUnitId(),
      // The captured start endpoint itself is not rewritten, because it also serves as the boundary endpoint that
      // closes the preceding pending transaction. The given selections are used only for the standalone edit's start
      // endpoint, and the start range is encoded here, before the tree changes.
      endpoints: classification === 'single' && endpoints !== undefined && boundary !== undefined
        ? {
          start: { text: boundary.text, selection: this.snapshots.encodeSelection(endpoints.start) },
          end: endpoints.end,
        }
        : undefined,
    };
    return true;
  }

  /** Closes a changed attempt, then updates the timeout or finalizes and delivers according to its classification. */
  completeEdit(): void {
    const attempt = this.attempt;
    if (attempt === undefined || this.disposed) {
      return;
    }
    this.attempt = undefined;

    try {
      this.completeAttempt(attempt);
    } finally {
      this.releaseAttemptWaiters();
    }
  }

  /** Closes only the unchanged attempt, preserving the existing pending transaction and timeout. */
  abortEdit(): void {
    if (this.attempt === undefined || this.disposed) {
      return;
    }
    this.attempt = undefined;
    this.releaseAttemptWaiters();
  }

  /** Returns whether the queue still contains finalized, unsent transactions. */
  hasUnsentTransactions(): boolean {
    return this.unsent.length > 0;
  }

  /** Resends the unsent queue once in oldest-first order. */
  retry(): void {
    if (this.disposed) {
      return;
    }
    while (this.unsent.length > 0) {
      try {
        this.postSettledUnit(this.unsent[0]);
        this.unsent.shift();
      } catch {
        this.failureController.reportDeliveryFailure();
        this.failureController.refresh();
        return;
      }
    }
    this.failureController.refresh();
  }

  /**
   * Waits for attempts to finish for each request ID, then delivers the pending and unsent transactions.
   *
   * @param requestId The request ID issued by the host.
   * @returns Whether every target transaction was delivered.
   */
  flush(requestId: RequestId): Promise<boolean> {
    const current = this.flushRequest;
    if (current !== undefined && current.requestId === requestId) {
      return current.result;
    }

    const generation = this.flushGeneration + 1;
    this.flushGeneration = generation;
    const result = this.performFlush(generation);
    this.flushRequest = { requestId, generation, result };
    return result;
  }

  /** Returns whether a completed promise belongs to the current flush request. */
  isCurrentFlushResult(result: Promise<boolean>): boolean {
    return this.flushRequest?.result === result;
  }

  /** Delivers, rejects, or isolates the old history state according to the document apply kind. */
  async prepareDocumentApply(
    kind: DocumentApplyKind,
    hasUnsentContent: boolean,
  ): Promise<DocumentApplyPreparation> {
    if (this.disposed) {
      return { ready: false, outcome: DOCUMENT_APPLY_OUTCOME.failed };
    }

    if (kind === 'saveCandidate') {
      const success = await this.performFlush();
      return success
        ? { ready: true, finish: () => undefined }
        : { ready: false, outcome: DOCUMENT_APPLY_OUTCOME.failed };
    }

    if (kind === 'externalChange') {
      if (
        hasUnsentContent
        || this.isolated !== undefined
        || this.attempt !== undefined
        || this.pending !== undefined
        || this.unsent.length > 0
      ) {
        return { ready: false, outcome: DOCUMENT_APPLY_OUTCOME.rejectedUnsaved };
      }
      return { ready: true, finish: () => undefined };
    }

    if (kind === 'editHistory') {
      if (
        this.isolated !== undefined
        || this.attempt !== undefined
        || this.pending !== undefined
        || this.unsent.length > 0
      ) {
        return { ready: false, outcome: DOCUMENT_APPLY_OUTCOME.failed };
      }
      return { ready: true, finish: () => undefined };
    }

    if (this.isolated !== undefined) {
      return { ready: false, outcome: DOCUMENT_APPLY_OUTCOME.failed };
    }

    // Isolate the entire old state from timeout processing until the Revert replacement succeeds or fails.
    this.clearIdleTimer();
    const isolated: IsolatedHistoryState = {
      attempt: this.attempt,
      pending: this.pending,
      unsent: this.unsent,
    };
    this.isolated = isolated;
    this.attempt = undefined;
    this.pending = undefined;
    this.unsent = [];
    return {
      ready: true,
      finish: (applied) => {
        if (this.isolated !== isolated) {
          return;
        }
        this.isolated = undefined;
        if (!applied && !this.disposed) {
          this.attempt = isolated.attempt;
          this.pending = isolated.pending;
          this.unsent = isolated.unsent;
          this.schedulePendingDeadline();
        }
      },
    };
  }

  /** Delivers history synchronously during unload without creating retry state on failure. */
  flushForUnload(): void {
    if (this.disposed) {
      return;
    }
    this.clearIdleTimer();

    const ready = [...this.unsent];
    const boundary = this.snapshots.captureEnd();
    if (boundary !== undefined) {
      const attempt = this.attempt;
      const attemptBoundary = attempt?.boundary;
      const pending = this.pending;
      if (pending !== undefined) {
        // If the attempt has a start endpoint, the pending transaction covers up to it; otherwise up to the end endpoint.
        pushSettled(ready, closeUnit(pending, attemptBoundary ?? boundary));
      }
      if (attemptBoundary !== undefined && attempt?.unitId !== undefined) {
        pushSettled(ready, closeUnit(standaloneUnit(attempt.unitId, attemptBoundary), boundary));
      }
    } else if (this.pending !== undefined || this.attempt !== undefined) {
      this.postUnloadDiagnostic('Could not capture the history endpoint during unload.');
    }

    for (const entry of ready) {
      try {
        this.postSettledUnit(entry);
      } catch (error) {
        this.postUnloadDiagnostic(`Could not send an edit transaction during unload: ${String(error)}`);
        break;
      }
    }
  }

  /** Disposes timeouts, waiters, history state, and the reusable endpoint with the old session. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearIdleTimer();
    this.attempt = undefined;
    this.pending = undefined;
    this.unsent = [];
    this.isolated = undefined;
    this.flushRequest = undefined;
    this.snapshots.dispose();
    this.releaseAttemptWaiters();
  }

  private completeAttempt(attempt: EditAttempt): void {
    if (attempt.decision === 'continue') {
      const pending = this.pending;
      if (pending?.groupKind === undefined) {
        return;
      }
      this.pending = { ...pending, deadline: Date.now() + TRANSACTION_IDLE_MS };
      this.schedulePendingDeadline();
      return;
    }

    const boundary = attempt.boundary;
    const unitId = attempt.unitId;
    if (boundary === undefined || unitId === undefined) {
      return;
    }

    if (attempt.decision === 'start' && isGroupKind(attempt.classification)) {
      this.openPending(unitId, boundary, attempt.classification);
      return;
    }

    if (
      (attempt.decision === 'kindBoundary' || attempt.decision === 'idleBoundary')
      && isGroupKind(attempt.classification)
    ) {
      const previous = this.pending;
      this.clearIdleTimer();
      const previousClose = previous === undefined ? undefined : closeUnit(previous, boundary);
      if (previousClose !== undefined && !this.sendBatch([previousClose])) {
        const after = this.snapshots.captureEnd();
        if (after === undefined) {
          // The boundary endpoint is available, so keep the failed pre-boundary entries in the unsent queue and
          // retain only the applied post-boundary edit as pending from that endpoint. Never group across the boundary.
          this.pending = standaloneUnit(unitId, boundary);
          this.handleCaptureFailure('Could not capture the edit endpoint after delivery failed.');
          return;
        }
        pushSettled(this.unsent, closeUnit(standaloneUnit(unitId, boundary), after));
        this.pending = undefined;
        return;
      }
      this.openPending(unitId, boundary, attempt.classification);
      return;
    }

    const endpoints = attempt.endpoints;
    const start = endpoints?.start ?? boundary;
    const after = this.snapshots.captureEnd();
    if (after === undefined) {
      // Although the end endpoint is missing, the boundary endpoint is available. Finalize and deliver only the
      // pre-boundary edit, then retain the applied post-boundary edit as pending. Never group across the boundary.
      const previous = this.pending;
      const previousClose = previous === undefined ? undefined : closeUnit(previous, boundary);
      if (previousClose !== undefined) {
        this.sendBatch([previousClose]);
      }
      this.pending = standaloneUnit(unitId, start);
      this.handleCaptureFailure('Could not capture the history endpoint after the edit completed.');
      return;
    }

    // The captured end endpoint is reused as the current endpoint at the next start, so the selection is replaced only
    // in the pair that is sent.
    const end = endpoints === undefined
      ? after
      : { text: after.text, selection: this.snapshots.encodeSelection(endpoints.end) };
    const ready: SettledUnit[] = [];
    if (this.pending !== undefined) {
      pushSettled(ready, closeUnit(this.pending, boundary));
    }
    pushSettled(ready, closeUnit(standaloneUnit(unitId, start), end));
    this.pending = undefined;
    this.clearIdleTimer();
    this.sendBatch(ready);
  }

  /**
   * Opens a new pending transaction and sends its start endpoint once.
   *
   * The start is never resent. A start arriving after its pair would leave the host awaiting a settlement that
   * nothing will close, blocking every later save and history application. For a unit whose start could not
   * be sent, the pair sent on close is registered as a standalone edit.
   *
   * @param unitId Issued edit unit id.
   * @param before Start endpoint.
   * @param groupKind Grouping kind to group together.
   */
  private openPending(unitId: EditUnitId, before: EditSnapshot, groupKind: EditGroupKind): void {
    try {
      this.channel.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart, unitId, start: before });
    } catch {
      const after = this.snapshots.captureEnd();
      if (after === undefined) {
        this.pending = standaloneUnit(unitId, before);
        this.handleCaptureFailure('Could not capture the edit endpoint after the start delivery failed.');
        return;
      }
      this.unsent.push({
        kind: 'settled',
        transaction: { unitId, before, after },
      });
      this.pending = undefined;
      this.clearIdleTimer();
      this.failureController.reportDeliveryFailure();
      return;
    }

    this.pending = {
      unitId,
      before,
      groupKind,
      deadline: Date.now() + TRANSACTION_IDLE_MS,
      startSent: true,
    };
    this.schedulePendingDeadline();
  }

  private async performFlush(generation?: number): Promise<boolean> {
    if (this.isolated !== undefined) {
      return false;
    }
    await this.waitForAttemptEnd();
    if (
      this.disposed
      || (generation !== undefined && this.flushRequest?.generation !== generation)
    ) {
      return false;
    }

    this.clearIdleTimer();
    if (this.unsent.length > 0) {
      this.retry();
      if (this.unsent.length > 0) {
        return false;
      }
    }
    const pending = this.pending;
    if (pending === undefined) {
      return true;
    }

    const after = this.snapshots.captureEnd();
    if (after === undefined) {
      this.handleCaptureFailure('Could not capture the history endpoint while flushing.');
      return false;
    }
    const ready = closeUnit(pending, after);
    this.pending = undefined;
    if (ready === undefined) {
      return true;
    }
    return this.sendBatch([ready]);
  }

  private sendBatch(entries: readonly SettledUnit[]): boolean {
    for (let index = 0; index < entries.length; index += 1) {
      try {
        this.postSettledUnit(entries[index]);
      } catch {
        this.unsent = entries.slice(index);
        this.pending = undefined;
        this.clearIdleTimer();
        this.failureController.reportDeliveryFailure();
        return false;
      }
    }
    this.failureController.refresh();
    return true;
  }

  private postSettledUnit(entry: SettledUnit): void {
    this.channel.post(
      entry.kind === 'settled'
        ? { type: VIEW_TO_HOST_MESSAGE_TYPE.editTransaction, transaction: entry.transaction }
        : { type: VIEW_TO_HOST_MESSAGE_TYPE.editUnitUnchanged, unitId: entry.unitId },
    );
  }

  private schedulePendingDeadline(): void {
    this.clearIdleTimer();
    const deadline = this.pending?.deadline;
    if (deadline === undefined || this.disposed) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.handleIdleDeadline();
    }, Math.max(0, deadline - Date.now()));
  }

  private async handleIdleDeadline(): Promise<void> {
    await this.waitForAttemptEnd();
    if (this.disposed || this.pending === undefined) {
      return;
    }
    const deadline = this.pending.deadline;
    if (deadline !== undefined && Date.now() < deadline) {
      this.schedulePendingDeadline();
      return;
    }
    await this.performFlush();
  }

  private waitForAttemptEnd(): Promise<void> {
    if (this.attempt === undefined) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.attemptWaiters.push(resolve);
    });
  }

  private releaseAttemptWaiters(): void {
    const waiters = this.attemptWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }

  private handleCaptureFailure(detail: string): void {
    this.clearIdleTimer();
    this.failureController.reportCaptureFailure(detail);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === undefined) {
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private postUnloadDiagnostic(detail: string): void {
    try {
      this.channel.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.viewDiagnostic, detail });
    } catch {
      // During unload there is no other reporting destination, so a diagnostic delivery failure must not stop later preservation.
    }
  }
}

/**
 * Appends to the queue only when there is something to send.
 *
 * @param entries Queue of items waiting to be sent.
 * @param entry Result of closing, or `undefined` if there is nothing to send.
 */
function pushSettled(entries: SettledUnit[], entry: SettledUnit | undefined): void {
  if (entry !== undefined) {
    entries.push(entry);
  }
}
