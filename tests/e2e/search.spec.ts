import { expect, test, type Page } from '@playwright/test';
import { focusEditor, mountEditor, selectTextInside } from './helpers/page';

/** Number of registered CSS Custom Highlight entries for a given name. */
async function highlightSize(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => {
    const hl = CSS.highlights.get(n);
    if (!hl) return 0;
    let size = 0;
    hl.forEach(() => size++);
    return size;
  }, name);
}

test.describe('In-document search (Ctrl+F)', () => {
  test('Ctrl+F opens the widget and Escape closes it', async ({ page }) => {
    await mountEditor(page, '<p>alpha beta gamma</p>');
    await focusEditor(page);

    const widget = page.locator('#ahve-search');
    await expect(widget).toBeHidden();

    await page.keyboard.press('Control+f');
    await expect(widget).toBeVisible();
    await expect(page.locator('.ahve-search-input')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(widget).toBeHidden();
  });

  test('typing highlights matches and reports the count', async ({ page }) => {
    await mountEditor(page, '<p>one two one two one</p>');
    await focusEditor(page);
    await page.keyboard.press('Control+f');

    await page.locator('.ahve-search-input').fill('one');

    await expect(page.locator('.ahve-search-count')).toHaveText('1/3');
    expect(await highlightSize(page, 'ahve-search')).toBe(3);
    expect(await highlightSize(page, 'ahve-search-current')).toBe(1);
  });

  test('Enter and Shift+Enter move through matches with wrap-around', async ({ page }) => {
    await mountEditor(page, '<p>x x x</p>');
    await focusEditor(page);
    await page.keyboard.press('Control+f');
    await page.locator('.ahve-search-input').fill('x');

    const count = page.locator('.ahve-search-count');
    await expect(count).toHaveText('1/3');

    await page.keyboard.press('Enter');
    await expect(count).toHaveText('2/3');
    await page.keyboard.press('Enter');
    await expect(count).toHaveText('3/3');
    await page.keyboard.press('Enter'); // wrap to first
    await expect(count).toHaveText('1/3');
    await page.keyboard.press('Shift+Enter'); // wrap back to last
    await expect(count).toHaveText('3/3');
  });

  test('the match-case toggle changes the result set', async ({ page }) => {
    await mountEditor(page, '<p>Cat cat CAT</p>');
    await focusEditor(page);
    await page.keyboard.press('Control+f');
    await page.locator('.ahve-search-input').fill('cat');

    await expect(page.locator('.ahve-search-count')).toHaveText('1/3');

    // Toggle "Match case" (Aa).
    await page.locator('.ahve-search-btn', { hasText: 'Aa' }).click();
    await expect(page.locator('.ahve-search-count')).toHaveText('1/1');
  });

  test('the whole-word toggle excludes partial matches', async ({ page }) => {
    await mountEditor(page, '<p>cat category cat</p>');
    await focusEditor(page);
    await page.keyboard.press('Control+f');
    await page.locator('.ahve-search-input').fill('cat');

    await expect(page.locator('.ahve-search-count')).toHaveText('1/3');

    await page.locator('.ahve-search-btn', { hasText: 'ab' }).click();
    await expect(page.locator('.ahve-search-count')).toHaveText('1/2');
  });

  test('reports "No results" when nothing matches', async ({ page }) => {
    await mountEditor(page, '<p>alpha beta</p>');
    await focusEditor(page);
    await page.keyboard.press('Control+f');
    await page.locator('.ahve-search-input').fill('zzz');

    await expect(page.locator('.ahve-search-count')).toHaveText('No results');
    expect(await highlightSize(page, 'ahve-search')).toBe(0);
  });

  test('prefills the query from the editor selection', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 0, 5);

    await page.keyboard.press('Control+f');
    await expect(page.locator('.ahve-search-input')).toHaveValue('hello');
    await expect(page.locator('.ahve-search-count')).toHaveText('1/1');
  });

  test('closing clears the highlights', async ({ page }) => {
    await mountEditor(page, '<p>find find</p>');
    await focusEditor(page);
    await page.keyboard.press('Control+f');
    await page.locator('.ahve-search-input').fill('find');
    // Wait for the debounced search to settle before reading the one-shot count.
    await expect(page.locator('.ahve-search-count')).toHaveText('1/2');
    expect(await highlightSize(page, 'ahve-search')).toBe(2);

    await page.keyboard.press('Escape');
    expect(await highlightSize(page, 'ahve-search')).toBe(0);
    expect(await highlightSize(page, 'ahve-search-current')).toBe(0);
  });
});
