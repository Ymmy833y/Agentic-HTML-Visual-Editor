import { expect, test } from '@playwright/test';
import { focusEditor, mountEditor, selectTextInside } from './helpers/page';

test.describe('Floating menu', () => {
  test('is hidden when no selection exists and shows for a non-empty selection', async ({ page }) => {
    await mountEditor(page, '<p>hello world that is long enough to position above</p>');
    const menu = page.locator('#ahve-floating-menu');
    await expect(menu).toBeHidden();

    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);
    await expect(menu).toBeVisible();
  });

  test('returns to hidden when the selection collapses', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);
    const menu = page.locator('#ahve-floating-menu');
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
    await selectTextInside(page, '#ahve-root p', 0, 5);

    const menu = page.locator('#ahve-floating-menu');
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
    await selectTextInside(page, '#ahve-root p', 0, 5);
    await page.locator('#ahve-floating-menu button', { hasText: /^B$/ }).click();
    await expect(page.locator('#ahve-root strong')).toHaveText('hello');
  });

  // The tooltip hides via opacity, not display, so visibility is asserted
  // through the ahve-tooltip-visible class rather than toBeVisible/toBeHidden.
  test('hovering a button shows the shared tooltip with the toolbar text', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);

    await page.locator('#ahve-floating-menu button', { hasText: /^B$/ }).hover();

    const tooltip = page.locator('#ahve-tooltip');
    await expect(tooltip).toHaveText('Bold (Ctrl+B)');
    await expect(tooltip).toHaveClass(/ahve-tooltip-visible/);
  });

  test('the tooltip is cleared when the menu hides while hovered', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);
    await page.locator('#ahve-floating-menu button', { hasText: /^B$/ }).hover();
    await expect(page.locator('#ahve-tooltip')).toHaveClass(/ahve-tooltip-visible/);

    await page.evaluate(() => window.getSelection()?.removeAllRanges());

    await expect(page.locator('#ahve-floating-menu')).toBeHidden();
    await expect(page.locator('#ahve-tooltip')).not.toHaveClass(/ahve-tooltip-visible/);
  });
});
