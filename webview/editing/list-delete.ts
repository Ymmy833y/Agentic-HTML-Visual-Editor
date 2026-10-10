import {
  BLOCK_SEPARATOR_TEXT,
  appendBlock,
  findBlock,
  hasBlockChild,
  isEmptyBlock,
  isHtmlWhitespaceOnly,
  isMergeableBlock,
  wrapInlineRuns,
} from './block';
import type { BlockRewriteProgress } from './block-format';
import { findMergeCandidate, mergeBlocks, removeWithSeparator } from './block-merge';
import type { MergePoint } from './block-merge';
import { isAtBlockStart, placeCaret } from './caret';
import { mergeFollowingList } from './list-merge';
import { removeItemWithEmptyLists } from './list-split';
import {
  findFirstBlockChild,
  findItemLine,
  findMergeTarget,
  isAtItemLineEnd,
  isAtItemLineStart,
  isFirstItem,
  isListItem,
  readListKind,
} from './list-structure';
import type { ItemLine } from './list-structure';

/**
 * The source and merge target of a backward delete merge.
 *
 * The source is one of: an item line, the block right after a list, or the block child right after the own
 * content inside an item. The merge target is an item or the block (element) at the end of an item, or the own
 * content of an item.
 */
export type ListMerge =
  | { readonly kind: 'line'; readonly line: ItemLine; readonly target: Element }
  | { readonly kind: 'block'; readonly block: Element; readonly target: Element }
  | { readonly kind: 'ownContent'; readonly block: Element; readonly item: Element };

/**
 * Returns the first item only when a caret with no range is at the start of its item line.
 *
 * @param root The editor root.
 * @param range The range.
 * @returns The first item, or `undefined` when there is a range selection or at any other position.
 */
export function findFirstItemAtLineStart(root: Element, range: Range): Element | undefined {
  if (!range.collapsed) {
    return undefined;
  }
  const line = findItemLine(range.startContainer, root, true);
  if (line === undefined || !isAtItemLineStart(range, line) || !isFirstItem(line.item)) {
    return undefined;
  }
  return line.item;
}

/**
 * Decides the source and merge target for a backward delete at a list boundary that block merge cannot handle.
 * Changes neither the tree nor the selection.
 *
 * Common editors join with the visually preceding line on backward delete. Block merge does nothing when
 * either side has block children, so those positions are taken over here.
 *
 * @param root The editor root.
 * @param range The range.
 * @returns The merge, or `undefined` when there is a range selection, at positions left to block merge, or when
 *   there is no merge target.
 */
export function readListMerge(root: Element, range: Range): ListMerge | undefined {
  if (!range.collapsed) {
    return undefined;
  }

  const line = findItemLine(range.startContainer, root, true);
  if (line !== undefined) {
    return isAtItemLineStart(range, line) ? readLineMerge(line) : undefined;
  }

  const block = findBlock(range.startContainer, root);
  if (
    block === undefined
    || block.localName === 'li'
    || !isMergeableBlock(block)
    || !isAtBlockStart(range, block)
  ) {
    return undefined;
  }

  const item = block.parentElement;
  if (item !== null && isListItem(item) && findFirstBlockChild(item) === block) {
    return { kind: 'ownContent', block, item };
  }

  const previous = findMergeCandidate(block, 'backward');
  if (previous === undefined || readListKind(previous) === undefined) {
    return undefined;
  }
  const target = findMergeTarget(previous);
  return target === undefined ? undefined : { kind: 'block', block, target };
}

/**
 * Merges into the end of the merge target.
 *
 * @param merge The merge.
 * @param progress The holder of whether the tree was changed. Set to true on each rewrite, and the caret is
 *   placed at the merge point.
 */
export function applyListMerge(merge: ListMerge, progress: BlockRewriteProgress): void {
  switch (merge.kind) {
    case 'line':
      mergeItemLine(merge.line, merge.target, progress);
      return;
    case 'block':
      mergeBlockAfterList(merge.block, merge.target, progress);
      return;
    case 'ownContent':
      mergeIntoOwnContent(merge.block, merge.item, progress);
      return;
  }
}

/**
 * Returns whether to stop a forward delete at the end of the own content of an item with block children.
 * Changes neither the tree nor the selection.
 *
 * Block merge does not treat this position as an edge, so it would fall through to the browser default. The
 * default merge cannot be controlled and may break the structure of nested lists.
 *
 * @param root The editor root.
 * @param range The range.
 * @returns `true` only when there is no range selection and the caret is at the end of the own content of an
 *   item with block children (including an empty line). `false` for an item whose line is a paragraph, which is
 *   left to block merge as the edge of the paragraph.
 */
export function isAtBlockItemOwnContentEnd(root: Element, range: Range): boolean {
  if (!range.collapsed) {
    return false;
  }
  const line = findItemLine(range.startContainer, root, false);
  if (line === undefined || line.block !== undefined || !hasBlockChild(line.item)) {
    return false;
  }
  return isAtItemLineEnd(range, line);
}

/**
 * Decides the merge at the start of an item line.
 *
 * @param line The item line.
 * @returns The merge, or `undefined` at positions block merge can handle, such as between two inline-only items.
 */
function readLineMerge(line: ItemLine): ListMerge | undefined {
  const item = line.item;
  const previous = findMergeCandidate(item, 'backward');
  if (previous === undefined) {
    return undefined;
  }
  const previousIsList = readListKind(previous) !== undefined;
  if (!previousIsList && previous.localName !== 'li') {
    return undefined;
  }

  const unmergeable = previousIsList
    || line.block !== undefined
    || hasBlockChild(item)
    || hasBlockChild(previous);
  if (!unmergeable) {
    return undefined;
  }
  const target = findMergeTarget(previous);
  return target === undefined ? undefined : { kind: 'line', line, target };
}

/**
 * Merges an item line into the end of the merge target and removes the item.
 *
 * The children the item has after the line move to the end of the previous item, keeping the visual levels and
 * order.
 *
 * @param line The item line of the source item.
 * @param target The merge target.
 * @param progress The holder of whether the tree was changed.
 */
function mergeItemLine(line: ItemLine, target: Element, progress: BlockRewriteProgress): void {
  if (isEmptyBlock(target)) {
    removeTarget(target, progress);
    return;
  }

  const item = line.item;
  const previous = findMergeCandidate(item, 'backward');
  let point: MergePoint | undefined;
  if (line.block !== undefined) {
    point = mergeBlocks(target, line.block);
  } else if (!hasBlockChild(item)) {
    point = mergeBlocks(target, item);
  } else {
    point = moveOwnContent(item, target);
  }
  if (point === undefined) {
    return;
  }
  progress.changed = true;

  if (item.isConnected && previous !== undefined) {
    const moved = moveRemainingChildren(item, previous);
    removeWithSeparator(item);
    const first = moved.find((node): node is Element => node instanceof Element);
    const before = first === undefined ? undefined : findMergeCandidate(first, 'backward');
    if (first !== undefined && readListKind(first) !== undefined && before !== undefined) {
      mergeFollowingList(before, progress);
    }
  }
  placeCaret(point.container, point.offset);
}

/**
 * Merges the block right after a list into the end of the merge target and removes it.
 *
 * @param block The source block.
 * @param target The merge target.
 * @param progress The holder of whether the tree was changed.
 */
function mergeBlockAfterList(block: Element, target: Element, progress: BlockRewriteProgress): void {
  if (isEmptyBlock(target)) {
    removeTarget(target, progress);
    return;
  }

  const previousList = findMergeCandidate(block, 'backward');
  const point = mergeBlocks(target, block);
  if (point === undefined) {
    return;
  }
  progress.changed = true;
  // Once the block in between is gone, lists of the same kind become adjacent: a single list would look split
  // by a gap, and the numbering would restart from 1.
  if (previousList !== undefined) {
    mergeFollowingList(previousList, progress);
  }
  placeCaret(point.container, point.offset);
}

/**
 * Merges the block child right after the own content inside an item into the end of the own content.
 *
 * @param block The source block child.
 * @param item The item.
 * @param progress The holder of whether the tree was changed.
 */
function mergeIntoOwnContent(block: Element, item: Element, progress: BlockRewriteProgress): void {
  const ownContent = collectOwnContent(item, block);
  if (isEmptyContent(ownContent)) {
    // Remove the empty side and keep the block as the item line. The kind of the block is kept as it is.
    progress.changed = true;
    for (const node of ownContent) {
      node.remove();
    }
    return;
  }

  progress.changed = true;
  if (isEmptyBlock(block)) {
    removeWithSeparator(block);
    placeCaretAtOwnContentEnd(item);
    return;
  }

  // Leaving the newline between the own content and the block would put whitespace inside the joined content.
  for (let node = block.previousSibling; node !== null && isSeparator(node); node = block.previousSibling) {
    node.remove();
  }
  const offset = [...item.childNodes].indexOf(block);
  for (let node = block.firstChild; node !== null && isSeparator(node); node = block.firstChild) {
    node.remove();
  }
  block.before(...block.childNodes);
  block.remove();
  placeCaret(item, offset);
}

/**
 * Removes an empty merge target.
 *
 * For an item, lists left without items are removed too. When removing the block at the end of an item leaves
 * nothing in the item, the item is removed as well. An item with no content would leave a line with only its
 * marker.
 *
 * @param target The empty merge target.
 * @param progress The holder of whether the tree was changed.
 */
function removeTarget(target: Element, progress: BlockRewriteProgress): void {
  if (isListItem(target)) {
    removeItemWithEmptyLists(target, progress);
    return;
  }

  const item = target.parentElement;
  progress.changed = true;
  removeWithSeparator(target);
  if (item !== null && isListItem(item) && [...item.childNodes].every(isSeparator)) {
    removeItemWithEmptyLists(item, progress);
  }
}

/**
 * Moves the own content of an item with block children to the end of the merge target.
 *
 * @param item The item.
 * @param target The merge target.
 * @returns The merge point. When the own content is empty, it is removed instead of moved, and the end of the
 *   merge target is returned.
 */
function moveOwnContent(item: Element, target: Element): MergePoint {
  const point = { container: target, offset: target.childNodes.length };
  const ownContent = collectOwnContent(item, findFirstBlockChild(item));
  if (isEmptyContent(ownContent)) {
    // The placeholder of an empty line is not content. Left in place, it would be carried along with the
    // following children and add an empty line.
    for (const node of ownContent) {
      node.remove();
    }
    return point;
  }

  // The newlines at both ends separate lines and are not content. They are left in place rather than moved, and
  // removed when the following children are carried.
  let start = 0;
  let end = ownContent.length;
  while (start < end && isSeparator(ownContent[start])) {
    start += 1;
  }
  while (end > start && isSeparator(ownContent[end - 1])) {
    end -= 1;
  }
  target.append(...ownContent.slice(start, end));
  return point;
}

/**
 * Moves the children left in an item to the end of the previous item. When the previous sibling is a
 * handwritten list, they are lined up right after it instead.
 *
 * @param item The source item. The content of its line has already been moved.
 * @param previous The previous sibling item or list.
 * @returns What was moved (block children, paragraphs wrapping runs, HTML comments), in document order.
 */
function moveRemainingChildren(item: Element, previous: Element): ChildNode[] {
  const document = item.ownerDocument;
  const moved = wrapInlineRuns([...item.childNodes], document);
  let anchor: ChildNode = previous;
  for (const node of moved) {
    if (previous.localName === 'li') {
      appendBlock(node, previous);
      continue;
    }
    anchor.after(document.createTextNode(BLOCK_SEPARATOR_TEXT), node);
    anchor = node;
  }
  return moved;
}

/**
 * Places the caret at the end of the own content.
 *
 * @param item The item.
 */
function placeCaretAtOwnContentEnd(item: Element): void {
  const boundary = findFirstBlockChild(item);
  placeCaret(item, boundary === undefined ? item.childNodes.length : [...item.childNodes].indexOf(boundary));
}

/**
 * Returns the children before the boundary (the own content).
 *
 * @param item The item.
 * @param boundary The first block child.
 * @returns The nodes of the own content, in document order.
 */
function collectOwnContent(item: Element, boundary: Element | undefined): ChildNode[] {
  const nodes: ChildNode[] = [];
  for (let node = item.firstChild; node !== null && node !== boundary; node = node.nextSibling) {
    nodes.push(node);
  }
  return nodes;
}

/**
 * Determines whether content is empty (whitespace and at most one `br`). Uses the same line as the empty-block
 * check, so a line holding only a placeholder counts as empty.
 *
 * @param nodes The nodes of the content.
 * @returns `true` when empty.
 */
function isEmptyContent(nodes: readonly Node[]): boolean {
  let breaks = 0;
  for (const node of nodes) {
    if (isSeparator(node)) {
      continue;
    }
    if (node instanceof Element && node.localName === 'br' && breaks === 0) {
      breaks += 1;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Determines whether a node is whitespace-only text.
 *
 * @param node The node to check.
 * @returns `true` for whitespace-only text.
 */
function isSeparator(node: Node): boolean {
  return node instanceof Text && isHtmlWhitespaceOnly(node.data);
}
