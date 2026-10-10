/**
 * Splits LF-separated text into lines, keeping the trailing empty element.
 *
 * @param text The LF-separated text to split.
 * @returns The array of lines, with the trailing empty element preserved.
 */
export function splitLines(text: string): string[] {
  return text.split('\n');
}

/**
 * Joins an array of lines back into LF-separated text.
 *
 * @param lines The array of lines to join.
 * @returns The text joined with LF separators.
 */
export function joinLines(lines: readonly string[]): string {
  return lines.join('\n');
}
