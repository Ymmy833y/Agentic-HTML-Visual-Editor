import { CONTENT_WIDTH_PT, PAGE_HEIGHT_PT, PAGE_MARGIN_PT, PAGE_WIDTH_PT } from '../../common/index';

// TextEncoder is a global in both extension hosts, but this layer has no DOM types. The web extension host cannot
// resolve node:util, so only the shape in use is declared.
declare const TextEncoder: { new (): { encode(input: string): Uint8Array } };

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

/** One page drawn as a JPEG image. */
export interface JpegPage {
  /** The bytes of the JPEG file. */
  readonly jpeg: Uint8Array;
  /** Width of the image in pixels. */
  readonly width: number;
  /** Height of the image in pixels. */
  readonly height: number;
  /** The link annotations on the page, in the pixels of the image. */
  readonly links: readonly PdfLinkAnnotation[];
}

/**
 * Builds a PDF that puts each image on its own A4 page.
 *
 * Each image fills the width inside the margins and starts at the top margin, so a page shorter than the area
 * leaves the rest blank. The images are embedded as they are, because a PDF reader decodes JPEG itself; this is what
 * keeps the writer free of any compression library.
 *
 * @param pages The pages in order.
 * @returns The bytes of the PDF file.
 */
export function writePdf(pages: readonly JpegPage[]): Uint8Array {
  const writer = new PdfByteWriter();
  // The second line holds bytes above 127, which tells tools that move files as text that this one is binary.
  writer.writeText('%PDF-1.4\n');
  writer.writeBytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  // Objects 1 and 2 are the catalog and the page tree; each page then takes three: the page, its image and its
  // drawing instructions. The link annotations follow all the pages, so that the number of a page depends on its
  // position alone and a link can point at a page it comes before.
  const pageObjectNumber = (index: number): number => 3 + index * 3;
  writer.writeObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, index) => `${String(pageObjectNumber(index))} 0 R`).join(' ');
  writer.writeObject(2, `<< /Type /Pages /Kids [${kids}] /Count ${String(pages.length)} >>`);

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
        + ` /Resources << /XObject << /Im0 ${String(imageNumber)} 0 R >> >> /Contents ${String(contentNumber)} 0 R${annots} >>`,
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
        + `${formatNumber(placement.x)} ${formatNumber(placement.y)} cm /Im0 Do Q\n`),
    );
  });
  annotations.forEach((annotation, index) => {
    writer.writeObject(pageObjectNumber(pages.length) + index, annotation);
  });

  writer.writeTrailer(1);
  return writer.toBytes();
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
