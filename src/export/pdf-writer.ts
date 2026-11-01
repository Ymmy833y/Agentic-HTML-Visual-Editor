import { CONTENT_WIDTH_PT, PAGE_HEIGHT_PT, PAGE_MARGIN_PT, PAGE_WIDTH_PT, PDF_FONT_ROLE } from '../../common/index';
import type { PdfFontRole, PdfTextRun } from '../../common/index';
import type { TrueTypeFont } from './true-type-font';

// TextEncoder is a global in both extension hosts, but this layer has no DOM types. The web extension host cannot
// resolve node:util, so only the shape in use is declared.
declare const TextEncoder: { new (): { encode(input: string): Uint8Array } };

// The fonts have one weight, so bold is drawn by stroking the outlines as well as filling them, about as much as a
// browser thickens them when a font lacks the bold weight. The ratio is the width of the stroke to the font size.
const BOLD_STROKE_RATIO = 1 / 30;

// The fonts have no italic, so italic is drawn by slanting the glyphs as Chrome does: a quarter of the height to the
// right.
const ITALIC_SKEW = 0.25;

// A PDF reader takes at most 100 entries in one block of a character map.
const CMAP_BLOCK_SIZE = 100;

// Each embedded font takes five objects: the font, its descendant, its descriptor, its file and its character map.
const OBJECTS_PER_FONT = 5;

/** A font the text of the PDF is set in. */
export interface PdfTextFont {
  /** The PostScript name of the font, without the tag of the subset. */
  readonly name: string;
  /** The font. */
  readonly font: TrueTypeFont;
}

/** Where a link annotation leads once the host has decided it. */
export type PdfLinkDestination =
  /** A URL opened as written into the PDF. */
  | { readonly kind: 'uri'; readonly uri: string }
  /** A page of the PDF and the height on that page in the pixels of its image. */
  | { readonly kind: 'page'; readonly pageIndex: number; readonly y: number };

/** A link annotation on one page, measured from the top-left corner of the page image in its pixels. */
export interface PdfLinkAnnotation {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly target: PdfLinkDestination;
}

/** One page drawn as a JPEG image without its text, with the text to draw over it. */
export interface JpegPage {
  /** The bytes of the JPEG file. */
  readonly jpeg: Uint8Array;
  /** Width of the image in pixels. */
  readonly width: number;
  /** Height of the image in pixels. */
  readonly height: number;
  /** The link annotations on the page, in the pixels of the image. */
  readonly links: readonly PdfLinkAnnotation[];
  /** The text drawn over the image, in document order, in the pixels of the image. */
  readonly text: readonly PdfTextRun[];
}

/** A font as it is embedded: where its objects are and which glyphs the text uses. */
interface EmbeddedFont {
  /** The name the drawing instructions call the font by. */
  readonly resource: string;
  /** The object number of the font; its other objects follow it. */
  readonly objectNumber: number;
  readonly font: PdfTextFont;
  /** The character each glyph the text uses stands for, for copying and searching. */
  readonly glyphs: ReadonlyMap<number, number>;
}

/**
 * Builds a PDF that puts each image on its own A4 page, with the text of the page over it.
 *
 * Each image fills the width inside the margins and starts at the top margin, so a page shorter than the area
 * leaves the rest blank. The images are embedded as they are, because a PDF reader decodes JPEG itself; this is what
 * keeps the writer free of any compression library. The text is set in subsets of the fonts that hold only the glyphs
 * it uses, with a character map that lets a reader copy and search it.
 *
 * @param pages The pages in order.
 * @param fonts The font of each role the text uses.
 * @returns The bytes of the PDF file.
 * @throws When the text uses a role without a font, or a character its font has no glyph for.
 */
export function writePdf(pages: readonly JpegPage[], fonts: ReadonlyMap<PdfFontRole, PdfTextFont>): Uint8Array {
  const writer = new PdfByteWriter();
  // The second line holds bytes above 127, which tells tools that move files as text that this one is binary.
  writer.writeText('%PDF-1.4\n');
  writer.writeBytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  // Objects 1 and 2 are the catalog and the page tree, and the fonts follow them. Each page then takes three: the page,
  // its image and its drawing instructions. The link annotations follow all the pages, so that the number of a page
  // depends on its position alone and a link can point at a page it comes before.
  const embedded = embedFonts(pages, fonts, 3);
  const firstPageNumber = 3 + embedded.size * OBJECTS_PER_FONT;
  const pageObjectNumber = (index: number): number => firstPageNumber + index * 3;
  writer.writeObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, index) => `${String(pageObjectNumber(index))} 0 R`).join(' ');
  writer.writeObject(2, `<< /Type /Pages /Kids [${kids}] /Count ${String(pages.length)} >>`);
  for (const font of embedded.values()) {
    writeFont(writer, font);
  }
  const fontResources = [...embedded.values()]
    .map((font) => `/${font.resource} ${String(font.objectNumber)} 0 R`)
    .join(' ');
  const fontDictionary = fontResources === '' ? '' : ` /Font << ${fontResources} >>`;

  const annotations: string[] = [];
  pages.forEach((page, index) => {
    const pageNumber = pageObjectNumber(index);
    const imageNumber = pageNumber + 1;
    const contentNumber = pageNumber + 2;
    const references: string[] = [];
    for (const link of page.links) {
      const annotation = describeLink(page, link, pages, pageObjectNumber);
      if (annotation !== undefined) {
        references.push(`${String(pageObjectNumber(pages.length) + annotations.length)} 0 R`);
        annotations.push(annotation);
      }
    }
    const annots = references.length === 0 ? '' : ` /Annots [${references.join(' ')}]`;
    writer.writeObject(
      pageNumber,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${formatNumber(PAGE_WIDTH_PT)} ${formatNumber(PAGE_HEIGHT_PT)}]`
        + ` /Resources << /XObject << /Im0 ${String(imageNumber)} 0 R >>${fontDictionary} >>`
        + ` /Contents ${String(contentNumber)} 0 R${annots} >>`,
    );
    writer.writeStream(
      imageNumber,
      `/Type /XObject /Subtype /Image /Width ${String(page.width)} /Height ${String(page.height)}`
        + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
      page.jpeg,
    );
    const placement = placeImage(page);
    writer.writeStream(
      contentNumber,
      '',
      encodeAscii(`q ${formatNumber(placement.width)} 0 0 ${formatNumber(placement.height)} `
        + `${formatNumber(placement.x)} ${formatNumber(placement.y)} cm /Im0 Do Q\n`
        + describeText(page, placement, embedded)),
    );
  });
  annotations.forEach((annotation, index) => {
    writer.writeObject(pageObjectNumber(pages.length) + index, annotation);
  });

  writer.writeTrailer(1);
  return writer.toBytes();
}

/**
 * Decides which fonts the PDF embeds and the glyphs of each, in the order of the roles.
 *
 * @param pages The pages in order.
 * @param fonts The font of each role.
 * @param firstObjectNumber The object number of the first font.
 * @returns The embedded fonts by role. A role the text does not use is left out.
 */
function embedFonts(
  pages: readonly JpegPage[],
  fonts: ReadonlyMap<PdfFontRole, PdfTextFont>,
  firstObjectNumber: number,
): Map<PdfFontRole, EmbeddedFont> {
  const used = new Map<PdfFontRole, Map<number, number>>();
  for (const page of pages) {
    for (const run of page.text) {
      const font = fonts.get(run.role);
      if (font === undefined) {
        throw new Error(`There is no font for the text of the role ${run.role}`);
      }
      const glyphs = used.get(run.role) ?? new Map<number, number>();
      used.set(run.role, glyphs);
      for (const character of run.text) {
        const codePoint = character.codePointAt(0) ?? 0;
        const glyphId = font.font.glyphIdOf(codePoint);
        if (glyphId === undefined) {
          throw new Error(`The font ${font.name} has no glyph for U+${codePoint.toString(16).toUpperCase()}`);
        }
        // A glyph that stands for several characters gives the first one, which is what copying it yields.
        if (!glyphs.has(glyphId)) {
          glyphs.set(glyphId, codePoint);
        }
      }
    }
  }

  const embedded = new Map<PdfFontRole, EmbeddedFont>();
  for (const role of Object.values(PDF_FONT_ROLE)) {
    const glyphs = used.get(role);
    const font = fonts.get(role);
    if (glyphs === undefined || font === undefined) {
      continue;
    }
    embedded.set(role, {
      resource: `F${String(embedded.size)}`,
      objectNumber: firstObjectNumber + embedded.size * OBJECTS_PER_FONT,
      font,
      glyphs,
    });
  }
  return embedded;
}

/**
 * Writes the objects of one embedded font: a composite font addressed by glyph id, with a subset of the font file.
 *
 * @param writer The writer.
 * @param embedded The font.
 */
function writeFont(writer: PdfByteWriter, embedded: EmbeddedFont): void {
  const { font, name } = embedded.font;
  const number = embedded.objectNumber;
  const glyphIds = [...embedded.glyphs.keys()].sort((left, right) => left - right);
  const toThousandths = (value: number): string => formatNumber((value * 1000) / font.unitsPerEm);
  const baseFont = `${subsetTag(glyphIds)}+${name}`;
  const widths = glyphIds.map((glyphId) => `${String(glyphId)} [${toThousandths(font.advanceOf(glyphId))}]`).join(' ');

  writer.writeObject(
    number,
    `<< /Type /Font /Subtype /Type0 /BaseFont /${baseFont} /Encoding /Identity-H`
      + ` /DescendantFonts [${String(number + 1)} 0 R] /ToUnicode ${String(number + 4)} 0 R >>`,
  );
  writer.writeObject(
    number + 1,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseFont}`
      + ' /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>'
      + ` /FontDescriptor ${String(number + 2)} 0 R /DW 1000 /W [${widths}] /CIDToGIDMap /Identity >>`,
  );
  writer.writeObject(
    number + 2,
    `<< /Type /FontDescriptor /FontName /${baseFont} /Flags 4`
      + ` /FontBBox [${font.boundingBox.map(toThousandths).join(' ')}] /ItalicAngle 0`
      + ` /Ascent ${toThousandths(font.ascender)} /Descent ${toThousandths(font.descender)}`
      + ` /CapHeight ${toThousandths(font.ascender)} /StemV 80 /FontFile2 ${String(number + 3)} 0 R >>`,
  );
  const file = font.subset(glyphIds);
  writer.writeStream(number + 3, `/Length1 ${String(file.length)}`, file);
  writer.writeStream(number + 4, '', encodeAscii(describeCharacterMap(embedded.glyphs)));
}

/**
 * Describes the character map that tells a reader which character each glyph id stands for.
 *
 * @param glyphs The character of each glyph id.
 */
function describeCharacterMap(glyphs: ReadonlyMap<number, number>): string {
  const entries = [...glyphs].sort(([left], [right]) => left - right);
  const blocks: string[] = [];
  for (let start = 0; start < entries.length; start += CMAP_BLOCK_SIZE) {
    const block = entries.slice(start, start + CMAP_BLOCK_SIZE);
    blocks.push(
      `${String(block.length)} beginbfchar\n`
        + block.map(([glyphId, codePoint]) => `<${toHex4(glyphId)}> <${toUtf16Hex(codePoint)}>`).join('\n')
        + '\nendbfchar\n',
    );
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    `${blocks.join('')}endcmap`,
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
    '',
  ].join('\n');
}

/**
 * Describes the drawing instructions of the text of a page, clipped to the area of its image.
 *
 * Each character is put where the view laid it out: the pen moves by the advance of the glyph, and any difference
 * from where the next character lies is made up before it is drawn.
 *
 * @param page The page.
 * @param placement Where the image of the page is drawn.
 * @param fonts The embedded fonts by role.
 * @returns The instructions, or an empty string for a page without text.
 */
function describeText(page: JpegPage, placement: ImagePlacement, fonts: ReadonlyMap<PdfFontRole, EmbeddedFont>): string {
  if (page.text.length === 0) {
    return '';
  }
  const ratio = pointsPerPixel(page);
  const lines: string[] = [
    'q',
    // A line of a block taller than a page is drawn on both pages it spans, each showing the part on its image.
    `${formatNumber(placement.x)} ${formatNumber(placement.y)} ${formatNumber(placement.width)}`
      + ` ${formatNumber(placement.height)} re W n`,
    'BT',
  ];
  for (const run of page.text) {
    const embedded = fonts.get(run.role);
    if (embedded === undefined) {
      continue;
    }
    const { font } = embedded.font;
    const size = run.size * ratio;
    const baseline = run.top + (run.size * font.ascender) / font.unitsPerEm;
    const color = run.color.map((channel) => formatNumber(channel / 255)).join(' ');
    lines.push(`/${embedded.resource} ${formatNumber(size)} Tf ${color} rg`);
    lines.push(run.bold ? `2 Tr ${formatNumber(size * BOLD_STROKE_RATIO)} w ${color} RG` : '0 Tr');
    const left = PAGE_MARGIN_PT + (run.xs[0] ?? 0) * ratio;
    const top = PAGE_HEIGHT_PT - PAGE_MARGIN_PT - baseline * ratio;
    lines.push(`1 0 ${run.italic ? String(ITALIC_SKEW) : '0'} 1 ${formatNumber(left)} ${formatNumber(top)} Tm`);
    lines.push(`${describeGlyphs(run, font, size, ratio)} TJ`);
  }
  lines.push('ET', 'Q', '');
  return lines.join('\n');
}

/**
 * Describes the glyphs of a run as the array of a TJ instruction.
 *
 * @param run The run.
 * @param font Its font.
 * @param size The font size in points.
 * @param ratio Points per pixel of the page image.
 */
function describeGlyphs(run: PdfTextRun, font: TrueTypeFont, size: number, ratio: number): string {
  const parts: string[] = [];
  let glyphs = '';
  let expected: number | undefined;
  [...run.text].forEach((character, index) => {
    const glyphId = font.glyphIdOf(character.codePointAt(0) ?? 0) ?? 0;
    const x = (run.xs[index] ?? 0) * ratio;
    if (expected !== undefined) {
      // A number in the array moves the pen left by thousandths of the font size.
      const adjustment = ((expected - x) * 1000) / size;
      if (Math.abs(adjustment) >= 0.01) {
        parts.push(`<${glyphs}>`, formatNumber(adjustment));
        glyphs = '';
      }
    }
    glyphs += toHex4(glyphId);
    expected = x + (font.advanceOf(glyphId) / font.unitsPerEm) * size;
  });
  parts.push(`<${glyphs}>`);
  return `[${parts.join(' ')}]`;
}

/**
 * Names a subset with six capital letters that follow from its glyphs, as a PDF reader expects of a subset font.
 *
 * @param glyphIds The glyphs of the subset.
 */
function subsetTag(glyphIds: readonly number[]): string {
  // FNV-1a keeps the tag the same for the same glyphs and tells different subsets apart.
  let hash = 0x811c9dc5;
  for (const glyphId of glyphIds) {
    hash = Math.imul(hash ^ glyphId, 0x01000193) >>> 0;
  }
  let tag = '';
  for (let index = 0; index < 6; index += 1) {
    tag += String.fromCharCode(65 + (hash % 26));
    hash = Math.floor(hash / 26);
  }
  return tag;
}

/**
 * Writes a number as four hexadecimal digits.
 *
 * @param value The number, from 0 to 65535.
 */
function toHex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Writes a character as the hexadecimal digits of its UTF-16 code units.
 *
 * @param codePoint The code point.
 */
function toUtf16Hex(codePoint: number): string {
  const text = String.fromCodePoint(codePoint);
  let hex = '';
  for (let index = 0; index < text.length; index += 1) {
    hex += toHex4(text.charCodeAt(index));
  }
  return hex;
}

/** Where an image is drawn on its page, in PDF points from the bottom-left corner. */
export interface ImagePlacement {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Places an image at the top margin, scaled to the width inside the margins.
 *
 * @param page The page image.
 * @returns The placement.
 */
export function placeImage(page: Pick<JpegPage, 'width' | 'height'>): ImagePlacement {
  const height = CONTENT_WIDTH_PT * (page.height / page.width);
  return {
    x: PAGE_MARGIN_PT,
    y: PAGE_HEIGHT_PT - PAGE_MARGIN_PT - height,
    width: CONTENT_WIDTH_PT,
    height,
  };
}

/**
 * Describes a link of a page as a link annotation without a border.
 *
 * @param page The page the link is on.
 * @param link The link.
 * @param pages All the pages, for a link to another page.
 * @param pageObjectNumber Returns the object number of a page from its position.
 * @returns The annotation dictionary, or `undefined` when the page it leads to does not exist.
 */
function describeLink(
  page: JpegPage,
  link: PdfLinkAnnotation,
  pages: readonly JpegPage[],
  pageObjectNumber: (index: number) => number,
): string | undefined {
  let action: string;
  if (link.target.kind === 'uri') {
    action = `/A << /S /URI /URI (${encodeUriString(link.target.uri)}) >>`;
  } else {
    const destination = pages.at(link.target.pageIndex);
    if (link.target.pageIndex < 0 || destination === undefined) {
      return undefined;
    }
    const top = PAGE_HEIGHT_PT - PAGE_MARGIN_PT - link.target.y * pointsPerPixel(destination);
    action = `/Dest [${String(pageObjectNumber(link.target.pageIndex))} 0 R /XYZ 0 ${formatNumber(top)} null]`;
  }
  const ratio = pointsPerPixel(page);
  const left = PAGE_MARGIN_PT + link.x * ratio;
  const top = PAGE_HEIGHT_PT - PAGE_MARGIN_PT - link.y * ratio;
  const rect = [left, top - link.height * ratio, left + link.width * ratio, top].map(formatNumber).join(' ');
  return `<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0] ${action} >>`;
}

/**
 * Returns how many PDF points one pixel of a page image takes, once the image fills the width inside the margins.
 *
 * @param page The page image.
 */
function pointsPerPixel(page: Pick<JpegPage, 'width'>): number {
  return CONTENT_WIDTH_PT / page.width;
}

/**
 * Writes a URL as the body of a PDF string.
 *
 * A URL in a PDF is ASCII, so spaces, control characters and characters beyond ASCII are percent-encoded as UTF-8,
 * as a browser does when it follows the link. The backslash and the parentheses, which end or escape a PDF string,
 * are escaped.
 *
 * @param uri The URL as written.
 */
function encodeUriString(uri: string): string {
  let encoded = '';
  for (const character of uri) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code >= 0x7f) {
      encoded += [...new TextEncoder().encode(character)]
        .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
        .join('');
    } else if (character === '\\' || character === '(' || character === ')') {
      encoded += `\\${character}`;
    } else {
      encoded += character;
    }
  }
  return encoded;
}

/** Collects the bytes of a PDF and remembers where each object starts, for the cross-reference table. */
class PdfByteWriter {
  private readonly chunks: Uint8Array[] = [];

  private length = 0;

  private readonly offsets = new Map<number, number>();

  writeText(text: string): void {
    this.writeBytes(encodeAscii(text));
  }

  writeBytes(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  writeObject(objectNumber: number, body: string): void {
    this.offsets.set(objectNumber, this.length);
    this.writeText(`${String(objectNumber)} 0 obj\n${body}\nendobj\n`);
  }

  writeStream(objectNumber: number, dictionary: string, data: Uint8Array): void {
    this.offsets.set(objectNumber, this.length);
    const entries = dictionary === '' ? '' : `${dictionary} `;
    this.writeText(`${String(objectNumber)} 0 obj\n<< ${entries}/Length ${String(data.length)} >>\nstream\n`);
    this.writeBytes(data);
    this.writeText('\nendstream\nendobj\n');
  }

  writeTrailer(rootNumber: number): void {
    const count = this.offsets.size + 1;
    const start = this.length;
    // Every entry is exactly 20 bytes, as the format requires, which is why the line ends with a space and a newline.
    let table = `xref\n0 ${String(count)}\n0000000000 65535 f \n`;
    for (let objectNumber = 1; objectNumber < count; objectNumber += 1) {
      table += `${String(this.offsets.get(objectNumber) ?? 0).padStart(10, '0')} 00000 n \n`;
    }
    this.writeText(table);
    this.writeText(`trailer\n<< /Size ${String(count)} /Root ${String(rootNumber)} 0 R >>\nstartxref\n${String(start)}\n%%EOF\n`);
  }

  toBytes(): Uint8Array {
    const bytes = new Uint8Array(this.length);
    let position = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, position);
      position += chunk.length;
    }
    return bytes;
  }
}

/**
 * Encodes text that has only ASCII characters, one byte each.
 *
 * @param text The text.
 */
function encodeAscii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index);
  }
  return bytes;
}

/**
 * Writes a number with at most two decimals, the precision PDF readers expect for coordinates.
 *
 * @param value The number.
 */
function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}
