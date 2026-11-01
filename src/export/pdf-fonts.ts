// Referenced here so that every project that compiles this file also sees the declaration of the imports.
/// <reference path="./font-file.d.ts" />
import monoFontPath from '@expo-google-fonts/biz-udgothic/400Regular/BIZUDGothic_400Regular.ttf';
import sansFontPath from '@expo-google-fonts/biz-udpgothic/400Regular/BIZUDPGothic_400Regular.ttf';

import { PDF_FONT_ROLE } from '../../common/index';
import type { PdfExportFont, PdfFontRole } from '../../common/index';
import type { PdfTextFont } from './pdf-writer';
import { parseTrueTypeFont } from './true-type-font';

// btoa is global in both extension hosts, but this layer has no DOM types. Declare only the part used here, because
// Buffer does not exist in the web extension host.
declare function btoa(data: string): string;

// How many bytes are turned into characters at once when encoding a font. Spreading a whole font into one call would
// exceed the limit on the number of arguments.
const ENCODE_CHUNK_SIZE = 0x8000;

/** A font file the extension bundles for the PDF export. */
interface BundledFontFile {
  readonly role: PdfFontRole;
  /** The PostScript name of the font. */
  readonly name: string;
  /** The path of the file relative to the folder of the extension bundle. */
  readonly path: string;
}

/**
 * The fonts the text of the PDF is set in: BIZ UDPGothic for the body text and BIZ UDGothic, its monospaced
 * counterpart, for code. Both have the same design and cover Japanese and Latin text, so code and prose look alike.
 */
export const BUNDLED_PDF_FONT_FILES: readonly BundledFontFile[] = [
  { role: PDF_FONT_ROLE.sans, name: 'BIZUDPGothic', path: sansFontPath },
  { role: PDF_FONT_ROLE.mono, name: 'BIZUDGothic', path: monoFontPath },
];

/** The bundled fonts, read once: as the request carries them, and as the PDF embeds them. */
export interface BundledPdfFonts {
  /** The fonts the view lays the copy out with. */
  readonly request: readonly PdfExportFont[];
  /** The fonts the PDF embeds, by role. */
  readonly embedding: ReadonlyMap<PdfFontRole, PdfTextFont>;
}

/**
 * Reads a file of the extension.
 *
 * @param path The path relative to the folder of the extension bundle.
 * @returns The bytes of the file.
 */
export type ExtensionFileReader = (path: string) => PromiseLike<Uint8Array>;

/**
 * Creates the loader of the bundled fonts.
 *
 * The files are read and parsed on the first export, and every later export gets the same fonts. A failed load is not
 * kept, so the next export tries again.
 *
 * @param readFile Reads a file of the extension.
 * @returns The loader. It rejects when a file cannot be read or is not a font this export can embed.
 */
export function createPdfFontLoader(readFile: ExtensionFileReader): () => Promise<BundledPdfFonts> {
  let loading: Promise<BundledPdfFonts> | undefined;
  return () => {
    loading ??= loadFonts(readFile).catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
    return loading;
  };
}

/**
 * Reads and parses every bundled font.
 *
 * @param readFile Reads a file of the extension.
 */
async function loadFonts(readFile: ExtensionFileReader): Promise<BundledPdfFonts> {
  const request: PdfExportFont[] = [];
  const embedding = new Map<PdfFontRole, PdfTextFont>();
  for (const file of BUNDLED_PDF_FONT_FILES) {
    const bytes = await readFile(file.path);
    const font = parseTrueTypeFont(bytes);
    request.push({ role: file.role, data: encodeBase64(bytes), ranges: font.readCoverage() });
    embedding.set(file.role, { name: file.name, font });
  }
  return { request, embedding };
}

/**
 * Encodes bytes as base64.
 *
 * @param bytes The bytes.
 */
function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += ENCODE_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(start, start + ENCODE_CHUNK_SIZE));
  }
  return btoa(binary);
}
