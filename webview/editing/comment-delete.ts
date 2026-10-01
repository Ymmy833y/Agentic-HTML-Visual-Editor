import { COMMENT_TAG_NAME } from '../../common/index';
import { containsNode, findBlock } from './block';
import type { BlockRewriteProgress } from './block-format';
import { deleteRangeKeepingNodes } from './block-merge';
import { placeCaret } from './caret';
import { readDeletionExtent } from './code-block-guard';
import { readCommentEdge, readCommentEdgePosition, readPartialComments } from './comment-edge';
import type { CommentEdge, CommentEdgeSide } from './comment-edge';
import { readCommentEntries } from './comment-read';
import { readDeleteKind } from './delete-rule';
import type { DeleteKind } from './delete-rule';
import type { RangeDeleteKeep } from './editing-hooks';
import type { DiagnosticReporter, InputRule } from './input-dispatcher';
import type { NodeBoundary } from '../selection/selection-position';

const NO_KEEP: RangeDeleteKeep = { emptiedElements: [], keptNodes: [] };

/**
 * A record that tells later rules, within the same input, that an outward delete was shifted to the outside neighbor.
 *
 * After shifting, the delete looks the same as an outward delete from the outside neighbor. How much is deleted depends on whether it was shifted, so this is kept per input.
 * Each input is a distinct object and is held by weak reference, so no cleanup is needed.
 */
export class CommentShiftRecord {
  private readonly shifted = new WeakSet<InputEvent>();

  /**
   * Adds the input of a shifted delete.
   *
   * @param event The input.
   */
  add(event: InputEvent): void {
    this.shifted.add(event);
  }

  /**
   * Returns whether the input was shifted.
   *
   * @param event The input.
   * @returns `true` if the same input was shifted.
   */
  has(event: InputEvent): boolean {
    return this.shifted.has(event);
  }
}

/** The outside neighbor to place the caret at again after deleting. */
export interface CommentOutsideNeighbor {
  /** The comment. */
  readonly comment: Element;
  /** Start side or end side. */
  readonly side: CommentEdgeSide;
}

/**
 * The step of a delete keeping entries.
 *
 * One of: pass, no-op, one character across the edge (crossing), or clamp at a comment boundary. The clamp step records whether it started from a comment edge
 * (which changes the handling when the range cannot be determined). For steps without an outside neighbor to place at, the caret stays where the deletion happened.
 */
export type CommentDeleteStep =
  | { readonly kind: 'pass' }
  | { readonly kind: 'noop' }
  | { readonly kind: 'crossing'; readonly placeAt: CommentOutsideNeighbor | undefined }
  | { readonly kind: 'clamp'; readonly atEdge: boolean; readonly placeAt: CommentOutsideNeighbor | undefined };

/**
 * Creates the rule that shifts an outward delete from a comment edge to the outside neighbor on the side of the delete direction.
 *
 * A delete from a comment edge inside does not reach the block edge rules, because the block edge check counts the comment element as content. Shifting it to the
 * outside neighbor and passing it on lets the block edge rules and the structural boundary rules apply unchanged. It does not take over even after shifting.
 *
 * @param record The comment shift record.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 * @returns The rule to register at the head of the main queue for the delete input types.
 */
export function createCommentShiftRule(record: CommentShiftRecord, reportDiagnostic: DiagnosticReporter): InputRule {
  return ({ event, root, range }) => {
    const kind = readDeleteKind(event.inputType);
    if (kind === undefined || !range.collapsed) {
      return 'pass';
    }
    try {
      const edge = readCommentEdge(root, readCaret(range), kind.backward ? 'backward' : 'forward');
      if (edge === undefined || edge.inward) {
        return 'pass';
      }
      const side: CommentEdgeSide = kind.backward ? 'start' : 'end';
      if (edge.place === 'outside' && edge.side === side) {
        return 'pass';
      }
      const target = readCommentEdgePosition(edge.comment, 'outside', side);
      placeCaret(target.container, target.offset);
      range.setStart(target.container, target.offset);
      range.collapse(true);
      record.add(event);
    } catch (error) {
      reportDiagnostic(`Could not shift the delete from the comment edge to the outside neighbor: ${String(error)}`);
    }
    return 'pass';
  };
}

/**
 * Creates the rule that, among collapsed deletes no earlier rule took over, deletes those involving comments while keeping entries.
 *
 * The default delete removes entries from the end side both backward and forward, and at word granularity removes a word crossing the boundary together with the comment.
 * So deletes from a comment edge and deletes crossing a boundary are not passed to the default.
 *
 * @param record The comment shift record.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 * @returns The rule to register at the end of the fallback queue for the delete input types.
 */
export function createCommentRemoveRule(record: CommentShiftRecord, reportDiagnostic: DiagnosticReporter): InputRule {
  return ({ event, root, range }) => {
    const kind = readDeleteKind(event.inputType);
    if (kind === undefined || !range.collapsed) {
      return 'pass';
    }
    const progress: BlockRewriteProgress = { changed: false };
    try {
      const step = readCommentDeleteStep(root, range, kind, record.has(event));
      if (step.kind === 'pass') {
        return 'pass';
      }
      if (step.kind === 'noop') {
        return 'consumed';
      }

      const atEdge = step.kind === 'crossing' || step.atEdge;
      const caret = readCaret(range);
      // A crossing delete removes only one visible character on the other side, even at word granularity.
      const extent = readDeletionExtent(root, range, step.kind === 'crossing' ? { ...kind, granularity: 'character' } : kind);
      if (extent === undefined) {
        // At a comment edge the default delete would remove entries, so do not pass it on. Away from an edge, the default delete does not reach entries.
        return atEdge ? 'consumed' : 'pass';
      }
      let target = extent;
      if (step.kind === 'clamp') {
        const clamped = clampAtCommentBoundary(extent, caret);
        if (clamped === undefined && !step.atEdge) {
          return 'pass';
        }
        target = clamped ?? extent;
      }

      // Set progress to true before deleting, so that even if an exception occurs midway, what was deleted can be closed as an edit.
      progress.changed = true;
      deleteKeepingEntries(target);
      const position = step.placeAt === undefined
        ? { container: target.startContainer, offset: target.startOffset }
        : readCommentEdgePosition(step.placeAt.comment, 'outside', step.placeAt.side);
      placeCaret(position.container, position.offset);
      range.setStart(position.container, position.offset);
      range.collapse(true);
      return 'edited';
    } catch (error) {
      reportDiagnostic(`Could not handle the delete around the comment: ${String(error)}`);
      return progress.changed ? 'edited' : 'consumed';
    }
  };
}

/**
 * Decides the step for a collapsed delete. Changes neither the tree nor the selection.
 *
 * @param root The editor root.
 * @param range The collapsed selection range.
 * @param kind The delete kind.
 * @param shifted Whether the same delete was shifted to the outside neighbor.
 * @returns The step.
 */
export function readCommentDeleteStep(root: Element, range: Range, kind: DeleteKind, shifted: boolean): CommentDeleteStep {
  const caret = readCaret(range);
  if (kind.line) {
    // The line's extent depends on visual wrapping, which cannot be reproduced here. In a block with comments it could take entries along, so stop it.
    const block = findBlock(caret.container, root) ?? root;
    return block.querySelector(COMMENT_TAG_NAME.comment) === null ? { kind: 'pass' } : { kind: 'noop' };
  }

  const edge = readCommentEdge(root, caret, kind.backward ? 'backward' : 'forward');
  if (shifted) {
    return { kind: 'crossing', placeAt: readOutsideNeighbor(edge) };
  }
  if (edge === undefined) {
    return { kind: 'clamp', atEdge: false, placeAt: undefined };
  }
  if (edge.place === 'outside') {
    return edge.inward
      ? { kind: 'crossing', placeAt: readOutsideNeighbor(edge) }
      : { kind: 'clamp', atEdge: true, placeAt: readOutsideNeighbor(edge) };
  }
  // An outward delete from inside normally arrives after being shifted. No shift record means the shift rule failed; the default delete would remove entries, so stop it.
  return edge.inward ? { kind: 'clamp', atEdge: true, placeAt: undefined } : { kind: 'noop' };
}

/**
 * Cuts the end of the deletion range far from the caret at the first comment boundary encountered from the caret's side.
 *
 * Even a word-granularity delete does not remove annotated text and words outside together across a comment boundary. With nesting, the nearer boundary comes first.
 *
 * @param extent The range to delete. Not modified.
 * @param caret The caret position, at one end of the range to delete.
 * @returns A clamped copy of the range. `undefined` if it crosses no comment boundary.
 */
export function clampAtCommentBoundary(extent: Range, caret: NodeBoundary): Range | undefined {
  const document = extent.startContainer.ownerDocument;
  const scope = extent.commonAncestorContainer;
  if (document === null || !(scope instanceof Element)) {
    return undefined;
  }
  const probe = document.createRange();
  probe.setStart(caret.container, caret.offset);
  // If the caret is after the range start, this is a backward delete and the far end is the start.
  const backward = probe.compareBoundaryPoints(Range.START_TO_START, extent) > 0;

  let cut: NodeBoundary | undefined;
  for (const comment of scope.querySelectorAll(COMMENT_TAG_NAME.comment)) {
    const parent = comment.parentNode;
    if (parent === null) {
      continue;
    }
    const index = [...parent.childNodes].indexOf(comment);
    const length = comment.childNodes.length;
    const crossesStart = extent.comparePoint(parent, index) === 0 && extent.comparePoint(comment, 0) === 0;
    const crossesEnd = extent.comparePoint(comment, length) === 0 && extent.comparePoint(parent, index + 1) === 0;
    // The position of the boundary on the caret's side. Backward, the last one is nearest the caret; forward, the first one.
    const points: NodeBoundary[] = [];
    if (crossesStart) {
      points.push(backward ? { container: comment, offset: 0 } : { container: parent, offset: index });
    }
    if (crossesEnd) {
      points.push(backward ? { container: parent, offset: index + 1 } : { container: comment, offset: length });
    }
    for (const point of points) {
      if (cut === undefined || isBefore(point, cut) !== backward) {
        cut = point;
      }
    }
  }
  if (cut === undefined) {
    return undefined;
  }
  const clamped = extent.cloneRange();
  if (backward) {
    clamped.setStart(cut.container, cut.offset);
  } else {
    clamped.setEnd(cut.container, cut.offset);
  }
  return clamped;
}

/**
 * Deletes the other contents of the range while keeping the entries in it whole. Collapses the range to its start.
 *
 * Entries are not displayed, so users could not notice if they disappeared. Comment elements the range covers are kept by the range deletion rule.
 * The procedure that splits the deletion around entries is shared with the one range deletion uses for nodes kept whole.
 *
 * @param range The range to delete.
 */
export function deleteKeepingEntries(range: Range): void {
  const scope = range.commonAncestorContainer;
  const entries = scope instanceof Element
    ? [...scope.querySelectorAll(`${COMMENT_TAG_NAME.body}, ${COMMENT_TAG_NAME.reply}`)]
    : [];
  deleteRangeKeepingNodes(range, entries);
}

/**
 * As the range delete guard, returns the entries within the range of partly covered comments as nodes to keep whole. Changes neither the tree nor the selection.
 *
 * Comments the range fully contains are deleted together with their entries, so that deleting a paragraph or the whole document leaves no invisible comments.
 * A failure does not stop the range deletion. Stopping it would turn every deletion of the same range into a no-op and leave no way to delete it.
 *
 * @param range The range to delete.
 * @param root The editor root.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 * @returns What to keep. Empty if nothing.
 */
export function collectCommentKeep(range: Range, root: Element, reportDiagnostic: DiagnosticReporter): RangeDeleteKeep {
  try {
    const keptNodes = readPartialComments(range, root)
      .flatMap((comment) => readCommentEntries(comment).filter((entry) => containsNode(range, entry)));
    return { emptiedElements: [], keptNodes };
  } catch (error) {
    reportDiagnostic(`Could not determine which comment entries to keep: ${String(error)}`);
    return NO_KEEP;
  }
}

/**
 * Reads the range start as the caret position.
 *
 * @param range The collapsed selection range.
 * @returns The position.
 */
function readCaret(range: Range): NodeBoundary {
  return { container: range.startContainer, offset: range.startOffset };
}

/**
 * Returns the outside neighbor if the comment edge is one.
 *
 * @param edge The comment edge.
 * @returns The outside neighbor. `undefined` if the edge is inside or there is no comment edge.
 */
function readOutsideNeighbor(edge: CommentEdge | undefined): CommentOutsideNeighbor | undefined {
  return edge?.place === 'outside' ? { comment: edge.comment, side: edge.side } : undefined;
}

/**
 * Returns whether a position comes before another in document order.
 *
 * @param point The position.
 * @param other The position to compare with.
 * @returns `true` if it comes before.
 */
function isBefore(point: NodeBoundary, other: NodeBoundary): boolean {
  const document = point.container.ownerDocument;
  if (document === null) {
    return false;
  }
  const probe = document.createRange();
  probe.setStart(other.container, other.offset);
  return probe.comparePoint(point.container, point.offset) < 0;
}
