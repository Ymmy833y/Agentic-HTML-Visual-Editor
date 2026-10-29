import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { PdfFontRole } from '../../common/index';

// The bundled fonts as installed. The bundle copies these files next to itself.
const FONT_FILES: Readonly<Record<PdfFontRole, string>> = {
  sans: '../../node_modules/@expo-google-fonts/biz-udpgothic/400Regular/BIZUDPGothic_400Regular.ttf',
  mono: '../../node_modules/@expo-google-fonts/biz-udgothic/400Regular/BIZUDGothic_400Regular.ttf',
};

/**
 * Reads the file of a bundled font.
 *
 * @param role The role of the font.
 * @returns The bytes of the file.
 */
export function readBundledFontFile(role: PdfFontRole): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(FONT_FILES[role], import.meta.url))));
}
