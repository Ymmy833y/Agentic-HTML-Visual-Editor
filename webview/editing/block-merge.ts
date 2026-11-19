import {
  BLOCK_SEPARATOR_TEXT,
  INLINE_RUN_TAG_NAMES,
  containsNode,
  createEmptyBlock,
  fillPlaceholder,
  findBlock,
  hasBlockChild,
  isEmptyBlock,
  isHtmlWhitespaceOnly,
  isMergeableBlock,
  isSplittableBlock,
} from './block';
import { findTrailingPreBreak, placeCaret } from './caret';
import type { RangeDeleteKeep } from './editing-hooks';
import { FORMAT_ELEMENT_TAG_NAMES } from './inline-format';
import { STRUCTURE_TAG_NAMES, isStructureCrossingRange, isStructureElement, isTypableLine } from './structure-boundary';

/** The direction in which to find an adjacent block. */
export type MergeDirection = 'backward' | 'forward';

/**
 * Where a merge puts the children of the following block.
 *
 * `end` puts them at the end of the preceding block. A range delete joins at the start of the range, and a `br` left
 * right before it is a line break that the range did not delete. `lastLine` puts them at the end of the last line of
 * the preceding block. A delete at a block edge joins the lines the author sees, and a trailing `br` shows no line of
 * its own.
 */
export type MergeJoin = 'end' | 'lastLine';

// Inline elements that show nothing once they hold no text. A range delete leaves them empty around its ends, with
// their attributes. Any other element shows something, or may, so a block that holds one is not blank.
const BLANK_WRAPPER_TAG_NAMES: ReadonlySet<string> = new Set([...FORMAT_ELEMENT_TAG_NAMES, 'span']);

// Containers that go together with the emptied end block they alone held, and that hold nothing once only blank
// blocks are left in them.
const CONTAINER_TAG_NAMES: ReadonlySet<string> = new Set(['ul', 'ol', 'li', 'blockquote', 'div']);

// Lines whose kind the author chooses. When a range delete leaves nothing but blank ones, the editor root goes back to
// one empty paragraph. A details title and a table cell are parts of a structure, so they are not among them.
const LINE_TAG_NAMES: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'div',
  'blockquote',
  'li',
  'pre',
]);

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
 * @param join Where the children of the following block go.
 * @returns The caret position after the merge, or `undefined` when the blocks cannot be merged.
 */
export function mergeBlocks(previous: Element, next: Element, join: MergeJoin = 'end'): MergePoint | undefined {
  if (!isMergeableBlock(previous) || !isMergeableBlock(next)) {
    return undefined;
  }

  // A trailing `br` shows no line of its own, so the last line of the preceding block ends right before it. Joining
  // after it would put the moved content, the caret, and whatever is pasted next, on a line below an empty one.
  const lineEnd = join === 'lastLine' ? readTrailingBreak(previous) : undefined;

  // If either side is empty, remove only that side. Moving content and adopting one side's type would turn a
  // heading into a paragraph merely because an adjacent empty line was removed.
  if (isEmptyBlock(next)) {
    const offset = previous.childNodes.length - (lineEnd === undefined ? 0 : 1);
    removeWithSeparator(next);
    return { container: previous, offset };
  }
  if (isEmptyBlock(previous)) {
    removeWithSeparator(previous);
    return { container: next, offset: 0 };
  }

  // The moved content fills the line that the `br` was keeping visible, so the `br` is no longer needed.
  lineEnd?.remove();
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
 * Returns the `br` that ends a block, when its last child is one.
 *
 * @param block The block to inspect.
 * @returns The trailing `br`, or `undefined` when the last child is anything else.
 */
function readTrailingBreak(block: Element): Element | undefined {
  const last = block.lastChild;
  return last instanceof Element && last.localName === 'br' ? last : undefined;
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
 * An end block that is left with nothing visible goes, together with the containers that held only it, and when nothing
 * visible is left in the editor root at all, it goes back to one empty paragraph. Either kind of shell left behind would
 * take what is pasted or typed next.
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
  // Deleting the range empties the elements that hold its ends but keeps them, so record them first: what is left of
  // them is what the author deleted, not an empty element that was already there.
  const rangeEnds = collectRangeEnds(range, root);
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
      // The placeholder replaces the children that the merge point counted, so a caret placed by that count would sit
      // after the placeholder, and pasted or formatted text would then land below an empty line.
      const emptied = isEmptyBlock(remaining);
      fillPlaceholder(remaining);
      placeRange(range, point.container, emptied ? 0 : point.offset);
      return resetBlankRoot(range, root, rangeEnds) ?? remaining;
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
  if (endBlock !== undefined) {
    // After the line between structures is in, so that a structure left at the end of the range still has a line next
    // to it once an emptied code block after it is gone.
    removeEmptiedEnd(endBlock, block, root, emptiedElements, rangeEnds);
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
  return resetBlankRoot(range, root, rangeEnds) ?? block;
}

/**
 * Returns the elements that hold the start or the end of a range, up to the editor root.
 *
 * Deleting the range removes the elements it holds whole, but keeps these, emptied of the part it covers.
 *
 * @param range The range before the delete.
 * @param root The editor root. Not included.
 * @returns The elements that hold an end of the range.
 */
function collectRangeEnds(range: Range, root: Element): ReadonlySet<Element> {
  const ends = new Set<Element>();
  for (const container of [range.startContainer, range.endContainer]) {
    for (
      let current: Element | null = container instanceof Element ? container : container.parentElement;
      current !== null && current !== root;
      current = current.parentElement
    ) {
      ends.add(current);
    }
  }
  return ends;
}

/**
 * Removes the end block of a range delete when nothing visible is left in it, then removes outward, in turn, each
 * container that held only it.
 *
 * A container that holds the start block stays. Table cells, captions and details titles, and the blocks inside them,
 * stay as well, since the table skeleton and the title are kept by their guards.
 *
 * @param endBlock The block that held the end of the range.
 * @param block The block that held the start of the range.
 * @param root The editor root.
 * @param emptiedElements The elements a guard emptied instead of deleting.
 * @param rangeEnds The elements that held an end of the range before the delete.
 */
function removeEmptiedEnd(
  endBlock: Element,
  block: Element,
  root: Element,
  emptiedElements: readonly Element[],
  rangeEnds: ReadonlySet<Element>,
): void {
  if (
    endBlock === block
    || !root.contains(endBlock)
    || endBlock.contains(block)
    || emptiedElements.includes(endBlock)
    || isInStructurePart(endBlock, root)
    || !isBlankBlock(endBlock, rangeEnds)
  ) {
    return;
  }

  let container: Element | null = endBlock.parentElement;
  removeWithSeparator(endBlock);
  while (
    container !== null
    && container !== root
    && !container.contains(block)
    && CONTAINER_TAG_NAMES.has(container.localName)
    && [...container.childNodes].every((child) => isSeparatorText(child))
  ) {
    const parent = container.parentElement;
    removeWithSeparator(container);
    container = parent;
  }
}

/**
 * Determines whether a block is, or is inside, a table cell, a caption or a details title.
 *
 * @param block The block to inspect.
 * @param root The editor root. Not inspected.
 * @returns `true` for a part of a table skeleton or a title, or a block inside one.
 */
function isInStructurePart(block: Element, root: Element): boolean {
  for (let current: Element | null = block; current !== null && current !== root; current = current.parentElement) {
    // A code block and a details section are structures too, but they are not parts that a guard keeps: an emptied
    // code block goes, and the body of an open details section is the author's lines.
    if (isStructureElement(current) && current.localName !== 'pre' && current.localName !== 'details') {
      return true;
    }
  }
  return false;
}

/**
 * Determines whether a block shows nothing.
 *
 * Text other than whitespace and elements other than one `br` count as content. Format elements left empty count as
 * nothing, as they are editing artifacts that saving drops or what is left of a range the author deleted; one with
 * attributes that held no end of the range was empty before the delete and counts. Inside `pre`, every character
 * counts except the trailing line break, which forms no line, and the `code` right under it counts as nothing.
 *
 * @param block The block to inspect.
 * @param rangeEnds The elements that held an end of the range before the delete.
 * @returns `true` when nothing in the block shows.
 */
function isBlankBlock(block: Element, rangeEnds: ReadonlySet<Element>): boolean {
  const insidePre = block.localName === 'pre';
  const trailing = insidePre ? findTrailingPreBreak(block) : undefined;
  let breaks = 0;
  const walker = block.ownerDocument.createTreeWalker(
    block,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT,
  );
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text) {
      const data = node === trailing?.text ? node.data.slice(0, trailing.offset) : node.data;
      if (insidePre ? data.length > 0 : !isHtmlWhitespaceOnly(data)) {
        return false;
      }
      continue;
    }
    // An HTML comment is a note by the author. Treating it as nothing would let it go with the block.
    if (!(node instanceof Element)) {
      return false;
    }
    if (node.localName === 'br') {
      breaks += 1;
      if (breaks > 1) {
        return false;
      }
      continue;
    }
    // The `code` right under a `pre` is the frame of the code block, so its attributes, such as a language class, do not
    // keep an emptied code block from going.
    if (insidePre && node.localName === 'code' && node.parentNode === block) {
      continue;
    }
    // An empty element with attributes that held no end of the range was empty before the delete. It may be a link
    // target or a mark that saving keeps, so it counts as content and keeps its line from being replaced or removed.
    if (!BLANK_WRAPPER_TAG_NAMES.has(node.localName) || (node.attributes.length > 0 && !rangeEnds.has(node))) {
      return false;
    }
  }
  return true;
}

/**
 * Determines whether a node holds nothing that shows.
 *
 * @param node A child of the editor root, or a node inside one.
 * @param rangeEnds The elements that held an end of the range before the delete.
 * @returns `true` for whitespace, a blank line, or a list, blockquote or `div` that holds only those.
 */
function holdsNothing(node: Node, rangeEnds: ReadonlySet<Element>): boolean {
  if (node instanceof Text) {
    return isHtmlWhitespaceOnly(node.data);
  }
  if (!(node instanceof Element)) {
    return false;
  }
  const name = node.localName;
  if (name === 'ul' || name === 'ol' || (CONTAINER_TAG_NAMES.has(name) && hasBlockChild(node))) {
    return [...node.childNodes].every((child) => holdsNothing(child, rangeEnds));
  }
  return LINE_TAG_NAMES.has(name) && isBlankBlock(node, rangeEnds);
}

/**
 * Puts one empty paragraph in place of what a range delete left, when nothing in the editor root shows any more.
 *
 * A heading or a code block left empty would take the first line of what is pasted next, and an empty list would keep
 * its marker. The first element becomes the paragraph and the others go. HTML comments directly under the editor root
 * stay, as they are notes by the author that the range could not select.
 *
 * @param range The range after the delete. Moved to the start of the paragraph.
 * @param root The editor root.
 * @param rangeEnds The elements that held an end of the range before the delete.
 * @returns The empty paragraph, or `undefined` when something in the editor root still shows.
 */
function resetBlankRoot(range: Range, root: Element, rangeEnds: ReadonlySet<Element>): Element | undefined {
  const children = [...root.childNodes];
  if (!children.every((child) => child instanceof Comment || holdsNothing(child, rangeEnds))) {
    return undefined;
  }
  const [first, ...rest] = children.filter((child): child is Element => child instanceof Element);
  if (first === undefined) {
    return undefined;
  }

  const document = root.ownerDocument;
  let paragraph = first;
  if (first.localName === 'p') {
    first.replaceChildren(document.createElement('br'));
  } else {
    paragraph = createEmptyBlock(document, 'p');
    first.replaceWith(paragraph);
  }
  for (const element of rest) {
    removeWithSeparator(element);
  }
  placeRange(range, paragraph, 0);
  return paragraph;
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
