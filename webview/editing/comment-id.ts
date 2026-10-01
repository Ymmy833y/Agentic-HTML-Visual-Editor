import { COMMENT_ID_FORMAT } from '../../common/index';

/**
 * Random fill. Fills the given bytes with random values.
 *
 * The view passes `crypto.getRandomValues`; unit tests pass a fixed sequence.
 */
export type RandomFill = (bytes: Uint8Array<ArrayBuffer>) => void;

/** Maximum number of redraws when looking for a candidate that does not overlap. */
export const COMMENT_ID_ATTEMPT_LIMIT = 16;

// Upper bound (exclusive) of the bytes used for characters. Discarding values at or above it leaves a count that divides
// evenly by the number of characters, so every character is chosen with the same probability.
const UNIFORM_BYTE_LIMIT = Math.floor(256 / COMMENT_ID_FORMAT.characters.length)
  * COMMENT_ID_FORMAT.characters.length;

/**
 * Creates the ID of a new comment. Does not change the tree.
 *
 * Overlapping the `id` of an element in the editor root would give a reference two targets. What lies outside the body
 * (such as `<head>`) is not in the tree, so it is checked by whether the candidate's spelling appears in the text.
 *
 * @param root The editor root.
 * @param outsideTexts The texts outside the body (the prologue and the epilogue).
 * @param fillRandom The random fill.
 * @returns An ID that does not overlap. `undefined` if it still overlaps after redrawing up to the limit, or if no random values can be obtained.
 */
export function createCommentId(
  root: Element,
  outsideTexts: readonly string[],
  fillRandom: RandomFill,
): string | undefined {
  try {
    for (let attempt = 0; attempt < COMMENT_ID_ATTEMPT_LIMIT; attempt += 1) {
      const candidate = drawCandidate(fillRandom);
      if (candidate !== undefined && !overlaps(candidate, root, outsideTexts)) {
        return candidate;
      }
    }
  } catch {
    // Without random values, no ID is created. The caller leaves one diagnostic line and ends without changing the tree.
  }
  return undefined;
}

/**
 * Makes one candidate from random values.
 *
 * Takes twice as many bytes as one candidate needs. Only a few of the 256 values are discarded, so running short is very
 * unlikely; if it does, that round counts as a redraw. Even if the random fill returns only discarded values, the loop
 * does not hang and stops at the limit.
 *
 * @param fillRandom The random fill.
 * @returns The candidate. `undefined` if too many values were discarded to have enough characters.
 */
function drawCandidate(fillRandom: RandomFill): string | undefined {
  const { prefix, length, characters } = COMMENT_ID_FORMAT;
  const bytes = new Uint8Array(length * 2);
  fillRandom(bytes);

  let body = '';
  for (const byte of bytes) {
    if (byte >= UNIFORM_BYTE_LIMIT) {
      continue;
    }
    body += characters[byte % characters.length];
    if (body.length === length) {
      return `${prefix}${body}`;
    }
  }
  return undefined;
}

/**
 * Returns whether the candidate overlaps any `id` in the document.
 *
 * @param candidate The candidate.
 * @param root The editor root. The `id` of every element is checked, not only of `comment`.
 * @param outsideTexts The texts outside the body.
 * @returns `true` if it overlaps.
 */
function overlaps(candidate: string, root: Element, outsideTexts: readonly string[]): boolean {
  if (outsideTexts.some((text) => text.includes(candidate))) {
    return true;
  }
  return [...root.querySelectorAll('[id]')].some((element) => element.getAttribute('id') === candidate);
}
