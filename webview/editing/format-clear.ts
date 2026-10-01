import { CLEARED_TAG_NAMES } from './inline-format';
import { unwrapAncestorFormats, unwrapDescendantFormats } from './inline-wrap';
import type { FormatSegment } from './format-segment';

/**
 * Removes the format elements and `span`s that wrap the target text of the format segments.
 *
 * Links, elements the extension does not know, and block attributes are left untouched. A link carries a
 * destination rather than a format, and removing an unknown element would lose the intent of the document.
 *
 * @param segments The format segments.
 * @returns The touched blocks. Empty when there was nothing to remove.
 */
export function clearFormats(segments: readonly FormatSegment[]): Element[] {
  const touched: Element[] = [];
  // Work from the last format segment backwards. Splitting a format element at a boundary moves the
  // content after it into the split-off element, so working forwards would shift where the content that
  // the later format segments point at sits.
  for (const segment of [...segments].reverse()) {
    const inside = unwrapDescendantFormats(segment, CLEARED_TAG_NAMES);
    const outside = unwrapAncestorFormats(segment, CLEARED_TAG_NAMES);
    if ((inside || outside) && segment.block !== undefined) {
      touched.push(segment.block);
    }
  }
  return touched;
}
