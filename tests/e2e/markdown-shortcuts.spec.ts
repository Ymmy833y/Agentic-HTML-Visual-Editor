import { expect, test } from '@playwright/test';
import { caretAtEnd, focusEditor, getRootHtml, mountEditor } from './helpers/page';

test.describe('Markdown-style shortcuts', () => {
  test('"# " at the start of a paragraph converts it to <h1>', async ({ page }) => {
    await mountEditor(page, '<p>#</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#hw-root p');
    await page.keyboard.press('Space');
    expect(await getRootHtml(page)).toBe('<h1><br></h1>');
  });

  test('"###### " produces an <h6>', async ({ page }) => {
    await mountEditor(page, '<p>######</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#hw-root p');
    await page.keyboard.press('Space');
    await expect(page.locator('#hw-root h6')).toHaveCount(1);
  });

  test('"---" + Enter becomes <hr> followed by a fresh paragraph', async ({ page }) => {
    await mountEditor(page, '<p>---</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#hw-root p');
    await page.keyboard.press('Enter');
    expect(await getRootHtml(page)).toBe('<hr><p><br></p>');
  });

  test('does not fire when "#" is not at the start of the block', async ({ page }) => {
    await mountEditor(page, '<p>hello#</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#hw-root p');
    await page.keyboard.press('Space');
    const html = await getRootHtml(page);
    // The space is inserted normally (browser default). The block must NOT
    // have been promoted to a heading.
    await expect(page.locator('#hw-root h1, #hw-root h2, #hw-root h3')).toHaveCount(0);
    expect(html.startsWith('<p>')).toBe(true);
  });
});
