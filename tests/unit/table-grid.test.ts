import { describe, expect, it } from 'vitest';

import {
  findGridCell,
  findTableCell,
  listCellsInTableOrder,
  listTableRows,
  mapColumnElements,
  readCellTable,
  readGroupEnds,
  resolveTableGrid,
} from '../../webview/editing/table-grid';
import type { TableGrid } from '../../webview/editing/table-grid';
import { createRoot, readChildText, readElement } from './helpers/format-dom';

/**
 * Reads, for each slot of the logical grid, the text of the covering cell. A gap becomes `null`.
 *
 * @param grid The logical grid.
 * @returns For each row, the cell text for each slot.
 */
function readSlotTexts(grid: TableGrid): (string | null)[][] {
  return grid.slots.map((row) => row.map((slot) => slot?.element.textContent ?? null));
}

/**
 * Creates an editor root holding a single table and returns that table.
 *
 * @param html The HTML of the table.
 * @returns The table element.
 */
function createTable(html: string): Element {
  return readElement(createRoot(html), 'table');
}

/**
 * Creates a row outside any section from the row's HTML. Parsing would add a tbody around a row directly under the
 * table, so it is built with the DOM.
 *
 * @param html The HTML of the row's contents.
 * @returns The row element.
 */
function createRow(html: string): Element {
  const row = document.createElement('tr');
  row.innerHTML = html;
  return row;
}

describe('resolving the logical grid', () => {
  it('in a 2-by-3 table without spans, maps each slot to the cell in sibling order within the row, with 3 columns', () => {
    const table = createTable('<table><tbody><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>d</td><td>e</td><td>f</td></tr></tbody></table>');

    const grid = resolveTableGrid(table);

    expect([readSlotTexts(grid), grid.columnCount]).toEqual([[['a', 'b', 'c'], ['d', 'e', 'f']], 3]);
  });

  it('skips a slot covered by a rowspan from an upper row, placing the next cell of that row in the slot to the right', () => {
    const table = createTable('<table><tbody><tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr></tbody></table>');

    const grid = resolveTableGrid(table);

    expect(readSlotTexts(grid)).toEqual([['a', 'b'], ['a', 'c']]);
  });

  it('a cell with colspan 2 and rowspan 2 has its origin and spans, and maps to the 4 slots it covers', () => {
    const table = createTable('<table><tbody><tr><td>x</td><td colspan="2" rowspan="2">a</td></tr><tr><td>y</td></tr><tr><td>p</td><td>q</td><td>r</td></tr></tbody></table>');

    const grid = resolveTableGrid(table);
    const cell = grid.cells.find((candidate) => candidate.element.textContent === 'a');

    expect([
      cell === undefined ? undefined : [cell.row, cell.column, cell.rowSpan, cell.columnSpan, cell.clipped],
      readSlotTexts(grid),
    ]).toEqual([[0, 1, 2, 2, false], [['x', 'a', 'a'], ['y', 'a', 'a'], ['p', 'q', 'r']]]);
  });

  it('a cell whose rowspan exceeds the rows of its section is clipped at the last row of the section, with clipped true', () => {
    const table = createTable('<table><tbody><tr><td rowspan="5">a</td><td>b</td></tr><tr><td>c</td></tr></tbody><tbody><tr><td>d</td><td>e</td></tr></tbody></table>');

    const grid = resolveTableGrid(table);
    const cell = grid.cells.find((candidate) => candidate.element.textContent === 'a');

    expect([cell?.rowSpan, cell?.clipped, readSlotTexts(grid)])
      .toEqual([2, true, [['a', 'b'], ['a', 'c'], ['d', 'e']]]);
  });

  it('a cell with rowspan="0" extends to the end of the section, with clipped true', () => {
    const table = createTable('<table><tbody><tr><td rowspan="0">a</td><td>b</td></tr><tr><td>c</td></tr><tr><td>d</td></tr></tbody></table>');

    const grid = resolveTableGrid(table);
    const cell = grid.cells.find((candidate) => candidate.element.textContent === 'a');

    expect([cell?.rowSpan, cell?.clipped, readSlotTexts(grid)])
      .toEqual([3, true, [['a', 'b'], ['a', 'c'], ['a', 'd']]]);
  });

  it('reads colspan 0 and non-numeric values as 1, and values above 1000 as 1000', () => {
    const table = createTable('<table><tbody><tr><td colspan="0">a</td><td colspan="x">b</td><td colspan="1200">c</td></tr></tbody></table>');

    const grid = resolveTableGrid(table);

    expect(grid.cells.map((cell) => cell.columnSpan)).toEqual([1, 1, 1000]);
  });

  it('in a table with uneven cell counts per row, matches the column count to the longest row and leaves missing slots as gaps', () => {
    const table = createTable('<table><tbody><tr><td>a</td></tr><tr><td>b</td><td>c</td><td>d</td></tr></tbody></table>');

    const grid = resolveTableGrid(table);

    expect([grid.columnCount, readSlotTexts(grid)]).toEqual([3, [['a', null, null], ['b', 'c', 'd']]]);
  });

  it('cells of a nested table are in neither the slots nor the cells of the outer table', () => {
    const table = createTable('<table><tbody><tr><td>a<table><tbody><tr><td>x</td><td>y</td></tr></tbody></table></td><td>b</td></tr></tbody></table>');

    const grid = resolveTableGrid(table);

    expect([grid.columnCount, grid.cells.map((cell) => cell.element.firstChild?.textContent)])
      .toEqual([2, ['a', 'b']]);
  });

  it('in an overlap where a later row colspan extends into a slot covered by a rowspan, maps that slot to the cell placed first', () => {
    const table = createTable('<table><tbody><tr><td>a</td><td rowspan="2">b</td></tr><tr><td colspan="2">c</td></tr></tbody></table>');

    const grid = resolveTableGrid(table);
    const later = grid.cells.find((candidate) => candidate.element.textContent === 'c');

    expect([readSlotTexts(grid), later?.column, later?.columnSpan])
      .toEqual([[['a', 'b'], ['c', 'b']], 0, 2]);
  });

  it('building the logical grid leaves the serialization of the table unchanged', () => {
    const table = createTable('<table>\n<thead><tr><th scope="col">h</th></tr></thead>\n<tbody><tr><td rowspan="0">a</td></tr></tbody>\n</table>');
    const before = table.outerHTML;

    resolveTableGrid(table);

    expect(table.outerHTML).toBe(before);
  });
});

describe('looking up logical grid cells', () => {
  it('returns the cell with its origin row and column for a table cell element, and undefined for a cell of a nested table', () => {
    const root = createRoot('<table><tbody><tr><td>a</td><td id="b">b<table><tbody><tr><td id="inner">x</td></tr></tbody></table></td></tr></tbody></table>');
    const grid = resolveTableGrid(readElement(root, 'table'));

    const found = findGridCell(grid, readElement(root, '#b'));

    expect([found?.row, found?.column, findGridCell(grid, readElement(root, '#inner'))]).toEqual([0, 1, undefined]);
  });
});

describe('the order of table rows', () => {
  it('orders rows as thead, tbody, tfoot even in a table written as tfoot, tbody, thead', () => {
    const table = createTable('<table><tfoot><tr><td>f</td></tr></tfoot><tbody><tr><td>b</td></tr></tbody><thead><tr><td>h</td></tr></thead></table>');

    expect(listTableRows(table).map((row) => [row.element.textContent, row.section?.localName]))
      .toEqual([['h', 'thead'], ['b', 'tbody'], ['f', 'tfoot']]);
  });

  it('places a second thead and tfoot at their document-order positions, like other sections', () => {
    const table = createTable('<table><tfoot><tr><td>f1</td></tr></tfoot><thead><tr><td>h1</td></tr></thead><tbody><tr><td>b</td></tr></tbody><tfoot><tr><td>f2</td></tr></tfoot><thead><tr><td>h2</td></tr></thead></table>');

    expect(listTableRows(table).map((row) => row.element.textContent)).toEqual(['h1', 'b', 'f2', 'h2', 'f1']);
  });

  it('orders rows outside any section like tbody rows, and clips a rowspan at the end of a consecutive row group', () => {
    const table = document.createElement('table');
    const body = document.createElement('tbody');
    body.append(createRow('<td>c</td><td>d</td>'));
    table.append(createRow('<td rowspan="3">a</td><td>b</td>'), createRow('<td>x</td>'), body);

    const grid = resolveTableGrid(table);

    expect([grid.rows.map((row) => row.section?.localName), readSlotTexts(grid)])
      .toEqual([[undefined, undefined, 'tbody'], [['a', 'b'], ['a', 'x'], ['c', 'd']]]);
  });
});

describe('row group ends', () => {
  it('returns the index just past the last row of each row group, for each section and each run of consecutive rows outside any section', () => {
    // Display order is h, a, b, c, d, e. a and b are consecutive in the document, and e comes after tbody, so it is
    // in a separate row group.
    const table = document.createElement('table');
    const head = document.createElement('thead');
    head.append(createRow('<th>h</th>'));
    const body = document.createElement('tbody');
    body.append(createRow('<td>c</td>'), createRow('<td>d</td>'));
    table.append(head, createRow('<td>a</td>'), createRow('<td>b</td>'), body, createRow('<td>e</td>'));

    expect(readGroupEnds(listTableRows(table))).toEqual([1, 3, 3, 5, 5, 6]);
  });
});

describe('checking table cells', () => {
  it('returns undefined for a td that is not a child of a row and for a td in a row not belonging to a table', () => {
    const cell = document.createElement('td');
    document.createElement('div').append(cell);
    const row = createRow('<td>a</td>');
    document.createElement('div').append(row);

    expect([readCellTable(cell), readCellTable(readElement(row, 'td'))]).toEqual([undefined, undefined]);
  });

  it('returns the inner cell for a position inside a nested table, and undefined for a position outside the editor root', () => {
    const root = createRoot('<table><tbody><tr><td>a<table><tbody><tr><td id="inner">x</td></tr></tbody></table></td></tr></tbody></table>');
    const inner = readElement(root, '#inner');
    const outside = createRoot('<table><tbody><tr><td>y</td></tr></tbody></table>');

    expect([
      findTableCell(readChildText(inner, 0), root),
      findTableCell(readChildText(readElement(outside, 'td'), 0), root),
    ]).toEqual([inner, undefined]);
  });
});

describe('table order', () => {
  it('orders cells from the thead rows in display order and in sibling order within a row, even in a table written as tfoot, tbody, thead', () => {
    const table = createTable('<table><tfoot><tr><td>f</td><td>g</td></tr></tfoot><tbody><tr><td>b</td><td>c</td></tr></tbody><thead><tr><th>h</th><th>i</th></tr></thead></table>');

    expect(listCellsInTableOrder(table).map((cell) => cell.textContent)).toEqual(['h', 'i', 'b', 'c', 'f', 'g']);
  });

  it('cells of a nested table are not in the table order of the outer table', () => {
    const table = createTable('<table><tbody><tr><td>a<table><tbody><tr><td>x</td></tr></tbody></table></td><td>b</td></tr></tbody></table>');

    expect(listCellsInTableOrder(table).map((cell) => cell.firstChild?.textContent)).toEqual(['a', 'b']);
  });
});

describe('col for each column number', () => {
  it('a col with span 2 fills two columns, and the columns of a colgroup without col are undefined', () => {
    const table = createTable('<table><colgroup span="2"></colgroup><colgroup><col id="a" span="2"><col id="b"></colgroup><tbody><tr><td>x</td></tr></tbody></table>');

    expect(mapColumnElements(table).map((col) => col?.id)).toEqual([undefined, undefined, 'a', 'a', 'b']);
  });
});
