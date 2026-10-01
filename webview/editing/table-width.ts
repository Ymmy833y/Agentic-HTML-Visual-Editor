import { BLOCK_SEPARATOR_TEXT, isHtmlWhitespaceOnly } from './block';
import type { BlockRewriteProgress } from './block-format';
import { findGridCell, mapColumnElements } from './table-grid';
import type { TableGrid } from './table-grid';

/** The table width unit: whether the table's column widths are written in % or px. */
export type TableWidthUnit = 'percent' | 'pixel';

/**
 * The rendered widths of the columns and the table. Values are in viewport-coordinate pixels and are temporary values
 * used only within a single operation.
 */
export interface TableColumnMeasure {
  /**
   * The x of the column boundaries. One more than the number of columns: the first is the left edge of the first
   * column and the last is the right edge of the last column.
   */
  readonly boundaries: readonly number[];
  /** The rendered width of each column (the difference between adjacent boundaries). */
  readonly widths: readonly number[];
  /** The rendered width of the table (the difference between the first and last boundaries). */
  readonly tableWidth: number;
  /** The available width: the width of the table when rendered at full width. */
  readonly availableWidth: number;
}

/**
 * The minimum rendered width of a column (px). Keeps a column from collapsing entirely; the same as the prototype.
 *
 * A column currently narrower than this uses its current rendered width as the minimum. This keeps a mere press from
 * widening the column to the minimum and making the boundary jump.
 */
export const MIN_COLUMN_WIDTH = 20;

/**
 * The difference (px) within which a written value and a rendered width are considered the same. Absorbs the rounding
 * of values (px to integers, % to two decimal places) and the fractions in reading the boundaries.
 */
export const COLUMN_WIDTH_TOLERANCE = 1;

// The table sections and rows. An added colgroup is placed before the first of these elements.
const SECTION_OR_ROW_TAG_NAMES: ReadonlySet<string> = new Set(['thead', 'tbody', 'tfoot', 'tr']);

// The spellings read as px values. The width attribute expresses pixels as a unitless number.
const PIXEL_VALUE_PATTERN = /^\+?(?:\d+\.?\d*|\.\d+)(?:px)?$/iu;

/**
 * Returns the table width unit. Does not change the tree.
 *
 * Decided by the first col with a width; when no col has a width, it is %. The bundled styles render the table at the
 * full available width, so % takes effect as is, whereas px columns would be stretched proportionally and not match
 * the pointer position. Cols of nested tables are not counted.
 *
 * @param table The table.
 * @returns `percent` when the first width ends in %, `pixel` for any other value, and `percent` when there is no
 *   width.
 */
export function readTableWidthUnit(table: Element): TableWidthUnit {
  for (const group of table.children) {
    if (group.localName !== 'colgroup') {
      continue;
    }
    for (const col of group.children) {
      const written = col.localName === 'col' ? readWrittenWidth(col) : undefined;
      if (written !== undefined) {
        return written.endsWith('%') ? 'percent' : 'pixel';
      }
    }
  }
  return 'percent';
}

/**
 * Measures the rendered column boundaries and widths and the available width. Does not change the tree (it reads the
 * rendering).
 *
 * The x of a boundary is read from the rectangle of a cell whose left edge is on that boundary (or, failing that, a
 * cell whose right edge is). A boundary on which no cell has an edge, because of merged cells or gaps, is placed at
 * equal intervals between its known neighbors.
 *
 * @param grid The table grid.
 * @returns The measured widths.
 */
export function measureTableColumns(grid: TableGrid): TableColumnMeasure {
  const count = grid.columnCount;
  const lefts: (number | undefined)[] = Array.from({ length: count + 1 }, () => undefined);
  const rights: (number | undefined)[] = Array.from({ length: count + 1 }, () => undefined);
  for (const cell of grid.cells) {
    const rect = cell.element.getBoundingClientRect();
    lefts[cell.column] ??= rect.left;
    rights[cell.column + cell.columnSpan] ??= rect.right;
  }
  const boundaries = fillBoundaries(lefts.map((left, index) => left ?? rights[index]));
  const widths = boundaries.slice(1).map((boundary, index) => boundary - boundaries[index]);
  return {
    boundaries,
    widths,
    tableWidth: count === 0 ? 0 : boundaries[count] - boundaries[0],
    availableWidth: readAvailableWidth(grid.table),
  };
}

/**
 * Returns, for the table width unit, the limits for the rendered width of the target column.
 *
 * A percent table redistributes between the target column and its right neighbor to keep the total, so the limit is
 * where the right neighbor would fall below the minimum. Without keeping the total, the browser would redistribute
 * all columns proportionally. A pixel table is limited to where the table's rendered width does not exceed the
 * available width; for a table that already exceeds it, the current rendered width is the maximum and the column
 * does not move in the widening direction.
 *
 * @param unit The table width unit.
 * @param measure The measured widths.
 * @param column The target column.
 * @returns The minimum and maximum rendered widths. `undefined` for a percent table without a right neighbor.
 */
export function readColumnWidthLimits(
  unit: TableWidthUnit,
  measure: TableColumnMeasure,
  column: number,
): { readonly min: number; readonly max: number } | undefined {
  if (column < 0 || column >= measure.widths.length) {
    return undefined;
  }
  const width = measure.widths[column];
  const min = Math.min(MIN_COLUMN_WIDTH, width);
  if (unit === 'percent') {
    if (column + 1 >= measure.widths.length) {
      return undefined;
    }
    const next = measure.widths[column + 1];
    return { min, max: width + next - Math.min(MIN_COLUMN_WIDTH, next) };
  }
  return { min, max: width + Math.max(0, measure.availableWidth - measure.tableWidth) };
}

/**
 * Gives the rightmost column covered by the reference cell a new rendered width.
 *
 * If even one column has a written value that disagrees with its rendered width, all columns are first set to their
 * current rendered widths. Writing just one column while leaving a disagreement would make the browser redistribute
 * all columns, so the boundary would not land where the pointer was released and untouched columns would change
 * width too. A percent table changes the right neighbor by the opposite amount to keep the total; a pixel table sizes
 * the table to its content (auto). A column whose width to write is within the tolerance of the width derived from
 * its current value keeps its current value, and when every value to write equals the current one, the tree is not
 * changed.
 *
 * @param grid The table grid.
 * @param cell The reference cell.
 * @param width The new rendered width (px). Clamped into the limits when outside them.
 * @param progress Records whether the tree was changed. Set to true just before the tree is first changed.
 */
export function setColumnWidth(
  grid: TableGrid,
  cell: Element,
  width: number,
  progress: BlockRewriteProgress,
): void {
  const origin = findGridCell(grid, cell);
  if (origin === undefined) {
    return;
  }
  const column = origin.column + origin.columnSpan - 1;
  const unit = readTableWidthUnit(grid.table);
  const measure = measureTableColumns(grid);
  const limits = readColumnWidthLimits(unit, measure, column);
  if (measure.tableWidth <= 0 || limits === undefined) {
    return;
  }

  const target = Math.min(Math.max(width, limits.min), limits.max);
  const planned = new Map<number, number>();
  if (!matchesWrittenWidths(grid.table, unit, measure)) {
    measure.widths.forEach((current, index) => planned.set(index, current));
  }
  planned.set(column, target);
  if (unit === 'percent') {
    planned.set(column + 1, measure.widths[column] + measure.widths[column + 1] - target);
  }
  const columns = mapColumnElements(grid.table);
  const values = new Map([...planned].map(([index, planWidth]): [number, string] => {
    const col = columns.at(index);
    const kept = col === undefined || readSpan(col) !== 1
      ? undefined
      : readKeptWidth(col, unit, planWidth, measure.tableWidth);
    return [index, kept ?? formatColumnWidth(unit, planWidth, measure.tableWidth)];
  }));

  // When no column value changes, the table's width is not touched either. For a table whose width is wider than the
  // available width, a drag clamped in the widening direction that only set the table width to auto would shrink the
  // table and move the boundaries.
  const unchanged = [...values].every(([index, value]) => {
    const col = columns[index];
    return col !== undefined && readSpan(col) === 1 && readStyleWidth(col) === value;
  });
  if (unchanged) {
    return;
  }

  progress.changed = true;
  writeColumnWidths(prepareColumnElements(grid, [...values.keys()]), values);
  if (unit === 'pixel') {
    writeTableWidth(grid.table, 'auto');
  }
}

/**
 * Writes the current rendered widths of all columns in the opposite unit.
 *
 * Switching to px sizes the table to its content (auto), so the table's visible width does not change. Switching to %
 * removes the table's width, so the table is rendered at the full available width and the columns widen keeping
 * their proportions. The original width is not kept (undo restores it).
 *
 * @param grid The table grid.
 * @param progress Records whether the tree was changed. Set to true just before the tree is first changed.
 */
export function toggleTableWidthUnit(grid: TableGrid, progress: BlockRewriteProgress): void {
  const next: TableWidthUnit = readTableWidthUnit(grid.table) === 'percent' ? 'pixel' : 'percent';
  const measure = measureTableColumns(grid);
  if (measure.tableWidth <= 0) {
    return;
  }

  const values = new Map(
    measure.widths.map((width, index) => [index, formatColumnWidth(next, width, measure.tableWidth)]),
  );
  progress.changed = true;
  writeColumnWidths(prepareColumnElements(grid, [...values.keys()]), values);
  writeTableWidth(grid.table, next === 'pixel' ? 'auto' : undefined);
}

/**
 * Prepares, for each column to write, a col that covers only that column.
 *
 * The mapping between columns and cols counts cols with a span and colgroups without cols. A col with a span keeps
 * the original element for the first column and drops its span; for the remaining columns, cols copying its
 * attributes except id and span are placed right after it, so the look of each column (its background and so on)
 * does not change. A colgroup without cols gets as many cols as its span, and cols for columns that no colgroup
 * covers are added after the last col of the last colgroup. Cols are placed inside the colgroup without whitespace
 * between them.
 *
 * @param grid The table grid.
 * @param columns The indexes of the columns to write.
 * @returns The col for each column index.
 */
export function prepareColumnElements(grid: TableGrid, columns: readonly number[]): Map<number, Element> {
  const table = grid.table;
  const wanted = new Set(columns);
  if (![...table.children].some((child) => child.localName === 'colgroup')) {
    insertColumnGroup(table);
  }
  separateColumns(table, wanted);

  const last = Math.max(-1, ...columns);
  const covered = mapColumnElements(table).length;
  if (last >= covered) {
    appendColumns(table, last + 1 - covered);
  }

  const mapped = mapColumnElements(table);
  const prepared = new Map<number, Element>();
  for (const column of columns) {
    const col = mapped[column];
    if (col !== undefined) {
      prepared.set(column, col);
    }
  }
  return prepared;
}

/**
 * Spells a rendered width as a value in the table width unit.
 *
 * @param unit The table width unit.
 * @param width The rendered width (px).
 * @param basis The basis for percentages. Pass the table's rendered width (the sum of all columns' rendered widths).
 * @returns For px, the value rounded to an integer; for %, the proportion of the basis rounded to two decimal places
 *   with trailing zeros dropped (`33.33%`, `25%`).
 */
export function formatColumnWidth(unit: TableWidthUnit, width: number, basis: number): string {
  if (unit === 'pixel') {
    return `${Math.round(width)}px`;
  }
  return `${Math.round((width / basis) * 10000) / 100}%`;
}

/**
 * Returns a col's width. The style width takes precedence; without it, the width attribute is read.
 *
 * @param col The col element.
 * @returns The width. `undefined` for `auto` and empty.
 */
function readWrittenWidth(col: Element): string | undefined {
  const styled = readStyleWidth(col);
  const value = (styled === '' ? col.getAttribute('width') ?? '' : styled).trim();
  return value === '' || value.toLowerCase() === 'auto' ? undefined : value;
}

/**
 * Returns an element's style width, in the CSSOM spelling.
 *
 * @param element The element.
 * @returns The style width, or an empty string when there is none.
 */
function readStyleWidth(element: Element): string {
  return element instanceof HTMLElement ? element.style.width : '';
}

/**
 * Returns whether the written values of all columns agree with the rendered widths.
 *
 * @param table The table.
 * @param unit The table width unit.
 * @param measure The measured widths.
 * @returns `true` when every column has a value in the table width unit and the width derived from it is within the
 *   tolerance of the rendered width.
 */
function matchesWrittenWidths(table: Element, unit: TableWidthUnit, measure: TableColumnMeasure): boolean {
  const columns = mapColumnElements(table);
  return measure.widths.every((width, index) => {
    const col = columns.at(index);
    const written = col === undefined ? undefined : readWrittenWidth(col);
    const resolved = written === undefined ? undefined : resolveWrittenWidth(written, unit, measure.tableWidth);
    return resolved !== undefined && Math.abs(resolved - width) <= COLUMN_WIDTH_TOLERANCE;
  });
}

/**
 * Returns the col's current style width when it agrees, within the tolerance, with the rendered width to write.
 *
 * In a table with a width, half of the collapsed borders falls on the table's side, so the rendered width is off
 * from the written value by a fraction. Rounding the rendered width again and writing it would rewrite a value that
 * renders exactly as written into another value, and for a pixel table would also switch the table width to auto and
 * shrink the table.
 *
 * @param col A col that covers only its column.
 * @param unit The table width unit.
 * @param width The rendered width to write (px).
 * @param basis The basis for percentages (the table's rendered width).
 * @returns The current value. `undefined` when it does not agree or there is no style width.
 */
function readKeptWidth(col: Element, unit: TableWidthUnit, width: number, basis: number): string | undefined {
  const current = readStyleWidth(col);
  const resolved = current === '' ? undefined : resolveWrittenWidth(current, unit, basis);
  return resolved !== undefined && Math.abs(resolved - width) <= COLUMN_WIDTH_TOLERANCE ? current : undefined;
}

/**
 * Converts a written value into a rendered width in the table width unit.
 *
 * @param value The written value.
 * @param unit The table width unit.
 * @param basis The basis for percentages (the table's rendered width).
 * @returns The rendered width (px). `undefined` when the value is not in the table width unit.
 */
function resolveWrittenWidth(value: string, unit: TableWidthUnit, basis: number): number | undefined {
  if (unit === 'percent') {
    return value.endsWith('%') ? (Number.parseFloat(value) / 100) * basis : undefined;
  }
  return PIXEL_VALUE_PATTERN.test(value) ? Number.parseFloat(value) : undefined;
}

/**
 * Returns the available width: the content width of the table's parent minus the table's left and right margins.
 *
 * @param table The table.
 * @returns The available width (px).
 */
function readAvailableWidth(table: Element): number {
  const parent = table.parentElement;
  const view = table.ownerDocument.defaultView;
  if (parent === null || view === null) {
    return 0;
  }
  const parentStyle = view.getComputedStyle(parent);
  const tableStyle = view.getComputedStyle(table);
  return parent.clientWidth
    - readLength(parentStyle.paddingLeft)
    - readLength(parentStyle.paddingRight)
    - readLength(tableStyle.marginLeft)
    - readLength(tableStyle.marginRight);
}

/**
 * Returns a computed length as a number.
 *
 * @param value The computed value.
 * @returns The length (px), or 0 when it cannot be read.
 */
function readLength(value: string): number {
  const length = Number.parseFloat(value);
  return Number.isFinite(length) ? length : 0;
}

/**
 * Fills the holes in the list of boundaries. A hole with known neighbors on both sides is placed at equal intervals,
 * and a hole at an end takes the value of the nearest known boundary.
 *
 * @param known The x of each boundary, `undefined` for unknown boundaries.
 * @returns The x of the boundaries. A list of 0 when no boundary is known.
 */
function fillBoundaries(known: readonly (number | undefined)[]): number[] {
  const indexes = known.flatMap((value, index) => (value === undefined ? [] : [index]));
  if (indexes.length === 0) {
    return known.map(() => 0);
  }
  return known.map((value, index) => {
    if (value !== undefined) {
      return value;
    }
    const previous = indexes.filter((candidate) => candidate < index).at(-1);
    const next = indexes.find((candidate) => candidate > index);
    const previousValue = previous === undefined ? undefined : known[previous];
    const nextValue = next === undefined ? undefined : known[next];
    if (previous === undefined || next === undefined || previousValue === undefined || nextValue === undefined) {
      return previousValue ?? nextValue ?? 0;
    }
    return previousValue + ((nextValue - previousValue) * (index - previous)) / (next - previous);
  });
}

/**
 * Adds one colgroup to the table on its own line: a line break is put before it, and it is inserted before the
 * whitespace immediately preceding the table's first section or row.
 *
 * @param table The table.
 */
function insertColumnGroup(table: Element): void {
  const document = table.ownerDocument;
  const first = [...table.children].find((child) => SECTION_OR_ROW_TAG_NAMES.has(child.localName));
  const previous = first?.previousSibling ?? null;
  const reference = first === undefined
    ? null
    : previous instanceof Text && isHtmlWhitespaceOnly(previous.data) ? previous : first;
  table.insertBefore(document.createTextNode(BLOCK_SEPARATOR_TEXT), reference);
  table.insertBefore(document.createElement('colgroup'), reference);
}

/**
 * Splits cols with a span that cover columns to write into one col per column, and adds cols to colgroups without
 * cols.
 *
 * @param table The table.
 * @param wanted The indexes of the columns to write.
 */
function separateColumns(table: Element, wanted: ReadonlySet<number>): void {
  const covers = (start: number, span: number): boolean => {
    for (let column = start; column < start + span; column += 1) {
      if (wanted.has(column)) {
        return true;
      }
    }
    return false;
  };

  let start = 0;
  for (const group of [...table.children]) {
    if (group.localName !== 'colgroup') {
      continue;
    }
    const cols = [...group.children].filter((child) => child.localName === 'col');
    if (cols.length === 0) {
      const span = readSpan(group);
      if (covers(start, span)) {
        fillColumnGroup(group);
      }
      start += span;
      continue;
    }
    for (const col of cols) {
      const span = readSpan(col);
      if (span > 1 && covers(start, span)) {
        splitColumnElement(col, span);
      }
      start += span;
    }
  }
}

/**
 * Adds cols for the columns that no colgroup covers after the last col of the last colgroup.
 *
 * If the last colgroup has no cols, as many cols as its span are added first. Adding cols directly would change the
 * number of columns that colgroup covers from its span to its number of cols, shifting the columns after it.
 *
 * @param table The table.
 * @param count The number of cols to add.
 */
function appendColumns(table: Element, count: number): void {
  const group = [...table.children].filter((child) => child.localName === 'colgroup').at(-1);
  if (group === undefined) {
    return;
  }
  if (![...group.children].some((child) => child.localName === 'col')) {
    fillColumnGroup(group);
  }
  let anchor = [...group.children].filter((child) => child.localName === 'col').at(-1);
  for (let index = 0; index < count; index += 1) {
    const col = table.ownerDocument.createElement('col');
    if (anchor === undefined) {
      group.append(col);
    } else {
      anchor.after(col);
    }
    anchor = col;
  }
}

/**
 * Adds as many attribute-less cols as its span to a colgroup without cols.
 *
 * @param group The colgroup.
 */
function fillColumnGroup(group: Element): void {
  const span = readSpan(group);
  for (let index = 0; index < span; index += 1) {
    group.append(group.ownerDocument.createElement('col'));
  }
}

/**
 * Splits a col with a span into one col per column.
 *
 * The original element stays on the first column and drops its span. For the remaining columns, cols that copy its
 * attributes, namespaces included, except id and span are placed right after it. Copying id would repeat the same id,
 * and copying span would shift the columns.
 *
 * @param col A col with a span.
 * @param span The span value.
 */
function splitColumnElement(col: Element, span: number): void {
  let anchor = col;
  for (let index = 1; index < span; index += 1) {
    const copy = col.ownerDocument.createElement('col');
    for (const attribute of col.attributes) {
      if (attribute.namespaceURI === null && (attribute.localName === 'id' || attribute.localName === 'span')) {
        continue;
      }
      const clone = attribute.cloneNode();
      if (clone instanceof Attr) {
        copy.setAttributeNodeNS(clone);
      }
    }
    anchor.after(copy);
    anchor = copy;
  }
  col.removeAttribute('span');
}

/**
 * Writes the style width of each column's col. The width attribute is kept (the style takes precedence).
 *
 * @param columns The col for each column index.
 * @param values The value for each column index.
 */
function writeColumnWidths(columns: ReadonlyMap<number, Element>, values: ReadonlyMap<number, string>): void {
  for (const [column, value] of values) {
    const col = columns.get(column);
    if (col instanceof HTMLElement) {
      col.style.width = value;
    }
  }
}

/**
 * Writes or removes the table's style width. When removing leaves the style empty, the attribute itself is removed.
 *
 * @param table The table.
 * @param value The value to write. `undefined` removes it.
 */
function writeTableWidth(table: Element, value: string | undefined): void {
  if (!(table instanceof HTMLElement)) {
    return;
  }
  if (value !== undefined) {
    table.style.width = value;
    return;
  }
  table.style.removeProperty('width');
  if (table.style.length === 0) {
    table.removeAttribute('style');
  }
}

/**
 * Returns the number of columns a col or colgroup covers. The reflected span is clamped to 1 to 1000.
 *
 * @param element A col or colgroup.
 * @returns The number of columns covered.
 */
function readSpan(element: Element): number {
  return element instanceof HTMLTableColElement ? element.span : 1;
}
