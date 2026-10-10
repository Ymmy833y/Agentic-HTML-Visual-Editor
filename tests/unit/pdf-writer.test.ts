// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { CONTENT_WIDTH_PT, PAGE_HEIGHT_PT, PAGE_MARGIN_PT } from '../../common/index';
import { placeImage, writePdf } from '../../src/export/pdf-writer';
import type { JpegPage } from '../../src/export/pdf-writer';

// Stand-ins for JPEG files. The writer embeds the bytes as they are and never decodes them.
const PAGE: JpegPage = {
  jpeg: new Uint8Array([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]),
  width: 1360,
  height: 2000,
  links: [],
};

// PDF points per pixel of a page image 1360 pixels wide.
const RATIO = CONTENT_WIDTH_PT / 1360;

/**
 * Formats a number as the writer does, with at most two decimals.
 *
 * @param value The number.
 */
function format(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * Reads a PDF as text, one character per byte.
 *
 * @param bytes The PDF.
 */
function readText(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

describe('writing a PDF', () => {
  it('makes a file that starts with the PDF header and ends with the end-of-file marker from one page image', () => {
    const text = readText(writePdf([PAGE]));

    expect([text.startsWith('%PDF-1.4\n'), text.endsWith('%%EOF\n')]).toEqual([true, true]);
  });

  it('makes a page tree of three pages whose cross-reference table points at each object from three page images', () => {
    const text = readText(writePdf([PAGE, PAGE, PAGE]));

    const table = /xref\n0 (\d+)\n0000000000 65535 f \n((?:\d{10} 00000 n \n)+)/u.exec(text);
    const offsets = (table?.[2].match(/\d{10}/gu) ?? []).map(Number);
    expect([
      /\/Type \/Pages \/Kids \[[^\]]*\] \/Count 3 /u.test(text),
      Number(table?.[1]),
      offsets.every((offset, index) => text.startsWith(`${String(index + 1)} 0 obj\n`, offset)),
    ]).toEqual([true, 12, true]);
  });

  it('points the start of the cross-reference table at the table', () => {
    const text = readText(writePdf([PAGE]));

    const start = Number(/startxref\n(\d+)\n%%EOF\n$/u.exec(text)?.[1]);
    expect(text.startsWith('xref\n', start)).toBe(true);
  });

  it('embeds the bytes of each image as they are, as a JPEG stream', () => {
    const text = readText(writePdf([PAGE]));

    expect(text).toContain(`/Filter /DCTDecode /Length 6 >>\nstream\n${readText(PAGE.jpeg)}\nendstream`);
  });

  it('places an image inside the 15 mm margins, as wide as the area and hanging from the top margin', () => {
    const placement = placeImage({ width: 1360, height: 680 });

    expect(placement).toEqual({
      x: PAGE_MARGIN_PT,
      y: PAGE_HEIGHT_PT - PAGE_MARGIN_PT - CONTENT_WIDTH_PT / 2,
      width: CONTENT_WIDTH_PT,
      height: CONTENT_WIDTH_PT / 2,
    });
  });

  it('takes 15 mm as the margin', () => {
    expect(PAGE_MARGIN_PT).toBeCloseTo(42.52, 2);
  });

  it('puts a link annotation that opens the URL over the area of a link to a URL', () => {
    const page: JpegPage = {
      ...PAGE,
      links: [{ x: 100, y: 200, width: 300, height: 40, target: { kind: 'uri', uri: 'https://example.com/a' } }],
    };

    const text = readText(writePdf([page]));

    const left = PAGE_MARGIN_PT + 100 * RATIO;
    const top = PAGE_HEIGHT_PT - PAGE_MARGIN_PT - 200 * RATIO;
    const rect = [left, top - 40 * RATIO, left + 300 * RATIO, top].map(format).join(' ');
    expect([
      text.includes('/Contents 5 0 R /Annots [6 0 R] >>'),
      text.includes(`6 0 obj\n<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0]`
        + ' /A << /S /URI /URI (https://example.com/a) >> >>\nendobj'),
    ]).toEqual([true, true]);
  });

  it('percent-encodes spaces and characters beyond ASCII and escapes parentheses and backslashes in a URL', () => {
    const page: JpegPage = {
      ...PAGE,
      links: [{ x: 0, y: 0, width: 10, height: 10, target: { kind: 'uri', uri: 'docs/設計 (案)\\a.html' } }],
    };

    const text = readText(writePdf([page]));

    expect(text).toContain('/URI (docs/%E8%A8%AD%E8%A8%88%20\\(%E6%A1%88\\)\\\\a.html)');
  });

  it('keeps the percent signs of a URL that is already percent-encoded', () => {
    const page: JpegPage = {
      ...PAGE,
      links: [{ x: 0, y: 0, width: 10, height: 10, target: { kind: 'uri', uri: './a%3Fb.html#x' } }],
    };

    const text = readText(writePdf([page]));

    expect(text).toContain('/URI (./a%3Fb.html#x)');
  });

  it('puts a link annotation that points at the page object and the height of the target of a link inside the document', () => {
    const page: JpegPage = {
      ...PAGE,
      links: [{ x: 0, y: 0, width: 10, height: 10, target: { kind: 'page', pageIndex: 1, y: 500 } }],
    };

    const text = readText(writePdf([page, PAGE]));

    const top = format(PAGE_HEIGHT_PT - PAGE_MARGIN_PT - 500 * RATIO);
    expect([
      text.includes('/Contents 5 0 R /Annots [9 0 R] >>'),
      text.includes(`/Border [0 0 0] /Dest [6 0 R /XYZ 0 ${top} null] >>`),
    ]).toEqual([true, true]);
  });

  it('keeps the cross-reference table pointing at each object when pages have links', () => {
    const uri = { kind: 'uri', uri: 'https://example.com/' } as const;
    const page: JpegPage = {
      ...PAGE,
      links: [
        { x: 0, y: 0, width: 10, height: 10, target: uri },
        { x: 0, y: 20, width: 10, height: 10, target: uri },
      ],
    };

    const text = readText(writePdf([page, page]));

    const table = /xref\n0 (\d+)\n0000000000 65535 f \n((?:\d{10} 00000 n \n)+)/u.exec(text);
    const offsets = (table?.[2].match(/\d{10}/gu) ?? []).map(Number);
    expect([
      text.includes('/Annots [9 0 R 10 0 R]'),
      text.includes('/Annots [11 0 R 12 0 R]'),
      Number(table?.[1]),
      offsets.every((offset, index) => text.startsWith(`${String(index + 1)} 0 obj\n`, offset)),
    ]).toEqual([true, true, 13, true]);
  });

  it('leaves out a link to a page that does not exist', () => {
    const page: JpegPage = {
      ...PAGE,
      links: [{ x: 0, y: 0, width: 10, height: 10, target: { kind: 'page', pageIndex: 3, y: 0 } }],
    };

    expect(readText(writePdf([page]))).not.toContain('/Annot');
  });
});
