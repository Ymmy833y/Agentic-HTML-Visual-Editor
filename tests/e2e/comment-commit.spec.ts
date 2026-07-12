import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  focusEditor,
  getEditCommittedCount,
  mountEditor,
  saveAndGetHtml,
  selectTextInside,
} from './helpers/page';

// Commit-on-leave behavior of the comment popup: a new comment opens straight
// in body-edit mode, and pending body/reply edits are committed to the DOM
// whenever focus leaves the comment (outside click, close button, navigation,
// switching comments) instead of being silently dropped. Escape stays an
// explicit cancel. These flows hinge on real focus/blur/mousedown ordering,
// so they can only be proven in a real browser.

const TWO_PARAGRAPHS =
  '<p>hello world that is long enough</p><p>another paragraph to click</p>';

const ONE_COMMENT =
  '<p>hi <comment id="c-1">target<comment-body data-author="human" data-updated="2026-07-01T00:00:00.000Z">original note</comment-body></comment> bye</p>' +
  '<p>outside paragraph</p>';

const TWO_COMMENTS =
  '<p><comment id="c-1">one<comment-body data-author="human" data-updated="2026-07-01T00:00:00.000Z">first</comment-body></comment></p>' +
  '<p><comment id="c-2">two<comment-body data-author="human" data-updated="2026-07-01T00:00:00.000Z">second</comment-body></comment></p>';

// Create a fresh comment on "hello" through the floating menu; the popup opens
// with the body editor focused.
async function createComment(page: Page, html = TWO_PARAGRAPHS): Promise<void> {
  await mountEditor(page, html);
  await focusEditor(page);
  await selectTextInside(page, '#ahve-root p', 0, 5);
  await page.locator('#ahve-floating-menu button', { hasText: /^Comment$/ }).click();
  await expect(page.locator('#ahve-comment-popup textarea.ahve-cp-body-input')).toBeFocused();
}

test.describe('New comment opens in body-edit mode (R1)', () => {
  test('the body editor is focused on creation and typing lands in <comment-body>', async ({ page }) => {
    await createComment(page);
    await page.keyboard.type('typed immediately');
    await page.keyboard.press('Enter');

    const body = page.locator('#ahve-root comment > comment-body');
    await expect(body).toHaveText('typed immediately');
    await expect(body).toHaveAttribute('data-author', 'human');
  });

  test('creating the first comment in a tall document does not scroll the page', async ({ page }) => {
    // The popup lives at the end of <body> and has no top/left until the
    // first reposition(); focusing its textarea before it is positioned used
    // to scroll the page to the document bottom.
    await mountEditor(
      page,
      '<p>hello world that is long enough</p>' + '<p>filler paragraph</p>'.repeat(60),
    );
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);
    await page.locator('#ahve-floating-menu button', { hasText: /^Comment$/ }).click();

    await expect(page.locator('#ahve-comment-popup textarea.ahve-cp-body-input')).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(50);

    // The popup is anchored to the comment at the top, inside the viewport.
    const box = await page.locator('#ahve-comment-popup').boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  });

  test('the popup stays inside the viewport in auto-edit mode', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 320 });
    await createComment(
      page,
      '<p>filler one</p><p>filler two</p><p>filler three</p><p>filler four</p>' +
        '<p>hello world near the bottom</p>',
    );

    const box = await page.locator('#ahve-comment-popup').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(320 + 1);
  });
});

test.describe('Pending body/reply edits commit when focus leaves (R2)', () => {
  test('a body edit survives clicking outside the popup', async ({ page }) => {
    await createComment(page);
    await page.keyboard.type('note text');
    await page.locator('#ahve-root p').nth(1).click();

    await expect(page.locator('#ahve-comment-popup')).toBeHidden();
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveText('note text');
    expect(await saveAndGetHtml(page)).toContain('note text');
  });

  test('a body edit survives the header close button', async ({ page }) => {
    await createComment(page);
    await page.keyboard.type('kept on close');
    await page.locator('#ahve-comment-popup .ahve-cp-btn', { hasText: '×' }).click();

    await expect(page.locator('#ahve-comment-popup')).toBeHidden();
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveText('kept on close');
  });

  test('a body edit commits when navigating to the next comment', async ({ page }) => {
    await mountEditor(page, TWO_COMMENTS);
    await page.locator('#ahve-root comment').first().click();
    const popup = page.locator('#ahve-comment-popup');
    await popup.locator('.ahve-cp-body-display').click();
    await popup.locator('textarea.ahve-cp-body-input').fill('first edited');

    await popup.locator('.ahve-cp-btn', { hasText: '↓' }).click();

    await expect(popup.locator('.ahve-cp-body-display')).toHaveText('second');
    await expect(page.locator('#ahve-root comment#c-1 > comment-body')).toHaveText('first edited');
  });

  test('a body edit commits when clicking another comment highlight', async ({ page }) => {
    // Keep the two comments far apart so the popup anchored under the first
    // one does not cover the second highlight and intercept the click.
    const filler = '<p>filler paragraph</p>'.repeat(12);
    await mountEditor(
      page,
      '<p><comment id="c-1">one<comment-body data-author="human" data-updated="2026-07-01T00:00:00.000Z">first</comment-body></comment></p>' +
        filler +
        '<p><comment id="c-2">two<comment-body data-author="human" data-updated="2026-07-01T00:00:00.000Z">second</comment-body></comment></p>',
    );
    await page.locator('#ahve-root comment').first().click();
    const popup = page.locator('#ahve-comment-popup');
    await popup.locator('.ahve-cp-body-display').click();
    await popup.locator('textarea.ahve-cp-body-input').fill('first edited');

    await page.locator('#ahve-root comment').nth(1).click();

    await expect(popup).toBeVisible();
    await expect(popup.locator('.ahve-cp-body-display')).toHaveText('second');
    await expect(page.locator('#ahve-root comment#c-1 > comment-body')).toHaveText('first edited');
  });

  test('a reply edit survives clicking outside and keeps its author', async ({ page }) => {
    await mountEditor(
      page,
      '<p>hi <comment id="c-1">target<comment-body data-author="human">note</comment-body>' +
        '<comment-reply data-author="human" data-updated="2026-07-01T00:00:00.000Z">old reply</comment-reply></comment> bye</p>' +
        '<p>outside paragraph</p>',
    );
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    await popup.locator('.ahve-cp-reply-display').click();
    await popup.locator('.ahve-cp-reply-row textarea.ahve-cp-reply-input').fill('revised reply');

    await page.locator('#ahve-root p').nth(1).click();

    await expect(popup).toBeHidden();
    const reply = page.locator('#ahve-root comment > comment-reply');
    await expect(reply).toHaveText('revised reply');
    await expect(reply).toHaveAttribute('data-author', 'human');
  });

  test('an Enter-committed body is not committed again on outside click', async ({ page }) => {
    await createComment(page);
    await page.keyboard.type('first version');
    await page.keyboard.press('Enter');
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveText('first version');
    const committed = await getEditCommittedCount(page);

    await page.locator('#ahve-root p').nth(1).click();

    await expect(page.locator('#ahve-comment-popup')).toBeHidden();
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveCount(1);
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveText('first version');
    // Closing after an Enter-commit must not record another edit.
    expect(await getEditCommittedCount(page)).toBe(committed);
  });
});

test.describe('Pending reply-input text is submitted on leave (R3)', () => {
  test('reply-input text becomes a <comment-reply> on outside click', async ({ page }) => {
    await mountEditor(page, ONE_COMMENT);
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    await popup.locator('.ahve-cp-reply-form textarea.ahve-cp-reply-input').fill('pending reply');

    await page.locator('#ahve-root p').nth(1).click();

    await expect(popup).toBeHidden();
    const reply = page.locator('#ahve-root comment > comment-reply');
    await expect(reply).toHaveText('pending reply');
    await expect(reply).toHaveAttribute('data-author', 'human');
  });

  test('reply-input text is submitted by the header close button', async ({ page }) => {
    await mountEditor(page, ONE_COMMENT);
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    await popup.locator('.ahve-cp-reply-form textarea.ahve-cp-reply-input').fill('kept reply');

    await popup.locator('.ahve-cp-btn', { hasText: '×' }).click();

    await expect(popup).toBeHidden();
    await expect(page.locator('#ahve-root comment > comment-reply')).toHaveText('kept reply');
  });

  test('reply-input text lands on the comment it was typed for when navigating', async ({ page }) => {
    await mountEditor(page, TWO_COMMENTS);
    await page.locator('#ahve-root comment').first().click();
    const popup = page.locator('#ahve-comment-popup');
    const replyInput = popup.locator('.ahve-cp-reply-form textarea.ahve-cp-reply-input');
    await replyInput.fill('note for first');

    await popup.locator('.ahve-cp-btn', { hasText: '↓' }).click();

    await expect(popup.locator('.ahve-cp-body-display')).toHaveText('second');
    await expect(page.locator('#ahve-root comment#c-1 > comment-reply')).toHaveText('note for first');
    await expect(page.locator('#ahve-root comment#c-2 > comment-reply')).toHaveCount(0);
    await expect(replyInput).toHaveValue('');
  });

  test('whitespace-only reply-input text is not submitted', async ({ page }) => {
    await mountEditor(page, ONE_COMMENT);
    await page.locator('#ahve-root comment').click();
    await page
      .locator('#ahve-comment-popup .ahve-cp-reply-form textarea.ahve-cp-reply-input')
      .fill('   ');

    await page.locator('#ahve-root p').nth(1).click();

    await expect(page.locator('#ahve-comment-popup')).toBeHidden();
    await expect(page.locator('#ahve-root comment > comment-reply')).toHaveCount(0);
  });
});

test.describe('Escape stays an explicit cancel (R4)', () => {
  test('Escape discards a body edit and keeps the original text', async ({ page }) => {
    await mountEditor(page, ONE_COMMENT);
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    await popup.locator('.ahve-cp-body-display').click();
    const input = popup.locator('textarea.ahve-cp-body-input');
    await input.fill('junk that must not be saved');
    await input.press('Escape');

    await expect(page.locator('#ahve-root comment > comment-body')).toHaveText('original note');

    // Reopening shows the untouched body.
    await page.locator('#ahve-root comment').click();
    await expect(popup.locator('.ahve-cp-body-display')).toHaveText('original note');
  });

  test('Escape clears the reply input without submitting; closing adds no reply', async ({ page }) => {
    await mountEditor(page, ONE_COMMENT);
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    const replyInput = popup.locator('.ahve-cp-reply-form textarea.ahve-cp-reply-input');
    await replyInput.fill('draft reply');
    await replyInput.press('Escape');

    // First Escape only cancels the field: popup stays open, input cleared.
    await expect(popup).toBeVisible();
    await expect(replyInput).toHaveValue('');

    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();
    await expect(page.locator('#ahve-root comment > comment-reply')).toHaveCount(0);
  });

  test('an Escape-cancelled body edit is not resurrected by a later outside click', async ({ page }) => {
    await mountEditor(page, ONE_COMMENT);
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    await popup.locator('.ahve-cp-body-display').click();
    const input = popup.locator('textarea.ahve-cp-body-input');
    await input.fill('junk that must not be saved');
    await input.press('Escape');

    await page.locator('#ahve-root p').nth(1).click();

    await expect(page.locator('#ahve-root comment > comment-body')).toHaveText('original note');
    expect(await saveAndGetHtml(page)).not.toContain('junk that must not be saved');
  });
});

test.describe('Delete and empty-body interactions', () => {
  test('deleting while a body edit is pending removes the comment cleanly', async ({ page }) => {
    await createComment(page);
    await page.keyboard.type('doomed draft');
    await page.locator('#ahve-comment-popup .ahve-cp-btn', { hasText: '🗑' }).click();

    await expect(page.locator('#ahve-comment-popup')).toBeHidden();
    await expect(page.locator('#ahve-root comment')).toHaveCount(0);
    await expect(page.locator('#ahve-root p').first()).toHaveText('hello world that is long enough');
    const saved = await saveAndGetHtml(page);
    expect(saved).not.toContain('doomed draft');
    expect(saved).not.toContain('<comment');
  });

  test('a new comment left with an empty body stays in the document', async ({ page }) => {
    await createComment(page);
    await page.locator('#ahve-root p').nth(1).click();

    await expect(page.locator('#ahve-comment-popup')).toBeHidden();
    await expect(page.locator('#ahve-root comment')).toHaveCount(1);
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveCount(1);
    const saved = await saveAndGetHtml(page);
    expect(saved).toContain('<comment');
    expect(saved).toContain('<comment-body');
  });
});
