import { isInsidePre, isSplittableBlock } from './block';
import { prepareSplit, splitBlock } from './block-split';
import { insertTextAtRange, placeCaret, placeCaretAtStart } from './caret';
import { appendDisplayLineBreak } from './code-block-exit';
import { placeRangeInEmptyCode } from './code-block-text';
import type { EditingHooks } from './editing-hooks';
import type { InputRule } from './input-dispatcher';
import { prepareTargetBlock } from './target-block';

/**
 * Creates a rule that handles Enter and Shift+Enter.
 *
 * Enter is always handled here because the browser default creates a `div`, duplicates IDs when splitting, and
 * provides no opportunity to insert a line break before the new block. Shift+Enter passes to the browser outside
 * `pre` because the resulting in-block `br` is exactly the desired result.
 *
 * @param root The editor root.
 * @param hooks The editing hooks. Passed through to the range deletion.
 * @returns A rule registered for `insertParagraph` and `insertLineBreak`.
 */
export function createEnterRule(root: Element, hooks?: EditingHooks): InputRule {
  return ({ event, range }) => {
    const insidePre = isInsidePre(range.startContainer, root);

    // An in-block `br` is the desired result, so pass through without handling it. Deleting the range here would
    // change the tree despite passing and cause the following browser default to delete it again.
    if (event.inputType === 'insertLineBreak' && !insidePre) {
      return 'pass';
    }

    // When a split preprocessor takes over without changing the tree, whether a range selection was deleted decides between "edited" and "consumed".
    const deletesRange = !range.collapsed;
    const target = prepareTargetBlock(root, range, hooks);
    if (target === undefined) {
      return 'consumed';
    }

    if (insidePre) {
      // Inside `pre`, a line break is content itself, so insert it as text without creating another block.
      // In an empty code block the caret is outside the `code`, and inserting there would put the newline
      // character outside it. Once two children sit directly beneath the `pre`, later input piles up there as
      // well, so the range is moved in first.
      placeRangeInEmptyCode(root, range);
      const inserted = insertTextAtRange(range, '\n');
      if (inserted === undefined) {
        return 'edited';
      }
      // A newline that ends up as the last character of the content forms no line, so a second one is added after it
      // and the caret goes between the two.
      const offset = appendDisplayLineBreak(inserted);
      if (offset < inserted.data.length) {
        // Align the range the input dispatcher carries around with the caret that is placed.
        range.setStart(inserted, offset);
        range.collapse(true);
      }
      placeCaret(inserted, offset);
      return 'edited';
    }

    if (isSplittableBlock(target)) {
      // Apply the preprocessors before the start, end and middle checks. splitBlock redoes the checks at the position they shifted to.
      const preparation = prepareSplit(target, range, hooks?.splitPreprocessors ?? []);
      if (preparation.kind === 'takenOver') {
        placeCaret(range.startContainer, range.startOffset);
        return preparation.changed || deletesRange ? 'edited' : 'consumed';
      }
      placeCaretAtStart(splitBlock(target, range));
      return 'edited';
    }

    // Cells and summaries cannot be split, so insert an in-block break to preserve structure. A bare blockquote
    // cannot be split either, but never reaches here: its own rule takes over Enter with no range selected, and
    // with a range selected the range is deleted above before this branch is entered.
    const lineBreak = root.ownerDocument.createElement('br');
    range.insertNode(lineBreak);
    range.setStartAfter(lineBreak);
    range.collapse(true);
    placeCaret(range.startContainer, range.startOffset);
    return 'edited';
  };
}
