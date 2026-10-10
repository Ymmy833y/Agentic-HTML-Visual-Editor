import { BLOCK_SEPARATOR_TEXT, appendBlock, insertBlock, isHtmlWhitespaceOnly, wrapInlineRuns } from './block';
import type { BlockInsertPosition } from './block';
import type { BlockRewriteProgress } from './block-format';
import { removeWithSeparator } from './block-merge';
import { readItemNumber, writeFirstNumber } from './list-numbering';
import {
  findPreviousItem,
  isBlankItem,
  isItemLineParagraph,
  isItemOrList,
  isListItem,
  readListKind,
} from './list-structure';

/**
 * The list gap left by splitting a list.
 *
 * "Before" and "after" are a reference and direction that can be passed straight to block insertion.
 * "Replace" is used only when no items remain in the list.
 */
export interface ListGap {
  /** The element the position is relative to. */
  readonly reference: Element;
  /** Whether the position is before or after the reference, or replaces the reference itself. */
  readonly position: BlockInsertPosition | 'replace';
}

/**
 * The result of splitting a list.
 *
 * The content of a side left with neither items nor lists (such as bare text in handwritten HTML) is returned
 * rather than removed along with the list, and the caller decides where it goes. Placing it before or after the
 * gap early, once outer lists are split too, would make whatever is inserted in between mix up before and
 * after; placing it inside the outer list would put a paragraph directly under a list.
 */
export interface ListSplit {
  /** The list gap. */
  readonly gap: ListGap;
  /** What to place before the gap (paragraphs, HTML comments, elements), in document order, detached from the tree. */
  readonly leading: readonly ChildNode[];
  /** What to place after the gap, in document order, detached from the tree. */
  readonly trailing: readonly ChildNode[];
}

/**
 * Numbers read before splitting. Read after splitting, they would change with the removed items and with the
 * item count of a reversed list.
 */
interface SplitNumbers {
  /** The number of the first item before splitting. */
  readonly original: number | undefined;
  /** The number of the first item of the head. */
  readonly head: number | undefined;
  /** The number the first item of the tail should show: the continuation of the last item left in the head. */
  readonly tail: number | undefined;
}

/**
 * Splits a list before and after the items being taken out, and returns the gap and what to place around it.
 *
 * The tail copies the attributes of the original list except `id`, and starts from the number following the
 * last item left in the head. The items taken out are not counted, because to the reader the tail is a
 * continuation of the same list.
 *
 * @param items Consecutive items directly under one list, in document order.
 * @param outward Whether, when the parent is a list (handwritten HTML), outer lists are also split until the
 *   position is outside any list.
 * @param progress The holder of whether the tree was changed.
 * @returns The gap and what to place around it.
 */
export function splitListAround(
  items: readonly Element[],
  outward: boolean,
  progress: BlockRewriteProgress,
): ListSplit {
  const first = items.at(0);
  const last = items.at(-1);
  const list = first?.parentElement;
  if (first === undefined || last === undefined || list === null || list === undefined) {
    throw new Error('The items to take out are not in a list');
  }

  const numbers = readSplitNumbers(list, readItemsBefore(list, first));
  const tailStart = last.nextSibling;
  progress.changed = true;
  for (const item of items) {
    removeWithSeparator(item);
  }
  const split = splitAt(list, tailStart, numbers, progress);
  return outward ? splitOutward(split, progress) : split;
}

/**
 * Splits a list right after an item and returns the head list that serves as the insertion reference.
 *
 * A blank item is removed after the insertion, so it is not counted when deciding the tail's number. For a
 * nested list (whose parent is an item) only that list is split, so the reference stays inside the parent item.
 *
 * @param item The item.
 * @param progress The holder of whether the tree was changed.
 * @returns The insertion reference. The gap is right after it.
 */
export function splitListAfter(item: Element, progress: BlockRewriteProgress): Element {
  const list = item.parentElement;
  if (list === null) {
    throw new Error('The item to split after is not in a list');
  }

  const before = readItemsBefore(list, item);
  const blank = isBlankItem(item);
  if (blank && !hasItemOrListBefore(list, item) && collectNodesFrom(item.nextSibling).some(isItemOrList)) {
    // Only the item to be removed would remain in the head. Keep the original list as the tail so its `id` is
    // preserved, and create, at the position left after splitting outward, a new list holding only the item to
    // be removed as the insertion reference.
    const numbers = readSplitNumbers(list, []);
    const tailStart = item.nextSibling;
    const head = createSplitList(list);
    progress.changed = true;
    removeWithSeparator(item);
    head.append(item);
    const { gap, leading } = splitOutward(splitAt(list, tailStart, numbers, progress), progress);
    if (gap.position === 'replace') {
      gap.reference.replaceWith(head);
    } else {
      insertBlock(head, gap.reference, gap.position);
    }
    // The content before the item goes before the new head, so it does not end up after what is inserted.
    head.before(...leading.flatMap((node) => [node, createSeparator(head)]));
    return head;
  }

  const counted = blank ? before : [...before, item];
  const { gap, trailing } = splitOutward(
    splitAt(list, item.nextSibling, readSplitNumbers(list, counted), progress),
    progress,
  );
  // Insertion goes right after the reference, so placing the trailing content right after the reference first
  // lines it up after what is inserted.
  gap.reference.after(...trailing.flatMap((node) => [createSeparator(gap.reference), node]));
  return gap.reference;
}

/**
 * Takes over inserting a horizontal rule or collapsible section from an item or from a paragraph that is an
 * item line, and has it inserted between the halves of the split list.
 *
 * Inserting inside the item would put a block inside the list, producing invalid nesting. An empty item is
 * removed after the insertion.
 *
 * @param target The target block at the start.
 * @param insert The insertion step. Receives the reference, inserts right after it, and leaves the caret it placed.
 * @param progress The holder of whether the tree was changed.
 * @returns `true` when taken over. `false`, without touching the tree, when the target is neither an item nor a
 *   paragraph that is an item line.
 */
export function insertAfterListItem(
  target: Element,
  insert: (reference: Element) => boolean,
  progress: BlockRewriteProgress,
): boolean {
  const item = readInsertionItem(target);
  if (item === undefined) {
    return false;
  }

  const blank = isBlankItem(item);
  const reference = splitListAfter(item, progress);
  if (insert(reference)) {
    progress.changed = true;
  }
  if (blank) {
    removeItemWithEmptyLists(item, progress);
  }
  return true;
}

/**
 * Removes an item, then removes outward, in turn, each list left with neither items nor lists.
 *
 * Leaving a list without items would leave only spacing and a break in the numbering where nothing is.
 *
 * @param item The item.
 * @param progress The holder of whether the tree was changed.
 */
export function removeItemWithEmptyLists(item: Element, progress: BlockRewriteProgress): void {
  let list = item.parentElement;
  progress.changed = true;
  removeWithSeparator(item);
  while (list !== null && readListKind(list) !== undefined && ![...list.children].some(isItemOrList)) {
    const parent = list.parentElement;
    removeEmptyList(list);
    list = parent;
  }
}

/**
 * Removes a list left with neither items nor lists, together with the separator before it.
 *
 * Bare text (the handwritten HTML shape), HTML comments and elements left inside belong to the author, so they
 * are not dropped; they are placed where the list was, in document order. When the parent is a list, they are
 * moved to the end of the item just before it instead, since placing them where the list was would put a
 * paragraph directly under the outer list.
 *
 * @param list A list with neither items nor lists.
 */
export function removeEmptyList(list: Element): void {
  const parent = list.parentElement;
  const previous = parent !== null && readListKind(parent) !== undefined ? findPreviousItem(list) : undefined;
  const outputs = detachContent([...list.childNodes], list.ownerDocument);
  if (previous === undefined) {
    list.before(...outputs.flatMap((output) => [output, createSeparator(list)]));
  } else {
    for (const output of outputs) {
      appendBlock(output, previous);
    }
  }
  removeWithSeparator(list);
}

/**
 * Splits a list into a head and a tail at the split position.
 *
 * Everything from the separator after the split position to the last content moves to the tail, and the
 * whitespace after that stays in the head. When neither items nor lists remain in the head, the original list
 * is kept, with its attributes, as the tail. Losing the original list's `id` would break links pointing at it.
 *
 * @param list The list to split.
 * @param tailStart The first node of the tail, or `null` for the end of the list.
 * @param numbers The numbers read before splitting.
 * @param progress The holder of whether the tree was changed.
 * @returns The gap and what to place around it.
 */
function splitAt(
  list: Element,
  tailStart: ChildNode | null,
  numbers: SplitNumbers,
  progress: BlockRewriteProgress,
): ListSplit {
  const tailNodes = collectTailNodes(tailStart);
  const hasHead = hasItemOrListBefore(list, tailStart);

  // A side with neither items nor lists does not survive as a list, so the content left there is detached and
  // placed on the same side of the gap. Left in the list, it would either vanish with the list on replacement,
  // end up on the opposite side of the removed items, or leave a list without items.
  const leading = hasHead ? [] : detachContent(collectNodesBefore(list, tailStart), list.ownerDocument);
  const trailing = tailNodes.length === 0 ? detachContent(collectNodesFrom(tailStart), list.ownerDocument) : [];
  if (leading.length > 0 || trailing.length > 0) {
    progress.changed = true;
  }
  if (tailNodes.length === 0) {
    if (!hasHead) {
      return { gap: { reference: list, position: 'replace' }, leading, trailing };
    }
    writeNumber(list, numbers.head);
    return { gap: { reference: list, position: 'after' }, leading, trailing };
  }

  if (!hasHead) {
    writeNumber(list, numbers.original);
    return { gap: { reference: list, position: 'before' }, leading, trailing };
  }

  const tail = createSplitList(list);
  progress.changed = true;
  tail.append(...tailNodes);
  insertBlock(tail, list, 'after');
  // A reversed list counts from its item count, so fewer items in the head would change the numbers it showed.
  // Write a start number on the head as well to keep them.
  writeNumber(list, numbers.head);
  writeNumber(tail, numbers.tail);
  return { gap: { reference: list, position: 'after' }, leading, trailing };
}

/**
 * When the parent of the gap is a list (handwritten HTML), also splits the outer lists until the position is
 * outside any list.
 *
 * @param split The result of splitting the inner list.
 * @param progress The holder of whether the tree was changed.
 * @returns The gap outside the lists, and what to place around it from the inner and outer lists.
 */
function splitOutward(split: ListSplit, progress: BlockRewriteProgress): ListSplit {
  let current = split;
  for (
    let parent = current.gap.reference.parentElement;
    parent !== null && readListKind(parent) !== undefined;
    parent = current.gap.reference.parentElement
  ) {
    current = splitParentAtGap(parent, current, progress);
  }
  return current;
}

/**
 * Splits the parent list at the gap.
 *
 * @param parent The list that is the parent of the gap.
 * @param split The result of splitting the inner list.
 * @param progress The holder of whether the tree was changed.
 * @returns The gap outside the parent list, and what to place around it from the inner and outer lists.
 */
function splitParentAtGap(parent: Element, split: ListSplit, progress: BlockRewriteProgress): ListSplit {
  const { gap } = split;
  const reference = gap.reference;
  let tailStart: ChildNode | null = reference.nextSibling;
  if (gap.position === 'before') {
    const separator = reference.previousSibling;
    tailStart = separator !== null && isSeparator(separator) ? separator : reference;
  }

  const numbers = readSplitNumbers(parent, readItemsBefore(parent, tailStart));
  if (gap.position === 'replace') {
    // The empty list that was to be replaced gives way to the content placed at the outer split position.
    progress.changed = true;
    removeWithSeparator(reference);
  }
  const outer = splitAt(parent, tailStart, numbers, progress);
  // In document order, the outer leading content comes before the inner, and the outer trailing content after it.
  return {
    gap: outer.gap,
    leading: [...outer.leading, ...split.leading],
    trailing: [...split.trailing, ...outer.trailing],
  };
}

/**
 * Reads the numbers before splitting.
 *
 * @param list The list to split.
 * @param head The items kept in the head and counted for numbering, in document order.
 * @returns The numbers read before splitting.
 */
function readSplitNumbers(list: Element, head: readonly Element[]): SplitNumbers {
  const first = [...list.children].find((child) => child.localName === 'li');
  const original = first === undefined ? undefined : readItemNumber(first);
  const headFirst = head.at(0);
  const headLast = head.at(-1);
  return {
    original,
    head: headFirst === undefined ? undefined : readItemNumber(headFirst),
    tail: headLast === undefined
      ? original
      : readItemNumber(headLast) + (list.hasAttribute('reversed') ? -1 : 1),
  };
}

/**
 * Writes the number of the first item, only when a number is given.
 *
 * @param list The list.
 * @param number The number the first item should show.
 */
function writeNumber(list: Element, number: number | undefined): void {
  if (number !== undefined) {
    writeFirstNumber(list, number);
  }
}

/**
 * Creates the new list made by a split, copying the attributes of the original list except `id`.
 *
 * Duplicating `id` would make it no longer unique in the document. Attributes are copied with their namespace
 * and spelling. Recreating them from their names would throw for names the parser accepts but `setAttribute`
 * rejects, and would lose the namespace of quarantined attributes.
 *
 * @param list The original list.
 * @returns A new list holding only the attributes.
 */
function createSplitList(list: Element): Element {
  const created = list.ownerDocument.createElement(list.localName);
  for (const attribute of list.attributes) {
    if (attribute.namespaceURI === null && attribute.localName === 'id') {
      continue;
    }
    const copy = attribute.cloneNode();
    if (copy instanceof Attr) {
      created.setAttributeNodeNS(copy);
    }
  }
  return created;
}

/**
 * Wraps a sequence directly under a list that contains neither items nor lists in paragraphs, and detaches it
 * from the tree.
 *
 * Bare text is wrapped in paragraphs; comments and elements are not. A whitespace-only sequence separates lines,
 * so it is left untouched.
 *
 * @param nodes A sequence directly under a list containing neither items nor lists, in document order.
 * @param document The document used to create the paragraphs that wrap the sequence.
 * @returns What to place (paragraphs, HTML comments, elements), in document order.
 */
function detachContent(nodes: readonly ChildNode[], document: Document): ChildNode[] {
  if (nodes.every(isSeparator)) {
    return [];
  }
  const outputs = wrapInlineRuns(nodes, document);
  // Comments and elements output without wrapping are still inside the list.
  for (const output of outputs) {
    output.remove();
  }
  return outputs;
}

/**
 * Creates the newline placed between output nodes, so they do not sit on the same line.
 *
 * @param node A node of the tree the newline goes into.
 * @returns A text node holding a single newline.
 */
function createSeparator(node: Element): Text {
  return node.ownerDocument.createTextNode(BLOCK_SEPARATOR_TEXT);
}

/**
 * Returns the children directly under a list that come before a position.
 *
 * @param list The list.
 * @param boundary The position, or `null` for the end of the list.
 * @returns The children, in document order.
 */
function collectNodesBefore(list: Element, boundary: Node | null): ChildNode[] {
  const nodes: ChildNode[] = [];
  for (let node = list.firstChild; node !== null && node !== boundary; node = node.nextSibling) {
    nodes.push(node);
  }
  return nodes;
}

/**
 * Returns the siblings from a position onward.
 *
 * @param start The first sibling, or `null` for none.
 * @returns The siblings, in document order.
 */
function collectNodesFrom(start: ChildNode | null): ChildNode[] {
  const nodes: ChildNode[] = [];
  for (let node = start; node !== null; node = node.nextSibling) {
    nodes.push(node);
  }
  return nodes;
}

/**
 * Returns the nodes from the split position to the last node that is not whitespace-only text. The whitespace
 * after that stays in the head.
 *
 * Bare text and comments after the last item (the handwritten HTML shape) also move to the tail. Left in the
 * head, they would end up before the gap and the tail's items, breaking document order.
 *
 * @param tailStart The first node of the tail.
 * @returns The nodes to move to the tail. Empty when no item or list follows; a tail made only of elements such
 *   as paragraphs would leave a list without items.
 */
function collectTailNodes(tailStart: Node | null): Node[] {
  const nodes: Node[] = [];
  let count = 0;
  let kept = false;
  for (let node = tailStart; node !== null; node = node.nextSibling) {
    nodes.push(node);
    if (!isSeparator(node)) {
      count = nodes.length;
    }
    kept ||= isItemOrList(node);
  }
  return kept ? nodes.slice(0, count) : [];
}

/**
 * Determines whether there is an item or list before a position.
 *
 * @param list The list.
 * @param boundary The position, or `null` for the end of the list.
 * @returns `true` when an item or list comes before.
 */
function hasItemOrListBefore(list: Element, boundary: Node | null): boolean {
  return collectNodesBefore(list, boundary).some(isItemOrList);
}

/**
 * Returns the items directly under a list that come before a position.
 *
 * @param list The list.
 * @param boundary The position, or `null` for the end of the list.
 * @returns The items, in document order.
 */
function readItemsBefore(list: Element, boundary: Node | null): Element[] {
  const items: Element[] = [];
  for (let node = list.firstChild; node !== null && node !== boundary; node = node.nextSibling) {
    if (node instanceof Element && node.localName === 'li') {
      items.push(node);
    }
  }
  return items;
}

/**
 * Returns the item that takes over an insertion.
 *
 * @param target The target block at the start.
 * @returns The target itself when it is an item, its item when it is a paragraph that is an item line, or
 *   `undefined` otherwise.
 */
function readInsertionItem(target: Element): Element | undefined {
  if (isListItem(target)) {
    return target;
  }
  const parent = target.parentElement;
  return parent !== null && isItemLineParagraph(target) ? parent : undefined;
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
