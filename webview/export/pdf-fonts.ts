import { PDF_FONT_ROLE } from '../../common/index';
import type { PdfExportFont, PdfFontRole } from '../../common/index';

/**
 * The family names the copy gives the bundled fonts. They name no font the view or the system has, so the copy lays
 * text out in a bundled font only where it asks for one.
 */
export const PDF_FONT_FAMILIES: Readonly<Record<PdfFontRole, string>> = {
  [PDF_FONT_ROLE.sans]: 'AHVE PDF Sans',
  [PDF_FONT_ROLE.mono]: 'AHVE PDF Mono',
};

/** The bundled fonts as the view uses them. */
export interface PdfFonts {
  /** The bytes of the font file of each role. */
  readonly files: ReadonlyMap<PdfFontRole, ArrayBuffer>;

  /**
   * Returns whether the font of a role has a glyph for a character.
   *
   * @param role The role.
   * @param codePoint The code point of the character.
   */
  covers(role: PdfFontRole, codePoint: number): boolean;
}

/**
 * Reads the bundled fonts the request carries.
 *
 * @param fonts The fonts of the request, as received.
 * @returns The fonts.
 * @throws When a role has no font, or a font is not base64 or has malformed ranges; the text could not be set then.
 */
export function readPdfFonts(fonts: unknown): PdfFonts {
  if (!Array.isArray(fonts)) {
    throw new Error('The request carries no fonts');
  }
  const items: readonly unknown[] = fonts;
  const files = new Map<PdfFontRole, ArrayBuffer>();
  const ranges = new Map<PdfFontRole, readonly (readonly [number, number])[]>();
  for (const role of Object.values(PDF_FONT_ROLE)) {
    const font = items.find((item): item is PdfExportFont => isFont(item) && item.role === role);
    if (font === undefined) {
      throw new Error(`The request carries no font for the role ${role}`);
    }
    files.set(role, decodeBase64(font.data));
    ranges.set(role, font.ranges);
  }
  return {
    files,
    covers: (role, codePoint) => isInRanges(ranges.get(role) ?? [], codePoint),
  };
}

/**
 * Adds the bundled fonts to a document and waits until they are ready to lay text out and draw it with.
 *
 * The frame of the copy cannot load a font from a URL, so each font is built from its bytes, in the window of the
 * document because a font belongs to the document it is added to.
 *
 * @param document The copied document, or the document of the view that the canvas is drawn in.
 * @param fonts The bundled fonts.
 * @returns The fonts added, for {@link unloadPdfFonts}.
 * @throws When a font cannot be built from its bytes.
 */
export async function loadPdfFonts(document: Document, fonts: PdfFonts): Promise<FontFace[]> {
  const view = document.defaultView;
  if (view === null) {
    throw new Error('The document has no window to load the fonts in');
  }
  const faces = [...fonts.files].map(([role, data]) => new view.FontFace(PDF_FONT_FAMILIES[role], data));
  for (const face of faces) {
    document.fonts.add(face);
  }
  try {
    await Promise.all(faces.map((face) => face.load()));
  } catch (error) {
    unloadPdfFonts(document, faces);
    throw error;
  }
  return faces;
}

/**
 * Takes the bundled fonts out of a document again.
 *
 * @param document The document.
 * @param faces The fonts {@link loadPdfFonts} added to it.
 */
export function unloadPdfFonts(document: Document, faces: readonly FontFace[]): void {
  for (const face of faces) {
    document.fonts.delete(face);
  }
}

/**
 * Returns whether a value is a font as the request describes it.
 *
 * @param value The value.
 */
function isFont(value: unknown): value is PdfExportFont {
  if (!isRecord(value)) {
    return false;
  }
  const ranges = value.ranges;
  return typeof value.data === 'string' && Array.isArray(ranges) && ranges.every((range: unknown) => (
    Array.isArray(range) && range.length === 2 && Number.isInteger(range[0]) && Number.isInteger(range[1])
  ));
}

/**
 * Returns whether a value is an object whose fields can be read.
 *
 * @param value The value.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Returns whether sorted ranges hold a code point, by binary search.
 *
 * @param ranges The ranges in ascending order.
 * @param codePoint The code point.
 */
function isInRanges(ranges: readonly (readonly [number, number])[], codePoint: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const [first, last] = ranges[middle];
    if (codePoint < first) {
      high = middle - 1;
    } else if (codePoint > last) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

/**
 * Decodes base64 into bytes.
 *
 * @param text The base64 text.
 * @throws When the text is not base64.
 */
function decodeBase64(text: string): ArrayBuffer {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
