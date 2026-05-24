import { expect, test } from '@playwright/test';
import { focusEditor, mountEditor, selectTextInside } from './helpers/page';

test.describe('Floating menu', () => {
  test('is hidden when no selection exists and shows for a non-empty selection', async ({ page }) => {
    await mountEditor(page, '<p>hello world that is long enough to position above</p>');
    const menu = page.locator('#hw-floating-menu');
    await expect(menu).toBeHidden();

    await focusEditor(page);
    await selectTextInside(page, '#hw-root p', 0, 5);
    await expect(menu).toBeVisible();
  });

  test('returns to hidden when the selection collapses', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#hw-root p', 0, 5);
    const menu = page.locator('#hw-floating-menu');
    await expect(menu).toBeVisible();

    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await expect(menu).toBeHidden();
  });

  test('positions itself above the selection rectangle', async ({ page }) => {
    // Pad the top of the document so there is room above the paragraph for
    // the menu to actually fit (the layout falls back to viewport padding
    // otherwise, which would invalidate the comparison).
    await mountEditor(
      page,
      '<p style="margin-top: 200px">hello world that is long enough to measure</p>',
    );
    await focusEditor(page);
    await selectTextInside(page, '#hw-root p', 0, 5);

    const menu = page.locator('#hw-floating-menu');
    await expect(menu).toBeVisible();

    const menuBox = await menu.boundingBox();
    const selectionBox = await page.evaluate(() => {
      const sel = window.getSelection();
      const rect = sel!.getRangeAt(0).getBoundingClientRect();
      return { top: rect.top + window.scrollY, height: rect.height };
    });
    expect(menuBox).not.toBeNull();
    // The menu's bottom edge should sit above the selection's top edge.
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(selectionBox.top);
  });

  test('clicking Bold in the floating menu wraps the selection', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#hw-root p', 0, 5);
    await page.locator('#hw-floating-menu button', { hasText: /^B$/ }).click();
    await expect(page.locator('#hw-root strong')).toHaveText('hello');
  });
});
