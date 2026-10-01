import { resolveImageSources } from '../document/image-source-resolver';
import { BLOCK_SEPARATOR_TEXT, findBlock, isEmptyBlock, isHtmlWhitespaceOnly } from './block';
import type { BlockInsertPosition } from './block';
import { removeWithSeparator } from './block-merge';
import { extractSplitTail, splitBlock } from './block-split';
import { findStructurePlacement, findVisibleEdge } from './boundary-placement';
import { findTrailingPreBreak, isAtBlockEnd, isAtBlockStart, placeCaret } from './caret';
import type { SplitPreparation } from './editing-hooks';
import { normalizeFormatElements } from './inline-normalize';
import { isPasteBlock } from './paste-placement';
import type { PastePlacement } from './paste-placement';
import { STRUCTURE_TAG_NAMES } from './structure-boundary';

/**
 * Ports of fragment insertion.
 *
 * Split preprocessing and block insertion use what is registered with the editing session, so that the preprocessor
 * that keeps comments from being split applies just as it does for Enter and text paste. The base URIs are held as the
 * mount target's values, so pasted images are resolved for display against the same bases the mount used to resolve
 * images.
 */
export interface PasteInsertPorts {
  /**
   * Applies the registered split preprocessors and either moves the range to the split position or reports that a
   * preprocessor took over.
   *
   * @param block The block to split.
   * @param range A collapsed range. Moved to the split position.
   * @returns The split position, or that a preprocessor took over.
   */
  prepareSplit(block: Element, range: Range): SplitPreparation;

  /**
   * Inserts a new block preceded by one line break.
   *
   * @param block The block to insert.
   * @param reference The reference element for the position.
   * @param position Before or after the reference element.
   */
  insertBlock(block: Element, reference: Element, position: BlockInsertPosition): void;

  /** The document URI used as the base for resolving relative paths. May be empty. */
  readonly documentUri: string;

  /** The resource root URI. May be empty. */
  readonly resourceRootUri: string;
}

/** Placements that insert the fragment as HTML (anything but the text form). */
type FragmentPlacement = Exclude<PastePlacement, { readonly kind: 'text' }>;

/** Placements that insert blocks. */
type BlockPlacement = Exclude<FragmentPlacement, { readonly kind: 'caret' | 'inlineCode' }>;

/**
 * Inserts the fragment into the editor root according to the placement and places the caret at the end of the
 * inserted content.
 *
 * Exceptions are thrown as is. The caller decides whether to close the tree changed before the exception as an edit.
 *
 * @param fragment The fragment. Its children move into the live tree.
 * @param placement The placement decided at the caret after deleting the range.
 * @param caret The caret range after deleting the range.
 * @param root The editor root.
 * @param ports The ports.
 */
export function insertPasteFragment(
  fragment: DocumentFragment,
  placement: FragmentPlacement,
  caret: Range,
  root: Element,
  ports: PasteInsertPorts,
): void {
  // Moving into the live document starts fetching unresolved relative paths. Resolve them first, keeping the saved
  // src as the author's value.
  resolveImageSources(fragment, ports.documentUri, ports.resourceRootUri);
  switch (placement.kind) {
    case 'caret':
      insertInline(fragment, caret, root);
      return;
    case 'inlineCode':
      convertToInlineCode(fragment);
      insertInline(fragment, caret, root);
      return;
    default:
      insertBlocks(fragment, placement, caret, ports);
  }
}

/**
 * Normalizes a fragment containing blocks into a shape that can be inserted into the editor root.
 *
 * Top-level runs of `li` are wrapped in `ul`, other top-level inline runs are wrapped in paragraphs, and
 * whitespace-only runs are dropped, so that no bare text or items are left directly under the editor root. Top-level
 * whitespace is only removed; the line break before each top-level block is placed on insertion.
 *
 * Below that, whitespace adjacent to blocks is removed, and one line break is placed before each block and at the end
 * of elements that end with a block. Without splitting blocks into lines, the line mapping breaks on save and even
 * untouched blocks change their spelling. This editor's spelling uses no indentation, so any indentation the fragment
 * brought in is dropped. Whitespace inside `pre` is content and is left as is, and no line break is placed before
 * cells within a row.
 *
 * @param fragment A fragment containing blocks.
 */
export function normalizePasteBlocks(fragment: DocumentFragment): void {
  wrapTopLevelRuns(fragment);
  for (const node of [...fragment.childNodes]) {
    if (isBlankText(node)) {
      node.remove();
    }
  }
  for (const element of fragment.querySelectorAll('*')) {
    if (element.closest('pre') === null && element.localName !== 'tr') {
      separateBlockChildren(element);
    }
  }
}

/**
 * Turns a fragment that is only a single-line code block into a fragment that is only inline `code`.
 *
 * Copying within the editor wraps a range inside a code block in `pre`. It is inserted inline so that pasting a
 * function name or the like into a paragraph does not split the paragraph every time. If the content is a single
 * `code`, that `code` is used; otherwise the children of `pre` are wrapped in a new `code`. A trailing pre break is
 * removed because inline it would show as a space.
 *
 * @param fragment A fragment whose top level is only whitespace text and a single `pre`.
 */
export function convertToInlineCode(fragment: DocumentFragment): void {
  const pre = fragment.querySelector('pre');
  if (pre === null) {
    return;
  }
  const trailing = findTrailingPreBreak(pre);
  if (trailing !== undefined) {
    trailing.text.deleteData(trailing.offset, 1);
    if (trailing.text.data === '') {
      trailing.text.remove();
    }
  }
  const [only] = pre.childNodes;
  if (pre.childNodes.length === 1 && only instanceof Element && only.localName === 'code') {
    fragment.replaceChildren(only);
    return;
  }
  const code = fragment.ownerDocument.createElement('code');
  code.append(...pre.childNodes);
  fragment.replaceChildren(code);
}

/**
 * Inserts an inline fragment at the caret, normalizes the block at the insertion point, and places the caret right
 * after the last inserted node.
 *
 * @param fragment A fragment with only inline content.
 * @param caret The caret range.
 * @param root The editor root.
 */
function insertInline(fragment: DocumentFragment, caret: Range, root: Element): void {
  if (isInsideLink(caret.startContainer, root)) {
    // A link cannot go inside a link. The parser moves a nested link out after saving and reopening, changing the
    // shape of the tree.
    for (const link of fragment.querySelectorAll('a')) {
      link.replaceWith(...link.childNodes);
    }
  }
  const last = fragment.lastChild;
  if (last === null) {
    return;
  }
  const block = findBlock(caret.startContainer, root);
  // After insertion the block no longer counts as empty, so note the placeholders before inserting. Note the elements
  // themselves so they are not confused with `br` elements from the fragment.
  const placeholders = block !== undefined && isEmptyBlock(block) ? findDirectBreaks(block) : [];

  caret.insertNode(fragment);
  for (const placeholder of placeholders) {
    placeholder.remove();
  }
  // Even if normalization unwraps the inserted nodes or merges them with neighbors, the range boundary follows the
  // tree changes and stays at the same visual position.
  const end = root.ownerDocument.createRange();
  end.setStartAfter(last);
  if (block !== undefined) {
    normalizeFormatElements([block]);
  }
  placeCaret(end.startContainer, end.startOffset);
}

/**
 * Inserts a fragment containing blocks next to the current block, as items of the same list, or into a container,
 * normalizes the inserted blocks, and places the caret at the end of the last inserted block.
 *
 * @param fragment A fragment containing blocks.
 * @param placement The placement.
 * @param caret The caret range.
 * @param ports The ports.
 */
function insertBlocks(fragment: DocumentFragment, placement: BlockPlacement, caret: Range, ports: PasteInsertPorts): void {
  normalizePasteBlocks(fragment);
  const target = placement.kind === 'adjacent'
    ? placement.block
    : placement.kind === 'listItem' ? placement.item : placement.container;
  // A preprocessor takes over only in the middle of a comment, where the placement is already the text form, so this
  // normally does not return here.
  if (ports.prepareSplit(target, caret).kind === 'takenOver') {
    return;
  }
  const blocks = placement.kind === 'listItem' ? collectListItems(fragment) : [...fragment.children];
  if (placement.kind === 'container') {
    insertIntoContainer(blocks, placement.container, caret);
  } else {
    insertNextTo(blocks, target, caret, ports);
  }
  normalizeFormatElements(blocks);
  const last = blocks.at(-1);
  if (last !== undefined) {
    placeCaretAtEnd(last);
  }
}

/**
 * Inserts blocks in order next to the current block. Replaces it if empty, inserts before it at its start, after it at
 * its end, and between the split halves in the middle.
 *
 * @param blocks The blocks to insert.
 * @param block The current block (a paragraph, heading, or `div`, or an item of the same list).
 * @param caret The caret range.
 * @param ports The ports.
 */
function insertNextTo(blocks: readonly Element[], block: Element, caret: Range, ports: PasteInsertPorts): void {
  const [first, ...rest] = blocks;
  if (first === undefined) {
    return;
  }
  const empty = isEmptyBlock(block);
  if (empty) {
    // Inserting before the empty block would leave an empty line behind, so insert after it and then remove it.
    ports.insertBlock(first, block, 'after');
  } else if (isAtBlockStart(caret, block)) {
    ports.insertBlock(first, block, 'before');
  } else if (isAtBlockEnd(caret, block)) {
    ports.insertBlock(first, block, 'after');
  } else {
    splitBlock(block, caret);
    ports.insertBlock(first, block, 'after');
  }
  // Insert the second and later blocks after the previously inserted one. Without a consistent reference, there would
  // be two line breaks between blocks.
  let previous = first;
  for (const next of rest) {
    ports.insertBlock(next, previous, 'after');
    previous = next;
  }
  if (empty) {
    removeWithSeparator(block);
  }
}

/**
 * Inserts blocks at the caret inside a container.
 *
 * Inline content before and after is not wrapped in paragraphs, so that pasting does not change the shape of items or
 * cells. The container's child holding the caret is split if there is visible content both before and after the caret;
 * otherwise the blocks go before or after it without splitting. Blocks may go where there is no reference element, so
 * they are inserted here with the same spelling as block insertion (one line break before each block).
 *
 * @param blocks The blocks to insert.
 * @param container The container.
 * @param caret The caret range, inside the container.
 */
function insertIntoContainer(blocks: readonly Element[], container: Element, caret: Range): void {
  const document = container.ownerDocument;
  const separated = blocks.flatMap((block) => [document.createTextNode(BLOCK_SEPARATOR_TEXT), block]);
  // After insertion the container no longer counts as empty, so note the placeholders before inserting.
  const placeholders = isEmptyBlock(container) ? findDirectBreaks(container) : [];

  const child = [...container.childNodes].find((node) => node.contains(caret.startContainer));
  if (child === undefined) {
    // When the caret is between children, treat it as already split there and insert at that boundary.
    container.insertBefore(createFragment(document, separated), container.childNodes[caret.startOffset] ?? null);
  } else if (!hasVisibleContentBefore(child, caret)) {
    child.before(...separated, document.createTextNode(BLOCK_SEPARATOR_TEXT));
  } else if (!hasVisibleContentAfter(child, caret)) {
    child.after(...separated);
  } else {
    const tail = extractSplitTail(caret, container, [...container.childNodes].indexOf(child) + 1);
    child.after(...separated, tail);
  }

  for (const placeholder of placeholders) {
    placeholder.remove();
  }
}

/**
 * Collects only the direct items from the fragment's top-level lists.
 *
 * @param fragment A fragment whose top level is only lists with only items as children.
 * @returns The items.
 */
function collectListItems(fragment: DocumentFragment): Element[] {
  return [...fragment.children].flatMap((list) => [...list.children].filter((child) => child.localName === 'li'));
}

/**
 * Places the caret at the last visible position of the last inserted block, or right after that block if it has no
 * visible position.
 *
 * For structures (collapsible sections, code blocks, and tables), the nearest visible position from outside is used.
 * The body of a closed collapsible section is not visible, so it lands at the end of the title. In a code block it
 * lands before the trailing pre break.
 *
 * @param block The last inserted block.
 */
function placeCaretAtEnd(block: Element): void {
  const edge = STRUCTURE_TAG_NAMES.has(block.localName)
    ? findStructurePlacement(block, 'backward')
    : findVisibleEdge(block, 'last');
  if (edge !== undefined) {
    placeCaret(edge.container, edge.offset);
    return;
  }
  const parent = block.parentNode;
  if (parent !== null) {
    placeCaret(parent, [...parent.childNodes].indexOf(block) + 1);
  }
}

/**
 * Wraps the fragment's top-level runs: runs of `li` in `ul`, and other inline runs in paragraphs.
 *
 * @param fragment A fragment containing blocks.
 */
function wrapTopLevelRuns(fragment: DocumentFragment): void {
  const document = fragment.ownerDocument;
  let items: Element[] = [];
  let run: ChildNode[] = [];
  for (const node of [...fragment.childNodes]) {
    if (node instanceof Element && node.localName === 'li') {
      wrapInlineRun(run, document);
      run = [];
      items.push(node);
      continue;
    }
    if (isPasteBlock(node)) {
      wrapInlineRun(run, document);
      run = [];
      wrapListItems(items, document);
      items = [];
      continue;
    }
    // Whitespace between items does not break the run. It is removed later as top-level whitespace.
    if (items.length > 0 && isBlankText(node)) {
      continue;
    }
    wrapListItems(items, document);
    items = [];
    run.push(node);
  }
  wrapInlineRun(run, document);
  wrapListItems(items, document);
}

/**
 * Wraps an inline run in a paragraph. Whitespace at both ends stays outside the paragraph, and a whitespace-only run is
 * not wrapped.
 *
 * @param run A top-level inline run.
 * @param document The document to create the paragraph in.
 */
function wrapInlineRun(run: readonly ChildNode[], document: Document): void {
  const first = run.findIndex((node) => !isBlankText(node));
  if (first === -1) {
    return;
  }
  let last = run.length - 1;
  while (isBlankText(run[last])) {
    last -= 1;
  }
  const paragraph = document.createElement('p');
  run[first].before(paragraph);
  paragraph.append(...run.slice(first, last + 1));
}

/**
 * Wraps a top-level run of `li` in `ul`.
 *
 * @param items A top-level run of items.
 * @param document The document to create the list in.
 */
function wrapListItems(items: readonly Element[], document: Document): void {
  const [first] = items;
  if (first === undefined) {
    return;
  }
  const list = document.createElement('ul');
  first.before(list);
  list.append(...items);
}

/**
 * Splits an element's block children into lines. Removes whitespace adjacent to blocks, and places one line break
 * before each block and at the end of an element that ends with a block.
 *
 * @param element The element.
 */
function separateBlockChildren(element: Element): void {
  for (const child of [...element.childNodes]) {
    if (isBlankText(child) && (isPasteBlock(child.previousSibling) || isPasteBlock(child.nextSibling))) {
      child.remove();
    }
  }
  const document = element.ownerDocument;
  for (const child of [...element.children]) {
    if (isPasteBlock(child)) {
      child.before(document.createTextNode(BLOCK_SEPARATOR_TEXT));
    }
  }
  if (isPasteBlock(element.lastChild)) {
    element.append(document.createTextNode(BLOCK_SEPARATOR_TEXT));
  }
}

/**
 * Returns whether the child has visible content before the caret.
 *
 * @param child The container's child holding the caret.
 * @param caret The caret range.
 * @returns `true` if there is visible content.
 */
function hasVisibleContentBefore(child: ChildNode, caret: Range): boolean {
  if (child instanceof Text) {
    return !isHtmlWhitespaceOnly(child.data.slice(0, caret.startOffset));
  }
  return child instanceof Element && !isAtBlockStart(caret, child);
}

/**
 * Returns whether the child has visible content after the caret.
 *
 * @param child The container's child holding the caret.
 * @param caret The caret range.
 * @returns `true` if there is visible content.
 */
function hasVisibleContentAfter(child: ChildNode, caret: Range): boolean {
  if (child instanceof Text) {
    return !isHtmlWhitespaceOnly(child.data.slice(caret.startOffset));
  }
  return child instanceof Element && !isAtBlockEnd(caret, child);
}

/**
 * Returns whether the position is inside a link.
 *
 * @param node The node of the position.
 * @param root The editor root.
 * @returns `true` if it has an `a` ancestor inside the editor root.
 */
function isInsideLink(node: Node, root: Element): boolean {
  const link = (node instanceof Element ? node : node.parentElement)?.closest('a') ?? null;
  return link !== null && link !== root && root.contains(link);
}

/**
 * Returns the `br` elements directly under the element.
 *
 * @param element The element.
 * @returns The direct `br` children.
 */
function findDirectBreaks(element: Element): Element[] {
  return [...element.children].filter((child) => child.localName === 'br');
}

/**
 * Returns whether the node is whitespace-only text.
 *
 * @param node The node to check.
 * @returns `true` for whitespace-only text.
 */
function isBlankText(node: Node | null | undefined): node is Text {
  return node instanceof Text && isHtmlWhitespaceOnly(node.data);
}

/**
 * Gathers a run of nodes into a fragment.
 *
 * @param document The document to create the fragment in.
 * @param nodes The run.
 * @returns A fragment with the run as its children.
 */
function createFragment(document: Document, nodes: readonly Node[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(...nodes);
  return fragment;
}
