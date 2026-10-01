import { expect, test } from '@playwright/test';

import {
  EDITOR_ROOT,
  focusEditor,
  openEditor,
  placeCaret,
  readBodyHtml,
} from './helpers/editing';

test.describe('Enter and Shift+Enter', () => {
  test('moves trailing content to a new paragraph without creating a div', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 });

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<p>a</p>\n<p>bc</p>\n');
  });

  test('inserts exactly one line break before a new paragraph at the paragraph end', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 3 });

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<p>abc</p>\n<p><br></p>\n');
  });

  test('creates a paragraph after pressing Enter at the end of a heading', async ({ page }) => {
    await openEditor(page, '\n<h2>abc</h2>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} h2`, childIndex: 0, offset: 3 });

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<h2>abc</h2>\n<p><br></p>\n');
  });

  test('creates an empty preceding paragraph and keeps the original paragraph on its own line', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n\n<p><br></p>\n<p>abc</p>\n');
  });

  test('keeps the caret in the original paragraph after pressing Enter at its start', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 0 });
    await page.keyboard.press('Enter');

    await page.keyboard.type('X');

    await expect(page.locator(`${EDITOR_ROOT} p`).nth(1)).toHaveText('Xabc');
  });

  test('replaces a selection with a br when Shift+Enter is pressed', async ({ page }) => {
    await openEditor(page, '\n<p>abcd</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 });
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');

    await page.keyboard.press('Shift+Enter');

    expect(await readBodyHtml(page)).toBe('\n<p>a<br>d</p>\n');
  });

  test('does not duplicate an id when splitting a paragraph', async ({ page }) => {
    await openEditor(page, '\n<p id="dup">abc</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 });

    await page.keyboard.press('Enter');

    await expect(page.locator(`${EDITOR_ROOT} [id="dup"]`)).toHaveCount(1);
  });

  test('deletes a selection before splitting when Enter is pressed', async ({ page }) => {
    await openEditor(page, '\n<p>abcd</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 });
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<p>a</p>\n<p>d</p>\n');
  });

  test('inserts a line-break character inside pre without adding a block', async ({ page }) => {
    await openEditor(page, '\n<pre>ab</pre>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} pre`, childIndex: 0, offset: 1 });

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<pre>a\nb</pre>\n');
  });

  test('Enter inside a section that is a child of a cell inserts a line break within the block as before, without splitting the cell', async ({ page }) => {
    // Enter directly inside a cell is taken over by the rule that turns the cell's content into paragraphs and splits
    // it. The built-in Enter inserts a line break within a block into a cell only inside an element among the cell's
    // children that is not phrasing content (such as section).
    await openEditor(page, '\n<table><tbody><tr><td><section>ab</section></td></tr></tbody></table>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} td section`, childIndex: 0, offset: 1 });

    await page.keyboard.press('Enter');

    await expect(page.locator(`${EDITOR_ROOT} td`)).toHaveJSProperty('innerHTML', '<section>a<br>b</section>');
  });

  // A collapsible section's first summary acts as its heading, so Enter inside it is taken over by
  // moving into the body. For a second or later summary, which has no body to move into, an in-block
  // line break is the final behavior.
  test('inserts a br without splitting it, for a summary that is not a title', async ({ page }) => {
    await openEditor(page, '\n<details><summary>t</summary><summary>ab</summary><p>c</p></details>\n');
    await focusEditor(page);
    await placeCaret(page, {
      selector: `${EDITOR_ROOT} summary:last-of-type`,
      childIndex: 0,
      offset: 1,
    });

    await page.keyboard.press('Enter');

    await expect(page.locator(`${EDITOR_ROOT} summary:last-of-type`))
      .toHaveJSProperty('innerHTML', 'a<br>b');
  });

  test('inserts a br inside a bare blockquote without splitting it', async ({ page }) => {
    await openEditor(page, '\n<blockquote>ab</blockquote>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} blockquote`, childIndex: 0, offset: 1 });

    await page.keyboard.press('Enter');

    await expect(page.locator(`${EDITOR_ROOT} blockquote`)).toHaveJSProperty('innerHTML', 'a<br>b');
  });

  test('inserts a br in the same nonempty paragraph with Shift+Enter', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 });

    await page.keyboard.press('Shift+Enter');

    await expect(page.locator(`${EDITOR_ROOT} p`)).toHaveJSProperty('innerHTML', 'a<br>b');
  });

  test('inserts a line-break character rather than a br with Shift+Enter inside pre', async ({ page }) => {
    await openEditor(page, '\n<pre>ab</pre>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} pre`, childIndex: 0, offset: 1 });

    await page.keyboard.press('Shift+Enter');

    expect(await readBodyHtml(page)).toBe('\n<pre>a\nb</pre>\n');
  });

  test('wraps bare text directly beneath the editor root in a paragraph before splitting', async ({ page }) => {
    await openEditor(page, 'abc');
    await focusEditor(page);
    await placeCaret(page, { selector: EDITOR_ROOT, childIndex: 0, offset: 1 });

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<p>a</p>\n<p>bc</p>');
  });
});
