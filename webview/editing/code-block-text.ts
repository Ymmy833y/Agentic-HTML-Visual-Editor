import { findBlock } from './block';
import type { BlockRewriteProgress } from './block-format';
import { insertTextAtRange, placeCaret } from './caret';

// Elements counted as content inside `pre` besides text.
const CODE_CONTENT_SELECTOR = 'img, br, comment';

/**
 * Returns the empty `code` at the caret position.
 *
 * Browsers never use an empty inline element as the target for keystrokes or IME input, so even with the caret inside or touching `code`,
 * characters go outside `code` (directly under `pre`) and the empty `code` remains. To steer input at the same position into `code` even in a `pre`
 * that has content outside `code`, the inside of `code` and the positions inside `pre` that touch `code` with no content in between
 * are treated the same. The start of `pre`, where the caret is placed right after converting to a code block, is one of them.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @returns The empty `code`, or `undefined` when there is a range selection or the caret is not at such a position.
 */
export function findEmptyCodeAt(root: Element, range: Range): Element | undefined {
  if (!range.collapsed) {
    return undefined;
  }

  const pre = findBlock(range.startContainer, root);
  if (pre === undefined || pre.localName !== 'pre') {
    return undefined;
  }
  return readEmptyCodeAt(pre, range);
}

/**
 * Determines whether the caret sits in an empty code block.
 *
 * Browsers do not make an inline element with no contents the destination of typed characters. Typing straight
 * into a code block created from an empty paragraph puts the characters outside the `code` (directly beneath the
 * `pre`), leaving an empty `code` behind while the content piles up outside it.
 * Because it takes over before the tree reaches that shape, if the caret is at an empty code position (`findEmptyCodeAt`),
 * returns the `pre` even when it has content outside `code`.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @returns The `pre` of the empty code block, or `undefined` when there is none.
 */
export function findEmptyCodeBlock(root: Element, range: Range): Element | undefined {
  return findEmptyCodeAt(root, range)?.parentElement ?? undefined;
}

/**
 * Inserts the typed characters into the `code` of an empty code block.
 *
 * @param pre The `pre` of the empty code block.
 * @param range The selection range.
 * @param text The typed characters.
 * @param progress The holder of whether the tree was changed.
 */
export function insertTextIntoCodeBlock(
  pre: Element,
  range: Range,
  text: string,
  progress: BlockRewriteProgress,
): void {
  const code = readEmptyCodeAt(pre, range);
  if (code === undefined || insertTextAtRange(collapseIntoCode(range, code), text) === undefined) {
    return;
  }
  progress.changed = true;

  // Move the live caret to just after the characters, not only the range the input dispatcher carries around.
  // The `code` now has contents, so characters typed next bypass this rule and the browser puts them into that
  // same `code`.
  placeCaret(range.startContainer, range.startOffset);
}

/**
 * Moves the insertion point into the `code` when the caret sits in an empty code block.
 *
 * Pasting puts the content at the caret position, but right after a conversion the caret is outside the `code`
 * (at the start of the `pre`). Left alone, the content would pile up outside the `code` and leave an empty
 * `code` behind. The tree is not rewritten; only the given range is moved.
 *
 * @param root The editor root.
 * @param range The selection range. When moved, this very range is the one that moves.
 */
export function placeRangeInEmptyCode(root: Element, range: Range): void {
  const code = findEmptyCodeAt(root, range);
  if (code !== undefined) {
    collapseIntoCode(range, code);
  }
}

/**
 * Returns the empty `code` directly under `pre` that contains the caret or touches it with no content in between.
 *
 * @param pre The `pre` to inspect.
 * @param range A collapsed range.
 * @returns The empty `code`, or `undefined` if there is none.
 */
function readEmptyCodeAt(pre: Element, range: Range): Element | undefined {
  if (!range.collapsed) {
    return undefined;
  }
  for (const code of pre.children) {
    if (code.localName !== 'code' || !isContentlessCode(code)) {
      continue;
    }
    if (code.contains(range.startContainer) || touchesCode(range, code)) {
      return code;
    }
  }
  return undefined;
}

/**
 * Determines whether `code` has no content.
 *
 * After its content is fully deleted, or after an uncommitted composition, only zero-length text may remain; unless that is also treated
 * as an empty `code`, subsequent input goes outside `code`.
 *
 * @param code The `code` to inspect.
 * @returns `true` if it has no children or only zero-length text.
 */
function isContentlessCode(code: Element): boolean {
  return [...code.childNodes].every((node) => node instanceof Text && node.data.length === 0);
}

/**
 * Determines whether the caret touches `code` inside `pre` with no content in between.
 *
 * Inside `pre`, whitespace and line breaks are also content; if any lies in between, input is treated as belonging at that position.
 *
 * @param range A collapsed range.
 * @param code The empty `code`.
 * @returns `true` if there is no content in between.
 */
function touchesCode(range: Range, code: Element): boolean {
  const document = code.ownerDocument;
  const start = document.createRange();
  start.setStartBefore(code);
  start.collapse(true);

  const gap = document.createRange();
  if (range.compareBoundaryPoints(Range.START_TO_START, start) <= 0) {
    gap.setStart(range.startContainer, range.startOffset);
    gap.setEndBefore(code);
  } else {
    gap.setStartAfter(code);
    gap.setEnd(range.startContainer, range.startOffset);
  }
  const between = gap.cloneContents();
  return (between.textContent ?? '').length === 0 && between.querySelector(CODE_CONTENT_SELECTOR) === null;
}

/**
 * Collapses a range into a `code`.
 *
 * @param range The selection range.
 * @param code The `code` to insert into.
 * @returns The same range, collapsed.
 */
function collapseIntoCode(range: Range, code: Element): Range {
  range.setStart(code, 0);
  range.collapse(true);
  return range;
}
