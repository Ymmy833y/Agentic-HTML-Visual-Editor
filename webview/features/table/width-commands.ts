// Column-width commands: switch a table between px/percent sizing and resize
// individual columns via <colgroup>/<col>.

import { buildTableModel, type TableModel } from './table-model';

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
