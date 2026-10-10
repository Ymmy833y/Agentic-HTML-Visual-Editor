// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { choosePageBreaks } from '../../webview/export/pdf-page-breaks';

describe('choosing where pages start', () => {
  it('ends a page at the lowest block bottom above the bottom of the page', () => {
    expect(choosePageBreaks([300, 700, 950, 1100, 1500], 1500, 1000)).toEqual([0, 950]);
  });

  it('cuts at the height of the page when no block ends within the page', () => {
    expect(choosePageBreaks([2500], 2500, 1000)).toEqual([0, 1000, 2000]);
  });

  it('puts a document no taller than a page on one page', () => {
    expect(choosePageBreaks([200, 400], 400, 1000)).toEqual([0]);
  });

  it('does not end a page at a bottom at the very top of the page', () => {
    expect(choosePageBreaks([0, 1000, 1000, 1600], 1600, 1000)).toEqual([0, 1000]);
  });
});
