import { createEmptyBlock, insertBlock, isHtmlWhitespaceOnly } from './block';
import type { BlockRewriteProgress } from './block-format';
import { findTrailingPreBreak, placeCaretAtStart } from './caret';

// Non-text content that, if it remains after the caret, means the caret is no longer at the end.
const VISIBLE_CONTENT_SELECTOR = 'img, br, comment';

// The display line break: a single newline after the caret. The last newline of the content of a `pre` forms no line,
// so this is what lets the caret's line show at the end of the content.
const DISPLAY_LINE_BREAK = '\n';

/**
 * Determines whether the caret sits on the trailing blank line of a code block.
 *
 * The decision uses the content text up to the caret, and only counts it as a blank line when that text ends
 * with a newline character. Looking at the text of the whole `pre` would count the source newline left after the
 * closing tag of `code` as a blank line and leave the block even when the content does not end with a newline.
 * A `pre` with no content does not match; one holding a single newline character does. A single newline after the
 * caret is the display line break and does not count as content.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @returns The `pre` whose trailing blank line holds the caret, or `undefined` when there is none.
 */
export function findExitableCodeBlock(root: Element, range: Range): Element | undefined {
  if (!range.collapsed) {
    return undefined;
  }

  const pre = findAncestor(range.startContainer, root, 'pre');
  if (pre === undefined || !readTextBeforeCaret(pre, range).endsWith('\n')) {
    return undefined;
  }
  return isAtContentEnd(pre, range) ? pre : undefined;
}

/**
 * Removes the trailing blank line of a code block and leaves it for the paragraph that follows.
 *
 * Leaving the blank line would keep a blank line at the end of the saved `pre` forever. The single newline character
 * immediately before the caret is removed, and so is the display line break after the caret unless it is still
 * needed to show an empty line before the caret. Even when that empties the `pre`, the `pre` itself is kept and holds
 * the height of the line through its background and padding.
 *
 * @param pre The `pre` whose trailing blank line holds the caret.
 * @param range The selection range.
 * @param progress The holder of whether the tree was changed.
 */
export function exitCodeBlock(pre: Element, range: Range, progress: BlockRewriteProgress): void {
  removeNewlineBeforeCaret(pre, range);
  progress.changed = true;
  removeDisplayLineBreak(pre, range);

  const paragraph = createEmptyBlock(pre.ownerDocument, 'p');
  insertBlock(paragraph, pre, 'after');
  // Align the range the input dispatcher carries around with the caret that was placed.
  range.setStart(paragraph, 0);
  range.collapse(true);
  placeCaretAtStart(paragraph);
}

/**
 * Adds the display line break after a newline just inserted at the end of the content of a code block.
 *
 * The last newline of the content of a `pre` forms no line, so a newline inserted there alone shows no new line and
 * the caret cannot move onto it. One more newline after it makes the line show. Nothing is added after a newline
 * inserted partway through, or before a newline that already follows it, even one outside the `code`.
 *
 * @param inserted The text holding only the newline just inserted inside a `pre`.
 * @returns The position in that text to place the caret at: between the two newlines when one was added, and right
 *   after the inserted newline otherwise.
 */
export function appendDisplayLineBreak(inserted: Text): number {
  const pre = inserted.parentElement?.closest('pre');
  const trailing = pre === null || pre === undefined ? undefined : findTrailingPreBreak(pre);
  if (trailing?.text !== inserted || trailing.offset !== inserted.data.length - 1) {
    return inserted.data.length;
  }
  inserted.appendData(DISPLAY_LINE_BREAK);
  return inserted.data.length - DISPLAY_LINE_BREAK.length;
}

/**
 * Searches for an element by following ancestors.
 *
 * @param node The starting node.
 * @param root The upper bound at which the search stops. This element itself is not inspected.
 * @param tagName The tag name to search for.
 * @returns The element found, or `undefined` when there is none.
 */
function findAncestor(node: Node, root: Element, tagName: string): Element | undefined {
  let current: Element | null = node instanceof Element ? node : node.parentElement;
  while (current !== null && current !== root) {
    if (current.localName === tagName) {
      return current;
    }
    current = current.parentElement;
  }
  return undefined;
}

/**
 * Determines whether the caret sits at the end of the content.
 *
 * @param pre The `pre` to inspect.
 * @param range The selection range.
 * @returns `true` when the caret is at the end.
 */
function isAtContentEnd(pre: Element, range: Range): boolean {
  const code = findAncestor(range.startContainer, pre, 'code');
  const inner = cloneToEnd(range.startContainer, range.startOffset, code ?? pre);
  const text = inner.textContent ?? '';
  if ((text !== '' && text !== DISPLAY_LINE_BREAK) || inner.querySelector(VISIBLE_CONTENT_SELECTOR) !== null) {
    return false;
  }
  if (code === undefined) {
    return true;
  }

  // Whitespace left outside the `code` is the line break and indentation before the closing tag, not content.
  const outer = cloneAfter(code, pre);
  return isHtmlWhitespaceOnly(outer.textContent ?? '')
    && outer.querySelector(VISIBLE_CONTENT_SELECTOR) === null;
}

/**
 * Returns the content text from the start of the element up to the caret.
 *
 * @param pre The `pre` to inspect.
 * @param range The selection range.
 * @returns The text before the caret.
 */
function readTextBeforeCaret(pre: Element, range: Range): string {
  const probe = pre.ownerDocument.createRange();
  probe.setStart(pre, 0);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.cloneContents().textContent ?? '';
}

/**
 * Extracts everything from a position to the end of an element.
 *
 * @param container The container of the position.
 * @param offset The position within the container.
 * @param end The element at which to stop.
 * @returns The extracted contents.
 */
function cloneToEnd(container: Node, offset: number, end: Element): DocumentFragment {
  const probe = end.ownerDocument.createRange();
  probe.setStart(container, offset);
  probe.setEnd(end, end.childNodes.length);
  return probe.cloneContents();
}

/**
 * Extracts everything from immediately after an element to the end of its container.
 *
 * @param element The element to start after.
 * @param end The element at which to stop.
 * @returns The extracted contents.
 */
function cloneAfter(element: Element, end: Element): DocumentFragment {
  const probe = end.ownerDocument.createRange();
  probe.setStartAfter(element);
  probe.setEnd(end, end.childNodes.length);
  return probe.cloneContents();
}

/**
 * Removes the single newline character immediately before the caret.
 *
 * What is removed is the newline that creates the blank line the caret sits on. Searching for the last newline
 * inside the `pre` would instead delete the source newline left after the closing tag of `code` when one is
 * there, leaving the blank line behind.
 *
 * @param pre The `pre` to inspect.
 * @param range The selection range.
 */
function removeNewlineBeforeCaret(pre: Element, range: Range): void {
  const container = range.startContainer;
  if (container instanceof Text && range.startOffset > 0) {
    if (container.data[range.startOffset - 1] === '\n') {
      container.deleteData(range.startOffset - 1, 1);
    }
    return;
  }

  // When the caret sits at a boundary inside an element, the newline is at the end of the text before it.
  const previous = findTextBeforeCaret(pre, range);
  if (previous !== undefined && previous.data.endsWith('\n')) {
    previous.deleteData(previous.data.length - 1, 1);
  }
}

/**
 * Removes the display line break after the caret when the empty line it showed goes away with the exit.
 *
 * When the content before the caret still ends with a newline, the display line break is what shows that empty line,
 * so it stays.
 *
 * @param pre The `pre` to inspect.
 * @param range The selection range, pointing at where the removed newline was.
 */
function removeDisplayLineBreak(pre: Element, range: Range): void {
  const scope = findAncestor(range.startContainer, pre, 'code') ?? pre;
  const rest = cloneToEnd(range.startContainer, range.startOffset, scope);
  if (rest.textContent !== DISPLAY_LINE_BREAK || rest.querySelector(VISIBLE_CONTENT_SELECTOR) !== null) {
    return;
  }
  if (readTextBeforeCaret(pre, range).endsWith('\n')) {
    return;
  }

  const container = range.startContainer;
  if (container instanceof Text && range.startOffset < container.data.length) {
    container.deleteData(range.startOffset, DISPLAY_LINE_BREAK.length);
    return;
  }
  findTextAfterCaret(scope, range)?.deleteData(0, DISPLAY_LINE_BREAK.length);
}

/**
 * Returns the first non-empty text node that starts after the caret.
 *
 * @param scope The element to search in.
 * @param range The selection range.
 * @returns The text node found, or `undefined` when there is none.
 */
function findTextAfterCaret(scope: Element, range: Range): Text | undefined {
  const boundary = scope.ownerDocument.createRange();
  boundary.setStart(range.startContainer, range.startOffset);
  boundary.setEnd(scope, scope.childNodes.length);

  const walker = scope.ownerDocument.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    // comparePoint returns 0 for a point inside the range. Only text that starts at or after the caret is taken.
    if (node instanceof Text && node.data.length > 0 && boundary.comparePoint(node, 0) === 0) {
      return node;
    }
  }
  return undefined;
}

/**
 * Returns the last text node that ends before the caret.
 *
 * @param pre The `pre` to inspect.
 * @param range The selection range.
 * @returns The text node found, or `undefined` when there is none.
 */
function findTextBeforeCaret(pre: Element, range: Range): Text | undefined {
  const boundary = pre.ownerDocument.createRange();
  boundary.setStart(pre, 0);
  boundary.setEnd(range.startContainer, range.startOffset);

  let found: Text | undefined;
  const walker = pre.ownerDocument.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    // comparePoint returns 1 for a point after the range. Only text whose end does not pass the boundary is taken.
    if (node instanceof Text && node.data.length > 0
      && boundary.comparePoint(node, node.data.length) <= 0) {
      found = node;
    }
  }
  return found;
}
