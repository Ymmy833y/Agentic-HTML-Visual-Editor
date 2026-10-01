import { BLOCK_SEPARATOR_TEXT, createEmptyBlock, isHtmlWhitespaceOnly } from './block';
import type { BlockRewriteProgress } from './block-format';
import { findGridCell, mapColumnElements } from './table-grid';
import type { TableGrid, TableGridCell } from './table-grid';
import { isHeaderRow } from './table-header';

/**
 * Inserts a row of the same section above or below the reference cell.
 *
 * Above inserts right before the row of the reference cell's origin; below inserts right after the lowest row
 * the reference cell covers. Inserting partway through a reference cell with a rowspan would make the reference
 * cell stretch across the new row, which does not match the user's visual above and below.
 *
 * @param grid The logical grid.
 * @param cell The reference cell.
 * @param direction The direction to add in.
 * @param progress The holder of whether the tree was changed. Set to true right before the tree is first
 *   changed.
 */
export function insertTableRow(
  grid: TableGrid,
  cell: Element,
  direction: 'above' | 'below',
  progress: BlockRewriteProgress,
): void {
  const origin = findGridCell(grid, cell);
  if (origin === undefined) {
    return;
  }
  if (direction === 'above') {
    insertRowAt(grid, origin.row, 'before', progress);
    return;
  }
  insertRowAt(grid, origin.row + origin.rowSpan - 1, 'after', progress);
}

/**
 * Adds a column to the left or right of the reference cell by inserting one cell per row.
 *
 * Left uses the boundary before the column of the reference cell's origin; right uses the boundary after the
 * rightmost column the reference cell covers. A new cell is a th (scope="col") in a header row and a td in other
 * rows. This keeps the heading row unbroken without making the new column a header column.
 *
 * @param grid The logical grid.
 * @param cell The reference cell.
 * @param direction The direction to add in. Left is the side with smaller column numbers and is not
 *   reinterpreted by writing direction.
 * @param progress The holder of whether the tree was changed. Set to true right before the tree is first
 *   changed.
 */
export function insertTableColumn(
  grid: TableGrid,
  cell: Element,
  direction: 'left' | 'right',
  progress: BlockRewriteProgress,
): void {
  const origin = findGridCell(grid, cell);
  if (origin === undefined) {
    return;
  }
  const boundary = direction === 'left' ? origin.column : origin.column + origin.columnSpan;
  const document = grid.table.ownerDocument;
  const ownCells = groupCellsByRow(grid);

  // Read these up front; reading them partway through the rewrite would let the added cells change the header
  // row judgment.
  const headerRows = grid.rows.map((_, index) => isHeaderRow(grid, index));
  const grown = new Set<TableGridCell>();
  const additions: { readonly row: number; readonly cell: Element }[] = [];
  grid.rows.forEach((_, index) => {
    const slots = grid.slots[index];
    const left = boundary > 0 ? slots[boundary - 1] : undefined;
    if (left !== undefined && left === slots[boundary]) {
      grown.add(left);
      return;
    }
    // Adding a cell to a row with a gap left of the boundary would make the browser place that cell in the gap,
    // filling the existing gap.
    if (slots.slice(0, boundary).includes(undefined)) {
      return;
    }
    const created = createEmptyBlock(document, headerRows[index] ? 'th' : 'td');
    if (headerRows[index]) {
      created.setAttribute('scope', 'col');
    }
    additions.push({ row: index, cell: created });
  });

  progress.changed = true;
  for (const spanning of grown) {
    growColumnSpan(spanning.element);
  }
  for (const addition of additions) {
    placeCellAtBoundary(grid.rows[addition.row].element, ownCells[addition.row], boundary, addition.cell);
  }
  insertColumnElement(grid.table, boundary);
}

/**
 * Inserts a row of the same section right after the last row in display order.
 *
 * Called by Tab in the last cell. Cells are created and line breaks placed the same way as when adding a row
 * below the last row.
 *
 * @param grid The logical grid.
 * @param progress The holder of whether the tree was changed. Set to true right before the tree is first
 *   changed.
 * @returns The first cell of the new row. `undefined` for a table without rows, or when the new row has no
 *   cells.
 */
export function appendTableRow(grid: TableGrid, progress: BlockRewriteProgress): Element | undefined {
  if (grid.rows.length === 0) {
    return undefined;
  }
  return insertRowAt(grid, grid.rows.length - 1, 'after', progress).firstElementChild ?? undefined;
}

/**
 * Inserts a new row right before or right after the reference row.
 *
 * @param grid The logical grid.
 * @param reference The index of the reference row. The new row goes into the same section as this row.
 * @param position Whether to insert right before or right after the reference row.
 * @param progress The holder of whether the tree was changed. Set to true right before the tree is first
 *   changed.
 * @returns The inserted row.
 */
function insertRowAt(
  grid: TableGrid,
  reference: number,
  position: 'before' | 'after',
  progress: BlockRewriteProgress,
): Element {
  const document = grid.table.ownerDocument;
  // The index where the new row goes. The original rows from this index on each shift back by one.
  const at = position === 'before' ? reference : reference + 1;
  const source = readSourceRow(grid, reference, position);
  const row = document.createElement('tr');
  const grown = new Set<TableGridCell>();
  for (let column = 0; column < grid.columnCount; column += 1) {
    const upper = at > 0 ? grid.slots[at - 1][column] : undefined;
    const lower = at < grid.rows.length ? grid.slots[at][column] : undefined;
    if (upper !== undefined && upper === lower) {
      grown.add(upper);
      continue;
    }
    // A cell clipped at the end of its section is drawn extending down to a row added below the last row of the
    // section. Creating a cell in that column would make an overlap, and increasing the rowspan would not change
    // how it is drawn.
    if (position === 'after' && upper !== undefined && upper.clipped) {
      continue;
    }
    row.append(createCellLike(document, source === undefined ? undefined : grid.slots[source][column]));
  }

  progress.changed = true;
  for (const spanning of grown) {
    growRowSpan(spanning.element);
  }
  const anchor = grid.rows[reference].element;
  // Put a single line break as the row separator before the new row, without indentation.
  const separator = document.createTextNode(BLOCK_SEPARATOR_TEXT);
  if (position === 'after') {
    anchor.after(separator, row);
    return row;
  }
  // Insert before the whitespace (line break and indentation) right before the reference row, so the leading
  // whitespace of the existing row is unchanged.
  const previous = anchor.previousSibling;
  const before = previous instanceof Text && isHtmlWhitespaceOnly(previous.data) ? previous : anchor;
  before.before(separator, row);
  return row;
}

/**
 * Decides the row whose cell element names and scope the new row copies.
 *
 * A row added below the heading row is made a body row. If adding a body row right below the heading added
 * another heading row instead, the user would have to toggle it back.
 *
 * @param grid The logical grid.
 * @param reference The index of the reference row.
 * @param position Whether to insert right before or right after the reference row.
 * @returns The index of the row to copy from, or `undefined` to make every column a td.
 */
function readSourceRow(grid: TableGrid, reference: number, position: 'before' | 'after'): number | undefined {
  if (position === 'before' || !isHeaderRow(grid, reference)) {
    return reference;
  }
  const below = reference + 1;
  if (below >= grid.rows.length) {
    return undefined;
  }
  return isHeaderRow(grid, below) ? reference : below;
}

/**
 * Creates an empty cell with the same element name and scope as the source cell.
 *
 * Does not copy the contents or other attributes. Copying them would create duplicate ids and unintended copies
 * of attributes the author added.
 *
 * @param document The document to create the cell in.
 * @param source The source cell, or `undefined` for a gap.
 * @returns A cell holding only a placeholder break.
 */
export function createCellLike(document: Document, source: TableGridCell | undefined): Element {
  const created = createEmptyBlock(document, source?.element.localName === 'th' ? 'th' : 'td');
  const scope = source?.element.getAttribute('scope');
  if (scope !== null && scope !== undefined) {
    created.setAttribute('scope', scope);
  }
  return created;
}

/**
 * Inserts the new cell, with no whitespace around it, right before the row's cell to the right of the boundary
 * (or right after the row's last cell if there is none).
 *
 * @param row The row element.
 * @param ownCells The cells whose origin is in that row (in document order).
 * @param boundary The column index of the boundary.
 * @param cell The cell to insert.
 */
function placeCellAtBoundary(
  row: Element,
  ownCells: readonly TableGridCell[],
  boundary: number,
  cell: Element,
): void {
  const next = ownCells.find((own) => own.column >= boundary);
  if (next !== undefined) {
    next.element.before(cell);
    return;
  }
  const last = ownCells.at(-1);
  if (last !== undefined) {
    last.element.after(cell);
    return;
  }
  row.append(cell);
}

/**
 * Fixes the col corresponding to the boundary of the added column.
 *
 * If the same col covers both sides of the boundary, increases its span by 1; otherwise inserts a col without
 * attributes at the boundary. In a table with no col covering the column left of the boundary (the column to
 * the right at the left edge), column widths are not specified, so no col is added.
 *
 * @param table The table element.
 * @param boundary The column index of the boundary.
 */
function insertColumnElement(table: Element, boundary: number): void {
  const columns = mapColumnElements(table);
  const left = boundary > 0 ? columns[boundary - 1] : undefined;
  const right = columns[boundary];
  if (boundary > 0) {
    if (left === undefined) {
      return;
    }
    if (left === right) {
      growColumnElementSpan(left);
      return;
    }
    left.after(table.ownerDocument.createElement('col'));
    return;
  }
  right?.before(table.ownerDocument.createElement('col'));
}

/**
 * Returns, for each row, the cells whose origin is in that row, in document order.
 *
 * @param grid The logical grid.
 * @returns For each row index, the list of cells originating there.
 */
function groupCellsByRow(grid: TableGrid): TableGridCell[][] {
  const groups: TableGridCell[][] = grid.rows.map(() => []);
  for (const cell of grid.cells) {
    groups[cell.row].push(cell);
  }
  return groups;
}

/**
 * Increases the rowspan by 1. A rowspan of 0 means extending to the end of the section and already covers the
 * added row, so it is left unchanged.
 *
 * @param cell The cell element.
 */
function growRowSpan(cell: Element): void {
  if (cell instanceof HTMLTableCellElement && cell.rowSpan !== 0) {
    cell.rowSpan += 1;
  }
}

/**
 * Increases the colspan by 1.
 *
 * @param cell The cell element.
 */
function growColumnSpan(cell: Element): void {
  if (cell instanceof HTMLTableCellElement) {
    cell.colSpan += 1;
  }
}

/**
 * Increases the span of a col by 1.
 *
 * @param col The col element.
 */
function growColumnElementSpan(col: Element): void {
  if (col instanceof HTMLTableColElement) {
    col.span += 1;
  }
}
