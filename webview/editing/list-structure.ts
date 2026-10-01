import {
  NESTED_BLOCK_TAG_NAMES,
  findBlock,
  hasBlockChild,
  isEmptyBlock,
  isHtmlWhitespaceOnly,
  isMergeableBlock,
} from './block';
import { findMergeCandidate } from './block-merge';
import { isAtBlockEnd, isAtBlockStart } from './caret';

/**
 * Identifiers of the list kinds.
 *
 * The "none" of the query is not an identifier; it is represented as `undefined`. Kept apart from the spelling
 * of the toolbar slots, so that the values of the list operations stay the same even if a slot is renamed.
 */
export const LIST_KIND = {
  bullet: 'bullet',
  ordered: 'ordered',
} as const;

/** A list kind. Values not in the table above are not accepted. */
export type ListKind = (typeof LIST_KIND)[keyof typeof LIST_KIND];

/** One-to-one mapping from list kind to the name of the element created for it. */
export const LIST_KIND_TAG_NAME: Readonly<Record<ListKind, string>> = {
  bullet: 'ul',
  ordered: 'ol',
};

// Reverse lookup from element name to list kind. Built from the list of kinds, so the mapping is not written in
// two places.
const LIST_KIND_BY_TAG_NAME: ReadonlyMap<string, ListKind> = new Map(
  Object.values(LIST_KIND).map((kind): [string, ListKind] => [LIST_KIND_TAG_NAME[kind], kind]),
);

/**
 * The elements at which the search for the owning item stops. The search for the lists to switch stops at the
 * same elements, so the two searches draw the same boundary.
 *
 * Inside a table cell or a collapsible section, editing works as usual within it. Treating an outer item beyond
 * it as the owning item would unwrap the outer list when a button is pressed inside, and Tab inside a cell would
 * compete with moving between cells.
 */
export const OWNING_ITEM_STOP_TAG_NAMES: ReadonlySet<string> = new Set(['td', 'th', 'details']);

// First-child blocks treated as the item line only for backward delete. This shape is left behind after an
// empty own content is removed by a merge; without treating it as the line, backward delete at the start would
// do nothing. Enter, conversion and insertion do not treat it as the line.
const BACKWARD_LINE_TAG_NAMES: ReadonlySet<string> = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'div',
  'blockquote',
]);

/**
 * The item line of a list item: the extent in which Enter and backward delete decide the start and end of the
 * item.
 *
 * The own content has no element of its own, so it is paired with the item and passed with the same type as a
 * block that is the line.
 */
export interface ItemLine {
  /** The item the line belongs to. */
  readonly item: Element;
  /** The block that is the line. `undefined` when the own content is the line. */
  readonly block: Element | undefined;
}

/**
 * Returns the list kind from the element name of a list.
 *
 * Attributes such as the start number and reversed order are not looked at.
 *
 * @param element The element to check.
 * @returns The list kind, or `undefined` when it is not a list.
 */
export function readListKind(element: Element): ListKind | undefined {
  return LIST_KIND_BY_TAG_NAME.get(element.localName);
}

/**
 * Determines whether an element is a list item (an `li` directly under a list).
 *
 * @param element The element to check.
 * @returns `true` only for an `li` whose parent is a `ul` or `ol`.
 */
export function isListItem(element: Element): boolean {
  const parent = element.parentElement;
  return element.localName === 'li' && parent !== null && readListKind(parent) !== undefined;
}

/**
 * Determines whether a node directly under a list is a child that justifies keeping the list: an item, or a
 * list placed directly under the list in handwritten HTML.
 *
 * A list left with only other elements such as paragraphs is removed, since it would leave only empty space and
 * no items. A nested list is kept inside the list to preserve its visual level.
 *
 * @param node A node directly under a list.
 * @returns `true` for an `li`, `ul` or `ol`.
 */
export function isItemOrList(node: Node): boolean {
  return node instanceof Element && (node.localName === 'li' || readListKind(node) !== undefined);
}

/**
 * Returns the innermost item containing the start point (the owning item).
 *
 * Deciding the mode of an operation and querying the list kind both use this one function, so the pressed state
 * and the direction of the result of pressing never disagree.
 *
 * @param node The node at the start of the selection.
 * @param root The editor root.
 * @returns The owning item, or `undefined` when a cell or collapsible section is reached before an item, when
 *   the node is not inside any item, or when the node is outside the editor root.
 */
export function findOwningItem(node: Node, root: Element): Element | undefined {
  if (!root.contains(node)) {
    return undefined;
  }

  let current: Element | null = node instanceof Element ? node : node.parentElement;
  while (current !== null && current !== root) {
    if (OWNING_ITEM_STOP_TAG_NAMES.has(current.localName)) {
      return undefined;
    }
    if (isListItem(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return undefined;
}

/**
 * Decides the item line of an item.
 *
 * For an item whose own content is only whitespace and whose first child is a paragraph (the shape of a loose
 * Markdown list), that paragraph is the line. Left as a plain paragraph, neither a backward delete at its start
 * nor Enter at its end would be treated as acting on the edge of the item.
 *
 * @param item The item.
 * @param backwardDelete Whether this is for backward delete. When `true`, a first child that is a heading,
 *   `div` or blockquote with inline-only children is also taken as the line.
 * @returns The item line. When neither applies, the own content is the line, even if it is empty.
 */
export function readItemLine(item: Element, backwardDelete: boolean): ItemLine {
  const leading = findLeadingBlock(item);
  if (leading?.localName === 'p') {
    return { item, block: leading };
  }
  if (
    backwardDelete
    && leading !== undefined
    && BACKWARD_LINE_TAG_NAMES.has(leading.localName)
    && !hasBlockChild(leading)
  ) {
    return { item, block: leading };
  }
  return { item, block: undefined };
}

/**
 * Returns the item line that contains a node.
 *
 * Only the innermost item containing the node is looked at. The Enter, backward delete and forward delete rules
 * all find the item line with this same decision.
 *
 * @param node The node at the start of the range.
 * @param root The editor root.
 * @param backwardDelete Whether this is for backward delete.
 * @returns The item line, or `undefined` inside a block child that is not the line and in bare text after the
 *   first block child.
 */
export function findItemLine(node: Node, root: Element, backwardDelete: boolean): ItemLine | undefined {
  const item = findInnermostItem(node, root);
  if (item === undefined) {
    return undefined;
  }

  const line = readItemLine(item, backwardDelete);
  // A position whose container is the item itself is treated as inside the line, because the code that places
  // the caret only creates such positions at the start of the item or at the end of its own content.
  if (node === item) {
    return line;
  }

  const child = findChildContaining(item, node);
  if (line.block !== undefined) {
    return child === line.block ? line : undefined;
  }

  const boundary = findFirstBlockChild(item);
  if (boundary === undefined) {
    return line;
  }
  return child !== undefined && isBefore(child, boundary) ? line : undefined;
}

/**
 * Determines whether the caret is at the start of an item line.
 *
 * Uses the same function as the check for the edge of a block, so the line drawn here matches that of the
 * backward delete merge.
 *
 * @param range A collapsed range.
 * @param line The item line.
 * @returns `true` at the start of the line.
 */
export function isAtItemLineStart(range: Range, line: ItemLine): boolean {
  return isAtBlockStart(range, line.block ?? line.item);
}

/**
 * Determines whether the caret is at the end of an item line.
 *
 * For the own content, the first block child is passed as the boundary, so the block children after it do not
 * count as content of the line. A trailing placeholder does not count as content either.
 *
 * @param range A collapsed range.
 * @param line The item line.
 * @returns `true` at the end of the line.
 */
export function isAtItemLineEnd(range: Range, line: ItemLine): boolean {
  if (line.block !== undefined) {
    return isAtBlockEnd(range, line.block);
  }
  return isAtBlockEnd(range, line.item, findFirstBlockChild(line.item));
}

/**
 * Returns the first block child. The own content is whatever comes before it.
 *
 * Enter, backward delete, forward delete and unwrap all decide the end of the item line with this one decision.
 * With separate decisions, fixing one of them would make the extent of the item line differ between operations.
 *
 * @param item The item.
 * @returns The first block child, or `undefined` when there is none.
 */
export function findFirstBlockChild(item: Element): Element | undefined {
  for (const child of item.children) {
    if (NESTED_BLOCK_TAG_NAMES.has(child.localName)) {
      return child;
    }
  }
  return undefined;
}

/**
 * Determines whether an element is a paragraph that is an item line.
 *
 * A paragraph that is the line is excluded from block conversion and from markdown-style autoformat. Converting
 * it to a heading would leave the item without a line, so neither a backward delete at its start nor Enter at
 * its end would act on the edge of the item.
 *
 * @param element The element to check.
 * @returns `true` only for a `p` whose parent is an item and whose preceding siblings are all whitespace-only
 *   text.
 */
export function isItemLineParagraph(element: Element): boolean {
  const parent = element.parentElement;
  return element.localName === 'p'
    && parent !== null
    && isListItem(parent)
    && findLeadingBlock(parent) === element;
}

/**
 * Determines whether an item is an empty item (one that gets outdented).
 *
 * Only an item with no block children that passes the empty-block check (whitespace and at most one `br`) is
 * empty. Block children are elements other than `br`, so the empty-block check already excludes them.
 *
 * @param item The item.
 * @returns `true` for an empty item.
 */
export function isEmptyItem(item: Element): boolean {
  return isEmptyBlock(item);
}

/**
 * Determines whether an item is a blank item.
 *
 * An item whose line paragraph is empty looks like the same single line as an empty item. The items removed
 * after an insertion and the items outdented by Enter are aligned by this decision.
 *
 * @param item The item.
 * @returns `true` for an empty item, or when the line paragraph holds only a placeholder and the item has no
 *   content besides the line.
 */
export function isBlankItem(item: Element): boolean {
  if (isEmptyItem(item)) {
    return true;
  }
  const line = readItemLine(item, false);
  const block = line.block;
  if (block === undefined || !isEmptyBlock(block)) {
    return false;
  }
  return [...item.childNodes].every((child) => child === block || isWhitespaceText(child));
}

/**
 * Returns the trailing empty paragraph that holds the caret.
 *
 * It is a placeholder-only paragraph that is the last child (ignoring whitespace-only text) of an item with
 * block children. If Enter here could not leave the item, there would be no way to create the next item after
 * a table or similar.
 *
 * @param root The editor root.
 * @param range The range.
 * @returns The trailing empty paragraph, or `undefined` when there is a range selection or at any other position.
 */
export function findTrailingEmptyParagraph(root: Element, range: Range): Element | undefined {
  if (!range.collapsed) {
    return undefined;
  }

  const block = findBlock(range.startContainer, root);
  const item = block?.parentElement;
  if (
    block === undefined
    || item === null
    || item === undefined
    || block.localName !== 'p'
    || !isEmptyBlock(block)
    || !isListItem(item)
  ) {
    return undefined;
  }
  return readLastChild(item, false) === block ? block : undefined;
}

/**
 * Determines whether an item is a top-level item (one promoted to a paragraph when outdented).
 *
 * @param item The item.
 * @returns `true` when the parent of its list is neither an item nor a list (such as directly under the editor
 *   root, a cell or a collapsible section).
 */
export function isTopLevelItem(item: Element): boolean {
  const container = item.parentElement?.parentElement;
  if (container === null || container === undefined) {
    return true;
  }
  return !isListItem(container) && readListKind(container) === undefined;
}

/**
 * Returns the previous item, which is where indent moves an item to.
 *
 * @param item The item.
 * @returns That item, only when the immediately preceding sibling (skipping whitespace-only text and comments) is
 *   an item. `undefined` when it is a list or bare text.
 */
export function findPreviousItem(item: Element): Element | undefined {
  const previous = findMergeCandidate(item, 'backward');
  return previous?.localName === 'li' ? previous : undefined;
}

/**
 * Determines whether an item is the first item (no item of the same list before it).
 *
 * An item directly preceded by a handwritten list is not a first item. There is visibly a line before it, so
 * it is merged with the visually preceding line instead of being outdented.
 *
 * @param item The item.
 * @returns `true` when there is no preceding sibling once whitespace and comments are skipped.
 */
export function isFirstItem(item: Element): boolean {
  for (let node = item.previousSibling; node !== null; node = node.previousSibling) {
    if (node instanceof Comment || isWhitespaceText(node)) {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Returns where backward delete moves content to (the visually preceding line).
 *
 * When the previous item has a nested list, the visually preceding line is its deepest last item. Joining to
 * the previous item without descending there would skip over the nested lines and join with a distant line.
 *
 * @param start The starting point: a preceding sibling item or a preceding sibling list.
 * @returns The merge target: an item with no block children, or a mergeable block at the end of an item.
 *   `undefined` when the last child cannot be merged into, such as a horizontal rule, table, code block or
 *   collapsible section.
 */
export function findMergeTarget(start: Element): Element | undefined {
  let item = readListKind(start) === undefined ? start : findLastItem(start);
  while (item !== undefined) {
    if (!hasBlockChild(item)) {
      return item;
    }
    const last = readLastChild(item, true);
    if (!(last instanceof Element)) {
      return undefined;
    }
    if (readListKind(last) === undefined) {
      return isMergeableBlock(last) ? last : undefined;
    }
    item = findLastItem(last);
  }
  return undefined;
}

/**
 * Returns the innermost item containing a node. Does not stop at cells or collapsible sections.
 *
 * @param node The node to check.
 * @param root The editor root.
 * @returns The innermost item, or `undefined` when there is none.
 */
function findInnermostItem(node: Node, root: Element): Element | undefined {
  if (!root.contains(node)) {
    return undefined;
  }

  let current: Element | null = node instanceof Element ? node : node.parentElement;
  while (current !== null && current !== root) {
    if (isListItem(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return undefined;
}

/**
 * Returns the first-child block that has only whitespace-only text before it.
 *
 * @param item The item.
 * @returns The first child when it is a block child, or `undefined` when the item has own content.
 */
function findLeadingBlock(item: Element): Element | undefined {
  for (const child of item.childNodes) {
    if (isWhitespaceText(child)) {
      continue;
    }
    return child instanceof Element && NESTED_BLOCK_TAG_NAMES.has(child.localName) ? child : undefined;
  }
  return undefined;
}

/**
 * Returns the direct child of a parent that contains a node.
 *
 * @param parent The parent.
 * @param node The node to check.
 * @returns The direct child containing the node, or `undefined` when none does.
 */
function findChildContaining(parent: Element, node: Node): Node | undefined {
  let current: Node | null = node;
  while (current !== null && current.parentNode !== parent) {
    current = current.parentNode;
  }
  return current ?? undefined;
}

/**
 * Determines whether one child of a parent comes before another child of the same parent.
 *
 * @param node The child to check.
 * @param other The child to compare with.
 * @returns `true` when `node` comes before `other`.
 */
function isBefore(node: Node, other: Node): boolean {
  return (node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/**
 * Returns the last item of a list. When the last direct child is a handwritten list, descends to the last item
 * inside it.
 *
 * @param list The list.
 * @returns The last item, or `undefined` when there is none.
 */
function findLastItem(list: Element): Element | undefined {
  const last = readLastChild(list, true);
  if (!(last instanceof Element)) {
    return undefined;
  }
  if (last.localName === 'li') {
    return last;
  }
  return readListKind(last) === undefined ? undefined : findLastItem(last);
}

/**
 * Returns the last child, ignoring whitespace-only text (and comments, when asked).
 *
 * @param parent The parent.
 * @param skipComments Whether to skip comments too.
 * @returns The last child, or `undefined` when there is none.
 */
function readLastChild(parent: Element, skipComments: boolean): ChildNode | undefined {
  for (let node = parent.lastChild; node !== null; node = node.previousSibling) {
    if (isWhitespaceText(node) || (skipComments && node instanceof Comment)) {
      continue;
    }
    return node;
  }
  return undefined;
}

/**
 * Determines whether a node is whitespace-only text: the newline and indentation between lines, which do not
 * count as content.
 *
 * @param node The node to check.
 * @returns `true` for whitespace-only text.
 */
function isWhitespaceText(node: Node): boolean {
  return node instanceof Text && isHtmlWhitespaceOnly(node.data);
}
