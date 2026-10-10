import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { findDirectCell, wrapCellRuns } from '../../webview/editing/cell-wrap';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/**
 * Creates a body with just one table, with the given cell contents.
 *
 * @param cells The contents of the cells in the row.
 * @returns The editor root.
 */
function mountTable(...cells: readonly string[]): HTMLElement {
  return mountRoot(`<table><tbody><tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr></tbody></table>`);
}

/**
 * Selects the range and then wraps.
 *
 * @param root The editor root.
 * @param range The range to select.
 * @param progress Records whether the tree was changed.
 * @returns The wrapping result.
 */
function wrapSelected(root: Element, range: Range, progress: BlockRewriteProgress = { changed: false }): ReturnType<typeof wrapCellRuns> {
  select(range);
  return wrapCellRuns(root, range, progress);
}

describe('wrapping the bare runs of a cell', () => {
  it('moves the text of a bare text cell, by reference, into a paragraph preceded by one line break, and returns the caret to the same character position', () => {
    const root = mountTable('abc');
    const cell = readElement(root, 'td');
    const text = readChildText(cell, 0);

    wrapSelected(root, createRange(text, 1, text, 1));

    const selection = window.getSelection();
    expect([cell.innerHTML, readElement(cell, 'p').firstChild === text, selection?.anchorNode === text, selection?.anchorOffset])
      .toEqual(['\n<p>abc</p>', true, true, 1]);
  });

  it('moves a run that includes b, i, u, sub, sup, kbd and comment into one paragraph as a whole', () => {
    const inner = 'a<b>b</b><i>c</i><u>d</u><sub>e</sub><sup>f</sup><kbd>g</kbd><comment>h</comment>i';
    const root = mountTable(inner);
    const cell = readElement(root, 'td');
    const text = readChildText(cell, 0);

    wrapSelected(root, createRange(text, 0, text, 0));

    expect(cell.innerHTML).toBe(`\n<p>${inner}</p>`);
  });

  it('moves a run that includes mark into one paragraph as a whole', () => {
    const inner = 'a<mark>b</mark>c';
    const root = mountTable(inner);
    const cell = readElement(root, 'td');
    const text = readChildText(cell, 0);

    wrapSelected(root, createRange(text, 1, text, 1));

    expect(cell.innerHTML).toBe(`\n<p>${inner}</p>`);
  });

  it('ends runs at section and dl, and turns only the start\'s run into a paragraph', () => {
    const root = mountTable('ab<section>x</section>cd<dl><dt>y</dt></dl>ef');
    const cell = readElement(root, 'td');
    const text = readChildText(cell, 2);

    wrapSelected(root, createRange(text, 1, text, 1));

    expect(cell.innerHTML).toBe('ab<section>x</section>\n<p>cd</p><dl><dt>y</dt></dl>ef');
  });

  it('creates two paragraphs, one per run, when the range overlaps two runs in the same cell, and returns both ends of the range to their original character positions', () => {
    const root = mountTable('ab<p>cd</p>ef');
    const cell = readElement(root, 'td');
    const first = readChildText(cell, 0);
    const last = readChildText(cell, 2);

    wrapSelected(root, createRange(first, 1, last, 1));

    const selection = window.getSelection();
    expect([
      cell.innerHTML,
      selection?.anchorNode === first,
      selection?.anchorOffset,
      selection?.focusNode === last,
      selection?.focusOffset,
    ]).toEqual(['\n<p>ab</p><p>cd</p>\n<p>ef</p>', true, 1, true, 1]);
  });

  it('does not wrap the bare runs of other cells or of cells of a nested table, even when the range reaches them', () => {
    const nested = 'cd<table><tbody><tr><td>ef</td></tr></tbody></table>';
    const root = mountTable('ab', nested);
    const [first, second] = [...readElement(root, 'tr').children];
    const inner = readElement(second, 'td');

    wrapSelected(root, createRange(readChildText(first, 0), 1, readChildText(inner, 0), 1));

    expect([first.innerHTML, second.innerHTML]).toEqual(['\n<p>ab</p>', nested]);
  });

  it('wraps only the bare run when the start is inside a paragraph and the range overlaps a bare run in the same cell, and the start\'s paragraph is undefined', () => {
    const root = mountTable('<p>ab</p>cd');
    const cell = readElement(root, 'td');

    const result = wrapSelected(root, createRange(readChildText(readElement(cell, 'p'), 0), 1, readChildText(cell, 1), 1));

    expect([cell.innerHTML, result?.startParagraph]).toEqual(['<p>ab</p>\n<p>cd</p>', undefined]);
  });

  it('inserts one line break and a placeholder paragraph before the whitespace when the start is in the whitespace between a list and a table, and reports that it was inserted where there was no run', () => {
    const table = '<table><tbody><tr><td>x</td></tr></tbody></table>';
    const root = mountTable(`<ul><li>a</li></ul>\n${table}`);
    const cell = readElement(root, 'td');
    const space = readChildText(cell, 1);

    const result = wrapSelected(root, createRange(space, 1, space, 1));

    expect([cell.innerHTML, result?.insertedEmpty]).toEqual([`<ul><li>a</li></ul>\n<p><br></p>\n${table}`, true]);
  });

  it('inserts an empty paragraph with one placeholder into a cell without children', () => {
    const root = mountTable('');
    const cell = readElement(root, 'td');

    wrapSelected(root, createRange(cell, 0, cell, 0));

    expect(cell.innerHTML).toBe('\n<p><br></p>');
  });

  it('gives a paragraph that wraps a run of only whitespace and br a single placeholder br', () => {
    const root = mountTable('\n<br>\n');
    const cell = readElement(root, 'td');

    wrapSelected(root, createRange(cell, 0, cell, 0));

    expect(cell.innerHTML).toBe('\n<p><br></p>');
  });

  it('leaves the tree unchanged, returns undefined and leaves the progress false when the start is outside cells', () => {
    const html = '<p>ab</p><table><tbody><tr><td>cd</td></tr></tbody></table>';
    const root = mountRoot(html);
    const text = readChildText(readElement(root, 'p'), 0);
    const progress: BlockRewriteProgress = { changed: false };

    const result = wrapSelected(root, createRange(text, 1, text, 1), progress);

    expect([result, progress.changed, root.innerHTML]).toEqual([undefined, false, html]);
  });
});

describe('deciding a direct child of a cell', () => {
  it('returns the cell for text with only phrasing content elements in between, and undefined for text inside a paragraph', () => {
    const root = mountTable('a<b><i>x</i></b><p>y</p>');
    const cell = readElement(root, 'td');

    const found = [
      findDirectCell(root, readChildText(readElement(cell, 'i'), 0)),
      findDirectCell(root, readChildText(readElement(cell, 'p'), 0)),
    ];

    expect(found).toEqual([cell, undefined]);
  });
});
