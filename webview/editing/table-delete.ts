import { createEmptyBlock, insertBlock, isEmptyBlock, isHtmlWhitespaceOnly } from './block';
import type { BlockRewriteProgress } from './block-format';
import { findMergeCandidate, removeWithSeparator } from './block-merge';
import { findGridCell, listCellsInTableOrder, mapColumnElements } from './table-grid';
import type { TableGrid, TableGridCell, TableGridRow } from './table-grid';

/**
 * Removes the row of the reference cell's origin.
 *
 * Cells extending down from that row are moved, with their contents, to the next row, and cells covering it from
 * above have their rowspan reduced. Just removing the row would lose the contents of the cells extending down,
 * and the cells covering from above would extend one row too far, creating overlaps and gaps.
 * If no row other than the one being removed is covered by a cell (including a table with only one row), removes
 * the whole table. Keeping it would leave a table with no cells, which could not be removed from the view since
 * it could have no reference cell.
 *
 * @param grid The logical grid.
 * @param cell The reference cell.
 * @param ends The containers of the selection start and end.
 * @param progress The holder of whether the tree was changed. Set to true right before the tree is first
 *   changed.
 * @returns The caret placement. `undefined` if no end of the selection is inside the removed row or section, or
 *   if there is no cell to place it in.
 */
export function deleteTableRow(
  grid: TableGrid,
  cell: Element,
  ends: readonly Node[],
  progress: BlockRewriteProgress,
): Element | undefined {
  const origin = findGridCell(grid, cell);
  if (origin === undefined) {
    return undefined;
  }
  const index = origin.row;
  if (!grid.slots.some((slots, target) => target !== index && slots.some((slot) => slot !== undefined))) {
    return deleteTable(grid.table, progress);
  }

  const row = grid.rows[index];
  const moved = grid.cells.filter((target) => target.row === index && target.rowSpan >= 2);
  const removed = new Set(
    grid.cells.filter((target) => target.row === index && !moved.includes(target)).map((target) => target.element),
  );
  const shrunk = new Set<TableGridCell>();
  for (const slot of grid.slots[index]) {
    if (slot !== undefined && slot.row < index) {
      shrunk.add(slot);
    }
  }

  // If it is the last row of its section, the section is removed with it, and an end on the section itself also
  // leaves the tree. Cells moved to the next row remain, so an end inside them needs no caret placement.
  const detached = [row.element, ...listRemovedSections([row])];
  const inRemoved = ends.some(
    (node) => detached.some((element) => element.contains(node))
      && !moved.some((target) => target.element.contains(node)),
  );
  const placement = inRemoved
    ? findPlacement(grid, origin, index + 1 < grid.rows.length ? index + 1 : index - 1, origin.column, removed)
    : undefined;

  progress.changed = true;
  for (const spanning of shrunk) {
    shrinkRowSpan(spanning.element);
  }
  moveToNextRow(grid, index, moved);
  removeRowWithSection(row);
  return placement;
}

/**
 * Removes the column of the reference cell's origin.
 *
 * Of the cells covering that column, those with a colspan of 2 or more are kept with it reduced by 1, and those
 * with 1 are removed. Rows that were covered only by removed cells are removed too. Keeping them would leave an
 * empty row no cell covers in the saved content, which could not be removed from the view since it could have
 * no reference cell. If the table has only one column, removes the whole table.
 *
 * @param grid The logical grid.
 * @param cell The reference cell.
 * @param ends The containers of the selection start and end.
 * @param progress The holder of whether the tree was changed. Set to true right before the tree is first
 *   changed.
 * @returns The caret placement. `undefined` if no end of the selection is inside a removed cell, row or section,
 *   or if there is no cell to place it in.
 */
export function deleteTableColumn(
  grid: TableGrid,
  cell: Element,
  ends: readonly Node[],
  progress: BlockRewriteProgress,
): Element | undefined {
  const origin = findGridCell(grid, cell);
  if (origin === undefined) {
    return undefined;
  }
  if (grid.columnCount === 1) {
    return deleteTable(grid.table, progress);
  }

  const column = origin.column;
  const covering = new Set<TableGridCell>();
  for (const slots of grid.slots) {
    const slot = slots[column];
    if (slot !== undefined) {
      covering.add(slot);
    }
  }
  const removed = new Set([...covering].filter((target) => target.columnSpan === 1).map((target) => target.element));
  // A row no cell covered was not emptied by this operation, so it is kept.
  const emptied = grid.rows.filter((_, index) => {
    const slots = grid.slots[index];
    return slots.some((slot) => slot !== undefined)
      && slots.every((slot) => slot === undefined || removed.has(slot.element));
  });

  // An end on a removed row itself (a position between cells), or on a section removed along with its rows,
  // also leaves the tree and cannot be restored to the table selection.
  const detached = [...removed, ...emptied.map((row) => row.element), ...listRemovedSections(emptied)];
  const inRemoved = ends.some((node) => detached.some((element) => element.contains(node)));
  const placement = inRemoved
    ? findPlacement(grid, origin, origin.row, column + 1 < grid.columnCount ? column + 1 : column - 1, removed)
    : undefined;

  progress.changed = true;
  for (const target of covering) {
    if (removed.has(target.element)) {
      removeWithLineBreak(target.element);
    } else {
      shrinkColumnSpan(target.element);
    }
  }
  removeColumnElement(grid.table, column);
  for (const row of emptied) {
    removeRowWithSection(row);
  }
  return placement;
}

/**
 * Removes a table and returns an empty paragraph as the caret placement.
 *
 * If there is an empty paragraph next to it, uses that as the placement, and inserts an empty paragraph where
 * the table was only when there is none. A freshly inserted table has an empty paragraph next to it, so adding a
 * paragraph on every removal would leave two blank lines in a row. The cells and comment annotations inside go
 * away with the table; undo brings them back.
 *
 * @param table The table element.
 * @param progress The holder of whether the tree was changed. Set to true right before the tree is first
 *   changed.
 * @returns The paragraph to place the caret in.
 */
export function deleteTable(table: Element, progress: BlockRewriteProgress): Element {
  // Skip whitespace and comments when looking for a neighbor. Neither has a visible line.
  const neighbor = [findMergeCandidate(table, 'forward'), findMergeCandidate(table, 'backward')]
    .find((candidate) => candidate !== undefined && candidate.localName === 'p' && isEmptyBlock(candidate));

  progress.changed = true;
  if (neighbor !== undefined) {
    removeWithSeparator(table);
    return neighbor;
  }
  const paragraph = createEmptyBlock(table.ownerDocument, 'p');
  // Inserting right after the table and then removing the table puts the paragraph on the line where the table
  // was, without adding a blank line.
  insertBlock(paragraph, table, 'after');
  removeWithSeparator(table);
  return paragraph;
}

/**
 * Moves the cells extending down from the removed row, with their contents, to the next row, and reduces their
 * rowspan by 1.
 *
 * Each is moved right before the first cell in the next row whose origin column is later. The browser places the
 * cells of a row from the left in sibling order, so moving them anywhere else would draw them in a different
 * column.
 *
 * @param grid The logical grid.
 * @param index The index of the removed row.
 * @param moved The cells to move (in document order).
 */
function moveToNextRow(grid: TableGrid, index: number, moved: readonly TableGridCell[]): void {
  const next = grid.rows[index + 1];
  if (next === undefined) {
    return;
  }
  const nextCells = grid.cells.filter((target) => target.row === index + 1);
  let tail = nextCells.at(-1)?.element;
  for (const target of moved) {
    const following = nextCells.find((candidate) => candidate.column > target.column);
    if (following !== undefined) {
      following.element.before(target.element);
    } else if (tail !== undefined) {
      tail.after(target.element);
      tail = target.element;
    } else {
      next.element.append(target.element);
      tail = target.element;
    }
    shrinkRowSpan(target.element);
  }
}

/**
 * Removes a row together with the whitespace before it, and removes its section too if no rows remain in it.
 *
 * @param row The row to remove.
 */
function removeRowWithSection(row: TableGridRow): void {
  removeWithSeparator(row.element);
  const section = row.section;
  if (section !== undefined && ![...section.children].some((child) => child.localName === 'tr')) {
    removeWithSeparator(section);
  }
}

/**
 * Returns the sections that would be left with no rows by removing the rows, and so are removed along with them.
 *
 * The check matches the condition under which `removeRowWithSection` removes a section (no rows remain).
 *
 * @param rows The rows to remove.
 * @returns The sections removed along with the rows.
 */
function listRemovedSections(rows: readonly TableGridRow[]): Element[] {
  const elements = new Set(rows.map((row) => row.element));
  const sections = new Set<Element>();
  for (const { section } of rows) {
    if (section !== undefined
      && [...section.children].every((child) => child.localName !== 'tr' || elements.has(child))) {
      sections.add(section);
    }
  }
  return [...sections];
}

/**
 * Finds the cell for the caret placement from a row and column position.
 *
 * If that slot is a gap, uses the nearest cell to the left in the same row. If no cell remains in that row, uses
 * the next remaining cell after the reference cell in table order (or the previous one if there is none).
 * Without a placement, a caret that was inside a removed cell would be left among the children of a row or
 * section, in no cell. A removed cell is never used as the placement.
 *
 * @param grid The logical grid (from before the rewrite).
 * @param origin The reference cell.
 * @param row The row index.
 * @param column The column index.
 * @param removed The cells to be removed.
 * @returns The placement cell, or `undefined` if no cell remains.
 */
function findPlacement(
  grid: TableGrid,
  origin: TableGridCell,
  row: number,
  column: number,
  removed: ReadonlySet<Element>,
): Element | undefined {
  const slots = grid.slots[row] ?? [];
  for (let target = column; target >= 0; target -= 1) {
    const slot = slots[target];
    if (slot !== undefined && !removed.has(slot.element)) {
      return slot.element;
    }
  }
  const ordered = listCellsInTableOrder(grid.table);
  const index = ordered.indexOf(origin.element);
  const remains = (target: Element): boolean => !removed.has(target);
  return ordered.slice(index + 1).find(remains) ?? ordered.slice(0, index).filter(remains).at(-1);
}

/**
 * Fixes the col of the removed column. Reduces its span by 1 if it is 2 or more, and removes it if it is 1.
 *
 * Also removes a colgroup left with no col. A colgroup that never had a col only covers columns through its
 * span, so it is not rewritten.
 *
 * @param table The table element.
 * @param column The index of the removed column.
 */
function removeColumnElement(table: Element, column: number): void {
  const col = mapColumnElements(table)[column];
  if (!(col instanceof HTMLTableColElement)) {
    return;
  }
  if (col.span >= 2) {
    col.span -= 1;
    return;
  }
  const group = col.parentElement;
  removeWithLineBreak(col);
  if (group !== null && ![...group.children].some((child) => child.localName === 'col')) {
    removeWithLineBreak(group);
  }
}

/**
 * Removes an element, and also removes the whitespace right before it only when that whitespace contains a line
 * break.
 *
 * In a table that writes each cell on its own line, leftover whitespace would become a whitespace-only line.
 * Between cells placed on the same line, keeping the whitespace avoids changing the text of untouched cells.
 *
 * @param element The element to remove.
 */
export function removeWithLineBreak(element: Element): void {
  const previous = element.previousSibling;
  element.remove();
  if (previous instanceof Text && isHtmlWhitespaceOnly(previous.data) && previous.data.includes('\n')) {
    previous.remove();
  }
}

/**
 * Reduces the rowspan by 1. A rowspan of 0 means extending to the end of the section and still covers the
 * remaining rows, so it is left unchanged.
 *
 * A rowspan that reaches 1 is removed along with the attribute. Keeping a value equal to the default would leave
 * an attribute the author never wrote in the saved content.
 *
 * @param cell The cell element.
 */
function shrinkRowSpan(cell: Element): void {
  if (!(cell instanceof HTMLTableCellElement) || cell.rowSpan === 0) {
    return;
  }
  if (cell.rowSpan <= 2) {
    cell.removeAttribute('rowspan');
    return;
  }
  cell.rowSpan -= 1;
}

/**
 * Reduces the colspan by 1. A colspan that reaches 1 is removed along with the attribute.
 *
 * @param cell The cell element.
 */
function shrinkColumnSpan(cell: Element): void {
  if (!(cell instanceof HTMLTableCellElement)) {
    return;
  }
  if (cell.colSpan <= 2) {
    cell.removeAttribute('colspan');
    return;
  }
  cell.colSpan -= 1;
}
