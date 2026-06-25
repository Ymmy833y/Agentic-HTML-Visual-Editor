import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  DEBOUNCE_MS,
  focusEditor,
  getEditMessages,
  mountEditor,
  selectTextInside,
} from './helpers/page';

// Collapse the caret at a character offset inside the first text node of a
// comment's target (the editable text before <comment-body>).
async function caretInCommentTarget(page: Page, offset: number): Promise<void> {
  await page.evaluate((offset) => {
    const comment = document.querySelector('#ahve-root comment');
    if (!comment) throw new Error('no comment');
    const target = comment.firstChild;
    if (!target) throw new Error('comment has no target text');
    const r = document.createRange();
    r.setStart(target, offset);
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  }, offset);
}

test.describe('Comment', () => {
  test('clicking Comment in the floating menu wraps the selection and opens the popup', async ({ page }) => {
    await mountEditor(page, '<p>hello world that is long enough</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);

    await page.locator('#ahve-floating-menu button', { hasText: /^Comment$/ }).click();

    const comment = page.locator('#ahve-root comment');
    await expect(comment).toHaveCount(1);
    await expect(comment).toHaveText('hello');
    await expect(comment).toHaveAttribute('id', /^c-[a-z0-9]+$/);

    const popup = page.locator('#ahve-comment-popup');
    await expect(popup).toBeVisible();
    await expect(popup.locator('.ahve-cp-body-display')).toHaveText('Add a comment');
  });

  test('typing a body and pressing Enter saves it under <comment-body>', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);
    await page.locator('#ahve-floating-menu button', { hasText: /^Comment$/ }).click();

    const popup = page.locator('#ahve-comment-popup');
    await popup.locator('.ahve-cp-body-display').click();
    await popup.locator('textarea.ahve-cp-body-input').fill('great point');
    await popup.locator('textarea.ahve-cp-body-input').press('Enter');

    const body = page.locator('#ahve-root comment > comment-body');
    await expect(body).toHaveText('great point');
    await expect(popup.locator('.ahve-cp-body-display')).toHaveText('great point');
  });

  test('replies are stored as <comment-reply> children and listed in the popup', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);
    await page.locator('#ahve-floating-menu button', { hasText: /^Comment$/ }).click();

    const popup = page.locator('#ahve-comment-popup');
    const replyInput = popup.locator('textarea.ahve-cp-reply-input');
    await replyInput.fill('first reply');
    await replyInput.press('Enter');
    await replyInput.fill('second reply');
    await replyInput.press('Enter');

    const replies = page.locator('#ahve-root comment > comment-reply');
    await expect(replies).toHaveCount(2);
    await expect(replies.nth(0)).toHaveText('first reply');
    await expect(replies.nth(1)).toHaveText('second reply');

    const replyRows = popup.locator('.ahve-cp-reply-row .ahve-cp-reply-display');
    await expect(replyRows).toHaveCount(2);
  });

  test('clicking a reply delete button removes it from the comment', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);
    await page.locator('#ahve-floating-menu button', { hasText: /^Comment$/ }).click();

    const popup = page.locator('#ahve-comment-popup');
    const replyInput = popup.locator('textarea.ahve-cp-reply-input');
    await replyInput.fill('only reply');
    await replyInput.press('Enter');

    await expect(page.locator('#ahve-root comment > comment-reply')).toHaveCount(1);
    // The delete button is hidden until hover, but click() forces it.
    await popup.locator('.ahve-cp-reply-row .ahve-cp-reply-del').click();
    await expect(page.locator('#ahve-root comment > comment-reply')).toHaveCount(0);
  });

  test('the trash button deletes the whole comment and closes the popup', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);
    await page.locator('#ahve-floating-menu button', { hasText: /^Comment$/ }).click();

    const popup = page.locator('#ahve-comment-popup');
    await expect(popup).toBeVisible();

    await popup.locator('.ahve-cp-btn', { hasText: '🗑' }).click();

    await expect(popup).toBeHidden();
    await expect(page.locator('#ahve-root comment')).toHaveCount(0);
    await expect(page.locator('#ahve-root p')).toHaveText('hello world');
  });

  test('does not nest a comment when the selection is inside an existing comment', async ({ page }) => {
    await mountEditor(
      page,
      '<p>hi <comment id="c-existing">target<comment-body>note</comment-body></comment> bye</p>',
    );
    await focusEditor(page);
    // Select part of the existing comment's target text.
    await selectTextInside(page, '#ahve-root comment', 0, 3);

    await page.locator('#ahve-floating-menu button', { hasText: /^Comment$/ }).click();

    // No new comment was created and the popup did not open.
    await expect(page.locator('#ahve-root comment')).toHaveCount(1);
    await expect(page.locator('#ahve-comment-popup')).toBeHidden();
  });

  test('does not create a comment that would wrap an existing one', async ({ page }) => {
    await mountEditor(
      page,
      '<p>aa <comment id="c-existing">mid<comment-body>note</comment-body></comment> bb</p>',
    );
    await focusEditor(page);
    // Select from the leading text, across the comment, into the trailing text.
    await page.evaluate(() => {
      const p = document.querySelector('#ahve-root p')!;
      const range = document.createRange();
      range.setStart(p.firstChild!, 1); // inside "aa "
      range.setEnd(p.lastChild!, 2); // inside " bb"
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    await page.locator('#ahve-floating-menu button', { hasText: /^Comment$/ }).click();

    await expect(page.locator('#ahve-root comment')).toHaveCount(1);
    await expect(page.locator('#ahve-comment-popup')).toBeHidden();
  });

  test('does not add a comment when the selection spans two paragraphs', async ({ page }) => {
    await mountEditor(page, '<p>first paragraph</p><p>second paragraph</p>');
    await focusEditor(page);
    await page.evaluate(() => {
      const ps = document.querySelectorAll('#ahve-root p');
      const range = document.createRange();
      range.setStart(ps[0].firstChild!, 0);
      range.setEnd(ps[1].firstChild!, 6);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    await page.locator('#ahve-floating-menu button', { hasText: /^Comment$/ }).click();

    await expect(page.locator('#ahve-root comment')).toHaveCount(0);
    await expect(page.locator('#ahve-comment-popup')).toBeHidden();
  });

  test('clicking an existing comment highlight reopens the popup with its body', async ({ page }) => {
    await mountEditor(
      page,
      '<p>hi <comment id="c-existing">target<comment-body>note</comment-body></comment> bye</p>',
    );
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    await expect(popup).toBeVisible();
    await expect(popup.locator('.ahve-cp-body-display')).toHaveText('note');
  });

  test('comments work for text inside a table cell', async ({ page }) => {
    await mountEditor(
      page,
      '<table><tbody><tr><td>cell content</td></tr></tbody></table>',
    );
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root td', 0, 4);
    await page.locator('#ahve-floating-menu button', { hasText: /^Comment$/ }).click();

    const comment = page.locator('#ahve-root td > comment');
    await expect(comment).toHaveCount(1);
    await expect(comment).toHaveText('cell');
    await expect(page.locator('#ahve-comment-popup')).toBeVisible();
  });

  test('arrow buttons navigate between comments in document order', async ({ page }) => {
    await mountEditor(
      page,
      '<p><comment id="c-1">one<comment-body>first</comment-body></comment></p>' +
        '<p><comment id="c-2">two<comment-body>second</comment-body></comment></p>',
    );
    await page.locator('#ahve-root comment').first().click();
    const popup = page.locator('#ahve-comment-popup');
    await expect(popup.locator('.ahve-cp-body-display')).toHaveText('first');
    await popup.locator('.ahve-cp-btn', { hasText: '↓' }).click();
    await expect(popup.locator('.ahve-cp-body-display')).toHaveText('second');
    await popup.locator('.ahve-cp-btn', { hasText: '↑' }).click();
    await expect(popup.locator('.ahve-cp-body-display')).toHaveText('first');
  });

  test('a human-created comment records author and timestamp metadata', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);
    await page.locator('#ahve-floating-menu button', { hasText: /^Comment$/ }).click();

    const popup = page.locator('#ahve-comment-popup');
    await popup.locator('.ahve-cp-body-display').click();
    await popup.locator('textarea.ahve-cp-body-input').fill('great point');
    await popup.locator('textarea.ahve-cp-body-input').press('Enter');

    const body = page.locator('#ahve-root comment > comment-body');
    await expect(body).toHaveAttribute('data-author', 'human');
    await expect(body).toHaveAttribute('data-updated', /^\d{4}-\d{2}-\d{2}T/);
    await expect(popup.locator('.ahve-cp-meta').first()).toContainText('Human');
  });

  test('the resolve toggle adds and removes data-resolved on the comment', async ({ page }) => {
    await mountEditor(
      page,
      '<p><comment id="c-r">target<comment-body data-author="human">note</comment-body></comment></p>',
    );
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    const resolveBtn = popup.locator('.ahve-cp-btn', { hasText: '✓' });

    await resolveBtn.click();
    await expect(page.locator('#ahve-root comment')).toHaveAttribute('data-resolved', '');
    await resolveBtn.click();
    await expect(page.locator('#ahve-root comment')).not.toHaveAttribute('data-resolved', '');
  });

  test('editing an AI-authored body asks for confirmation; cancel keeps it', async ({ page }) => {
    await mountEditor(
      page,
      '<p>hi <comment id="c-ai">target<comment-body data-author="ai" data-updated="2026-06-18T09:00:00Z">ai note</comment-body></comment> bye</p>',
    );
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    await popup.locator('.ahve-cp-body-display').click();

    const dialog = page.locator('.ahve-dialog-overlay');
    await expect(dialog).toBeVisible();
    await dialog.locator('button', { hasText: 'Cancel' }).click();

    await expect(dialog).toHaveCount(0);
    // No edit textarea opened and the AI note is untouched.
    await expect(popup.locator('textarea.ahve-cp-body-input')).toHaveCount(0);
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveText('ai note');
  });

  test('confirming lets the human edit the AI-authored body', async ({ page }) => {
    await mountEditor(
      page,
      '<p>hi <comment id="c-ai">target<comment-body data-author="ai" data-updated="2026-06-18T09:00:00Z">ai note</comment-body></comment> bye</p>',
    );
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    await popup.locator('.ahve-cp-body-display').click();

    await page.locator('.ahve-dialog-overlay button', { hasText: 'Edit' }).click();
    const input = popup.locator('textarea.ahve-cp-body-input');
    await expect(input).toBeVisible();
    await input.fill('human revised');
    await input.press('Enter');

    const body = page.locator('#ahve-root comment > comment-body');
    await expect(body).toHaveText('human revised');
    // Author attribution stays with the original AI author.
    await expect(body).toHaveAttribute('data-author', 'ai');
  });

  test('deleting an AI-authored reply asks for confirmation; cancel keeps it', async ({ page }) => {
    await mountEditor(
      page,
      '<p>hi <comment id="c-ai">target<comment-body data-author="human">note</comment-body>' +
        '<comment-reply data-author="ai" data-updated="2026-06-18T09:00:00Z">ai reply</comment-reply></comment> bye</p>',
    );
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    await popup.locator('.ahve-cp-reply-row .ahve-cp-reply-del').click();

    const dialog = page.locator('.ahve-dialog-overlay');
    await expect(dialog).toBeVisible();
    await dialog.locator('button', { hasText: 'Cancel' }).click();
    await expect(page.locator('#ahve-root comment > comment-reply')).toHaveCount(1);
  });

  test('AI-authored comments render in a different highlight colour than human ones', async ({ page }) => {
    await mountEditor(
      page,
      '<p><comment id="c-h">human<comment-body data-author="human">h</comment-body></comment> ' +
        '<comment id="c-a">ai<comment-body data-author="ai">a</comment-body></comment></p>',
    );
    const humanBg = await page
      .locator('#ahve-root comment#c-h')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const aiBg = await page
      .locator('#ahve-root comment#c-a')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(humanBg).not.toBe(aiBg);
  });
});

// Editing in and around an inline <comment> must never corrupt it: the browser
// default contenteditable split/merge would otherwise cut through the comment
// (whose <comment-body> is contenteditable=false), losing the target text or
// body and duplicating the id. See keepCommentWholeOnEnter in editor-core and
// the COMMENT guard in serialize.
test.describe('Comment editing keeps comments intact', () => {
  const SAMPLE =
    '<p>This is sample <comment id="c-gsb0lvjq">text' +
    '<comment-body contenteditable="false" data-author="human" data-updated="2026-06-24T10:05:36.074Z">This is comment</comment-body>' +
    '</comment>.</p>';

  // Structured snapshot of the comment state, read from the live DOM.
  async function readState(page: Page) {
    return page.evaluate(() => {
      const root = document.querySelector('#ahve-root')!;
      const ps = Array.from(root.querySelectorAll(':scope > p'));
      const comments = Array.from(root.querySelectorAll('comment'));
      const c = comments[0] as HTMLElement | undefined;
      const target = c && c.firstChild && c.firstChild.nodeType === Node.TEXT_NODE
        ? c.firstChild.textContent
        : null;
      const body = c?.querySelector('comment-body') ?? null;
      return {
        pCount: ps.length,
        commentCount: comments.length,
        commentId: c?.getAttribute('id') ?? null,
        targetText: target,
        bodyText: body?.textContent ?? null,
        bodyAuthor: body?.getAttribute('data-author') ?? null,
        firstPHasComment: c ? (ps[0]?.contains(c) ?? false) : false,
        lastPText: ps[ps.length - 1]?.textContent ?? null,
      };
    });
  }

  test('Enter at the end of comment target keeps the comment whole and typing lands outside it (bug ①)', async ({ page }) => {
    await mountEditor(page, SAMPLE);
    await focusEditor(page);
    await caretInCommentTarget(page, 'text'.length); // caret right after "text"

    await page.keyboard.press('Enter');
    await page.keyboard.type('a');

    await expect(page.locator('#ahve-root > p')).toHaveCount(2);
    const state = await readState(page);
    expect(state.commentCount).toBe(1);
    expect(state.commentId).toBe('c-gsb0lvjq');
    expect(state.targetText).toBe('text');
    expect(state.bodyText).toBe('This is comment');
    expect(state.bodyAuthor).toBe('human');
    expect(state.firstPHasComment).toBe(true);
    // The typed "a" landed in the new paragraph, not inside the comment body.
    expect(state.lastPText).toBe('a.');
  });

  test('Enter in the middle of comment target does not split the comment', async ({ page }) => {
    await mountEditor(page, SAMPLE);
    await focusEditor(page);
    await caretInCommentTarget(page, 2); // "te|xt"

    await page.keyboard.press('Enter');

    const state = await readState(page);
    expect(state.commentCount).toBe(1);
    expect(state.targetText).toBe('text'); // target text not cut
    expect(state.bodyText).toBe('This is comment');
  });

  test('Enter at the start of comment target leaves the comment on the current line', async ({ page }) => {
    await mountEditor(page, SAMPLE);
    await focusEditor(page);
    await caretInCommentTarget(page, 0); // before the first char of "text"

    await page.keyboard.press('Enter');

    const state = await readState(page);
    expect(state.commentCount).toBe(1);
    expect(state.targetText).toBe('text');
    expect(state.firstPHasComment).toBe(true); // comment stayed on the current (first) line
  });

  test('the comment survives serialization to the host after an Enter near it (bug ②)', async ({ page }) => {
    await mountEditor(page, SAMPLE);
    await focusEditor(page);
    await caretInCommentTarget(page, 'text'.length);

    await page.keyboard.press('Enter');
    await page.keyboard.type('a');

    await page.waitForTimeout(DEBOUNCE_MS + 100);
    const edits = await getEditMessages(page);
    expect(edits.length).toBeGreaterThan(0);
    const html = edits[edits.length - 1].html;
    expect(html).toContain('id="c-gsb0lvjq"');
    expect(html).toContain('This is comment');
    expect(html).toContain('data-author="human"');
    // Exactly one <comment> element in the serialized output (no duplicate id).
    // `[\s>]` avoids matching the <comment-body> child tag.
    expect(html.match(/<comment[\s>]/g)?.length).toBe(1);
  });

  test('Backspace just after a comment does not delete its body', async ({ page }) => {
    await mountEditor(
      page,
      '<p>a <comment id="c1">text<comment-body data-author="human">note</comment-body></comment> b</p>',
    );
    await focusEditor(page);
    // Caret at the start of the " b" text node that follows the comment.
    await page.evaluate(() => {
      const comment = document.querySelector('#ahve-root comment')!;
      const after = comment.nextSibling!;
      const r = document.createRange();
      r.setStart(after, 0);
      r.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
    });

    await page.keyboard.press('Backspace');

    const comment = page.locator('#ahve-root comment');
    await expect(comment).toHaveCount(1);
    await expect(comment.locator('comment-body')).toHaveText('note');
  });

  test('Delete just before a comment does not delete its body', async ({ page }) => {
    await mountEditor(
      page,
      '<p>a <comment id="c1">text<comment-body data-author="human">note</comment-body></comment> b</p>',
    );
    await focusEditor(page);
    // Caret at the end of the "a " text node that precedes the comment.
    await page.evaluate(() => {
      const comment = document.querySelector('#ahve-root comment')!;
      const before = comment.previousSibling!;
      const r = document.createRange();
      r.setStart(before, before.textContent!.length);
      r.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
    });

    await page.keyboard.press('Delete');

    const comment = page.locator('#ahve-root comment');
    await expect(comment).toHaveCount(1);
    await expect(comment.locator('comment-body')).toHaveText('note');
  });

  test('Enter then Backspace re-merges the heading without losing the comment or injecting a style span (bug ③)', async ({ page }) => {
    await mountEditor(
      page,
      '<h2>Head<comment id="c-z8tsbr26">in' +
        '<comment-body contenteditable="false" data-author="human" data-updated="2026-06-24T11:18:44.358Z">ほげ</comment-body>' +
        '</comment>gs</h2>',
    );
    await focusEditor(page);

    // 1) Enter right after "in": keepCommentWholeOnEnter moves "gs" to a new <h2>.
    await caretInCommentTarget(page, 'in'.length);
    await page.keyboard.press('Enter');
    await expect(page.locator('#ahve-root > h2')).toHaveCount(2);

    // 2) Backspace at the start of the "gs" line merges it back into the heading.
    await page.evaluate(() => {
      const second = document.querySelectorAll('#ahve-root > h2')[1];
      const r = document.createRange();
      r.setStart(second, 0);
      r.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
    });
    await page.keyboard.press('Backspace');

    // The two headings re-merge into one, with the comment and its body intact.
    await expect(page.locator('#ahve-root > h2')).toHaveCount(1);
    const comment = page.locator('#ahve-root comment');
    await expect(comment).toHaveCount(1);
    await expect(comment).toHaveAttribute('id', 'c-z8tsbr26');
    await expect(comment.locator('comment-body')).toHaveText('ほげ');
    // "gs" is plain heading text again — no <span style="font-size"> overlay.
    await expect(page.locator('#ahve-root > h2 span')).toHaveCount(0);
    const h2Html = await page.locator('#ahve-root > h2').innerHTML();
    expect(h2Html).not.toContain('font-size');
    expect(h2Html).toContain('gs');

    // A subsequent edit still serializes a single, intact comment to the host
    // (Enter+Backspace alone round-trips to the original, so it is deduped — type
    // a character to force a fresh edit message).
    await page.keyboard.type('x');
    await page.waitForTimeout(DEBOUNCE_MS + 100);
    const edits = await getEditMessages(page);
    expect(edits.length).toBeGreaterThan(0);
    const html = edits[edits.length - 1].html;
    expect(html).toContain('id="c-z8tsbr26"');
    expect(html).toContain('ほげ');
    expect(html).not.toContain('font-size');
    expect(html.match(/<comment[\s>]/g)?.length).toBe(1);
  });

  test('Delete at the comment trailing edge removes the next visible char, not the body (bug ④)', async ({ page }) => {
    await mountEditor(
      page,
      '<h2>Hea<comment id="c-5m4ikno2">di' +
        '<comment-body contenteditable="false" data-author="human" data-updated="2026-06-25T11:19:48.504Z">Comment</comment-body>' +
        '</comment>ng</h2>',
    );
    await focusEditor(page);

    // Caret at the comment's internal trailing edge (after the display:none body),
    // i.e. visually just before "n". The metadata must be skipped.
    await page.evaluate(() => {
      const comment = document.querySelector('#ahve-root comment')!;
      const r = document.createRange();
      r.setStart(comment, comment.childNodes.length);
      r.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
    });
    await page.keyboard.press('Delete');

    const comment = page.locator('#ahve-root comment');
    await expect(comment).toHaveCount(1);
    await expect(comment).toHaveAttribute('id', 'c-5m4ikno2');
    await expect(comment.locator('comment-body')).toHaveText('Comment'); // body survives
    // The comment target is untouched and only the following "n" was removed.
    const h2Text = await page.locator('#ahve-root > h2').evaluate((el) => {
      const c = el.querySelector('comment')!;
      return {
        target: c.firstChild?.textContent ?? null,
        after: c.nextSibling?.textContent ?? null,
      };
    });
    expect(h2Text.target).toBe('di');
    expect(h2Text.after).toBe('g');

    // The serialized edit keeps a single, intact comment with its body.
    await page.waitForTimeout(DEBOUNCE_MS + 100);
    const edits = await getEditMessages(page);
    const html = edits[edits.length - 1].html;
    expect(html).toContain('id="c-5m4ikno2"');
    expect(html).toContain('Comment');
    expect(html.match(/<comment[\s>]/g)?.length).toBe(1);
  });
});
