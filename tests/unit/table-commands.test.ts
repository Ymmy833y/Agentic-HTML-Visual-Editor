import { afterEach, describe, expect, it } from 'vitest';
import {
  adjacentCell,
  appendRowAtEnd,
  convertColumnToBody,
  convertColumnToHeader,
  convertRowToHeader,
  deleteColumn,
  deleteRow,
  deleteTable,
  getTableWidthMode,
  insertColumn,
  insertRow,
  insertTable,
  isColumnHeader,
  mergeCells,
  removeHeader,
  setColumnWidth,
  setTableWidthMode,
  splitCell,
} from '../../webview/table-commands';
import type { CommandContext } from '../../webview/commands';
import { caretAtEnd, caretAtStart, clearDom, makeRoot, selectTextRange } from './helpers/selection';

afterEach(clearDom);

function ctxOf(root: HTMLElement): CommandContext {
  return { root };
}

function tableOf(root: HTMLElement): HTMLTableElement {
  return root.querySelector('table') as HTMLTableElement;
}

function cellAt(root: HTMLElement, index: number): HTMLTableCellElement {
  const cells = root.querySelectorAll('td, th');
  return cells[index] as HTMLTableCellElement;
}

// jsdom returns 0 from getBoundingClientRect because it does no layout.
// These helpers stub a specific rendered width on cells / the table so we
// can exercise the unit conversions deterministically.
function stubCellWidths(table: HTMLTableElement, widthsByColumn: number[]): void {
  const rows = table.querySelectorAll('tr');
  for (const row of Array.from(rows)) {
    const cells = row.querySelectorAll('td, th');
    cells.forEach((cell, i) => {
      const w = widthsByColumn[i % widthsByColumn.length] ?? 0;
      Object.defineProperty(cell, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ width: w, height: 20, top: 0, left: 0, right: w, bottom: 20, x: 0, y: 0, toJSON: () => '' }),
      });
    });
  }
}

function stubTableWidth(table: HTMLTableElement, widthPx: number): void {
  Object.defineProperty(table, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width: widthPx, height: 100, top: 0, left: 0, right: widthPx, bottom: 100, x: 0, y: 0, toJSON: () => '' }),
  });
}

describe('insertTable', () => {
  it('inserts a 2x3 table with a thead row at the current block', () => {
    const root = makeRoot('<p>before</p>');
    caretAtEnd(root.querySelector('p')!);
    insertTable({ rows: 2, cols: 3, withHeader: true }, ctxOf(root));
    const tables = root.querySelectorAll('table');
    expect(tables.length).toBe(1);
    const thRow = tables[0].querySelector('thead tr')!;
    expect(thRow.querySelectorAll('th').length).toBe(3);
    const bodyRows = tables[0].querySelectorAll('tbody tr');
    expect(bodyRows.length).toBe(1);
    expect(bodyRows[0].querySelectorAll('td').length).toBe(3);
  });

  it('inserts a header-less 3x2 table when withHeader is false', () => {
    const root = makeRoot('<p>x</p>');
    caretAtStart(root.querySelector('p')!);
    insertTable({ rows: 3, cols: 2, withHeader: false }, ctxOf(root));
    const table = tableOf(root);
    expect(table.querySelector('thead')).toBeNull();
    expect(table.querySelectorAll('tbody tr').length).toBe(3);
    expect(table.querySelectorAll('tbody td').length).toBe(6);
  });

  it('splits the host paragraph when the caret is in the middle of it', () => {
    const root = makeRoot('<p>hello world</p>');
    const text = root.querySelector('p')!.firstChild!;
    selectTextRange(text, 5, 5); // caret between "hello" and " world"
    insertTable({ rows: 1, cols: 1, withHeader: false }, ctxOf(root));
    // Expect: <p>hello</p><table>...</table><p> world</p>
    expect(root.children[0].tagName).toBe('P');
    expect(root.children[0].textContent).toBe('hello');
    expect(root.children[1].tagName).toBe('TABLE');
    expect(root.children[2].tagName).toBe('P');
    expect(root.children[2].textContent).toBe(' world');
  });

  it('drops a fully-empty host block instead of leaving a stub paragraph', () => {
    const root = makeRoot('<p><br></p>');
    caretAtStart(root.querySelector('p')!);
    insertTable({ rows: 1, cols: 1, withHeader: false }, ctxOf(root));
    expect(root.querySelectorAll('p').length).toBe(0);
    expect(root.firstElementChild?.tagName).toBe('TABLE');
  });
});

describe('insertRow', () => {
  it('inserts a new row above the target row inside <tbody>', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td>a</td><td>b</td></tr>' +
        '<tr><td>c</td><td>d</td></tr>' +
      '</tbody></table>',
    );
    insertRow(cellAt(root, 2), 'above'); // cell "c" is in row 1
    const tbody = tableOf(root).querySelector('tbody')!;
    expect(tbody.children.length).toBe(3);
    expect(tbody.children[0].textContent).toBe('ab');
    expect(tbody.children[1].textContent).toBe(''); // new empty row (br)
    expect(tbody.children[2].textContent).toBe('cd');
  });

  it('inserts a new row below the target row', () => {
    const root = makeRoot(
      '<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
    );
    insertRow(cellAt(root, 0), 'below');
    const rows = tableOf(root).querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    expect(rows[1].querySelectorAll('td').length).toBe(2);
  });

  it('extends a carrying rowspan instead of adding a fresh cell inside it', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td rowspan="2">tall</td><td>b</td></tr>' +
        '<tr><td>c</td></tr>' +
      '</tbody></table>',
    );
    // Insert a row between the two existing rows. The "tall" cell already
    // spans through that position, so its rowspan should grow from 2 to 3
    // and the new tr should contain only one fresh cell.
    insertRow(cellAt(root, 2), 'above'); // "c" is the third td; row index 1
    const tallCell = root.querySelector('td[rowspan]') as HTMLTableCellElement;
    expect(tallCell.getAttribute('rowspan')).toBe('3');
    const rows = tableOf(root).querySelectorAll('tbody tr');
    expect(rows.length).toBe(3);
    expect(rows[1].children.length).toBe(1);
  });

  it('adds th cells when inserting a row inside <thead>', () => {
    const root = makeRoot(
      '<table>' +
        '<thead><tr><th>A</th><th>B</th></tr></thead>' +
        '<tbody><tr><td>1</td><td>2</td></tr></tbody>' +
      '</table>',
    );
    insertRow(cellAt(root, 0), 'below'); // below "A" in thead
    const thead = tableOf(root).querySelector('thead')!;
    expect(thead.children.length).toBe(2);
    expect(thead.children[1].querySelectorAll('th').length).toBe(2);
    expect(thead.children[1].querySelectorAll('td').length).toBe(0);
  });
});

describe('deleteRow', () => {
  it('removes the row containing the target cell', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td>a</td><td>b</td></tr>' +
        '<tr><td>c</td><td>d</td></tr>' +
      '</tbody></table>',
    );
    deleteRow(cellAt(root, 0), ctxOf(root)); // delete first row
    const rows = tableOf(root).querySelectorAll('tr');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toBe('cd');
  });

  it('migrates an anchor with rowspan when its first row is removed', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td rowspan="2">tall</td><td>b</td></tr>' +
        '<tr><td>c</td></tr>' +
      '</tbody></table>',
    );
    deleteRow(cellAt(root, 0), ctxOf(root)); // delete row 0; "tall" should move
    const rows = tableOf(root).querySelectorAll('tr');
    expect(rows.length).toBe(1);
    // The migrated cell should now lead the surviving row.
    const cells = rows[0].children;
    expect(cells[0].textContent).toBe('tall');
    expect(cells[0].hasAttribute('rowspan')).toBe(false); // shrunk to 1
    expect(cells[1].textContent).toBe('c');
  });

  it('removes the whole table when deleting the last remaining row', () => {
    const root = makeRoot(
      '<p>before</p><table><tbody><tr><td>only</td></tr></tbody></table>',
    );
    deleteRow(cellAt(root, 0), ctxOf(root));
    expect(root.querySelector('table')).toBeNull();
  });
});

describe('insertColumn / deleteColumn', () => {
  it('inserts a column to the right of the target cell', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td>a</td><td>b</td></tr>' +
        '<tr><td>c</td><td>d</td></tr>' +
      '</tbody></table>',
    );
    insertColumn(cellAt(root, 0), 'right'); // "a" is at col 0; insert at col 1
    const rows = tableOf(root).querySelectorAll('tr');
    expect(rows[0].children.length).toBe(3);
    expect(rows[1].children.length).toBe(3);
    expect(rows[0].children[0].textContent).toBe('a');
    expect(rows[0].children[2].textContent).toBe('b');
  });

  it('extends a colspan when the insertion falls inside it', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td colspan="2">wide</td><td>z</td></tr>' +
        '<tr><td>a</td><td>b</td><td>c</td></tr>' +
      '</tbody></table>',
    );
    // Insert a column at logical index 1 by anchoring on cell "a" (anchorCol=0
    // in row 1). 'right' produces insertColIndex = 1, which falls inside the
    // colspan=2 wide cell on row 0.
    const a = root.querySelectorAll('td')[2] as HTMLTableCellElement;
    insertColumn(a, 'right');
    const wide = root.querySelector('td[colspan]') as HTMLTableCellElement;
    expect(wide.getAttribute('colspan')).toBe('3');
    const rows = tableOf(root).querySelectorAll('tr');
    expect(rows[0].children.length).toBe(2); // wide + z (only 2 anchors)
    expect(rows[1].children.length).toBe(4);
  });

  it('deletes a column and trims the corresponding cells', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td>a</td><td>b</td><td>c</td></tr>' +
        '<tr><td>d</td><td>e</td><td>f</td></tr>' +
      '</tbody></table>',
    );
    deleteColumn(cellAt(root, 1), ctxOf(root));
    const rows = tableOf(root).querySelectorAll('tr');
    expect(rows[0].textContent).toBe('ac');
    expect(rows[1].textContent).toBe('df');
  });

  it('removes the table when deleting the only column', () => {
    const root = makeRoot(
      '<table><tbody><tr><td>x</td></tr></tbody></table>',
    );
    deleteColumn(cellAt(root, 0), ctxOf(root));
    expect(root.querySelector('table')).toBeNull();
  });
});

describe('convertRowToHeader / removeHeader', () => {
  it('promotes the first tbody row into thead with th cells', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td>A</td><td>B</td></tr>' +
        '<tr><td>1</td><td>2</td></tr>' +
      '</tbody></table>',
    );
    convertRowToHeader(cellAt(root, 0));
    const thead = tableOf(root).querySelector('thead')!;
    expect(thead.querySelectorAll('th').length).toBe(2);
    expect(thead.querySelectorAll('td').length).toBe(0);
    expect(tableOf(root).querySelectorAll('tbody tr').length).toBe(1);
  });

  it('demotes a thead row back into tbody with td cells', () => {
    const root = makeRoot(
      '<table>' +
        '<thead><tr><th>A</th><th>B</th></tr></thead>' +
        '<tbody><tr><td>1</td><td>2</td></tr></tbody>' +
      '</table>',
    );
    removeHeader(cellAt(root, 0));
    expect(tableOf(root).querySelector('thead')).toBeNull();
    const bodyRows = tableOf(root).querySelectorAll('tbody tr');
    expect(bodyRows.length).toBe(2);
    expect(bodyRows[0].querySelectorAll('td').length).toBe(2);
  });
});

describe('convertColumnToHeader / convertColumnToBody', () => {
  it('promotes tbody cells in the clicked column to <th scope="row">', () => {
    const root = makeRoot(
      '<table>' +
        '<thead><tr><th>A</th><th>B</th></tr></thead>' +
        '<tbody>' +
          '<tr><td>1a</td><td>1b</td></tr>' +
          '<tr><td>2a</td><td>2b</td></tr>' +
        '</tbody>' +
      '</table>',
    );
    convertColumnToHeader(root.querySelectorAll('tbody td')[0] as HTMLTableCellElement);
    const bodyRows = root.querySelectorAll('tbody tr');
    expect(bodyRows[0].children[0].tagName).toBe('TH');
    expect(bodyRows[0].children[0].getAttribute('scope')).toBe('row');
    expect(bodyRows[1].children[0].tagName).toBe('TH');
    expect(bodyRows[1].children[0].getAttribute('scope')).toBe('row');
    // The other column is unchanged.
    expect(bodyRows[0].children[1].tagName).toBe('TD');
    expect(bodyRows[1].children[1].tagName).toBe('TD');
    // thead is untouched.
    expect(root.querySelector('thead th')!.hasAttribute('scope')).toBe(false);
  });

  it('demotes a header column back to <td> and strips scope', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><th scope="row">a</th><td>b</td></tr>' +
        '<tr><th scope="row">c</th><td>d</td></tr>' +
      '</tbody></table>',
    );
    convertColumnToBody(root.querySelector('th') as HTMLTableCellElement);
    const cells = root.querySelectorAll('tbody tr');
    expect(cells[0].children[0].tagName).toBe('TD');
    expect(cells[0].children[0].hasAttribute('scope')).toBe(false);
    expect(cells[1].children[0].tagName).toBe('TD');
  });

  it('uses the anchor column when the clicked cell has a colspan', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td colspan="2">wide</td><td>z</td></tr>' +
        '<tr><td>a</td><td>b</td><td>c</td></tr>' +
      '</tbody></table>',
    );
    // wide.anchorCol === 0 — so converting "wide" promotes column 0.
    convertColumnToHeader(root.querySelector('td[colspan]') as HTMLTableCellElement);
    const wide = root.querySelector('th[colspan]') as HTMLTableCellElement;
    expect(wide).not.toBeNull();
    expect(wide.getAttribute('scope')).toBe('row');
    // Cell "a" (anchorCol 0 on row 1) also becomes th.
    const firstRow1Cell = root.querySelectorAll('tbody tr')[1].children[0];
    expect(firstRow1Cell.tagName).toBe('TH');
    // Cell "b" (anchorCol 1) is *not* a header — it sits inside the colspan
    // but its own anchor lives at column 1.
    const secondRow1Cell = root.querySelectorAll('tbody tr')[1].children[1];
    expect(secondRow1Cell.tagName).toBe('TD');
  });

  it('isColumnHeader returns true only when every tbody anchor in the column is <th>', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><th scope="row">a</th><td>b</td></tr>' +
        '<tr><th scope="row">c</th><td>d</td></tr>' +
      '</tbody></table>',
    );
    const table = root.querySelector('table')!;
    expect(isColumnHeader(table, 0)).toBe(true);
    expect(isColumnHeader(table, 1)).toBe(false);
  });
});

describe('getTableWidthMode / setTableWidthMode', () => {
  it('defaults to px when no <col> has a width', () => {
    const root = makeRoot(
      '<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
    );
    expect(getTableWidthMode(root.querySelector('table')!)).toBe('px');
  });

  it('detects px from an existing <col style="width:Npx">', () => {
    const root = makeRoot(
      '<table>' +
        '<colgroup><col style="width:120px"><col></colgroup>' +
        '<tbody><tr><td>a</td><td>b</td></tr></tbody>' +
      '</table>',
    );
    expect(getTableWidthMode(root.querySelector('table')!)).toBe('px');
  });

  it('detects percent from an existing <col style="width:NN%">', () => {
    const root = makeRoot(
      '<table>' +
        '<colgroup><col style="width:40%"><col></colgroup>' +
        '<tbody><tr><td>a</td><td>b</td></tr></tbody>' +
      '</table>',
    );
    expect(getTableWidthMode(root.querySelector('table')!)).toBe('percent');
  });

  it('setTableWidthMode("percent") converts each <col> to a percent value', () => {
    const root = makeRoot(
      '<table>' +
        '<colgroup><col style="width:80px"><col style="width:120px"></colgroup>' +
        '<tbody><tr><td>a</td><td>b</td></tr></tbody>' +
      '</table>',
    );
    const table = root.querySelector('table')!;
    // Stub the per-cell widths so the conversion has measurable input.
    stubCellWidths(table, [80, 120]);
    setTableWidthMode(table, 'percent');
    const cols = table.querySelectorAll('col');
    expect(cols[0].style.width).toMatch(/%$/);
    expect(cols[1].style.width).toMatch(/%$/);
    // 80 / 200 = 40%, 120 / 200 = 60%
    expect(parseFloat(cols[0].style.width)).toBeCloseTo(40, 1);
    expect(parseFloat(cols[1].style.width)).toBeCloseTo(60, 1);
    expect(table.style.width).toBe('100%');
    expect(table.style.tableLayout).toBe('fixed');
    expect(getTableWidthMode(table)).toBe('percent');
  });

  it('setTableWidthMode("px") snaps each <col> back to a pixel value', () => {
    const root = makeRoot(
      '<table>' +
        '<colgroup><col style="width:40%"><col style="width:60%"></colgroup>' +
        '<tbody><tr><td>a</td><td>b</td></tr></tbody>' +
      '</table>',
    );
    const table = root.querySelector('table')!;
    stubCellWidths(table, [120, 180]);
    setTableWidthMode(table, 'px');
    const cols = table.querySelectorAll('col');
    expect(cols[0].style.width).toBe('120px');
    expect(cols[1].style.width).toBe('180px');
    expect(table.style.width).toBe('auto');
    expect(getTableWidthMode(table)).toBe('px');
  });

  it('setColumnWidth converts the requested pixel value to a percent in percent-mode', () => {
    const root = makeRoot(
      '<table>' +
        '<colgroup><col style="width:30%"><col style="width:70%"></colgroup>' +
        '<tbody><tr><td>a</td><td>b</td></tr></tbody>' +
      '</table>',
    );
    const table = root.querySelector('table')!;
    // 400px-wide table; ask for 100px on the first column -> 25%.
    stubTableWidth(table, 400);
    setColumnWidth(table, 0, 100);
    const cols = table.querySelectorAll('col');
    expect(cols[0].style.width).toMatch(/%$/);
    expect(parseFloat(cols[0].style.width)).toBeCloseTo(25, 1);
  });
});

describe('mergeCells / splitCell', () => {
  it('merges a 2x2 block into a single cell that owns all the content', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td>a</td><td>b</td></tr>' +
        '<tr><td>c</td><td>d</td></tr>' +
      '</tbody></table>',
    );
    const cells = root.querySelectorAll('td');
    mergeCells(cells[0] as HTMLTableCellElement, cells[3] as HTMLTableCellElement);
    const survivors = tableOf(root).querySelectorAll('td');
    expect(survivors.length).toBe(1);
    const survivor = survivors[0];
    expect(survivor.getAttribute('rowspan')).toBe('2');
    expect(survivor.getAttribute('colspan')).toBe('2');
    expect(survivor.textContent).toBe('abcd');
  });

  it('tightens a non-rectangular request to cover overlapping merged cells', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td colspan="2">wide</td><td>x</td></tr>' +
        '<tr><td>a</td><td>b</td><td>c</td></tr>' +
      '</tbody></table>',
    );
    const wide = root.querySelector('td[colspan]') as HTMLTableCellElement;
    const a = root.querySelectorAll('td')[2] as HTMLTableCellElement; // first td in row 1
    mergeCells(wide, a);
    const cells = tableOf(root).querySelectorAll('td');
    // wide(2x2) absorbs row 1 cells a & b. Remaining anchors: merged, x, c.
    expect(cells.length).toBe(3);
    const merged = root.querySelector('td[rowspan]') as HTMLTableCellElement;
    expect(merged.getAttribute('rowspan')).toBe('2');
    expect(merged.getAttribute('colspan')).toBe('2');
  });

  it('splits a merged cell back into the original grid of empty cells', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td rowspan="2" colspan="2">M</td><td>x</td></tr>' +
        '<tr><td>y</td></tr>' +
      '</tbody></table>',
    );
    const merged = root.querySelector('td[rowspan]') as HTMLTableCellElement;
    splitCell(merged);
    const rows = tableOf(root).querySelectorAll('tr');
    expect(rows[0].children.length).toBe(3);
    expect(rows[1].children.length).toBe(3);
    const surviving = merged;
    expect(surviving.hasAttribute('rowspan')).toBe(false);
    expect(surviving.hasAttribute('colspan')).toBe(false);
    expect(surviving.textContent).toBe('M');
  });
});

describe('deleteTable', () => {
  it('replaces the table with a fresh paragraph', () => {
    const root = makeRoot(
      '<p>before</p><table><tbody><tr><td>x</td></tr></tbody></table><p>after</p>',
    );
    deleteTable(tableOf(root), ctxOf(root));
    expect(root.querySelector('table')).toBeNull();
    expect(root.children[1].tagName).toBe('P');
    expect(root.children[1].innerHTML).toBe('<br>');
  });
});

describe('setColumnWidth', () => {
  it('creates a colgroup and sets the width on the requested column', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td>a</td><td>b</td><td>c</td></tr>' +
      '</tbody></table>',
    );
    setColumnWidth(tableOf(root), 1, 200);
    const cg = tableOf(root).querySelector('colgroup');
    expect(cg).not.toBeNull();
    const cols = cg!.querySelectorAll('col');
    expect(cols.length).toBe(3);
    expect((cols[1] as HTMLElement).style.width).toBe('200px');
    expect(tableOf(root).style.tableLayout).toBe('fixed');
  });

  it('updates an existing <col> width without growing the colgroup', () => {
    const root = makeRoot(
      '<table>' +
        '<colgroup><col><col><col></colgroup>' +
        '<tbody><tr><td>a</td><td>b</td><td>c</td></tr></tbody>' +
      '</table>',
    );
    setColumnWidth(tableOf(root), 0, 150);
    const cols = tableOf(root).querySelectorAll('col');
    expect(cols.length).toBe(3);
    expect((cols[0] as HTMLElement).style.width).toBe('150px');
  });
});

describe('adjacentCell / appendRowAtEnd', () => {
  it('navigates to the next/previous cell in DOM order', () => {
    const root = makeRoot(
      '<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>',
    );
    const cells = root.querySelectorAll('td');
    expect(adjacentCell(cells[0] as HTMLTableCellElement, 'next')?.textContent).toBe('b');
    expect(adjacentCell(cells[1] as HTMLTableCellElement, 'next')?.textContent).toBe('c');
    expect(adjacentCell(cells[3] as HTMLTableCellElement, 'next')).toBeNull();
    expect(adjacentCell(cells[0] as HTMLTableCellElement, 'prev')).toBeNull();
  });

  it('appends a fresh row when called and returns its first cell', () => {
    const root = makeRoot(
      '<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
    );
    const first = appendRowAtEnd(tableOf(root));
    expect(first).not.toBeNull();
    const rows = tableOf(root).querySelectorAll('tr');
    expect(rows.length).toBe(2);
    expect(rows[1].children.length).toBe(2);
  });
});
