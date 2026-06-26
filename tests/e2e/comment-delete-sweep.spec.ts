import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { focusEditor, mountEditor } from './helpers/page';

// Exhaustive caret sweep around an inline <comment>. The comment's metadata
// (<comment-body>/<comment-reply>) is display:none + contenteditable=false, so
// the browser default deletion repeatedly mistakes it for "the next thing to
// delete" and wipes it out as collateral. This sweep is the permanent net: for
// every caret position in and around the comment, neither Backspace nor Delete
// may ever destroy the comment or its body. A single keystroke from any of
// these positions never empties the 2-char target, so the comment must always
// survive with its body intact.
test.describe('Comment delete sweep — body must survive every Backspace/Delete', () => {
  const SAMPLE =
    '<h2>Hea<comment id="c-sweep01">di' +
    '<comment-body contenteditable="false" data-author="human" data-updated="2026-06-25T10:00:00.000Z">Comment</comment-body>' +
    '</comment>ng</h2>';

  // Collapsed-caret positions, named by where they sit relative to the comment.
  const POSITIONS = [
    'hea-start', // start of "Hea"
    'hea-mid', // "He|a"
    'before-comment', // "Hea|" — block text right before the comment
    'target-start', // inside comment, before "di"
    'target-mid', // inside comment, "d|i"
    'target-end-text', // inside comment, "di|" (text-node level)
    'target-end-elem', // inside comment, after "di" before the body (element offset)
    'comment-trailing-edge', // inside comment, after the (display:none) body
    'block-after-comment', // block level, right after </comment>
    'after-comment-text', // "|ng" (text-node level, just after the comment)
    'ng-mid', // "n|g"
    'ng-end', // "ng|"
  ] as const;

  type Position = (typeof POSITIONS)[number];

  async function placeCaret(page: Page, where: Position): Promise<void> {
    await page.evaluate((where) => {
      const root = document.querySelector('#ahve-root')!;
      const h2 = root.querySelector('h2')!;
      const comment = root.querySelector('comment')!;
      const hea = h2.firstChild!; // text "Hea"
      const di = comment.firstChild!; // text "di"
      const ng = comment.nextSibling!; // text "ng"
      const set = (node: Node, off: number): void => {
        const r = document.createRange();
        r.setStart(node, off);
        r.collapse(true);
        const s = window.getSelection()!;
        s.removeAllRanges();
        s.addRange(r);
      };
      const indexIn = (parent: Node, child: Node): number =>
        Array.prototype.indexOf.call(parent.childNodes, child);
      switch (where) {
        case 'hea-start': return set(hea, 0);
        case 'hea-mid': return set(hea, 2);
        case 'before-comment': return set(hea, 3);
        case 'target-start': return set(di, 0);
        case 'target-mid': return set(di, 1);
        case 'target-end-text': return set(di, 2);
        case 'target-end-elem': return set(comment, 1);
        case 'comment-trailing-edge': return set(comment, comment.childNodes.length);
        case 'block-after-comment': return set(h2, indexIn(h2, comment) + 1);
        case 'after-comment-text': return set(ng, 0);
        case 'ng-mid': return set(ng, 1);
        case 'ng-end': return set(ng, 2);
      }
    }, where);
  }

  for (const where of POSITIONS) {
    for (const key of ['Backspace', 'Delete'] as const) {
      test(`${key} at ${where} keeps the comment and its body`, async ({ page }) => {
        await mountEditor(page, SAMPLE);
        await focusEditor(page);
        await placeCaret(page, where);
        await page.keyboard.press(key);

        const comment = page.locator('#ahve-root comment');
        await expect(comment).toHaveCount(1);
        await expect(comment).toHaveAttribute('id', 'c-sweep01');
        // The body is never collateral-deleted.
        await expect(comment.locator('comment-body')).toHaveText('Comment');
        await expect(comment.locator('comment-body')).toHaveAttribute('data-author', 'human');
        // Comments never end up nested inside one another.
        await expect(page.locator('#ahve-root comment comment')).toHaveCount(0);
      });
    }
  }
});
