import { BLOCK_SEPARATOR_TEXT, appendBlock, insertBlock, isHtmlWhitespaceOnly, wrapInlineRuns } from './block';
import type { BlockRewriteProgress } from './block-format';
import { unwrapItems } from './list-convert';
import { appendItems, moveItems } from './list-merge';
import { removeEmptyList, splitListAround } from './list-split';
import {
  LIST_KIND_TAG_NAME,
  findPreviousItem,
  isItemOrList,
  isListItem,
  isTopLevelItem,
  readListKind,
} from './list-structure';
import type { ListKind } from './list-structure';

/**
 * Moves the target items together into the nested list of the previous item.
 *
 * If the last child of the previous item is a list of the same kind, they go to its end; otherwise a new list
 * of the same kind is created for them. An item's nested lists and block children move with it. When there is
 * no previous item (the first item, or one directly preceded by a handwritten list), nothing is rewritten.
 *
 * @param items Consecutive items directly under one list, in document order.
 * @param progress The holder of whether the tree was changed. Set to true when items are moved.
 */
export function indentItems(items: readonly Element[], progress: BlockRewriteProgress): void {
  const first = items.at(0);
  const last = items.at(-1);
  const list = first?.parentElement;
  const kind = list === null || list === undefined ? undefined : readListKind(list);
  const previous = first === undefined ? undefined : findPreviousItem(first);
  if (first === undefined || last === undefined || kind === undefined || previous === undefined) {
    return;
  }

  progress.changed = true;
  const nested = readTrailingList(previous, kind) ?? appendNewList(previous, kind);
  // Bare text and comments between items in handwritten HTML are carried along too. Left in the original list,
  // they would end up after the moved items.
  appendItems(collectContentNodes(first, last), nested);
}

/**
 * Outdents the target items.
 *
 * Top-level items are promoted to paragraphs. Other items are placed right after the parent item. To keep the
 * visual order and levels, the items that follow move into the nested list of the last item placed, and the
 * children of the parent item after the list holding the targets move to the end of the last item placed.
 * Without moving them, they would end up before the placed items and break document order.
 *
 * @param items Consecutive items directly under one list, in document order.
 * @param progress The holder of whether the tree was changed.
 */
export function outdentItems(items: readonly Element[], progress: BlockRewriteProgress): void {
  const first = items.at(0);
  const last = items.at(-1);
  const list = first?.parentElement;
  const container = list?.parentElement;
  if (first === undefined || last === undefined || list === null || list === undefined) {
    return;
  }

  if (isTopLevelItem(first)) {
    unwrapItems(items, progress);
    return;
  }
  if (container !== null && container !== undefined && isListItem(container)) {
    outdentToParentItem(items, last, list, container, progress);
    return;
  }
  outdentFromNestedList(items, progress);
}

/**
 * Places the target items right after the parent item.
 *
 * @param items The target items.
 * @param last The last target item.
 * @param list The list of the target items.
 * @param parentItem The parent item.
 * @param progress The holder of whether the tree was changed.
 */
function outdentToParentItem(
  items: readonly Element[],
  last: Element,
  list: Element,
  parentItem: Element,
  progress: BlockRewriteProgress,
): void {
  const kind = readListKind(list);
  const outer = parentItem.parentElement;
  const first = items.at(0);
  if (kind === undefined || outer === null || first === undefined) {
    return;
  }

  // Collected before anything moves; once the items are placed, it is no longer known what was between and
  // after the targets. Bare text and comments directly under the list in handwritten HTML are carried with the
  // items too. Left in the list, they would end up before the placed items when the list is removed.
  const moved = collectContentNodes(first, last);
  const following = collectContentNodes(last.nextSibling, null);
  const trailing = collectFollowingNodes(list);
  const document = parentItem.ownerDocument;

  progress.changed = true;
  moveItems(moved, outer, parentItem);
  let carried: ChildNode[] = [];
  if (following.some((node) => node instanceof Element && node.localName === 'li')) {
    const nested = readTrailingList(last, kind) ?? appendNewList(last, kind);
    appendItems(following, nested);
  } else {
    // With no items after, no nested list is created; the content is carried to the end of the last item
    // placed, the same as the children after the list.
    carried = wrapInlineRuns(following, document);
  }
  // Inline runs after the list (the handwritten HTML shape) are also wrapped in paragraphs and carried. Carrying
  // only the block children would leave the runs in the parent item, before the placed items.
  for (const node of [...carried, ...wrapInlineRuns(trailing, document)]) {
    appendBlock(node, last);
  }
  // A list with neither items nor lists leaves only empty space where nothing is.
  if (![...list.children].some(isItemOrList)) {
    removeEmptyList(list);
  }
}

/**
 * Places the target items as items of the outer list, out of a list placed directly under a list in
 * handwritten HTML.
 *
 * Bare text and comments between the items are placed together with the items, in document order.
 *
 * @param items The target items.
 * @param progress The holder of whether the tree was changed.
 */
function outdentFromNestedList(items: readonly Element[], progress: BlockRewriteProgress): void {
  const first = items.at(0);
  const last = items.at(-1);
  const list = first?.parentElement;
  if (first === undefined || last === undefined || list === null || list === undefined) {
    return;
  }

  // Where content with no item before it goes. After the split, the list has been replaced and this cannot be
  // found.
  const previousItem = findPreviousItem(list);
  // Detached from the list before the split. Left there, it would be output as content of the side without
  // elements, before the placed items.
  const moved = collectContentNodes(first, last);
  progress.changed = true;
  for (const node of moved) {
    if (!(node instanceof Element)) {
      node.remove();
    }
  }
  const { gap, leading, trailing } = splitListAround(
    moved.filter((node): node is Element => node instanceof Element),
    false,
    progress,
  );
  if (gap.position === 'replace') {
    gap.reference.replaceWith(first);
  } else {
    insertBlock(first, gap.reference, gap.position);
  }

  // The head is `first` itself, inserted above. A newline goes only before elements; bare text and comments
  // follow the previous node directly, as in the original sequence.
  const document = first.ownerDocument;
  let previous: ChildNode = first;
  for (const node of moved.slice(1)) {
    previous.after(...(node instanceof Element ? [document.createTextNode(BLOCK_SEPARATOR_TEXT), node] : [node]));
    previous = node;
  }

  // Content of a side emptied by the split, if placed in the gap (directly under the outer list), would put
  // paragraphs without items inside the list, so it moves to the end of an item that keeps its visual level.
  // With no item before, there is no other place that keeps document order, so it stays where it was.
  for (const node of trailing) {
    appendBlock(node, last);
  }
  if (previousItem === undefined) {
    first.before(...leading.flatMap((node) => [node, document.createTextNode(BLOCK_SEPARATOR_TEXT)]));
  } else {
    for (const node of leading) {
      appendBlock(node, previousItem);
    }
  }
}

/**
 * Returns the last child of an item (ignoring whitespace) when it is a list of the given kind.
 *
 * @param item The item.
 * @param kind The list kind.
 * @returns The list that is the last child, or `undefined` when there is none.
 */
function readTrailingList(item: Element, kind: ListKind): Element | undefined {
  for (let node = item.lastChild; node !== null; node = node.previousSibling) {
    if (node instanceof Text && isHtmlWhitespaceOnly(node.data)) {
      continue;
    }
    return node instanceof Element && readListKind(node) === kind ? node : undefined;
  }
  return undefined;
}

/**
 * Appends a new list without attributes to the end of an item, preceded by a single newline.
 *
 * @param item The item.
 * @param kind The list kind.
 * @returns The appended list.
 */
function appendNewList(item: Element, kind: ListKind): Element {
  const list = item.ownerDocument.createElement(LIST_KIND_TAG_NAME[kind]);
  appendBlock(list, item);
  return list;
}

/**
 * Returns a run of siblings without the whitespace-only text. The whitespace comes along as a separator when
 * moving.
 *
 * @param start The first sibling, or `null` for none.
 * @param end The last sibling, or `null` to go to the end of the parent.
 * @returns Items, non-`li` elements, bare text and comments, in document order.
 */
function collectContentNodes(start: ChildNode | null, end: ChildNode | null): ChildNode[] {
  const nodes: ChildNode[] = [];
  for (let node = start; node !== null; node = node.nextSibling) {
    if (!(node instanceof Text && isHtmlWhitespaceOnly(node.data))) {
      nodes.push(node);
    }
    if (node === end) {
      break;
    }
  }
  return nodes;
}

/**
 * Returns the children of the parent item that come after the list.
 *
 * @param list The list of the target items.
 * @returns The following children, in document order.
 */
function collectFollowingNodes(list: Element): ChildNode[] {
  const nodes: ChildNode[] = [];
  for (let node = list.nextSibling; node !== null; node = node.nextSibling) {
    nodes.push(node);
  }
  return nodes;
}
