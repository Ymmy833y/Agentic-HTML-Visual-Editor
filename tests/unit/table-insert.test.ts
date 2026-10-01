import { describe, expect, it } from 'vitest';

import { insertTable, insertTableIntoListItem } from '../../webview/editing/table-insert';
import { mountRoot, readElement } from './helpers/format-dom';

/** A table inserted with 1 row and 1 column. The section and the row each sit on their own line. */
const TABLE_1X1 = '<table>\n<tbody>\n<tr><td><br></td></tr>\n</tbody>\n</table>';

/** A table inserted with 3 rows and 2 columns. The first row becomes a header row. */
const TABLE_3X2 = '<table>\n<tbody>\n'
  + '<tr><th scope="col"><br></th><th scope="col"><br></th></tr>\n'
  + '<tr><td><br></td><td><br></td></tr>\n'
  + '<tr><td><br></td><td><br></td></tr>\n'
  + '</tbody>\n</table>';

describe('insert table', () => {
  it('given 3 rows and 2 columns with a non-empty paragraph as the reference, inserts a 3-by-2 table right after the paragraph', () => {
    const root = mountRoot('\n<p>ab</p>\n<p>cd</p>');

    const inserted = insertTable(readElement(root, 'p'), 3, 2);

    expect([inserted, root.innerHTML]).toEqual([true, `\n<p>ab</p>\n${TABLE_3X2}\n<p>cd</p>`]);
  });

  it('makes the first row cells th (scope="col") and the rest td, with every row in a single tbody and no thead', () => {
    const root = mountRoot('\n<p>ab</p>');

    insertTable(readElement(root, 'p'), 3, 2);

    const rows = [...root.querySelectorAll('tr')].map((row) =>
      [...row.children].map((cell) => `${cell.localName}:${cell.getAttribute('scope') ?? ''}`));
    expect([rows, root.querySelectorAll('tbody').length, root.querySelectorAll('thead').length]).toEqual([
      [['th:col', 'th:col'], ['td:', 'td:'], ['td:', 'td:']],
      1,
      0,
    ]);
  });

  it('given 1 row, makes no header row and produces a single row of td', () => {
    const root = mountRoot('\n<p>ab</p>\n<p>cd</p>');

    insertTable(readElement(root, 'p'), 1, 2);

    expect(readElement(root, 'table').outerHTML)
      .toBe('<table>\n<tbody>\n<tr><td><br></td><td><br></td></tr>\n</tbody>\n</table>');
  });

  it('every cell holds only one placeholder br, and the table, section, rows and td have no attributes', () => {
    const root = mountRoot('\n<p>ab</p>');

    insertTable(readElement(root, 'p'), 3, 2);

    const table = readElement(root, 'table');
    expect([
      [...table.querySelectorAll('th, td')].every((cell) => cell.innerHTML === '<br>'),
      [table, ...table.querySelectorAll('tbody, tr, td')].every((element) => element.attributes.length === 0),
    ]).toEqual([true, true]);
  });

  it('with an empty paragraph as the reference, inserts the table before it, keeps the paragraph after the table, and adds no empty paragraph', () => {
    const root = mountRoot('\n<p><br></p>');

    insertTable(readElement(root, 'p'), 1, 1);

    expect(root.innerHTML).toBe(`\n\n${TABLE_1X1}\n<p><br></p>`);
  });

  it('adds an empty paragraph right after the table when no block follows, and not when a block or bare text follows', () => {
    const results = ['\n<p>ab</p>', '\n<p>ab</p>\n<p>cd</p>', '\n<p>ab</p>\ncd'].map((html) => {
      const root = mountRoot(html);
      insertTable(readElement(root, 'p'), 1, 1);
      return root.innerHTML;
    });

    expect(results).toEqual([
      `\n<p>ab</p>\n${TABLE_1X1}\n<p><br></p>`,
      `\n<p>ab</p>\n${TABLE_1X1}\n<p>cd</p>`,
      `\n<p>ab</p>\n${TABLE_1X1}\ncd`,
    ]);
  });

  it('puts the table, section and rows each on their own line, with cells in a row and no whitespace between them', () => {
    const root = mountRoot('\n<p>ab</p>');

    insertTable(readElement(root, 'p'), 2, 2);

    expect(root.innerHTML.split('\n')).toEqual([
      '',
      '<p>ab</p>',
      '<table>',
      '<tbody>',
      '<tr><th scope="col"><br></th><th scope="col"><br></th></tr>',
      '<tr><td><br></td><td><br></td></tr>',
      '</tbody>',
      '</table>',
      '<p><br></p>',
    ]);
  });

  it('when the reference is a code block or a bare blockquote, inserts after the pre or blockquote rather than inside it', () => {
    const results = ['pre', 'blockquote'].map((selector) => {
      const root = mountRoot('\n<pre><code>ab</code></pre>\n<blockquote>cd</blockquote>\n<p>ef</p>');
      insertTable(readElement(root, selector), 1, 1);
      return root.innerHTML;
    });

    expect(results).toEqual([
      `\n<pre><code>ab</code></pre>\n${TABLE_1X1}\n<blockquote>cd</blockquote>\n<p>ef</p>`,
      `\n<pre><code>ab</code></pre>\n<blockquote>cd</blockquote>\n${TABLE_1X1}\n<p>ef</p>`,
    ]);
  });

  it('when the reference is a paragraph inside a cell, inserts a nested table inside that cell', () => {
    const root = mountRoot('<table><tbody><tr><td><p>ab</p></td></tr></tbody></table>');

    insertTable(readElement(root, 'td p'), 1, 1);

    expect(readElement(root, 'td').innerHTML).toBe(`<p>ab</p>\n${TABLE_1X1}\n<p><br></p>`);
  });

  it('given 100 rows and 100 columns, inserts a 100-by-100 table', () => {
    const root = mountRoot('\n<p>ab</p>');

    insertTable(readElement(root, 'p'), 100, 100);

    const rows = [...readElement(root, 'table').querySelectorAll('tr')];
    expect([rows.length, rows.every((row) => row.children.length === 100)]).toEqual([100, true]);
  });
});

describe('inserting a table into a list item', () => {
  it('in an item whose own content is the line, inserts the table at the end of the item without splitting the list, and adds an empty paragraph after it', () => {
    const root = mountRoot('<ul><li>ab</li><li>cd</li></ul>');

    const inserted = insertTableIntoListItem(readElement(root, 'li'), 1, 1);

    expect([inserted, root.innerHTML])
      .toEqual([true, `<ul><li>ab\n${TABLE_1X1}\n<p><br></p></li><li>cd</li></ul>`]);
  });

  it('in an item with a nested list, inserts the table right before the nested list and adds no empty paragraph', () => {
    const root = mountRoot('<ul><li>ab<ul><li>c</li></ul></li></ul>');

    insertTableIntoListItem(readElement(root, 'li'), 1, 1);

    expect(root.innerHTML).toBe(`<ul><li>ab\n${TABLE_1X1}\n<ul><li>c</li></ul></li></ul>`);
  });

  it('in an empty item, replaces the placeholder with the table and adds an empty paragraph after the table', () => {
    const root = mountRoot('<ul><li><br></li></ul>');

    insertTableIntoListItem(readElement(root, 'li'), 1, 1);

    expect(root.innerHTML).toBe(`<ul><li>\n${TABLE_1X1}\n<p><br></p></li></ul>`);
  });

  it('inserts the table right after the item line paragraph if it is not empty, and right before it if empty, keeping the paragraph', () => {
    const results = ['<ul><li><p>ab</p></li></ul>', '<ul><li><p><br></p></li></ul>'].map((html) => {
      const root = mountRoot(html);
      insertTableIntoListItem(readElement(root, 'p'), 1, 1);
      return root.innerHTML;
    });

    expect(results).toEqual([
      `<ul><li><p>ab</p>\n${TABLE_1X1}\n<p><br></p></li></ul>`,
      `<ul><li>\n${TABLE_1X1}\n<p><br></p></li></ul>`,
    ]);
  });
});
