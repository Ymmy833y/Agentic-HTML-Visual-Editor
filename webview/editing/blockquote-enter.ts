import {
  createEmptyBlock,
  fillPlaceholder,
  findBlock,
  hasFollowingContent,
  insertBlock,
  isEmptyBlock,
  isHtmlWhitespaceOnly,
} from './block';
import { BLOCK_KIND, isConvertibleBlock, readBlockKind } from './block-format';
import type { BlockRewriteProgress } from './block-format';
import { removeWithSeparator } from './block-merge';
import { placeCaret, placeCaretAtStart } from './caret';

// Elements counted as one piece of content on their own, without looking inside. A line break inside a comment is
// formatting within the annotation, not a trailing line of the blockquote.
const OPAQUE_CONTENT_TAG_NAMES: ReadonlySet<string> = new Set(['img', 'comment']);

/**
 * Returns the innermost block holding the caret only when that block is a bare blockquote.
 *
 * Ancestor blockquotes are not followed up. A blockquote holding blocks as children is not returned either, so the
 * built-in replacement splits the paragraphs inside it.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @returns The bare blockquote, or `undefined` when there is none.
 */
export function findBareBlockquote(root: Element, range: Range): Element | undefined {
  if (!range.collapsed) {
    // Enter with a range selected is not taken over. It is handed to the built-in replacement, which deletes the
    // range and inserts an in-block break.
    return undefined;
  }

  const block = findBlock(range.startContainer, root);
  if (block === undefined || readBlockKind(block) !== BLOCK_KIND.quote || !isConvertibleBlock(block)) {
    return undefined;
  }
  return block;
}

/**
 * Decides from the shape of the tree alone whether the caret sits on the trailing blank line of a blockquote.
 *
 * The last of the `br` elements running at the end is there to make the line before it show, and does not count as
 * content. A blockquote holding a single `br` (a blockquote with empty content) therefore does not match, whichever
 * side of it the caret is on. What is counted is the run of content that shows, crossing the boundaries of format
 * elements. Whether the alert attribute is there, and what its value is, is not looked at.
 *
 * @param quote The bare blockquote.
 * @param range The collapsed selection range that points at the caret.
 * @returns `true` when the caret sits on the trailing blank line of the blockquote.
 */
export function isAtTrailingBlankLine(quote: Element, range: Range): boolean {
  return countTrailingBreaks(quote) >= 2 && isAtContentEnd(quote, range);
}

/**
 * Inserts an in-block break at the caret and places the caret on the next line.
 *
 * A break inserted at the end of the content shows no blank line unless another `br` follows it. When the content
 * already ends with a `br`, that one carries the display, so only a single break is inserted.
 *
 * @param quote The bare blockquote.
 * @param range The collapsed selection range that points at the caret. The one the input dispatcher carries around
 *   is brought to the same position.
 * @param progress The holder of whether the tree was changed.
 */
export function insertBreakInBlockquote(
  quote: Element,
  range: Range,
  progress: BlockRewriteProgress,
): void {
  const document = quote.ownerDocument;
  // The range is no longer collapsed once the break is inserted, so the decision is made beforehand.
  const needsBlankLine = isAtContentEnd(quote, range) && !endsWithBreak(quote);

  const inserted = document.createElement('br');
  // Format elements and comments are not split. When the caret sits inside one, the break goes inside it.
  range.insertNode(inserted);
  progress.changed = true;

  if (needsBlankLine) {
    inserted.after(document.createElement('br'));
  }

  // The caret goes immediately after the first `br` inserted. When two were inserted, the gap between them is the
  // new line.
  range.setStartAfter(inserted);
  range.collapse(true);
  placeCaret(range.startContainer, range.startOffset);
}

/**
 * Removes one trailing break and inserts an empty paragraph right after the blockquote, moving the caret into it.
 *
 * Only the last of the `br` elements running at the end is removed; the blank line before it is kept. The
 * blockquote itself is not removed, and its alert attribute is not changed either.
 *
 * @param quote The bare blockquote.
 * @param range The collapsed selection range that points at the caret.
 * @param progress The holder of whether the tree was changed.
 */
export function exitBlockquote(
  quote: Element,
  range: Range,
  progress: BlockRewriteProgress,
): void {
  findLastBreak(quote)?.remove();
  progress.changed = true;
  // A blockquote left with empty content loses its height and looks as though the line disappeared. A placeholder
  // of the same shape an empty block gets is put in.
  fillPlaceholder(quote);

  const paragraph = createEmptyBlock(quote.ownerDocument, 'p');
  insertBlock(paragraph, quote, 'after');
  // Align the range the input dispatcher carries around with the caret that was placed.
  range.setStart(paragraph, 0);
  range.collapse(true);
  placeCaretAtStart(paragraph);
}

/**
 * Returns the trailing quote paragraph that holds the caret: the empty last paragraph of a blockquote holding blocks
 * as children.
 *
 * Enter splits the paragraphs inside such a blockquote, so without this there would be no way to leave it with the
 * keyboard. Whether the alert attribute is there, and what its value is, is not looked at.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @returns The paragraph, or `undefined` when there is a range selection or at any other position.
 */
export function findTrailingQuoteParagraph(root: Element, range: Range): Element | undefined {
  if (!range.collapsed) {
    // Enter with a range selected is handed to the built-in replacement, as in a bare blockquote.
    return undefined;
  }

  const paragraph = findBlock(range.startContainer, root);
  const quote = paragraph?.parentElement;
  if (
    paragraph === undefined
    || quote === null
    || quote === undefined
    || paragraph.localName !== 'p'
    || quote.localName !== 'blockquote'
    || !isEmptyBlock(paragraph)
    || hasFollowingContent(paragraph)
  ) {
    return undefined;
  }
  return paragraph;
}

/**
 * Removes the trailing quote paragraph and inserts an empty paragraph right after the blockquote, moving the caret
 * into it.
 *
 * The blockquote itself is not removed, and its alert attribute is not changed either.
 *
 * @param paragraph The trailing quote paragraph.
 * @param range The collapsed selection range that points at the caret.
 * @param progress The holder of whether the tree was changed.
 */
export function exitQuoteParagraph(
  paragraph: Element,
  range: Range,
  progress: BlockRewriteProgress,
): void {
  const quote = paragraph.parentElement;
  if (quote === null) {
    return;
  }

  // The newline before the paragraph goes with it, so no blank separator is left at the end of the blockquote.
  removeWithSeparator(paragraph);
  progress.changed = true;
  // A blockquote left with nothing in it loses its height, the same as when leaving a bare blockquote empties it.
  fillPlaceholder(quote);

  const next = createEmptyBlock(quote.ownerDocument, 'p');
  insertBlock(next, quote, 'after');
  // Align the range the input dispatcher carries around with the caret that was placed.
  range.setStart(next, 0);
  range.collapse(true);
  placeCaretAtStart(next);
}

/**
 * Returns whether no content that shows is left after the caret.
 *
 * The last of the `br` elements running at the end is there to make a line show and does not count as content.
 * Text made of whitespace alone does not show either. Inserting a break where the caret sits at the end of a text
 * node leaves an empty text node behind it, and counting that as content would keep the second Enter from leaving
 * the blockquote.
 *
 * @param quote The bare blockquote.
 * @param range The collapsed selection range that points at the caret.
 * @returns `true` when the caret is at the end of the content.
 */
function isAtContentEnd(quote: Element, range: Range): boolean {
  const probe = quote.ownerDocument.createRange();
  probe.setStart(range.startContainer, range.startOffset);
  probe.setEnd(quote, quote.childNodes.length);
  const rest = probe.cloneContents();

  const last = findLastContent(rest);
  if (last === undefined) {
    return true;
  }
  // When all that is left is the single last `br` that makes a line show, the caret is at the end of the content.
  return isBreak(last) && findPreviousContent(last, rest) === undefined;
}

/**
 * Counts the `br` elements running at the end.
 *
 * @param quote The bare blockquote.
 * @returns The number of `br` elements running at the end.
 */
function countTrailingBreaks(quote: Element): number {
  let count = 0;
  for (
    let node = findLastContent(quote);
    node !== undefined;
    node = findPreviousContent(node, quote)
  ) {
    if (!isBreak(node)) {
      return count;
    }
    count += 1;
  }
  return count;
}

/**
 * Returns the last of the `br` elements running at the end.
 *
 * @param quote The bare blockquote.
 * @returns The last `br`, or `undefined` when the content does not end with a `br`.
 */
function findLastBreak(quote: Element): Element | undefined {
  const last = findLastContent(quote);
  return last !== undefined && isBreak(last) ? last : undefined;
}

/**
 * Returns the last piece of content that shows.
 *
 * @param parent The node to look inside.
 * @returns The last piece of content, or `undefined` when nothing shows.
 */
function findLastContent(parent: Node): Node | undefined {
  for (let child = parent.lastChild; child !== null; child = child.previousSibling) {
    const content = readContent(child);
    if (content !== undefined) {
      return content;
    }
  }
  return undefined;
}

/**
 * Returns the previous piece of content that shows.
 *
 * The boundaries of format elements are crossed. Even when the last line of a blockquote ends inside a format
 * element, that break is a trailing line of the blockquote. Without crossing them there would be no way to leave
 * that blockquote with Enter.
 *
 * @param node The piece of content to start from.
 * @param root The upper bound at which the walk up stops. Only what is inside it is looked at.
 * @returns The previous piece of content, or `undefined` when nothing that shows precedes it.
 */
function findPreviousContent(node: Node, root: Node): Node | undefined {
  for (
    let current: Node | null = node;
    current !== null && current !== root;
    current = current.parentNode
  ) {
    for (let sibling = current.previousSibling; sibling !== null; sibling = sibling.previousSibling) {
      const content = readContent(sibling);
      if (content !== undefined) {
        return content;
      }
    }
  }
  return undefined;
}

/**
 * Returns the node itself, or the last piece of content inside it, as what shows.
 *
 * @param node The node to inspect.
 * @returns The content that shows, or `undefined` when nothing shows.
 */
function readContent(node: Node): Node | undefined {
  if (node instanceof Text) {
    // Text made of whitespace alone does not show, so it does not break a run of `br` elements.
    return isHtmlWhitespaceOnly(node.data) ? undefined : node;
  }
  if (!(node instanceof Element)) {
    return undefined;
  }
  if (node.localName === 'br' || OPAQUE_CONTENT_TAG_NAMES.has(node.localName)) {
    return node;
  }
  // A format element is a container, and what shows is its contents. With no contents, nothing shows.
  return findLastContent(node);
}

/**
 * Returns whether a node is a line break.
 *
 * @param node The node to inspect.
 * @returns `true` when it is a `br`.
 */
function isBreak(node: Node): node is Element {
  return node instanceof Element && node.localName === 'br';
}

/**
 * Returns whether the content of a blockquote ends with a `br`.
 *
 * @param quote The bare blockquote.
 * @returns `true` when it ends with a `br`.
 */
function endsWithBreak(quote: Element): boolean {
  return findLastBreak(quote) !== undefined;
}
