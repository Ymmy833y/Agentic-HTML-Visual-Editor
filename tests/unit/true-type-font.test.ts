// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseTrueTypeFont } from '../../src/export/true-type-font';
import { readBundledFontFile } from './bundled-font-files';

const SANS = parseTrueTypeFont(readBundledFontFile('sans'));
const MONO = parseTrueTypeFont(readBundledFontFile('mono'));

// The outlines of a font of four glyphs: none for glyph 0, one point for glyphs 1 and 3, and glyph 2 made of glyph 1.
const SIMPLE_OUTLINE = [0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00];
const COMPOSITE_OUTLINE = [0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

/**
 * Builds a font of four glyphs whose glyph 2 is made of glyph 1, with a character map of format 4 that maps A to
 * glyph 2. The bundled fonts have neither a composite glyph nor only a map of that format.
 */
function buildCompositeFont(): Uint8Array {
  const head = new DataView(new ArrayBuffer(54));
  head.setUint32(0, 0x00010000);
  head.setUint32(12, 0x5f0f3cf5);
  head.setUint16(18, 1000);
  head.setInt16(50, 0);
  const hhea = new DataView(new ArrayBuffer(36));
  hhea.setUint32(0, 0x00010000);
  hhea.setInt16(4, 800);
  hhea.setInt16(6, -200);
  hhea.setUint16(34, 4);
  const maxp = new DataView(new ArrayBuffer(6));
  maxp.setUint32(0, 0x00005000);
  maxp.setUint16(4, 4);
  const hmtx = new DataView(new ArrayBuffer(16));
  hmtx.setUint16(0, 500);
  hmtx.setUint16(4, 600);
  hmtx.setUint16(8, 700);
  hmtx.setUint16(12, 800);
  // Offsets in the short form are halved: glyph 0 is empty and each of the others takes 20 bytes.
  const loca = new DataView(new ArrayBuffer(10));
  loca.setUint16(4, 10);
  loca.setUint16(6, 20);
  loca.setUint16(8, 30);
  const glyf = new Uint8Array([...SIMPLE_OUTLINE, ...COMPOSITE_OUTLINE, ...SIMPLE_OUTLINE]);
  // One Windows Unicode subtable of format 4 with a segment for A and the closing segment.
  const cmap = new DataView(new ArrayBuffer(44));
  cmap.setUint16(2, 1);
  cmap.setUint16(4, 3);
  cmap.setUint16(6, 1);
  cmap.setUint32(8, 12);
  cmap.setUint16(12, 4);
  cmap.setUint16(14, 32);
  cmap.setUint16(18, 4);
  cmap.setUint16(26, 0x41);
  cmap.setUint16(28, 0xffff);
  cmap.setUint16(32, 0x41);
  cmap.setUint16(34, 0xffff);
  cmap.setInt16(36, 2 - 0x41);
  cmap.setInt16(38, 1);

  const tables: [string, Uint8Array][] = [
    ['cmap', new Uint8Array(cmap.buffer)],
    ['glyf', glyf],
    ['head', new Uint8Array(head.buffer)],
    ['hhea', new Uint8Array(hhea.buffer)],
    ['hmtx', new Uint8Array(hmtx.buffer)],
    ['loca', new Uint8Array(loca.buffer)],
    ['maxp', new Uint8Array(maxp.buffer)],
  ];
  // Each table gets 64 bytes, more than any of them needs.
  const file = new Uint8Array(12 + tables.length * 16 + tables.length * 64);
  const view = new DataView(file.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, tables.length);
  tables.forEach(([tag, data], index) => {
    const offset = 12 + tables.length * 16 + index * 64;
    file.set(data, offset);
    file.set([...tag].map((character) => character.charCodeAt(0)), 12 + index * 16);
    view.setUint32(12 + index * 16 + 8, offset);
    view.setUint32(12 + index * 16 + 12, data.length);
  });
  return file;
}

/**
 * Returns whether ranges of code points hold a character.
 *
 * @param ranges The ranges.
 * @param character The character.
 */
function covers(ranges: readonly [number, number][], character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return ranges.some(([first, last]) => first <= codePoint && codePoint <= last);
}

describe('reading a TrueType font', () => {
  it('reads the units per em, the ascent and the descent of BIZ UDPGothic', () => {
    expect([SANS.unitsPerEm, SANS.ascender, SANS.descender]).toEqual([2048, 1802, -246]);
  });

  it('looks up a glyph for A and for 検', () => {
    expect([SANS.glyphIdOf(0x41), SANS.glyphIdOf(0x691c)].every((glyphId) => glyphId !== undefined && glyphId > 0))
      .toBe(true);
  });

  it('gives 検 twice the advance of A in the monospaced font', () => {
    const latin = MONO.advanceOf(MONO.glyphIdOf(0x41) ?? 0);
    const kanji = MONO.advanceOf(MONO.glyphIdOf(0x691c) ?? 0);

    expect([latin > 0, kanji]).toEqual([true, latin * 2]);
  });

  it('covers 検 and leaves out א and 😀', () => {
    const ranges = SANS.readCoverage();

    expect([covers(ranges, '検'), covers(ranges, 'א'), covers(ranges, '😀')]).toEqual([true, false, false]);
  });

  it('reads a character map of format 4', () => {
    expect(parseTrueTypeFont(buildCompositeFont()).glyphIdOf(0x41)).toBe(2);
  });
});

describe('making a subset of a TrueType font', () => {
  it('keeps glyph 0, the glyph asked for and the glyph it is made of, and empties the rest without renumbering', () => {
    const font = parseTrueTypeFont(buildCompositeFont());

    const subset = parseTrueTypeFont(font.subset([2]));

    expect([0, 1, 2, 3].map((glyphId) => [...subset.outlineOf(glyphId)])).toEqual([
      [],
      SIMPLE_OUTLINE,
      COMPOSITE_OUTLINE,
      [],
    ]);
  });

  it('keeps the outline of A and empties that of 検 in a subset of BIZ UDPGothic for A', () => {
    const latin = SANS.glyphIdOf(0x41) ?? 0;
    const kanji = SANS.glyphIdOf(0x691c) ?? 0;
    const outline = SANS.outlineOf(latin);

    const subset = parseTrueTypeFont(SANS.subset([latin]));

    // Outlines are padded with zeros to a four-byte boundary in the subset.
    expect([
      subset.glyphCount,
      [...subset.outlineOf(latin).subarray(0, outline.length)],
      subset.outlineOf(kanji).length,
    ]).toEqual([SANS.glyphCount, [...outline], 0]);
  });
});
