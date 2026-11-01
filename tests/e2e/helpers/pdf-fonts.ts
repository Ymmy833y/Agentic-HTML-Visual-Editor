import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { PDF_FONT_ROLE } from '../../../common/index';
import type { PdfExportFont } from '../../../common/index';
import { parseTrueTypeFont } from '../../../src/export/true-type-font';

// The bundled fonts as the build writes them next to the extension bundle, where the host reads them.
const FONT_FILES = [
  [PDF_FONT_ROLE.sans, path.resolve(__dirname, '../../../dist/fonts/BIZUDPGothic_400Regular.ttf')],
  [PDF_FONT_ROLE.mono, path.resolve(__dirname, '../../../dist/fonts/BIZUDGothic_400Regular.ttf')],
] as const;

let fonts: readonly PdfExportFont[] | undefined;

/**
 * Returns the bundled fonts as a request PDF export message carries them.
 *
 * The files are read once per worker, because every export request carries them.
 */
export function readPdfExportFonts(): readonly PdfExportFont[] {
  fonts ??= FONT_FILES.map(([role, file]) => {
    const bytes = readFileSync(file);
    return { role, data: bytes.toString('base64'), ranges: parseTrueTypeFont(new Uint8Array(bytes)).readCoverage() };
  });
  return fonts;
}
