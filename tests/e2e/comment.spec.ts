import { expect, test } from '@playwright/test';
import { focusEditor, mountEditor, selectTextInside } from './helpers/page';

test.describe('Comment', () => {
  test('clicking Comment in the floating menu wraps the selection and opens the popup', async ({ page }) => {
    await mountEditor(page, '<p>hello world that is long enough</p>');
    await focusEditor(page);
    await selectTextInside(page, '#hw-root p', 0, 5);

    await page.locator('#hw-floating-menu button', { hasText: /^Comment$/ }).click();

    const comment = page.locator('#hw-root comment');
    await expect(comment).toHaveCount(1);
    await expect(comment).toHaveText('hello');
    await expect(comment).toHaveAttribute('id', /^c-[a-z0-9]+$/);

    const popup = page.locator('#hw-comment-popup');
    await expect(popup).toBeVisible();
    await expect(popup.locator('.hw-cp-body-display')).toHaveText('Add a comment');
  });

  test('typing a body and pressing Enter saves it under <comment-body>', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#hw-root p', 0, 5);
    await page.locator('#hw-floating-menu button', { hasText: /^Comment$/ }).click();

    const popup = page.locator('#hw-comment-popup');
    await popup.locator('.hw-cp-body-display').click();
    await popup.locator('textarea.hw-cp-body-input').fill('great point');
    await popup.locator('textarea.hw-cp-body-input').press('Enter');

    const body = page.locator('#hw-root comment > comment-body');
    await expect(body).toHaveText('great point');
    await expect(popup.locator('.hw-cp-body-display')).toHaveText('great point');
  });

  test('replies are stored as <comment-reply> children and listed in the popup', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#hw-root p', 0, 5);
    await page.locator('#hw-floating-menu button', { hasText: /^Comment$/ }).click();

    const popup = page.locator('#hw-comment-popup');
    const replyInput = popup.locator('textarea.hw-cp-reply-input');
    await replyInput.fill('first reply');
    await replyInput.press('Enter');
    await replyInput.fill('second reply');
    await replyInput.press('Enter');

    const replies = page.locator('#hw-root comment > comment-reply');
    await expect(replies).toHaveCount(2);
    await expect(replies.nth(0)).toHaveText('first reply');
    await expect(replies.nth(1)).toHaveText('second reply');

    const replyRows = popup.locator('.hw-cp-reply-row .hw-cp-reply-display');
    await expect(replyRows).toHaveCount(2);
  });

  test('clicking a reply delete button removes it from the comment', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#hw-root p', 0, 5);
    await page.locator('#hw-floating-menu button', { hasText: /^Comment$/ }).click();

    const popup = page.locator('#hw-comment-popup');
    const replyInput = popup.locator('textarea.hw-cp-reply-input');
    await replyInput.fill('only reply');
    await replyInput.press('Enter');

    await expect(page.locator('#hw-root comment > comment-reply')).toHaveCount(1);
    // The delete button is hidden until hover, but click() forces it.
    await popup.locator('.hw-cp-reply-row .hw-cp-reply-del').click();
    await expect(page.locator('#hw-root comment > comment-reply')).toHaveCount(0);
  });

  test('the trash button deletes the whole comment and closes the popup', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#hw-root p', 0, 5);
    await page.locator('#hw-floating-menu button', { hasText: /^Comment$/ }).click();

    const popup = page.locator('#hw-comment-popup');
    await expect(popup).toBeVisible();

    await popup.locator('.hw-cp-btn', { hasText: '🗑' }).click();

    await expect(popup).toBeHidden();
    await expect(page.locator('#hw-root comment')).toHaveCount(0);
    await expect(page.locator('#hw-root p')).toHaveText('hello world');
  });

  test('does not add a comment when the selection spans two paragraphs', async ({ page }) => {
    await mountEditor(page, '<p>first paragraph</p><p>second paragraph</p>');
    await focusEditor(page);
    await page.evaluate(() => {
      const ps = document.querySelectorAll('#hw-root p');
      const range = document.createRange();
      range.setStart(ps[0].firstChild!, 0);
      range.setEnd(ps[1].firstChild!, 6);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    await page.locator('#hw-floating-menu button', { hasText: /^Comment$/ }).click();

    await expect(page.locator('#hw-root comment')).toHaveCount(0);
    await expect(page.locator('#hw-comment-popup')).toBeHidden();
  });

  test('clicking an existing comment highlight reopens the popup with its body', async ({ page }) => {
    await mountEditor(
      page,
      '<p>hi <comment id="c-existing">target<comment-body>note</comment-body></comment> bye</p>',
    );
    await page.locator('#hw-root comment').click();
    const popup = page.locator('#hw-comment-popup');
    await expect(popup).toBeVisible();
    await expect(popup.locator('.hw-cp-body-display')).toHaveText('note');
  });

  test('comments work for text inside a table cell', async ({ page }) => {
    await mountEditor(
      page,
      '<table><tbody><tr><td>cell content</td></tr></tbody></table>',
    );
    await focusEditor(page);
    await selectTextInside(page, '#hw-root td', 0, 4);
    await page.locator('#hw-floating-menu button', { hasText: /^Comment$/ }).click();

    const comment = page.locator('#hw-root td > comment');
    await expect(comment).toHaveCount(1);
    await expect(comment).toHaveText('cell');
    await expect(page.locator('#hw-comment-popup')).toBeVisible();
  });

  test('arrow buttons navigate between comments in document order', async ({ page }) => {
    await mountEditor(
      page,
      '<p><comment id="c-1">one<comment-body>first</comment-body></comment></p>' +
        '<p><comment id="c-2">two<comment-body>second</comment-body></comment></p>',
    );
    await page.locator('#hw-root comment').first().click();
    const popup = page.locator('#hw-comment-popup');
    await expect(popup.locator('.hw-cp-body-display')).toHaveText('first');
    await popup.locator('.hw-cp-btn', { hasText: '↓' }).click();
    await expect(popup.locator('.hw-cp-body-display')).toHaveText('second');
    await popup.locator('.hw-cp-btn', { hasText: '↑' }).click();
    await expect(popup.locator('.hw-cp-body-display')).toHaveText('first');
  });

  test('a human-created comment records author and timestamp metadata', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#hw-root p', 0, 5);
    await page.locator('#hw-floating-menu button', { hasText: /^Comment$/ }).click();

    const popup = page.locator('#hw-comment-popup');
    await popup.locator('.hw-cp-body-display').click();
    await popup.locator('textarea.hw-cp-body-input').fill('great point');
    await popup.locator('textarea.hw-cp-body-input').press('Enter');

    const body = page.locator('#hw-root comment > comment-body');
    await expect(body).toHaveAttribute('data-author', 'human');
    await expect(body).toHaveAttribute('data-updated', /^\d{4}-\d{2}-\d{2}T/);
    await expect(popup.locator('.hw-cp-meta').first()).toContainText('Human');
  });

  test('the resolve toggle adds and removes data-resolved on the comment', async ({ page }) => {
    await mountEditor(
      page,
      '<p><comment id="c-r">target<comment-body data-author="human">note</comment-body></comment></p>',
    );
    await page.locator('#hw-root comment').click();
    const popup = page.locator('#hw-comment-popup');
    const resolveBtn = popup.locator('.hw-cp-btn', { hasText: '✓' });

    await resolveBtn.click();
    await expect(page.locator('#hw-root comment')).toHaveAttribute('data-resolved', '');
    await resolveBtn.click();
    await expect(page.locator('#hw-root comment')).not.toHaveAttribute('data-resolved', '');
  });

  test('editing an AI-authored body asks for confirmation; cancel keeps it', async ({ page }) => {
    await mountEditor(
      page,
      '<p>hi <comment id="c-ai">target<comment-body data-author="ai" data-updated="2026-06-18T09:00:00Z">ai note</comment-body></comment> bye</p>',
    );
    await page.locator('#hw-root comment').click();
    const popup = page.locator('#hw-comment-popup');
    await popup.locator('.hw-cp-body-display').click();

    const dialog = page.locator('.hw-dialog-overlay');
    await expect(dialog).toBeVisible();
    await dialog.locator('button', { hasText: 'Cancel' }).click();

    await expect(dialog).toHaveCount(0);
    // No edit textarea opened and the AI note is untouched.
    await expect(popup.locator('textarea.hw-cp-body-input')).toHaveCount(0);
    await expect(page.locator('#hw-root comment > comment-body')).toHaveText('ai note');
  });

  test('confirming lets the human edit the AI-authored body', async ({ page }) => {
    await mountEditor(
      page,
      '<p>hi <comment id="c-ai">target<comment-body data-author="ai" data-updated="2026-06-18T09:00:00Z">ai note</comment-body></comment> bye</p>',
    );
    await page.locator('#hw-root comment').click();
    const popup = page.locator('#hw-comment-popup');
    await popup.locator('.hw-cp-body-display').click();

    await page.locator('.hw-dialog-overlay button', { hasText: 'Edit' }).click();
    const input = popup.locator('textarea.hw-cp-body-input');
    await expect(input).toBeVisible();
    await input.fill('human revised');
    await input.press('Enter');

    const body = page.locator('#hw-root comment > comment-body');
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
    await page.locator('#hw-root comment').click();
    const popup = page.locator('#hw-comment-popup');
    await popup.locator('.hw-cp-reply-row .hw-cp-reply-del').click();

    const dialog = page.locator('.hw-dialog-overlay');
    await expect(dialog).toBeVisible();
    await dialog.locator('button', { hasText: 'Cancel' }).click();
    await expect(page.locator('#hw-root comment > comment-reply')).toHaveCount(1);
  });

  test('AI-authored comments render in a different highlight colour than human ones', async ({ page }) => {
    await mountEditor(
      page,
      '<p><comment id="c-h">human<comment-body data-author="human">h</comment-body></comment> ' +
        '<comment id="c-a">ai<comment-body data-author="ai">a</comment-body></comment></p>',
    );
    const humanBg = await page
      .locator('#hw-root comment#c-h')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const aiBg = await page
      .locator('#hw-root comment#c-a')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(humanBg).not.toBe(aiBg);
  });
});
