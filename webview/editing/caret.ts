import { isHtmlWhitespaceOnly } from './block';

// Elements other than non-whitespace text that count as visible content. Only these and text are inspected.
const VISIBLE_CONTENT_SELECTOR = 'img, br, comment';

// Comment annotation bodies and replies. They are not part of the document flow, so the search for the last character of pre content does not descend into them.
const COMMENT_TEXT_TAG_NAMES: ReadonlySet<string> = new Set(['comment-body', 'comment-reply']);

/** The position of the line break that is the last character of the `pre` content (the trailing pre break). */
export interface TrailingPreBreak {
  /** The text holding the line break. */
  readonly text: Text;
  /** The position of the line break within the text. */
  readonly offset: number;
}

/**
 * Determines whether an extracted fragment has visible content.
 *
 * Exported so the comment start and end checks count visible content by the same line as block edges. With two different
 * lines, the same position could disagree on whether it is at a comment edge and at a block edge.
 *
 * @param fragment The cloned contents of a range.
 * @param insidePre Whether the range is inside `pre`. Inside `pre`, whitespace and line breaks also form lines and indentation, so any length counts as content.
 * @returns `true` when it contains text, an image, a break, or a comment annotation.
 */
export function hasVisibleContent(fragment: DocumentFragment, insidePre: boolean): boolean {
  const text = fragment.textContent ?? '';
  if (insidePre ? text.length > 0 : !isHtmlWhitespaceOnly(text)) {
    return true;
  }
  return fragment.querySelector(VISIBLE_CONTENT_SELECTOR) !== null;
}

/**
 * Returns the position of the trailing pre break.
 *
 * The line break that is the last character of the `pre` content forms no line, and the caret cannot be placed after it. Counting it as content
 * would make a visually empty code block not count as blank, and a forward delete at the end of the last line would delete only the invisible line break.
 * Handwritten and Markdown-derived `code` often ends with a line break, so the search does not distinguish inside and outside `code`.
 *
 * @param pre The `pre` to inspect.
 * @returns The position of the line break, or `undefined` if the last character of the content is not a line break.
 */
export function findTrailingPreBreak(pre: Element): TrailingPreBreak | undefined {
  const walker = pre.ownerDocument.createTreeWalker(
    pre,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => (node instanceof Element && COMMENT_TEXT_TAG_NAMES.has(node.localName)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT),
    },
  );

  let last: Node | undefined;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text ? node.data.length > 0 : node instanceof Element && node.matches(VISIBLE_CONTENT_SELECTOR)) {
      last = node;
    }
  }
  if (!(last instanceof Text) || !last.data.endsWith('\n')) {
    return undefined;
  }
  return { text: last, offset: last.data.length - 1 };
}

/**
 * Returns a selection range contained within the editor root.
 *
 * A range is returned only when both endpoints are inside. The caller suppresses input crossing the boundary
 * because it cannot determine what should be changed.
 *
 * @param root The editor root.
 * @returns The first selection range, or `undefined` when there is no selection or it crosses the root boundary.
 */
export function readSelectionRange(root: Element): Range | undefined {
  const selection = root.ownerDocument.defaultView?.getSelection();
  if (selection === null || selection === undefined || selection.rangeCount === 0) {
    return undefined;
  }

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return undefined;
  }
  return range;
}

/**
 * Replaces the selection with a collapsed caret.
 *
 * @param container The node in which to place the caret.
 * @param offset The position within the node.
 */
export function placeCaret(container: Node, offset: number): void {
  const document = container.ownerDocument;
  if (document === null) {
    return;
  }

  const selection = document.defaultView?.getSelection();
  if (selection === null || selection === undefined) {
    return;
  }

  const range = document.createRange();
  range.setStart(container, offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Places the caret at the start of a block.
 *
 * Uses element offset 0 so the caret is placed before a placeholder `br`, if present.
 *
 * @param block The target block.
 */
export function placeCaretAtStart(block: Element): void {
  const first = block.firstChild;
  if (first instanceof Text) {
    placeCaret(first, 0);
    return;
  }
  placeCaret(block, 0);
}

/**
 * Determines whether the caret is at the start of a block.
 *
 * @param range A collapsed range.
 * @param block The target block.
 * @returns `true` when there is no content between the start of the block and the caret.
 */
export function isAtBlockStart(range: Range, block: Element): boolean {
  if (!range.collapsed || !block.contains(range.startContainer)) {
    return false;
  }

  const probe = block.ownerDocument.createRange();
  probe.setStart(block, 0);
  probe.setEnd(range.startContainer, range.startOffset);
  // Treating the position after leading blank lines or indentation in code as the start would make a delete there an edge noop that can never delete them.
  return !hasVisibleContent(probe.cloneContents(), block.closest('pre') !== null);
}

/**
 * Determines whether the caret is at the end of a block.
 *
 * When a boundary child is given, the block is treated as ending right before that child. List items with
 * block children use this to find the end of their own content without being misled by the block children
 * that follow it.
 *
 * @param range A collapsed range.
 * @param block The target block.
 * @param boundary The child right after the position treated as the end. When omitted, the real end of the
 *   block is used.
 * @returns `true` when there is no content between the caret and the end of the block.
 */
export function isAtBlockEnd(range: Range, block: Element, boundary?: Node): boolean {
  if (!range.collapsed || !block.contains(range.endContainer)) {
    return false;
  }

  const probe = block.ownerDocument.createRange();
  probe.setStart(range.endContainer, range.endOffset);
  if (boundary === undefined) {
    probe.setEnd(block, block.childNodes.length);
  } else {
    // A caret after the boundary (including inside it) is not at the end before the boundary. Setting the
    // range end before its start would collapse the range into "no content" and wrongly report the end,
    // so rule this case out first.
    if (probe.comparePoint(boundary, 0) <= 0) {
      return false;
    }
    probe.setEndBefore(boundary);
  }

  const pre = block.closest('pre');
  const trailing = pre === null ? undefined : findTrailingPreBreak(pre);
  if (
    trailing !== undefined
    && probe.comparePoint(trailing.text, trailing.offset) === 0
    && probe.comparePoint(trailing.text, trailing.offset + 1) === 0
  ) {
    // The trailing pre break forms no line, so the position before it is treated as the end. Counting it would make a forward delete at the end of
    // the last line an edit that deletes only the invisible line break. This line break is the last character of the content, so nothing follows it.
    probe.setEnd(trailing.text, trailing.offset);
  }
  const rest = probe.cloneContents();

  // A trailing placeholder is not a break authored by the user; it only provides empty-line height.
  // Its presence therefore does not mean the caret is before the end.
  const last = rest.lastChild;
  if (last instanceof Element && last.localName === 'br') {
    last.remove();
  }
  return !hasVisibleContent(rest, pre !== null);
}

/**
 * Inserts text into a collapsed range and moves the range immediately after it.
 *
 * Inserts a new text node instead of merging with an adjacent one.
 *
 * @param range A collapsed range.
 * @param text The text to insert.
 * @returns The inserted text node, or `undefined` when the text is empty and nothing is inserted.
 */
export function insertTextAtRange(range: Range, text: string): Text | undefined {
  if (text.length === 0) {
    return undefined;
  }

  const document = range.startContainer.ownerDocument;
  if (document === null) {
    return undefined;
  }

  const inserted = document.createTextNode(text);
  range.insertNode(inserted);
  range.setStartAfter(inserted);
  range.collapse(true);
  return inserted;
}
