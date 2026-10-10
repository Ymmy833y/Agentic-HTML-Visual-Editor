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
  ConflictChoice,
  ConflictRegion,
  ConflictSides,
  DocumentApplyKind,
  DocumentApplyOutcome,
  DocumentReplacedMessage,
  HistoryDirection,
  HostToViewMessage,
  LineEnding,
  MergeRegion,
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
import { flattenSaveCandidate, mergeSaveRegions, mergeViewSide } from './save-merge';

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
   * The returned promise rejects for a file whose bytes are not UTF-8. Reading such a file with replacement
   * characters would put them into the view in place of the original characters.
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

  /**
   * Tells the user that the text editor of this file holds unsaved edits, so the view was not saved, and offers to
   * save the text editor first.
   *
   * The returned promise settles when the notification closes and, if the offer was taken, when the saves it started
   * have ended. While it is pending the coordinator raises no second notification: auto save repeats the failed save
   * on every change event, and every retry fails for the same reason until the text editor is saved.
   *
   * @param cause One line describing the cause, recorded in the diagnostic log.
   */
  reportDirtyTextBuffer(cause: string): Promise<void>;

  /**
   * Tells the user, when the view's tab is not visible, that a save waits for them to choose in it, and offers to bring
   * the tab forward.
   *
   * A save can start while the tab is behind another one (Save All, auto save, closing the window), and the user cannot
   * answer a conflict they cannot see. The tab is not brought forward unasked: an auto save on focus change starts as
   * the user moves to another tab, and pulling them back would keep them from ever leaving.
   *
   * The returned promise settles at once when the view is visible, and otherwise when the notification closes, after
   * the tab was asked to come forward if the user chose to. Nothing waits for it.
   */
  reportConflictsWaiting(): Promise<void>;
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
   * Registers what the user chose in the conflict overlay as one settled history entry, after the chosen candidate
   * was applied to the view.
   *
   * Without it the view holds content that no history entry ends at, so undo merges against the wrong endpoint and
   * redo reaches the save point with content that differs from the file.
   *
   * @param viewSideText Full text with the view side kept in every conflict region: where undo returns to.
   * @param chosenText Full text of the applied candidate: where redo returns to.
   * @returns Whether it was registered. False while protected, when writing would put content into the file that
   *   undo cannot take back.
   */
  registerConflictChoiceEntry(viewSideText: string, chosenText: string): boolean;

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
 * A cancellation of the save by VS Code joins the existing path as one kind of failure, which avoids adding another
 * recovery mechanism. Canceled is only the user's cancel in the conflict overlay: the user already knows the file was
 * not saved, and reporting it as a failure would offer Revert, which discards the edits.
 */
export type SaveOutcome = 'completed' | 'failed' | 'canceled';

/**
 * The outcome of a Revert.
 *
 * Abandoned is kept apart from failed because, on Don't Save when closing a tab, VS Code closes the tab without
 * waiting for the Revert to finish. Only a failure with the view still present is treated as a failure, and the
 * backup is kept.
 */
export type RevertOutcome = 'completed' | 'failed' | 'abandoned';

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

/**
 * What the view sent back for a presentation of conflicts, after the message handler checked its shape.
 *
 * Invalid carries the presentation id only when it could be read.
 */
export type ReceivedConflictsResolved =
  | {
    readonly kind: 'chosen';
    readonly presentationId: number;
    /** The choice for each conflict region, in document order. */
    readonly choices: readonly ConflictChoice[];
  }
  | { readonly kind: 'canceled'; readonly presentationId: number }
  | { readonly kind: 'invalid'; readonly presentationId: number | undefined; readonly detail: string };

/** How the wait for the user's choice ended. */
type ConflictWaitOutcome =
  | { readonly kind: 'chosen'; readonly choices: readonly ConflictChoice[] }
  | { readonly kind: 'canceled' }
  // The view sent a choice outside the contract, or one that does not fit the presented regions.
  | { readonly kind: 'invalid'; readonly detail: string }
  // The view was reloaded or disposed, or the presentation could not be sent.
  | { readonly kind: 'abandoned'; readonly detail: string };

/** A presentation of conflicts waiting for the user's choice. */
interface ConflictWait {
  readonly presentationId: number;
  /** The number of conflict regions presented. A choice must have exactly this many entries. */
  readonly conflictCount: number;
  readonly settle: (outcome: ConflictWaitOutcome) => void;
}

/**
 * The full text a save goes on to apply and write, or the outcome that ends the save before applying.
 *
 * The source is the one the candidate was merged against last. While the user chooses, the file can change and the
 * source is resolved again, so the source resolved at the start of the save no longer describes the candidate.
 */
type CandidateDecision =
  | {
    readonly kind: 'decided';
    /** Full document text to apply and write (LF). */
    readonly text: string;
    /** Full text of the source the candidate was merged against (LF). */
    readonly sourceText: string;
    /** Line ending detected from that source. */
    readonly lineEnding: LineEnding;
    /** Whether the user chose a side for at least one conflict region. */
    readonly presented: boolean;
    /**
     * Full text with the view side kept in every conflict region, merged against the same source (LF). Equal to the
     * text when nothing was presented or the user kept the visual editor's version everywhere.
     */
    readonly viewSideText: string;
  }
  | {
    readonly kind: 'stopped';
    readonly outcome: 'failed' | 'canceled';
    /**
     * The source resolution that failed after the user chose, when that is why the save stops. The save reports it
     * only after settling, because the notification settles only when the user closes it.
     */
    readonly failedResolution?: Exclude<SourceResolution, { readonly kind: 'resolved' }>;
  };

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

  private conflictWait: ConflictWait | undefined;

  // Presentation ids only grow, so a choice that arrives for an earlier presentation of conflicts is told apart.
  private nextPresentationId = 1;

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

  // The dirty text buffer notification still open for this document, or `undefined` when none is. Auto save repeats
  // the failed save on every change event, so without this one notification would pile up per retry.
  private dirtyTextBufferNotice: Promise<void> | undefined;

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
   * @returns Whether it completed, failed, or was canceled by the user in the conflict overlay.
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

      const candidate = await this.buildSaveCandidate(resolution.text, resolution.lineEnding, viewText);
      if (candidate.kind === 'stopped') {
        // The file, the sync state and the view's edits are all unchanged.
        settle(candidate.outcome);
        if (candidate.failedResolution !== undefined) {
          await this.reportResolutionFailure(candidate.failedResolution, 'saving');
        }
        await this.endRoundTrip(false, false);
        return;
      }

      const applied = await this.applySaveCandidate(candidate.text, candidate.sourceText);
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

      // Registered before the write: VS Code takes the save point when the save returns, so an entry fired earlier is
      // at the save point once the write succeeds, and the view already holds the candidate even if the write fails.
      if (
        candidate.viewSideText !== candidate.text
        && this.historyPort?.registerConflictChoiceEntry(candidate.viewSideText, candidate.text) === false
      ) {
        this.host.reportInternalError('Skipped writing the chosen content because the history did not take it');
        settle('failed');
        await this.endRoundTrip(false, false);
        return;
      }

      const written = await this.writeDocumentText(
        this.documentUri,
        candidate.text,
        candidate.lineEnding,
        // Once the user has chosen, the candidate is the newest content. A later save cancels this one's token, and
        // dropping the choice there would make the user choose again, while the later save writes the same content.
        candidate.presented ? () => false : isCancelled,
      );
      if (!written) {
        // Leave the sync base and write reconcile unchanged. The view containing the candidate and the save retry base
        // remain, so the next save retries from that common ancestor.
        settle('failed');
        await this.endRoundTrip(false, false);
        return;
      }

      this.retainWrittenBody(candidate.text, candidate.sourceText);
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
   * @returns Whether it completed, failed, or was canceled by the user in the conflict overlay.
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
   * Re-reads the text buffer and replaces the view's tree with its content. When the text buffer holds unsaved edits,
   * reads the file on disk instead and does not wait for the buffer to follow.
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
    // The reloaded view no longer shows the conflicts, so nobody is left to choose.
    this.conflictWait?.settle({ kind: 'abandoned', detail: 'the view was reloaded while waiting for a conflict choice' });
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
    this.conflictWait?.settle({ kind: 'abandoned', detail: 'the view was closed while waiting for a conflict choice' });
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
      // A write empties the file before writing the content, so a buffer reloaded in between holds only the start of the
      // written full text. Settling on it would hand a partial document to the view as an external change.
      const isMidWrite = (text: string): boolean => text !== reconcile.previousSource
        && text.length < reconcile.writtenBody.length
        && reconcile.writtenBody.startsWith(text);
      const settled = await this.pollBuffer(
        // If the buffer is still at the previous source or in the middle of the write, the direct write has not reached
        // it. Poll and wait. Either a match or a later external change settles the buffer follow being awaited.
        (text) => text === reconcile.writtenBody || (text !== reconcile.previousSource && !isMidWrite(text)),
        current,
        remaining,
        // Past the deadline a mid-write source cannot be told apart from a truncation made outside, so it is taken
        // as a later external change, like any other content that differs from both texts.
        isMidWrite,
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
   * @param isSettledAtTimeout Function that receives the last clean LF-normalized text read before the timeout and
   * reports whether it is final after all.
   * @returns A resolved clean buffer, dirty state detected while waiting, the last read accepted by
   * `isSettledAtTimeout`, or `undefined` on timeout.
   */
  private async pollBuffer(
    isSettled: (text: string) => boolean,
    current: BufferText,
    timeoutMs: number,
    isSettledAtTimeout: (text: string) => boolean = () => false,
  ): Promise<BufferFollowOutcome | undefined> {
    // The initial read has already occurred. Reading again here would add a round trip even when no wait is needed.
    if (isSettled(current.text)) {
      return current;
    }

    let raw = current.raw;
    let isDirty = false;
    let last: BufferText = current;
    let readFailed = false;
    const outcome = await pollTextBuffer<BufferFollowOutcome>(
      async () => {
        let snapshot: TextBufferSnapshot;
        try {
          snapshot = await this.host.readTextBuffer();
        } catch (error) {
          // A failed read also ends the wait early. Only a wait that ran to its deadline settles at the timeout.
          readFailed = true;
          throw error;
        }
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
        last = { text, raw };
        return isSettled(text) ? last : undefined;
      },
      timeoutMs,
    );
    if (outcome === undefined && !readFailed && isSettledAtTimeout(last.text)) {
      return last;
    }
    return outcome;
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
   * Builds a save candidate from the merge base, resolved source, and full view text, asking the user to choose a side
   * for each conflict region.
   *
   * While the user chooses, the file can change. The source is therefore resolved again after every choice, and a
   * changed source is merged once more with the source the user saw as the common ancestor and the chosen result as the
   * view side. That keeps both the user's choice and the newer change on disk.
   *
   * @param sourceText Full text of the resolved clean source (LF).
   * @param lineEnding Line ending detected from that source.
   * @param viewText Full text generated by the view after input was blocked (LF).
   * @returns The candidate to apply and write, or the outcome that ends the save.
   */
  private async buildSaveCandidate(
    sourceText: string,
    lineEnding: LineEnding,
    viewText: string,
  ): Promise<CandidateDecision> {
    const base = this.state.syncState.mergeBase;
    // Do not perform a save-time merge with an uninitialized sync base. Using the source as the common ancestor would
    // hide source changes in the base and treat content that has not been synchronized as synchronized.
    if (base === undefined) {
      // If the view mounted, the sync base is initialized, so a save that received output cannot reach this branch.
      // This is not actionable by the user; record it and fail the save.
      this.host.reportInternalError('Skipped merging because the sync base is not initialized');
      return { kind: 'stopped', outcome: 'failed' };
    }

    let ancestor = base;
    let source = { text: sourceText, lineEnding };
    let viewSide = viewText;
    let presented = false;
    for (;;) {
      const merged = mergeSaveRegions(ancestor, source.text, viewSide);
      let candidateText: string;
      if (merged.hasConflict) {
        const chosen = await this.presentConflicts(merged.regions, presented);
        if (chosen.kind !== 'chosen') {
          return this.stopForConflictOutcome(chosen);
        }
        presented = true;
        candidateText = flattenSaveCandidate(merged.regions, chosen.choices);
      } else {
        candidateText = flattenSaveCandidate(merged.regions, []);
      }

      if (presented) {
        const recheck = await this.resolveCurrentSource('save');
        if (recheck.kind !== 'resolved') {
          // The choice is lost here, as on any other failed save; the notification tells the user what to do first.
          return { kind: 'stopped', outcome: 'failed', failedResolution: recheck };
        }
        if (recheck.text !== source.text) {
          ancestor = source.text;
          viewSide = candidateText;
          source = { text: recheck.text, lineEnding: recheck.lineEnding };
          continue;
        }
        source = { text: recheck.text, lineEnding: recheck.lineEnding };
      }

      // The file is written as UTF-8. The declaration is rewritten in the final candidate, before it is applied to
      // the view, so that the view, the file, and the sync base keep agreeing on the full text.
      const text = rewriteCharsetDeclaration(candidateText);
      return {
        kind: 'decided',
        text,
        sourceText: source.text,
        lineEnding: source.lineEnding,
        presented,
        // Built from the view output rather than from the last round's regions: after a presentation again, those
        // regions already hold the earlier choice, and undo would keep it. The declaration is rewritten here too, so
        // that undoing a choice does not also take back the declaration.
        viewSideText: presented ? rewriteCharsetDeclaration(mergeViewSide(base, source.text, viewText)) : text,
      };
    }
  }

  /**
   * Shows the conflict regions in the view and waits until the user chooses, cancels, or the view goes away.
   *
   * The wait has no deadline: the user may take as long as they need to read both sides, and a deadline would only fill
   * the diagnostic log. A reload or disposal of the view releases it. A tab that is not visible stays where it is, and
   * the user is told that the save waits for them.
   *
   * @param regions Merge regions containing at least one conflict region.
   * @param repeated Whether the user already chose for an earlier presentation of this save.
   * @returns How the wait ended.
   */
  private async presentConflicts(
    regions: readonly MergeRegion[],
    repeated: boolean,
  ): Promise<ConflictWaitOutcome> {
    if (this.disposed) {
      return { kind: 'abandoned', detail: 'the document was closed before the conflicts were presented' };
    }

    const conflicts: ConflictSides[] = regions
      .filter((region): region is ConflictRegion => region.kind === 'conflict')
      .map((region) => ({ source: region.source, view: region.view }));
    const presentationId = this.nextPresentationId;
    this.nextPresentationId += 1;

    const outcome = new Promise<ConflictWaitOutcome>((resolve) => {
      this.conflictWait = {
        presentationId,
        conflictCount: conflicts.length,
        settle: (settled) => {
          this.conflictWait = undefined;
          resolve(settled);
        },
      };
    });

    try {
      await this.host.postToView({
        type: HOST_TO_VIEW_MESSAGE_TYPE.presentConflicts,
        presentationId,
        conflicts,
        repeated,
      });
    } catch (error) {
      // Nothing would ever answer a presentation that did not arrive, so the wait ends at once.
      this.conflictWait?.settle({ kind: 'abandoned', detail: `the conflicts could not be presented: ${String(error)}` });
      return outcome;
    }

    this.notifyConflictsWaiting();
    return outcome;
  }

  /**
   * Tells the user that the save waits for their choice, without waiting for the notice to close.
   *
   * It runs on every presentation: a notice from an earlier one may have gone from view while the user chose without
   * it, and VS Code replaces an earlier notification with the same text instead of adding a second one.
   */
  private notifyConflictsWaiting(): void {
    this.host.reportConflictsWaiting().catch((error: unknown) => {
      // The user can still answer once they open the tab, so the save goes on waiting.
      this.host.reportInternalError(`Could not tell the user that a save waits for a conflict choice: ${String(error)}`);
    });
  }

  /**
   * Turns a wait for the user's choice that did not end with a choice into the outcome of the save.
   *
   * @param outcome How the wait ended.
   * @returns The stopped decision.
   */
  private stopForConflictOutcome(
    outcome: Exclude<ConflictWaitOutcome, { readonly kind: 'chosen' }>,
  ): CandidateDecision {
    if (outcome.kind === 'canceled') {
      return { kind: 'stopped', outcome: 'canceled' };
    }
    this.host.reportInternalError(`Skipped the save because ${outcome.detail}`);
    return { kind: 'stopped', outcome: 'failed' };
  }

  /**
   * Receives what the user chose in the conflict overlay.
   *
   * A choice for an earlier presentation is dropped and the wait goes on, because the regions it answered have been
   * merged again since.
   *
   * @param received The choices, cancel, or invalid message, as checked by the message handler.
   */
  receiveConflictsResolved(received: ReceivedConflictsResolved): void {
    const wait = this.conflictWait;
    if (wait === undefined) {
      this.host.reportInternalError(
        `Discarded a conflict choice that no save is waiting for: presentation ${String(received.presentationId)}`,
      );
      return;
    }
    if (received.presentationId !== undefined && received.presentationId !== wait.presentationId) {
      this.host.reportInternalError(
        `Discarded a conflict choice for presentation ${received.presentationId} while waiting for presentation ${wait.presentationId}`,
      );
      return;
    }

    if (received.kind === 'invalid') {
      wait.settle({ kind: 'invalid', detail: `the view sent a conflict choice outside the contract: ${received.detail}` });
      return;
    }
    if (received.kind === 'canceled') {
      wait.settle({ kind: 'canceled' });
      return;
    }
    if (received.choices.length !== wait.conflictCount) {
      wait.settle({
        kind: 'invalid',
        detail: `the view sent ${received.choices.length} conflict choices for ${wait.conflictCount} conflict regions`,
      });
      return;
    }
    wait.settle({ kind: 'chosen', choices: received.choices });
  }

  /**
   * Applies a save candidate to the view before writing it to the file.
   *
   * @param candidateText Full document text of the save candidate (LF).
   * @param sourceBeforeApply Full source text before application (LF).
   * @returns Application outcome determined by the host.
   */
  private async applySaveCandidate(
    candidateText: string,
    sourceBeforeApply: string,
  ): Promise<HostApplyResult> {
    const applied = await this.requestDocumentApply({
      kind: DOCUMENT_APPLY_KIND.saveCandidate,
      text: candidateText,
    });
    if (applied === DOCUMENT_APPLY_OUTCOME.applied) {
      // Retain the applied candidate on the host so it can be passed to initialization if the view is recreated after
      // replacement. Returning to the pre-application output could lose source changes incorporated by the merge on
      // the next save.
      this.state.retainUnsavedContent(candidateText);
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
    let resolution = await this.resolveCurrentSource('revert');
    if (resolution.kind === 'dirty') {
      // A revert returns the view to the file, and the file is on the disk whether or not the text buffer holds
      // unsaved edits. Those edits stay in the text editor and reach the view as an external change once saved.
      resolution = await this.readSourceFromDisk();
    }
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
      return this.failRevert(resolution.cause);
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
   * Reads the file on disk for Revert or history application while the text buffer holds unsaved edits.
   *
   * The disk already holds the last write, so no wait for the buffer to follow it is needed.
   *
   * @returns The resolved disk content, or an unreadable failure when the file cannot be read as UTF-8.
   */
  private async readSourceFromDisk(): Promise<Extract<SourceResolution, { kind: 'resolved' | 'unreadable' }>> {
    let raw: string;
    try {
      raw = await this.host.readFile(this.documentUri);
    } catch (error) {
      return { kind: 'unreadable', cause: `Could not read the file on disk: ${String(error)}` };
    }
    return { kind: 'resolved', text: normalizeLineEndings(raw), lineEnding: this.updateLineEnding(raw) };
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

    let resolution = await this.resolveCurrentSource('save');
    if (resolution.kind === 'dirty') {
      // History changes only the view. Reading the disk leaves unsaved text buffer edits in their own editor.
      resolution = await this.readSourceFromDisk();
    }
    if (resolution.kind !== 'resolved') {
      const reason = resolution.kind === 'unreadable' ? resolution.cause : resolution.kind;
      settle(this.failHistoryApply(
        `Could not resolve the current source while applying history: ${reason}`,
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
      // Only Save reaches this branch with dirty state. VS Code shows just its generic save failure, so the reason
      // and the way out are told here.
      this.notifyDirtyTextBuffer(`Skipped ${during} because the text buffer has unsaved edits`);
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
   * Raises the dirty text buffer notification unless one is still open for this document.
   *
   * The notification is not awaited: it settles only when the user closes it, and the save has already failed.
   *
   * @param cause One line describing the cause. It reaches the diagnostic log whether or not a notification is raised.
   */
  private notifyDirtyTextBuffer(cause: string): void {
    if (this.dirtyTextBufferNotice !== undefined) {
      // The open notification already tells the user what to do, but each failed retry still leaves its trace.
      this.host.reportInternalError(cause);
      return;
    }

    this.dirtyTextBufferNotice = this.host.reportDirtyTextBuffer(cause)
      .catch((error: unknown) => {
        this.host.reportInternalError(`Could not report the dirty text buffer: ${String(error)}`);
      })
      .finally(() => {
        // No second notification is raised while one is open, so the one that closed is the one recorded here.
        this.dirtyTextBufferNotice = undefined;
      });
  }

  /**
   * Notifies the user that the revert failed and hands the failure to the history side.
   *
   * @param cause One line describing the cause, recorded in the diagnostic log.
   * @returns The failure outcome.
   */
  private failRevert(cause: string): RevertOutcome {
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
