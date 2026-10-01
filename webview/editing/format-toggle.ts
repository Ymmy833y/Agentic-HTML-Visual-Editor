import {
  CREATED_FORMAT_TAG_NAME,
  FORMAT_TAG_NAMES,
  isBlockLevelElement,
  isFormatElement,
} from './inline-format';
import type { ToggleFormat } from './inline-format';
import { unwrapAncestorFormats, unwrapDescendantFormats, wrapSegment } from './inline-wrap';
import type { FormatSegment } from './format-segment';

/**
 * Applies a format to the format segments.
 *
 * @param format The format to apply.
 * @param segments The format segments.
 * @returns The touched blocks. Empty when nothing was changed.
 */
export function applyFormat(format: ToggleFormat, segments: readonly FormatSegment[]): Element[] {
  const touched: Element[] = [];
  for (const segment of segments) {
    // Wrapping a format segment that already lies entirely inside the same format would nest that
    // format inside itself.
    if (hasAncestorFormat(segment, format)) {
      continue;
    }

    // Remove the same format from inside the format segment and gather it into a single new element.
    unwrapDescendantFormats(segment, FORMAT_TAG_NAMES[format]);
    const document = segment.range.startContainer.ownerDocument;
    if (document === null) {
      continue;
    }
    const wrapper = document.createElement(CREATED_FORMAT_TAG_NAME[format]);
    if (wrapSegment(segment, wrapper) && segment.block !== undefined) {
      touched.push(segment.block);
    }
  }
  return touched;
}

/**
 * Removes a format from the format segments.
 *
 * `b` and `i` are removed as the same format too. A format element that reaches beyond the format
 * segment is split at the boundary and kept on the outside.
 *
 * @param format The format to remove.
 * @param segments The format segments.
 * @returns The touched blocks. Empty when there was no matching format element.
 */
export function removeFormat(format: ToggleFormat, segments: readonly FormatSegment[]): Element[] {
  const touched: Element[] = [];
  // Work from the last format segment backwards. Splitting a format element at a boundary moves the
  // content after it into the split-off element, so working forwards would shift where the content that
  // the later format segments point at sits.
  for (const segment of [...segments].reverse()) {
    const inside = unwrapDescendantFormats(segment, FORMAT_TAG_NAMES[format]);
    const outside = unwrapAncestorFormats(segment, FORMAT_TAG_NAMES[format]);
    if ((inside || outside) && segment.block !== undefined) {
      touched.push(segment.block);
    }
  }
  return touched;
}

/**
 * Determines whether a format segment lies entirely inside the given format.
 *
 * @param segment The format segment.
 * @param format The format.
 * @returns `true` when a format element of that format is among the ancestors up to the block-level
 * element.
 */
function hasAncestorFormat(segment: FormatSegment, format: ToggleFormat): boolean {
  const container = segment.range.startContainer;
  let current: Element | null = container instanceof Element ? container : container.parentElement;
  while (current !== null && !isBlockLevelElement(current)) {
    if (isFormatElement(current, format)) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}
