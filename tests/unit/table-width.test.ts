import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { resolveTableGrid } from '../../webview/editing/table-grid';
import {
  MIN_COLUMN_WIDTH,
  distributeColumnWidths,
  formatColumnWidth,
  prepareColumnElements,
  readColumnWidthLimits,
  readColumnWidthsForInsert,
  readTableWidthUnit,
  setColumnWidth,
  toggleTableWidthUnit,
  writeDistributedColumnWidths,
} from '../../webview/editing/table-width';
import type { TableColumnMeasure } from '../../webview/editing/table-width';
import { createRoot, readElement } from './helpers/format-dom';

/**
 * Creates one table and returns it.
 *
 * @param html The table's HTML.
 * @returns The table element.
 */
function createTable(html: string): Element {
  return readElement(createRoot(html), 'table');
}

/** A tbody with one two-column row. */
const TWO_COLUMN_BODY = '<tbody><tr><td>a</td><td>b</td></tr></tbody>';

describe('deciding the table width unit', () => {
  it('returns percent when the first col with a width uses %, and pixel when it uses px', () => {
    const units = [
      readTableWidthUnit(createTable(`<table><colgroup><col style="width: 30%"><col style="width: 50px"></colgroup>${TWO_COLUMN_BODY}</table>`)),
      readTableWidthUnit(createTable(`<table><colgroup><col style="width: 50px"><col style="width: 30%"></colgroup>${TWO_COLUMN_BODY}</table>`)),
    ];

    expect(units).toEqual(['percent', 'pixel']);
  });

  it('decides by the attribute value for a col with only a width attribute, returning percent for 30% and pixel for 120', () => {
    const units = [
      readTableWidthUnit(createTable(`<table><colgroup><col width="30%"></colgroup>${TWO_COLUMN_BODY}</table>`)),
      readTableWidthUnit(createTable(`<table><colgroup><col width="120"></colgroup>${TWO_COLUMN_BODY}</table>`)),
    ];

    expect(units).toEqual(['percent', 'pixel']);
  });

  it('treats a col with an em width as pixel, and skips an auto col so the next col decides', () => {
    const units = [
      readTableWidthUnit(createTable(`<table><colgroup><col style="width: 10em"></colgroup>${TWO_COLUMN_BODY}</table>`)),
      readTableWidthUnit(createTable(`<table><colgroup><col style="width: auto"><col style="width: 40%"></colgroup>${TWO_COLUMN_BODY}</table>`)),
    ];

    expect(units).toEqual(['pixel', 'percent']);
  });

  it('returns percent for a table without cols and for a table with no col that has a width', () => {
    const units = [
      readTableWidthUnit(createTable(`<table>${TWO_COLUMN_BODY}</table>`)),
      readTableWidthUnit(createTable(`<table><colgroup><col><col class="x"></colgroup>${TWO_COLUMN_BODY}</table>`)),
    ];

    expect(units).toEqual(['percent', 'percent']);
  });

  it('makes the outer table percent when it has no cols, even if the col of a nested table is px', () => {
    const table = createTable(
      '<table><tbody><tr><td><table><colgroup><col style="width: 80px"></colgroup>'
      + '<tbody><tr><td>x</td></tr></tbody></table></td></tr></tbody></table>',
    );

    expect(readTableWidthUnit(table)).toBe('percent');
  });
});

describe('preparing a col per column', () => {
  it('inserts, for a table without a colgroup, a colgroup preceded by one line break before the whitespace just before the first section after the caption, with as many cols as columns and no whitespace between them', () => {
    const table = createTable(`<table><caption>c</caption>\n${TWO_COLUMN_BODY}\n</table>`);

    prepareColumnElements(resolveTableGrid(table), [0, 1]);

    expect(table.innerHTML).toBe(`<caption>c</caption>\n<colgroup><col><col></colgroup>\n${TWO_COLUMN_BODY}\n`);
  });

  it('keeps the original col on the first column without its span when writing the second column of a span 3 col, followed by two cols copying its attributes except id and span', () => {
    const table = createTable(
      '<table><colgroup><col id="k" span="3" class="c" style="background: red"></colgroup>'
      + '<tbody><tr><td>a</td><td>b</td><td>c</td></tr></tbody></table>',
    );

    const prepared = prepareColumnElements(resolveTableGrid(table), [1]);

    const group = readElement(table, 'colgroup');
    expect([group.innerHTML, prepared.get(1) === group.children[1]]).toEqual([
      '<col id="k" class="c" style="background: red"><col class="c" style="background: red">'
      + '<col class="c" style="background: red">',
      true,
    ]);
  });

  it('adds two cols to a span 2 colgroup without cols, and adds cols for columns no colgroup covers after the last col of the last colgroup', () => {
    const table = createTable(
      '<table><colgroup span="2"></colgroup><colgroup><col class="x"></colgroup>'
      + '<tbody><tr><td>a</td><td>b</td><td>c</td><td>d</td></tr></tbody></table>',
    );

    prepareColumnElements(resolveTableGrid(table), [0, 1, 2, 3]);

    expect([...table.querySelectorAll('colgroup')].map((group) => group.outerHTML)).toEqual([
      '<colgroup span="2"><col><col></colgroup>',
      '<colgroup><col class="x"><col></colgroup>',
    ]);
  });

  it('leaves the tree unchanged for a table where each column to write already has its own col', () => {
    const html = `<table><colgroup><col><col style="width: 40%"></colgroup>${TWO_COLUMN_BODY}</table>`;
    const table = createTable(html);

    prepareColumnElements(resolveTableGrid(table), [0, 1]);

    expect(table.outerHTML).toBe(html);
  });
});

describe('spelling a column width value', () => {
  it('rounds px to an integer and spells % as the proportion of the basis to two decimal places with trailing zeros dropped (33.33%, 25%)', () => {
    const values = [
      formatColumnWidth('pixel', 120.6, 400),
      formatColumnWidth('percent', 100, 300),
      formatColumnWidth('percent', 100, 400),
    ];

    expect(values).toEqual(['121px', '33.33%', '25%']);
  });
});

describe('the limits for a column\'s rendered width', () => {
  it('makes the maximum the sum of the target and right neighbor widths minus 20px for a percent table, and returns undefined for the rightmost column', () => {
    const measure: TableColumnMeasure = {
      boundaries: [0, 100, 300, 400],
      widths: [100, 200, 100],
      tableWidth: 400,
      availableWidth: 800,
    };

    const limits = [
      readColumnWidthLimits('percent', measure, 0),
      readColumnWidthLimits('percent', measure, 2),
    ];

    expect(limits).toEqual([{ min: MIN_COLUMN_WIDTH, max: 280 }, undefined]);
  });

  it('makes the maximum wider by the remaining available width for a pixel table, and the current width for a table already wider than the available width', () => {
    const fitting: TableColumnMeasure = { boundaries: [0, 100, 300], widths: [100, 200], tableWidth: 300, availableWidth: 500 };
    const wide: TableColumnMeasure = { boundaries: [0, 300, 700], widths: [300, 400], tableWidth: 700, availableWidth: 500 };

    const limits = [readColumnWidthLimits('pixel', fitting, 0), readColumnWidthLimits('pixel', wide, 1)];

    expect(limits).toEqual([{ min: MIN_COLUMN_WIDTH, max: 300 }, { min: MIN_COLUMN_WIDTH, max: 400 }]);
  });

  it('makes the current width the minimum for a column currently narrower than 20px', () => {
    const measure: TableColumnMeasure = { boundaries: [0, 10, 210], widths: [10, 200], tableWidth: 210, availableWidth: 500 };

    expect(readColumnWidthLimits('pixel', measure, 0)?.min).toBe(10);
  });
});

describe('sharing column widths with an added column', () => {
  it('gives a column added at index 1 to widths 180, 210 and 210 the total divided by four, shrinking the others by the same proportion', () => {
    expect(distributeColumnWidths([180, 210, 210], 1)).toEqual([135, 150, 157.5, 157.5]);
  });

  it('keeps the total of a pixel table when rounding, giving the added column the difference (76px, 76px, 76px, 75px for three 101px columns)', () => {
    const table = createTable('<table><colgroup><col><col><col><col></colgroup>'
      + '<tbody><tr><td>a</td><td>b</td><td>c</td><td>d</td></tr></tbody></table>');

    writeDistributedColumnWidths(table, { unit: 'pixel', widths: [101, 101, 101] }, 3);

    expect([...table.querySelectorAll('col')].map((col) => (col instanceof HTMLElement ? col.style.width : '')))
      .toEqual(['76px', '76px', '76px', '75px']);
  });

  it('reads no widths for a table whose cols have no width, nor for a table that is not rendered', () => {
    const tables = [
      createTable(`<table><colgroup><col><col></colgroup>${TWO_COLUMN_BODY}</table>`),
      createTable(`<table><colgroup><col style="width: 30%"><col style="width: 70%"></colgroup>${TWO_COLUMN_BODY}</table>`),
    ];

    expect(tables.map((table) => readColumnWidthsForInsert(resolveTableGrid(table)))).toEqual([undefined, undefined]);
  });
});

describe('writing to a table that is not rendered', () => {
  it('leaves the tree unchanged and the progress false when setting a column width on a table that is not rendered (rendered width 0)', () => {
    const html = `<table>${TWO_COLUMN_BODY}</table>`;
    const table = createTable(html);
    const progress: BlockRewriteProgress = { changed: false };

    setColumnWidth(resolveTableGrid(table), readElement(table, 'td'), 50, progress);

    expect([table.outerHTML, progress.changed]).toEqual([html, false]);
  });

  it('leaves the tree unchanged and the progress false when toggling the width unit of a table that is not rendered', () => {
    const html = `<table>${TWO_COLUMN_BODY}</table>`;
    const table = createTable(html);
    const progress: BlockRewriteProgress = { changed: false };

    toggleTableWidthUnit(resolveTableGrid(table), progress);

    expect([table.outerHTML, progress.changed]).toEqual([html, false]);
  });
});
