import { COMMENT_AUTHOR } from '../../common/index';
import type { CommentAuthor } from '../../common/index';
import { INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX } from '../document/internal-attribute';
import { readSelectionRange } from '../editing/caret';
import { findCommentAt, readCommentEntries } from '../editing/comment-read';
import { isAiEntry } from '../editing/comment-thread-read';

/**
 * The namespace of the comment caret mark.
 *
 * Placed under the internal namespace that the inverse transform drops from the output. The mark is a temporary display state and must not appear in the saved content, the unsaved content, or the history.
 */
export const COMMENT_CARET_MARK_NAMESPACE = `${INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX}comment-caret`;

/** The local name of the mark attribute. The bundled stylesheet and E2E tests look it up with the same spelling. The value is `ai` or `human`. */
export const COMMENT_CARET_MARK_NAME = 'data-ahve-comment-caret';

/** Ports for the comment caret color. Holds no values and reads them on every call. */
export interface CommentCaretPorts {
  /** Returns the editor root. `undefined` before mounting. */
  readEditorRoot(): HTMLElement | undefined;

  /**
   * Records one diagnostic line for maintainers. Not used for user notifications.
   *
   * @param detail The line to record.
   */
  reportDiagnostic(detail: string): void;
}

/**
 * If a collapsed caret is inside annotated text, returns the side of that comment's thread author. Changes neither the tree nor the selection.
 *
 * The thread author is decided by the same rule as the bundled stylesheet selector that sets the annotated text outline color (the AI side if the author of the first
 * direct entry in document order exactly matches `ai`). This keeps the outline and caret colors from disagreeing.
 *
 * @param root The editor root.
 * @returns `ai` or `human`. `undefined` for a range selection, a selection outside the editor root, or outside annotated text (including the outside neighbor).
 */
export function readCommentCaretColor(root: Element): CommentAuthor | undefined {
  const range = readSelectionRange(root);
  if (range === undefined || !range.collapsed) {
    return undefined;
  }
  const comment = findCommentAt(range.startContainer, root, 'innermost');
  if (comment === undefined) {
    return undefined;
  }
  const first = readCommentEntries(comment).at(0);
  return first !== undefined && isAiEntry(first) ? COMMENT_AUTHOR.ai : COMMENT_AUTHOR.human;
}

/**
 * On selection changes, marks the editor root only while the caret is inside annotated text, so the caret is drawn in the inside color.
 *
 * It does not evaluate within the selection change but evaluates once in the next frame, so that repeated evaluations during a range-selection drag do not block the input path.
 * The mark goes on the editor root itself and the elements inside inherit the color. At the same visual position, the element in which the browser draws the caret may differ
 * from the element at the selection position, so it is not set per element. There is one per view, and it is not recreated on document replacement.
 */
export class CommentCaret {
  // The pending batch. Changes arriving while pending are folded into it.
  private pending: number | undefined;

  /**
   * @param view The view's window.
   * @param ports The ports.
   */
  constructor(
    private readonly view: Window,
    private readonly ports: CommentCaretPorts,
  ) {}

  /** On a selection change, schedules one evaluation for the next frame if none is pending. Does not postpone a pending one. */
  handleSelectionChange(): void {
    if (this.pending !== undefined) {
      return;
    }
    this.pending = this.view.requestAnimationFrame(() => {
      this.pending = undefined;
      this.evaluate();
    });
  }

  /**
   * Reads the inside color and resets or removes the mark on the editor root. Setting or removing it is not reported as an edit.
   *
   * After document replacement, it is recomputed against the new tree by the change from restoring the selection (the old tree carries no mark).
   */
  evaluate(): void {
    const root = this.ports.readEditorRoot();
    if (root === undefined) {
      return;
    }
    try {
      const color = readCommentCaretColor(root);
      if (color === undefined) {
        removeMark(root);
      } else if (root.getAttributeNS(COMMENT_CARET_MARK_NAMESPACE, COMMENT_CARET_MARK_NAME) !== color) {
        // Do not set the same value again. An attribute change stops edit endpoints from being reused, so write only when it changes.
        root.setAttributeNS(COMMENT_CARET_MARK_NAMESPACE, COMMENT_CARET_MARK_NAME, color);
      }
    } catch (error) {
      this.ports.reportDiagnostic(`Could not determine the caret color: ${String(error)}`);
      removeMark(root);
    }
  }
}

/**
 * Attaches the selection change listener to the view's document.
 *
 * Selection changes arrive at the view's document and the editor root element stays the same across document replacement, so call this only once on the first mount.
 *
 * @param view The view's window.
 * @param ports The ports.
 * @returns The attached comment caret.
 */
export function attachCommentCaret(view: Window, ports: CommentCaretPorts): CommentCaret {
  const caret = new CommentCaret(view, ports);
  view.document.addEventListener('selectionchange', () => caret.handleSelectionChange());
  return caret;
}

/**
 * Removes the mark from the editor root. Does nothing if it is not set.
 *
 * @param root The editor root.
 */
function removeMark(root: Element): void {
  if (root.hasAttributeNS(COMMENT_CARET_MARK_NAMESPACE, COMMENT_CARET_MARK_NAME)) {
    root.removeAttributeNS(COMMENT_CARET_MARK_NAMESPACE, COMMENT_CARET_MARK_NAME);
  }
}
