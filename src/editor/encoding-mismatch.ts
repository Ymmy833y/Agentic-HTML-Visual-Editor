// TextDecoder is global in both extension hosts, but this layer has no DOM types.
declare const TextDecoder: {
  new (label: string, options: { fatal: boolean }): { decode(input: Uint8Array): string };
};

// The character a decoder puts in place of bytes it cannot read with the chosen encoding.
const REPLACEMENT_CHARACTER = '\uFFFD';

/**
 * Determines whether the text buffer was decoded with an encoding that does not match the file's bytes.
 *
 * When VS Code reads a non-UTF-8 file as UTF-8, it puts replacement characters in place of the bytes it cannot read.
 * Saving such text would write the replacement characters over the original characters, including lines nobody
 * edited. A replacement character in a file whose bytes are valid UTF-8 is a character the author wrote, so it is not
 * treated as a mismatch, and a buffer reopened with the right encoding has no replacement characters at all.
 *
 * @param text The full text of the text buffer.
 * @param readBytes A function that reads the file's bytes. It is called only when the text has a replacement
 * character.
 * @returns `true` only when the text has a replacement character and the bytes are not valid UTF-8. Bytes that cannot
 * be read give `false`, which leaves the document opening as before.
 */
export async function detectEncodingMismatch(
  text: string,
  readBytes: () => PromiseLike<Uint8Array>,
): Promise<boolean> {
  if (!text.includes(REPLACEMENT_CHARACTER)) {
    return false;
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBytes();
  } catch {
    return false;
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}
