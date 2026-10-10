import { isHtmlWhitespaceOnly, isMergeableBlock } from './block';
import type { BlockCommandPorts } from './block-command';
import type { BlockRewriteProgress } from './block-format';
import { placeCaret, readSelectionRange } from './caret';
import { appendTableRow, insertTableColumn, insertTableRow } from './table-add';
import { deleteTable, deleteTableColumn, deleteTableRow } from './table-delete';
import { readCellTable, resolveTableGrid } from './table-grid';
import { toggleHeaderColumn, toggleHeaderRow } from './table-header';
import { mergeTableCells, splitTableCell } from './table-merge';
import {
  readColumnWidthsForInsert,
  setColumnWidth,
  toggleTableWidthUnit,
  writeDistributedColumnWidths,
} from './table-width';

/**
 * A table operation.
 *
 * Only the direction of an addition, the other cell of a cell merge and the new rendered width (px) of setting a
 * column width carry values; the reference cell is passed as an argument. The column whose width is set is also
 * decided from the reference cell. The context menu, Tab and the column resize call the same operation, rather than
 * each trigger having its own.
 */
export type TableOperation =
  | { readonly kind: 'insertRow'; readonly direction: 'above' | 'below' }
  | { readonly kind: 'insertColumn'; readonly direction: 'left' | 'right' }
  | { readonly kind: 'appendRow' }
  | { readonly kind: 'deleteRow' }
  | { readonly kind: 'deleteColumn' }
  | { readonly kind: 'deleteTable' }
  | { readonly kind: 'toggleHeaderRow' }
  | { readonly kind: 'toggleHeaderColumn' }
  | { readonly kind: 'mergeCells'; readonly otherCell: Element }
  | { readonly kind: 'splitCell' }
  | { readonly kind: 'setColumnWidth'; readonly width: number }
  | { readonly kind: 'toggleWidthUnit' };

/** One end of a table selection. */
interface TableSelectionPoint {
  /** The container of the end. */
  readonly container: Node;
  /** The offset within the container. */
  readonly offset: number;
  /**
   * The child right after the offset, held only when the container is a table, section or row. `null` at the
   * end.
   *
   * These children come and go with table operations, so holding the position as a number would point at a
   * different cell just because a row or column was added before it.
   */
  readonly next?: ChildNode | null;
}

/**
 * The selection captured before a table operation.
 *
 * Holds the position neither as serialized lines and columns nor as a character count in the editor root.
 * Replacing cell element names and moving rows changes the spelling of lines, and the way br is counted shifts
 * the character count, so neither would point at the same position after the operation.
 */
export interface TableSelection {
  /** The start. */
  readonly start: TableSelectionPoint;
  /** The end. */
  readonly end: TableSelectionPoint;
}

// Element names of containers whose children come and go with table operations.
const STRUCTURE_TAG_NAMES: ReadonlySet<string> = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr']);

// Finds the first non-whitespace character. NBSP has a width, so it counts as content.
const CONTENT_CHARACTER_PATTERN = /[^\t\n\f\r ]/u;

/**
 * Runs a table operation, from checking the preconditions to closing the edit attempt.
 *
 * @param ports The block command ports.
 * @param operation The table operation.
 * @param cell The reference cell.
 * @returns `true` when the tree changed.
 */
export function runTableOperation(ports: BlockCommandPorts, operation: TableOperation, cell: Element): boolean {
  const root = ports.readEditorRoot();
  if (root === undefined || ports.isComposing() || ports.isInputStopped()) {
    return false;
  }
  // Rewriting based on a cell detached from the editor root, or a cell of another document, would change a tree
  // that never shows up in the saved content.
  const table = readCellTable(cell);
  if (table === undefined || !root.contains(table)) {
    return false;
  }
  return ports.runCommandEdit(`table:${operation.kind}`, () => rewriteTable(ports, root, operation, cell, table));
}

/**
 * Captures both ends of the selection in a form that points at the same position across cell replacements and
 * rows or cells coming and going. Changes neither the tree nor the selection.
 *
 * @param root The editor root.
 * @returns The table selection. `undefined` if there is no selection or an end lies outside the editor root.
 */
export function readTableSelection(root: Element): TableSelection | undefined {
  const range = readSelectionRange(root);
  if (range === undefined) {
    return undefined;
  }
  return {
    start: toSelectionPoint(range.startContainer, range.startOffset),
    end: toSelectionPoint(range.endContainer, range.endOffset),
  };
}

/**
 * Restores a table selection.
 *
 * If the container or the child right after the offset is a cell whose element name was replaced, reads it as
 * the replacement element. The contents were moved by reference, so the same offset still applies. If an end
 * has left the editor root, the selection is left untouched.
 *
 * @param root The editor root.
 * @param selection The table selection.
 * @param replaced The mapping of cells whose element names were replaced (old → new).
 */
export function restoreTableSelection(
  root: Element,
  selection: TableSelection,
  replaced: ReadonlyMap<Element, Element>,
): void {
  const start = resolveSelectionPoint(selection.start, replaced);
  const end = resolveSelectionPoint(selection.end, replaced);
  if (start === undefined || end === undefined || !root.contains(start.node) || !root.contains(end.node)) {
    return;
  }
  const domSelection = root.ownerDocument.defaultView?.getSelection();
  if (domSelection === null || domSelection === undefined) {
    return;
  }
  const range = root.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  domSelection.removeAllRanges();
  domSelection.addRange(range);
}

/**
 * Places a collapsed caret right before the first content inside a cell or paragraph. Any range selection is
 * collapsed.
 *
 * Placing it before a leading line break or indentation would separate the next typed character from the first
 * character. If the first content is a paragraph, heading, div or bare blockquote whose children are all inline,
 * descends one level into it. Does not descend into structures that cannot take typed characters directly, such
 * as tables, lists and code blocks, and places the caret right before them instead.
 *
 * @param target A cell or paragraph.
 */
export function placeCaretInCell(target: Element): void {
  const first = findFirstContent(target);
  if (first instanceof Element && isMergeableBlock(first)) {
    placeCaretBefore(first, findFirstContent(first));
    return;
  }
  placeCaretBefore(target, first);
}

/**
 * Performs the body of a table operation, from capturing the selection to placing the caret again.
 *
 * Does not throw, and returns whether the tree changed. This lets a rewrite that fails partway still close what
 * it changed as an edit. Aborting instead would make the display and the saved content disagree.
 *
 * @param ports The block command ports.
 * @param root The editor root.
 * @param operation The table operation.
 * @param cell The reference cell.
 * @param table The table of the reference cell.
 * @returns `true` when the tree changed.
 */
function rewriteTable(
  ports: BlockCommandPorts,
  root: Element,
  operation: TableOperation,
  cell: Element,
  table: Element,
): boolean {
  const progress: BlockRewriteProgress = { changed: false };
  const selection = readTableSelection(root);
  const range = readSelectionRange(root);
  const ends = range === undefined ? [] : [range.startContainer, range.endContainer];
  let placement: Element | undefined;
  let replaced: ReadonlyMap<Element, Element> = new Map();

  try {
    // Build the logical grid only once, before rewriting. Rebuilding it partway would continue the operation on
    // the rewritten slots.
    const grid = resolveTableGrid(table);
    switch (operation.kind) {
      case 'insertRow':
        insertTableRow(grid, cell, operation.direction, progress);
        break;
      case 'insertColumn': {
        // Read the widths before the new column changes the rendering. In a table with column widths, a column added
        // without a width is drawn at its minimum width once the other columns take up the table's width.
        const widths = readColumnWidthsForInsert(grid);
        const column = insertTableColumn(grid, cell, operation.direction, progress);
        if (widths !== undefined && column !== undefined) {
          writeDistributedColumnWidths(table, widths, column);
        }
        break;
      }
      case 'appendRow':
        placement = appendTableRow(grid, progress);
        break;
      case 'deleteRow':
        placement = deleteTableRow(grid, cell, ends, progress);
        break;
      case 'deleteColumn':
        placement = deleteTableColumn(grid, cell, ends, progress);
        break;
      case 'deleteTable':
        placement = deleteTable(table, progress);
        break;
      case 'toggleHeaderRow':
        replaced = toggleHeaderRow(grid, cell, progress);
        break;
      case 'toggleHeaderColumn':
        replaced = toggleHeaderColumn(grid, cell, progress);
        break;
      case 'mergeCells':
        placement = mergeTableCells(grid, cell, operation.otherCell, progress);
        break;
      case 'splitCell':
        // The content stays in the origin cell, so there is no placement and the captured selection is restored.
        splitTableCell(grid, cell, progress);
        break;
      case 'setColumnWidth':
        // A column width does not move content, so there is no placement and the captured selection is restored.
        setColumnWidth(grid, cell, operation.width, progress);
        break;
      case 'toggleWidthUnit':
        toggleTableWidthUnit(grid, progress);
        break;
    }
  } catch (error) {
    ports.reportDiagnostic(`Could not finish the table operation: ${String(error)}`);
  }

  // An operation that did not change the tree does not touch the selection either.
  if (progress.changed) {
    if (placement !== undefined) {
      placeCaretInCell(placement);
    } else if (selection !== undefined) {
      restoreTableSelection(root, selection, replaced);
    }
  }
  return progress.changed;
}

/**
 * Turns an end of the selection into the form of a table selection end.
 *
 * @param container The container of the end.
 * @param offset The offset within the container.
 * @returns The table selection end.
 */
function toSelectionPoint(container: Node, offset: number): TableSelectionPoint {
  if (container instanceof Element && STRUCTURE_TAG_NAMES.has(container.localName)) {
    return { container, offset, next: container.childNodes[offset] ?? null };
  }
  return { container, offset };
}

/**
 * Resolves a table selection end back to a position on the current tree.
 *
 * @param point The table selection end.
 * @param replaced The mapping of cells whose element names were replaced (old → new).
 * @returns The container and offset. `undefined` if the child right after has left the container.
 */
function resolveSelectionPoint(
  point: TableSelectionPoint,
  replaced: ReadonlyMap<Element, Element>,
): { node: Node; offset: number } | undefined {
  const container = point.container;
  if (point.next === null) {
    return { node: container, offset: container.childNodes.length };
  }
  if (point.next !== undefined) {
    const next = point.next instanceof Element ? replaced.get(point.next) ?? point.next : point.next;
    if (next.parentNode !== container) {
      return undefined;
    }
    return { node: container, offset: [...container.childNodes].indexOf(next) };
  }
  const node = container instanceof Element ? replaced.get(container) ?? container : container;
  const length = node instanceof CharacterData ? node.data.length : node.childNodes.length;
  return { node, offset: Math.min(point.offset, length) };
}

/**
 * Returns the first content. Whitespace-only text and comments are skipped, since they have no visible form.
 *
 * @param parent The parent element.
 * @returns The first content child, or `undefined` if there is none.
 */
function findFirstContent(parent: Element): ChildNode | undefined {
  for (const child of parent.childNodes) {
    if (child instanceof Comment || (child instanceof Text && isHtmlWhitespaceOnly(child.data))) {
      continue;
    }
    return child;
  }
  return undefined;
}

/**
 * Places the caret right before a content. For text, places it right before the first character after any
 * leading whitespace.
 *
 * @param parent The parent of the content.
 * @param content The content. If absent, places the caret at the start of the parent.
 */
function placeCaretBefore(parent: Element, content: ChildNode | undefined): void {
  if (content === undefined) {
    placeCaret(parent, 0);
    return;
  }
  if (content instanceof Text) {
    placeCaret(content, Math.max(0, content.data.search(CONTENT_CHARACTER_PATTERN)));
    return;
  }
  placeCaret(parent, [...parent.childNodes].indexOf(content));
}
