// Low-level cell helpers shared by the structural and merge/split commands.

import type { TableModel } from './table-model';

/** Create an empty cell of the given tag, seeded with a stub <br>. */
export function emptyCell(tag: 'td' | 'th'): HTMLTableCellElement {
  const cell = document.createElement(tag);
  cell.appendChild(document.createElement('br'));
  return cell;
}

/** Write rowspan/colspan attributes, removing them when they collapse to 1. */
export function setSpans(cell: HTMLTableCellElement, rowSpan: number, colSpan: number): void {
  if (rowSpan <= 1) cell.removeAttribute('rowspan');
  else cell.setAttribute('rowspan', String(rowSpan));
  if (colSpan <= 1) cell.removeAttribute('colspan');
  else cell.setAttribute('colspan', String(colSpan));
}

/** Find the first DOM cell in row `r` whose anchor column is >= targetCol. */
export function findRowInsertionRef(
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
