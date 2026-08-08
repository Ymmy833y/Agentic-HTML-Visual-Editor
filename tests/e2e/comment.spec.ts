import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  caretAtStart,
  focusEditor,
  getRootHtml,
  mountEditor,
  saveAndGetHtml,
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
    // A new comment opens straight in body-edit mode with the editor focused.
    const bodyInput = popup.locator('textarea.ahve-cp-body-input');
    await expect(bodyInput).toBeVisible();
    await expect(bodyInput).toBeFocused();
  });

  test('typing a body and pressing Enter saves it under <comment-body>', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);
    await page.locator('#ahve-floating-menu button', { hasText: /^Comment$/ }).click();

    const popup = page.locator('#ahve-comment-popup');
    // The body editor is already focused on creation — type with no click.
    await expect(popup.locator('textarea.ahve-cp-body-input')).toBeFocused();
    await page.keyboard.type('great point');
    await page.keyboard.press('Enter');

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
    await expect(popup.locator('textarea.ahve-cp-body-input')).toBeFocused();
    await page.keyboard.type('great point');
    await page.keyboard.press('Enter');

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

  // The caret is tinted in the author colour while it edits inside a comment and
  // reverts to the default outside, so the visually-identical inside-end and
  // just-outside positions are told apart by colour without any added spacing.
  test('the caret is tinted inside a comment and default outside, by author colour', async ({ page }) => {
    await mountEditor(
      page,
      '<p>plain <comment id="c-h">human<comment-body data-author="human">h</comment-body></comment> ' +
        '<comment id="c-a">ai<comment-body data-author="ai">a</comment-body></comment></p>',
    );
    const caretColorOf = (selector: string) =>
      page.locator(selector).evaluate((el) => getComputedStyle(el).caretColor);

    const outside = await caretColorOf('#ahve-root p');
    const human = await caretColorOf('#ahve-root comment#c-h');
    const ai = await caretColorOf('#ahve-root comment#c-a');

    // Inside (either author) differs from outside: the colour shift is the cue.
    expect(human).not.toBe(outside);
    expect(ai).not.toBe(outside);
    // Human vs AI carets use their own author hues.
    expect(human).not.toBe(ai);
  });

  test('closing the popup with Escape clears a tooltip anchored to its buttons', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);
    await page.locator('#ahve-floating-menu button', { hasText: /^Comment$/ }).click();

    const popup = page.locator('#ahve-comment-popup');
    await expect(popup).toBeVisible();

    await popup.locator('button', { hasText: '↑' }).hover();
    const tooltip = page.locator('#ahve-tooltip');
    await expect(tooltip).toHaveText('Previous comment');
    await expect(tooltip).toHaveClass(/ahve-tooltip-visible/);

    // Escape cancels the auto-opened body edit AND closes the popup while
    // the pointer still rests on the button; mouseleave never fires on the
    // hidden popup, so close() must clear the tooltip itself.
    await page.keyboard.press('Escape');

    await expect(popup).toBeHidden();
    await expect(tooltip).not.toHaveClass(/ahve-tooltip-visible/);
  });
});

// Editing in and around an inline <comment> must never corrupt it: the browser
// default contenteditable split/merge would otherwise cut through the comment
// (whose <comment-body> is contenteditable=false), losing the target text or
// body and duplicating the id. See keepCommentWholeOnEnter in
// features/comment/comment-boundary and the COMMENT guard in serialize.
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

    const html = await saveAndGetHtml(page);
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

    // A subsequent edit still serializes a single, intact comment on save.
    await page.keyboard.type('x');
    const html = await saveAndGetHtml(page);
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

    // The serialized save keeps a single, intact comment with its body.
    const html = await saveAndGetHtml(page);
    expect(html).toContain('id="c-5m4ikno2"');
    expect(html).toContain('Comment');
    expect(html.match(/<comment[\s>]/g)?.length).toBe(1);
  });
});

// The end of a comment's target text (inside) and the position just after
// </comment> (outside) render at the same spot because the <comment-body> is
// display:none. ArrowRight steps the caret outside so the next character is
// typed after the comment; ArrowLeft steps back inside. See
// handleCommentArrowRight / handleBoundaryInsert in
// features/comment/comment-boundary.
test.describe('Comment inside/outside typing', () => {
  // A comment sitting at the very end of its block (nothing after </comment>).
  const TAIL =
    '<p>Sample <comment id="c-tail01">text' +
    '<comment-body contenteditable="false" data-author="human" data-updated="2026-06-26T00:00:00.000Z">Comment</comment-body>' +
    '</comment></p>';

  async function tailState(page: Page) {
    return page.evaluate(() => {
      const root = document.querySelector('#ahve-root')!;
      const p = root.querySelector('p')!;
      const comment = root.querySelector('comment');
      const body = comment?.querySelector('comment-body') ?? null;
      const next = comment?.nextSibling ?? null;
      const outsideText =
        next && next.nodeType === Node.TEXT_NODE ? next.textContent : null;
      return {
        commentCount: root.querySelectorAll('comment').length,
        nestedCount: root.querySelectorAll('comment comment').length,
        commentId: comment?.getAttribute('id') ?? null,
        target: comment?.firstChild?.textContent ?? null,
        bodyText: body?.textContent ?? null,
        outsideText,
        commentInsideP: comment ? p.contains(comment) : false,
      };
    });
  }

  test('ArrowRight then typing lands after the comment, not inside it', async ({ page }) => {
    await mountEditor(page, TAIL);
    await focusEditor(page);
    await caretInCommentTarget(page, 'text'.length); // caret right after "text"

    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('abc');

    const state = await tailState(page);
    expect(state.commentCount).toBe(1);
    expect(state.nestedCount).toBe(0);
    expect(state.commentId).toBe('c-tail01');
    expect(state.target).toBe('text'); // comment target unchanged
    expect(state.bodyText).toBe('Comment'); // body intact
    expect(state.outsideText).toBe('abc'); // typed text is a sibling after </comment>
    expect(state.commentInsideP).toBe(true);

    // The serialized save places the text outside the comment.
    const html = await saveAndGetHtml(page);
    expect(html).toContain('</comment>abc</p>');
    expect(html.match(/<comment[\s>]/g)?.length).toBe(1);
  });

  test('stepping outside resets the caret to the default colour, and the marker never serializes', async ({ page }) => {
    await mountEditor(page, TAIL);
    await focusEditor(page);
    await caretInCommentTarget(page, 'text'.length);

    const comment = page.locator('#ahve-root comment');
    const caretColorOf = (selector: string) =>
      page.locator(selector).evaluate((el) => getComputedStyle(el).caretColor);

    // The default caret colour (what plain block text uses) and the author
    // colour the comment tints the caret with while it is edited inside.
    const defaultColor = await caretColorOf('#ahve-root p');
    const insideColor = await caretColorOf('#ahve-root comment');
    expect(insideColor).not.toBe(defaultColor);

    // ArrowRight steps outside: the marker appears and resets the boundary
    // caret (painted with this comment's caret-color) back to the default.
    await page.keyboard.press('ArrowRight');
    await expect(comment).toHaveAttribute('data-ahve-caret-outside', '');
    expect(await caretColorOf('#ahve-root comment')).toBe(defaultColor);

    // ArrowLeft steps back inside: the marker clears and the author colour returns.
    await page.keyboard.press('ArrowLeft');
    await expect(comment).not.toHaveAttribute('data-ahve-caret-outside', '');
    expect(await caretColorOf('#ahve-root comment')).toBe(insideColor);

    // The marker is UI-only and must never reach the saved file.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('z');
    const html = await saveAndGetHtml(page);
    expect(html).not.toContain('data-ahve-caret-outside');
    expect(html).toContain('</comment>z</p>');
  });

  test('ArrowLeft after stepping out re-enters the comment so typing appends to the target', async ({ page }) => {
    await mountEditor(page, TAIL);
    await focusEditor(page);
    await caretInCommentTarget(page, 'text'.length);

    await page.keyboard.press('ArrowRight'); // step outside
    await page.keyboard.press('ArrowLeft'); // step back inside
    await page.keyboard.type('Z');

    const state = await tailState(page);
    expect(state.commentCount).toBe(1);
    expect(state.target).toBe('textZ'); // appended inside the comment
    expect(state.bodyText).toBe('Comment');
    expect(state.outsideText).toBeNull(); // nothing outside the comment
  });

  // Every caret position that renders at the comment's trailing edge must, after
  // ArrowRight, type the next character OUTSIDE the comment while the comment and
  // its body survive — mirroring the delete sweep's exhaustive coverage.
  const TRAILING_EDGE = [
    'target-end-text', // inside, "text|" at the text-node level
    'comment-trailing-edge', // inside, after the (display:none) body
  ] as const;

  for (const where of TRAILING_EDGE) {
    test(`ArrowRight + type from ${where} inserts outside and keeps the comment`, async ({ page }) => {
      await mountEditor(page, TAIL);
      await focusEditor(page);
      await page.evaluate((where) => {
        const comment = document.querySelector('#ahve-root comment')!;
        const r = document.createRange();
        if (where === 'target-end-text') {
          r.setStart(comment.firstChild!, comment.firstChild!.textContent!.length);
        } else {
          r.setStart(comment, comment.childNodes.length);
        }
        r.collapse(true);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
      }, where);

      await page.keyboard.press('ArrowRight');
      await page.keyboard.type('Q');

      const state = await tailState(page);
      expect(state.commentCount).toBe(1);
      expect(state.nestedCount).toBe(0);
      expect(state.target).toBe('text');
      expect(state.bodyText).toBe('Comment');
      expect(state.outsideText).toBe('Q');
    });
  }
});

// A long comment thread must not overflow the viewport: once the popup reaches
// the height cap it scrolls its middle (body + replies) while the header and the
// reply input stay pinned, so the reply box is always reachable and new replies
// can still be entered. Layout/overflow can only be proven in a real browser.
test.describe('Comment popup scrolls when the thread is taller than the viewport', () => {
  // Add `count` replies through the popup's reply input, one Enter each.
  async function addReplies(page: Page, count: number): Promise<void> {
    const input = page.locator('#ahve-comment-popup textarea.ahve-cp-reply-input');
    for (let i = 0; i < count; i++) {
      await input.fill(`reply number ${i + 1}`);
      await input.press('Enter');
    }
    await expect(page.locator('#ahve-root comment > comment-reply')).toHaveCount(count);
  }

  test('a tall thread keeps the popup within the viewport and the reply input reachable', async ({ page }) => {
    // A short viewport so a modest number of replies is enough to overflow.
    await page.setViewportSize({ width: 800, height: 320 });
    await mountEditor(page, '<p>hello world that is long enough</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);
    await page.locator('#ahve-floating-menu button', { hasText: /^Comment$/ }).click();

    const popup = page.locator('#ahve-comment-popup');
    await expect(popup).toBeVisible();
    await addReplies(page, 20);

    const viewportH = 320;

    // 1) The popup itself never grows past the viewport height.
    const popupBox = await popup.boundingBox();
    expect(popupBox).not.toBeNull();
    expect(popupBox!.height).toBeLessThanOrEqual(viewportH);
    expect(popupBox!.y).toBeGreaterThanOrEqual(0);
    expect(popupBox!.y + popupBox!.height).toBeLessThanOrEqual(viewportH + 1);

    // 2) The reply input stays visible and fully inside the viewport, and a new
    //    reply can still be entered (the reported "cannot input" regression).
    const replyInput = popup.locator('textarea.ahve-cp-reply-input');
    await expect(replyInput).toBeVisible();
    const inputBox = await replyInput.boundingBox();
    expect(inputBox).not.toBeNull();
    expect(inputBox!.y).toBeGreaterThanOrEqual(0);
    expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(viewportH + 1);

    await replyInput.fill('added after scrolling');
    await replyInput.press('Enter');
    await expect(page.locator('#ahve-root comment > comment-reply')).toHaveCount(21);

    // 3) The middle region actually scrolls, and the header stays pinned in view.
    const content = popup.locator('.ahve-cp-content');
    const scroll = await content.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);

    const header = popup.locator('.ahve-cp-header');
    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(headerBox!.y).toBeGreaterThanOrEqual(0);
    expect(headerBox!.y + headerBox!.height).toBeLessThanOrEqual(viewportH + 1);
  });

});

// Authoritative boundary matrix: drive REAL keyboard input and assert, for every
// inside/outside × leading/trailing case, both WHERE the typed character lands in
// the DOM and the CARET COLOUR. jsdom and programmatic boundary selections cannot
// model the browser's caret normalisation/affinity, so only this real-Chromium
// matrix proves the behaviour. The caret is only ever pre-placed at a position the
// browser KEEPS (the text just before the comment for the leading edge; the target
// end for the trailing edge); the inside/outside choice is then made with a real
// arrow key, exactly as a user would.
test.describe('Comment boundary typing — real keyboard, all four cases', () => {
  const SAMPLE =
    '<p>g<comment id="c1">rap' +
    '<comment-body contenteditable="false" data-author="human" data-updated="2026-06-26T00:00:00.000Z">com</comment-body>' +
    '</comment>e</p>';

  async function readState(page: Page) {
    return page.evaluate(() => {
      const c = document.querySelector('#ahve-root comment');
      return {
        count: document.querySelectorAll('#ahve-root comment').length,
        nested: document.querySelectorAll('#ahve-root comment comment').length,
        target: c?.firstChild?.textContent ?? null,
        before: c?.previousSibling?.textContent ?? null,
        after: c?.nextSibling?.textContent ?? null,
        body: c?.querySelector('comment-body')?.textContent ?? null,
      };
    });
  }

  // Pre-place the caret at a STICKY boundary position (one the browser keeps):
  // 'before' = end of the text node just before the comment (outside, leading);
  // 'inside-end' = end of the target text (inside, trailing).
  async function placeSticky(page: Page, where: 'before' | 'inside-end') {
    await page.evaluate((where) => {
      const c = document.querySelector('#ahve-root comment')!;
      const node = where === 'before' ? c.previousSibling! : c.firstChild!;
      const r = document.createRange();
      r.setStart(node, node.textContent!.length);
      r.collapse(true);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    }, where);
  }

  const caretColor = (page: Page, selector: string) =>
    page.locator(selector).evaluate((el) => getComputedStyle(el).caretColor);

  test('leading edge, no arrow: typing lands before the comment (outside)', async ({ page }) => {
    await mountEditor(page, SAMPLE);
    await focusEditor(page);
    await placeSticky(page, 'before');

    await page.keyboard.type('b');

    const s = await readState(page);
    expect(s.count).toBe(1);
    expect(s.before).toBe('gb'); // typed outside, before the comment
    expect(s.target).toBe('rap'); // target unchanged
  });

  test('leading edge, ArrowRight: caret turns the author colour and typing lands inside the target start', async ({ page }) => {
    await mountEditor(page, SAMPLE);
    // Read the colours before any caret is placed (no marker yet): the comment
    // tints the caret with the author colour, plain block text uses the default.
    const defaultColor = await caretColor(page, '#ahve-root p');
    const authorColor = await caretColor(page, '#ahve-root comment');
    expect(authorColor).not.toBe(defaultColor);

    await focusEditor(page);
    await placeSticky(page, 'before');

    // ArrowRight signals "type inside": the caret does not move, but its colour
    // flips to the author colour (rendered via the comment's parent).
    await page.keyboard.press('ArrowRight');
    expect(await caretColor(page, '#ahve-root p')).toBe(authorColor);

    await page.keyboard.type('b');

    const s = await readState(page);
    expect(s.count).toBe(1);
    expect(s.nested).toBe(0);
    expect(s.before).toBe('g'); // text before the comment is untouched
    expect(s.target).toBe('brap'); // typed INSIDE, at the target start
    expect(s.body).toBe('com');
  });

  test('trailing edge, no arrow: typing lands inside the target end', async ({ page }) => {
    await mountEditor(page, SAMPLE);
    await focusEditor(page);
    await placeSticky(page, 'inside-end');

    await page.keyboard.type('b');

    const s = await readState(page);
    expect(s.target).toBe('rapb'); // inside, at the target end
    expect(s.after).toBe('e'); // nothing added outside
  });

  test('trailing edge, ArrowRight: caret turns default and typing lands after the comment (outside)', async ({ page }) => {
    await mountEditor(page, SAMPLE);
    await focusEditor(page);
    await placeSticky(page, 'inside-end');

    await page.keyboard.press('ArrowRight');
    // Outside: the caret reverts to the default colour.
    expect(await caretColor(page, '#ahve-root comment')).toBe(await caretColor(page, '#ahve-root p'));

    await page.keyboard.type('b');

    const s = await readState(page);
    expect(s.target).toBe('rap'); // target unchanged
    expect(s.after).toBe('be'); // typed outside, after the comment

    // Neither transient marker may reach the saved file.
    const html = await saveAndGetHtml(page);
    expect(html).not.toContain('data-ahve-caret-outside');
    expect(html).not.toContain('data-ahve-caret-inside');
  });
});

// Displayed body/reply text must be natively selectable without switching into
// edit mode: the popup's blanket mousedown-preventDefault exempts the display
// nodes, and the click that ends a drag-selection is not treated as a request
// to edit (pointer-travel check in comment-popup.ts). A plain click — including
// one that lands on text already selected — still opens the editor as before.
test.describe('Comment display text selection', () => {
  const SAMPLE =
    '<p>hi <comment id="c-sel">target' +
    '<comment-body data-author="human">selectable body text</comment-body>' +
    '<comment-reply data-author="human">selectable reply text</comment-reply>' +
    '</comment> bye</p>';

  const BODY_DISPLAY = '#ahve-comment-popup .ahve-cp-body-display';
  const REPLY_DISPLAY = '#ahve-comment-popup .ahve-cp-reply-display';

  // Drag the mouse horizontally across the element to make a text selection.
  // Both ends sit in the element's horizontal padding, so a successful drag
  // covers the whole (single-line) text.
  async function dragAcross(page: Page, selector: string): Promise<void> {
    await pressAndDragAcross(page, selector);
    await page.mouse.up();
  }

  // Same drag, but the button stays down. Use this when the selection must be
  // inspected while the display node is still mounted: releasing fires a click
  // that may open the editor, which replaces the node.
  async function pressAndDragAcross(page: Page, selector: string): Promise<void> {
    const box = await page.locator(selector).boundingBox();
    expect(box).not.toBeNull();
    const y = box!.y + box!.height / 2;
    await page.mouse.move(box!.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width - 2, y, { steps: 5 });
  }

  /** The selected text, plus whether the selection lives inside `selector`. */
  function selectionIn(page: Page, selector: string): Promise<{ text: string; inside: boolean }> {
    return page.evaluate((selector) => {
      const el = document.querySelector(selector);
      // Fail loudly instead of reporting "nothing selected": a node that was
      // replaced by an editor must never make a not-selected assertion pass.
      if (!el) throw new Error(`selectionIn: no element matches ${selector}`);
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return { text: '', inside: false };
      return {
        text: sel.toString(),
        inside: el.contains(sel.anchorNode) && el.contains(sel.focusNode),
      };
    }, selector);
  }

  test('drag-selecting the body text keeps the selection and stays in display mode', async ({ page }) => {
    await mountEditor(page, SAMPLE);
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    const display = popup.locator('.ahve-cp-body-display');
    await expect(display).toHaveText('selectable body text');

    await dragAcross(page, BODY_DISPLAY);

    const selected = await selectionIn(page, BODY_DISPLAY);
    expect(selected.text).toBe('selectable body text');
    expect(selected.inside).toBe(true);
    // The drag did not flip the body into edit mode.
    await expect(popup.locator('textarea.ahve-cp-body-input')).toHaveCount(0);
    await expect(display).toBeVisible();
  });

  test('drag-selecting a reply keeps the selection and stays in display mode', async ({ page }) => {
    await mountEditor(page, SAMPLE);
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    const display = popup.locator('.ahve-cp-reply-display');
    await expect(display).toHaveText('selectable reply text');

    await dragAcross(page, REPLY_DISPLAY);

    const selected = await selectionIn(page, REPLY_DISPLAY);
    expect(selected.text).toBe('selectable reply text');
    expect(selected.inside).toBe(true);
    // The drag did not flip the reply into edit mode.
    await expect(popup.locator('.ahve-cp-reply-row textarea.ahve-cp-reply-input')).toHaveCount(0);
    await expect(display).toBeVisible();
  });

  test('a plain click still opens the body and reply editors', async ({ page }) => {
    await mountEditor(page, SAMPLE);
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');

    await popup.locator('.ahve-cp-body-display').click();
    const bodyInput = popup.locator('textarea.ahve-cp-body-input');
    await expect(bodyInput).toBeVisible();
    // Commit the (unchanged) body edit so the popup stays open in display mode.
    await bodyInput.press('Enter');
    await expect(popup.locator('.ahve-cp-body-display')).toBeVisible();

    await popup.locator('.ahve-cp-reply-display').click();
    await expect(popup.locator('.ahve-cp-reply-row textarea.ahve-cp-reply-input')).toBeVisible();
  });

  // Selecting text and then clicking it to edit is the natural follow-up, and
  // it is exactly where a selection-state guard would swallow the click: the
  // mousedown lands inside the existing selection, which the browser keeps
  // alive until it knows whether a drag started.
  test('clicking body text that is already selected opens the body editor', async ({ page }) => {
    await mountEditor(page, SAMPLE);
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    await dragAcross(page, BODY_DISPLAY);
    expect((await selectionIn(page, BODY_DISPLAY)).inside).toBe(true);

    await popup.locator('.ahve-cp-body-display').click();

    await expect(popup.locator('textarea.ahve-cp-body-input')).toHaveValue('selectable body text');
  });

  test('clicking a reply that is already selected opens the reply editor', async ({ page }) => {
    await mountEditor(page, SAMPLE);
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    await dragAcross(page, REPLY_DISPLAY);
    expect((await selectionIn(page, REPLY_DISPLAY)).inside).toBe(true);

    await popup.locator('.ahve-cp-reply-display').click();

    await expect(popup.locator('.ahve-cp-reply-row textarea.ahve-cp-reply-input')).toHaveValue(
      'selectable reply text',
    );
  });

  // Display-mode selection is drag-only by design: the first click of a
  // double-click opens the editor, so the word selection happens in the
  // textarea. Pinned here so the trade-off cannot change unnoticed.
  test('double-clicking the body text opens the editor without changing the body', async ({ page }) => {
    await mountEditor(page, SAMPLE);
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');

    await popup.locator('.ahve-cp-body-display').dblclick();

    await expect(popup.locator('textarea.ahve-cp-body-input')).toHaveValue('selectable body text');
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveText('selectable body text');
  });

  // A press released outside the text produces no click on it, so the recorded
  // press is never consumed. A later click with no pointer behind it (element
  // .click(), assistive activation) reports coordinates of 0 and must still
  // open the editor rather than be measured against that stale press.
  test('a coordinate-less click opens the body editor after a drag released elsewhere', async ({
    page,
  }) => {
    await mountEditor(page, SAMPLE);
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    const display = popup.locator('.ahve-cp-body-display');
    await expect(display).toHaveText('selectable body text');

    // Press on the body text, then release over the reply form at the bottom
    // of the popup: the click lands on a common ancestor, not on the text.
    await pressAndDragAcross(page, BODY_DISPLAY);
    const popupBox = await popup.boundingBox();
    expect(popupBox).not.toBeNull();
    await page.mouse.move(popupBox!.x + 8, popupBox!.y + popupBox!.height - 8, { steps: 5 });
    await page.mouse.up();
    await expect(display).toBeVisible();

    await display.dispatchEvent('click');

    await expect(popup.locator('textarea.ahve-cp-body-input')).toHaveValue('selectable body text');
  });

  test('the empty-body placeholder is not selectable and any press starts writing', async ({ page }) => {
    await mountEditor(page, '<p>hello world that is long enough</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);
    await page.locator('#ahve-floating-menu button', { hasText: /^Comment$/ }).click();
    const popup = page.locator('#ahve-comment-popup');
    const bodyInput = popup.locator('textarea.ahve-cp-body-input');
    await expect(bodyInput).toBeFocused();
    // Commit the (empty, unchanged) body so the placeholder is shown instead.
    await bodyInput.press('Enter');
    await expect(popup.locator('.ahve-cp-body-display.ahve-cp-empty')).toHaveText('Add a comment');

    // Assert mid-drag, while the placeholder is still mounted: the release
    // fires the click that opens the editor and unmounts it, and a vanished
    // node would make "not selected" true no matter what the code does.
    await pressAndDragAcross(page, BODY_DISPLAY);
    const selected = await selectionIn(page, BODY_DISPLAY);
    expect(selected.inside).toBe(false);
    expect(selected.text).not.toContain('Add a comment');

    // The press opens the body editor even though the pointer travelled.
    await page.mouse.up();
    await expect(bodyInput).toBeVisible();
  });

  // While an inline editor is open the display text is deliberately not
  // selectable: blurring the textarea mid-drag would commit it and re-render
  // the popup, moving the dragged text out from under the pointer.
  test('dragging a reply while the body editor is open commits nothing and selects nothing', async ({ page }) => {
    await mountEditor(page, SAMPLE);
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    await popup.locator('.ahve-cp-body-display').click();
    const bodyInput = popup.locator('textarea.ahve-cp-body-input');
    await bodyInput.fill('edited body');

    await dragAcross(page, REPLY_DISPLAY);

    await expect(bodyInput).toBeFocused();
    await expect(bodyInput).toHaveValue('edited body');
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveText('selectable body text');
    await expect(popup.locator('.ahve-cp-reply-row textarea.ahve-cp-reply-input')).toHaveCount(0);
    expect((await selectionIn(page, REPLY_DISPLAY)).inside).toBe(false);
  });
});

// Inline formatting over a comment that sits in a BARE root-level run — text
// directly under <body> with no block wrapper. The run is delimited by
// root-level blocks only, so it walks straight through the comment, and the
// segmentation has to split it there or the contenteditable=false body ends up
// inside the inline wrapper. The unit tests build those selections
// programmatically; only Chromium can say what Ctrl+A and Shift+Arrow really
// produce around a contenteditable=false subtree, which is the one thing a
// programmatic Range cannot stand in for.
test.describe('Inline formatting around a comment in bare root-level text', () => {
  const BODY = '<comment-body contenteditable="false">note</comment-body>';
  const COMMENT = `<comment id="c-1">tgt${BODY}</comment>`;

  /** The invariant behind every case here, asserted the same way each time. */
  async function expectCommentIntact(page: Page): Promise<void> {
    await expect(page.locator('#ahve-root strong comment-body')).toHaveCount(0);
    await expect(page.locator('#ahve-root strong comment')).toHaveCount(0);
    await expect(page.locator('#ahve-root comment')).toHaveCount(1);
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveCount(1);
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveText('note');
    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-1');
  }

  test('Ctrl+A then Ctrl+B formats around and inside the comment, never the body', async ({ page }) => {
    await mountEditor(page, `pre${COMMENT}post`);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root');

    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+b');

    await expectCommentIntact(page);
    expect(await getRootHtml(page)).toBe(
      `<strong>pre</strong><comment id="c-1"><strong>tgt</strong>${BODY}</comment><strong>post</strong>`,
    );
  });

  test('Ctrl+B twice over the whole document leaves it as it started', async ({ page }) => {
    const html = `pre${COMMENT}post`;
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root');

    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+b');
    await page.keyboard.press('Control+b');

    await expectCommentIntact(page);
    expect(await getRootHtml(page)).toBe(html);
  });

  test('a Shift+Arrow selection dragged across the comment keeps the body out', async ({ page }) => {
    // The other way a selection reaches this shape, and the one that actually
    // crosses the comment's inline boundaries key by key. Plain ArrowRight is
    // intercepted by the comment boundary handler; a shifted arrow is not, so
    // this is Chromium extending a selection over a contenteditable=false
    // subtree — the case a programmatic Range cannot reproduce.
    await mountEditor(page, `pre${COMMENT}post`);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root');

    for (let i = 0; i < 9; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Control+b');

    await expectCommentIntact(page);
    // Something was formatted — otherwise the invariant above passes vacuously.
    await expect(page.locator('#ahve-root strong')).not.toHaveCount(0);
  });

  test('a whole-document selection with a block beside the run keeps the body out', async ({ page }) => {
    // The run is the END side here, so it is the clip against the block that
    // decides how much of it each side owns.
    await mountEditor(page, `<p>x</p>pre${COMMENT}post`);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+b');

    await expectCommentIntact(page);
    expect(await getRootHtml(page)).toBe(
      '<p><strong>x</strong></p><strong>pre</strong>'
      + `<comment id="c-1"><strong>tgt</strong>${BODY}</comment><strong>post</strong>`,
    );
  });
});

// Inline formatting over a comment that lives INSIDE a block. The unit tests
// build these selections programmatically, but what Chromium actually reports
// for a selection that reaches a contenteditable=false subtree — and where
// Ctrl+A puts its boundaries — is the one thing a programmatic Range cannot
// stand in for. These are the two shapes the block-level segmentation exists
// for: a comment the selection merely passes OVER (a block covered whole), and
// one the selection ends INSIDE.
test.describe('Inline formatting around a comment inside a block', () => {
  const BODY = '<comment-body contenteditable="false">note</comment-body>';
  const COMMENT = `<comment id="c-1">tgt${BODY}</comment>`;

  /** The invariant behind every case here, asserted the same way each time. */
  async function expectCommentIntact(page: Page): Promise<void> {
    await expect(page.locator('#ahve-root strong comment-body')).toHaveCount(0);
    await expect(page.locator('#ahve-root strong comment')).toHaveCount(0);
    await expect(page.locator('#ahve-root comment')).toHaveCount(1);
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveCount(1);
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveText('note');
    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-1');
  }

  test('Ctrl+A then Ctrl+B splits a middle block at the comment it holds', async ({ page }) => {
    // The block is covered whole, so it used to contribute ONE flat segment over
    // all its children — and the wrapper took the comment and its
    // contenteditable=false body with it, straight into the saved file.
    await mountEditor(page, `<p>a</p><p>b${COMMENT}c</p><p>d</p>`);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+b');

    await expectCommentIntact(page);
    expect(await getRootHtml(page)).toBe(
      '<p><strong>a</strong></p>'
      + `<p><strong>b</strong><comment id="c-1"><strong>tgt</strong>${BODY}</comment>`
      + '<strong>c</strong></p>'
      + '<p><strong>d</strong></p>',
    );
  });

  test('Ctrl+A then Ctrl+B splits the FIRST block at the comment it holds', async ({ page }) => {
    // The other entry point into the same flat segment: the start side ran from
    // the selection start to the end of its own block's children.
    await mountEditor(page, `<p>a${COMMENT}b</p><p>d</p>`);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+b');

    await expectCommentIntact(page);
    expect(await getRootHtml(page)).toBe(
      `<p><strong>a</strong><comment id="c-1"><strong>tgt</strong>${BODY}</comment>`
      + '<strong>b</strong></p>'
      + '<p><strong>d</strong></p>',
    );
  });

  test('Ctrl+B twice over such a document leaves it as it started', async ({ page }) => {
    const html = `<p>a</p><p>b${COMMENT}c</p><p>d</p>`;
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+b');
    await page.keyboard.press('Control+b');

    await expectCommentIntact(page);
    expect(await getRootHtml(page)).toBe(html);
  });

  test('a Shift+Arrow selection dragged from an earlier block into the comment', async ({ page }) => {
    // The selection that actually crosses the comment's inline boundaries key by
    // key, and the one whose end position only Chromium can report: a shifted
    // arrow is not intercepted by the comment boundary handler, so this is the
    // browser extending a selection over a contenteditable=false subtree.
    await mountEditor(page, `<p>a</p><p>b${COMMENT}c</p><p>z</p>`);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Control+b');

    await expectCommentIntact(page);
    // Something was formatted — otherwise the invariant above passes vacuously.
    await expect(page.locator('#ahve-root strong')).not.toHaveCount(0);
    // ...and the block past the selection was left alone.
    await expect(page.locator('#ahve-root > p:last-child')).toHaveText('z');
    expect(await getRootHtml(page)).toContain('<p>z</p>');
  });

  test('a Shift+Arrow selection that starts and ends in the comment\'s own block', async ({ page }) => {
    // The ordinary gesture — select a phrase, press Ctrl+B — and the one the
    // whole-document cases above cannot stand in for: both boundaries stay in
    // the same block, which is the shape the segmentation used to take verbatim
    // and wrap whole. Only Chromium can say how far a shifted arrow travels
    // across a contenteditable=false subtree, so the keys are what selects here.
    await mountEditor(page, `<p>b${COMMENT}c</p>`);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    // 'b' + the comment's 'tgt' + 'c' — the hidden body is not on the visual
    // line, so it costs no keystrokes.
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Control+b');

    await expectCommentIntact(page);
    // The comment's own target text was reached, so the selection really did
    // cross the boundaries rather than stopping in front of them.
    await expect(page.locator('#ahve-root comment > strong')).toHaveCount(1);
    expect(await getRootHtml(page)).toBe(
      `<p><strong>b</strong><comment id="c-1"><strong>tgt</strong>${BODY}</comment>`
      + '<strong>c</strong></p>',
    );
  });
});

// A comment that sits INSIDE an inline wrapper rather than directly in its
// block — the shape two ordinary commands produce in sequence: bold a phrase,
// then comment a word inside it. The segmentation used to absorb the wrapper
// whole, so the <comment> and its contenteditable=false body went into the new
// inline tag and reached the saved file. The unit tests build the wrapper as a
// fixture; these press the keys, which is the only way to say that Ctrl+A really
// does put both boundaries where the walk has to enter the wrapper from outside.
test.describe('Inline formatting around a comment inside an inline wrapper', () => {
  const BODY = '<comment-body contenteditable="false">note</comment-body>';
  const COMMENT = `<comment id="c-1">tgt${BODY}</comment>`;

  /** The invariant behind every case here, asserted the same way each time. */
  async function expectCommentIntact(page: Page, tag: string): Promise<void> {
    await expect(page.locator(`#ahve-root ${tag} comment-body`)).toHaveCount(0);
    await expect(page.locator(`#ahve-root ${tag} comment`)).toHaveCount(0);
    await expect(page.locator('#ahve-root comment')).toHaveCount(1);
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveCount(1);
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveText('note');
    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-1');
  }

  test('Ctrl+A then Ctrl+B enters an <em> holding a comment instead of wrapping it', async ({ page }) => {
    await mountEditor(page, `<p><em>a${COMMENT}b</em></p>`);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+b');

    await expectCommentIntact(page, 'strong');
    expect(await getRootHtml(page)).toBe(
      `<p><em><strong>a</strong><comment id="c-1"><strong>tgt</strong>${BODY}</comment>`
      + '<strong>b</strong></em></p>',
    );
  });

  test('the same for a link, whose href survives', async ({ page }) => {
    await mountEditor(page, `<p><a href="https://example.com/">a${COMMENT}b</a></p>`);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+b');

    await expectCommentIntact(page, 'strong');
    await expect(page.locator('#ahve-root a')).toHaveAttribute('href', 'https://example.com/');
  });

  test('Ctrl+B twice over such a document leaves it as it started', async ({ page }) => {
    const html = `<p><em>a${COMMENT}b</em></p>`;
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+b');
    await page.keyboard.press('Control+b');

    await expectCommentIntact(page, 'strong');
    expect(await getRootHtml(page)).toBe(html);
  });

  test('a Shift+Arrow selection dragged across the wrapped comment', async ({ page }) => {
    // The gesture that crosses the comment's boundaries key by key while the
    // wrapper encloses both sides — a shifted arrow is not intercepted by the
    // comment boundary handler, so this is Chromium extending the selection
    // over a contenteditable=false subtree inside an inline element.
    await mountEditor(page, `<p><em>a${COMMENT}b</em></p>`);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    // 'a' + the comment's 'tgt' + 'b' — the hidden body costs no keystrokes.
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Control+b');

    await expectCommentIntact(page, 'strong');
    await expect(page.locator('#ahve-root comment > strong')).toHaveCount(1);
    await expect(page.locator('#ahve-root em')).toHaveCount(1);
  });
});

// REMOVING an inline tag that already encloses a comment — the direction the
// cases above cannot reach, because a round trip only ever removes the wrappers
// its own first pass built, and each of those sits inside a single segment. Here
// the wrapper is in the document before the keys are pressed: the shape a .html
// file carries, and the one two ordinary commands produce (bold a phrase, then
// comment a word inside it). The removal used to extract across the comment's
// edge and leave TWO <comment id="c-1"> elements behind, one empty. Chromium is
// what says where Ctrl+A and a shifted arrow really put the boundaries around a
// contenteditable=false subtree, which is why this is not only a unit test.
test.describe('Removing an inline format that encloses a comment', () => {
  const BODY = '<comment-body contenteditable="false">note</comment-body>';
  const COMMENT = `<comment id="c-1">tgt${BODY}</comment>`;

  /** Exactly one comment, whole, with its body still in it. */
  async function expectCommentIntact(page: Page): Promise<void> {
    await expect(page.locator('#ahve-root comment')).toHaveCount(1);
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveCount(1);
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveText('note');
    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-1');
  }

  test('Ctrl+A then Ctrl+B takes the bold off without duplicating the comment', async ({ page }) => {
    const html = `<p><strong>pre${COMMENT}post</strong></p>`;
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+b');

    await expectCommentIntact(page);
    await expect(page.locator('#ahve-root strong')).toHaveCount(0);
    expect(await getRootHtml(page)).toBe(`<p>pre${COMMENT}post</p>`);
  });

  test('the same in a bare root-level run', async ({ page }) => {
    await mountEditor(page, `<em>pre${COMMENT}post</em>`);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root');

    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+i');

    await expectCommentIntact(page);
    await expect(page.locator('#ahve-root em')).toHaveCount(0);
    expect(await getRootHtml(page)).toBe(`pre${COMMENT}post`);
  });

  test('a Shift+Arrow selection inside the wrapper removes only what it covers', async ({ page }) => {
    // The wrapper has to be SPLIT at the comment for this to be expressible at
    // all: the text past the selection stays bold while the comment's own
    // target loses it. A shifted arrow is not intercepted by the comment
    // boundary handler, so the selection really is Chromium's.
    await mountEditor(page, `<p><strong>pre${COMMENT}post</strong></p>`);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    // 'pre' + the comment's 'tgt' — the hidden body costs no keystrokes.
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Control+b');

    await expectCommentIntact(page);
    await expect(page.locator('#ahve-root comment strong')).toHaveCount(0);
    await expect(page.locator('#ahve-root strong')).toHaveText('post');
  });

  test('Ctrl+B twice returns the document to the shape it started in', async ({ page }) => {
    // Removing distributes the wrapper over the runs the comment splits, so
    // applying again has to land on exactly those runs — and produce the same
    // shape a plain Ctrl+A Ctrl+B produces on an unformatted document.
    await mountEditor(page, `<p><strong>pre${COMMENT}post</strong></p>`);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+b');
    await page.keyboard.press('Control+b');

    await expectCommentIntact(page);
    await expect(page.locator('#ahve-root strong comment')).toHaveCount(0);
    await expect(page.locator('#ahve-root strong comment-body')).toHaveCount(0);
    expect(await getRootHtml(page)).toBe(
      `<p><strong>pre</strong><comment id="c-1"><strong>tgt</strong>${BODY}</comment>`
      + '<strong>post</strong></p>',
    );
  });
});
