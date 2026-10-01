import {
  NESTED_BLOCK_TAG_NAMES,
  createEmptyBlock,
  fillPlaceholder,
  hasBlockChild,
  insertBlock,
  isHtmlWhitespaceOnly,
} from './block';
import type { BlockRewriteProgress } from './block-format';
import { removeWithSeparator } from './block-merge';
import { extractSplitTail } from './block-split';
import { placeCaretAtStart } from './caret';
import {
  findFirstBlockChild,
  findItemLine,
  findTrailingEmptyParagraph,
  isAtItemLineEnd,
  isAtItemLineStart,
  isBlankItem,
  isEmptyItem,
  readListKind,
} from './list-structure';
import type { ItemLine } from './list-structure';

/**
 * How paragraph insertion is taken over, paired with its target.
 *
 * One of 3: outdent, leaving from the trailing empty paragraph (the paragraph), or splitting the item (the item
 * line). Not taking it over is not part of the type; it is represented as `undefined`.
 */
export type ListEnter =
  | { readonly kind: 'outdent' }
  | { readonly kind: 'exit'; readonly paragraph: Element }
  | { readonly kind: 'split'; readonly line: ItemLine };

/**
 * Decides how paragraph insertion is taken over from the range and the caret position. Changes neither the tree
 * nor the selection.
 *
 * An item with block children is split into items rather than getting a line break within a block, which keeps
 * Enter distinct from a line break within a block. A non-empty inline-only item is left to block splitting.
 *
 * @param root The editor root.
 * @param range The range.
 * @returns How it is taken over, or `undefined` when it is not taken over.
 */
export function readListEnter(root: Element, range: Range): ListEnter | undefined {
  const trailing = findTrailingEmptyParagraph(root, range);
  const owner = trailing?.parentElement;
  if (trailing !== undefined && owner !== null && owner !== undefined) {
    // With no content besides the paragraph, it looks the same as an empty item, so outdent.
    return isBlankItem(owner) ? { kind: 'outdent' } : { kind: 'exit', paragraph: trailing };
  }

  const line = findItemLine(range.startContainer, root, false);
  if (line === undefined) {
    return undefined;
  }
  if (range.collapsed && isEmptyItem(line.item)) {
    return { kind: 'outdent' };
  }
  return hasBlockChild(line.item) ? { kind: 'split', line } : undefined;
}

/**
 * Removes the trailing empty paragraph, creates an empty item right after the item, and places the caret in it.
 *
 * @param paragraph The trailing empty paragraph.
 * @param progress The holder of whether the tree was changed.
 */
export function exitTrailingParagraph(paragraph: Element, progress: BlockRewriteProgress): void {
  const item = paragraph.parentElement;
  if (item === null) {
    return;
  }

  removeWithSeparator(paragraph);
  progress.changed = true;
  const next = createEmptyBlock(item.ownerDocument, 'li');
  insertBlock(next, item, 'after');
  placeCaretAtStart(next);
}

/**
 * Splits an item with block children at the caret position to create a new item.
 *
 * At the end of the line, when the first block child after the line is a list, an empty item is put at its
 * start. This makes the next line without changing the parent of the nested items. At any other end position
 * and in the middle, everything from the caret to the end of the line, plus the children after the line, moves
 * to a new item right after. At the start of the line, an empty item is put right before, and the caret stays
 * in the original item.
 *
 * @param line The item line.
 * @param range A collapsed range.
 * @param progress The holder of whether the tree was changed.
 */
export function splitItemAtCaret(line: ItemLine, range: Range, progress: BlockRewriteProgress): void {
  const item = line.item;
  const document = item.ownerDocument;
  // An empty line is both the start and the end, so it is treated as the end. The next line is created, and
  // Enter looks as if it moved one line down.
  if (isAtItemLineEnd(range, line)) {
    const after = findFirstBlockAfterLine(line);
    if (after !== undefined && readListKind(after) !== undefined) {
      const empty = createEmptyBlock(document, 'li');
      const first = after.firstElementChild;
      if (first === null) {
        after.append(empty);
      } else {
        insertBlock(empty, first, 'before');
      }
      progress.changed = true;
      placeCaretAtStart(empty);
      return;
    }
  } else if (isAtItemLineStart(range, line)) {
    insertBlock(createItemLike(line), item, 'before');
    progress.changed = true;
    placeCaretAtStart(line.block ?? item);
    return;
  }

  const lineBlock = line.block;
  const boundary = findFirstBlockChild(item);
  const moved = lineBlock === undefined
    ? extractSplitTail(range, item, boundary === undefined ? item.childNodes.length : indexOf(boundary))
    : extractSplitTail(range, lineBlock, lineBlock.childNodes.length);
  progress.changed = true;

  // Attributes are not copied to the new item and paragraph. Copying them would duplicate even `id` and the
  // internal attributes.
  const next = document.createElement('li');
  let caretTarget: Element = next;
  if (lineBlock === undefined) {
    next.append(moved);
  } else {
    const paragraph = document.createElement('p');
    paragraph.append(moved);
    fillPlaceholder(paragraph);
    next.append(paragraph);
    caretTarget = paragraph;
  }
  next.append(...collectNodesAfterLine(line, boundary));

  if (lineBlock === undefined) {
    fillOwnContentPlaceholder(next);
    fillOwnContentPlaceholder(item);
  } else {
    fillPlaceholder(lineBlock);
  }
  insertBlock(next, item, 'after');
  placeCaretAtStart(caretTarget);
}

/**
 * Creates an empty item with the same shape as the original line (own content or a paragraph).
 *
 * Creating an item without a paragraph from an item whose line is a paragraph would change the HTML shape, and
 * the next operation would treat the lines inconsistently.
 *
 * @param line The item line.
 * @returns The empty item.
 */
function createItemLike(line: ItemLine): Element {
  const document = line.item.ownerDocument;
  if (line.block === undefined) {
    return createEmptyBlock(document, 'li');
  }
  const item = document.createElement('li');
  item.append(createEmptyBlock(document, 'p'));
  return item;
}

/**
 * Returns the first block child after the line.
 *
 * @param line The item line.
 * @returns The first block child after the line, or `undefined` when there is none.
 */
function findFirstBlockAfterLine(line: ItemLine): Element | undefined {
  if (line.block === undefined) {
    return findFirstBlockChild(line.item);
  }
  for (let element = line.block.nextElementSibling; element !== null; element = element.nextElementSibling) {
    if (NESTED_BLOCK_TAG_NAMES.has(element.localName)) {
      return element;
    }
  }
  return undefined;
}

/**
 * Returns the children after the line: what moves to the new item, including the newline between the line and
 * the block children after it.
 *
 * @param line The item line.
 * @param boundary The first block child, when the own content is the line.
 * @returns The children after the line, in document order.
 */
function collectNodesAfterLine(line: ItemLine, boundary: Element | undefined): Node[] {
  const start = line.block === undefined ? boundary : line.block.nextSibling;
  const nodes: Node[] = [];
  for (let node: Node | null = start ?? null; node !== null; node = node.nextSibling) {
    nodes.push(node);
  }
  return nodes;
}

/**
 * Puts a placeholder that keeps the line's height when the own content is empty.
 *
 * Own content of only whitespace before the block children has no height, and the item's marker would appear
 * attached to the line of the block child.
 *
 * @param item The item.
 */
function fillOwnContentPlaceholder(item: Element): void {
  const boundary = findFirstBlockChild(item);
  if (boundary === undefined) {
    fillPlaceholder(item);
    return;
  }
  for (let node = item.firstChild; node !== null && node !== boundary; node = node.nextSibling) {
    if (!(node instanceof Text) || !isHtmlWhitespaceOnly(node.data)) {
      return;
    }
  }
  item.prepend(item.ownerDocument.createElement('br'));
}

/**
 * Returns the position of an element among its parent's children.
 *
 * @param element The child.
 * @returns The position.
 */
function indexOf(element: Element): number {
  return [...(element.parentNode?.childNodes ?? [])].indexOf(element);
}
