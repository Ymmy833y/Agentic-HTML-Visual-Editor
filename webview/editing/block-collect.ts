import { BLOCK_TAG_NAMES, findBlock, isHtmlWhitespaceOnly } from './block';
import { readSelectionRange } from './caret';
import { isInsideClosedDetailsBody } from './details-body-guard';
import { INLINE_RUN_TAG_NAMES } from './target-block';

/**
 * Returns the target blocks overlapping a range, in document order.
 *
 * Without a range there is only the single block at the start point. The scaffolding of tables and lists
 * (`table`, `ul`, `ol`, and the elements between) are not blocks and do not enter the list; the `td` and `li`
 * inside them do.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @returns The target blocks, or an empty list when there are none.
 */
export function collectTargetBlocks(root: Element, range: Range): Element[] {
  if (range.collapsed) {
    const block = findBlock(range.startContainer, root);
    return block === undefined ? [] : [block];
  }

  // Walk only within the common ancestor. Walking the whole editor root would re-examine blocks outside the range.
  const scope = readScope(range, root);
  const candidates: Element[] = [];

  // The block containing the common ancestor is added separately because the walk does not reach above it. When
  // the range fits inside a single block, this is the only candidate.
  const enclosing = findBlock(scope, root);
  if (enclosing !== undefined) {
    candidates.push(enclosing);
  }

  const walker = root.ownerDocument.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Element && BLOCK_TAG_NAMES.has(node.localName)) {
      candidates.push(node);
    }
  }

  // A closed details body is invisible and gets no selection highlight, so it is not a target even when the range crosses it.
  // Exclude it before the filter that keeps only the innermost blocks, so blocks outside the body are not dropped because of blocks in the body.
  const overlapping = candidates.filter(
    (block) => range.intersectsNode(block) && !isInsideClosedDetailsBody(block, root),
  );
  // Keep only the innermost. When even one inner block overlaps, its ancestor block is left out of the list.
  return overlapping.filter(
    (block) => !overlapping.some((other) => other !== block && block.contains(other)),
  );
}

/**
 * Reads the block containing the start point without ensuring or wrapping anything.
 *
 * This is a read for querying the block kind; it changes neither the tree nor the selection.
 *
 * @param root The editor root.
 * @returns The block containing the start point, or `undefined` when there is no selection, it lies outside the
 *   editor root, or it sits inside a bare run.
 */
export function readCurrentBlock(root: Element): Element | undefined {
  const range = readSelectionRange(root);
  if (range === undefined) {
    return undefined;
  }
  return findBlock(range.startContainer, root);
}

/**
 * Returns the first node of each bare run overlapping the range, one per run.
 *
 * Only the direct children of the parent of the runs (the editor root or a cell) are inspected. Ensuring a target
 * returns the cell itself and does not wrap bare text inside a cell, so the runs of a cell are wrapped only by a
 * caller that passes the cell as the parent.
 *
 * Returning just one node per run prevents the same run from being wrapped twice.
 *
 * @param parent The parent of the runs (the editor root or a cell).
 * @param range The selection range.
 * @returns The first node of each bare run, in document order.
 */
export function collectBareRunHeads(parent: Element, range: Range): Node[] {
  const heads: Node[] = [];
  let run: Node[] = [];

  const close = (): void => {
    const head = run[0];
    if (head !== undefined && hasRunContent(run) && run.some((node) => range.intersectsNode(node))) {
      heads.push(head);
    }
    run = [];
  };

  for (const child of parent.childNodes) {
    if (isRunMember(child)) {
      run.push(child);
      continue;
    }
    close();
  }
  close();
  return heads;
}

/**
 * Returns the element at which the walk starts.
 *
 * @param range The selection range.
 * @param root The editor root.
 * @returns The common ancestor element, or the editor root itself when that ancestor lies outside it.
 */
function readScope(range: Range, root: Element): Element {
  const ancestor = range.commonAncestorContainer;
  const element = ancestor instanceof Element ? ancestor : ancestor.parentElement;
  if (element === null || !root.contains(element)) {
    return root;
  }
  return element;
}

/**
 * Determines whether a node may continue a run.
 *
 * The decision uses the same set as the range that ensuring a target wraps. Counting nodes as one run across an
 * element that ensuring does not wrap would wrap only the leading run and leave the rest bare, missing from the
 * targets.
 *
 * @param node The node to inspect.
 * @returns `true` for text, or for an element that ensuring a target includes in a run.
 */
function isRunMember(node: Node): boolean {
  if (node instanceof Text) {
    return true;
  }
  return node instanceof Element && INLINE_RUN_TAG_NAMES.has(node.localName);
}

/**
 * Determines whether a run holds content worth wrapping.
 *
 * The line breaks and indentation between blocks also form a run, but nothing in it is visible, so it is not
 * wrapped in a paragraph.
 *
 * @param run The nodes of the run.
 * @returns `true` when it holds anything other than whitespace-only text.
 */
function hasRunContent(run: readonly Node[]): boolean {
  return run.some((node) => !(node instanceof Text) || !isHtmlWhitespaceOnly(node.data));
}
