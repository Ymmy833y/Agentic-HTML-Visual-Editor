// Element names of table sections. A row outside any section is treated the same as a row of a tbody.
const SECTION_TAG_NAMES: ReadonlySet<string> = new Set(['thead', 'tbody', 'tfoot']);

// Element names of table cells.
const CELL_TAG_NAMES: ReadonlySet<string> = new Set(['td', 'th']);

/** A row paired with the section it belongs to. */
export interface TableGridRow {
  /** The row element. */
  readonly element: Element;
  /** The section it belongs to. `undefined` for a row outside any section. */
  readonly section: Element | undefined;
}

/** One cell placed on the logical grid. */
export interface TableGridCell {
  /** The cell element. */
  readonly element: Element;
  /** The row of the origin (0-based). */
  readonly row: number;
  /** The column of the origin (0-based). */
  readonly column: number;
  /** The number of rows it spans, after clipping at the end of the section. */
  readonly rowSpan: number;
  /** The number of columns it spans. */
  readonly columnSpan: number;
  /** Whether the rowspan is clipped at the end of the section because it runs past the section or is 0. */
  readonly clipped: boolean;
}

/**
 * The logical grid of a table.
 *
 * A transient value rebuilt for every operation; it does not follow rewrites of the tree. Using it after a
 * rewrite points at shifted slots.
 */
export interface TableGrid {
  /** The table element. */
  readonly table: Element;
  /** The rows in display order. */
  readonly rows: readonly TableGridRow[];
  /** The number of columns, matching the longest row. */
  readonly columnCount: number;
  /** The cells in document order. */
  readonly cells: readonly TableGridCell[];
  /**
   * The cell covering each slot, looked up as `slots[row][column]`. A slot no cell covers (a gap) is `undefined`.
   *
   * A slot in an existing overlap maps to the cell placed first.
   */
  readonly slots: readonly (readonly (TableGridCell | undefined)[])[];
}

/**
 * Builds the logical grid of a table.
 *
 * Places cells at the same slots where the browser draws them. Deciding slots from attribute values alone
 * misses slots covered by a rowspan from an upper row and rowspans clipped at the end of a section, so row and
 * column operations would rewrite the wrong slots. Changes neither the tree nor the selection.
 *
 * @param table The table element.
 * @returns The logical grid.
 */
export function resolveTableGrid(table: Element): TableGrid {
  const rows = listTableRows(table);
  const groupEnds = readGroupEnds(rows);
  const slots: (TableGridCell | undefined)[][] = rows.map(() => []);
  const cells: TableGridCell[] = [];

  rows.forEach((row, rowIndex) => {
    // Like the browser, clip a rowspan that runs past the end of the section at the last row of the section.
    const remaining = groupEnds[rowIndex] - rowIndex;
    let column = 0;
    for (const element of readRowCells(row.element)) {
      while (slots[rowIndex][column] !== undefined) {
        column += 1;
      }
      const columnSpan = readColumnSpan(element);
      const declaredRowSpan = readRowSpan(element);
      const rowSpan = declaredRowSpan === 0 ? remaining : Math.min(declaredRowSpan, remaining);
      const cell: TableGridCell = {
        element,
        row: rowIndex,
        column,
        rowSpan,
        columnSpan,
        clipped: declaredRowSpan === 0 || declaredRowSpan > remaining,
      };
      for (let target = rowIndex; target < rowIndex + rowSpan; target += 1) {
        for (let offset = column; offset < column + columnSpan; offset += 1) {
          // In an existing overlap, keep the cell placed first. Overwriting it with the later cell would leave
          // a hole in the range the earlier cell covers.
          slots[target][offset] ??= cell;
        }
      }
      cells.push(cell);
      column += columnSpan;
    }
  });

  let columnCount = 0;
  for (const row of slots) {
    columnCount = Math.max(columnCount, row.length);
  }
  return {
    table,
    rows,
    columnCount,
    cells: cells.sort(compareDocumentOrder),
    // Pad every row to the column count. A sparse array would hide gaps from iteration.
    slots: slots.map((row) => Array.from({ length: columnCount }, (_, index) => row[index])),
  };
}

/**
 * Returns the logical grid cell for an element.
 *
 * @param grid The logical grid.
 * @param element The cell element.
 * @returns The logical grid cell, or `undefined` if not found.
 */
export function findGridCell(grid: TableGrid, element: Element): TableGridCell | undefined {
  return grid.cells.find((cell) => cell.element === element);
}

/**
 * Returns the rows of a table in display order, each paired with the section it belongs to.
 *
 * The browser draws the first thead at the top and the first tfoot at the bottom, and any later ones at their
 * document-order positions. Counting in document order would make row numbers disagree with what is shown in a
 * table that writes the tfoot first. Rows of nested tables are not included.
 *
 * @param table The table element.
 * @returns The rows in display order.
 */
export function listTableRows(table: Element): TableGridRow[] {
  const head = findChild(table, 'thead');
  const foot = findChild(table, 'tfoot');
  const rows: TableGridRow[] = [];
  const pushSection = (section: Element): void => {
    for (const child of section.children) {
      if (child.localName === 'tr') {
        rows.push({ element: child, section });
      }
    }
  };

  if (head !== undefined) {
    pushSection(head);
  }
  for (const child of table.children) {
    if (child === head || child === foot) {
      continue;
    }
    if (child.localName === 'tr') {
      rows.push({ element: child, section: undefined });
    } else if (SECTION_TAG_NAMES.has(child.localName)) {
      pushSection(child);
    }
  }
  if (foot !== undefined) {
    pushSection(foot);
  }
  return rows;
}

/**
 * Returns the cells of a table in table order (row by row in display order, and in sibling order within a row).
 *
 * Does not order by logical grid slot. Counting a cell that extends down by rowspan once per row would stop on
 * the same cell several times. Cells of nested tables are not included. Does not change the tree.
 *
 * @param table The table element.
 * @returns The cells in table order.
 */
export function listCellsInTableOrder(table: Element): Element[] {
  return listTableRows(table).flatMap((row) => readRowCells(row.element));
}

/**
 * Returns the innermost table cell containing the node of a position.
 *
 * @param node The node of the position.
 * @param root The editor root.
 * @returns The innermost td or th. `undefined` outside the editor root and for a td or th that does not belong
 *   to a table row.
 */
export function findTableCell(node: Node, root: Element): Element | undefined {
  if (!root.contains(node)) {
    return undefined;
  }

  let current: Element | null = node instanceof Element ? node : node.parentElement;
  while (current !== null && current !== root) {
    if (CELL_TAG_NAMES.has(current.localName)) {
      return readCellTable(current) === undefined ? undefined : current;
    }
    current = current.parentElement;
  }
  return undefined;
}

/**
 * Checks whether an element is a table cell and returns the table of that cell.
 *
 * The browser does not draw a td or th as a table cell when it is not a child of a row, or when it is inside a
 * row that belongs to neither a table nor a section. Treating these as table cells would base an operation on a
 * cell that is not on the logical grid.
 *
 * @param element The element to check.
 * @returns The table of the cell, or `undefined` if it is not a table cell.
 */
export function readCellTable(element: Element): Element | undefined {
  if (!CELL_TAG_NAMES.has(element.localName)) {
    return undefined;
  }
  const row = element.parentElement;
  if (row === null || row.localName !== 'tr') {
    return undefined;
  }
  const parent = row.parentElement;
  if (parent === null) {
    return undefined;
  }
  if (parent.localName === 'table') {
    return parent;
  }
  const table = parent.parentElement;
  return SECTION_TAG_NAMES.has(parent.localName) && table !== null && table.localName === 'table'
    ? table
    : undefined;
}

/**
 * Returns, for each column number, the col element responsible for that column.
 *
 * A colgroup without col elements still covers as many columns as its span, so those columns are counted as
 * `undefined`. Skipping them would shift the numbers of the columns covered by later col elements. Does not
 * change the tree.
 *
 * @param table The table element.
 * @returns The col element for each column number, or `undefined` for a column no col covers.
 */
export function mapColumnElements(table: Element): (Element | undefined)[] {
  const columns: (Element | undefined)[] = [];
  for (const group of table.children) {
    if (group.localName !== 'colgroup') {
      continue;
    }
    const cols = [...group.children].filter((child) => child.localName === 'col');
    if (cols.length === 0) {
      columns.push(...Array.from({ length: readColumnElementSpan(group) }, () => undefined));
      continue;
    }
    for (const col of cols) {
      columns.push(...Array.from({ length: readColumnElementSpan(col) }, () => col));
    }
  }
  return columns;
}

/**
 * Returns the first child element with the given name.
 *
 * @param parent The parent element.
 * @param tagName The element name.
 * @returns The child element, or `undefined` if there is none.
 */
function findChild(parent: Element, tagName: string): Element | undefined {
  for (const child of parent.children) {
    if (child.localName === tagName) {
      return child;
    }
  }
  return undefined;
}

/**
 * Returns, for each row, the end index of the row group it belongs to (a section, or a run of consecutive rows
 * outside any section).
 *
 * Exported so that checking whether a rectangle spans table sections uses the same boundaries as the clipping of
 * rowspan.
 *
 * @param rows The rows in display order.
 * @returns For each row, the index just past the last row of its row group.
 */
export function readGroupEnds(rows: readonly TableGridRow[]): number[] {
  const ends: number[] = new Array<number>(rows.length);
  let end = rows.length;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const next = rows[index + 1];
    if (next !== undefined && !isSameGroup(rows[index], next)) {
      end = index + 1;
    }
    ends[index] = end;
  }
  return ends;
}

/**
 * Returns whether two rows adjacent in display order belong to the same row group.
 *
 * Rows outside any section form one row group only while they are consecutive in the document. Even when
 * adjacent in display order, rows that had a section between them are drawn by the browser as separate row
 * groups.
 *
 * @param previous The earlier row.
 * @param current The later row.
 * @returns `true` if they are in the same row group.
 */
function isSameGroup(previous: TableGridRow, current: TableGridRow): boolean {
  if (current.section !== undefined) {
    return current.section === previous.section;
  }
  return previous.section === undefined && current.element.previousElementSibling === previous.element;
}

/**
 * Returns the cells that are children of a row, in sibling order.
 *
 * @param row The row element.
 * @returns The td and th children.
 */
function readRowCells(row: Element): Element[] {
  return [...row.children].filter((child) => CELL_TAG_NAMES.has(child.localName));
}

/**
 * Reads the number of columns a cell spans.
 *
 * Like the browser, clamps to 1–1000 and reads non-numeric values and 0 as 1 (the reflected colSpan property
 * returns values by this rule).
 *
 * @param cell The cell element.
 * @returns The number of columns it spans.
 */
function readColumnSpan(cell: Element): number {
  return cell instanceof HTMLTableCellElement ? cell.colSpan : 1;
}

/**
 * Reads the rowspan of a cell.
 *
 * Like the browser, clamps to 0–65534 and reads non-numeric values as 1 (the reflected rowSpan property returns
 * values by this rule). 0 means extending to the end of the section.
 *
 * @param cell The cell element.
 * @returns The rowspan value.
 */
function readRowSpan(cell: Element): number {
  return cell instanceof HTMLTableCellElement ? cell.rowSpan : 1;
}

/**
 * Reads the number of columns a col or colgroup covers. The reflected span property returns it clamped to
 * 1–1000.
 *
 * @param element A col or colgroup element.
 * @returns The number of columns it covers.
 */
function readColumnElementSpan(element: Element): number {
  return element instanceof HTMLTableColElement ? element.span : 1;
}

/**
 * Compare function for sorting two cells in document order.
 *
 * @param first The first cell.
 * @param second The second cell.
 * @returns Negative if the first comes earlier, positive if later.
 */
function compareDocumentOrder(first: TableGridCell, second: TableGridCell): number {
  if (first.element === second.element) {
    return 0;
  }
  return (first.element.compareDocumentPosition(second.element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    ? -1
    : 1;
}
