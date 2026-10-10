import { DOCUMENT_APPLY_KIND, DOCUMENT_APPLY_OUTCOME } from '../../common/index';
import type { DocumentApplyKind, DocumentApplyOutcome, RequestId } from '../../common/index';
import type { EncodedSelection, LineRange } from '../../common/index';
import type { SaveRoundTripOutput } from './save-round-trip';
import { INPUT_STOP_REASON } from '../ui/input-stop';
import { BLANK_OVERLAY_CONTENT } from '../ui/overlay-presenter';
import type { OverlayPresenter } from '../ui/overlay-presenter';
import type { DocumentApplyPreparation } from '../history/edit-transaction-controller';
import type { HistorySelectionInput } from '../history/history-selection-remap';

/** Recorded target endpoint and edit location, present only for a history application. */
export interface HistoryApplyTarget {
  /** Full document text of the target endpoint (LF). */
  readonly targetText: string;
  /** Selection on the target endpoint's body, or `null` if it could not be captured. */
  readonly targetSelection: EncodedSelection | null;
  /** Line range of the recorded edit, relative to the target endpoint's full document text. */
  readonly editRange: LineRange;
}

/**
 * Ports received by document apply.
 *
 * Replacement recreates the view state, so ports are functions rather than values and are read on every call.
 */
export interface DocumentApplyPorts {
  /**
   * The overlay presenter. The editor root belongs to it and to the input stop controller, so it is
   * never touched directly.
   */
  readonly overlay: OverlayPresenter;

  /** Reads the most recently returned output, or `undefined` outside a round trip. */
  readLastOutput(): SaveRoundTripOutput | undefined;

  /**
   * Replaces the three baselines.
   *
   * @param writtenBody Body that will be written.
   * @param current Current form from which that output was produced.
   */
  commitSerialization(writtenBody: string, current: string): void;

  /** Delivers, rejects, or isolates the old edit history according to the apply kind. */
  prepareDocumentApply(kind: DocumentApplyKind): Promise<DocumentApplyPreparation>;

  /** Reports whether the view has been edited since the sync base. */
  hasUncommittedEdits(): boolean;

  /**
   * Replaces the tree while preserving the selection.
   *
   * @param text New full document text.
   * @returns Whether the replacement was applied.
   */
  replaceDocument(text: string): boolean;

  /**
   * Remaps the recorded selection onto coordinates of the body of the candidate being applied.
   *
   * @param input Target endpoint full text and selection, candidate full text, and edit range.
   * @returns Selection on the candidate body, or `undefined` when it cannot be remapped.
   */
  remapHistorySelection(input: HistorySelectionInput): EncodedSelection | undefined;

  /** Replaces the tree using the selection stored in edit history. */
  replaceDocumentFromHistory(text: string, selection: EncodedSelection | null): boolean;
}

/** Processed request id and the application outcome determined for it. */
interface HandledRequest {
  readonly requestId: RequestId;
  readonly outcome: Promise<DocumentApplyOutcome>;
}

/**
 * Handles full-document application in the view.
 *
 * There is one instance per view, and replacement does not recreate it. It retains only the last processed request id
 * and outcome until another request id is processed or the view is disposed or reloaded. If only the response is lost
 * and the host retries the same request id, this allows the same outcome to be returned without applying it again.
 */
export class DocumentApply {
  private handled: HandledRequest | undefined;

  /**
   * @param ports Ports used by document apply.
   */
  constructor(private readonly ports: DocumentApplyPorts) {}

  /**
   * Handles one full-document application request.
   *
   * Raises the overlay before applying. The host lowers it with a release, so this method does not lower it.
   * Nothing is stopped again after applying: even though the replacement makes the editor root
   * editable again, the input stop controller stops it once more on the completed mount. The
   * outcome is retained before sending the response, allowing a retry to receive the retained
   * outcome even if sending the response fails.
   *
   * @param requestId Request id.
   * @param kind Application kind.
   * @param text Full document text to apply.
   * @param history Recorded target endpoint and edit location, present only for a history application.
   * @returns Application outcome.
   */
  handleRequest(
    requestId: RequestId,
    kind: DocumentApplyKind,
    text: string,
    history?: HistoryApplyTarget,
  ): Promise<DocumentApplyOutcome> {
    const handled = this.handled;
    if (handled !== undefined && handled.requestId === requestId) {
      return handled.outcome;
    }

    // A save raises the overlay when requesting output. Adding the same reason twice does nothing.
    this.ports.overlay.present(INPUT_STOP_REASON.saveRoundTrip, BLANK_OVERLAY_CONTENT);

    const outcome = this.applyByKind(kind, text, history);
    this.handled = { requestId, outcome };
    return outcome;
  }

  /**
   * Dispatches to the procedure for the application kind.
   *
   * @param kind Application kind.
   * @param text Full document text to apply.
   * @param history Recorded target endpoint and edit location, present only for a history application.
   * @returns Application outcome.
   */
  private applyByKind(
    kind: DocumentApplyKind,
    text: string,
    history: HistoryApplyTarget | undefined,
  ): Promise<DocumentApplyOutcome> {
    if (kind === DOCUMENT_APPLY_KIND.saveCandidate) {
      return this.applySaveCandidate(text);
    }
    if (kind === DOCUMENT_APPLY_KIND.externalChange) {
      return this.applyExternalChange(text);
    }
    if (kind === DOCUMENT_APPLY_KIND.revert) {
      return this.applyRevert(text);
    }
    return this.applyEditHistory(text, history);
  }

  /**
   * Applies a save candidate.
   *
   * When the full text matches the most recently returned output, updates only the three baselines with that body and
   * current form without replacing the tree. In a normal save, the candidate is the output itself; rebuilding the tree
   * in that case would unnecessarily remap the selection every time.
   *
   * @param text Full document text of the save candidate.
   * @returns Application outcome.
   */
  private async applySaveCandidate(text: string): Promise<DocumentApplyOutcome> {
    const preparation = await this.ports.prepareDocumentApply(DOCUMENT_APPLY_KIND.saveCandidate);
    if (!preparation.ready) {
      return preparation.outcome;
    }

    const last = this.ports.readLastOutput();
    let outcome: DocumentApplyOutcome;
    if (last !== undefined && last.text === text) {
      this.ports.commitSerialization(last.output.body, last.output.current);
      outcome = DOCUMENT_APPLY_OUTCOME.applied;
    } else {
      outcome = this.replace(text);
    }
    preparation.finish(outcome === DOCUMENT_APPLY_OUTCOME.applied);
    return outcome;
  }

  /**
   * Applies an external change only to a view without unsaved edits.
   *
   * Checks immediately before replacement. Rejects when unsent content exists even if the content otherwise matches,
   * because an edit not received by the host cannot be recovered after replacing the tree.
   *
   * @param text Full document text after the external change.
   * @returns Application outcome.
   */
  private async applyExternalChange(text: string): Promise<DocumentApplyOutcome> {
    const preparation = await this.ports.prepareDocumentApply(DOCUMENT_APPLY_KIND.externalChange);
    if (!preparation.ready) {
      return preparation.outcome;
    }
    if (this.ports.hasUncommittedEdits()) {
      preparation.finish(false);
      return DOCUMENT_APPLY_OUTCOME.rejectedUnsaved;
    }
    const outcome = this.replace(text);
    preparation.finish(outcome === DOCUMENT_APPLY_OUTCOME.applied);
    return outcome;
  }

  /**
   * Replaces the document with the reread full text.
   *
   * Does not check for unsaved edits because Revert is the operation that discards them.
   *
   * @param text Reread full document text.
   * @returns Application outcome.
   */
  private async applyRevert(text: string): Promise<DocumentApplyOutcome> {
    const preparation = await this.ports.prepareDocumentApply(DOCUMENT_APPLY_KIND.revert);
    if (!preparation.ready) {
      return preparation.outcome;
    }
    const outcome = this.replace(text);
    preparation.finish(outcome === DOCUMENT_APPLY_OUTCOME.applied);
    return outcome;
  }

  /**
   * Applies full document text and selection from edit history only when the history state is empty.
   *
   * The body is applied even when the selection cannot be remapped. Failing to restore the body loses far
   * more, whereas a wrong position is fixed by placing the caret again.
   *
   * @param text Full document text of the candidate.
   * @param history Recorded target endpoint and edit location.
   * @returns Application outcome.
   */
  private async applyEditHistory(
    text: string,
    history: HistoryApplyTarget | undefined,
  ): Promise<DocumentApplyOutcome> {
    const preparation = await this.ports.prepareDocumentApply(DOCUMENT_APPLY_KIND.editHistory);
    if (!preparation.ready) {
      return preparation.outcome;
    }
    const selection = history === undefined
      ? undefined
      : this.ports.remapHistorySelection({ ...history, candidateText: text });
    const applied = this.ports.replaceDocumentFromHistory(text, selection ?? null);
    const outcome = applied ? DOCUMENT_APPLY_OUTCOME.applied : DOCUMENT_APPLY_OUTCOME.failed;
    preparation.finish(applied);
    return outcome;
  }

  /**
   * Replaces the tree and converts the result to an application outcome.
   *
   * @param text New full document text.
   * @returns Application outcome.
   */
  private replace(text: string): DocumentApplyOutcome {
    if (!this.ports.replaceDocument(text)) {
      return DOCUMENT_APPLY_OUTCOME.failed;
    }

    return DOCUMENT_APPLY_OUTCOME.applied;
  }
}
