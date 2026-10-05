import {
  DOCUMENT_APPLY_KIND,
  DOCUMENT_APPLY_OUTCOME,
  DOCUMENT_REPLACE_TIMEOUT_MS,
  HISTORY_DIRECTION,
  HOST_TO_VIEW_MESSAGE_TYPE,
  VIEW_TO_HOST_MESSAGE_TYPE,
  decideHistoryTransition,
  detectLineEnding,
  isBlankDocument,
  normalizeLineEndings,
  restoreLineEndings,
  rewriteCharsetDeclaration,
} from '../../common/index';
import type {
  BodyOutputResponseMessage,
  DocumentApplyKind,
  DocumentApplyOutcome,
  DocumentReplacedMessage,
  HistoryDirection,
  HostToViewMessage,
  LineEnding,
  MessageKey,
  ReplaceEditHistoryMessage,
  RequestId,
  ResponseMessage,
} from '../../common/index';
import type {
  HistoryApplyResult,
  RecordedEndpoints,
} from '../history/edit-history-coordinator';
import { PendingRequests } from '../messaging/pending-requests';
import { BUFFER_FOLLOW_TIMEOUT_MS, pollTextBuffer } from './buffer-follow';
import { DocumentOperationQueue } from './document-operation-queue';
import type { QueuedOperationResult } from './document-operation-queue';
import type { DocumentSyncState } from './document-sync-state';
import { mergeSaveCandidate } from './save-merge';
import type { SaveCandidate } from './save-merge';

/** The result of reading the text buffer once. */
export interface TextBufferSnapshot {
  /** The whole buffer text. VS Code has already decoded it, and the line endings keep the file's spelling. */
  readonly text: string;
  /** Whether the text tab has unsaved edits. */
  readonly isDirty: boolean;
}

/**
 * The extension-host channel the save coordinator uses.
 *
 * Keeping vscode types out of this interface makes the coordinator's behavior verifiable without
 * launching VS Code. URIs are passed as strings.
 */
export interface SaveHost {
  /**
   * Writes the whole text to a destination.
   *
   * @param uri The string form of the URI to write to.
   * @param text The whole text to write, with its line endings already restored.
   */
  writeFile(uri: string, text: string): Promise<void>;

  /** Reads the text buffer. */
  readTextBuffer(): Promise<TextBufferSnapshot>;

  /**
   * Reads a file as UTF-8.
   *
   * The result of a recovery write is verified against the file, not the text buffer. The buffer can lag behind the
   * disk.
   *
   * @param uri The string form of the URI to read.
   * @returns The file's full text, with line endings as spelled in the file.
   */
  readFile(uri: string): Promise<string>;

  /**
   * Sends a message to the view.
   *
   * @param message The message to send.
   */
  postToView(message: HostToViewMessage): Promise<void>;

  /** Fires one change event to mark the tab dirty. */
  notifyDocumentChanged(): void;

  /**
   * Records one line in the diagnostic log for a fact the user cannot act on.
   *
   * @param detail One line intended for maintainers.
   */
  reportInternalError(detail: string): void;

  /**
   * Notifies the user of a failure and records its cause in the diagnostic log.
   *
   * @param key The message key for the notification.
   * @param cause One line describing the cause, recorded in the diagnostic log.
   */
  reportUserError(key: MessageKey, cause?: string): Promise<void>;

  /**
   * Tells the user of a success. Showing it as an error notification would make a successful save look like a failure.
   *
   * @param key The message key of the notification body.
   */
  reportUserInformation(key: MessageKey): Promise<void>;
}

/** The per-document state the save coordinator reads and writes. */
export interface DocumentState {
  /** The last known content, or `undefined` when none exists. Held LF-delimited. */
  readonly lastKnownContent: string | undefined;

  /**
   * Replaces the last known content with the received text.
   *
   * @param text The complete document text received from the view.
   */
  retainUnsavedContent(text: string): void;

  /** Clears the last known content. */
  clearUnsavedContent(): void;

  /** The file's line ending: the spelling restored when writing back. */
  lineEnding: LineEnding;

  /** Sync state for this document. The save coordinator receives it from the document rather than creating it. */
  readonly syncState: DocumentSyncState;
}

/**
 * Target endpoint and edit range, present only on a history application request.
 *
 * The message definition is kept as the single source of truth. Writing the same shape again here would let
 * only one of the two change.
 */
export type HistoryApplyRequest =
  Pick<ReplaceEditHistoryMessage, 'targetText' | 'targetSelection' | 'editRange'>;

/**
 * One full-document application request.
 *
 * The kind and its extra values are bundled into one value. As separate arguments, the types could not rule
 * out a history application without a target endpoint.
 */
type DocumentApplyRequest =
  | {
    readonly kind: Exclude<DocumentApplyKind, typeof DOCUMENT_APPLY_KIND.editHistory>;
    readonly text: string;
  }
  | {
    readonly kind: typeof DOCUMENT_APPLY_KIND.editHistory;
    readonly text: string;
    readonly history: HistoryApplyRequest;
  };

/**
 * Port the save side uses to reach the history side.
 *
 * The save coordinator does not know the edit history coordinator directly. If each referenced the other,
 * whichever was created first would have a period with the other unset.
 */
export interface SaveHistoryPort {
  /**
   * Whether the dirty mark is driven by custom document edit events.
   *
   * VS Code cannot mix edit events with plain change events in one provider. While this is true, the save side
   * fires no plain change events.
   */
  isHistoryEventDriven(): boolean;

  /**
   * Returns, from the settlement status of history endpoints, whether saving may proceed.
   *
   * @param text Full text of the view output the save candidate was built from.
   */
  prepareSaveEndpoint(text: string): Promise<boolean>;

  /**
   * Returns, without flushing, whether the retained copy may be written, based on how far history endpoints are settled.
   *
   * Used for saves when the view is unresponsive. A view that does not respond will not receive a flush either, so
   * waiting for a flush would fail the save.
   *
   * @param text The retained copy about to be written.
   */
  confirmSaveEndpoint(text: string): boolean;

  /**
   * Reports a successful save.
   *
   * @param text Full text that was written.
   */
  notifySaveSucceeded(text: string): void;

  /**
   * Reports the result of a Revert.
   *
   * @param succeeded Whether it succeeded.
   * @param text Full text after the Revert on success, or the actual old full text on failure.
   */
  notifyRevertResult(succeeded: boolean, text: string | undefined): void;

  /**
   * Hands over a trigger that stops editing, saving, and history on the old DOM.
   *
   * @param reason Cause.
   * @param staleText Actual old full text.
   */
  reportProtection(reason: string, staleText: string | undefined): void;
}

/**
 * The outcome returned by the three save entry points.
 *
 * There is no value dedicated to cancellation. A cancellation joins the existing path as one kind of
 * failure, which avoids adding another recovery mechanism.
 */
export type SaveOutcome = 'completed' | 'failed';

/**
 * The outcome of a Revert.
 *
 * Abandoned is kept apart from failed because, on Don't Save when closing a tab, VS Code closes the tab without
 * waiting for the Revert to finish. Only a failure with the view still present is treated as a failure, and the
 * backup is kept.
 */
export type RevertOutcome = SaveOutcome | 'abandoned';

/**
 * The result of an output request.
 *
 * Distinguishes unresponsiveness from a response saying output cannot be produced. A view that responded is alive,
 * and writing the retained copy in that state would ignore why the view could not produce output and save stale
 * content.
 */
export type BodyOutputResult =
  | { readonly kind: 'text'; readonly text: string }
  // No response within the timeout, or the view was disposed or reloaded before responding.
  | { readonly kind: 'unresponsive' }
  // A response of null or a value outside the contract, or the request could not be sent.
  | { readonly kind: 'unavailable' };

/**
 * The outcome of writing an HTML skeleton to a blank document.
 *
 * The cause of a skeleton that was not written goes to the diagnostic log only; the user sees one message whatever it
 * is, because in every case the file was left unchanged.
 */
export type SkeletonWriteOutcome =
  | { readonly kind: 'written' }
  | { readonly kind: 'notWritten'; readonly cause: string };

/** A port for performing recovery reads and writes within one unit of the operation queue. */
export interface RecoveryOperationPort {
  /** Waits for the buffer to follow and resolves the current source. */
  resolveSource(): Promise<SourceResolution>;
  /** Reads the original file and returns it normalized to LF. */
  readFile(): Promise<string>;
  /**
   * Writes the full text to the original file.
   *
   * @param text The full text to write (LF).
   * @param lineEnding The line ending to restore.
   */
  writeText(text: string, lineEnding: LineEnding): Promise<void>;
}

/**
 * Source reread triggers accepted as change notifications.
 *
 * Only file change notifications poll a buffer still at the sync base until the timeout because a file notification
 * can arrive before the text buffer follows the change. Initial reconciliation performs the same polling only when a
 * notification was missed while the sync base was uninitialized.
 */
export type SourceChangeTrigger = 'textBufferChange' | 'fileChange' | 'initialReconcile';

/** Source reread trigger. Save and Revert use the same source-resolution process. */
export type SourceResolutionTrigger = SourceChangeTrigger | 'save' | 'revert';

/**
 * Result of resolving the current source.
 *
 * The three failures remain distinct because each branch has different notification text and follow-up processing.
 */
export type SourceResolution =
  | {
    readonly kind: 'resolved';
    /** Full text of the resolved clean source (LF). */
    readonly text: string;
    /** Line ending detected from that source. */
    readonly lineEnding: LineEnding;
  }
  // The text buffer has unsaved edits. It cannot be used as the source because it may not match the disk.
  | { readonly kind: 'dirty' }
  | { readonly kind: 'unreadable'; readonly cause: string }
  // The buffer stayed at the write reconcile's previous source until timeout. Arrival of the preceding write has not
  // been confirmed.
  | { readonly kind: 'followTimeout' };

/** One text-buffer read retained in separate forms for comparison and line-ending detection. */
interface BufferText {
  /** Full text normalized to LF. All comparisons use this form. */
  readonly text: string;
  /** Full text before normalization, used to detect the line ending. */
  readonly raw: string;
}

/** Clean full text resolved by buffer follow, or dirty state detected while waiting. */
type BufferFollowOutcome = BufferText | { readonly kind: 'dirty' };

/**
 * Result of full-document application determined by the host.
 *
 * Not applied is returned only when the view is disposed or reloaded before the outcome is determined. The tree that
 * the view may have applied is also lost, making this distinct from all three view outcomes.
 */
export type HostApplyResult = DocumentApplyOutcome | 'notApplied';

/** Full-document application awaiting a final outcome. */
interface ApplyInFlight {
  readonly requestId: RequestId;
  /** Stops waiting for the outcome and makes the caller receive not applied. */
  readonly abandon: () => void;
}

/** The phase of a revert. It decides whether a change event may be fired. */
type RevertPhase =
  // No revert is running.
  | 'none'
  // From acceptance until the ack. These notices are about edits the replacement discards, so the tab
  // is not marked dirty again.
  | 'replacing'
  // After the ack, until the outcome is returned. These are edits to the new tree, so the notice is
  // fired again once the outcome has been returned.
  | 'settling';

/**
 * The owner of save, save as, and revert for one document.
 *
 * The queue and the debounced sends touch the same state through different paths, so holding that
 * state and receiving messages from the view are gathered here. Any operation added later has just one
 * rule to follow: go through the coordinator.
 */
export class SaveCoordinator {
  private readonly queue = new DocumentOperationQueue();

  private readonly pending: PendingRequests;

  private applyInFlight: ApplyInFlight | undefined;

  // Sync base for which delayed buffer follow has already been settled. A buffer that did not move before timeout can
  // only produce the same result until the sync base moves. Waiting for the full timeout whenever both notification
  // types arrive for one change would leave the operation queue that serializes Save and Revert spinning idly.
  private followedBase: string | undefined;

  // Whether a change notification was missed while the sync base was uninitialized. A notification with no comparison
  // base cannot be reconciled, so initial reconciliation performs delayed buffer-follow polling for that notification.
  private missedSourceChangeNotice = false;

  private historyPort: SaveHistoryPort | undefined;

  private revertPhase: RevertPhase = 'none';

  // Whether a notice arrived after the ack and was deferred until the outcome had been returned.
  private deferredChangeNotice = false;

  private disposed = false;

  /**
   * @param documentUri The string form of the original file's URI.
   * @param state The per-document state.
   * @param host The extension-host channel.
   */
  constructor(
    private readonly documentUri: string,
    private readonly state: DocumentState,
    private readonly host: SaveHost,
  ) {
    this.pending = new PendingRequests(host);
  }

  /**
   * Receives the port to the history side.
   *
   * Set it before subscribing to messages, so that an edit arriving before it is set cannot get a save through
   * without reaching the history side.
   *
   * This port is always set before any save entry point runs. There is no fallback behavior while it is unset.
   * If wiring decided whether to hand over to protection or fire a plain change event, the same failure would
   * have two destinations.
   *
   * @param port Port to the history side. A later one replaces it.
   */
  setHistoryPort(port: SaveHistoryPort): void {
    this.historyPort = port;
  }

  /**
   * Queues a save and, once its turn comes, carries it from regenerating the output through to writing to disk.
   *
   * Preserves the order: receive output, confirm buffer follow, merge, apply to the view, then write. The candidate is
   * applied to the view before the file is written so the file remains unchanged if application fails.
   *
   * The outcome is returned as soon as the write has succeeded or failed, without waiting for the save
   * committed or save released message to be sent. Input in the view is held by the overlay for the
   * whole round trip, so nothing is missed by not waiting. The queued unit itself lasts until that send
   * has finished.
   *
   * @param isCancelled A function returning whether the supplied token has been cancelled.
   * @returns Whether it completed or failed.
   */
  save(isCancelled: () => boolean): Promise<SaveOutcome> {
    return this.runEntry<SaveOutcome>(async (settle) => {
      const output = await this.requestBodyOutput();
      if (output.kind === 'unresponsive') {
        await this.saveFallback(this.documentUri, isCancelled, settle);
        return;
      }
      if (output.kind === 'unavailable') {
        settle('failed');
        // Without the output handed over, the host is left with nothing but its last known content, so
        // ask for a resend.
        await this.endRoundTrip(false, true);
        return;
      }
      const viewText = output.text;

      // Check before resolving the source. Mixing a failed source resolution with incomplete history endpoints
      // would make it impossible to tell from the log which one prevented the write.
      if (this.historyPort !== undefined && !(await this.historyPort.prepareSaveEndpoint(viewText))) {
        settle('failed');
        await this.endRoundTrip(false, false);
        return;
      }

      const resolution = await this.resolveCurrentSource('save');
      if (resolution.kind !== 'resolved') {
        settle('failed');
        await this.reportResolutionFailure(resolution, 'saving');
        await this.endRoundTrip(false, false);
        return;
      }

      if (isCancelled()) {
        this.host.reportInternalError('Skipped applying the save candidate because the save was cancelled');
        settle('failed');
        await this.endRoundTrip(false, false);
        return;
      }

      const candidate = this.buildSaveCandidate(resolution.text, viewText);
      if (candidate === undefined) {
        // If the view mounted, the sync base is initialized, so a save that received output cannot reach this branch.
        // This is not actionable by the user; record it and fail the save.
        this.host.reportInternalError('Skipped merging because the sync base is not initialized');
        settle('failed');
        await this.endRoundTrip(false, false);
        return;
      }

      const applied = await this.applySaveCandidate(candidate, resolution.text);
      if (applied !== DOCUMENT_APPLY_OUTCOME.applied) {
        settle('failed');
        // The file is unchanged, and the view still contains the edits from before the save.
        await this.host.reportUserError(
          'documentApplyFailed.message',
          `The view did not apply the save candidate: ${applied}`,
        );
        await this.endRoundTrip(false, false);
        return;
      }

      const written = await this.writeDocumentText(
        this.documentUri,
        candidate.text,
        resolution.lineEnding,
        isCancelled,
      );
      if (!written) {
        // Leave the sync base and write reconcile unchanged. The view containing the candidate and the save retry base
        // remain, so the next save retries from that common ancestor.
        settle('failed');
        await this.endRoundTrip(false, false);
        return;
      }

      this.retainWrittenBody(candidate.text, resolution.text);
      this.historyPort?.notifySaveSucceeded(candidate.text);
      settle('completed');
      await this.endRoundTrip(true, false);
    }, 'failed');
  }

  /**
   * Runs a history transition as one unit of the document operation queue, deciding the candidate and applying
   * the full document once each.
   *
   * It goes on the same queue as saves and external changes. Running concurrently would base the candidate
   * decision on source written in the middle of applying.
   *
   * @param direction Direction of the history transition.
   * @param recorded Recorded before and after endpoints.
   * @returns Result of applying.
   */
  applyHistoryTransition(
    direction: HistoryDirection,
    recorded: RecordedEndpoints,
  ): Promise<HistoryApplyResult> {
    if (this.queue.isClosed) {
      return Promise.resolve(this.failHistoryApply('The document operation queue is closed'));
    }

    let settle = (_result: HistoryApplyResult): void => undefined;
    const result = new Promise<HistoryApplyResult>((resolve) => {
      settle = resolve;
    });

    void this.queue.run(() => this.runHistoryApply(direction, recorded, settle)).then(
      (outcome) => {
        if (!outcome.ran) {
          settle(this.failHistoryApply('The document operation queue was closed before the turn came'));
        }
      },
      (error: unknown) => {
        this.host.reportInternalError(`A history transition ended with an error: ${String(error)}`);
        settle(this.failHistoryApply(`The history transition ended with an error: ${String(error)}`));
      },
    );

    return result;
  }

  /**
   * Replaces the live view content with modified full text in integration tests.
   *
   * The extension host cannot generate keystrokes, so the existing full-document application path is required for the
   * save path to receive genuinely different view output. This leaves the sync state unchanged and delegates the
   * decision to the edit notice sent next by the test.
   *
   * @param text Full document text to apply to the view.
   * @returns Whether the view could apply the full text.
   */
  replaceViewContentForTest(text: string): Promise<boolean> {
    return this.runEntry<SaveOutcome>(async (settle) => {
      const outcome = await this.requestDocumentApply({
        kind: DOCUMENT_APPLY_KIND.saveCandidate,
        text,
      });
      await this.endRoundTrip(false, false);
      settle(outcome === DOCUMENT_APPLY_OUTCOME.applied ? 'completed' : 'failed');
    }, 'failed').then((outcome) => outcome === 'completed');
  }

  /**
   * Writes to a destination, treating a destination equal to the original file as an ordinary save.
   *
   * Saving to another URI bypasses both merging and reconciliation because it creates a new file from view output
   * rather than synchronizing with the current source. It also serves as an escape hatch when buffer follow cannot be
   * confirmed, so an existing write reconcile does not make it fail.
   *
   * Success to a different URI sends no save committed message: VS Code disposes the original tab, so
   * there is nowhere left to replace the three baselines. A save released message lowers only the
   * overlay instead, and the original document's queue is closed.
   *
   * @param destinationUri The string form of the destination URI.
   * @param isCancelled A function returning whether the supplied token has been cancelled.
   * @returns Whether it completed or failed.
   */
  saveAs(destinationUri: string, isCancelled: () => boolean): Promise<SaveOutcome> {
    if (destinationUri === this.documentUri) {
      return this.save(isCancelled);
    }

    return this.runEntry<SaveOutcome>(async (settle) => {
      const output = await this.requestBodyOutput();
      if (output.kind === 'unresponsive') {
        await this.saveFallback(destinationUri, isCancelled, settle);
        return;
      }
      if (output.kind === 'unavailable') {
        settle('failed');
        await this.endRoundTrip(false, true);
        return;
      }

      const written = await this.writeDocumentText(
        destinationUri,
        // The destination is written as UTF-8 too, so it must not keep declaring another encoding.
        rewriteCharsetDeclaration(output.text),
        this.state.lineEnding,
        isCancelled,
      );
      if (!written) {
        settle('failed');
        await this.endRoundTrip(false, false);
        return;
      }

      await this.endRoundTrip(false, false);
      this.queue.close();
      settle('completed');
    }, 'failed');
  }

  /**
   * Re-reads the text buffer and replaces the view's tree with its content.
   *
   * While a write reconcile exists, waits for the buffer to follow the written full text before rereading. The write
   * reconcile represents the latest write; reading without waiting could restore the preceding content.
   *
   * The dirty mark is already cleared when the revert is accepted and does not come back when a failure
   * is returned, so a failure raises it again with a change event.
   *
   * @param isCancelled A function returning whether the supplied token has been cancelled.
   * @returns Completed, failed, or abandoned because the document was disposed.
   */
  revert(isCancelled: () => boolean): Promise<RevertOutcome> {
    // From acceptance until the ack, do not mark the tab dirty again for notices about edits the
    // replacement discards.
    this.revertPhase = 'replacing';

    return this.runEntry<RevertOutcome>(
      async (settle) => {
        try {
          settle(await this.runRevert(isCancelled));
        } finally {
          // Fire again only after the outcome has reached the caller. Firing earlier races with VS Code
          // clearing the dirty mark, and the notice is swallowed.
          await Promise.resolve();
          this.finishRevert();
        }
      },
      'failed',
      () => {
        this.finishRevert();
        // The queue closed on a disposed coordinator only when closing the tab abandoned the Revert before it was
        // applied.
        return this.disposed ? 'abandoned' : 'failed';
      },
    );
  }

  /**
   * Resolves the current source for the restore without writing.
   *
   * Performs the same resolution as a save, as one unit of the document operation queue. Outside the queue it
   * could read the source in the middle of an earlier write. Leaves the sync state, the retained copy, and the
   * file unchanged.
   *
   * @returns The resolution, or `undefined` if the queue was closed and it did not run.
   */
  async resolveSourceForRestore(): Promise<SourceResolution | undefined> {
    if (this.queue.isClosed) {
      return undefined;
    }
    const result = await this.queue.run(() => this.resolveCurrentSource('save'));
    return result.ran ? result.value : undefined;
  }

  /**
   * Enqueues one source-change reconciliation operation.
   *
   * Does not read content when the notice is received. Reading concurrently with Save or Revert could use a source
   * being written or a stale sync base. Both notification types are accepted when they arrive for the same change;
   * the later one becomes a no-op when it matches the sync base.
   *
   * @param trigger Trigger that initiated reconciliation.
   */
  receiveSourceChangeNotice(trigger: SourceChangeTrigger): void {
    if (this.queue.isClosed) {
      return;
    }

    void this.queue.run(() => this.reconcileSourceChange(trigger)).then(undefined, (error: unknown) => {
      // A reconciliation failure does not stop the queue. It is not actionable by the user, so only record it.
      this.host.reportInternalError(`A source change reconcile ended with an error: ${String(error)}`);
    });
  }

  /**
   * Receives a view edited message.
   *
   * It carries no content, so there is nothing to retain. Set the flag because recreating the view would prevent the
   * view itself from determining that it had unsaved changes. Subsequent external changes are not applied as
   * replacements and are instead merged during the next save.
   */
  receiveEditNotice(): void {
    this.state.syncState.blockReplacement();
    this.fireOrDeferChangeNotice();
  }

  /**
   * Receives unsaved content and stores it as the last known content.
   *
   * It is retained before deciding whether to fire, because the opposite order would let whoever
   * handles the event read stale content.
   *
   * @param text The complete document text received.
   * @param resent Whether this is the single item resent in response to a save released message.
   */
  receiveUnsavedContent(text: string, resent: boolean): void {
    this.state.retainUnsavedContent(text);
    // Set the flag even when the resend marker is present. The view still holds unsaved content.
    this.state.syncState.blockReplacement();
    if (resent) {
      return;
    }
    this.fireOrDeferChangeNotice();
  }

  /**
   * Stops a full-document application awaiting a final outcome as not applied.
   *
   * Recreating the view also loses any tree that was already applied. No response indicates whether application
   * occurred, and the host-side sync state is still unchanged, so the caller must receive not applied. Does nothing
   * when no application is pending.
   */
  notifyViewRestarted(): void {
    this.applyInFlight?.abandon();
    // Output requests addressed to the old view will never get a response, so end them as unresponsive without
    // waiting for the timeout.
    this.pending.abandonForViewRestart();
  }

  /**
   * Runs the recovery reads and writes as one unit of the operation queue.
   *
   * Overlapping a preceding save's write would check against a source that is mid-write. The save point, sync
   * base, and history are not advanced. The old document is closed after recovery completes, and the new document
   * starts them from their initial state.
   *
   * @param operation A function that receives the read/write port.
   * @returns The operation's result, or a marker that it did not run if the queue was closed.
   */
  runRecovery<TValue>(
    operation: (port: RecoveryOperationPort) => Promise<TValue>,
  ): Promise<QueuedOperationResult<TValue>> {
    if (this.queue.isClosed) {
      return Promise.resolve({ ran: false });
    }
    return this.queue.run(() => operation({
      resolveSource: () => this.resolveCurrentSource('save'),
      readFile: async () => normalizeLineEndings(await this.host.readFile(this.documentUri)),
      writeText: (text, lineEnding) => this.host.writeFile(this.documentUri, restoreLineEndings(text, lineEnding)),
    }));
  }

  /**
   * Writes an HTML skeleton over a blank source as one unit of the operation queue.
   *
   * The source is checked again here because it may have changed since the view decided to offer the skeleton.
   * Writing over a source that is no longer blank, or while a text tab holds unsaved edits, would overwrite content
   * the user wrote. The file on disk is checked as well, because the buffer can still lag behind a write made outside
   * VS Code. The sync base moves to the skeleton together with the write, so the change notices this write
   * causes match it and send nothing to the view: the view of a blank document is not mounted and could not apply
   * them. The buffer follow is awaited so that the view recreated afterwards reads the skeleton from the buffer.
   *
   * @param text The skeleton text (LF).
   * @returns Whether the skeleton was written, or why not.
   */
  async writeSkeleton(text: string): Promise<SkeletonWriteOutcome> {
    if (this.queue.isClosed) {
      return { kind: 'notWritten', cause: `Did not write the skeleton because the document is closed: ${this.documentUri}` };
    }
    const result = await this.queue.run(() => this.writeSkeletonInQueue(text));
    return result.ran
      ? result.value
      : { kind: 'notWritten', cause: `Did not write the skeleton because the document is closed: ${this.documentUri}` };
  }

  /**
   * The body of `writeSkeleton`, run inside the operation queue.
   *
   * @param text The skeleton text (LF).
   */
  private async writeSkeletonInQueue(text: string): Promise<SkeletonWriteOutcome> {
    const resolution = await this.resolveCurrentSource('save');
    if (resolution.kind !== 'resolved') {
      return {
        kind: 'notWritten',
        cause: `Did not write the skeleton because the source could not be resolved (${resolution.kind}): ${this.documentUri}`,
      };
    }
    if (!isBlankDocument(resolution.text)) {
      return {
        kind: 'notWritten',
        cause: `Did not write the skeleton because the source is no longer blank: ${this.documentUri}`,
      };
    }
    let diskText: string;
    try {
      diskText = await this.host.readFile(this.documentUri);
    } catch (error) {
      return { kind: 'notWritten', cause: `Did not write the skeleton because the file could not be read: ${String(error)}` };
    }
    if (!isBlankDocument(diskText)) {
      return {
        kind: 'notWritten',
        cause: `Did not write the skeleton because the file on disk is no longer blank: ${this.documentUri}`,
      };
    }

    try {
      await this.host.writeFile(this.documentUri, text);
    } catch (error) {
      return { kind: 'notWritten', cause: `Failed to write the skeleton to ${this.documentUri}: ${String(error)}` };
    }
    this.retainWrittenBody(text, resolution.text);

    const followed = await this.resolveCurrentSource('save');
    if (followed.kind !== 'resolved' || followed.text !== text) {
      // The file already holds the skeleton, so it still counts as written. A recreated view that reads a buffer
      // still behind shows the blank document dialog again, and the user can retry from there.
      this.host.reportInternalError(
        `Could not confirm that the text buffer followed the skeleton (${followed.kind}): ${this.documentUri}`,
      );
    }
    return { kind: 'written' };
  }

  /**
   * Matches body output responses and acks to the pending request with the same request ID and type.
   *
   * @param response A response carrying its request ID and type.
   * @returns `true` when it matched a pending request.
   */
  settleResponse(response: ResponseMessage): boolean {
    if (this.pending.settle(response)) {
      return true;
    }
    // This response arrived after its wait had been released by a timeout or by disposal. Processing
    // has already taken another path, so discard it.
    this.host.reportInternalError(
      `Discarded a ${response.type} response that no request is waiting for: ${response.requestId}`,
    );
    return false;
  }

  /**
   * Closes the queue and releases every pending request.
   *
   * Even when the panel is disposed mid round trip, no promise is left waiting forever, and the resend
   * of a full-document apply stops instead of repeating forever. Calls after the first do nothing.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.queue.close();
    this.applyInFlight?.abandon();
    this.pending.dispose();
  }

  /**
   * Queues one invocation of a save entry point and returns to the caller as soon as the outcome is decided.
   *
   * Returning to the caller and finishing the queued unit are not the same moment: a save returns
   * without waiting for the save committed message to be sent, while the queued unit covers that send
   * as well.
   *
   * @param operation One queued unit. It calls `settle` as soon as the outcome is decided.
   * @param failed The outcome when it ends with an exception.
   * @param onNotRun The cleanup, and the outcome, when the queue was closed and it did not run.
   * @returns Whether it completed or failed.
   */
  private runEntry<TOutcome>(
    operation: (settle: (outcome: TOutcome) => void) => Promise<void>,
    failed: TOutcome,
    onNotRun: () => TOutcome = () => failed,
  ): Promise<TOutcome> {
    if (this.queue.isClosed) {
      return Promise.resolve(onNotRun());
    }

    let settle = (_outcome: TOutcome): void => undefined;
    const entryOutcome = new Promise<TOutcome>((resolve) => {
      settle = resolve;
    });

    void this.queue.run(() => operation(settle)).then(
      (result) => {
        if (!result.ran) {
          settle(onNotRun());
        }
      },
      (error: unknown) => {
        // An exception from an operation does not stop the queue. Return a failure to the entry point
        // and record the cause.
        this.host.reportInternalError(`A document operation ended with an error: ${String(error)}`);
        settle(failed);
      },
    );

    return entryOutcome;
  }

  /**
   * Requests one body output from the view and overwrites the last known content with the text received.
   *
   * The overwrite does not wait for the write to succeed or fail. Content the view produced is the last
   * known content from the moment the host receives it, and a failed write is no reason to fall back to
   * older content.
   *
   * @returns The received full text, unresponsive, or unavailable.
   */
  private async requestBodyOutput(): Promise<BodyOutputResult> {
    let reportSendFailure = (): void => undefined;
    const sendFailed = new Promise<'sendFailed'>((resolve) => {
      reportSendFailure = () => resolve('sendFailed');
    });

    const outcome = await Promise.race([
      this.pending.send<BodyOutputResponseMessage>(
        VIEW_TO_HOST_MESSAGE_TYPE.bodyOutputResponse,
        (requestId) => {
          this.host.postToView({ type: HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput, requestId }).then(
            undefined,
            (error: unknown) => {
              this.host.reportInternalError(`Could not send the output request to the view: ${String(error)}`);
              reportSendFailure();
            },
          );
        },
      ),
      sendFailed,
    ]);

    // A request that could not be sent is a failure on the extension side, not an unresponsive view. Switching to
    // the retained copy would silently cover up a defect in the send path by saving stale content.
    if (outcome === 'sendFailed') {
      return { kind: 'unavailable' };
    }
    if (!outcome.ok) {
      return { kind: 'unresponsive' };
    }

    const text = outcome.response.text;
    // The type says a string or null, but at runtime the view can send any value. Retaining a
    // non-string would open a path for writing it back to the file.
    if (typeof text !== 'string') {
      return { kind: 'unavailable' };
    }

    this.state.retainUnsavedContent(text);
    return { kind: 'text', text };
  }

  /**
   * In a save where the view does not respond, writes the retained copy in place of the output.
   *
   * Only a retained copy that passes the save endpoint confirmation may be written. Writing content that may
   * include units awaiting settlement would silently mark missed edits as saved. For the original URI, the source
   * must also be unchanged from the merge base, because writing a merge result that cannot be applied to the view
   * would let the recovered view's next save erase external changes.
   *
   * @param targetUri The destination URI: the original URI or the Save As destination.
   * @param isCancelled A function that checks for cancellation.
   * @param settle A function called once the result is decided.
   */
  private async saveFallback(
    targetUri: string,
    isCancelled: () => boolean,
    settle: (outcome: SaveOutcome) => void,
  ): Promise<void> {
    const fail = async (cause: string): Promise<void> => {
      this.host.reportInternalError(`Did not save the retained copy: ${cause}`);
      settle('failed');
      // Ask for a resend so that content newer than the retained copy can be received when the view comes back.
      await this.endRoundTrip(false, true);
    };

    const text = this.state.lastKnownContent;
    if (text === undefined) {
      await fail('There is no retained copy');
      return;
    }
    if (this.historyPort?.confirmSaveEndpoint(text) !== true) {
      await fail('The retained copy did not pass the save endpoint confirmation');
      return;
    }

    const isOriginal = targetUri === this.documentUri;
    let lineEnding = this.state.lineEnding;
    let sourceBeforeWrite: string | undefined;
    if (isOriginal) {
      const resolution = await this.resolveCurrentSource('save');
      if (resolution.kind !== 'resolved') {
        await this.reportResolutionFailure(resolution, 'saving the retained copy');
        await fail(`Could not resolve the source: ${resolution.kind}`);
        return;
      }
      if (resolution.text !== this.state.syncState.mergeBase) {
        await fail('The source has changed from the merge base');
        return;
      }
      lineEnding = resolution.lineEnding;
      sourceBeforeWrite = resolution.text;
    }

    // Edits that arrived while waiting for the source to resolve have not been checked. Check once more right before
    // writing.
    if (this.state.lastKnownContent !== text || this.historyPort?.confirmSaveEndpoint(text) !== true) {
      await fail('The retained copy or history endpoint changed before the write');
      return;
    }

    if (!(await this.writeDocumentText(targetUri, text, lineEnding, isCancelled))) {
      settle('failed');
      await this.endRoundTrip(false, true);
      return;
    }

    if (sourceBeforeWrite !== undefined) {
      this.retainWrittenBody(text, sourceBeforeWrite);
      this.historyPort?.notifySaveSucceeded(text);
    }
    this.host.reportInternalError(`Saved the retained copy to ${targetUri} because the view is not responding`);
    void this.host.reportUserInformation('backup.savedFromRetainedCopy.message');
    settle('completed');

    if (isOriginal) {
      // Do not update the view's baseline. The view returned no output, so the commit only signals lowering the
      // overlay.
      await this.endRoundTrip(true, false);
      return;
    }
    // When a save to another URI succeeds, VS Code closes the original tab, so close the queue just like a normal
    // Save As.
    await this.endRoundTrip(false, false);
    this.queue.close();
  }

  /**
   * Rereads the source when this operation reaches the front of the queue and passes it to conditional replacement
   * only when it is determined to be an external change.
   *
   * @param trigger Trigger that initiated reconciliation.
   */
  private async reconcileSourceChange(trigger: SourceChangeTrigger): Promise<void> {
    const syncState = this.state.syncState;
    // An uninitialized sync base cannot identify an external change. Watch registration completes before initial
    // reconciliation, so that reconciliation handles notifications received in this state. Remember only that one
    // was missed.
    if (syncState.syncBase === undefined) {
      this.missedSourceChangeNotice = true;
      return;
    }

    const resolution = await this.resolveCurrentSource(trigger);
    // Skipping a dirty buffer is an expected state on this path, not a failure. While a text tab is being edited, each
    // keystroke produces a notification; recording every one would add hundreds of identical lines and bury real
    // failures in the diagnostic log.
    if (resolution.kind === 'dirty') {
      return;
    }
    if (resolution.kind !== 'resolved') {
      await this.reportResolutionFailure(resolution, 'reconciling the source change');
      return;
    }

    // The written full text has already advanced the sync base, so a notification caused by this extension's write
    // stops here. The second notification type for the same change does as well.
    if (resolution.text === syncState.syncBase) {
      return;
    }

    await this.applyExternalChange(resolution.text);
  }

  /**
   * Waits for the buffer to follow the write reconcile, resolves the current clean source, and updates the current
   * line ending.
   *
   * All comparisons use LF-normalized text. Sources differing only in line endings are treated as the same content,
   * and only the detected line ending becomes the current value.
   *
   * @param trigger Trigger that initiated reconciliation.
   * @returns The resolved source or one of the three failures.
   */
  private async resolveCurrentSource(trigger: SourceResolutionTrigger): Promise<SourceResolution> {
    let snapshot: TextBufferSnapshot;
    try {
      snapshot = await this.host.readTextBuffer();
    } catch (error) {
      return { kind: 'unreadable', cause: `Could not read the text buffer: ${String(error)}` };
    }

    // A dirty buffer does not follow the disk. Using it as the source would erase disk-only changes, while using the
    // disk as the source would ignore unsaved buffer edits. Either choice silently overwrites content, so do nothing
    // until the user saves or Reverts the text side and makes it clean.
    if (snapshot.isDirty) {
      return { kind: 'dirty' };
    }

    const followed = await this.followBuffer(trigger, {
      text: normalizeLineEndings(snapshot.text),
      raw: snapshot.text,
    });
    if (followed === undefined) {
      return { kind: 'followTimeout' };
    }
    if ('kind' in followed) {
      return followed;
    }

    return { kind: 'resolved', text: followed.text, lineEnding: this.updateLineEnding(followed.raw) };
  }

  /**
   * Waits for an unreconciled write or for a buffer that has not moved yet to follow the disk.
   *
   * @param trigger Trigger that initiated reconciliation.
   * @param current Buffer content from the initial read.
   * @returns A resolved clean buffer, dirty state detected while waiting, or `undefined` on timeout.
   */
  private async followBuffer(
    trigger: SourceResolutionTrigger,
    current: BufferText,
  ): Promise<BufferFollowOutcome | undefined> {
    const syncState = this.state.syncState;
    const reconcile = syncState.writeReconcile;

    if (reconcile !== undefined) {
      // Determine the remaining time from the write timestamp. Repeated waits across paths never exceed the same limit
      // measured from the original write.
      const remaining = BUFFER_FOLLOW_TIMEOUT_MS - (Date.now() - reconcile.writtenAt);
      const settled = await this.pollBuffer(
        // If the buffer is still at the previous source, the direct write has not reached it. Poll and wait. Either a
        // match or a later external change settles the buffer follow being awaited.
        (text) => text === reconcile.writtenBody || text !== reconcile.previousSource,
        current,
        remaining,
      );

      if (settled === undefined) {
        return undefined;
      }
      if ('kind' in settled) {
        // Dirty state does not settle buffer follow. Clearing the write reconcile here could misidentify a buffer that
        // becomes clean with its pre-write content as an external change, rolling back the preceding save.
        return settled;
      }
      syncState.clearWriteReconcile();
      // The buffer has been confirmed to follow the written full text. As long as that content remains the sync base,
      // polling again for a later second notification will not produce a change.
      this.followedBase = settled.text;
      return settled;
    }

    // For a file change notification, following the disk can be delayed if the buffer had been released. If it remains
    // at the sync base, poll until timeout and treat no movement as no change.
    if (this.takeDeferredFollowNeed(trigger) && current.text === syncState.syncBase) {
      const moved = await this.pollBuffer(
        (text) => text !== syncState.syncBase,
        current,
        BUFFER_FOLLOW_TIMEOUT_MS,
      );
      if (moved !== undefined) {
        return moved;
      }
      this.followedBase = current.text;
    }

    return current;
  }

  /**
   * Determines whether this trigger should poll for delayed buffer follow and consumes a missed notification during
   * initial reconciliation.
   *
   * A buffer whose delayed follow has already been settled against the same sync base will not move when polled again.
   * Initial reconciliation polls only when a notification was missed while the sync base was uninitialized. Polling
   * until timeout without a missed notification would block the operation queue whenever a tab opens.
   *
   * @param trigger Trigger that initiated reconciliation.
   * @returns `true` when the buffer should be polled.
   */
  private takeDeferredFollowNeed(trigger: SourceResolutionTrigger): boolean {
    const missed = this.missedSourceChangeNotice;
    if (trigger === 'initialReconcile') {
      // Consume this only once. Leaving it set would repeat the same wait whenever the view is recreated.
      this.missedSourceChangeNotice = false;
    }

    if (this.followedBase === this.state.syncState.syncBase) {
      return false;
    }
    return trigger === 'fileChange' || (trigger === 'initialReconcile' && missed);
  }

  /**
   * Polls the buffer until the decision is final.
   *
   * The decision uses LF-normalized text, but line-ending detection requires the raw full text. Detecting again from
   * the normalized value would produce a result unrelated to the original spelling.
   *
   * @param isSettled Function that receives LF-normalized text and reports whether the decision is final.
   * @param current Buffer content from the initial read.
   * @param timeoutMs Maximum wait in milliseconds.
   * @returns A resolved clean buffer, dirty state detected while waiting, or `undefined` on timeout.
   */
  private async pollBuffer(
    isSettled: (text: string) => boolean,
    current: BufferText,
    timeoutMs: number,
  ): Promise<BufferFollowOutcome | undefined> {
    // The initial read has already occurred. Reading again here would add a round trip even when no wait is needed.
    if (isSettled(current.text)) {
      return current;
    }

    let raw = current.raw;
    let isDirty = false;
    return pollTextBuffer<BufferFollowOutcome>(
      async () => {
        const snapshot = await this.host.readTextBuffer();
        raw = snapshot.text;
        isDirty = snapshot.isDirty;
        return raw;
      },
      (text) => {
        // The buffer can become dirty after waiting begins. Check this before matching content to avoid accepting
        // unsaved content as the clean current source.
        if (isDirty) {
          return { kind: 'dirty' };
        }
        return isSettled(text) ? { text, raw } : undefined;
      },
      timeoutMs,
    );
  }

  /**
   * Makes the resolved source's line ending the current value.
   *
   * @param rawText Full source text before line-ending normalization.
   * @returns The detected line ending.
   */
  private updateLineEnding(rawText: string): LineEnding {
    const lineEnding = detectLineEnding(rawText);
    this.state.lineEnding = lineEnding;
    return lineEnding;
  }

  /**
   * Passes an external change as a replacement only to a view without unsaved edits.
   *
   * @param text Full document text after the external change (LF).
   */
  private async applyExternalChange(text: string): Promise<void> {
    const syncState = this.state.syncState;
    // While a save retry base exists, the view contains a save candidate not yet written to the file. The
    // replacement-blocked flag is the host's conservative record that the view had unsaved changes. In either case,
    // the current source will be merged by the next save, so do not send a request to the view.
    if (syncState.saveRetryBase !== undefined || syncState.isReplacementBlocked) {
      return;
    }

    const applied = await this.requestDocumentApply({
      kind: DOCUMENT_APPLY_KIND.externalChange,
      text,
    });

    if (applied === DOCUMENT_APPLY_OUTCOME.applied) {
      syncState.completeSync(text);
      this.state.retainUnsavedContent(text);
      await this.endRoundTrip(false, false);
      return;
    }

    syncState.blockReplacement();

    if (applied !== DOCUMENT_APPLY_OUTCOME.rejectedUnsaved) {
      // A rejection due to unsaved edits is a normal path, so it is not handed to protection. Only a failure to
      // apply is handed to the side that stops editing, saving, and history on the old DOM.
      this.historyPort?.reportProtection(
        `The view did not apply the external change: ${applied}`,
        this.state.lastKnownContent,
      );
      await this.host.reportUserError(
        'documentApplyFailed.message',
        `The view did not apply the external change: ${applied}`,
      );
    }

    await this.endRoundTrip(false, false);
  }

  /**
   * Builds a save candidate from the merge base, resolved source, and full view text.
   *
   * @param sourceText Full text of the resolved clean source (LF).
   * @param viewText Full text generated by the view after input was blocked (LF).
   * @returns A save candidate, or `undefined` when the merge base is uninitialized.
   */
  private buildSaveCandidate(sourceText: string, viewText: string): SaveCandidate | undefined {
    const base = this.state.syncState.mergeBase;
    // Do not perform a save-time merge with an uninitialized sync base. Using the source as the common ancestor would
    // hide source changes in the base and treat content that has not been synchronized as synchronized.
    if (base === undefined) {
      return undefined;
    }
    const merged = mergeSaveCandidate(base, sourceText, viewText);
    // The file is written as UTF-8. The declaration is rewritten in the candidate, before it is applied to the view,
    // so that the view, the file, and the sync base keep agreeing on the full text.
    return { ...merged, text: rewriteCharsetDeclaration(merged.text) };
  }

  /**
   * Applies a save candidate to the view before writing it to the file.
   *
   * @param candidate Save candidate.
   * @param sourceBeforeApply Full source text before application (LF).
   * @returns Application outcome determined by the host.
   */
  private async applySaveCandidate(
    candidate: SaveCandidate,
    sourceBeforeApply: string,
  ): Promise<HostApplyResult> {
    const applied = await this.requestDocumentApply({
      kind: DOCUMENT_APPLY_KIND.saveCandidate,
      text: candidate.text,
    });
    if (applied === DOCUMENT_APPLY_OUTCOME.applied) {
      // Retain the applied candidate on the host so it can be passed to initialization if the view is recreated after
      // replacement. Returning to the pre-application output could lose source changes incorporated by the merge on
      // the next save.
      this.state.retainUnsavedContent(candidate.text);
      // Set the common ancestor to use until the write completes. Advancing the sync base here would treat content as
      // synchronized even if the write fails.
      this.state.syncState.beginSaveRetry(sourceBeforeApply);
    }
    return applied;
  }

  /**
   * Checks for cancellation, restores the line endings, and writes to the destination.
   *
   * Cancellation is checked only immediately before the write. Checking after the write has started
   * would be pointless, because there is no way to take back content already written.
   *
   * @param targetUri The string form of the URI to write to.
   * @param text The whole LF-delimited text.
   * @param lineEnding Line ending to restore. Saving to the original URI uses the resolved source's value.
   * @param isCancelled A function returning whether the supplied token has been cancelled.
   * @returns `true` when the write succeeded.
   */
  private async writeDocumentText(
    targetUri: string,
    text: string,
    lineEnding: LineEnding,
    isCancelled: () => boolean,
  ): Promise<boolean> {
    if (isCancelled()) {
      this.host.reportInternalError(`Skipped writing ${targetUri} because the operation was cancelled`);
      return false;
    }

    try {
      await this.host.writeFile(targetUri, restoreLineEndings(text, lineEnding));
      return true;
    } catch (error) {
      // The user sees VS Code's own notification for the failed entry point. The cause can be recorded
      // only here.
      this.host.reportInternalError(`Failed to write ${targetUri}: ${String(error)}`);
      return false;
    }
  }

  /**
   * Retains the write reconcile after a successful write, then advances the sync base to the candidate.
   *
   * Reversing this order would move only the sync base while no write reconcile exists. A change notification arriving
   * in that interval could not distinguish this extension's write from an external change.
   *
   * @param writtenBody Full document text that was written (LF).
   * @param previousSource Full source text immediately before the write (LF).
   */
  private retainWrittenBody(writtenBody: string, previousSource: string): void {
    const syncState = this.state.syncState;
    syncState.retainWriteReconcile(writtenBody, previousSource);
    syncState.completeSync(writtenBody);
  }

  /**
   * Requests full-document application and waits until the outcome for the request id is final.
   *
   * A response timeout is not treated as a failure because a timeout cannot determine whether application occurred
   * when only the response was lost. Retrying with the same request id and full text makes the view return its retained
   * outcome without applying again.
   *
   * @param request Application kind and full text, plus target endpoint and edit range only for a history application.
   * @returns Application outcome determined by the host.
   */
  private async requestDocumentApply(request: DocumentApplyRequest): Promise<HostApplyResult> {
    if (this.disposed) {
      return 'notApplied';
    }

    const requestId = this.pending.issueRequestId();
    let abandon = (): void => undefined;
    const abandoned = new Promise<'notApplied'>((resolve) => {
      abandon = () => resolve('notApplied');
    });
    this.applyInFlight = { requestId, abandon };

    try {
      for (;;) {
        const outcome = await Promise.race([
          this.pending.sendWithId<DocumentReplacedMessage>(
            requestId,
            VIEW_TO_HOST_MESSAGE_TYPE.documentReplaced,
            (id) => {
              void this.postToView(buildReplaceDocumentMessage(id, request));
            },
            DOCUMENT_REPLACE_TIMEOUT_MS,
          ),
          abandoned,
        ]);

        if (outcome === 'notApplied') {
          return 'notApplied';
        }
        if (outcome.ok) {
          return readApplyOutcome(outcome.response);
        }
        if (outcome.failure !== 'timeout') {
          // This outcome occurs only when the view is disposed. Retrying would have no recipient.
          return 'notApplied';
        }
      }
    } finally {
      this.applyInFlight = undefined;
    }
  }

  /**
   * Sends exactly one save committed or save released message at the end of an operation that raised the overlay.
   *
   * Without that signal the view never lowers its overlay. Unless this send is paired with the side
   * that raised the overlay, lowering it would be left to the panel being disposed. External-change and Revert
   * application also raise the overlay in the view, so send exactly one message for those paths as well.
   *
   * @param committed `true` to send a save committed message, `false` to send a save released message.
   * A save as to a different URI sends no save committed message even on success, so the caller decides
   * which to send rather than deriving it from the outcome.
   * @param resendUnsavedContent Whether to put a resend instruction on the save released message.
   */
  private async endRoundTrip(committed: boolean, resendUnsavedContent: boolean): Promise<void> {
    await this.postToView(
      committed
        ? { type: HOST_TO_VIEW_MESSAGE_TYPE.saveCommitted }
        : { type: HOST_TO_VIEW_MESSAGE_TYPE.saveReleased, resendUnsavedContent },
    );
  }

  /**
   * Carries out the revert steps.
   *
   * @param isCancelled A function returning whether the supplied token has been cancelled.
   * @returns Whether it completed or failed.
   */
  private async runRevert(isCancelled: () => boolean): Promise<RevertOutcome> {
    const resolution = await this.resolveCurrentSource('revert');
    if (resolution.kind !== 'resolved') {
      if (resolution.kind === 'followTimeout') {
        // Keep the write reconcile. Clearing it here would reread the previous content instead of a buffer that catches
        // up later and would roll back the most recent save.
        await this.host.reportUserError(
          'bufferFollowTimeout.message',
          'The text buffer did not catch up with the last write in time',
        );
        this.historyPort?.notifyRevertResult(false, this.state.lastKnownContent);
        return 'failed';
      }
      return this.failRevert(
        resolution.kind === 'dirty'
          ? 'Skipped reverting because the text buffer has unsaved edits'
          : resolution.cause,
      );
    }

    if (isCancelled()) {
      return this.failRevert('Skipped replacing the view because the revert was cancelled');
    }

    const applied = await this.requestDocumentApply({
      kind: DOCUMENT_APPLY_KIND.revert,
      text: resolution.text,
    });
    if (applied !== DOCUMENT_APPLY_OUTCOME.applied) {
      // If the coordinator is already disposed when the result arrives, closing the tab abandoned the apply. The
      // view is already gone, so neither a failure notification nor a report to the history side means anything.
      // Not applied because of a view reload does not dispose the coordinator, so it stays a failure.
      if (this.disposed) {
        return 'abandoned';
      }
      return this.failRevert(`The view did not apply the revert: ${applied}`);
    }

    // Notices after the ack are edits to the new tree. From here on they are deferred and fired again.
    this.revertPhase = 'settling';

    // Keeping the last known content would put it on the initialize message when the view is recreated,
    // bringing back edits that were supposed to have been reverted, and without the dirty mark.
    this.state.clearUnsavedContent();
    this.state.syncState.completeRevert(resolution.text);
    this.historyPort?.notifyRevertResult(true, resolution.text);
    await this.endRoundTrip(false, false);
    return 'completed';
  }

  /**
   * Builds a history transition failure with the actual old full text attached.
   *
   * @param reason Cause.
   * @returns Failure result.
   */
  private failHistoryApply(reason: string): HistoryApplyResult {
    return { kind: 'failed', reason, liveText: this.state.lastKnownContent };
  }

  /**
   * Runs the history transition procedure.
   *
   * @param direction Direction of the history transition.
   * @param recorded Recorded before and after endpoints.
   * @param settle Called once the result is determined.
   */
  private async runHistoryApply(
    direction: HistoryDirection,
    recorded: RecordedEndpoints,
    settle: (result: HistoryApplyResult) => void,
  ): Promise<void> {
    // The output request stops input in the view. This keeps an edit made mid-application from belonging to
    // neither endpoint.
    const output = await this.requestBodyOutput();
    if (output.kind !== 'text') {
      settle(this.failHistoryApply('The view did not return its current content'));
      return;
    }
    const viewText = output.text;

    const resolution = await this.resolveCurrentSource('save');
    if (resolution.kind !== 'resolved') {
      settle(this.failHistoryApply(
        `Could not resolve the current source while applying history: ${resolution.kind}`,
      ));
      return;
    }

    const decision = decideHistoryTransition({
      recordedBefore: recorded.before.text,
      recordedAfter: recorded.after.text,
      currentView: viewText,
      syncBase: this.state.syncState.syncBase,
      currentSource: resolution.text,
      direction,
    });
    if (decision.kind === 'rejected') {
      settle(this.failHistoryApply(`The history transition was rejected: ${decision.reason}`));
      return;
    }

    const target = direction === HISTORY_DIRECTION.undo ? recorded.before : recorded.after;
    const applied = await this.requestDocumentApply({
      kind: DOCUMENT_APPLY_KIND.editHistory,
      text: decision.text,
      history: {
        targetText: target.text,
        targetSelection: target.selection,
        editRange: decision.editRange,
      },
    });
    if (applied !== DOCUMENT_APPLY_OUTCOME.applied) {
      settle(this.failHistoryApply(`The view did not apply the history transition: ${applied}`));
      return;
    }

    // The applied full text becomes the last known content as is. No separate change event is fired.
    this.state.retainUnsavedContent(decision.text);
    settle({ kind: 'applied', text: decision.text });
    await this.endRoundTrip(false, false);
  }

  /**
   * Notifies the user that the current source could not be resolved.
   *
   * @param resolution Failed source-resolution result.
   * @param during Phrase identifying the failed operation in the diagnostic log.
   */
  private async reportResolutionFailure(
    resolution: SourceResolution,
    during: string,
  ): Promise<void> {
    if (resolution.kind === 'dirty') {
      // Only Save reaches this branch with dirty state. The user sees only VS Code's generic save failure, making this
      // line the sole record of the reason. Adding a notification would repeat it on every automatic save while the
      // text is being edited.
      this.host.reportInternalError(`Skipped ${during} because the text buffer has unsaved edits`);
      return;
    }
    if (resolution.kind === 'unreadable') {
      await this.host.reportUserError('syncFailed.message', `${resolution.cause} while ${during}`);
      return;
    }
    if (resolution.kind === 'followTimeout') {
      await this.host.reportUserError(
        'bufferFollowTimeout.message',
        `The text buffer did not catch up with the last write in time while ${during}`,
      );
    }
  }

  /**
   * Notifies the user that the revert failed and hands the failure to the history side.
   *
   * @param cause One line describing the cause, recorded in the diagnostic log.
   * @returns The failure outcome.
   */
  private failRevert(cause: string): SaveOutcome {
    void this.host.reportUserError('revertFailed.message', cause);
    this.historyPort?.notifyRevertResult(false, this.state.lastKnownContent);
    return 'failed';
  }

  /** Ends the revert phase and fires any deferred notice. */
  private finishRevert(): void {
    this.revertPhase = 'none';
    if (!this.deferredChangeNotice) {
      return;
    }
    this.deferredChangeNotice = false;
    this.fireHistorylessChangeNotice();
  }

  /** Decides, from the revert phase, whether to fire, defer, or drop the change event. */
  private fireOrDeferChangeNotice(): void {
    if (this.historyPort?.isHistoryEventDriven() === true) {
      // In a build whose dirty mark is driven by edit events, the history side has already registered the history
      // entry for this notice. Firing a plain change event here would mix two forms in one provider. Deferral is
      // also owned by the history side.
      return;
    }
    if (this.revertPhase === 'replacing') {
      return;
    }
    if (this.revertPhase === 'settling') {
      this.deferredChangeNotice = true;
      return;
    }
    this.host.notifyDocumentChanged();
  }

  /**
   * Fires a change event without history.
   *
   * Not fired in a build whose dirty mark is driven by edit events, because VS Code does not allow one provider
   * to mix the two forms.
   */
  private fireHistorylessChangeNotice(): void {
    if (this.historyPort?.isHistoryEventDriven() === true) {
      return;
    }
    this.host.notifyDocumentChanged();
  }

  /**
   * Sends to the view, confining a failed send to the diagnostic log.
   *
   * Reflecting a failed send in the entry point's outcome would not change what the user can do.
   *
   * @param message The message to send.
   */
  private async postToView(message: HostToViewMessage): Promise<void> {
    try {
      await this.host.postToView(message);
    } catch (error) {
      this.host.reportInternalError(`Failed to send ${message.type} to the view: ${String(error)}`);
    }
  }
}

/**
 * Builds the full-document application request message.
 *
 * @param requestId Request id.
 * @param request Application kind and full text, plus target endpoint and edit range for a history application.
 * @returns Replace document message to send to the view.
 */
function buildReplaceDocumentMessage(
  requestId: RequestId,
  request: DocumentApplyRequest,
): HostToViewMessage {
  if (request.kind === DOCUMENT_APPLY_KIND.editHistory) {
    return {
      type: HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument,
      requestId,
      text: request.text,
      kind: request.kind,
      ...request.history,
    };
  }
  return {
    type: HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument,
    requestId,
    text: request.text,
    kind: request.kind,
  };
}

/**
 * Reads the application outcome carried by a response.
 *
 * The type has three values, but at runtime the view can send any value. Treating an out-of-contract value as applied
 * would create a path that overwrites the file with content not delivered to the view.
 *
 * @param response Replacement response.
 * @returns The contract-compliant application outcome, or application failure for an out-of-contract value.
 */
function readApplyOutcome(response: DocumentReplacedMessage): DocumentApplyOutcome {
  const outcome: unknown = response.outcome;
  return outcome === DOCUMENT_APPLY_OUTCOME.applied
    || outcome === DOCUMENT_APPLY_OUTCOME.rejectedUnsaved
    ? outcome
    : DOCUMENT_APPLY_OUTCOME.failed;
}
