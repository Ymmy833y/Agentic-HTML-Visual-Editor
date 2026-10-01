import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { appendTableRow, insertTableColumn, insertTableRow } from '../../webview/editing/table-add';
import { resolveTableGrid } from '../../webview/editing/table-grid';
import { createRoot, readElement } from './helpers/format-dom';

/**
 * Creates an editor root holding one table.
 *
 * @param html The HTML of the table.
 * @returns The editor root and the first table in it.
 */
function createTable(html: string): { root: HTMLElement; table: Element } {
  const root = createRoot(html);
  return { root, table: readElement(root, 'table') };
}

/**
 * Adds a row above or below the reference cell.
 *
 * @param html The HTML of the table.
 * @param selector The selector of the reference cell.
 * @param direction The direction to add in.
 * @returns The contents of the editor root after adding.
 */
function addRow(html: string, selector: string, direction: 'above' | 'below'): string {
  const { root, table } = createTable(html);
  insertTableRow(resolveTableGrid(table), readElement(root, selector), direction, { changed: false });
  return root.innerHTML;
}

/**
 * Adds a column to the left or right of the reference cell.
 *
 * @param html The HTML of the table.
 * @param selector The selector of the reference cell.
 * @param direction The direction to add in.
 * @returns The contents of the editor root after adding.
 */
function addColumn(html: string, selector: string, direction: 'left' | 'right'): string {
  const { root, table } = createTable(html);
  insertTableColumn(resolveTableGrid(table), readElement(root, selector), direction, { changed: false });
  return root.innerHTML;
}

describe('adding a row', () => {
  it('adding below inserts a row of the same section right after the reference row, with an empty cell per column', () => {
    const { root, table } = createTable('<table><tbody><tr><td id="a">a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>');
    const progress: BlockRewriteProgress = { changed: false };

    insertTableRow(resolveTableGrid(table), readElement(root, '#a'), 'below', progress);

    expect([root.innerHTML, progress.changed]).toEqual([
      '<table><tbody><tr><td id="a">a</td><td>b</td></tr>\n<tr><td><br></td><td><br></td></tr><tr><td>c</td><td>d</td></tr></tbody></table>',
      true,
    ]);
  });

  it('for a reference cell with rowspan 2, above goes right before the origin row and below right after the lowest covered row', () => {
    const html = '<table><tbody><tr><td id="a" rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr><tr><td>d</td><td>e</td></tr></tbody></table>';

    const rowTexts = (['above', 'below'] as const).map((direction) => {
      const table = readElement(createRoot(addRow(html, '#a', direction)), 'table');
      return [...table.querySelectorAll('tr')].map((row) => row.textContent);
    });

    expect(rowTexts).toEqual([['', 'ab', 'c', 'de'], ['ab', 'c', '', 'de']]);
  });

  it('new cells copy only the element name and scope of the source row cells, not other attributes or contents', () => {
    const html = '<table><tbody><tr><th scope="row" class="k" id="a">x</th><td class="m">y</td></tr></tbody></table>';

    expect(addRow(html, '#a', 'below')).toBe(
      '<table><tbody><tr><th scope="row" class="k" id="a">x</th><td class="m">y</td></tr>\n<tr><th scope="row"><br></th><td><br></td></tr></tbody></table>',
    );
  });

  it('makes a column of the new row a td when that column is a gap in the source row', () => {
    const html = '<table><tbody><tr><th scope="row" id="a">a</th></tr><tr><th scope="row">b</th><th scope="row">c</th></tr></tbody></table>';

    expect(addRow(html, '#a', 'below')).toBe(
      '<table><tbody><tr><th scope="row" id="a">a</th></tr>\n<tr><th scope="row"><br></th><td><br></td></tr><tr><th scope="row">b</th><th scope="row">c</th></tr></tbody></table>',
    );
  });

  it('adding below a header row whose next row is a body row copies the next row, making the new row a body row', () => {
    const html = '<table><tbody><tr><th scope="col" id="h">h</th><th scope="col">i</th></tr><tr><th scope="row">a</th><td>b</td></tr></tbody></table>';

    expect(addRow(html, '#h', 'below')).toBe(
      '<table><tbody><tr><th scope="col" id="h">h</th><th scope="col">i</th></tr>\n<tr><th scope="row"><br></th><td><br></td></tr><tr><th scope="row">a</th><td>b</td></tr></tbody></table>',
    );
  });

  it('adding below in a table whose last row is a header row makes every cell of the new row a td', () => {
    const html = '<table><tbody><tr><th scope="col" id="h">h</th><th scope="col">i</th></tr></tbody></table>';

    expect(addRow(html, '#h', 'below')).toBe(
      '<table><tbody><tr><th scope="col" id="h">h</th><th scope="col">i</th></tr>\n<tr><td><br></td><td><br></td></tr></tbody></table>',
    );
  });

  it('adding above a header row makes the new row a header row too', () => {
    const html = '<table><tbody><tr><th scope="col" id="h">h</th></tr><tr><td>a</td></tr></tbody></table>';

    expect(addRow(html, '#h', 'above')).toBe(
      '<table><tbody>\n<tr><th scope="col"><br></th></tr><tr><th scope="col" id="h">h</th></tr><tr><td>a</td></tr></tbody></table>',
    );
  });

  it('adding a row to a table with a header column makes the same column of the new row a th (scope="row") too', () => {
    const html = '<table><tbody><tr><th scope="col">h</th><th scope="col">i</th></tr><tr><th scope="row" id="a">a</th><td>b</td></tr></tbody></table>';

    expect(addRow(html, '#a', 'below')).toBe(
      '<table><tbody><tr><th scope="col">h</th><th scope="col">i</th></tr><tr><th scope="row" id="a">a</th><td>b</td></tr>\n<tr><th scope="row"><br></th><td><br></td></tr></tbody></table>',
    );
  });

  it('a cell covering across the insertion point gets its rowspan increased by 1, and no cell is created in that column', () => {
    const html = '<table><tbody><tr><td rowspan="2">a</td><td id="b">b</td></tr><tr><td>c</td></tr></tbody></table>';

    expect(addRow(html, '#b', 'below')).toBe(
      '<table><tbody><tr><td rowspan="3">a</td><td id="b">b</td></tr>\n<tr><td><br></td></tr><tr><td>c</td></tr></tbody></table>',
    );
  });

  it('where a cell with rowspan="0" spans the insertion point, the rowspan stays 0 and no cell is created in that column', () => {
    const html = '<table><tbody><tr><td rowspan="0">a</td><td id="b">b</td></tr><tr><td>c</td></tr></tbody></table>';

    expect(addRow(html, '#b', 'below')).toBe(
      '<table><tbody><tr><td rowspan="0">a</td><td id="b">b</td></tr>\n<tr><td><br></td></tr><tr><td>c</td></tr></tbody></table>',
    );
  });

  it('adding below the last row of a section creates no cell in the column of a clipped rowspan and leaves the rowspan unchanged', () => {
    const html = '<table><tbody><tr><td rowspan="5">a</td><td>b</td></tr><tr><td id="c">c</td></tr></tbody></table>';

    expect(addRow(html, '#c', 'below')).toBe(
      '<table><tbody><tr><td rowspan="5">a</td><td>b</td></tr><tr><td id="c">c</td></tr>\n<tr><td><br></td></tr></tbody></table>',
    );
  });

  it('adding above an indented row leaves the text of existing rows unchanged, with only one line break before the new row', () => {
    const html = '<table>\n  <tbody>\n    <tr><td>a</td></tr>\n    <tr><td id="b">b</td></tr>\n  </tbody>\n</table>';

    expect(addRow(html, '#b', 'above').split('\n')).toEqual([
      '<table>',
      '  <tbody>',
      '    <tr><td>a</td></tr>',
      '<tr><td><br></td></tr>',
      '    <tr><td id="b">b</td></tr>',
      '  </tbody>',
      '</table>',
    ]);
  });
});

describe('adding a column', () => {
  it('adding right inserts a cell right of the reference column in each row, th (scope="col") in a header row and td elsewhere', () => {
    const html = '<table><tbody><tr><th scope="col">h</th><th scope="col">i</th></tr><tr><td id="a">a</td><td>b</td></tr></tbody></table>';

    expect(addColumn(html, '#a', 'right')).toBe(
      '<table><tbody><tr><th scope="col">h</th><th scope="col"><br></th><th scope="col">i</th></tr><tr><td id="a">a</td><td><br></td><td>b</td></tr></tbody></table>',
    );
  });

  it('for a reference cell with colspan 2, left goes left of the origin column and right goes right of the rightmost covered column', () => {
    const html = '<table><tbody><tr><td id="a" colspan="2">a</td><td>b</td></tr><tr><td>c</td><td>d</td><td>e</td></tr></tbody></table>';

    expect([addColumn(html, '#a', 'left'), addColumn(html, '#a', 'right')]).toEqual([
      '<table><tbody><tr><td><br></td><td id="a" colspan="2">a</td><td>b</td></tr><tr><td><br></td><td>c</td><td>d</td><td>e</td></tr></tbody></table>',
      '<table><tbody><tr><td id="a" colspan="2">a</td><td><br></td><td>b</td></tr><tr><td>c</td><td>d</td><td><br></td><td>e</td></tr></tbody></table>',
    ]);
  });

  it('a cell covering across the boundary gets its colspan increased by 1, only once even if it spans rows', () => {
    const html = '<table><tbody><tr><td id="x">x</td><td>y</td><td>z</td></tr><tr><td colspan="2" rowspan="2">p</td><td>q</td></tr><tr><td>r</td></tr></tbody></table>';

    expect(addColumn(html, '#x', 'right')).toBe(
      '<table><tbody><tr><td id="x">x</td><td><br></td><td>y</td><td>z</td></tr><tr><td colspan="3" rowspan="2">p</td><td>q</td></tr><tr><td>r</td></tr></tbody></table>',
    );
  });

  it('creates no cell in a row with a gap left of the boundary, leaving the existing gap unfilled', () => {
    const html = '<table><tbody><tr><td>a</td><td id="b">b</td><td>c</td></tr><tr><td>d</td></tr></tbody></table>';

    expect(addColumn(html, '#b', 'right')).toBe(
      '<table><tbody><tr><td>a</td><td id="b">b</td><td><br></td><td>c</td></tr><tr><td>d</td></tr></tbody></table>',
    );
  });

  it('in a table with each cell on its own line, inserts the new cell with no whitespace around it and leaves the text of other lines unchanged', () => {
    const html = '<table>\n<tbody>\n<tr>\n  <td id="a">a</td>\n  <td>b</td>\n</tr>\n<tr>\n  <td>c</td>\n  <td>d</td>\n</tr>\n</tbody>\n</table>';

    expect(addColumn(html, '#a', 'right').split('\n')).toEqual([
      '<table>',
      '<tbody>',
      '<tr>',
      '  <td id="a">a</td>',
      '  <td><br></td><td>b</td>',
      '</tr>',
      '<tr>',
      '  <td>c</td>',
      '  <td><br></td><td>d</td>',
      '</tr>',
      '</tbody>',
      '</table>',
    ]);
  });

  it('in a table with col elements, inserts a col without attributes at the added boundary, and adding inside a col with span 2 makes the span 3', () => {
    const html = '<table><colgroup><col id="a"><col id="b" span="2"></colgroup><tbody><tr><td id="x">x</td><td id="y">y</td><td>z</td></tr></tbody></table>';

    const colgroups = [addColumn(html, '#x', 'right'), addColumn(html, '#y', 'right')]
      .map((result) => readElement(createRoot(result), 'colgroup').outerHTML);

    expect(colgroups).toEqual([
      '<colgroup><col id="a"><col><col id="b" span="2"></colgroup>',
      '<colgroup><col id="a"><col id="b" span="3"></colgroup>',
    ]);
  });
});

describe('appending a row', () => {
  it('in a table with a tfoot, inserts the row right after the last row of the tfoot and returns the first cell of the new row', () => {
    const { root, table } = createTable('<table><tfoot><tr><td>f</td></tr></tfoot><tbody><tr><td>a</td></tr></tbody></table>');

    const first = appendTableRow(resolveTableGrid(table), { changed: false });

    expect([root.innerHTML, first === readElement(root, 'tfoot tr:last-child td')]).toEqual([
      '<table><tfoot><tr><td>f</td></tr>\n<tr><td><br></td></tr></tfoot><tbody><tr><td>a</td></tr></tbody></table>',
      true,
    ]);
  });

  it('creates no cell in the appended row for the column of a cell with rowspan="0"', () => {
    const { root, table } = createTable('<table><tbody><tr><td rowspan="0">a</td><td>b</td></tr><tr><td>c</td></tr></tbody></table>');

    appendTableRow(resolveTableGrid(table), { changed: false });

    expect(root.innerHTML).toBe(
      '<table><tbody><tr><td rowspan="0">a</td><td>b</td></tr><tr><td>c</td></tr>\n<tr><td><br></td></tr></tbody></table>',
    );
  });
});
