import { expect, test } from '@playwright/test';
import { caretAtEnd, focusEditor, getRootHtml, mountEditor } from './helpers/page';

test.describe('Lists', () => {
  test('UL button wraps the current paragraph in a bulleted list', async ({ page }) => {
    await mountEditor(page, '<p>a</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');

    await page.locator('#ahve-tb-ul').click();

    expect(await getRootHtml(page)).toBe('<ul><li>a</li></ul>');
  });

  test('OL button wraps the current paragraph in a numbered list', async ({ page }) => {
    await mountEditor(page, '<p>a</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');

    await page.locator('#ahve-tb-ol').click();

    expect(await getRootHtml(page)).toBe('<ol><li>a</li></ol>');
  });

  test('clicking the same list button again toggles back to a paragraph', async ({ page }) => {
    await mountEditor(page, '<ul><li>a</li></ul>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root li');

    await page.locator('#ahve-tb-ul').click();

    expect(await getRootHtml(page)).toBe('<p>a</p>');
  });

  test('the other list button switches ul to ol', async ({ page }) => {
    await mountEditor(page, '<ul><li>a</li></ul>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root li');

    await page.locator('#ahve-tb-ol').click();

    expect(await getRootHtml(page)).toBe('<ol><li>a</li></ol>');
  });

  test('Tab nests an item under the previous one', async ({ page }) => {
    await mountEditor(page, '<ul><li>a</li><li>b</li></ul>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root li:nth-child(2)');

    await page.keyboard.press('Tab');

    expect(await getRootHtml(page)).toBe('<ul><li>a<ul><li>b</li></ul></li></ul>');
  });

  test('Shift+Tab un-nests an item back up a level', async ({ page }) => {
    await mountEditor(page, '<ul><li>a<ul><li>b</li></ul></li></ul>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root ul ul li');

    await page.keyboard.press('Shift+Tab');

    expect(await getRootHtml(page)).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  test('Tab on the first item is a no-op and inserts no tab character', async ({ page }) => {
    await mountEditor(page, '<ul><li>a</li></ul>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root li');

    await page.keyboard.press('Tab');

    expect(await getRootHtml(page)).toBe('<ul><li>a</li></ul>');
  });

  test('the list button reflects the active state of the caret', async ({ page }) => {
    await mountEditor(page, '<ul><li>a</li></ul>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root li');

    await expect(page.locator('#ahve-tb-ul')).toHaveClass(/ahve-tb-active/);
    await expect(page.locator('#ahve-tb-ol')).not.toHaveClass(/ahve-tb-active/);
  });

  test('Enter in an empty trailing item exits the list', async ({ page }) => {
    await mountEditor(page, '<ul><li>a</li></ul>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root li');

    await page.keyboard.press('Enter'); // browser splits into a new empty item
    await page.keyboard.press('Enter'); // our handler exits the list

    expect(await getRootHtml(page)).toBe('<ul><li>a</li></ul><p><br></p>');
  });
});
