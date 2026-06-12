import { expect, test } from '@playwright/test';
import {
  DEBOUNCE_MS,
  caretAtEnd,
  focusEditor,
  getEditMessages,
  getRootHtml,
  mountEditor,
} from './helpers/page';

test.describe('Details / summary', () => {
  test('Details toolbar button inserts a collapsible section', async ({ page }) => {
    await mountEditor(page, '<p>hello</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#hw-root p');

    await page.locator('#hw-toolbar button', { hasText: 'Details' }).click();

    expect(await getRootHtml(page)).toBe(
      '<p>hello</p><details open=""><summary>Details</summary><p><br></p></details>',
    );
  });

  test('Enter inside the summary drops into the body without splitting it', async ({ page }) => {
    await mountEditor(page, '<details open=""><summary>title</summary><p>body</p></details>');
    await focusEditor(page);
    await caretAtEnd(page, '#hw-root summary');

    await page.keyboard.press('Enter');
    await page.keyboard.type('Z');

    // Exactly one summary survived, and the typed text landed in the body.
    expect(await page.locator('#hw-root summary').count()).toBe(1);
    expect(await getRootHtml(page)).toContain('<p>Zbody</p>');
  });

  test('Clicking the disclosure marker toggles open/closed', async ({ page }) => {
    await mountEditor(page, '<details open=""><summary>title</summary><p>body</p></details>');

    const summary = page.locator('#hw-root summary');
    // Click the marker zone (left edge) to collapse.
    await summary.click({ position: { x: 4, y: 8 } });
    await expect(page.locator('#hw-root details')).not.toHaveAttribute('open', '');

    // Click again to expand.
    await summary.click({ position: { x: 4, y: 8 } });
    await expect(page.locator('#hw-root details')).toHaveAttribute('open', '');
  });

  test('Clicking the summary title text does not toggle', async ({ page }) => {
    await mountEditor(
      page,
      '<details open=""><summary>A long summary title to click</summary><p>body</p></details>',
    );

    // Click well past the marker zone, on the title text.
    await page.locator('#hw-root summary').click({ position: { x: 120, y: 8 } });
    await expect(page.locator('#hw-root details')).toHaveAttribute('open', '');
  });

  test('Toggling persists as an edit message', async ({ page }) => {
    await mountEditor(page, '<details open=""><summary>title</summary><p>body</p></details>');

    await page.locator('#hw-root summary').click({ position: { x: 4, y: 8 } });

    await page.waitForTimeout(DEBOUNCE_MS + 100);
    const edits = await getEditMessages(page);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    const last = edits[edits.length - 1];
    expect(last.html).toContain('<summary>title</summary>');
    expect(last.html).not.toContain('<details open');
  });
});
