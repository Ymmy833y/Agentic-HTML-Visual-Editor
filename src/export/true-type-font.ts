// Reads the parts of a TrueType font that embedding it in a PDF needs: the glyph of each character, the advance of each
// glyph, the metrics of the font and the outlines. Only fonts with TrueType outlines (a glyf table) are read.

/** A TrueType font, read from its file. */
export interface TrueTypeFont {
  /** Font units per em. */
  readonly unitsPerEm: number;
  /** The ascent above the baseline in font units, as the horizontal header gives it. */
  readonly ascender: number;
  /** The descent below the baseline in font units, a negative number, as the horizontal header gives it. */
  readonly descender: number;
  /** The box that holds every glyph, in font units: left, bottom, right and top. */
  readonly boundingBox: readonly [number, number, number, number];
  /** How many glyphs the font has. */
  readonly glyphCount: number;

  /**
   * Returns the glyph a character is drawn with.
   *
   * @param codePoint The code point of the character.
   * @returns The glyph id, or `undefined` when the font has no glyph for it.
   */
  glyphIdOf(codePoint: number): number | undefined;

  /**
   * Returns how far a glyph moves the pen.
   *
   * @param glyphId The glyph id.
   * @returns The advance in font units.
   */
  advanceOf(glyphId: number): number;

  /**
   * Returns the outline of a glyph as the glyph table holds it.
   *
   * @param glyphId The glyph id.
   * @returns The bytes of the outline, empty for a glyph without one.
   */
  outlineOf(glyphId: number): Uint8Array;

  /**
   * Returns the characters the font has a glyph for.
   *
   * @returns Ranges of first and last code point, in ascending order and never touching each other.
   */
  readCoverage(): [number, number][];

  /**
   * Makes a font file that keeps the outlines of the given glyphs only.
   *
   * The glyph ids stay the same, so text can address the subset with the ids of the whole font. The parts of a
   * composite glyph are kept with it, and so is glyph 0, which a font must have.
   *
   * @param glyphIds The glyphs to keep.
   * @returns The bytes of the subset.
   */
  subset(glyphIds: Iterable<number>): Uint8Array;
}

/** A table of the font file. */
interface TableRecord {
  readonly offset: number;
  readonly length: number;
}

// The tables a TrueType font program embedded in a PDF needs, and the hinting tables that keep its glyphs as the font
// draws them. The rest, such as the character map, the names and the layout features, is left out of a subset.
const SUBSET_TABLE_TAGS = ['cvt ', 'fpgm', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'prep'] as const;

// The flags of a component of a composite glyph that decide how many bytes follow its glyph id.
const ARG_1_AND_2_ARE_WORDS = 0x0001;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;

// The sum the checksum of a whole font file must reach once the head table records its adjustment.
const CHECKSUM_MAGIC = 0xb1b0afba;

/**
 * Reads a TrueType font file.
 *
 * @param bytes The bytes of the file.
 * @returns The font.
 * @throws When the file is not a TrueType font with the tables this reader needs.
 */
export function parseTrueTypeFont(bytes: Uint8Array): TrueTypeFont {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = readTableDirectory(view);
  const table = (tag: string): TableRecord => {
    const record = tables.get(tag);
    if (record === undefined || record.offset + record.length > bytes.byteLength) {
      throw new Error(`The font has no ${tag.trim()} table`);
    }
    return record;
  };

  const head = table('head');
  const unitsPerEm = view.getUint16(head.offset + 18);
  const boundingBox: [number, number, number, number] = [
    view.getInt16(head.offset + 36),
    view.getInt16(head.offset + 38),
    view.getInt16(head.offset + 40),
    view.getInt16(head.offset + 42),
  ];
  const longOffsets = view.getInt16(head.offset + 50) === 1;

  const hhea = table('hhea');
  const ascender = view.getInt16(hhea.offset + 4);
  const descender = view.getInt16(hhea.offset + 6);
  const metricCount = view.getUint16(hhea.offset + 34);

  const glyphCount = view.getUint16(table('maxp').offset + 4);
  const hmtx = table('hmtx');
  const loca = table('loca');
  const glyf = table('glyf');
  // A subset this module wrote has no character map, and maps no character.
  const cmap = tables.get('cmap');
  const characters = cmap === undefined ? new Map<number, number>() : readCharacterMap(view, cmap, glyphCount);

  const glyphRange = (glyphId: number): [number, number] => {
    const start = longOffsets ? view.getUint32(loca.offset + glyphId * 4) : view.getUint16(loca.offset + glyphId * 2) * 2;
    const end = longOffsets
      ? view.getUint32(loca.offset + (glyphId + 1) * 4)
      : view.getUint16(loca.offset + (glyphId + 1) * 2) * 2;
    return [glyf.offset + start, glyf.offset + end];
  };

  return {
    unitsPerEm,
    ascender,
    descender,
    boundingBox,
    glyphCount,
    glyphIdOf: (codePoint) => characters.get(codePoint),
    advanceOf: (glyphId) => {
      // Glyphs past the last metric share its advance, which is how monospaced fonts keep the table short.
      const index = Math.min(glyphId, metricCount - 1);
      return view.getUint16(hmtx.offset + index * 4);
    },
    outlineOf: (glyphId) => bytes.subarray(...glyphRange(glyphId)),
    readCoverage: () => toRanges([...characters.keys()].sort((left, right) => left - right)),
    subset: (glyphIds) => buildSubset(bytes, view, tables, glyphCount, glyphRange, glyphIds),
  };
}

/**
 * Reads where each table of the font file lies.
 *
 * @param view The bytes of the file.
 */
function readTableDirectory(view: DataView): Map<string, TableRecord> {
  if (view.byteLength < 12 || view.getUint32(0) !== 0x00010000) {
    throw new Error('The file is not a TrueType font');
  }
  const count = view.getUint16(4);
  const tables = new Map<string, TableRecord>();
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    const tag = String.fromCharCode(
      view.getUint8(record),
      view.getUint8(record + 1),
      view.getUint8(record + 2),
      view.getUint8(record + 3),
    );
    tables.set(tag, { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) });
  }
  return tables;
}

/**
 * Reads the Unicode character map: segment format 12 when the font has one, as it covers every plane, and else
 * format 4, which covers the basic plane.
 *
 * @param view The bytes of the file.
 * @param cmap Where the character map table lies.
 * @param glyphCount How many glyphs the font has; a mapping to any other glyph is ignored.
 * @returns The glyph id of each code point that has a glyph other than glyph 0. Without a Unicode map, none.
 */
function readCharacterMap(view: DataView, cmap: TableRecord, glyphCount: number): Map<number, number> {
  const count = view.getUint16(cmap.offset + 2);
  let format4: number | undefined;
  let format12: number | undefined;
  for (let index = 0; index < count; index += 1) {
    const record = cmap.offset + 4 + index * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const offset = cmap.offset + view.getUint32(record + 4);
    // Platform 0 is Unicode itself; platform 3 with encoding 1 or 10 is Unicode on Windows.
    const isUnicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!isUnicode) {
      continue;
    }
    const format = view.getUint16(offset);
    if (format === 12) {
      format12 ??= offset;
    } else if (format === 4) {
      format4 ??= offset;
    }
  }

  const characters = new Map<number, number>();
  const add = (codePoint: number, glyphId: number): void => {
    if (glyphId > 0 && glyphId < glyphCount) {
      characters.set(codePoint, glyphId);
    }
  };
  if (format12 !== undefined) {
    const groups = view.getUint32(format12 + 12);
    for (let group = 0; group < groups; group += 1) {
      const record = format12 + 16 + group * 12;
      const first = view.getUint32(record);
      const last = view.getUint32(record + 4);
      const glyph = view.getUint32(record + 8);
      for (let codePoint = first; codePoint <= last; codePoint += 1) {
        add(codePoint, glyph + codePoint - first);
      }
    }
    return characters;
  }
  if (format4 === undefined) {
    return characters;
  }
  const segments = view.getUint16(format4 + 6) / 2;
  const ends = format4 + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  for (let segment = 0; segment < segments; segment += 1) {
    const first = view.getUint16(starts + segment * 2);
    const last = view.getUint16(ends + segment * 2);
    const delta = view.getInt16(deltas + segment * 2);
    const rangeOffset = view.getUint16(rangeOffsets + segment * 2);
    for (let codePoint = first; codePoint <= last && codePoint !== 0xffff; codePoint += 1) {
      if (rangeOffset === 0) {
        add(codePoint, (codePoint + delta) & 0xffff);
        continue;
      }
      // The offset counts from its own place in the table to the glyph index of the first code point.
      const at = rangeOffsets + segment * 2 + rangeOffset + (codePoint - first) * 2;
      const glyph = view.getUint16(at);
      if (glyph !== 0) {
        add(codePoint, (glyph + delta) & 0xffff);
      }
    }
  }
  return characters;
}

/**
 * Joins sorted code points into ranges.
 *
 * @param codePoints The code points in ascending order, without repeats.
 */
function toRanges(codePoints: readonly number[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const codePoint of codePoints) {
    const last = ranges.at(-1);
    if (last !== undefined && last[1] + 1 === codePoint) {
      last[1] = codePoint;
    } else {
      ranges.push([codePoint, codePoint]);
    }
  }
  return ranges;
}

/**
 * Builds a font file whose glyph table holds the outlines of the kept glyphs only.
 *
 * Every other glyph stays in place with no outline, so the glyph ids, the metrics and the hinting tables are those of
 * the whole font.
 *
 * @param bytes The bytes of the whole font.
 * @param view The same bytes.
 * @param tables Where each table of the whole font lies.
 * @param glyphCount How many glyphs the font has.
 * @param glyphRange Returns where the outline of a glyph lies in the file.
 * @param glyphIds The glyphs to keep.
 */
function buildSubset(
  bytes: Uint8Array,
  view: DataView,
  tables: ReadonlyMap<string, TableRecord>,
  glyphCount: number,
  glyphRange: (glyphId: number) => [number, number],
  glyphIds: Iterable<number>,
): Uint8Array {
  const kept = new Set<number>();
  const pending = [0, ...glyphIds];
  while (pending.length > 0) {
    const glyphId = pending.pop() ?? 0;
    if (kept.has(glyphId) || !Number.isInteger(glyphId) || glyphId < 0 || glyphId >= glyphCount) {
      continue;
    }
    kept.add(glyphId);
    pending.push(...readComponents(view, glyphRange(glyphId)));
  }

  // Outlines start on four-byte boundaries, so the offsets are written in the long form.
  const loca = new DataView(new ArrayBuffer((glyphCount + 1) * 4));
  const outlines: Uint8Array[] = [];
  let size = 0;
  for (let glyphId = 0; glyphId < glyphCount; glyphId += 1) {
    loca.setUint32(glyphId * 4, size);
    if (kept.has(glyphId)) {
      const [start, end] = glyphRange(glyphId);
      const outline = bytes.subarray(start, end);
      outlines.push(outline);
      size += padLength(outline.length);
    }
  }
  loca.setUint32(glyphCount * 4, size);
  const glyf = new Uint8Array(size);
  let position = 0;
  for (const outline of outlines) {
    glyf.set(outline, position);
    position += padLength(outline.length);
  }

  const head = bytes.slice(...span(tables, 'head'));
  const headView = new DataView(head.buffer);
  // The adjustment is cleared before the file is summed, and the long form of the offsets is recorded.
  headView.setUint32(8, 0);
  headView.setInt16(50, 1);

  const contents = new Map<string, Uint8Array>();
  for (const tag of SUBSET_TABLE_TAGS) {
    if (tag === 'glyf') {
      contents.set(tag, glyf);
    } else if (tag === 'loca') {
      contents.set(tag, new Uint8Array(loca.buffer));
    } else if (tag === 'head') {
      contents.set(tag, head);
    } else if (tables.has(tag)) {
      contents.set(tag, bytes.slice(...span(tables, tag)));
    }
  }

  const file = writeFontFile(contents);
  const headOffset = new DataView(file.buffer).getUint32(tableRecordOffset(file, 'head') + 8);
  new DataView(file.buffer).setUint32(headOffset + 8, (CHECKSUM_MAGIC - checksum(file)) >>> 0);
  return file;
}

/**
 * Reads the glyphs a composite glyph is made of.
 *
 * @param view The bytes of the font.
 * @param range Where the outline of the glyph lies.
 * @returns The glyph ids of its parts, or none for a simple or empty glyph.
 */
function readComponents(view: DataView, [start, end]: [number, number]): number[] {
  if (end - start < 10 || view.getInt16(start) >= 0) {
    return [];
  }
  const parts: number[] = [];
  let position = start + 10;
  let flags: number;
  do {
    flags = view.getUint16(position);
    parts.push(view.getUint16(position + 2));
    position += 4 + ((flags & ARG_1_AND_2_ARE_WORDS) !== 0 ? 4 : 2);
    if ((flags & WE_HAVE_A_SCALE) !== 0) {
      position += 2;
    } else if ((flags & WE_HAVE_AN_X_AND_Y_SCALE) !== 0) {
      position += 4;
    } else if ((flags & WE_HAVE_A_TWO_BY_TWO) !== 0) {
      position += 8;
    }
  } while ((flags & MORE_COMPONENTS) !== 0 && position + 4 <= end);
  return parts;
}

/**
 * Lays tables out as a font file, with the directory sorted by tag and every table on a four-byte boundary.
 *
 * @param contents The bytes of each table by tag.
 */
function writeFontFile(contents: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const tags = [...contents.keys()].sort();
  const directorySize = 12 + tags.length * 16;
  let size = directorySize;
  for (const tag of tags) {
    size += padLength(contents.get(tag)?.length ?? 0);
  }
  const file = new Uint8Array(size);
  const view = new DataView(file.buffer);
  // The search fields let a reader find a table by binary search over the sorted directory.
  const power = 2 ** Math.floor(Math.log2(tags.length));
  view.setUint32(0, 0x00010000);
  view.setUint16(4, tags.length);
  view.setUint16(6, power * 16);
  view.setUint16(8, Math.log2(power));
  view.setUint16(10, tags.length * 16 - power * 16);

  let offset = directorySize;
  tags.forEach((tag, index) => {
    const data = contents.get(tag) ?? new Uint8Array();
    file.set(data, offset);
    const record = 12 + index * 16;
    for (let character = 0; character < 4; character += 1) {
      view.setUint8(record + character, tag.charCodeAt(character));
    }
    view.setUint32(record + 4, checksum(file.subarray(offset, offset + padLength(data.length))));
    view.setUint32(record + 8, offset);
    view.setUint32(record + 12, data.length);
    offset += padLength(data.length);
  });
  return file;
}

/**
 * Returns the start and the end of a table in the file.
 *
 * @param tables Where each table lies.
 * @param tag The tag of the table.
 */
function span(tables: ReadonlyMap<string, TableRecord>, tag: string): [number, number] {
  const record = tables.get(tag);
  if (record === undefined) {
    throw new Error(`The font has no ${tag.trim()} table`);
  }
  return [record.offset, record.offset + record.length];
}

/**
 * Returns where the directory record of a table starts in a file this module wrote.
 *
 * @param file The bytes of the file.
 * @param tag The tag of the table.
 */
function tableRecordOffset(file: Uint8Array, tag: string): number {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const count = view.getUint16(4);
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    if (String.fromCharCode(...file.subarray(record, record + 4)) === tag) {
      return record;
    }
  }
  throw new Error(`The font has no ${tag.trim()} table`);
}

/**
 * Sums bytes as big-endian 32-bit words, as a font file's checksums do.
 *
 * @param data The bytes, a multiple of four long or padded with zeros as if they were.
 */
function checksum(data: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < data.length; index += 4) {
    const word = ((data[index] ?? 0) << 24) | ((data[index + 1] ?? 0) << 16) | ((data[index + 2] ?? 0) << 8)
      | (data[index + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

/**
 * Rounds a length up to a multiple of four.
 *
 * @param length The length in bytes.
 */
function padLength(length: number): number {
  return Math.ceil(length / 4) * 4;
}
