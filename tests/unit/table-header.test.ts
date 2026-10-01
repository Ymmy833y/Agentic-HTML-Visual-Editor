import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { resolveTableGrid } from '../../webview/editing/table-grid';
import {
  isHeaderColumn,
  isHeaderRow,
  readTableHeaderState,
  toggleHeaderColumn,
  toggleHeaderRow,
} from '../../webview/editing/table-header';
import { createRoot, readElement } from './helpers/format-dom';

/**
 * Creates an editor root holding a table.
 *
 * @param html The HTML of the table.
 * @returns The editor root and the first table in it.
 */
function createTable(html: string): { root: HTMLElement; table: Element } {
  const root = createRoot(html);
  return { root, table: readElement(root, 'table') };
}

describe('toggling the header row', () => {
  it('toggling a non-header row turns the cells originating in it into th (scope="col") without moving the row between sections', () => {
    const { root, table } = createTable('<table><tbody><tr><td id="a">a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>');
    const progress: BlockRewriteProgress = { changed: false };

    toggleHeaderRow(resolveTableGrid(table), readElement(root, '#a'), progress);

    expect([root.innerHTML, progress.changed]).toEqual([
      '<table><tbody><tr><th id="a" scope="col">a</th><th scope="col">b</th></tr><tr><td>c</td><td>d</td></tr></tbody></table>',
      true,
    ]);
  });

  it('toggling a header row turns cells into td with scope removed, and cells in a header column into th (scope="row")', () => {
    const { root, table } = createTable('<table><tbody><tr><th scope="col">a</th><th id="b" scope="col">b</th></tr><tr><th scope="row">c</th><td>d</td></tr></tbody></table>');

    toggleHeaderRow(resolveTableGrid(table), readElement(root, '#b'), { changed: false });

    expect(readElement(root, 'tr').outerHTML)
      .toBe('<tr><th scope="row">a</th><td id="b">b</td></tr>');
  });

  it('toggling a row inside a thead changes only the cells, and the row stays in the thead after it stops being a header row', () => {
    const { root, table } = createTable('<table><thead><tr><th id="a">a</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>');

    toggleHeaderRow(resolveTableGrid(table), readElement(root, '#a'), { changed: false });

    expect(root.innerHTML).toBe('<table><thead><tr><td id="a">a</td></tr></thead><tbody><tr><td>b</td></tr></tbody></table>');
  });

  it('does not rewrite cells covering by colspan from a left column or by rowspan from an upper row', () => {
    // A cell covering by rowspan from above does not originate in the row being toggled, and a cell covering by
    // colspan from the left does not originate in the column being toggled.
    const byRow = createTable('<table><tbody><tr><td>a</td><td rowspan="2">b</td></tr><tr><td id="c">c</td></tr></tbody></table>');
    const byColumn = createTable('<table><tbody><tr><td colspan="2">a</td></tr><tr><td>c</td><td id="d">d</td></tr></tbody></table>');

    toggleHeaderRow(resolveTableGrid(byRow.table), readElement(byRow.root, '#c'), { changed: false });
    toggleHeaderColumn(resolveTableGrid(byColumn.table), readElement(byColumn.root, '#d'), { changed: false });

    expect([byRow.root.innerHTML, byColumn.root.innerHTML]).toEqual([
      '<table><tbody><tr><td>a</td><td rowspan="2">b</td></tr><tr><th id="c" scope="col">c</th></tr></tbody></table>',
      '<table><tbody><tr><td colspan="2">a</td></tr><tr><td>c</td><th id="d" scope="row">d</th></tr></tbody></table>',
    ]);
  });

  it('a replaced cell keeps its contents by reference and carries over every attribute except scope, and the old-to-new mapping is returned', () => {
    const { root, table } = createTable('<table><tbody><tr><td id="a" class="k" colspan="2"><strong>x</strong></td></tr></tbody></table>');
    const cell = readElement(root, '#a');
    const content = readElement(cell, 'strong');

    const replaced = toggleHeaderRow(resolveTableGrid(table), cell, { changed: false });

    const created = readElement(root, '#a');
    expect([
      created.localName,
      created.getAttribute('class'),
      created.getAttribute('colspan'),
      created.firstChild === content,
      [...replaced.entries()],
    ]).toEqual(['th', 'k', '2', true, [[cell, created]]]);
  });
});

describe('toggling the header column', () => {
  it('toggling a non-header column turns its cells outside header rows into th (scope="row")', () => {
    const { root, table } = createTable('<table><tbody><tr><th scope="col">h</th><th scope="col">i</th></tr><tr><td id="a">a</td><td>b</td></tr></tbody></table>');

    toggleHeaderColumn(resolveTableGrid(table), readElement(root, '#a'), { changed: false });

    expect(root.innerHTML).toBe('<table><tbody><tr><th scope="col">h</th><th scope="col">i</th></tr><tr><th id="a" scope="row">a</th><td>b</td></tr></tbody></table>');
  });

  it('toggling a header column turns the same cells into td with scope removed', () => {
    const { root, table } = createTable('<table><tbody><tr><th scope="col">h</th><th scope="col">i</th></tr><tr><th id="a" scope="row">a</th><td>b</td></tr></tbody></table>');

    toggleHeaderColumn(resolveTableGrid(table), readElement(root, '#a'), { changed: false });

    expect(root.innerHTML).toBe('<table><tbody><tr><th scope="col">h</th><th scope="col">i</th></tr><tr><td id="a">a</td><td>b</td></tr></tbody></table>');
  });

  it('toggling a column in a table with no non-header rows leaves the tree unchanged and the progress false', () => {
    const html = '<table><tbody><tr><th id="a" scope="col">a</th><th scope="col">b</th></tr></tbody></table>';
    const { root, table } = createTable(html);
    const progress: BlockRewriteProgress = { changed: false };

    const replaced = toggleHeaderColumn(resolveTableGrid(table), readElement(root, '#a'), progress);

    expect([root.innerHTML, progress.changed, replaced.size]).toEqual([html, false, 0]);
  });
});

describe('judging and querying headers', () => {
  it('returns whether the reference cell row is a header row and its column a header column, without changing the tree', () => {
    const html = '<table><tbody><tr><th scope="col">h</th><th scope="col">i</th></tr><tr><th scope="row">a</th><td id="b">b</td></tr></tbody></table>';
    const { root } = createTable(html);

    const states = [readTableHeaderState(readElement(root, 'th')), readTableHeaderState(readElement(root, '#b'))];

    expect([states, root.innerHTML]).toEqual([
      [{ headerRow: true, headerColumn: true }, { headerRow: false, headerColumn: false }],
      html,
    ]);
  });

  it('returns undefined when the query is given an element that is not a table cell', () => {
    const { root } = createTable('<table><tbody><tr><td><p id="p">a</p></td></tr></tbody></table>');

    expect(readTableHeaderState(readElement(root, '#p'))).toBeUndefined();
  });

  it('a row containing a th with scope="row" and a row containing a td are not header rows', () => {
    const { table } = createTable('<table><tbody><tr><th scope="row">a</th><th>b</th></tr><tr><th>c</th><td>d</td></tr><tr><th>e</th><th scope="col">f</th></tr></tbody></table>');
    const grid = resolveTableGrid(table);

    expect([isHeaderRow(grid, 0), isHeaderRow(grid, 1), isHeaderRow(grid, 2)]).toEqual([false, false, true]);
  });

  it('does not count header row cells, so a column with no other originating cells is not a header column', () => {
    const { table } = createTable('<table><tbody><tr><th scope="col">h</th><th scope="col">i</th></tr><tr><th scope="row">a</th></tr></tbody></table>');
    const grid = resolveTableGrid(table);

    expect([isHeaderColumn(grid, 0), isHeaderColumn(grid, 1)]).toEqual([true, false]);
  });
});
