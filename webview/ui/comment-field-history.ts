import { TRANSACTION_IDLE_MS, classifyEditKind, decideEditBoundary } from '../history/edit-grouping';
import type { EditClassification, PendingEditGroup } from '../history/edit-grouping';

/** A state of a field the history can return to. Two states with the same key hold the same content. */
export interface CommentFieldHistorySnapshot {
  readonly key: string;
}

/**
 * Where an undo or redo pressed in a field goes.
 *
 * `field` returns the field to the snapshot, `document` lets the key through to the document's history, and `none`
 * takes the key without doing anything.
 */
export type CommentFieldHistoryRoute<S> =
  | { readonly kind: 'field'; readonly snapshot: S }
  | { readonly kind: 'document' }
  | { readonly kind: 'none' };

/** One operation in the field: the states before and after it. */
interface Step<S> {
  readonly before: S;
  after: S;
}

/** The edit attempt open in the field. */
interface OpenAttempt<S> {
  readonly classification: EditClassification;
  readonly before: S;
  readonly readAfter: () => S;
}

/**
 * The history of what is being written in one comment field.
 *
 * A draft is not in the document, so it cannot go into the document's history, which VS Code holds; it is kept here
 * and stacked on top of the document's history instead. A draft is always newer than any edit of the document, so
 * undoing the draft to where writing started and then going on into the document undoes both as one history.
 *
 * Edits are grouped as the document groups them, so one undo takes back as much in a field as in the document.
 */
export class CommentFieldHistory<S extends CommentFieldHistorySnapshot> {
  private readonly undoSteps: Step<S>[] = [];
  private readonly redoSteps: Step<S>[] = [];
  private group: PendingEditGroup | undefined;
  private attempt: OpenAttempt<S> | undefined;
  // Rules can run commands of their own while an edit is open; those become part of the outer edit.
  private depth = 0;
  // Undos let through to the document since the draft last changed. Redo goes to the document as many times first,
  // so that redo retraces the undos in reverse order.
  private documentUndos = 0;

  /**
   * @param now Returns the current time in milliseconds.
   */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Opens an edit. An edit opened while another is open becomes part of it.
   *
   * @param editKind The input type or command name.
   * @param readBefore Reads the state before the edit.
   * @param readAfter Reads the state after the edit, when it closes.
   */
  begin(editKind: string, readBefore: () => S, readAfter: () => S): void {
    this.depth += 1;
    if (this.depth > 1) {
      return;
    }
    this.attempt = { classification: classifyEditKind(editKind), before: readBefore(), readAfter };
  }

  /**
   * Closes an edit, whether it completed or was aborted. When the outermost edit closes and the content changed, the
   * change becomes an operation, or joins the previous one when the document would join them.
   */
  end(): void {
    if (this.depth === 0) {
      return;
    }
    this.depth -= 1;
    const attempt = this.attempt;
    if (this.depth > 0 || attempt === undefined) {
      return;
    }
    this.attempt = undefined;
    const after = attempt.readAfter();
    if (after.key === attempt.before.key) {
      return;
    }
    const now = this.now();
    const last = this.undoSteps.at(-1);
    if (decideEditBoundary(this.group, attempt.classification, now) === 'continue' && last !== undefined) {
      last.after = after;
    } else {
      this.undoSteps.push({ before: attempt.before, after });
    }
    this.group = attempt.classification === 'single'
      ? undefined
      : { kind: attempt.classification, deadline: now + TRANSACTION_IDLE_MS };
    this.redoSteps.length = 0;
    this.documentUndos = 0;
  }

  /**
   * Decides where an undo goes: back one operation in the field, or on into the document once the field is back where
   * writing started.
   *
   * @returns The route.
   */
  undo(): CommentFieldHistoryRoute<S> {
    this.closeOpenAttempt();
    const step = this.undoSteps.pop();
    if (step === undefined) {
      this.documentUndos += 1;
      return { kind: 'document' };
    }
    this.redoSteps.push(step);
    this.group = undefined;
    return { kind: 'field', snapshot: step.before };
  }

  /**
   * Decides where a redo goes: to the document while undos went there, then forward one operation in the field.
   *
   * @returns The route. Nothing is redone while the draft has operations but none to redo, because the draft is the
   *   newest change and the document's redo was given up when it was written.
   */
  redo(): CommentFieldHistoryRoute<S> {
    this.closeOpenAttempt();
    if (this.documentUndos > 0) {
      this.documentUndos -= 1;
      return { kind: 'document' };
    }
    const step = this.redoSteps.pop();
    if (step !== undefined) {
      this.undoSteps.push(step);
      this.group = undefined;
      return { kind: 'field', snapshot: step.after };
    }
    return this.undoSteps.length > 0 ? { kind: 'none' } : { kind: 'document' };
  }

  /** Drops everything, as when the field is emptied or given new content. */
  reset(): void {
    this.undoSteps.length = 0;
    this.redoSteps.length = 0;
    this.group = undefined;
    this.attempt = undefined;
    this.depth = 0;
    this.documentUndos = 0;
  }

  /**
   * Closes an edit left open, so that it is recorded before moving through the history.
   *
   * Undo and redo are pressed between edits, so an edit still open then never got its end, and it would otherwise
   * keep every later edit inside it.
   */
  private closeOpenAttempt(): void {
    if (this.depth === 0) {
      return;
    }
    this.depth = 1;
    this.end();
  }
}
