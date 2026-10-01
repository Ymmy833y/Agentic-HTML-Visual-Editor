import { expect, test } from '@playwright/test';

import {
  EDITOR_ROOT,
  focusEditor,
  openEditor,
  placeCaret,
  readBodyHtml,
} from './helpers/editing';

const TABLE_BODY = '<table><tbody><tr><td>cell</td></tr></tbody></table>';

test.describe('paragraph materialization', () => {
  test('places text typed into an empty body in a paragraph without leaving bare text', async ({ page }) => {
    await openEditor(page, '');
    await focusEditor(page);

    await page.keyboard.type('\u3042');

    expect(await readBodyHtml(page)).toBe('\n<p>\u3042</p>');
  });

  test('creates two empty paragraphs when Enter is pressed in an empty body', async ({ page }) => {
    await openEditor(page, '');
    await focusEditor(page);

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<p><br></p>\n<p><br></p>');
  });

  test('places text typed after Enter in an empty body into the second paragraph', async ({ page }) => {
    await openEditor(page, '');
    await focusEditor(page);
    await page.keyboard.press('Enter');

    await page.keyboard.type('\u3042');

    await expect(page.locator(`${EDITOR_ROOT} p`).nth(1)).toHaveText('\u3042');
  });

  test('creates two breaks in a paragraph when Shift+Enter is pressed in an empty body', async ({ page }) => {
    await openEditor(page, '');
    await focusEditor(page);

    await page.keyboard.press('Shift+Enter');

    expect(await readBodyHtml(page)).toBe('\n<p><br><br></p>');
  });

  test('places text typed after Shift+Enter in an empty body on the second line', async ({ page }) => {
    await openEditor(page, '');
    await focusEditor(page);
    await page.keyboard.press('Shift+Enter');

    await page.keyboard.type('\u3042');

    // The text only needs to follow the in-paragraph break; whether a trailing placeholder remains is browser-dependent.
    expect(await page.locator(`${EDITOR_ROOT} p`).innerHTML()).toMatch(/^<br>\u3042/u);
  });

  test('replaces a body containing one break with a paragraph containing typed text', async ({ page }) => {
    await openEditor(page, '<br>');
    await focusEditor(page);

    await page.keyboard.type('\u3042');

    expect(await readBodyHtml(page)).toBe('\n<p>\u3042</p>');
  });

  test('does not create a paragraph or move the table when typing into bare text after it', async ({ page }) => {
    await openEditor(page, `${TABLE_BODY}para`);
    await focusEditor(page);
    await placeCaret(page, { selector: EDITOR_ROOT, childIndex: 1, offset: 4 });

    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe(`${TABLE_BODY}paraX`);
  });
});
