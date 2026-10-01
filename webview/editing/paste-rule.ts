import { isInsidePre, isSplittableBlock, removePlaceholderBreak } from './block';
import { prepareSplit, splitBlock } from './block-split';
import { insertTextAtRange, placeCaret } from './caret';
import { placeRangeInEmptyCode } from './code-block-text';
import type { EditingHooks } from './editing-hooks';
import type { InputRule } from './input-dispatcher';
import { prepareTargetBlock } from './target-block';

// Treat LF, CRLF, and CR alike because the source application determines line-break spelling.
const LINE_BREAK_PATTERN = /\r\n|\r|\n/u;

/**
 * Splits pasted plain text into lines.
 *
 * A trailing line break is retained as an empty final line.
 *
 * @param text The pasted plain text.
 * @returns The lines.
 */
export function splitPastedLines(text: string): string[] {
  return text.split(LINE_BREAK_PATTERN);
}

/**
 * Creates a rule that inserts a paste as the text form. The HTML form is not read.
 *
 * Handles pastes the HTML paste rule did not take (no HTML form, a placement that falls back to the text form, and
 * so on). The browser default is never let through, because it would insert styled external markup as is and break
 * the structure.
 *
 * @param root The editor root.
 * @param hooks The editing hooks. Passed through to the range deletion.
 * @returns A rule registered for `insertFromPaste`.
 */
export function createPasteRule(root: Element, hooks?: EditingHooks): InputRule {
  return ({ event, range }) => {
    const text = event.dataTransfer?.getData('text/plain') ?? '';
    return insertPastedText(root, range, text, hooks) ? 'edited' : 'consumed';
  };
}

/**
 * Deletes the range, inserts the text split into lines, and places the caret at the end of the inserted text.
 *
 * Kept in one place so that the built-in paste rule and pastes from command paths (plain text paste, and HTML paste
 * whose placement falls back to the text form) go through the same procedure. With two procedures, the handling
 * inside `pre` and of split preprocessors would drift between paths.
 *
 * @param root The editor root.
 * @param range The range to insert into. For a range selection, a target block is ensured before deleting it.
 * @param text The text to paste.
 * @param hooks The editing hooks. Passed to the range deletion and the split preprocessors.
 * @returns Whether the tree changed. Returns false without deleting the range if the text is empty, and false if a
 *   target block cannot be ensured.
 */
export function insertPastedText(root: Element, range: Range, text: string, hooks?: EditingHooks): boolean {
  if (text.length === 0) {
    return false;
  }

  let target = prepareTargetBlock(root, range, hooks);
  if (target === undefined) {
    return false;
  }

  const lines = splitPastedLines(text);

  if (isInsidePre(range.startContainer, root)) {
    // Inside `pre`, line breaks are content and are inserted without splitting into blocks. Normalize CRLF and
    // CR from source applications to LF before inserting them into the body.
    // In an empty code block the caret is outside the `code`, so inserting there would pile the content up
    // outside it and leave an empty `code` behind. The insertion point is moved in first.
    placeRangeInEmptyCode(root, range);
    insertTextAtRange(range, lines.join('\n'));
    placeCaret(range.startContainer, range.startOffset);
    return true;
  }

  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      target = startNextLine(target, range, root, hooks);
    }
    if (insertTextAtRange(range, line) !== undefined) {
      removePlaceholderBreak(target);
    }
  }

  placeCaret(range.startContainer, range.startOffset);
  return true;
}

/**
 * Creates a location for inserting the next line.
 *
 * @param target The block currently receiving text.
 * @param range The insertion range, moved to the start of the next line.
 * @param root The editor root.
 * @param hooks The editing hooks. Its split preprocessors are read.
 * @returns The block that will receive the next line.
 */
function startNextLine(target: Element, range: Range, root: Element, hooks: EditingHooks | undefined): Element {
  if (isSplittableBlock(target)) {
    // When a preprocessor takes over the split (a line break inserted in the middle of a comment), continue the next line
    // from the range without splitting. On a takeover with no boundary to continue from, the range stays as is and the next line goes there.
    if (prepareSplit(target, range, hooks?.splitPreprocessors ?? []).kind === 'takenOver') {
      return target;
    }
    const next = splitBlock(target, range);
    range.setStart(next, 0);
    range.collapse(true);
    return next;
  }

  // Use a `br` for an unsplittable target because splitting it would damage the structure.
  const lineBreak = root.ownerDocument.createElement('br');
  range.insertNode(lineBreak);
  range.setStartAfter(lineBreak);
  range.collapse(true);
  return target;
}
