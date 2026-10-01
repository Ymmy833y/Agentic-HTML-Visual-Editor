import type { BlockRewriteProgress } from './block-format';
import { findGridCell, readCellTable, resolveTableGrid } from './table-grid';
import type { TableGrid } from './table-grid';

/**
 * Whether the reference cell's row is a header row and whether its column is a header column.
 *
 * A value read by whoever decides the labels of the toggle items; it holds no references into the tree.
 */
export interface TableHeaderState {
  /** Whether the row of the reference cell's origin is a header row. */
  readonly headerRow: boolean;
  /** Whether the column of the reference cell's origin is a header column. */
  readonly headerColumn: boolean;
}

/**
 * Returns whether a row is a header row.
 *
 * A header row is a row with at least one cell originating in it, where all such cells are th and none has
 * scope="row". It is not decided by section (thead), so that a heading row is treated as a heading even in a
 * table that does not use thead.
 *
 * @param grid The logical grid.
 * @param row The row index.
 * @returns `true` if it is a header row.
 */
export function isHeaderRow(grid: TableGrid, row: number): boolean {
  return readHeaderRows(grid)[row] ?? false;
}

/**
 * Returns whether a column is a header column.
 *
 * A header column is a column with at least one cell originating in it outside the header rows, where all such
 * cells are th. Counting the cells of header rows would make a column a header column from the th of the
 * heading row alone.
 *
 * @param grid The logical grid.
 * @param column The column index.
 * @returns `true` if it is a header column.
 */
export function isHeaderColumn(grid: TableGrid, column: number): boolean {
  return readHeaderColumns(grid, readHeaderRows(grid))[column] ?? false;
}

/**
 * Returns whether the reference cell's row and column are a header row and a header column. Changes neither the
 * tree nor the selection.
 *
 * @param cell The reference cell.
 * @returns The result of the query, or `undefined` if it is not a table cell.
 */
export function readTableHeaderState(cell: Element): TableHeaderState | undefined {
  const table = readCellTable(cell);
  if (table === undefined) {
    return undefined;
  }
  const grid = resolveTableGrid(table);
  const origin = findGridCell(grid, cell);
  if (origin === undefined) {
    return undefined;
  }
  return { headerRow: isHeaderRow(grid, origin.row), headerColumn: isHeaderColumn(grid, origin.column) };
}

/**
 * Toggles the row of the reference cell's origin between a header row and a non-header row.
 *
 * Rewrites only the element names and scope of cells, and does not move the row between sections. Moving it into
 * a thead would need a rule to tell when the row order does not change, and a way to handle non-header rows left
 * in the thead. Cells covering the row by colspan from a left column or by rowspan from an upper row do not
 * originate in it, so they are not rewritten.
 *
 * @param grid The logical grid.
 * @param cell The reference cell.
 * @param progress The holder of whether the tree was changed. Set to true right before the tree is first
 *   changed.
 * @returns The mapping of cells whose element names were changed (old → new).
 */
export function toggleHeaderRow(
  grid: TableGrid,
  cell: Element,
  progress: BlockRewriteProgress,
): Map<Element, Element> {
  const replaced = new Map<Element, Element>();
  const origin = findGridCell(grid, cell);
  if (origin === undefined) {
    return replaced;
  }

  // Read these up front; reading them partway through the rewrite would let the rewritten cells change the
  // header row and header column judgments.
  const headerRows = readHeaderRows(grid);
  const headerColumns = readHeaderColumns(grid, headerRows);
  const toHeader = !headerRows[origin.row];
  for (const target of grid.cells) {
    if (target.row !== origin.row) {
      continue;
    }
    progress.changed = true;
    if (toHeader) {
      rewriteCell(target.element, 'th', 'col', replaced);
    } else if (headerColumns[target.column]) {
      // Even when the row stops being a header row, the headings of a header column stay unbroken.
      rewriteCell(target.element, 'th', 'row', replaced);
    } else {
      rewriteCell(target.element, 'td', undefined, replaced);
    }
  }
  return replaced;
}

/**
 * Toggles the column of the reference cell's origin between a header column and a non-header column.
 *
 * Rewrites only the cells originating in that column that are not in a header row. Cells of a header row are
 * column headings, and turning them into row headings would change the meaning of the table. If there is no
 * cell to rewrite, the tree is not changed.
 *
 * @param grid The logical grid.
 * @param cell The reference cell.
 * @param progress The holder of whether the tree was changed. Set to true right before the tree is first
 *   changed.
 * @returns The mapping of cells whose element names were changed (old → new).
 */
export function toggleHeaderColumn(
  grid: TableGrid,
  cell: Element,
  progress: BlockRewriteProgress,
): Map<Element, Element> {
  const replaced = new Map<Element, Element>();
  const origin = findGridCell(grid, cell);
  if (origin === undefined) {
    return replaced;
  }

  const headerRows = readHeaderRows(grid);
  const toHeader = !readHeaderColumns(grid, headerRows)[origin.column];
  for (const target of grid.cells) {
    if (target.column !== origin.column || headerRows[target.row]) {
      continue;
    }
    progress.changed = true;
    if (toHeader) {
      rewriteCell(target.element, 'th', 'row', replaced);
    } else {
      rewriteCell(target.element, 'td', undefined, replaced);
    }
  }
  return replaced;
}

/**
 * Determines for every row whether it is a header row, in a single pass over the cells.
 *
 * Re-scanning all cells per row would repeat the row judgment inside the column judgment, making the wait
 * noticeable on large tables.
 *
 * @param grid The logical grid.
 * @returns For each row index, whether it is a header row.
 */
function readHeaderRows(grid: TableGrid): boolean[] {
  const found = grid.rows.map(() => false);
  const headers = grid.rows.map(() => true);
  for (const cell of grid.cells) {
    found[cell.row] = true;
    if (cell.element.localName !== 'th' || readScope(cell.element) === 'row') {
      headers[cell.row] = false;
    }
  }
  return headers.map((header, row) => header && found[row]);
}

/**
 * Determines for every column whether it is a header column, in a single pass over the cells.
 *
 * @param grid The logical grid.
 * @param headerRows For each row index, whether it is a header row.
 * @returns For each column index, whether it is a header column.
 */
function readHeaderColumns(grid: TableGrid, headerRows: readonly boolean[]): boolean[] {
  const found = Array.from({ length: grid.columnCount }, () => false);
  const headers = Array.from({ length: grid.columnCount }, () => true);
  for (const cell of grid.cells) {
    if (headerRows[cell.row]) {
      continue;
    }
    found[cell.column] = true;
    if (cell.element.localName !== 'th') {
      headers[cell.column] = false;
    }
  }
  return headers.map((header, column) => header && found[column]);
}

/**
 * Reads the scope of a cell case-insensitively, the way the browser matches values of enumerated attributes.
 *
 * @param cell The cell element.
 * @returns The lowercased scope value, or `undefined` if there is none.
 */
function readScope(cell: Element): string | undefined {
  return cell.getAttribute('scope')?.toLowerCase();
}

/**
 * Rewrites a cell to the given element name and scope.
 *
 * If the element name is the same, only changes the scope without replacing the cell. When changing the element
 * name, moves the contents by reference into the new element and carries over every attribute except scope,
 * namespace included. Recreating attributes from their names would lose the namespace of quarantined
 * attributes.
 *
 * @param cell The cell to rewrite.
 * @param tagName The element name after the rewrite.
 * @param scope The scope after the rewrite. `undefined` removes the scope.
 * @param replaced The mapping of cells whose element names were changed. Old → new is added when replaced.
 */
function rewriteCell(
  cell: Element,
  tagName: 'th' | 'td',
  scope: 'col' | 'row' | undefined,
  replaced: Map<Element, Element>,
): void {
  let target = cell;
  if (cell.localName !== tagName) {
    target = cell.ownerDocument.createElement(tagName);
    for (const attribute of cell.attributes) {
      if (attribute.namespaceURI === null && attribute.localName === 'scope') {
        continue;
      }
      const copy = attribute.cloneNode();
      if (copy instanceof Attr) {
        target.setAttributeNodeNS(copy);
      }
    }
    target.append(...cell.childNodes);
    cell.replaceWith(target);
    replaced.set(cell, target);
  }

  if (scope === undefined) {
    target.removeAttribute('scope');
  } else {
    target.setAttribute('scope', scope);
  }
}
