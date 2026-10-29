import { describe, expect, it } from 'vitest';

import { assignTextToPages } from '../../webview/export/pdf-text';
import type { PdfTextLine } from '../../webview/export/pdf-text';

// A line of body text 14 CSS pixels high.
const LINE: PdfTextLine = {
  role: 'sans',
  size: 14,
  top: 0,
  color: [0, 0, 0],
  bold: false,
  italic: false,
  text: 'ab',
  xs: [10, 18],
};

describe('putting the text on the pages', () => {
  it('puts a line on the page it lies in, measured from the top of that page in the pixels of the image', () => {
    const pages = assignTextToPages([{ ...LINE, top: 1050 }], [0, 1000], 2000, 2);

    expect(pages).toEqual([[], [{ ...LINE, size: 28, top: 100, xs: [20, 36] }]]);
  });

  it('puts a line that reaches past the end of its page on both pages', () => {
    const pages = assignTextToPages([{ ...LINE, top: 990 }], [0, 1000], 2000, 2);

    expect(pages.map((runs) => runs.map((run) => run.top))).toEqual([[1980], [-20]]);
  });

  it('puts a line that ends where the next page starts on its page only', () => {
    const pages = assignTextToPages([{ ...LINE, top: 986 }], [0, 1000], 2000, 1);

    expect(pages.map((runs) => runs.length)).toEqual([1, 0]);
  });
});
