import { expect, test } from '@playwright/test';
import { focusEditor, getRootHtml, mountEditor, selectTextInside } from './helpers/page';

test.describe('Link dialog (Ctrl+K)', () => {
  test('opens the dialog with focus on the URL input', async ({ page }) => {
    await mountEditor(page, '<p>click here</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);
    await page.keyboard.press('Control+k');

    const dialog = page.locator('.ahve-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-label', 'Insert link');
    await expect(page.locator('.ahve-dialog-input')).toBeFocused();
  });

  test('Enter submits the URL and wraps the selection in <a href>', async ({ page }) => {
    await mountEditor(page, '<p>click here</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);
    await page.keyboard.press('Control+k');

    await page.locator('.ahve-dialog-input').fill('https://example.com');
    await page.keyboard.press('Enter');

    await expect(page.locator('.ahve-dialog')).toHaveCount(0);
    expect(await getRootHtml(page)).toBe('<p><a href="https://example.com">click</a> here</p>');
  });

  test('Escape cancels and inserts nothing', async ({ page }) => {
    await mountEditor(page, '<p>click here</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Escape');

    await expect(page.locator('.ahve-dialog')).toHaveCount(0);
    expect(await getRootHtml(page)).toBe('<p>click here</p>');
  });

  test('opens in edit mode for an existing <a> and updates its href', async ({ page }) => {
    await mountEditor(page, '<p><a href="https://old.example">click</a> here</p>');
    await focusEditor(page);
    // Place caret inside the link so the editor recognises an existing <a>.
    await page.evaluate(() => {
      const a = document.querySelector('#ahve-root a')!;
      const range = document.createRange();
      range.selectNodeContents(a);
      range.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.press('Control+k');

    const dialog = page.locator('.ahve-dialog');
    await expect(dialog).toHaveAttribute('aria-label', 'Edit link');
    await expect(page.locator('.ahve-dialog-input')).toHaveValue('https://old.example');

    await page.locator('.ahve-dialog-input').fill('https://new.example');
    await page.keyboard.press('Enter');

    expect(await getRootHtml(page)).toBe('<p><a href="https://new.example">click</a> here</p>');
  });

  test('Remove link button unwraps the existing <a>', async ({ page }) => {
    await mountEditor(page, '<p><a href="https://x">click</a> here</p>');
    await focusEditor(page);
    await page.evaluate(() => {
      const a = document.querySelector('#ahve-root a')!;
      const range = document.createRange();
      range.selectNodeContents(a);
      range.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.press('Control+k');

    await page.getByRole('button', { name: 'Remove link' }).click();

    await expect(page.locator('.ahve-dialog')).toHaveCount(0);
    expect(await getRootHtml(page)).toBe('<p>click here</p>');
  });
});
