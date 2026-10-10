import { BLOCK_SEPARATOR_TEXT, findBlock, isHtmlWhitespaceOnly } from './block';
import { convertBlock } from './block-convert';
import { BLOCK_KIND } from './block-format';
import type { BlockRewriteProgress } from './block-format';
import { removeWithSeparator } from './block-merge';
import { isAtBlockStart, placeCaretAtStart } from './caret';
import { findItemLine } from './list-structure';
import { isBareBlockquote } from './quote-code-block';
import { isTypableLine } from './structure-boundary';

/**
 * How a backward delete at the start of a blockquote takes the line out of it.
 *
 * A bare blockquote holds its lines directly and becomes a paragraph as a whole. A blockquote holding blocks gives up
 * only its first block, so a delete takes out one block at a time, the same as a list gives up one item.
 */
export type QuoteLift =
  | { readonly kind: 'unquote'; readonly quote: Element }
  | { readonly kind: 'liftFirst'; readonly block: Element; readonly quote: Element };

/**
 * Decides, without changing the tree, whether a backward delete takes a line out of a blockquote.
 *
 * Only a collapsed caret at the start of the first line counts. A bare blockquote that is the line of a list item is
 * left to the list rule, which takes the item out of the list first. A first block that is not a line of text (a code
 * block, a table, a collapsible section, a diagram, or a list) keeps the rules of its own boundary.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @returns How the line is taken out, or `undefined` when the delete is not one that takes a line out.
 */
export function findQuoteLift(root: Element, range: Range): QuoteLift | undefined {
  if (!range.collapsed) {
    return undefined;
  }
  const block = findBlock(range.startContainer, root);
  if (block === undefined || !isAtBlockStart(range, block)) {
    return undefined;
  }

  if (isBareBlockquote(block)) {
    return findItemLine(range.startContainer, root, true)?.block === block
      ? undefined
      : { kind: 'unquote', quote: block };
  }

  const quote = block.parentElement;
  if (
    quote === null
    || quote === root
    || quote.localName !== 'blockquote'
    || !isTypableLine(block)
    || !isFirstChild(block)
  ) {
    return undefined;
  }
  return { kind: 'liftFirst', block, quote };
}

/**
 * Takes the line out of the blockquote and puts the caret at its start.
 *
 * A bare blockquote is converted to a paragraph, keeping its attributes the same as a conversion from the block type
 * menu does. A first block moves to right before the blockquote, and a blockquote left with no content is removed,
 * leaving its HTML comments where it was.
 *
 * @param lift How the line is taken out.
 * @param progress The holder of whether the tree was changed.
 */
export function liftQuoteLine(lift: QuoteLift, progress: BlockRewriteProgress): void {
  if (lift.kind === 'unquote') {
    const paragraph = convertBlock(lift.quote, BLOCK_KIND.paragraph);
    if (paragraph === undefined) {
      return;
    }
    progress.changed = true;
    placeCaretAtStart(paragraph);
    return;
  }

  const { block, quote } = lift;
  const document = quote.ownerDocument;
  // The newline that separated the block from the next one stays behind otherwise, at the start of the blockquote.
  const separator = block.nextSibling;
  quote.before(block, document.createTextNode(BLOCK_SEPARATOR_TEXT));
  progress.changed = true;
  if (separator instanceof Text && isHtmlWhitespaceOnly(separator.data)) {
    separator.remove();
  }
  if (!hasContent(quote)) {
    // HTML comments do not show, so the blockquote counts as empty with them inside. They are still part of the
    // document, so they take the place of the blockquote instead of going with it.
    for (const node of [...quote.childNodes]) {
      if (node instanceof Comment) {
        quote.before(node, document.createTextNode(BLOCK_SEPARATOR_TEXT));
      }
    }
    // The newline put before the blockquote goes with it.
    removeWithSeparator(quote);
  }
  placeCaretAtStart(block);
}

/**
 * Determines whether a block is the first child of its parent, with only whitespace and HTML comments before it.
 *
 * @param block The block to inspect.
 * @returns `true` when nothing that shows comes before the block.
 */
function isFirstChild(block: Element): boolean {
  for (let node = block.previousSibling; node !== null; node = node.previousSibling) {
    if (node instanceof Comment || (node instanceof Text && isHtmlWhitespaceOnly(node.data))) {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Determines whether an element still holds content that shows: an element or non-whitespace text.
 *
 * @param element The element to inspect.
 * @returns `true` when there is content.
 */
function hasContent(element: Element): boolean {
  return [...element.childNodes].some(
    (node) => node instanceof Element || (node instanceof Text && !isHtmlWhitespaceOnly(node.data)),
  );
}
