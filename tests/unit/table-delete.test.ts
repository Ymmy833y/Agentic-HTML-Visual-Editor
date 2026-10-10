import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { deleteTable, deleteTableColumn, deleteTableRow } from '../../webview/editing/table-delete';
import { resolveTableGrid } from '../../webview/editing/table-grid';
import { createRoot, readChildText, readElement } from './helpers/format-dom';

/** The result of a deletion. */
interface DeleteResult {
  /** The editor root after deleting. */
  readonly root: HTMLElement;
  /** The returned placement. */
  readonly placement: Element | undefined;
}

/**
 * Deletes the row of the reference cell's origin. The selection end is passed as if placed in the first text of the
 * reference cell.
 *
 * @param html The contents of the editor root.
 * @param selector The selector of the reference cell.
 * @param endInCell Whether to place the selection end inside the reference cell. If not, the end is placed in a
 *   paragraph outside the table.
 * @returns The result of the deletion.
 */
function removeRow(html: string, selector: string, endInCell = true): DeleteResult {
  const root = createRoot(html);
  const cell = readElement(root, selector);
  const ends = endInCell ? [readChildText(cell, 0)] : [root];
  const placement = deleteTableRow(resolveTableGrid(readElement(root, 'table')), cell, ends, { changed: false });
  return { root, placement };
}

/**
 * Deletes the column of the reference cell's origin. The selection end is passed as if placed in the first text of
 * the reference cell.
 *
 * @param html The contents of the editor root.
 * @param selector The selector of the reference cell.
 * @returns The result of the deletion.
 */
function removeColumn(html: string, selector: string): DeleteResult {
  const root = createRoot(html);
  const cell = readElement(root, selector);
  const placement = deleteTableColumn(
    resolveTableGrid(readElement(root, 'table')),
    cell,
    [readChildText(cell, 0)],
    { changed: false },
  );
  return { root, placement };
}

describe('deleting a row', () => {
  it('removes the origin row together with the line break before it, leaving the text of other rows unchanged', () => {
    const html = '<table>\n<tbody>\n<tr><td>a</td></tr>\n<tr><td id="b">b</td></tr>\n<tr><td>c</td></tr>\n</tbody>\n</table>';

    expect(removeRow(html, '#b').root.innerHTML.split('\n'))
      .toEqual(['<table>', '<tbody>', '<tr><td>a</td></tr>', '<tr><td>c</td></tr>', '</tbody>', '</table>']);
  });

  it('moves a rowspan 2 cell starting in the removed row, with its contents, to the same column of the next row and drops the rowspan', () => {
    const root = createRoot('<table><tbody><tr><td id="a">a</td><td rowspan="2"><em>b</em></td><td>c</td></tr><tr><td>d</td><td>e</td></tr></tbody></table>');
    const content = readElement(root, 'em');

    deleteTableRow(resolveTableGrid(readElement(root, 'table')), readElement(root, '#a'), [], { changed: false });

    expect([root.innerHTML, readElement(root, 'em') === content])
      .toEqual(['<table><tbody><tr><td>d</td><td><em>b</em></td><td>e</td></tr></tbody></table>', true]);
  });

  it('reduces the rowspan of a cell covering from above by 1, drops the attribute when it goes from 2 to 1, and leaves 0 as is', () => {
    const html = '<table><tbody><tr><td rowspan="3">a</td><td rowspan="2">b</td><td rowspan="0">c</td><td>d</td></tr><tr><td id="e">e</td></tr><tr><td>f</td><td>g</td></tr></tbody></table>';

    expect(removeRow(html, '#e').root.innerHTML).toBe(
      '<table><tbody><tr><td rowspan="2">a</td><td>b</td><td rowspan="0">c</td><td>d</td></tr><tr><td>f</td><td>g</td></tr></tbody></table>',
    );
  });

  it('when removing the row leaves its section with no rows, removes the section together with the line break before it', () => {
    const html = '<table>\n<thead>\n<tr><th id="h">h</th></tr>\n</thead>\n<tbody>\n<tr><td>a</td></tr>\n</tbody>\n</table>';

    expect(removeRow(html, '#h').root.innerHTML)
      .toBe('<table>\n<tbody>\n<tr><td>a</td></tr>\n</tbody>\n</table>');
  });

  it('when a selection end is in the removed row, the placement is the cell in the same column of the next row, or of the previous row for the last row', () => {
    const html = '<table><tbody><tr><td>a</td><td>b</td></tr><tr><td id="c">c</td><td>d</td></tr><tr><td id="e">e</td><td>f</td></tr></tbody></table>';

    const middle = removeRow(html, '#c');
    const last = removeRow(html, '#e');

    expect([middle.placement?.textContent, last.placement?.textContent]).toEqual(['e', 'c']);
  });

  it('when a selection end is in the removed row and the next row was already empty, the placement is the next remaining cell after the reference cell in table order', () => {
    const html = '<table><tbody><tr><td id="a">a</td><td>b</td></tr><tr></tr><tr><td>c</td><td>d</td></tr></tbody></table>';

    expect(removeRow(html, '#a').placement?.textContent).toBe('c');
  });

  it('returns no placement when no selection end is in the removed row', () => {
    const html = '<table><tbody><tr><td id="a">a</td></tr><tr><td>b</td></tr></tbody></table>';

    expect(removeRow(html, '#a', false).placement).toBeUndefined();
  });

  it('when a selection end is on the section itself, the placement is the cell in the same column of the next row only if the section is removed with the row', () => {
    const removed = createRoot('<table><thead><tr><th id="h">h</th></tr></thead><tbody><tr><td>a</td></tr></tbody></table>');
    const kept = createRoot('<table><tbody><tr><td id="a">a</td></tr><tr><td>b</td></tr></tbody></table>');

    const placement = deleteTableRow(
      resolveTableGrid(readElement(removed, 'table')),
      readElement(removed, '#h'),
      [readElement(removed, 'thead')],
      { changed: false },
    );
    const none = deleteTableRow(
      resolveTableGrid(readElement(kept, 'table')),
      readElement(kept, '#a'),
      [readElement(kept, 'tbody')],
      { changed: false },
    );

    expect([placement?.textContent, none]).toEqual(['a', undefined]);
  });

  it('deleting the row of a single-row table removes the whole table, with an empty paragraph as the placement', () => {
    const result = removeRow('<p>x</p>\n<table><tbody><tr><td id="a">a</td></tr></tbody></table>', '#a');

    expect([result.root.innerHTML, result.placement === result.root.lastElementChild])
      .toEqual(['<p>x</p>\n<p><br></p>', true]);
  });

  it('deleting the only row with cells in a table whose other rows were already empty removes the whole table with an empty paragraph as the placement, but keeps the table when the empty rows are covered by a cell extending from the removed row', () => {
    const empty = removeRow('<p>x</p>\n<table><tbody><tr><td id="a">a</td></tr><tr></tr></tbody></table>', '#a');
    const covered = removeRow('<table><tbody><tr><td id="a">a</td><td rowspan="2">b</td></tr><tr></tr></tbody></table>', '#a');

    expect([empty.root.innerHTML, empty.placement === empty.root.lastElementChild, covered.root.innerHTML])
      .toEqual(['<p>x</p>\n<p><br></p>', true, '<table><tbody><tr><td>b</td></tr></tbody></table>']);
  });
});

describe('deleting a column', () => {
  it('removes cells with colspan 1 and keeps cells with colspan 2 reduced by 1', () => {
    const html = '<table><tbody><tr><td id="a">a</td><td>b</td></tr><tr><td colspan="2">c</td></tr></tbody></table>';

    expect(removeColumn(html, '#a').root.innerHTML)
      .toBe('<table><tbody><tr><td>b</td></tr><tr><td>c</td></tr></tbody></table>');
  });

  it('removing a column in a table with each cell on its own line also removes the line break and indentation, leaving no whitespace-only lines', () => {
    const html = '<table>\n<tbody>\n<tr>\n  <td>a</td>\n  <td id="b">b</td>\n</tr>\n<tr>\n  <td>c</td>\n  <td>d</td>\n</tr>\n</tbody>\n</table>';

    expect(removeColumn(html, '#b').root.innerHTML.split('\n')).toEqual([
      '<table>',
      '<tbody>',
      '<tr>',
      '  <td>a</td>',
      '</tr>',
      '<tr>',
      '  <td>c</td>',
      '</tr>',
      '</tbody>',
      '</table>',
    ]);
  });

  it('keeps the preceding whitespace without a line break when removing cells placed on the same line', () => {
    const html = '<table><tbody><tr><td>a</td> <td id="b">b</td></tr></tbody></table>';

    expect(removeColumn(html, '#b').root.innerHTML).toBe('<table><tbody><tr><td>a</td> </tr></tbody></table>');
  });

  it('removes the col of the removed column, reduces a col with span 2 by 1, and removes a colgroup left with no col', () => {
    const html = '<table><colgroup><col id="a"><col id="b" span="2"></colgroup><colgroup><col id="c"></colgroup><tbody><tr><td id="x">x</td><td id="y">y</td><td>z</td><td id="w">w</td></tr></tbody></table>';

    const colgroups = ['#x', '#y', '#w'].map((selector) =>
      [...removeColumn(html, selector).root.querySelectorAll('colgroup')].map((group) => group.outerHTML));

    expect(colgroups).toEqual([
      ['<colgroup><col id="b" span="2"></colgroup>', '<colgroup><col id="c"></colgroup>'],
      ['<colgroup><col id="a"><col id="b" span="1"></colgroup>', '<colgroup><col id="c"></colgroup>'],
      ['<colgroup><col id="a"><col id="b" span="2"></colgroup>'],
    ]);
  });

  it('leaves a row unchanged where the removed column is a gap, without filling existing gaps', () => {
    const html = '<table><tbody><tr><td>a</td><td id="b">b</td></tr><tr><td>c</td></tr></tbody></table>';

    expect(removeColumn(html, '#b').root.innerHTML)
      .toBe('<table><tbody><tr><td>a</td></tr><tr><td>c</td></tr></tbody></table>');
  });

  it('removes a row covered only by removed cells together with the line break before it, and removes a section left with no rows', () => {
    const html = '<table>\n<thead>\n<tr><th>h</th></tr>\n</thead>\n<tbody>\n<tr><td id="a" rowspan="2">a</td><td>b</td></tr>\n<tr></tr>\n<tr><td>note</td></tr>\n<tr><td>c</td><td>d</td></tr>\n</tbody>\n</table>';

    expect(removeColumn(html, '#a').root.innerHTML.split('\n'))
      .toEqual(['<table>', '<tbody>', '<tr><td>b</td></tr>', '<tr><td>d</td></tr>', '</tbody>', '</table>']);
  });

  it('keeps a row covered by a remaining cell from an upper row and a row no cell covered to begin with', () => {
    const html = '<table><tbody><tr><td rowspan="2">a</td><td id="b">b</td></tr><tr><td>c</td></tr><tr></tr><tr><td>d</td><td>e</td></tr></tbody></table>';

    expect(removeColumn(html, '#b').root.innerHTML)
      .toBe('<table><tbody><tr><td rowspan="2">a</td></tr><tr></tr><tr></tr><tr><td>d</td></tr></tbody></table>');
  });

  it('when a selection end is in a removed cell, the placement is the cell in the next column of the same row (the previous column for the last column)', () => {
    const html = '<table><tbody><tr><td>a</td><td id="b">b</td><td id="c">c</td></tr></tbody></table>';

    const middle = removeColumn(html, '#b');
    const last = removeColumn(html, '#c');

    expect([middle.placement?.textContent, last.placement?.textContent]).toEqual(['c', 'b']);
  });

  it('when a selection end is outside a cell but on a row covered only by removed cells, the placement is the cell in the next column of the reference cell row', () => {
    const root = createRoot('<table><tbody><tr><td id="a">a</td><td>b</td></tr><tr id="note"><td>x</td></tr></tbody></table>');

    const placement = deleteTableColumn(
      resolveTableGrid(readElement(root, 'table')),
      readElement(root, '#a'),
      [readElement(root, '#note')],
      { changed: false },
    );

    expect(placement?.textContent).toBe('b');
  });

  it('when a selection end is on a section whose rows are all removed, the placement is the cell in the next column of the reference cell row', () => {
    const root = createRoot('<table><thead><tr><th>h</th></tr></thead><tbody><tr><td id="a">a</td><td>b</td></tr></tbody></table>');

    const placement = deleteTableColumn(
      resolveTableGrid(readElement(root, 'table')),
      readElement(root, '#a'),
      [readElement(root, 'thead')],
      { changed: false },
    );

    expect([placement?.textContent, root.querySelector('thead')]).toEqual(['b', null]);
  });

  it('when a selection end is in a removed cell and no cell remains in that row, the placement is the next remaining cell after the reference cell in table order (the previous one for the last row)', () => {
    const middle = removeColumn('<table><tbody><tr><td>a</td><td>b</td></tr><tr><td id="x">x</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>', '#x');
    const last = removeColumn('<table><tbody><tr><td>a</td><td>b</td></tr><tr><td id="x">x</td></tr></tbody></table>', '#x');

    expect([middle.placement?.textContent, last.placement?.textContent]).toEqual(['d', 'b']);
  });

  it('deleting the column of a single-column table removes the whole table, with an empty paragraph as the placement', () => {
    const result = removeColumn('<p>x</p>\n<table><tbody><tr><td id="a">a</td></tr><tr><td>b</td></tr></tbody></table>\n<p><br></p>', '#a');

    expect([result.root.innerHTML, result.placement === result.root.lastElementChild])
      .toEqual(['<p>x</p>\n<p><br></p>', true]);
  });

  it('a comment annotation inside a removed cell goes away with the cell', () => {
    const html = '<table><tbody><tr><td id="a">x<comment>y<comment-body>note</comment-body></comment></td><td>b</td></tr></tbody></table>';

    expect(removeColumn(html, '#a').root.innerHTML).toBe('<table><tbody><tr><td>b</td></tr></tbody></table>');
  });
});

describe('deleting a table', () => {
  it('uses the empty paragraph right after the table as the placement, removing the table with the line break before it and leaving one paragraph', () => {
    const root = createRoot('<p>ab</p>\n<table><tbody><tr><td>a</td></tr></tbody></table>\n<p><br></p>');
    const progress: BlockRewriteProgress = { changed: false };

    const placement = deleteTable(readElement(root, 'table'), progress);

    expect([root.innerHTML, placement === root.lastElementChild, progress.changed])
      .toEqual(['<p>ab</p>\n<p><br></p>', true, true]);
  });

  it('uses the paragraph right before as the placement when the one right after is not an empty paragraph but the one before is', () => {
    const root = createRoot('<p><br></p>\n<table><tbody><tr><td>a</td></tr></tbody></table>\n<p>cd</p>');

    const placement = deleteTable(readElement(root, 'table'), { changed: false });

    expect([root.innerHTML, placement === root.firstElementChild]).toEqual(['<p><br></p>\n<p>cd</p>', true]);
  });

  it('inserts an empty paragraph where the table was as the placement when neither neighbor is an empty paragraph', () => {
    const root = createRoot('<p>ab</p>\n<table><tbody><tr><td>a</td></tr></tbody></table>\n<p>cd</p>');

    const placement = deleteTable(readElement(root, 'table'), { changed: false });

    expect([root.innerHTML, placement === root.children[1]]).toEqual(['<p>ab</p>\n<p><br></p>\n<p>cd</p>', true]);
  });
});
