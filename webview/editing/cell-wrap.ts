import { BLOCK_SEPARATOR_TEXT, createEmptyBlock, fillPlaceholder, isEmptyBlock, isHtmlWhitespaceOnly } from './block';
import { collectBareRunHeads } from './block-collect';
import type { BlockRewriteProgress } from './block-format';
import { findTableCell } from './table-grid';
import { INLINE_RUN_TAG_NAMES, wrapBareRun } from './target-block';

/** The result of wrapping a cell's bare runs. */
export interface CellRunWrap {
  /** The innermost cell containing the start (the cell of the start). */
  readonly cell: Element;
  /** The wrapping paragraphs and the empty paragraph inserted where there was no run (in document order). */
  readonly paragraphs: readonly Element[];
  /**
   * The paragraph containing the start. `undefined` when the start is inside an element among the cell's children
   * that is not phrasing content.
   */
  readonly startParagraph: Element | undefined;
  /**
   * Whether the start's paragraph was inserted as an empty paragraph where there was no run (including where the run
   * was whitespace only).
   */
  readonly insertedEmpty: boolean;
}

/**
 * An end of the range, captured before wrapping.
 *
 * An end on a boundary between the cell's children is held by the children before and after it rather than by an
 * offset. Wrapping moves the cell's children into paragraphs, so an offset could no longer point to the same boundary.
 */
type RangeEnd =
  | { readonly kind: 'node'; readonly container: Node; readonly offset: number }
  | { readonly kind: 'boundary'; readonly before: ChildNode | null; readonly after: ChildNode | null };

/** A position at which to place an end of the range. */
interface RangePoint {
  readonly container: Node;
  readonly offset: number;
}

/**
 * How the start's run is handled. A run with content is wrapped; when there is no run or it is whitespace only, an
 * empty paragraph is inserted at that position.
 */
type StartRun =
  | { readonly kind: 'run'; readonly head: Node }
  | { readonly kind: 'empty'; readonly reference: Node | null };

/**
 * Returns the innermost cell that has the position's node as a direct child. Changes neither the tree nor the
 * selection.
 *
 * A direct child of a cell is a position with only phrasing content elements between it and the cell. Positions
 * inside paragraphs, lists and the like are not included.
 *
 * @param root The editor root.
 * @param node The position's node. May be the cell itself.
 * @returns The cell. `undefined` outside the editor root, for a td or th that is not a table cell, and inside an
 *   element among the cell's children that is not phrasing content.
 */
export function findDirectCell(root: Element, node: Node): Element | undefined {
  const cell = findTableCell(node, root);
  if (cell === undefined) {
    return undefined;
  }
  let current: Element | null = node instanceof Element ? node : node.parentElement;
  while (current !== null && current !== cell) {
    if (!INLINE_RUN_TAG_NAMES.has(current.localName)) {
      return undefined;
    }
    current = current.parentElement;
  }
  return cell;
}

/**
 * Directly inside the innermost cell containing the start, wraps the start's run and the runs overlapping the range
 * in new paragraphs, one per run.
 *
 * Only the runs directly inside that cell are wrapped; other cells the range spans and cells of nested tables are
 * not. Wrapping other cells as well would disagree with operations that leave the structure as is (such as list
 * creation) and leave behind cells that were merely wrapped. When the start is directly inside the cell and there is
 * no run or it is whitespace only, an empty paragraph is inserted at that position and becomes the target.
 *
 * After wrapping, both ends of the range are put back at positions with the same content as before wrapping, and the
 * selection is set to that range. Moving nodes pushes the range's ends out of the moved nodes, which would visibly
 * move the caret.
 *
 * Exceptions are not caught and are left to the caller. Progress is set to true just before the tree is first
 * changed, so even after an exception the caller can tell whether the tree was changed.
 *
 * @param root The editor root.
 * @param range The selection range. Placed again at the positions after wrapping.
 * @param progress Records whether the tree was changed.
 * @returns The wrapping result. `undefined`, without changing the tree, when the start is not in a cell, or when the
 *   start is not directly inside the cell and no run overlaps the range.
 */
export function wrapCellRuns(root: Element, range: Range, progress: BlockRewriteProgress): CellRunWrap | undefined {
  const cell = findTableCell(range.startContainer, root);
  if (cell === undefined) {
    return undefined;
  }
  const startRun = findDirectCell(root, range.startContainer) === cell
    ? readStartRun(cell, range.startContainer, range.startOffset)
    : undefined;
  const startHead = startRun?.kind === 'run' ? startRun.head : undefined;
  const heads = collectBareRunHeads(cell, range).filter((head) => head !== startHead);
  if (startRun === undefined && heads.length === 0) {
    return undefined;
  }

  const collapsed = range.collapsed;
  const start = readRangeEnd(cell, range.startContainer, range.startOffset);
  const end = readRangeEnd(cell, range.endContainer, range.endOffset);

  progress.changed = true;
  const inserted = startRun?.kind === 'empty' ? insertEmptyParagraph(cell, startRun.reference) : undefined;
  const startWrapped = startRun?.kind === 'run' ? wrapBareRun(startRun.head, cell) : undefined;
  const wrapped = [
    ...(startWrapped === undefined ? [] : [startWrapped]),
    ...heads.map((head) => wrapBareRun(head, cell)),
  ];

  let startPoint = resolveRangeEnd(cell, start);
  let endPoint = resolveRangeEnd(cell, end);
  for (const paragraph of wrapped) {
    if (!isEmptyBlock(paragraph)) {
      continue;
    }
    // Replacing with a placeholder detaches the nodes inside, so an end pointing inside is first moved to the start
    // of the paragraph.
    if (paragraph.contains(startPoint.container)) {
      startPoint = { container: paragraph, offset: 0 };
    }
    if (paragraph.contains(endPoint.container)) {
      endPoint = { container: paragraph, offset: 0 };
    }
    fillPlaceholder(paragraph);
  }
  if (inserted !== undefined) {
    startPoint = { container: inserted, offset: 0 };
    if (collapsed) {
      endPoint = startPoint;
    }
  }
  placeRange(range, startPoint, endPoint);

  return {
    cell,
    paragraphs: [...(inserted === undefined ? [] : [inserted]), ...wrapped].sort(compareDocumentOrder),
    startParagraph: inserted ?? startWrapped,
    insertedEmpty: inserted !== undefined,
  };
}

/**
 * Decides the start's run. When the child containing the start, or the child before or after the start, belongs in
 * a run, that run is the start's run.
 *
 * @param cell The cell of the start.
 * @param container The start's container. The start is directly inside the cell.
 * @param offset The start's offset.
 * @returns How the start's run is handled.
 */
function readStartRun(cell: Element, container: Node, offset: number): StartRun {
  let member: ChildNode | null;
  let reference: ChildNode | null;
  if (container === cell) {
    const before = cell.childNodes[offset - 1] ?? null;
    const after = cell.childNodes[offset] ?? null;
    member = isRunMember(before) ? before : isRunMember(after) ? after : null;
    reference = after;
  } else {
    const child = [...cell.childNodes].find((candidate) => candidate.contains(container)) ?? null;
    member = isRunMember(child) ? child : null;
    reference = child;
  }
  if (member === null) {
    return { kind: 'empty', reference };
  }

  const run = readRun(member);
  if (run.some((node) => !(node instanceof Text) || !isHtmlWhitespaceOnly(node.data))) {
    return { kind: 'run', head: run[0] };
  }
  // A whitespace-only run is the line breaks and indentation between tables or lists. The paragraph is inserted
  // before it, so the text of the neighboring block's line does not change.
  return { kind: 'empty', reference: run[0] };
}

/**
 * Returns the run containing the node, in document order.
 *
 * @param member A node of the run.
 * @returns The nodes of the run.
 */
function readRun(member: ChildNode): ChildNode[] {
  let first = member;
  while (isRunMember(first.previousSibling)) {
    first = first.previousSibling;
  }
  const run: ChildNode[] = [];
  for (let current: ChildNode | null = first; isRunMember(current); current = current.nextSibling) {
    run.push(current);
  }
  return run;
}

/**
 * Returns whether the node belongs in a run.
 *
 * Counted with the same set as the runs that ensuring a target wraps. Counting with a different set would make the
 * wrapped range and the counted range diverge.
 *
 * @param node The node to inspect.
 * @returns `true` for text or an element that belongs in a run.
 */
function isRunMember(node: ChildNode | null): node is ChildNode {
  if (node instanceof Text) {
    return true;
  }
  return node instanceof Element && INLINE_RUN_TAG_NAMES.has(node.localName);
}

/**
 * Inserts an empty paragraph, preceded by one line break, immediately before the reference child. The shape is the
 * same as the empty paragraph Enter creates.
 *
 * @param cell The cell.
 * @param reference The child to insert before. When absent, the paragraph is inserted at the end.
 * @returns The inserted paragraph.
 */
function insertEmptyParagraph(cell: Element, reference: Node | null): Element {
  const document = cell.ownerDocument;
  const paragraph = createEmptyBlock(document, 'p');
  cell.insertBefore(document.createTextNode(BLOCK_SEPARATOR_TEXT), reference);
  cell.insertBefore(paragraph, reference);
  return paragraph;
}

/**
 * Captures an end of the range in its shape before wrapping.
 *
 * @param cell The cell of the start.
 * @param container The end's container.
 * @param offset The end's offset.
 * @returns The captured end.
 */
function readRangeEnd(cell: Element, container: Node, offset: number): RangeEnd {
  if (container !== cell) {
    return { kind: 'node', container, offset };
  }
  return { kind: 'boundary', before: cell.childNodes[offset - 1] ?? null, after: cell.childNodes[offset] ?? null };
}

/**
 * Puts a captured end back at its position in the wrapped tree.
 *
 * An end inside a moved node keeps pointing where it did. An end on a boundary between the cell's children is put
 * back on the same boundary inside the paragraph that the child before or after it moved into.
 *
 * @param cell The cell of the start.
 * @param end The captured end.
 * @returns The position at which to place the end.
 */
function resolveRangeEnd(cell: Element, end: RangeEnd): RangePoint {
  if (end.kind === 'node') {
    return { container: end.container, offset: end.offset };
  }
  const { before, after } = end;
  const beforeParent = before?.parentNode ?? null;
  if (before !== null && beforeParent !== null && beforeParent !== cell) {
    return { container: beforeParent, offset: indexOfChild(beforeParent, before) + 1 };
  }
  const afterParent = after?.parentNode ?? null;
  if (after !== null && afterParent !== null) {
    return { container: afterParent, offset: indexOfChild(afterParent, after) };
  }
  if (before !== null && beforeParent === cell) {
    return { container: cell, offset: indexOfChild(cell, before) + 1 };
  }
  return { container: cell, offset: cell.childNodes.length };
}

/**
 * Places the range and the selection at the same two ends.
 *
 * @param range The range to place again.
 * @param start The start.
 * @param end The end.
 */
function placeRange(range: Range, start: RangePoint, end: RangePoint): void {
  // The start is placed first. Even when the new start is after the current end, the range first collapses to the
  // start and then the end is set.
  range.setStart(start.container, start.offset);
  range.setEnd(end.container, end.offset);
  const selection = range.startContainer.ownerDocument?.defaultView?.getSelection();
  if (selection === null || selection === undefined) {
    return;
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Returns the index of a child.
 *
 * @param parent The parent.
 * @param child The child.
 * @returns The index of the child.
 */
function indexOfChild(parent: Node, child: ChildNode): number {
  return [...parent.childNodes].indexOf(child);
}

/**
 * A comparison function that orders two elements in document order.
 *
 * @param first The first element.
 * @param second The second element.
 * @returns Negative when the first comes before, positive when it comes after.
 */
function compareDocumentOrder(first: Element, second: Element): number {
  if (first === second) {
    return 0;
  }
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 ? -1 : 1;
}
