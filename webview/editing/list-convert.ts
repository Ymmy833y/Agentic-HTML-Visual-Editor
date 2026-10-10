import { BLOCK_SEPARATOR_TEXT, fillPlaceholder, wrapInlineRuns } from './block';
import type { BlockRewriteProgress } from './block-format';
import { findMergeCandidate } from './block-merge';
import { mergeFollowingList } from './list-merge';
import { splitListAround } from './list-split';
import type { ListGap } from './list-split';
import { LIST_KIND_TAG_NAME, findFirstBlockChild, readListKind } from './list-structure';
import type { ListKind } from './list-structure';

/**
 * Replaces the creation blocks with items and gathers them into new lists, one per group of blocks that sit next
 * to each other with only whitespace and comments in between.
 *
 * Each list is put in as a replacement at the position of its first block, without adding newlines. Whitespace
 * and comments between the gathered blocks move between the items in document order. At the position of
 * anything else, such as a table or bare text, the list is split and that thing stays where it was.
 *
 * @param blocks The creation blocks, in document order.
 * @param kind The target list kind.
 * @param progress The holder of whether the tree was changed. Set to true on each replacement.
 * @returns The created lists. No attributes are put on them.
 */
export function createLists(
  blocks: readonly Element[],
  kind: ListKind,
  progress: BlockRewriteProgress,
): Element[] {
  const lists: Element[] = [];
  let current: Element | undefined;
  for (const block of blocks) {
    const joined = current !== undefined && findMergeCandidate(current, 'forward') === block
      ? current
      : undefined;
    progress.changed = true;
    const item = createItemFrom(block);
    if (joined !== undefined) {
      while (joined.nextSibling !== null && joined.nextSibling !== block) {
        joined.append(joined.nextSibling);
      }
      joined.append(item);
      block.remove();
      continue;
    }

    current = block.ownerDocument.createElement(LIST_KIND_TAG_NAME[kind]);
    current.append(item);
    block.replaceWith(current);
    lists.push(current);
  }
  return lists;
}

/**
 * Turns items back into paragraphs (along with the blocks and nested lists inside them), splits the list, and
 * places them in the gap in document order.
 *
 * Anything other than `li` directly under the list in handwritten HTML is taken out together with the items
 * when it lies in the range being taken out. When a list of the same kind directly follows a nested list taken
 * out, it is merged into one, whether it is the tail or a list that was already adjacent. Without merging, two
 * adjacent numbered lists would both start from 1, and bulleted lists would keep a gap between them.
 *
 * @param items Consecutive items directly under one list, in document order.
 * @param progress The holder of whether the tree was changed.
 */
export function unwrapItems(items: readonly Element[], progress: BlockRewriteProgress): void {
  const first = items.at(0);
  const last = items.at(-1);
  if (first === undefined || last === undefined) {
    return;
  }

  progress.changed = true;
  const pieces = detachRuns(collectRange(first, last), first.ownerDocument);
  const { gap, leading, trailing } = splitListAround(
    pieces.filter((piece): piece is Element => piece instanceof Element),
    true,
    progress,
  );
  // Items are turned back into paragraphs only after the split. Moving the item attributes to the paragraphs
  // first would strip the item's `value` from the original first number read before the split, and the
  // remaining list would restart from 1.
  const unwrapped = pieces.flatMap((piece) => {
    if (!(piece instanceof Element)) {
      return piece;
    }
    return piece.localName === 'li' ? unwrapItem(piece) : [piece];
  });
  // The content of the side emptied by the split is laid out together with the output. Placing it separately
  // before or after the outer split position would make the output mix up before and after.
  const outputs = [...leading, ...unwrapped, ...trailing];
  insertAtGap(outputs, gap);

  // Even when only comments follow, merge if the last element output was a nested list. Comments are invisible,
  // so the lists look adjacent even with comments in between.
  const lastOutput = [...outputs].reverse().find((output): output is Element => output instanceof Element);
  if (lastOutput !== undefined && readListKind(lastOutput) !== undefined) {
    mergeFollowingList(lastOutput, progress);
  }
}

/**
 * Replaces the element name of a list with that of the target kind.
 *
 * @param list The list of the owning item.
 * @param kind The target list kind.
 * @param progress The holder of whether the tree was changed. Nothing changes when the kind already matches.
 */
export function switchListKind(list: Element, kind: ListKind, progress: BlockRewriteProgress): void {
  if (readListKind(list) === kind) {
    return;
  }

  progress.changed = true;
  const created = list.ownerDocument.createElement(LIST_KIND_TAG_NAME[kind]);
  moveAttributes(list, created);
  created.append(...list.childNodes);
  list.replaceWith(created);
}

/**
 * Creates an item from a block. Children are moved by reference, and all attributes are carried over.
 *
 * `id`, `style` and the like are the author's information and cannot be recovered once dropped. All of them are
 * moved, so the same attributes come back when the item is turned back into a paragraph.
 *
 * @param block The creation block. It is empty after its content is moved.
 * @returns The created item.
 */
function createItemFrom(block: Element): Element {
  const item = block.ownerDocument.createElement('li');
  moveAttributes(block, item);
  item.append(...block.childNodes);
  // An item with no content has no height and looks as if the line disappeared.
  fillPlaceholder(item);
  return item;
}

/**
 * Creates what to place in the gap from an item.
 *
 * For an inline-only item, the content moves into a new paragraph. For an item with block children, the block
 * children are output as they are and the runs between them are wrapped in paragraphs. The item's attributes
 * are carried over to the paragraph wrapping its own content, and are lost when there is no such paragraph.
 *
 * @param item The item being taken out.
 * @returns What to place (blocks, paragraphs, HTML comments), in document order.
 */
function unwrapItem(item: Element): ChildNode[] {
  const document = item.ownerDocument;
  const boundary = findFirstBlockChild(item);
  if (boundary === undefined) {
    const paragraph = document.createElement('p');
    moveAttributes(item, paragraph);
    paragraph.append(...item.childNodes);
    fillPlaceholder(paragraph);
    return [paragraph];
  }

  const children = [...item.childNodes];
  const index = children.indexOf(boundary);
  // The own content has no block children, so it is wrapped in at most one paragraph, which carries over the
  // item's attributes.
  const ownContent = wrapInlineRuns(children.slice(0, index), document);
  const paragraph = ownContent.find((output): output is Element => output instanceof Element);
  if (paragraph !== undefined) {
    moveAttributes(item, paragraph);
  }
  return [...ownContent, ...wrapInlineRuns(children.slice(index), document)];
}

/**
 * Places the output into the gap in document order.
 *
 * As with block insertion, a single newline is put right before each newly inserted node. When inserting before
 * the reference, a newline also goes on the reference's side so the reference does not share a line with the
 * last inserted node. On replacement, the newlines around the list stay as they are.
 *
 * @param outputs What to place (blocks, paragraphs, HTML comments), in document order.
 * @param gap The list gap.
 */
function insertAtGap(outputs: readonly ChildNode[], gap: ListGap): void {
  const document = gap.reference.ownerDocument;
  const separator = (): Text => document.createTextNode(BLOCK_SEPARATOR_TEXT);
  const separated = outputs.flatMap((output, index) => (index === 0 ? [output] : [separator(), output]));
  if (separated.length === 0) {
    return;
  }
  if (gap.position === 'replace') {
    gap.reference.replaceWith(...separated);
  } else if (gap.position === 'after') {
    gap.reference.after(separator(), ...separated);
  } else {
    gap.reference.before(separator(), ...separated, separator());
  }
}

/**
 * Returns the children directly under the list from the first item to the last item.
 *
 * @param first The first item.
 * @param last The last item.
 * @returns The children in the range being taken out: the items and any non-`li` elements, text and comments
 *   between them, in document order.
 */
function collectRange(first: Element, last: Element): ChildNode[] {
  const nodes: ChildNode[] = [];
  for (let node: ChildNode | null = first; node !== null; node = node.nextSibling) {
    nodes.push(node);
    if (node === last) {
      break;
    }
  }
  return nodes;
}

/**
 * Separates the children in the range being taken out into elements and the wrapped runs between them.
 *
 * Bare text and comments between items (the handwritten HTML shape) are wrapped in paragraphs and detached from
 * the list before the split. Left in the list, they would end up on the opposite side of the removed items after
 * the split, or be removed together with the list.
 *
 * @param nodes The children in the range being taken out, in document order.
 * @param document The document used to create the paragraphs that wrap runs.
 * @returns A sequence of elements (items or non-`li` elements) and wrapped runs to output (paragraphs and HTML
 *   comments), in document order.
 */
function detachRuns(nodes: readonly ChildNode[], document: Document): (Element | ChildNode[])[] {
  const pieces: (Element | ChildNode[])[] = [];
  let run: ChildNode[] = [];
  const flush = (): void => {
    const wrapped = wrapInlineRuns(run, document);
    // Comments output without wrapping are still inside the list. Unless they are detached before the split,
    // they would be output a second time as content of the side without elements.
    for (const node of wrapped) {
      node.remove();
    }
    pieces.push(wrapped);
    run = [];
  };

  for (const node of nodes) {
    if (!(node instanceof Element)) {
      run.push(node);
      continue;
    }
    flush();
    pieces.push(node);
  }
  flush();
  return pieces;
}

/**
 * Moves attributes along with their namespace and spelling.
 *
 * @param source The element to move from.
 * @param target The element to move to.
 */
function moveAttributes(source: Element, target: Element): void {
  for (const attribute of [...source.attributes]) {
    source.removeAttributeNode(attribute);
    target.setAttributeNodeNS(attribute);
  }
}
