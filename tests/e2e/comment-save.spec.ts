import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import {
  focusEditor,
  mountEditor,
  saveAndGetFileData,
  selectTextInside,
} from './helpers/page';

// Interplay between the comment popup and the save flow. A body/reply edit
// that is still open in the popup textarea must be committed into the DOM
// before the save snapshot is serialized — otherwise the file is saved with
// an empty <comment-body>, and the save echo (saveResult with normalized
// content) remounts the DOM, detaching the element the popup would commit
// into, so the typed text is silently lost (the reported bug).

async function dispatchMessage(page: Page, data: unknown): Promise<void> {
  await page.evaluate((data) => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  }, data);
}

const ONE_COMMENT =
  '<p>hi <comment id="c-1">target<comment-body data-author="human" data-updated="2026-07-01T00:00:00.000Z">original note</comment-body></comment> bye</p>' +
  '<p>outside paragraph</p>';

async function createComment(page: Page): Promise<void> {
  await mountEditor(page, '<p>hello world that is long enough</p><p>another paragraph</p>');
  await focusEditor(page);
  await selectTextInside(page, '#ahve-root p', 0, 5);
  await page.locator('#ahve-floating-menu button', { hasText: /^Comment$/ }).click();
  await expect(page.locator('#ahve-comment-popup textarea.ahve-cp-body-input')).toBeFocused();
}

test.describe('Comment edits and the save flow', () => {
  test('body text still open in the editor is included in the save snapshot', async ({ page }) => {
    await createComment(page);
    await page.keyboard.type('saved mid edit');

    const save = await saveAndGetFileData(page);
    expect(save.html).toContain('saved mid edit');
  });

  test('the reported flow: type, Ctrl+S with echo remount, confirm, reopen — the text survives', async ({ page }) => {
    await createComment(page);
    await page.keyboard.type('my note');

    // Ctrl+S: the host runs the snapshot handshake, writes the file with
    // normalization (here: a trailing newline) and echoes the saved document,
    // which differs from the view serialization and triggers a remount.
    const save = await saveAndGetFileData(page);
    await dispatchMessage(page, { type: 'saveResult', html: save.html + '\n', ok: true });

    // Step 4 of the report: confirm the body input. After the fix the editor
    // was already settled by the save flush, so this is a no-op; before the
    // fix it committed into a detached element.
    await page.keyboard.press('Enter');

    // Step 5: reopen the comment — the typed text must still be there.
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    await expect(popup.locator('.ahve-cp-body-display')).toHaveText('my note');
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveText('my note');
  });

  test('the popup stays on the comment across a save-echo remount', async ({ page }) => {
    await createComment(page);
    await page.keyboard.type('kept across remount');

    const save = await saveAndGetFileData(page);
    await dispatchMessage(page, { type: 'saveResult', html: save.html + '\n', ok: true });

    // Without any further clicks the popup already shows the committed body,
    // re-bound to the remounted <comment> element.
    const popup = page.locator('#ahve-comment-popup');
    await expect(popup).toBeVisible();
    await expect(popup.locator('.ahve-cp-body-display')).toHaveText('kept across remount');
    await expect(page.locator('#ahve-root comment > comment-body')).toHaveText('kept across remount');
  });

  test('a save whose echo matches the view keeps the committed body without a remount', async ({ page }) => {
    await createComment(page);
    await page.keyboard.type('no remount case');

    const save = await saveAndGetFileData(page);
    await dispatchMessage(page, { type: 'saveResult', html: save.html, ok: true });

    await expect(page.locator('#ahve-root comment > comment-body')).toHaveText('no remount case');
    const popup = page.locator('#ahve-comment-popup');
    await expect(popup.locator('.ahve-cp-body-display')).toHaveText('no remount case');
  });

  test('pending reply-input text is included in the save snapshot', async ({ page }) => {
    await mountEditor(page, ONE_COMMENT);
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    await popup.locator('.ahve-cp-reply-form textarea.ahve-cp-reply-input').fill('pending reply');

    const save = await saveAndGetFileData(page);
    expect(save.html).toContain('<comment-reply');
    expect(save.html).toContain('pending reply');
    await expect(page.locator('#ahve-root comment > comment-reply')).toHaveText('pending reply');
  });

  test('the popup closes when the saved document no longer contains the comment', async ({ page }) => {
    await mountEditor(page, ONE_COMMENT);
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    await expect(popup).toBeVisible();

    const save = await saveAndGetFileData(page);
    void save;
    await dispatchMessage(page, {
      type: 'saveResult',
      html: '<p>hi target bye</p><p>outside paragraph</p>',
      ok: true,
    });

    await expect(popup).toBeHidden();
  });

  test('the popup re-binds after an undo/redo remount (applyHistoryState)', async ({ page }) => {
    await mountEditor(page, ONE_COMMENT);
    await page.locator('#ahve-root comment').click();
    const popup = page.locator('#ahve-comment-popup');
    await expect(popup.locator('.ahve-cp-body-display')).toHaveText('original note');

    const historyHtml =
      '<p>hi <comment id="c-1">target<comment-body data-author="human" data-updated="2026-07-01T00:00:00.000Z">undone note</comment-body></comment> bye</p>' +
      '<p>outside paragraph</p>';
    await dispatchMessage(page, { type: 'applyHistoryState', requestId: 1, html: historyHtml });

    await expect(popup).toBeVisible();
    await expect(popup.locator('.ahve-cp-body-display')).toHaveText('undone note');

    // The comment disappears from the applied state: the popup closes.
    await dispatchMessage(page, {
      type: 'applyHistoryState',
      requestId: 2,
      html: '<p>hi target bye</p><p>outside paragraph</p>',
    });
    await expect(popup).toBeHidden();
  });
});
