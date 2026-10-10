import {
  BLOCK_SEPARATOR_TEXT,
  INLINE_RUN_TAG_NAMES,
  containsNode,
  createEmptyBlock,
  fillPlaceholder,
  findBlock,
  isEmptyBlock,
  isHtmlWhitespaceOnly,
  isMergeableBlock,
  isSplittableBlock,
} from './block';
import { placeCaret } from './caret';
import type { RangeDeleteKeep } from './editing-hooks';
import { STRUCTURE_TAG_NAMES, isStructureCrossingRange, isTypableLine } from './structure-boundary';

/** The direction in which to find an adjacent block. */
export type MergeDirection = 'backward' | 'forward';

/** One range delete keep entry. Nested entries keep only the outermost one. */
type KeptPart =
  | { readonly kind: 'emptied'; readonly node: Element }
  | { readonly kind: 'kept'; readonly node: Node };

/** A line break deleted along with the range, and the node that was right after it. */
interface DeletedSeparator {
  /** The parent that held the line break. */
  readonly parent: Node;
  /** The element that was right after the line break. */
  readonly next: Element;
}

/** The structures at both ends of the range that may become adjacent after the range delete. */
interface SeparatedStructures {
  /** The outermost structure that contains the start but not the end. */
  readonly first: Element;
  /** The outermost structure that contains the end but not the start. */
  readonly second: Element;
}

/** The start of the range before the range delete. */
interface RangeStart {
  /** The node of the start. */
  readonly container: Node;
  /** The offset of the start. */
  readonly offset: number;
}

const NO_KEEP: RangeDeleteKeep = { emptiedElements: [], keptNodes: [] };

/** The caret position after a merge. */
export interface MergePoint {
  /** The node in which to place the caret. */
  readonly container: Node;
  /** The position within the node. */
  readonly offset: number;
}

/**
 * Determines whether a node can be skipped.
 *
 * Line breaks and indentation between blocks are invisible, so they are skipped when finding a neighbor.
 *
 * @param node The node to inspect.
 * @returns `true` for whitespace-only text or a comment node.
 */
function isSkippable(node: Node): boolean {
  if (node instanceof Comment) {
    return true;
  }
  return isSeparatorText(node);
}

/**
 * Determines whether text separates blocks onto different lines.
 *
 * @param node The node to inspect.
 * @returns `true` for whitespace-only text.
 */
function isSeparatorText(node: Node | null): node is Text {
  return node instanceof Text && isHtmlWhitespaceOnly(node.data);
}

/**
 * Returns an adjacent sibling element eligible for a merge attempt.
 *
 * Only siblings are considered, so an `li` can only find another `li` in the same list.
 *
 * @param block The starting block.
 * @param direction The search direction.
 * @returns The adjacent sibling element, or `undefined` when none exists.
 */
export function findMergeCandidate(block: Element, direction: MergeDirection): Element | undefined {
  const step = (node: Node): Node | null =>
    direction === 'backward' ? node.previousSibling : node.nextSibling;

  let current = step(block);
  while (current !== null) {
    if (current instanceof Element) {
      return current;
    }
    if (!isSkippable(current)) {
      return undefined;
    }
    current = step(current);
  }
  return undefined;
}

/**
 * Removes a block and the line-break text immediately before it.
 *
 * @param block The block to remove.
 */
export function removeWithSeparator(block: Element): void {
  const separator = block.previousSibling;
  block.remove();
  if (isSeparatorText(separator)) {
    separator.remove();
  }
}

/**
 * Combines adjacent mergeable blocks into one.
 *
 * Children are moved as existing nodes so no formatting `span` is inserted.
 *
 * @param previous The preceding block.
 * @param next The following block.
 * @returns The caret position after the merge, or `undefined` when the blocks cannot be merged.
 */
export function mergeBlocks(previous: Element, next: Element): MergePoint | undefined {
  if (!isMergeableBlock(previous) || !isMergeableBlock(next)) {
    return undefined;
  }

  // If either side is empty, remove only that side. Moving content and adopting one side's type would turn a
  // heading into a paragraph merely because an adjacent empty line was removed.
  if (isEmptyBlock(next)) {
    const point = { container: previous, offset: previous.childNodes.length };
    removeWithSeparator(next);
    return point;
  }
  if (isEmptyBlock(previous)) {
    removeWithSeparator(previous);
    return { container: next, offset: 0 };
  }

  // The merge point is the end of the preceding block before its children move; afterward the boundary is lost.
  const point = { container: previous, offset: previous.childNodes.length };

  while (isSeparatorText(next.firstChild)) {
    next.firstChild.remove();
  }
  previous.append(...next.childNodes);
  removeWithSeparator(next);
  return point;
}

/**
 * Places the range and caret at the same position.
 *
 * @param range The range to move.
 * @param container The destination node.
 * @param offset The position within the node.
 */
function placeRange(range: Range, container: Node, offset: number): void {
  placeCaret(container, offset);
  range.setStart(container, offset);
  range.collapse(true);
}

/**
 * Deletes a selected range and rejoins blocks that it crossed.
 *
 * `Range.deleteContents` does not remove partially selected parents, so deleting across blocks leaves empty
 * shells at both ends. They are rejoined only when both endpoints share a parent; both remain when the range
 * crosses into a table or list.
 *
 * Among the range delete keep, emptied elements keep the element, lose their content and get a placeholder; kept nodes are left untouched.
 * With nothing to keep and no structure crossed, merging and restoring line breaks behave as when there is no guard.
 *
 * @param range The range to delete.
 * @param root The editor root.
 * @param block The block containing the start of the range.
 * @param keep The range delete keep.
 * @returns The block that becomes the target of subsequent operations.
 */
export function deleteRangeContents(
  range: Range,
  root: Element,
  block: Element,
  keep: RangeDeleteKeep = NO_KEEP,
): Element {
  const endBlock = findBlock(range.endContainer, root);
  // A line break between blocks is also deleted when covered by the range, so record its presence first.
  const hadSeparator = isSeparatorText(block.nextSibling);
  const parts = arrangeKeptParts(range, keep);
  // A range crossing a table without whitespace yields an empty keep, but the structures containing the start or end remain as
  // elements, so line breaks deleted at their borders are also restored.
  const restoring = parts.length > 0 || isStructureCrossingRange(range, root);
  // After deleting, there is no telling where the deleted line breaks were, whether there was a line between the remaining structures, or whether the start was inside `code`.
  const separators = restoring ? collectDeletedSeparators(range, parts) : [];
  const structures = findSeparatedStructures(range, root);
  const codeStart = readCodeStart(range, block);

  if (parts.length === 0) {
    range.deleteContents();
  } else {
    deleteAroundKept(range, parts);
  }
  range.collapse(true);

  const emptiedElements = parts.flatMap((part) => (part.kind === 'emptied' ? [part.node] : []));
  for (const kept of emptiedElements) {
    // An element whose contents were deleted loses its height. Insert a placeholder so it remains as an empty line.
    fillPlaceholder(kept);
  }

  if (endBlock !== undefined && endBlock !== block && endBlock.parentNode === block.parentNode) {
    const point = mergeBlocks(block, endBlock);
    if (point !== undefined) {
      // The emptied side remains, so add a placeholder before positioning the caret to preserve line height.
      const remaining = point.container === block ? block : endBlock;
      fillPlaceholder(remaining);
      placeRange(range, point.container, point.offset);
      return remaining;
    }
  }

  if (isLineBlock(block) && isEmptyBlock(block)) {
    // A range over all the content of the start block leaves it with no height and no position for the caret, so the next character
    // would land in the following block. Keep it as an empty line, like a block emptied by merging.
    fillPlaceholder(block);
    placeRange(range, block, 0);
  }

  if (!restoring) {
    // Restore a deleted line break when both blocks remain separate. Otherwise they would share a line and even
    // the spelling of the untouched following block would normalize.
    if (hadSeparator && block.nextSibling !== null && !isSeparatorText(block.nextSibling)) {
      block.after(block.ownerDocument.createTextNode(BLOCK_SEPARATOR_TEXT));
    }
  } else {
    // With something to keep, or when crossing structures, borders between separately remaining parts appear besides the one right
    // after the start block. Without restoring the deleted line breaks there, the end paragraph shares a line with `</table>` and even untouched closing-tag lines change spelling.
    restoreSeparators(separators);
  }
  if (structures !== undefined) {
    insertLineBetween(structures);
  }

  if (codeStart !== undefined) {
    // When deleting the range moves the start outside `pre`, the caret ends up after `code`, and subsequently typed characters, line breaks
    // and pasted content land outside `code`. The start node is not removed by the delete, so the caret goes back to it.
    placeRange(range, codeStart.container, Math.min(codeStart.offset, readNodeLength(codeStart.container)));
  } else if (!block.contains(range.startContainer)) {
    // Everything from the start onward was deleted in the target block, so its remaining end is the caret position.
    placeRange(range, block, block.childNodes.length);
  }

  moveRangeIntoProtected(range, emptiedElements);
  return block;
}

/**
 * Determines whether a block holds a line of text that the caret can stay in once it is empty.
 *
 * Table cells and containers of other blocks are left out: a cell keeps its height from the table, and a container is not the line.
 *
 * @param block The block to inspect.
 * @returns `true` for a paragraph, heading, `div`, blockquote or list item with only inline children, and for a `summary`.
 */
export function isLineBlock(block: Element): boolean {
  return isTypableLine(block) || isSplittableBlock(block) || block.localName === 'summary';
}

/**
 * Deletes the range split around the kept nodes it fully contains, then collapses the range to its start.
 *
 * Uses the same splitting that range deletion uses for nodes protected as a whole. With two separate splitting procedures,
 * fixing only one of them would make the kept nodes diverge. It neither merges blocks nor restores line separators, so use it for ranges within a single block.
 *
 * @param range The range to delete.
 * @param keptNodes The nodes to keep. Nodes not fully contained in the range and nodes inside another kept node are not used as split points.
 */
export function deleteRangeKeepingNodes(range: Range, keptNodes: readonly Node[]): void {
  const parts = arrangeKeptParts(range, { emptiedElements: [], keptNodes });
  if (parts.length === 0) {
    range.deleteContents();
  } else {
    deleteAroundKept(range, parts);
  }
  range.collapse(true);
}

/**
 * Narrows the range delete keep to the outermost entries fully contained in the range and sorts them in document order.
 *
 * If the same node is in both lists, the kept one wins. Using entries that extend outside the range as separators would make a separated
 * range backwards and break the deletion.
 *
 * @param range The range to delete.
 * @param keep The range delete keep.
 * @returns The keep entries in document order.
 */
function arrangeKeptParts(range: Range, keep: RangeDeleteKeep): KeptPart[] {
  const parts = new Map<Node, KeptPart>();
  for (const node of keep.emptiedElements) {
    parts.set(node, { kind: 'emptied', node });
  }
  for (const node of keep.keptNodes) {
    parts.set(node, { kind: 'kept', node });
  }

  const contained = [...parts.values()].filter((part) => containsNode(range, part.node));
  const outermost = contained.filter(
    (part) => !contained.some((other) => other !== part && other.node.contains(part.node)),
  );
  return outermost.sort((first, second) => (
    (first.node.compareDocumentPosition(second.node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 ? -1 : 1
  ));
}

/**
 * Deletes the range, separated before and after each keep entry.
 *
 * Never creates a path that deletes a keep entry as a whole element. Emptied elements lose only their content, and kept nodes are untouched.
 * Each separated range follows changes to the tree, so deleting from the front does not shift the later borders.
 *
 * @param range The range to delete.
 * @param parts The keep entries in document order.
 */
function deleteAroundKept(range: Range, parts: readonly KeptPart[]): void {
  const document = range.startContainer.ownerDocument;
  if (document === null) {
    return;
  }

  const pieces: Range[] = [];
  let startContainer = range.startContainer;
  let startOffset = range.startOffset;

  for (const part of parts) {
    const before = document.createRange();
    before.setStart(startContainer, startOffset);
    before.setEndBefore(part.node);
    pieces.push(before);

    if (part.kind === 'emptied') {
      const inside = document.createRange();
      inside.selectNodeContents(part.node);
      pieces.push(inside);
    }

    const after = document.createRange();
    after.setStartAfter(part.node);
    startContainer = after.startContainer;
    startOffset = after.startOffset;
  }

  const tail = document.createRange();
  tail.setStart(startContainer, startOffset);
  tail.setEnd(range.endContainer, range.endOffset);
  pieces.push(tail);

  for (const piece of pieces) {
    piece.deleteContents();
  }
}

/**
 * Collects the line breaks deleted along with the range that sit right before a block or a keep entry.
 *
 * Whitespace within a line (between inline elements) is characters the user deleted; restoring it would undo part of the delete, so it is not collected.
 *
 * @param range The range to delete.
 * @param parts The keep entries.
 * @returns The deleted line breaks and the elements right after them.
 */
function collectDeletedSeparators(range: Range, parts: readonly KeptPart[]): DeletedSeparator[] {
  const scope = range.commonAncestorContainer;
  const document = scope.ownerDocument;
  if (document === null) {
    return [];
  }

  const separators: DeletedSeparator[] = [];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentNode;
    const next = node.nextSibling;
    if (
      !isSeparatorText(node)
      || parent === null
      || !(next instanceof Element)
      || INLINE_RUN_TAG_NAMES.has(next.localName)
      || !containsNode(range, node)
      || parts.some((part) => part.node.contains(node))
    ) {
      continue;
    }
    separators.push({ parent, next });
  }
  return separators;
}

/**
 * Restores the deleted line breaks one by one where the element that was right after each still remains in the same parent.
 *
 * Does not restore where that element was removed or moved by a merge, or where a line break already exists.
 *
 * @param separators The deleted line breaks.
 */
function restoreSeparators(separators: readonly DeletedSeparator[]): void {
  for (const { parent, next } of separators) {
    if (next.parentNode !== parent || isSeparatorText(next.previousSibling)) {
      continue;
    }
    next.before(next.ownerDocument.createTextNode(BLOCK_SEPARATOR_TEXT));
  }
}

/**
 * Checks whether the structures at both ends of the range can become adjacent siblings after the delete.
 *
 * Tables and details sections have no operation to move out before or after them, so when structures are adjacent the only way to type between them is undo.
 * Structures that were already adjacent and ranges contained in a single structure are out of scope.
 *
 * @param range The range to delete.
 * @param root The editor root.
 * @returns The pair of sibling structures with a typable line between them, or `undefined` if none applies.
 */
function findSeparatedStructures(range: Range, root: Element): SeparatedStructures | undefined {
  const first = findOutermostStructure(range.startContainer, range.endContainer, root);
  const second = findOutermostStructure(range.endContainer, range.startContainer, root);
  if (first === undefined || second === undefined || first.parentNode !== second.parentNode) {
    return undefined;
  }
  return hasTypableLineBetween(first, second) ? { first, second } : undefined;
}

/**
 * Returns the outermost structure that contains the node and not the other end.
 *
 * @param node The node at one end.
 * @param other The node at the other end.
 * @param root The editor root.
 * @returns The structure, or `undefined` if there is none.
 */
function findOutermostStructure(node: Node, other: Node, root: Element): Element | undefined {
  let found: Element | undefined;
  for (
    let current: Element | null = node instanceof Element ? node : node.parentElement;
    current !== null && current !== root && !current.contains(other);
    current = current.parentElement
  ) {
    if (STRUCTURE_TAG_NAMES.has(current.localName)) {
      found = current;
    }
  }
  return found;
}

/**
 * Determines whether there is a typable line between two siblings.
 *
 * Lines inside containers and lists between them also count. If they disappear, there is likewise no way left to type between the structures.
 *
 * @param first The earlier sibling.
 * @param second The later sibling.
 * @returns `true` if there is a typable line.
 */
function hasTypableLineBetween(first: Element, second: Element): boolean {
  for (let node = first.nextSibling; node !== null && node !== second; node = node.nextSibling) {
    if (containsTypableLine(node)) {
      return true;
    }
  }
  return false;
}

/**
 * Determines whether a node or one of its descendants is a typable line.
 *
 * @param node The node to inspect.
 * @returns `true` if there is a typable line.
 */
function containsTypableLine(node: Node): boolean {
  if (isTypableLine(node)) {
    return true;
  }
  return [...node.childNodes].some((child) => containsTypableLine(child));
}

/**
 * Inserts one empty paragraph between two structures that became adjacent after the delete.
 *
 * @param structures The structures at both ends of the range.
 */
function insertLineBetween(structures: SeparatedStructures): void {
  const { first, second } = structures;
  if (first.parentNode === null || first.parentNode !== second.parentNode || hasTypableLineBetween(first, second)) {
    return;
  }
  const document = first.ownerDocument;
  first.after(document.createTextNode(BLOCK_SEPARATOR_TEXT), createEmptyBlock(document, 'p'));
}

/**
 * Returns the start of the range if it is inside `code` directly under the `pre` that is the start block.
 *
 * @param range The range to delete.
 * @param block The start block.
 * @returns The start, or `undefined` if it is not inside `code`.
 */
function readCodeStart(range: Range, block: Element): RangeStart | undefined {
  if (block.localName !== 'pre') {
    return undefined;
  }
  for (let current: Node | null = range.startContainer; current !== null && current !== block; current = current.parentNode) {
    if (current instanceof Element && current.localName === 'code' && current.parentNode === block) {
      return { container: range.startContainer, offset: range.startOffset };
    }
  }
  return undefined;
}

/**
 * Returns the number of positions in a node (the character count for text, the child count for an element).
 *
 * @param node The node to inspect.
 * @returns The number of positions.
 */
function readNodeLength(node: Node): number {
  return node instanceof CharacterData ? node.length : node.childNodes.length;
}

/**
 * Moves the post-deletion caret to the start of a protected element, but only when it sits at a bare
 * position just before that element.
 *
 * Left directly beneath a collapsible section, subsequently typed characters would become bare text.
 *
 * @param range The range after the deletion.
 * @param protectedElements The protected elements.
 */
function moveRangeIntoProtected(range: Range, protectedElements: readonly Element[]): void {
  for (const kept of protectedElements) {
    const parent = kept.parentNode;
    if (parent === null || range.startContainer !== parent) {
      continue;
    }
    if (range.startOffset <= [...parent.childNodes].indexOf(kept)) {
      placeRange(range, kept, 0);
      return;
    }
  }
}
