import { isHtmlWhitespaceOnly } from './block';
import { findEnclosingLink } from './format-link';
import { collectFormatTarget } from './format-segment';
import { INLINE_FORMAT, isFormatElement } from './inline-format';
import type { InlineFormat } from './inline-format';
import type { FormatSegment, FormatTarget } from './format-segment';

/** Whether each of the five formats is formatted. No format is omitted. */
export type FormatState = Readonly<Record<InlineFormat, boolean>>;

/** The link state. All three are decided from the same target. */
export interface LinkState {
  /** Whether the link is formatted. */
  readonly formatted: boolean;
  /** Whether the range has format segments for the link. A caret or no target has none. */
  readonly hasSegments: boolean;
  /** The link when the selection fits inside one existing link. `undefined` if it does not. */
  readonly link: Element | undefined;
}

// The formats to inspect, so that a single walk decides all five.
const INLINE_FORMATS: readonly InlineFormat[] = Object.values(INLINE_FORMAT);

/**
 * Reads, for each format, whether the target is formatted. Does not change the tree.
 *
 * @param target A list of format segments, a caret position, or no target.
 * @returns Whether each format is formatted. Every format is false when there is no target text.
 *   The link alone is an exception: if the format segments hold images and all of them are inside a link, it is
 *   true even without target text.
 */
export function readFormatState(target: FormatTarget): FormatState {
  if (target.kind === 'none') {
    return createState();
  }
  if (target.kind === 'caret') {
    return readAncestorFormats(target.caret.startContainer);
  }

  const state = createState();
  let counted = 0;
  for (const segment of target.segments) {
    for (const text of collectTargetTexts(segment)) {
      const formats = readAncestorFormats(text);
      for (const format of INLINE_FORMATS) {
        // If even one character of the target text lies outside the format, that format is not formatted.
        state[format] = counted === 0 ? formats[format] : state[format] && formats[format];
      }
      counted += 1;
    }
  }

  // A link can wrap images too, so it is not formatted if an image in the format segments lies outside the link.
  // The other four formats give images no appearance, so they stay decided by the target text alone.
  const images = target.segments.flatMap(collectTargetImages);
  const imagesLinked = images.every((image) => readAncestorFormats(image).link);
  if (counted === 0) {
    return { ...createState(), link: images.length > 0 && imagesLinked };
  }
  return { ...state, link: state.link && imagesLinked };
}

/**
 * Reads whether the link is formatted, whether the range has format segments for the link, and the enclosing link.
 * Changes neither the tree nor the selection.
 *
 * Collecting the three separately could make them disagree, such as a selection that is formatted yet has no
 * enclosing link, so they are decided from a target collected only once with images counted.
 *
 * @param root The editor root.
 * @returns The link state.
 */
export function readLinkState(root: Element): LinkState {
  const target = collectFormatTarget(root, true);
  return {
    formatted: readFormatState(target).link,
    hasSegments: target.kind === 'segments' && target.segments.length > 0,
    link: findEnclosingLink(target, root),
  };
}

/**
 * Builds a state in which no format is formatted.
 *
 * @returns A state with all five formats false.
 */
function createState(): Record<InlineFormat, boolean> {
  return { bold: false, italic: false, strikethrough: false, inlineCode: false, link: false };
}

/**
 * Collects, per format, the format elements among a node's ancestors.
 *
 * @param node The node to start from.
 * @returns A state that is true for every format found among the ancestors.
 */
function readAncestorFormats(node: Node): Record<InlineFormat, boolean> {
  const state = createState();
  let current: Element | null = node instanceof Element ? node : node.parentElement;
  while (current !== null) {
    for (const format of INLINE_FORMATS) {
      if (isFormatElement(current, format)) {
        state[format] = true;
      }
    }
    current = current.parentElement;
  }
  return state;
}

/**
 * Returns, in document order, the texts a format segment covers that hold target text.
 *
 * A whitespace-only run is not target text. Counting even the whitespace that falls between format
 * elements would make a formatted selection read as not formatted.
 *
 * @param segment The format segment.
 * @returns The text nodes that hold target text.
 */
function collectTargetTexts(segment: FormatSegment): Text[] {
  const document = segment.parent.ownerDocument;
  if (document === null) {
    return [];
  }

  const texts: Text[] = [];
  const walker = document.createTreeWalker(segment.parent, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(node instanceof Text)) {
      continue;
    }
    const covered = readCoveredText(segment.range, node);
    if (covered === undefined || isHtmlWhitespaceOnly(covered)) {
      continue;
    }
    texts.push(node);
  }
  return texts;
}

/**
 * Returns, in document order, the images a format segment covers.
 *
 * @param segment The format segment.
 * @returns The `img` elements contained in the range.
 */
function collectTargetImages(segment: FormatSegment): Element[] {
  const document = segment.parent.ownerDocument;
  if (document === null) {
    return [];
  }

  const images: Element[] = [];
  const walker = document.createTreeWalker(segment.parent, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    // An image has no positions inside it, so if it overlaps the range it is covered whole.
    if (node instanceof Element && node.localName === 'img' && segment.range.intersectsNode(node)) {
      images.push(node);
    }
  }
  return images;
}

/**
 * Returns the part of a text node that the range covers.
 *
 * @param range The format segment's range.
 * @param text The text node to inspect.
 * @returns The covered string, or `undefined` when they do not overlap or the covered length is 0.
 */
function readCoveredText(range: Range, text: Text): string | undefined {
  // comparePoint returns -1 before the range, 0 inside it, and 1 after it.
  const startSide = range.comparePoint(text, 0);
  const endSide = range.comparePoint(text, text.data.length);
  if (startSide > 0 || endSide < 0) {
    return undefined;
  }
  const start = startSide < 0 ? range.startOffset : 0;
  const end = endSide > 0 ? range.endOffset : text.data.length;
  return start < end ? text.data.slice(start, end) : undefined;
}
