import { isInsidePre } from './block';
import { findCommentAt, isAtCommentEnd, isAtCommentStart } from './comment-read';
import type { SplitPreparation, SplitPreprocessor } from './editing-hooks';
import type { EditingSession } from './editing-session';
import type { DiagnosticReporter } from './input-dispatcher';
import type { NodeBoundary } from '../selection/selection-position';

/**
 * The result of checking comments before a split.
 *
 * One of: keep (splitting at the caret is fine), edge (split at the boundary just before or after the comment),
 * or middle (do not split; insert a line break instead).
 */
export type CommentSplit =
  | { readonly kind: 'keep' }
  | { readonly kind: 'edge'; readonly boundary: NodeBoundary }
  | { readonly kind: 'middle' };

/**
 * Decides how to split for the comment whose annotated text contains the caret inside the block being split.
 * Changes neither the tree nor the selection.
 *
 * A comment cannot span blocks, so splitting right at the caret would break the comment. At an edge, the split position
 * is shifted outside the comment; in the middle, a line break is inserted instead of splitting. Nested comments are judged
 * by the outermost one: splitting at the edge of an inner comment that is in the middle of the outer one breaks the outer.
 *
 * @param block The block to split. The search stops at it, so a comment containing the block is not counted (the split does not break it).
 * @param caret The caret boundary.
 * @returns The result. For annotated text with no visible content, the boundary just after is returned as the end edge.
 */
export function readCommentSplit(block: Element, caret: NodeBoundary): CommentSplit {
  // Inside `pre`, a line break is content itself and no split happens. Callers do not call this inside `pre` either.
  if (isInsidePre(caret.container, block)) {
    return { kind: 'keep' };
  }
  const comment = findCommentAt(caret.container, block, 'outermost');
  const parent = comment?.parentNode;
  if (comment === undefined || parent === null || parent === undefined) {
    return { kind: 'keep' };
  }

  // Check the end edge first. Annotated text with no visible content is also at the start edge, but leaving it in place and
  // creating the next line makes Enter move one line down, as it looks, rather than moving the comment to the later line.
  const index = [...parent.childNodes].indexOf(comment);
  if (isAtCommentEnd(comment, caret)) {
    return { kind: 'edge', boundary: { container: parent, offset: index + 1 } };
  }
  if (isAtCommentStart(comment, caret)) {
    return { kind: 'edge', boundary: { container: parent, offset: index } };
  }
  return { kind: 'middle' };
}

/**
 * Creates the split preprocessor that keeps comments from breaking.
 *
 * In the middle, it takes over by inserting a line break (`br`) at the caret instead of splitting. Format elements and
 * comments are not split; the line break goes inside them.
 * Exceptions are not thrown out; they become a takeover that prevents the split, because going on to split could break the comment.
 *
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 * @returns The split preprocessor.
 */
export function createCommentSplitPreprocessor(reportDiagnostic: DiagnosticReporter): SplitPreprocessor {
  return (block, caret): SplitPreparation => {
    let inserted = false;
    try {
      const split = readCommentSplit(block, caret);
      if (split.kind === 'keep') {
        return { kind: 'split', boundary: caret };
      }
      if (split.kind === 'edge') {
        return { kind: 'split', boundary: split.boundary };
      }

      const lineBreak = block.ownerDocument.createElement('br');
      const range = block.ownerDocument.createRange();
      range.setStart(caret.container, caret.offset);
      range.insertNode(lineBreak);
      inserted = true;
      const parent = lineBreak.parentNode;
      if (parent === null) {
        return { kind: 'takenOver', changed: true, boundary: undefined };
      }
      return {
        kind: 'takenOver',
        changed: true,
        boundary: { container: parent, offset: [...parent.childNodes].indexOf(lineBreak) + 1 },
      };
    } catch (error) {
      reportDiagnostic(`Could not handle a line break inside a comment: ${String(error)}`);
      return { kind: 'takenOver', changed: inserted, boundary: undefined };
    }
  };
}

/**
 * Registers the split preprocessor that keeps comments from breaking in the current editing session.
 *
 * The preprocessor is lost together with the editing session on document replacement, so call this on every mount, including the first.
 *
 * @param session The editing session. Only its preprocessor registration port is used.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 */
export function registerCommentSplit(
  session: Pick<EditingSession, 'registerSplitPreprocessor'>,
  reportDiagnostic: DiagnosticReporter,
): void {
  session.registerSplitPreprocessor(createCommentSplitPreprocessor(reportDiagnostic));
}
