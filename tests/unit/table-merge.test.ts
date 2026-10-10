import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { resolveTableGrid } from '../../webview/editing/table-grid';
import type { TableGrid } from '../../webview/editing/table-grid';
import {
  mergeTableCells,
  readSplitState,
  resolveCellRectangle,
  splitTableCell,
} from '../../webview/editing/table-merge';
import { createRoot, readElement } from './helpers/format-dom';

/**
 * Returns the logical grid of a table in the editor root.
 *
 * @param root The editor root.
 * @param selector Selector of the table.
 * @returns The logical grid.
 */
function readGrid(root: Element, selector = 'table'): TableGrid {
  return resolveTableGrid(readElement(root, selector));
}

/**
 * Returns the total number of slots the cells cover. When there are no gaps and it equals the number of slots of the
 * table, there are no overlaps either.
 *
 * @param grid The logical grid.
 * @returns The total number of covered slots.
 */
function sumCoveredSlots(grid: TableGrid): number {
  return grid.cells.reduce((sum, cell) => sum + cell.rowSpan * cell.columnSpan, 0);
}

/**
 * Creates a row outside any table section from the HTML of its content. Parsing wraps rows directly under a table in a
 * tbody, so the row is built with the DOM.
 *
 * @param html HTML of the row content.
 * @returns The row element.
 */
function createRow(html: string): Element {
  const row = document.createElement('tr');
  row.innerHTML = html;
  return row;
}

/** Creates a holder of whether the tree was changed, in its unchanged state. */
function createProgress(): BlockRewriteProgress {
  return { changed: false };
}

const TABLE_3X3 = '<table><tbody>'
  + '<tr><td id="a">a</td><td>b</td><td>c</td></tr>'
  + '<tr><td>d</td><td id="e">e</td><td>f</td></tr>'
  + '<tr><td>g</td><td>h</td><td>i</td></tr>'
  + '</tbody></table>';

describe('resolving the rectangle', () => {
  it('returns a 2 by 2 rectangle, its 4 cells in table order and the top-left kept cell, mergeable, for the top-left and center cells of a 3 by 3 table without spans', () => {
    const root = createRoot(TABLE_3X3);

    const rectangle = resolveCellRectangle(readGrid(root), readElement(root, '#a'), readElement(root, '#e'));

    expect([
      [rectangle?.top, rectangle?.bottom, rectangle?.left, rectangle?.right],
      rectangle?.cells.map((cell) => cell.element.textContent),
      rectangle?.keptCell.element === readElement(root, '#a'),
      rectangle?.mergeable,
    ]).toEqual([[0, 1, 0, 1], ['a', 'b', 'd', 'e'], true, true]);
  });

  it('grows right until it contains a colspan 2 cell that only partly overlaps the rectangle', () => {
    const root = createRoot(
      '<table><tbody><tr><td>a</td><td id="b">b</td><td>c</td></tr>'
      + '<tr><td id="d">d</td><td colspan="2">e</td></tr></tbody></table>',
    );

    const rectangle = resolveCellRectangle(readGrid(root), readElement(root, '#b'), readElement(root, '#d'));

    expect([rectangle?.left, rectangle?.right, rectangle?.cells.map((cell) => cell.element.textContent)])
      .toEqual([0, 2, ['a', 'b', 'c', 'd', 'e']]);
  });

  it('grows further down when a rowspan cell partly overlaps after growing, until every cell is either inside or outside', () => {
    const root = createRoot(
      '<table><tbody>'
      + '<tr><td id="a">a</td><td colspan="2">b</td><td>x</td></tr>'
      + '<tr><td>c</td><td id="d">d</td><td rowspan="2">e</td><td>y</td></tr>'
      + '<tr><td>f</td><td>g</td><td>z</td></tr>'
      + '</tbody></table>',
    );

    const rectangle = resolveCellRectangle(readGrid(root), readElement(root, '#a'), readElement(root, '#d'));

    expect([
      [rectangle?.top, rectangle?.bottom, rectangle?.left, rectangle?.right],
      rectangle?.cells.map((cell) => cell.element.textContent),
    ]).toEqual([[0, 2, 0, 2], ['a', 'b', 'c', 'd', 'e', 'f', 'g']]);
  });

  it('includes a gap inside the rectangle and stays mergeable', () => {
    const root = createRoot('<table><tbody><tr><td>a</td><td id="b">b</td></tr><tr><td id="c">c</td></tr></tbody></table>');

    const rectangle = resolveCellRectangle(readGrid(root), readElement(root, '#b'), readElement(root, '#c'));

    expect([
      [rectangle?.top, rectangle?.bottom, rectangle?.left, rectangle?.right],
      rectangle?.cells.map((cell) => cell.element.textContent),
      rectangle?.mergeable,
    ]).toEqual([[0, 1, 0, 1], ['a', 'b', 'c'], true]);
  });

  it('is not mergeable when the rectangle spans rows of thead and tbody', () => {
    const root = createRoot(
      '<table><thead><tr><th id="h">h</th><th>i</th></tr></thead>'
      + '<tbody><tr><td id="a">a</td><td>b</td></tr></tbody></table>',
    );

    const rectangle = resolveCellRectangle(readGrid(root), readElement(root, '#h'), readElement(root, '#a'));

    expect(rectangle?.mergeable).toBe(false);
  });

  it('is not mergeable when the rectangle spans a row group outside any section and rows of tbody', () => {
    const table = document.createElement('table');
    const body = document.createElement('tbody');
    body.append(createRow('<td id="c">c</td><td>d</td>'));
    table.append(createRow('<td id="a">a</td><td>b</td>'), body);
    const root = createRoot('');
    root.append(table);

    const rectangle = resolveCellRectangle(readGrid(root), readElement(root, '#a'), readElement(root, '#c'));

    expect(rectangle?.mergeable).toBe(false);
  });

  it('is not mergeable when the rectangle contains an overlap where a later row\'s colspan extends into slots covered by a rowspan', () => {
    const root = createRoot(
      '<table><tbody><tr><td id="a">a</td><td id="b" rowspan="2">b</td></tr>'
      + '<tr><td colspan="2">c</td></tr></tbody></table>',
    );

    const rectangle = resolveCellRectangle(readGrid(root), readElement(root, '#a'), readElement(root, '#b'));

    expect(rectangle?.mergeable).toBe(false);
  });

  it('returns no rectangle for a cell of the outer table and a cell of a nested table', () => {
    const root = createRoot(
      '<table><tbody><tr><td id="a">a<table><tbody><tr><td id="x">x</td></tr></tbody></table></td>'
      + '<td>b</td></tr></tbody></table>',
    );

    const rectangle = resolveCellRectangle(readGrid(root), readElement(root, '#a'), readElement(root, '#x'));

    expect(rectangle).toBeUndefined();
  });

  it('has only one cell and is not mergeable when the same cell is passed twice', () => {
    const root = createRoot(TABLE_3X3);
    const cell = readElement(root, '#e');

    const rectangle = resolveCellRectangle(readGrid(root), cell, cell);

    expect([rectangle?.cells.map((target) => target.element.textContent), rectangle?.mergeable]).toEqual([['e'], false]);
  });

  it('orders the cells of the rectangle in display order even in a table written as tfoot, tbody, thead', () => {
    const root = createRoot(
      '<table><tfoot><tr><td id="f">f</td></tr></tfoot><tbody><tr><td>b</td></tr></tbody>'
      + '<thead><tr><td id="h">h</td></tr></thead></table>',
    );

    const rectangle = resolveCellRectangle(readGrid(root), readElement(root, '#f'), readElement(root, '#h'));

    expect(rectangle?.cells.map((cell) => cell.element.textContent)).toEqual(['h', 'b', 'f']);
  });

  it('leaves the serialization of the table unchanged', () => {
    const root = createRoot(
      '<table>\n<thead><tr><th id="h" scope="col">h</th><th>i</th></tr></thead>\n'
      + '<tbody><tr><td rowspan="0">a</td><td id="b">b</td></tr></tbody>\n</table>',
    );
    const before = root.innerHTML;

    resolveCellRectangle(readGrid(root), readElement(root, '#h'), readElement(root, '#b'));

    expect(root.innerHTML).toBe(before);
  });
});

describe('merging cells', () => {
  it('gives the kept cell rowspan="2" and colspan="2", removes the other 3 cells and returns the kept cell when merging a 2 by 2 rectangle', () => {
    const root = createRoot(
      '<table><tbody><tr><td id="a">a</td><td>b</td></tr><tr><td>c</td><td id="d">d</td></tr></tbody></table>',
    );
    const kept = readElement(root, '#a');

    const placement = mergeTableCells(readGrid(root), kept, readElement(root, '#d'), createProgress());

    expect([
      placement === kept,
      kept.getAttribute('rowspan'),
      kept.getAttribute('colspan'),
      root.querySelectorAll('td').length,
    ]).toEqual([true, '2', '2', 1]);
  });

  it('adds only colspan="3" and no rowspan when merging a 1 by 3 rectangle', () => {
    const root = createRoot('<table><tbody><tr><td id="a">a</td><td>b</td><td id="c">c</td></tr></tbody></table>');
    const kept = readElement(root, '#a');

    mergeTableCells(readGrid(root), kept, readElement(root, '#c'), createProgress());

    expect([kept.hasAttribute('rowspan'), kept.getAttribute('colspan')]).toEqual([false, '3']);
  });

  it('moves the children of the removed cells to the end of the kept cell in table order as the same nodes', () => {
    const root = createRoot(
      '<table><tbody><tr><td id="a"><p>1</p></td><td><p>2</p></td></tr>'
      + '<tr><td><p>3</p></td><td id="d"><p>4</p></td></tr></tbody></table>',
    );
    const before: Element[] = [...root.querySelectorAll('p')];
    const kept = readElement(root, '#a');

    mergeTableCells(readGrid(root), readElement(root, '#d'), kept, createProgress());

    expect([...kept.children].map((child) => before.indexOf(child))).toEqual([0, 1, 2, 3]);
  });

  it('makes the kept cell content foo, br, bar when merging cells with the bare texts "foo" and "bar"', () => {
    const root = createRoot('<table><tbody><tr><td id="a">foo</td><td id="b">bar</td></tr></tbody></table>');
    const kept = readElement(root, '#a');

    mergeTableCells(readGrid(root), kept, readElement(root, '#b'), createProgress());

    expect(kept.innerHTML).toBe('foo<br>bar');
  });

  it('inserts no br at boundaries touching a paragraph when merging cells with paragraphs', () => {
    const root = createRoot(
      '<table><tbody><tr><td id="a">foo</td><td><p>bar</p></td><td id="c">baz</td></tr></tbody></table>',
    );
    const kept = readElement(root, '#a');

    mergeTableCells(readGrid(root), kept, readElement(root, '#c'), createProgress());

    expect(kept.innerHTML).toBe('foo<p>bar</p>baz');
  });

  it('inserts no br before the next piece when the previous piece ends with a br', () => {
    const root = createRoot('<table><tbody><tr><td id="a">foo<br></td><td id="b">bar</td></tr></tbody></table>');
    const kept = readElement(root, '#a');

    mergeTableCells(readGrid(root), kept, readElement(root, '#b'), createProgress());

    expect(kept.innerHTML).toBe('foo<br>bar');
  });

  it('moves the comment piece but inserts no br when merging a cell holding only an HTML comment with a bare text cell', () => {
    const root = createRoot(
      '<table id="after"><tbody><tr><td id="a">foo</td><td id="b"><!--c--></td></tr></tbody></table>'
      + '<table id="before"><tbody><tr><td id="c"><!--c--></td><td id="d">bar</td></tr></tbody></table>',
    );

    mergeTableCells(readGrid(root, '#after'), readElement(root, '#a'), readElement(root, '#b'), createProgress());
    mergeTableCells(readGrid(root, '#before'), readElement(root, '#c'), readElement(root, '#d'), createProgress());

    expect([readElement(root, '#a').innerHTML, readElement(root, '#c').innerHTML]).toEqual(['foo<!--c-->', '<!--c-->bar']);
  });

  it('makes the kept cell content foo, comment, br, bar when merging bare text cells "foo" and "bar" around a cell holding only an HTML comment', () => {
    const root = createRoot('<table><tbody><tr><td id="a">foo</td><td><!--c--></td><td id="c">bar</td></tr></tbody></table>');
    const kept = readElement(root, '#a');

    mergeTableCells(readGrid(root), kept, readElement(root, '#c'), createProgress());

    expect(kept.innerHTML).toBe('foo<!--c--><br>bar');
  });

  it('does not move the content of empty cells, and removes the placeholder of an empty kept cell before moving pieces', () => {
    const root = createRoot(
      '<table><tbody><tr><td id="a"><br></td><td> <br> </td><td id="c">bar</td></tr></tbody></table>',
    );
    const kept = readElement(root, '#a');

    mergeTableCells(readGrid(root), kept, readElement(root, '#c'), createProgress());

    expect(kept.innerHTML).toBe('bar');
  });

  it('leaves only the placeholder br of the kept cell when all cells of the rectangle are empty', () => {
    const root = createRoot('<table><tbody><tr><td id="a"><br></td><td id="b"><br></td></tr></tbody></table>');
    const kept = readElement(root, '#a');

    mergeTableCells(readGrid(root), kept, readElement(root, '#b'), createProgress());

    expect(kept.innerHTML).toBe('<br>');
  });

  it('keeps the element name, scope, id and style of the kept cell and leaves no attribute of the removed cells anywhere in the tree', () => {
    const root = createRoot(
      '<table><tbody><tr><th id="a" scope="row" style="color: red">a</th>'
      + '<td id="b" class="x" data-y="1" style="color: blue">b</td></tr></tbody></table>',
    );
    const kept = readElement(root, '#a');

    mergeTableCells(readGrid(root), kept, readElement(root, '#b'), createProgress());

    expect([
      kept.localName,
      kept.getAttribute('scope'),
      kept.id,
      kept.getAttribute('style'),
      root.querySelectorAll('#b, .x, [data-y], [style="color: blue"]').length,
    ]).toEqual(['th', 'row', 'a', 'color: red', 0]);
  });

  it('keeps a row whose cells are all removed and leaves the row and column counts of the logical grid unchanged', () => {
    const root = createRoot(
      '<table><tbody><tr><td id="a">a</td><td>b</td></tr><tr><td>c</td><td id="d">d</td></tr></tbody></table>',
    );

    mergeTableCells(readGrid(root), readElement(root, '#a'), readElement(root, '#d'), createProgress());

    const after = readGrid(root);
    expect([root.querySelectorAll('tr')[1]?.children.length, after.rows.length, after.columnCount]).toEqual([0, 2, 2]);
  });

  it('leaves neither gaps nor overlaps in the logical grid after merging a rectangle containing a gap', () => {
    const root = createRoot('<table><tbody><tr><td>a</td><td id="b">b</td></tr><tr><td id="c">c</td></tr></tbody></table>');

    mergeTableCells(readGrid(root), readElement(root, '#b'), readElement(root, '#c'), createProgress());

    // In a 2 by 2 table with no gaps, a total of 4 covered slots means there are no overlaps either.
    const after = readGrid(root);
    expect([
      [after.rows.length, after.columnCount],
      after.slots.flat().includes(undefined),
      sumCoveredSlots(after),
    ]).toEqual([[2, 2], false, 4]);
  });

  it('moves pieces containing a nested table, a details section and a comment annotation to the kept cell by reference', () => {
    const root = createRoot(
      '<table id="outer"><tbody><tr><td id="a">x</td><td id="b">'
      + '<table><tbody><tr><td>n</td></tr></tbody></table>'
      + '<details open=""><summary>t</summary><p>d</p></details>'
      + '<p>p<comment>c<comment-body>body</comment-body></comment></p>'
      + '</td></tr></tbody></table>',
    );
    const moved = [...readElement(root, '#b').children];
    const kept = readElement(root, '#a');

    mergeTableCells(readGrid(root, '#outer'), kept, readElement(root, '#b'), createProgress());

    expect([...kept.children].map((child) => moved.indexOf(child))).toEqual([0, 1, 2]);
  });

  it('also removes the line break and indentation of removed cells and leaves the text of other rows unchanged in a table written with one cell per line', () => {
    const root = createRoot(
      '<table>\n<tbody>\n<tr>\n  <td id="a">a</td>\n  <td id="b">b</td>\n</tr>\n'
      + '<tr>\n  <td>c</td>\n  <td>d</td>\n</tr>\n</tbody>\n</table>',
    );

    mergeTableCells(readGrid(root), readElement(root, '#a'), readElement(root, '#b'), createProgress());

    expect(root.innerHTML).toBe(
      '<table>\n<tbody>\n<tr>\n  <td id="a" colspan="2">a<br>b</td>\n</tr>\n'
      + '<tr>\n  <td>c</td>\n  <td>d</td>\n</tr>\n</tbody>\n</table>',
    );
  });

  it('keeps the preceding whitespace without a line break when removing cells written on the same line', () => {
    const root = createRoot('<table><tbody><tr><td id="a">a</td> <td id="b">b</td> <td>c</td></tr></tbody></table>');

    mergeTableCells(readGrid(root), readElement(root, '#a'), readElement(root, '#b'), createProgress());

    expect(readElement(root, 'tr').innerHTML).toBe('<td id="a" colspan="2">a<br>b</td>  <td>c</td>');
  });

  it('leaves col and colgroup unchanged when merging in a table with col', () => {
    const root = createRoot(
      '<table><colgroup><col span="2" style="width: 10em"><col></colgroup>'
      + '<tbody><tr><td id="a">a</td><td id="b">b</td><td>c</td></tr></tbody></table>',
    );
    const before = readElement(root, 'colgroup').outerHTML;

    mergeTableCells(readGrid(root), readElement(root, '#a'), readElement(root, '#b'), createProgress());

    expect(readElement(root, 'colgroup').outerHTML).toBe(before);
  });

  it('leaves the tree unchanged, keeps the progress false and returns nothing for a rectangle spanning thead and tbody', () => {
    const html = '<table><thead><tr><th id="h">h</th></tr></thead><tbody><tr><td id="a">a</td></tr></tbody></table>';
    const root = createRoot(html);
    const progress = createProgress();

    const placement = mergeTableCells(readGrid(root), readElement(root, '#h'), readElement(root, '#a'), progress);

    expect([placement, progress.changed, root.innerHTML]).toEqual([undefined, false, html]);
  });

  it('leaves the tree unchanged and returns nothing when the other cell is in a different table from the reference cell', () => {
    const html = '<table id="first"><tbody><tr><td id="a">a</td></tr></tbody></table>'
      + '<table><tbody><tr><td id="b">b</td></tr></tbody></table>';
    const root = createRoot(html);
    const progress = createProgress();

    const placement = mergeTableCells(readGrid(root, '#first'), readElement(root, '#a'), readElement(root, '#b'), progress);

    expect([placement, progress.changed, root.innerHTML]).toEqual([undefined, false, html]);
  });
});

describe('splitting a cell', () => {
  it('removes both attributes and inserts empty cells into the other 3 covered slots when splitting a rowspan="2" colspan="2" cell', () => {
    const root = createRoot(
      '<table><tbody><tr><td id="a" rowspan="2" colspan="2">a</td><td>b</td></tr><tr><td>c</td></tr></tbody></table>',
    );

    splitTableCell(readGrid(root), readElement(root, '#a'), createProgress());

    expect(readElement(root, 'tbody').innerHTML).toBe(
      '<tr><td id="a">a</td><td><br></td><td>b</td></tr><tr><td><br></td><td><br></td><td>c</td></tr>',
    );
  });

  it('gives the new cells only the element name and scope of the reference cell, with a single placeholder br as content', () => {
    const root = createRoot(
      '<table><tbody><tr><th id="a" scope="row" colspan="2" class="k" style="color: red">a</th></tr></tbody></table>',
    );

    splitTableCell(readGrid(root), readElement(root, '#a'), createProgress());

    expect(readElement(root, '#a').nextElementSibling?.outerHTML).toBe('<th scope="row"><br></th>');
  });

  it('keeps the content of the reference cell in the origin cell without moving it to the new cells', () => {
    const root = createRoot('<table><tbody><tr><td id="a" colspan="2"><p>x</p></td></tr></tbody></table>');
    const cell = readElement(root, '#a');
    const paragraph = readElement(root, 'p');

    splitTableCell(readGrid(root), cell, createProgress());

    expect([cell.firstElementChild === paragraph, cell.childNodes.length, cell.nextElementSibling?.innerHTML])
      .toEqual([true, 1, '<br>']);
  });

  it('inserts the new cells in column order without whitespace, just after the reference cell in the origin row and just before the cell on the right in lower rows', () => {
    const root = createRoot(
      '<table><tbody><tr><td>x</td> <td id="a" rowspan="2" colspan="2">a</td> <td>y</td></tr>'
      + '<tr><td>p</td> <td>q</td></tr></tbody></table>',
    );

    splitTableCell(readGrid(root), readElement(root, '#a'), createProgress());

    expect([...root.querySelectorAll('tr')].map((row) => row.innerHTML)).toEqual([
      '<td>x</td> <td id="a">a</td><td><br></td> <td>y</td>',
      '<td>p</td> <td><br></td><td><br></td><td>q</td>',
    ]);
  });

  it('inserts just after the last cell of a lower row with no cell on the right, and at the end of a row with no cells', () => {
    const root = createRoot(
      '<table><tbody><tr><td rowspan="2">x</td><td id="a" rowspan="3">a</td></tr>'
      + '<tr></tr><tr><td>y</td></tr></tbody></table>',
    );

    splitTableCell(readGrid(root), readElement(root, '#a'), createProgress());

    expect([...root.querySelectorAll('tr')].map((row) => row.innerHTML)).toEqual([
      '<td rowspan="2">x</td><td id="a">a</td>',
      '<td><br></td>',
      '<td>y</td><td><br></td>',
    ]);
  });

  it('inserts new cells only into the rows covered in the logical grid for a rowspan="0" cell and a cell whose rowspan exceeds the section', () => {
    const root = createRoot(
      '<table id="zero"><tbody><tr><td id="a" rowspan="0">a</td><td>b</td></tr><tr><td>c</td></tr></tbody>'
      + '<tbody><tr><td>d</td><td>e</td></tr></tbody></table>'
      + '<table id="over"><tbody><tr><td id="f" rowspan="5">f</td><td>g</td></tr><tr><td>h</td></tr></tbody>'
      + '<tbody><tr><td>i</td><td>j</td></tr></tbody></table>',
    );

    splitTableCell(readGrid(root, '#zero'), readElement(root, '#a'), createProgress());
    splitTableCell(readGrid(root, '#over'), readElement(root, '#f'), createProgress());

    expect([readElement(root, '#zero').innerHTML, readElement(root, '#over').innerHTML]).toEqual([
      '<tbody><tr><td id="a">a</td><td>b</td></tr><tr><td><br></td><td>c</td></tr></tbody>'
      + '<tbody><tr><td>d</td><td>e</td></tr></tbody>',
      '<tbody><tr><td id="f">f</td><td>g</td></tr><tr><td><br></td><td>h</td></tr></tbody>'
      + '<tbody><tr><td>i</td><td>j</td></tr></tbody>',
    ]);
  });

  it('keeps the origin columns of the other cells and has neither gaps nor overlaps in the logical grid after the split', () => {
    const root = createRoot(
      '<table><tbody>'
      + '<tr><td>x</td><td id="a" rowspan="2" colspan="2">a</td><td>y</td></tr>'
      + '<tr><td>p</td><td>q</td></tr>'
      + '<tr><td>r</td><td>s</td><td>t</td><td>u</td></tr>'
      + '</tbody></table>',
    );
    const others = [...root.querySelectorAll('td:not(#a)')];
    const readOrigins = (grid: TableGrid): [number | undefined, number | undefined][] => others.map((element) => {
      const cell = grid.cells.find((candidate) => candidate.element === element);
      return [cell?.row, cell?.column];
    });
    const before = readOrigins(readGrid(root));

    splitTableCell(readGrid(root), readElement(root, '#a'), createProgress());

    // In a 3 by 4 table with no gaps, a total of 12 covered slots means there are no overlaps either.
    const after = readGrid(root);
    expect([
      readOrigins(after),
      [after.rows.length, after.columnCount],
      after.slots.flat().includes(undefined),
      sumCoveredSlots(after),
    ]).toEqual([before, [3, 4], false, 12]);
  });

  it('leaves col and colgroup unchanged when splitting in a table with col', () => {
    const root = createRoot(
      '<table><colgroup><col span="2" style="width: 10em"></colgroup>'
      + '<tbody><tr><td id="a" colspan="2">a</td></tr></tbody></table>',
    );
    const before = readElement(root, 'colgroup').outerHTML;

    splitTableCell(readGrid(root), readElement(root, '#a'), createProgress());

    expect(readElement(root, 'colgroup').outerHTML).toBe(before);
  });

  it('leaves the tree unchanged and keeps the progress false for a cell that cannot be split', () => {
    const html = '<table><tbody><tr><td>a</td><td id="b" rowspan="2">b</td></tr><tr><td colspan="2">c</td></tr></tbody></table>';
    const root = createRoot(html);
    const progress = createProgress();

    splitTableCell(readGrid(root), readElement(root, '#b'), progress);

    expect([progress.changed, root.innerHTML]).toEqual([false, html]);
  });
});

describe('split state', () => {
  it('reports a colspan 2 cell as merged and splittable, and a cell without spans as neither', () => {
    const root = createRoot(
      '<table><tbody><tr><td id="a" colspan="2">a</td></tr><tr><td id="b">b</td><td>c</td></tr></tbody></table>',
    );
    const grid = readGrid(root);

    expect([readSplitState(grid, readElement(root, '#a')), readSplitState(grid, readElement(root, '#b'))]).toEqual([
      { merged: true, splittable: true },
      { merged: false, splittable: false },
    ]);
  });

  it('reports a rowspan cell clipped to one row at the end of its section as neither merged nor splittable', () => {
    const root = createRoot(
      '<table><tbody><tr><td id="a" rowspan="3">a</td></tr></tbody><tbody><tr><td>b</td></tr></tbody></table>',
    );

    expect(readSplitState(readGrid(root), readElement(root, '#a'))).toEqual({ merged: false, splittable: false });
  });

  it('reports a cell whose extent is touched by an overlap as merged but not splittable', () => {
    const root = createRoot(
      '<table><tbody><tr><td>a</td><td id="b" rowspan="2">b</td></tr><tr><td colspan="2">c</td></tr></tbody></table>',
    );

    expect(readSplitState(readGrid(root), readElement(root, '#b'))).toEqual({ merged: true, splittable: false });
  });

  it('reports a cell with a gap left of its origin column in a lower row as not splittable', () => {
    const root = createRoot('<table><tbody><tr><td>x</td><td id="a" rowspan="2">a</td></tr><tr></tr></tbody></table>');

    expect(readSplitState(readGrid(root), readElement(root, '#a'))).toEqual({ merged: true, splittable: false });
  });
});
