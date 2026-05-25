// Table DOM helpers. Builds a logical grid that resolves colspan/rowspan into
// (row, col) coordinates so command-layer operations can reason about cell
// positions without re-walking the DOM each time.

export type TableSectionKind = 'thead' | 'tbody' | 'tfoot';

export interface LogicalCell {
  /** The DOM <td>/<th> element this position refers to. */
  el: HTMLTableCellElement;
  /** Effective rowSpan (>=1) of the anchor cell. */
  rowSpan: number;
  /** Effective colSpan (>=1) of the anchor cell. */
  colSpan: number;
  /** (row, col) of the anchor. Carry-over positions share the anchor's coords. */
  anchorRow: number;
  anchorCol: number;
  section: TableSectionKind;
}

export interface TableModel {
  table: HTMLTableElement;
  /** Total number of logical columns (max across all rows). */
  cols: number;
  /** Total number of logical rows. */
  rows: number;
  /** rows[r][c] -> LogicalCell. Multi-span positions all reference the same anchor. */
  grid: LogicalCell[][];
  /** All <tr> elements in document order. */
  trs: HTMLTableRowElement[];
  /** Section each row belongs to. */
  sections: TableSectionKind[];
}

/** Climb up to find the nearest <table> ancestor inside the given root. */
export function findTable(node: Node, stopAt: Element): HTMLTableElement | null {
  let cur: Node | null = node;
  while (cur && cur !== stopAt) {
    if (cur instanceof HTMLTableElement) return cur;
    cur = cur.parentNode;
  }
  return null;
}

/** Climb up to find the nearest <td> or <th> ancestor inside the given root. */
export function findCell(node: Node, stopAt: Element): HTMLTableCellElement | null {
  let cur: Node | null = node;
  while (cur && cur !== stopAt) {
    if (cur instanceof HTMLTableCellElement) return cur;
    cur = cur.parentNode;
  }
  return null;
}

/** Determine which section (thead/tbody/tfoot) a row belongs to. */
function sectionOf(tr: HTMLTableRowElement): TableSectionKind {
  const parent = tr.parentElement;
  if (parent instanceof HTMLTableSectionElement) {
    const tag = parent.tagName.toLowerCase();
    if (tag === 'thead') return 'thead';
    if (tag === 'tfoot') return 'tfoot';
  }
  return 'tbody';
}

/** Collect <tr> rows from a table in document order (thead, tbody*, tfoot). */
function collectRows(table: HTMLTableElement): HTMLTableRowElement[] {
  const rows: HTMLTableRowElement[] = [];
  for (const section of Array.from(table.children)) {
    if (section instanceof HTMLTableSectionElement) {
      for (const tr of Array.from(section.children)) {
        if (tr instanceof HTMLTableRowElement) rows.push(tr);
      }
    } else if (section instanceof HTMLTableRowElement) {
      // <tr> directly under <table> (no section wrapper) — uncommon but legal.
      rows.push(section);
    }
  }
  return rows;
}

function readSpan(cell: HTMLTableCellElement, attr: 'colSpan' | 'rowSpan'): number {
  const raw = attr === 'colSpan' ? cell.colSpan : cell.rowSpan;
  return Math.max(1, Number.isFinite(raw) ? raw : 1);
}

/** Build the logical grid for the given table. */
export function buildTableModel(table: HTMLTableElement): TableModel {
  const trs = collectRows(table);
  const sections = trs.map(sectionOf);
  const grid: LogicalCell[][] = trs.map(() => []);
  let maxCols = 0;

  for (let r = 0; r < trs.length; r++) {
    const tr = trs[r];
    let c = 0;
    for (const child of Array.from(tr.children)) {
      if (!(child instanceof HTMLTableCellElement)) continue;
      // Advance past any positions already occupied by rowspans from above.
      while (grid[r][c]) c++;
      const colSpan = readSpan(child, 'colSpan');
      const rowSpan = readSpan(child, 'rowSpan');
      const anchor: LogicalCell = {
        el: child,
        rowSpan,
        colSpan,
        anchorRow: r,
        anchorCol: c,
        section: sections[r],
      };
      for (let dr = 0; dr < rowSpan; dr++) {
        for (let dc = 0; dc < colSpan; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (!grid[rr]) grid[rr] = [];
          grid[rr][cc] = anchor;
        }
      }
      c += colSpan;
      if (c > maxCols) maxCols = c;
    }
  }

  // Normalize each row length so missing trailing positions are explicit.
  for (let r = 0; r < grid.length; r++) {
    if (grid[r].length < maxCols) {
      // Leave gaps as undefined; consumers treat them as "no cell at this position".
      grid[r].length = maxCols;
    }
  }

  return { table, cols: maxCols, rows: trs.length, grid, trs, sections };
}

/**
 * Resolve the logical position of an anchor cell in the model.
 * Returns null if the cell is not an anchor in this model (e.g. it has been
 * detached, or it sits at a covered position which should never happen).
 */
export function findCellPosition(
  model: TableModel,
  cell: HTMLTableCellElement,
): { row: number; col: number } | null {
  for (let r = 0; r < model.grid.length; r++) {
    const row = model.grid[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const entry = row[c];
      if (entry && entry.el === cell && entry.anchorRow === r && entry.anchorCol === c) {
        return { row: r, col: c };
      }
    }
  }
  return null;
}

export interface CellRect {
  row1: number;
  col1: number;
  row2: number;
  col2: number;
}

/**
 * Given two anchor cells, return the smallest axis-aligned rectangle in
 * logical coordinates that contains both. Returns null if either cell is
 * not part of the model.
 */
export function boundingRect(
  model: TableModel,
  a: HTMLTableCellElement,
  b: HTMLTableCellElement,
): CellRect | null {
  const pa = findCellPosition(model, a);
  const pb = findCellPosition(model, b);
  if (!pa || !pb) return null;
  // Expand the rectangle to include the full extent of both anchors.
  const aRowSpan = readSpan(a, 'rowSpan');
  const aColSpan = readSpan(a, 'colSpan');
  const bRowSpan = readSpan(b, 'rowSpan');
  const bColSpan = readSpan(b, 'colSpan');
  return {
    row1: Math.min(pa.row, pb.row),
    col1: Math.min(pa.col, pb.col),
    row2: Math.max(pa.row + aRowSpan - 1, pb.row + bRowSpan - 1),
    col2: Math.max(pa.col + aColSpan - 1, pb.col + bColSpan - 1),
  };
}

/**
 * Expand a rectangle until every anchor cell that overlaps it is fully
 * contained. Returns a tight rectangle whose boundary cuts no merged cell.
 */
export function tightenRect(model: TableModel, rect: CellRect): CellRect {
  let { row1, col1, row2, col2 } = rect;
  let changed = true;
  while (changed) {
    changed = false;
    for (let r = row1; r <= row2; r++) {
      for (let c = col1; c <= col2; c++) {
        const entry = model.grid[r]?.[c];
        if (!entry) continue;
        const ar = entry.anchorRow;
        const ac = entry.anchorCol;
        const r2 = ar + entry.rowSpan - 1;
        const c2 = ac + entry.colSpan - 1;
        if (ar < row1) { row1 = ar; changed = true; }
        if (ac < col1) { col1 = ac; changed = true; }
        if (r2 > row2) { row2 = r2; changed = true; }
        if (c2 > col2) { col2 = c2; changed = true; }
      }
    }
  }
  return { row1, col1, row2, col2 };
}

/** Collect every unique anchor cell whose anchor coords sit inside the rect. */
export function anchorsInRect(model: TableModel, rect: CellRect): LogicalCell[] {
  const seen = new Set<HTMLTableCellElement>();
  const out: LogicalCell[] = [];
  for (let r = rect.row1; r <= rect.row2; r++) {
    for (let c = rect.col1; c <= rect.col2; c++) {
      const entry = model.grid[r]?.[c];
      if (!entry || seen.has(entry.el)) continue;
      if (entry.anchorRow < rect.row1 || entry.anchorCol < rect.col1) continue;
      if (entry.anchorRow + entry.rowSpan - 1 > rect.row2) continue;
      if (entry.anchorCol + entry.colSpan - 1 > rect.col2) continue;
      seen.add(entry.el);
      out.push(entry);
    }
  }
  return out;
}
