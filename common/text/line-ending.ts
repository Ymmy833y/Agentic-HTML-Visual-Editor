/** The line ending restored when writing back to the file. */
export type LineEnding = 'lf' | 'crlf';

/**
 * Detects the line ending that prevails across the whole file.
 *
 * @param text The whole file text to inspect.
 * @returns `crlf` if CRLF outnumbers the other line breaks, otherwise `lf`.
 */
export function detectLineEnding(text: string): LineEnding {
  let crlfCount = 0;
  let otherCount = 0;

  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    if (match[0] === '\r\n') {
      crlfCount += 1;
    } else {
      otherCount += 1;
    }
  }

  return crlfCount > otherCount ? 'crlf' : 'lf';
}

/**
 * Normalizes CRLF and lone CR to LF.
 *
 * @param text The text to normalize.
 * @returns The text with its line endings unified to LF.
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n|\r/g, '\n');
}

/**
 * Restores LF text to the given line ending.
 *
 * @param text The text normalized to LF.
 * @param lineEnding The line ending to restore.
 * @returns The text restored to the given line ending.
 */
export function restoreLineEndings(text: string, lineEnding: LineEnding): string {
  return lineEnding === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
}
