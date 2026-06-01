// Merge and split commands for table cells.

import {
  anchorsInRect,
  boundingRect,
  buildTableModel,
  findCellPosition,
  tightenRect,
} from './table-model';
import { emptyCell, findRowInsertionRef, setSpans } from './cell-utils';

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
