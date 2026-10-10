import { BLOCK_SEPARATOR_TEXT, isHtmlWhitespaceOnly } from './block';
import type { BlockRewriteProgress } from './block-format';
import { findMergeCandidate, removeWithSeparator } from './block-merge';
import type { MergeDirection } from './block-merge';
import { readItemNumber, writeFirstNumber } from './list-numbering';
import { readListKind } from './list-structure';

/**
 * Merges the created lists into neighbouring lists of the same kind.
 *
 * The element and attributes of the existing list are kept. The file may depend on the start number, reversed
 * order, `id` and so on, whereas a freshly created list has no attributes. When there are existing lists both
 * before and after, the lists merge into the one before, and the attributes of the one after are lost.
 *
 * @param created The created lists, in document order.
 * @param progress The holder of whether the tree was changed. Set to true on each merge.
 */
export function mergeCreatedLists(created: readonly Element[], progress: BlockRewriteProgress): void {
  const createdLists = new Set(created);
  for (const list of created) {
    let kept = list;
    const previous = findSameKindList(list, 'backward');
    if (previous !== undefined) {
      mergeFollowingList(previous, progress);
      kept = previous;
    }

    const next = findSameKindList(kept, 'forward');
    if (next === undefined) {
      continue;
    }
    if (kept === list && !createdLists.has(next)) {
      prependList(list, next, progress);
      continue;
    }
    mergeFollowingList(kept, progress);
  }
}

/**
 * Merges the immediately following list of the same kind by moving its items and comments to the end of the
 * preceding list.
 *
 * The element and attributes of the preceding list are kept. For numbered lists, the numbering of the preceding
 * list simply continues, giving a single sequence.
 *
 * @param list The preceding list.
 * @param progress The holder of whether the tree was changed. Set to true when a merge happens.
 */
export function mergeFollowingList(list: Element, progress: BlockRewriteProgress): void {
  const next = findSameKindList(list, 'forward');
  if (next === undefined) {
    return;
  }

  progress.changed = true;
  appendItems([...collectCommentsBetween(list, next), ...readContentNodes(next)], list);
  removeWithSeparator(next);
}

/**
 * Moves items and comments to the end of the destination list.
 *
 * @param nodes The items and comments to move (and, in handwritten HTML, bare text), in document order.
 * @param target The destination list.
 */
export function appendItems(nodes: readonly Node[], target: Element): void {
  moveItems(nodes, target, readLastContent(target));
}

/**
 * Moves items and comments, together with their separators, into the destination list.
 *
 * A newline is inserted only where elements would end up next to each other without a separator; other
 * whitespace is left as it is. Without the newline, a moved item would sit on the same line as its neighbour,
 * and even the spelling of untouched lines would be normalized.
 *
 * @param nodes The items and comments to move, in document order.
 * @param target The destination list.
 * @param after The node to come right before what is moved. When `undefined`, they go before the first child.
 */
export function moveItems(nodes: readonly Node[], target: Element, after: ChildNode | undefined): void {
  const reference = after === undefined ? target.firstChild : after.nextSibling;
  for (const node of nodes) {
    const separator = node.previousSibling;
    if (separator !== null && isSeparator(separator)) {
      target.insertBefore(separator, reference);
    }
    target.insertBefore(node, reference);
  }

  const document = target.ownerDocument;
  for (const node of nodes) {
    if (node instanceof Element && node.previousSibling instanceof Element) {
      node.before(document.createTextNode(BLOCK_SEPARATOR_TEXT));
    }
  }
  const last = nodes.at(-1);
  if (last instanceof Element && last.nextSibling instanceof Element) {
    last.after(document.createTextNode(BLOCK_SEPARATOR_TEXT));
  }
}

/**
 * Merges a created list by moving its items to the start of the existing list right after it.
 *
 * When the existing list has an explicit start number, the start number is shifted so that the existing items
 * keep the numbers they showed. In a list whose numbers the author specified, having existing items renumbered
 * just because items were added would break references to them in the text.
 *
 * @param created The created list.
 * @param existing The existing list right after it.
 * @param progress The holder of whether the tree was changed.
 */
function prependList(created: Element, existing: Element, progress: BlockRewriteProgress): void {
  const count = [...created.children].filter((child) => child.localName === 'li').length;
  const first = [...existing.children].find((child) => child.localName === 'li');
  const number = existing.hasAttribute('start') && first !== undefined ? readItemNumber(first) : undefined;

  progress.changed = true;
  moveItems([...readContentNodes(created), ...collectCommentsBetween(created, existing)], existing, undefined);
  removeWithSeparator(created);

  if (number !== undefined) {
    writeFirstNumber(existing, existing.hasAttribute('reversed') ? number + count : number - count);
  }
}

/**
 * Returns the list of the same kind that is adjacent with only whitespace-only text and comments in between.
 *
 * @param list The list.
 * @param direction The direction to look in.
 * @returns The list of the same kind, or `undefined` when bare text or another element lies in between or the
 *   kind differs.
 */
function findSameKindList(list: Element, direction: MergeDirection): Element | undefined {
  const kind = readListKind(list);
  const candidate = findMergeCandidate(list, direction);
  if (kind === undefined || candidate === undefined || readListKind(candidate) !== kind) {
    return undefined;
  }
  return candidate;
}

/**
 * Returns the comments between two siblings. They are not dropped when merging; they move between the items in
 * document order.
 *
 * @param first The preceding sibling.
 * @param second The following sibling.
 * @returns The comments in between, in document order.
 */
function collectCommentsBetween(first: Element, second: Element): Comment[] {
  const comments: Comment[] = [];
  for (let node = first.nextSibling; node !== null && node !== second; node = node.nextSibling) {
    if (node instanceof Comment) {
      comments.push(node);
    }
  }
  return comments;
}

/**
 * Returns the children other than whitespace-only text. The whitespace comes along as a separator when moving.
 *
 * @param parent The parent.
 * @returns The children, in document order.
 */
function readContentNodes(parent: Element): Node[] {
  return [...parent.childNodes].filter((node) => !isSeparator(node));
}

/**
 * Returns the last child other than whitespace-only text. Trailing whitespace is the newline before the closing
 * tag and stays after what is moved.
 *
 * @param parent The parent.
 * @returns The last child, or `undefined` when there is none.
 */
function readLastContent(parent: Element): ChildNode | undefined {
  for (let node = parent.lastChild; node !== null; node = node.previousSibling) {
    if (!isSeparator(node)) {
      return node;
    }
  }
  return undefined;
}

/**
 * Determines whether a node is whitespace-only text: the newline and indentation between items.
 *
 * @param node The node to check.
 * @returns `true` for whitespace-only text.
 */
function isSeparator(node: Node): node is Text {
  return node instanceof Text && isHtmlWhitespaceOnly(node.data);
}
