// Structural commands for tables: insert / delete rows and columns,
// promote rows to headers, merge / split cells, resize columns, and delete
// the whole table. All mutations go through a freshly-built TableModel so
// colspan / rowspan are reasoned about consistently.

import {
  anchorsInRect,
  boundingRect,
  buildTableModel,
  findCell,
  findCellPosition,
  findTable,
  tightenRect,
  type LogicalCell,
  type TableModel,
  type TableSectionKind,
} from './table-dom';
import type { CommandContext } from './shared/command-context';
import { findBlockAncestor, isBlockEmptyOrStubBr } from './shared/dom-utils';

export interface InsertTableOptions {
  rows: number;
  cols: number;
  withHeader: boolean;
}

/**
 * Insert a fresh table at the current selection. The block that hosts the
 * caret is split in two so the table lands at a block boundary regardless of
 * where inside the block the cursor sat. The cursor lands in the first body
 * cell of the new table.
 */
export function insertTable(opts: InsertTableOptions, ctx: CommandContext): HTMLTableElement | null {
  const rows = Math.max(1, Math.floor(opts.rows));
  const cols = Math.max(1, Math.floor(opts.cols));

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);

  const table = buildEmptyTable(rows, cols, opts.withHeader);

  const block = findBlockAncestor(range.startContainer, ctx.root);
  if (block) {
    splitBlockAndInsert(block, range, table, ctx.root);
  } else {
    // No block ancestor; insert at the range and split surrounding text.
    range.collapse(true);
    range.insertNode(table);
  }

  placeCaretInFirstCell(table);
  return table;
}

function buildEmptyTable(rows: number, cols: number, withHeader: boolean): HTMLTableElement {
  const table = document.createElement('table');

  if (withHeader) {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    for (let c = 0; c < cols; c++) {
      tr.appendChild(emptyCell('th'));
    }
    thead.appendChild(tr);
    table.appendChild(thead);
  }

  const tbody = document.createElement('tbody');
  const bodyRows = Math.max(1, rows - (withHeader ? 1 : 0));
  for (let r = 0; r < bodyRows; r++) {
    const tr = document.createElement('tr');
    for (let c = 0; c < cols; c++) {
      tr.appendChild(emptyCell('td'));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function emptyCell(tag: 'td' | 'th'): HTMLTableCellElement {
  const cell = document.createElement(tag);
  cell.appendChild(document.createElement('br'));
  return cell;
}

function splitBlockAndInsert(
  block: HTMLElement,
  range: Range,
  table: HTMLTableElement,
  root: HTMLElement,
): void {
  // List items live inside <ul>/<ol>; the table cannot sit inside <li>, so
  // bubble up to the list itself and split there.
  let target: HTMLElement = block;
  let splitRange: Range = range;
  if (block.tagName === 'LI') {
    const list = block.closest('ul, ol');
    if (list && list !== root) {
      target = list;
      const r = document.createRange();
      r.setStart(range.startContainer, range.startOffset);
      r.setEndAfter(block);
      splitRange = r;
    }
  }

  const parent = target.parentNode;
  if (!parent) return;

  // Extract everything from the cursor through the end of the target block
  // (Range.extractContents clones the wrapping element so we get a stub
  // block back containing the trailing content).
  const afterRange = document.createRange();
  afterRange.setStart(splitRange.startContainer, splitRange.startOffset);
  afterRange.setEndAfter(target);
  const afterFragment = afterRange.extractContents();

  parent.insertBefore(table, target.nextSibling);
  if (afterFragment.childNodes.length > 0) {
    parent.insertBefore(afterFragment, table.nextSibling);
  }

  // Drop the leading clone of the host block if extraction left it empty
  // (cursor was at the start of the block, or the block had no real
  // content besides a stub <br>).
  if (isBlockEmptyOrStubBr(target)) target.remove();
  // Drop the trailing clone too if it ended up empty (cursor was at the
  // end of the block).
  const trailing = table.nextSibling;
  if (trailing instanceof HTMLElement && isBlockEmptyOrStubBr(trailing)) trailing.remove();
}

function placeCaretInFirstCell(table: HTMLTableElement): void {
  const cell = table.querySelector('td, th');
  if (!cell) return;
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.selectNodeContents(cell);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

// ---------- Row insert / delete ----------

export type RowPosition = 'above' | 'below';

/** Insert a new row above or below the row that contains the given cell. */
export function insertRow(cell: HTMLTableCellElement, position: RowPosition): void {
  const table = cell.closest('table');
  if (!table) return;
  const model = buildTableModel(table);
  const pos = findCellPosition(model, cell);
  if (!pos) return;

  const anchor = model.grid[pos.row][pos.col];
  // For "above": insert at the cell's anchor row (pushes it down).
  // For "below": insert just past the cell's bottom-most extent.
  const insertIndex = position === 'above'
    ? anchor.anchorRow
    : anchor.anchorRow + anchor.rowSpan;
  // The row that anchors DOM placement and section detection.
  const anchorRowIndex = position === 'above' ? insertIndex : insertIndex - 1;
  const anchorTr = model.trs[anchorRowIndex];
  if (!anchorTr) return;
  const section = anchorTr.parentElement;
  if (!section) return;
  const cellTag: 'td' | 'th' = section.tagName === 'THEAD' ? 'th' : 'td';

  const newTr = buildRowAt(model, insertIndex, cellTag);
  if (position === 'above') {
    section.insertBefore(newTr, anchorTr);
  } else {
    section.insertBefore(newTr, anchorTr.nextSibling);
  }
}

/**
 * Construct a new <tr> for insertion at the given logical row index. Cells
 * from earlier rows whose rowspan already covers this position are extended
 * in place rather than duplicated.
 */
function buildRowAt(
  model: TableModel,
  insertIndex: number,
  cellTag: 'td' | 'th',
): HTMLTableRowElement {
  const newTr = document.createElement('tr');
  const handled = new Set<HTMLTableCellElement>();
  for (let c = 0; c < model.cols; c++) {
    if (insertIndex > 0 && insertIndex < model.rows) {
      const above = model.grid[insertIndex - 1]?.[c];
      if (above) {
        if (handled.has(above.el)) {
          // Same anchor handled in a previous column — no fresh cell.
          continue;
        }
        const extentBottom = above.anchorRow + above.rowSpan - 1;
        if (extentBottom >= insertIndex) {
          handled.add(above.el);
          setSpans(above.el, above.rowSpan + 1, above.colSpan);
          continue;
        }
        handled.add(above.el);
      }
    }
    newTr.appendChild(emptyCell(cellTag));
  }
  return newTr;
}

/**
 * Delete the row that contains the given cell. If the row is the last row,
 * the entire table is removed instead and the caret moves to a fresh
 * paragraph at the table's location.
 */
export function deleteRow(cell: HTMLTableCellElement, ctx: CommandContext): void {
  const table = cell.closest('table');
  if (!table) return;
  const model = buildTableModel(table);
  const pos = findCellPosition(model, cell);
  if (!pos) return;

  if (model.rows <= 1) {
    deleteTable(table, ctx);
    return;
  }

  // The "row to delete" is the row containing the clicked cell's tr, not
  // necessarily its anchor row.
  const targetTr = cell.parentElement;
  if (!(targetTr instanceof HTMLTableRowElement)) return;
  const targetRowIndex = model.trs.indexOf(targetTr);
  if (targetRowIndex < 0) return;

  const handled = new Set<HTMLTableCellElement>();
  for (let c = 0; c < model.cols; c++) {
    const entry = model.grid[targetRowIndex]?.[c];
    if (!entry || handled.has(entry.el)) continue;
    handled.add(entry.el);

    if (entry.anchorRow === targetRowIndex && entry.rowSpan === 1) {
      // Single-row anchor — just remove it from its parent tr.
      entry.el.remove();
      continue;
    }

    if (entry.anchorRow === targetRowIndex && entry.rowSpan > 1) {
      // Anchor must move down by one row; its DOM element migrates from this
      // row's tr to the next tr at the correct insertion point.
      const nextTr = model.trs[targetRowIndex + 1];
      const nextInsertBefore = findRowInsertionRef(model, targetRowIndex + 1, entry.anchorCol);
      entry.el.remove();
      setSpans(entry.el, entry.rowSpan - 1, entry.colSpan);
      nextTr.insertBefore(entry.el, nextInsertBefore);
      continue;
    }

    // Carryover from above — shrink the rowspan by 1.
    setSpans(entry.el, entry.rowSpan - 1, entry.colSpan);
  }

  // Remove the now-empty <tr> (it may still contain a stub <br>).
  const section = targetTr.parentElement;
  targetTr.remove();
  if (section && section instanceof HTMLTableSectionElement && section.children.length === 0) {
    section.remove();
  }
}

/** Find the first DOM cell in row `r` whose anchor column is >= targetCol. */
function findRowInsertionRef(
  model: TableModel,
  r: number,
  targetCol: number,
): HTMLTableCellElement | null {
  const tr = model.trs[r];
  if (!tr) return null;
  for (const child of Array.from(tr.children)) {
    if (!(child instanceof HTMLTableCellElement)) continue;
    const anchorCol = anchorColOf(model, r, child);
    if (anchorCol !== null && anchorCol >= targetCol) return child;
  }
  return null;
}

function anchorColOf(
  model: TableModel,
  r: number,
  el: HTMLTableCellElement,
): number | null {
  const row = model.grid[r];
  if (!row) return null;
  for (let c = 0; c < row.length; c++) {
    const entry = row[c];
    if (entry && entry.el === el && entry.anchorRow === r && entry.anchorCol === c) {
      return c;
    }
  }
  return null;
}

// ---------- Column insert / delete ----------

export type ColumnPosition = 'left' | 'right';

export function insertColumn(cell: HTMLTableCellElement, position: ColumnPosition): void {
  const table = cell.closest('table');
  if (!table) return;
  const model = buildTableModel(table);
  const pos = findCellPosition(model, cell);
  if (!pos) return;

  const anchor = model.grid[pos.row][pos.col];
  const refCol = position === 'left' ? anchor.anchorCol : anchor.anchorCol + anchor.colSpan - 1;
  const insertColIndex = position === 'left' ? refCol : refCol + 1;
  insertColumnAt(model, insertColIndex);
}

function insertColumnAt(model: TableModel, insertColIndex: number): void {
  const handled = new Set<HTMLTableCellElement>();
  for (let r = 0; r < model.rows; r++) {
    if (insertColIndex > 0 && insertColIndex < model.cols) {
      const left = model.grid[r]?.[insertColIndex - 1];
      const right = model.grid[r]?.[insertColIndex];
      if (left && right && left.el === right.el) {
        // Insertion falls inside an existing colspan — extend it once.
        if (!handled.has(left.el)) {
          handled.add(left.el);
          setSpans(left.el, left.rowSpan, left.colSpan + 1);
        }
        continue;
      }
    }
    // Fresh cell needed in row r at insertColIndex.
    const tag: 'td' | 'th' = model.sections[r] === 'thead' ? 'th' : 'td';
    const newCell = emptyCell(tag);
    const tr = model.trs[r];
    const insertBeforeRef = findRowInsertionRef(model, r, insertColIndex);
    tr.insertBefore(newCell, insertBeforeRef);
  }

  // Extend <col> entries inside <colgroup>, if present.
  extendColgroup(model.table, insertColIndex);
}

function extendColgroup(table: HTMLTableElement, insertColIndex: number): void {
  const cg = table.querySelector('colgroup');
  if (!cg) return;
  const cols = Array.from(cg.querySelectorAll('col'));
  if (cols.length === 0) return;
  const newCol = document.createElement('col');
  if (insertColIndex >= cols.length) {
    cg.appendChild(newCol);
  } else {
    cg.insertBefore(newCol, cols[insertColIndex]);
  }
}

/** Delete the column containing the given cell. */
export function deleteColumn(cell: HTMLTableCellElement, ctx: CommandContext): void {
  const table = cell.closest('table');
  if (!table) return;
  const model = buildTableModel(table);
  const pos = findCellPosition(model, cell);
  if (!pos) return;

  if (model.cols <= 1) {
    deleteTable(table, ctx);
    return;
  }

  const delCol = pos.col;
  const handled = new Set<HTMLTableCellElement>();
  for (let r = 0; r < model.rows; r++) {
    const entry = model.grid[r]?.[delCol];
    if (!entry || handled.has(entry.el)) continue;
    handled.add(entry.el);

    if (entry.colSpan === 1) {
      entry.el.remove();
    } else {
      setSpans(entry.el, entry.rowSpan, entry.colSpan - 1);
    }
  }

  // Trim <colgroup> if present.
  const cg = table.querySelector('colgroup');
  if (cg) {
    const cols = Array.from(cg.querySelectorAll('col'));
    if (cols[delCol]) cols[delCol].remove();
  }
}

// ---------- Header conversion ----------

/** Promote the row containing the given cell to a <thead> row of <th> cells. */
export function convertRowToHeader(cell: HTMLTableCellElement): void {
  const tr = cell.parentElement;
  if (!(tr instanceof HTMLTableRowElement)) return;
  const table = tr.closest('table');
  if (!table) return;

  // Change all td -> th, preserving attributes and contents.
  for (const child of Array.from(tr.children)) {
    if (child instanceof HTMLTableCellElement && child.tagName === 'TD') {
      changeCellTag(child, 'th');
    }
  }

  // Move the row into <thead> (creating one if needed).
  let thead = table.querySelector(':scope > thead');
  if (!thead) {
    thead = document.createElement('thead');
    table.insertBefore(thead, table.firstChild);
  }
  const oldSection = tr.parentElement;
  thead.appendChild(tr);
  if (
    oldSection &&
    oldSection !== thead &&
    oldSection instanceof HTMLTableSectionElement &&
    oldSection.children.length === 0
  ) {
    oldSection.remove();
  }
}

/** Demote the row containing the given cell to a regular <tbody> row. */
export function removeHeader(cell: HTMLTableCellElement): void {
  const tr = cell.parentElement;
  if (!(tr instanceof HTMLTableRowElement)) return;
  const table = tr.closest('table');
  if (!table) return;

  for (const child of Array.from(tr.children)) {
    if (child instanceof HTMLTableCellElement && child.tagName === 'TH') {
      changeCellTag(child, 'td');
    }
  }

  let tbody = table.querySelector(':scope > tbody');
  if (!tbody) {
    tbody = document.createElement('tbody');
    // Place tbody right after thead if any.
    const thead = table.querySelector(':scope > thead');
    if (thead) {
      table.insertBefore(tbody, thead.nextSibling);
    } else {
      table.insertBefore(tbody, table.firstChild);
    }
  }
  const oldSection = tr.parentElement;
  // Insert at the start of tbody so the previous order is preserved.
  tbody.insertBefore(tr, tbody.firstChild);
  if (
    oldSection &&
    oldSection !== tbody &&
    oldSection instanceof HTMLTableSectionElement &&
    oldSection.children.length === 0
  ) {
    oldSection.remove();
  }
}

function changeCellTag(
  cell: HTMLTableCellElement,
  newTag: 'th' | 'td',
): HTMLTableCellElement {
  if (cell.tagName.toLowerCase() === newTag) return cell;
  const next = document.createElement(newTag);
  for (const attr of Array.from(cell.attributes)) {
    next.setAttribute(attr.name, attr.value);
  }
  while (cell.firstChild) next.appendChild(cell.firstChild);
  cell.replaceWith(next);
  return next;
}

/**
 * Promote the column containing the given cell to a header column. Each
 * tbody/tfoot cell whose anchor lies in this column is rewritten as
 * `<th scope="row">`. thead cells are left untouched — they are managed by
 * the row-header feature and are already <th>.
 */
export function convertColumnToHeader(cell: HTMLTableCellElement): void {
  const table = cell.closest('table');
  if (!table) return;
  const model = buildTableModel(table);
  const pos = findCellPosition(model, cell);
  if (!pos) return;
  const colIndex = pos.col;

  const handled = new Set<HTMLTableCellElement>();
  for (let r = 0; r < model.rows; r++) {
    if (model.sections[r] === 'thead') continue;
    const entry = model.grid[r]?.[colIndex];
    if (!entry || handled.has(entry.el)) continue;
    // Only convert cells whose anchor sits in this column; a cell that spans
    // in from an earlier column is not "owned" by this column.
    if (entry.anchorCol !== colIndex) continue;
    handled.add(entry.el);
    const next = changeCellTag(entry.el, 'th');
    next.setAttribute('scope', 'row');
  }
}

/** Demote the column containing the given cell back to a body column. */
export function convertColumnToBody(cell: HTMLTableCellElement): void {
  const table = cell.closest('table');
  if (!table) return;
  const model = buildTableModel(table);
  const pos = findCellPosition(model, cell);
  if (!pos) return;
  const colIndex = pos.col;

  const handled = new Set<HTMLTableCellElement>();
  for (let r = 0; r < model.rows; r++) {
    if (model.sections[r] === 'thead') continue;
    const entry = model.grid[r]?.[colIndex];
    if (!entry || handled.has(entry.el)) continue;
    if (entry.anchorCol !== colIndex) continue;
    handled.add(entry.el);
    const next = changeCellTag(entry.el, 'td');
    next.removeAttribute('scope');
  }
}

/**
 * Determine whether the column at `colIndex` is acting as a row-header
 * column — that is, every non-thead anchor in that column is a <th>.
 */
export function isColumnHeader(table: HTMLTableElement, colIndex: number): boolean {
  const model = buildTableModel(table);
  if (colIndex < 0 || colIndex >= model.cols) return false;
  let saw = false;
  for (let r = 0; r < model.rows; r++) {
    if (model.sections[r] === 'thead') continue;
    const entry = model.grid[r]?.[colIndex];
    if (!entry || entry.anchorCol !== colIndex) continue;
    saw = true;
    if (entry.el.tagName !== 'TH') return false;
  }
  return saw;
}

// ---------- Merge / split ----------

/**
 * Merge the rectangular range that bounds two cells into a single cell.
 * Returns the surviving anchor, or null if the rectangle could not be
 * established (e.g. the two cells live in different tables).
 */
export function mergeCells(
  a: HTMLTableCellElement,
  b: HTMLTableCellElement,
): HTMLTableCellElement | null {
  const table = a.closest('table');
  if (!table || !table.contains(b)) return null;
  const model = buildTableModel(table);

  const initialRect = boundingRect(model, a, b);
  if (!initialRect) return null;
  const rect = tightenRect(model, initialRect);
  if (rect.row1 === rect.row2 && rect.col1 === rect.col2) return a;

  const anchors = anchorsInRect(model, rect);
  const topLeftEntry = model.grid[rect.row1]?.[rect.col1];
  if (!topLeftEntry) return null;
  const survivor = topLeftEntry.el;

  for (const entry of anchors) {
    if (entry.el === survivor) continue;
    // Append the merged cell's contents to the survivor so no text is lost.
    while (entry.el.firstChild) {
      survivor.appendChild(entry.el.firstChild);
    }
    entry.el.remove();
  }

  setSpans(
    survivor,
    rect.row2 - rect.row1 + 1,
    rect.col2 - rect.col1 + 1,
  );
  return survivor;
}

/** Split a merged cell back into its constituent (rowSpan * colSpan) cells. */
export function splitCell(cell: HTMLTableCellElement): void {
  const table = cell.closest('table');
  if (!table) return;
  if (cell.rowSpan <= 1 && cell.colSpan <= 1) return;

  const model = buildTableModel(table);
  const pos = findCellPosition(model, cell);
  if (!pos) return;

  const origRowSpan = cell.rowSpan;
  const origColSpan = cell.colSpan;
  // Use the original cell's tag for new cells in pos.row, and the section's
  // default tag (th in thead, td otherwise) for rows below.
  const cellTag: 'td' | 'th' = cell.tagName === 'TH' ? 'th' : 'td';

  setSpans(cell, 1, 1);

  // For the anchor row, insert new cells right after the original cell.
  let prev: ChildNode = cell;
  for (let cc = 1; cc < origColSpan; cc++) {
    const fresh = emptyCell(cellTag);
    prev.parentNode!.insertBefore(fresh, prev.nextSibling);
    prev = fresh;
  }

  // For each row below, insert origColSpan new cells at the original column.
  for (let rr = pos.row + 1; rr < pos.row + origRowSpan; rr++) {
    const tr = model.trs[rr];
    if (!tr) continue;
    const tag: 'td' | 'th' = model.sections[rr] === 'thead' ? 'th' : cellTag === 'th' ? 'th' : 'td';
    // Insertion point: first child whose anchorCol >= pos.col + origColSpan
    // in the ORIGINAL model. Any DOM-mutations so far affect only the
    // pos.row tr, so the anchorCol lookup for rr remains valid.
    const ref = findRowInsertionRef(model, rr, pos.col + origColSpan);
    for (let cc = 0; cc < origColSpan; cc++) {
      const fresh = emptyCell(tag);
      tr.insertBefore(fresh, ref);
    }
  }
}

// ---------- Delete table ----------

/** Remove the table entirely and place a fresh paragraph at its old location. */
export function deleteTable(table: HTMLTableElement, ctx: CommandContext): void {
  const parent = table.parentNode;
  if (!parent) return;
  const p = document.createElement('p');
  p.appendChild(document.createElement('br'));
  parent.insertBefore(p, table);
  table.remove();

  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.setStart(p, 0);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);

  // Reference ctx.root so callers that pass it intentionally do not trip a
  // lint warning; the parameter is here so the API matches other commands.
  void ctx.root;
}

// ---------- Column width ----------

export type TableWidthMode = 'px' | 'percent';

/**
 * Determine whether the table is currently sized in pixels or percent.
 * Inspected from the first <col> with a width style; tables with no width
 * information default to px mode.
 */
export function getTableWidthMode(table: HTMLTableElement): TableWidthMode {
  const cg = table.querySelector(':scope > colgroup');
  if (!cg) return 'px';
  for (const col of Array.from(cg.children)) {
    const w = (col as HTMLElement).style.width;
    if (!w) continue;
    return w.trim().endsWith('%') ? 'percent' : 'px';
  }
  return 'px';
}

/**
 * Switch the entire table to the requested width unit. The currently
 * rendered per-column widths are captured and re-written in the target unit
 * (px / %) so the visual layout is preserved across the switch.
 */
export function setTableWidthMode(table: HTMLTableElement, mode: TableWidthMode): void {
  const model = buildTableModel(table);
  if (model.cols === 0) return;
  const cg = ensureColgroup(table, model);

  const renderedWidths = measureColumnWidths(model);
  const measuredTotal = renderedWidths.reduce((acc, w) => acc + (w > 0 ? w : 0), 0);
  const tableRect = table.getBoundingClientRect().width;
  const totalPx = measuredTotal > 0 ? measuredTotal : tableRect;

  for (let i = 0; i < model.cols; i++) {
    const col = cg.children[i] as HTMLElement;
    const px = renderedWidths[i] > 0
      ? renderedWidths[i]
      : (totalPx > 0 ? totalPx / model.cols : 0);
    if (mode === 'percent') {
      const pct = totalPx > 0 ? (px / totalPx) * 100 : 100 / model.cols;
      col.style.width = `${pct.toFixed(2)}%`;
    } else {
      // Fall back to a sensible default so an unmeasured column still gets
      // a real px value (rather than 0).
      const value = px > 0 ? Math.round(px) : 80;
      col.style.width = `${value}px`;
    }
  }

  applyFixedLayoutStyle(table, mode);
}

/**
 * Set the width of the column at colIndex via <colgroup>/<col>. The width is
 * passed in pixels; if the table is in percent mode, the value is converted
 * to a percentage of the table's rendered width before being stored.
 *
 * The default stylesheet renders tables as `display: block; width: 100%`,
 * which prevents <col> widths from taking effect. On first call we capture
 * each column's current rendered width, freeze the table to
 * `display: table; table-layout: fixed`, and seed every <col> so subsequent
 * resizes (including the rightmost column) apply predictably.
 */
export function setColumnWidth(
  table: HTMLTableElement,
  colIndex: number,
  widthPx: number,
): void {
  const model = buildTableModel(table);
  if (colIndex < 0 || colIndex >= model.cols) return;

  const cg = ensureColgroup(table, model);
  const mode = getTableWidthMode(table);

  // First time the resize layout is being applied: seed each <col> with its
  // currently-rendered width in the active unit.
  if (table.style.tableLayout !== 'fixed') {
    const widths = measureColumnWidths(model);
    const measuredTotal = widths.reduce((acc, w) => acc + (w > 0 ? w : 0), 0);
    const fallbackTotal = measuredTotal > 0 ? measuredTotal : table.getBoundingClientRect().width;
    for (let i = 0; i < model.cols; i++) {
      const col = cg.children[i] as HTMLElement;
      if (col.style.width) continue;
      if (widths[i] <= 0) continue;
      if (mode === 'percent' && fallbackTotal > 0) {
        const pct = (widths[i] / fallbackTotal) * 100;
        col.style.width = `${pct.toFixed(2)}%`;
      } else {
        col.style.width = `${Math.round(widths[i])}px`;
      }
    }
    applyFixedLayoutStyle(table, mode);
  }

  const col = cg.children[colIndex] as HTMLElement;
  if (mode === 'percent') {
    const total = table.getBoundingClientRect().width;
    if (total <= 0) return;
    const pct = clampPercent((widthPx / total) * 100);
    col.style.width = `${pct.toFixed(2)}%`;
  } else {
    col.style.width = `${Math.max(20, Math.round(widthPx))}px`;
  }
}

function applyFixedLayoutStyle(table: HTMLTableElement, mode: TableWidthMode): void {
  table.style.display = 'table';
  table.style.width = mode === 'percent' ? '100%' : 'auto';
  table.style.tableLayout = 'fixed';
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value < 1) return 1;
  if (value > 100) return 100;
  return value;
}

function ensureColgroup(table: HTMLTableElement, model: TableModel): HTMLElement {
  let cg = table.querySelector(':scope > colgroup');
  if (!cg) {
    cg = document.createElement('colgroup');
    table.insertBefore(cg, table.firstChild);
  }
  while (cg.children.length < model.cols) {
    cg.appendChild(document.createElement('col'));
  }
  return cg;
}

function measureColumnWidths(model: TableModel): number[] {
  const widths: number[] = new Array<number>(model.cols).fill(0);
  for (let r = 0; r < model.rows; r++) {
    const row = model.grid[r];
    if (!row) continue;
    for (let c = 0; c < model.cols; c++) {
      const entry = row[c];
      if (!entry) continue;
      if (entry.anchorRow !== r || entry.anchorCol !== c) continue;
      // Single-column cells give us the most accurate per-column width.
      if (entry.colSpan !== 1) continue;
      const w = entry.el.getBoundingClientRect().width;
      if (w > widths[c]) widths[c] = w;
    }
  }
  return widths;
}

// ---------- Tab navigation ----------

/** Find the next/previous cell in DOM order for Tab/Shift+Tab navigation. */
export function adjacentCell(
  cell: HTMLTableCellElement,
  direction: 'next' | 'prev',
): HTMLTableCellElement | null {
  const table = cell.closest('table');
  if (!table) return null;
  const cells = Array.from(table.querySelectorAll('td, th'));
  const idx = cells.indexOf(cell);
  if (idx < 0) return null;
  const next = direction === 'next' ? cells[idx + 1] : cells[idx - 1];
  return next ?? null;
}

/** Append a fresh row to the table and return its first cell. */
export function appendRowAtEnd(table: HTMLTableElement): HTMLTableCellElement | null {
  const model = buildTableModel(table);
  if (model.rows === 0 || model.cols === 0) return null;
  const lastTr = model.trs[model.rows - 1];
  const section = lastTr.parentElement;
  if (!section) return null;
  const cellTag: 'td' | 'th' = section.tagName === 'THEAD' ? 'th' : 'td';
  const newTr = buildRowAt(model, model.rows, cellTag);
  section.insertBefore(newTr, lastTr.nextSibling);
  return newTr.querySelector('td, th');
}

// ---------- helpers ----------

function setSpans(cell: HTMLTableCellElement, rowSpan: number, colSpan: number): void {
  if (rowSpan <= 1) cell.removeAttribute('rowspan');
  else cell.setAttribute('rowspan', String(rowSpan));
  if (colSpan <= 1) cell.removeAttribute('colspan');
  else cell.setAttribute('colspan', String(colSpan));
}

// Re-export a few helpers callers commonly need together with these commands.
export { findCell, findTable };
export type { LogicalCell, TableModel, TableSectionKind };
