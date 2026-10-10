import { findBlock, isEmptyBlock, isHtmlWhitespaceOnly } from './block';
import type { BlockCommandPorts } from './block-command';
import type { BlockRewriteProgress } from './block-format';
import { findMergeCandidate, removeWithSeparator } from './block-merge';
import { findListTailStructure, findStructurePlacement } from './boundary-placement';
import { isAtBlockEnd, isAtBlockStart, placeCaret } from './caret';
import { clearCodeContents, isBlankCodeBlock, readCodeClearing, replaceBlankCodeBlock } from './code-block-guard';
import type { CodeClearing } from './code-block-guard';
import type { DeleteKind } from './delete-rule';
import { unwrapDetailsSection } from './details-unwrap';
import { readListKind } from './list-structure';
import {
  STRUCTURE_TAG_NAMES,
  findTitleWithCaretAtStart,
  isAtStructureBoundary,
  isTowardAdjacentBlock,
  isTypableLine,
} from './structure-boundary';
import type { DeleteDirection } from './structure-boundary';
import type { NodeBoundary } from '../selection/selection-position';

/**
 * The step a delete from the caret matched.
 *
 * A delete that is not taken over (one that proceeds to the built-in delete replacement) is represented by no match, not by this type.
 */
export type BoundaryDelete =
  | { readonly kind: 'blankCodeBlock' }
  | { readonly kind: 'codeClearing'; readonly clearing: CodeClearing }
  | {
    readonly kind: 'emptyBesideStructure';
    readonly empty: Element;
    readonly placement: NodeBoundary;
    readonly direction: DeleteDirection;
  }
  | { readonly kind: 'emptyBesideCode'; readonly empty: Element; readonly direction: DeleteDirection }
  | { readonly kind: 'unwrapDetails'; readonly title: Element }
  | { readonly kind: 'noop' };

/** An empty standalone block next to a structure, paired with the sibling structure in the delete direction. */
export interface StructureBesideEmptyBlock {
  /** The empty standalone block containing the caret. */
  readonly empty: Element;
  /** The sibling structure in the delete direction. Forward may also be a list, and backward may be a list whose last item ends with a structure. */
  readonly structure: Element;
}

/**
 * Decides, without changing the tree, which step a collapsed delete matches.
 *
 * Checks the conditions in the order blank code block, `code` content protection, empty standalone block next to a structure, empty standalone block next to a code block,
 * backward delete at the start of a details title and noop at a boundary, and returns the first match. The range of a line delete cannot be reproduced from visual wrapping, so only
 * `code` content protection and noop apply to it. Word deletes are checked under the same conditions as character deletes, with only the deletion extent decided by word.
 *
 * @param root The editor root.
 * @param range The selection range. Temporarily extended and restored only when checking `code` content protection.
 * @param kind The delete kind.
 * @returns The matched step, or `undefined` when there is a range selection or nothing matches.
 */
export function readBoundaryDelete(root: Element, range: Range, kind: DeleteKind): BoundaryDelete | undefined {
  if (!range.collapsed) {
    return undefined;
  }
  const direction: DeleteDirection = kind.backward ? 'backward' : 'forward';
  const block = findBlock(range.startContainer, root);

  if (!kind.line && block?.localName === 'pre' && isBlankCodeBlock(block)) {
    return { kind: 'blankCodeBlock' };
  }

  const clearing = readCodeClearing(root, range, kind);
  if (clearing !== undefined) {
    return { kind: 'codeClearing', clearing };
  }

  if (!kind.line) {
    const beside = findStructureBesideEmptyBlock(root, range, direction);
    if (beside !== undefined) {
      const placement = findStructurePlacement(beside.structure, direction);
      // Next to a structure with no visible position (a closed details section without a title), there is nowhere to move, so do nothing.
      return placement === undefined
        ? { kind: 'noop' }
        : { kind: 'emptyBesideStructure', empty: beside.empty, placement, direction };
    }

    const empty = findEmptyBlockBesideCode(root, range, direction);
    if (empty !== undefined) {
      return { kind: 'emptyBesideCode', empty, direction };
    }

    if (kind.backward) {
      // The start of a title is a structure boundary too, but a noop there would leave no way to remove a details section from the caret.
      const title = findTitleWithCaretAtStart(root, range);
      if (title !== undefined) {
        return { kind: 'unwrapDetails', title };
      }
    }
  }

  if (isAtStructureBoundary(root, range, direction) || isTowardAdjacentBlock(root, range, direction)) {
    return { kind: 'noop' };
  }
  return undefined;
}

/**
 * Runs the decided step.
 *
 * Does not catch exceptions. The rule that catches them decides from the progress whether the result is "edited" or "consumed".
 *
 * @param step The matched step.
 * @param range The selection range.
 * @param ports The block command ports.
 * @param progress The progress recording whether the tree changed. Set to true as soon as the tree changes.
 * @returns "Edited" if the tree changed, "consumed" otherwise.
 */
export function applyBoundaryDelete(
  step: BoundaryDelete,
  range: Range,
  ports: BlockCommandPorts,
  progress: BlockRewriteProgress,
): 'edited' | 'consumed' {
  switch (step.kind) {
    case 'blankCodeBlock':
      if (replaceBlankCodeBlock(ports)) {
        progress.changed = true;
      }
      break;
    case 'codeClearing':
      clearCodeContents(step.clearing, range, progress);
      break;
    case 'emptyBesideStructure':
      // Removing the last line next to a structure would leave undo as the only way to type there, because tables and details sections have no operation
      // to move out before or after them. Remove it only when the opposite side is a typable line; otherwise just move the caret into the structure.
      if (hasTypableLineBeyond(step.empty, step.direction === 'backward' ? 'forward' : 'backward')) {
        removeEmptyBlock(step.empty, progress);
      }
      placeCaret(step.placement.container, step.placement.offset);
      range.setStart(step.placement.container, step.placement.offset);
      range.collapse(true);
      break;
    case 'emptyBesideCode':
      // The caret stays in the code block. If the other side is not a typable line, it is not removed, for the same reason.
      if (hasTypableLineBeyond(step.empty, step.direction)) {
        removeEmptyBlock(step.empty, progress);
      }
      break;
    case 'unwrapDetails':
      unwrapDetailsSection(step.title, range, progress);
      break;
    case 'noop':
      break;
  }
  return progress.changed ? 'edited' : 'consumed';
}

/**
 * Returns the empty standalone block containing the caret and the sibling structure in its delete direction. Changes neither the tree nor the selection.
 *
 * Looks only at siblings and does not climb containers. Climbing would compete with the list, cell and body rules.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @param direction The delete direction.
 * @returns The empty standalone block and the structure, or `undefined` if the caret block is not an empty standalone block or the sibling is not a structure.
 */
export function findStructureBesideEmptyBlock(
  root: Element,
  range: Range,
  direction: DeleteDirection,
): StructureBesideEmptyBlock | undefined {
  if (!range.collapsed) {
    return undefined;
  }
  const empty = findBlock(range.startContainer, root);
  if (empty === undefined || !isEmptyStandaloneBlock(empty)) {
    return undefined;
  }
  const structure = findMergeCandidate(empty, direction);
  if (structure === undefined) {
    return undefined;
  }
  if (STRUCTURE_TAG_NAMES.has(structure.localName)) {
    return { empty, structure };
  }
  if (readListKind(structure) === undefined) {
    return undefined;
  }
  // For a backward list, take only those the list rule has no merge target for (whose last item ends with a structure).
  return direction === 'forward' || findListTailStructure(structure) !== undefined
    ? { empty, structure }
    : undefined;
}

/**
 * Returns the empty standalone block that is the sibling in the delete direction from the edge of a code block. Changes neither the tree nor the selection.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @param direction The delete direction.
 * @returns The empty standalone block, or `undefined` if the caret is not at that edge of the code block or the sibling is not an empty standalone block.
 */
export function findEmptyBlockBesideCode(
  root: Element,
  range: Range,
  direction: DeleteDirection,
): Element | undefined {
  const pre = findBlock(range.startContainer, root);
  if (pre === undefined || pre.localName !== 'pre') {
    return undefined;
  }
  const atEdge = direction === 'backward' ? isAtBlockStart(range, pre) : isAtBlockEnd(range, pre);
  if (!atEdge) {
    return undefined;
  }
  const sibling = findMergeCandidate(pre, direction);
  return sibling !== undefined && isEmptyStandaloneBlock(sibling) ? sibling : undefined;
}

/**
 * Determines whether the sibling on one side of an empty standalone block is a typable line.
 *
 * @param empty The empty standalone block.
 * @param side The side to look at.
 * @returns `true` if the sibling is a typable line. `false` if there is no sibling, or it is a structure, list, horizontal rule or container with block children.
 */
export function hasTypableLineBeyond(empty: Element, side: DeleteDirection): boolean {
  let node = side === 'backward' ? empty.previousSibling : empty.nextSibling;
  while (node !== null && (node instanceof Comment || (node instanceof Text && isHtmlWhitespaceOnly(node.data)))) {
    node = side === 'backward' ? node.previousSibling : node.nextSibling;
  }
  return isTypableLine(node ?? undefined);
}

/**
 * Removes an empty standalone block together with the line break text right before it.
 *
 * An empty standalone block with attributes is removed the same way, and no line break is added. This matches the shape a block merge leaves when it removes the empty side.
 *
 * @param empty The empty standalone block.
 * @param progress The progress recording whether the tree changed.
 */
export function removeEmptyBlock(empty: Element, progress: BlockRewriteProgress): void {
  removeWithSeparator(empty);
  progress.changed = true;
}

/**
 * Determines whether an element is an empty standalone block.
 *
 * @param element The element to inspect.
 * @returns `true` for a paragraph, heading, `div` or blockquote with only inline children whose content is whitespace and at most one `br`.
 *   List items are excluded because the list rules handle them.
 */
function isEmptyStandaloneBlock(element: Element): boolean {
  return isTypableLine(element) && isEmptyBlock(element);
}
