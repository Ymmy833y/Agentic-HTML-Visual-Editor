import { COMMENT_TAG_NAME } from '../../common/index';
import { INLINE_RUN_TAG_NAMES } from './block';
import { CLEARED_TAG_NAMES } from './inline-format';
import { unwrapAncestorFormats, unwrapDescendantFormats } from './inline-wrap';
import type { FormatSegment } from './format-segment';

// The body and replies of a comment annotation sit outside the text flow and cannot be selected, so their text does not
// count toward whether the selection covers a block.
const UNCOUNTED_TEXT_TAG_NAMES: ReadonlySet<string> = new Set([COMMENT_TAG_NAME.body, COMMENT_TAG_NAME.reply]);

// A character other than HTML whitespace. Whitespace at either end of a block is not drawn, so a selection that stops
// short of it still covers the block.
const VISIBLE_CHARACTER_PATTERN = /[^\t\n\f\r ]/u;

// The HTML whitespace at the end of a text.
const TRAILING_WHITESPACE_PATTERN = /[\t\n\f\r ]*$/u;

/**
 * Removes the format elements and `span`s that wrap the target text of the format segments, and the `style` of the
 * blocks whose text the selection covers entirely.
 *
 * Links, elements the extension does not know, and block attributes other than `style` are left untouched. A link
 * carries a destination rather than a format, and removing an unknown element would lose the intent of the document.
 * Pasted content also puts colors on blocks such as list items, which removing the `span`s alone would leave behind.
 * A block the selection covers only in part keeps its `style`, so that the text left out of the selection keeps its
 * look.
 *
 * @param segments The format segments.
 * @param range The selection range the format segments were cut out of.
 * @param root The editor root.
 * @returns The touched blocks, including those whose `style` was removed. Empty when there was nothing to remove.
 */
export function clearFormats(segments: readonly FormatSegment[], range: Range, root: Element): Element[] {
  // Judge the blocks before unwrapping, because unwrapping moves the text the selection range points into.
  const covered = collectCoveredBlocks(segments, range, root);
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
  for (const block of covered) {
    if (block.hasAttribute('style')) {
      block.removeAttribute('style');
      touched.push(block);
    }
  }
  return touched;
}

/**
 * Collects the blocks around the format segments whose text the selection range covers entirely, innermost first.
 *
 * Once a block is not covered, no block around it can be, so the walk outwards stops there.
 *
 * @param segments The format segments.
 * @param range The selection range.
 * @param root The editor root. Neither it nor anything outside it is collected.
 * @returns The covered blocks, each once.
 */
function collectCoveredBlocks(segments: readonly FormatSegment[], range: Range, root: Element): Element[] {
  const verdicts = new Map<Element, boolean>();
  for (const segment of segments) {
    let current: Element | null = segment.parent instanceof Element ? segment.parent : segment.parent.parentElement;
    while (current !== null && current !== root) {
      if (isClearedBlock(current)) {
        let covered = verdicts.get(current);
        if (covered === undefined) {
          covered = coversAllText(range, current);
          verdicts.set(current, covered);
        }
        if (!covered) {
          break;
        }
      }
      current = current.parentElement;
    }
  }
  return [...verdicts].filter(([, covered]) => covered).map(([block]) => block);
}

/**
 * Tells whether an element is a block whose `style` the clear removes.
 *
 * Phrasing content elements such as `u` and `kbd` are inline and left untouched like the other elements the extension
 * does not know. Elements inside SVG and MathML are not HTML, and their `style` draws the figure itself.
 *
 * @param element The element.
 * @returns `true` for an HTML element that is not phrasing content.
 */
function isClearedBlock(element: Element): boolean {
  return element instanceof HTMLElement && !INLINE_RUN_TAG_NAMES.has(element.localName);
}

/**
 * Tells whether the selection range covers all of a block's text.
 *
 * @param range The selection range.
 * @param block The block.
 * @returns `true` when the range contains the block's text from its first visible character to its last, and `false`
 *   for a block without visible text.
 */
function coversAllText(range: Range, block: Element): boolean {
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node instanceof Element && UNCOUNTED_TEXT_TAG_NAMES.has(node.localName)
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT),
  });
  let first: Text | undefined;
  let last: Text | undefined;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text && VISIBLE_CHARACTER_PATTERN.test(node.data)) {
      first ??= node;
      last = node;
    }
  }
  if (first === undefined || last === undefined) {
    return false;
  }
  const start = first.data.search(VISIBLE_CHARACTER_PATTERN);
  const end = last.data.length - (TRAILING_WHITESPACE_PATTERN.exec(last.data)?.[0].length ?? 0);
  return range.comparePoint(first, start) === 0 && range.comparePoint(last, end) === 0;
}
