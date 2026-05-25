import { expect, test } from '@playwright/test';
import {
  DEBOUNCE_MS,
  caretAtEnd,
  focusEditor,
  getEditMessages,
  getRootHtml,
  mountEditor,
  selectTextInside,
} from './helpers/page';

test.describe('Toolbar editing', () => {
  test('Bold button wraps the selected text in <strong>', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await selectTextInside(page, '#hw-root p', 0, 5);

    await page.locator('#hw-tb-bold').click();

    expect(await getRootHtml(page)).toBe('<p><strong>hello</strong> world</p>');
  });

  test('Bold button unwraps when the selection already lives inside <strong>', async ({ page }) => {
    await mountEditor(page, '<p><strong>hello</strong> world</p>');
    // Select the contents of <strong>.
    await page.evaluate(() => {
      const el = document.querySelector('#hw-root strong')!;
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    await page.locator('#hw-tb-bold').click();

    expect(await getRootHtml(page)).toBe('<p>hello world</p>');
  });

  test('Italic and inline code buttons behave the same way', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await selectTextInside(page, '#hw-root p', 0, 5);
    await page.locator('#hw-tb-italic').click();
    expect(await getRootHtml(page)).toBe('<p><em>hello</em> world</p>');

    await mountEditor(page, '<p>hello world</p>');
    await selectTextInside(page, '#hw-root p', 0, 5);
    await page.locator('#hw-tb-code').click();
    expect(await getRootHtml(page)).toBe('<p><code>hello</code> world</p>');
  });

  test('Block-type dropdown swaps the block tag', async ({ page }) => {
    await mountEditor(page, '<p>title</p>');
    await caretAtEnd(page, '#hw-root p');
    await page.locator('.hw-tb-blk-btn').click();
    await page.locator('.hw-tb-blk-opt[data-value="h1"]').click();
    expect(await getRootHtml(page)).toBe('<h1>title</h1>');
  });

  test('Edits dispatch a debounced edit message that preserves the body wrapper', async ({ page }) => {
    const full = '<!DOCTYPE html><html><head></head><body><p>hello world</p></body></html>';
    await mountEditor(page, full);
    await selectTextInside(page, '#hw-root p', 0, 5);
    await page.locator('#hw-tb-bold').click();

    // The edit notification is debounced; wait one debounce window plus a
    // small slack so the timer definitely fires.
    await page.waitForTimeout(DEBOUNCE_MS + 100);
    const edits = await getEditMessages(page);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    const last = edits[edits.length - 1];
    expect(last.html).toContain('<strong>hello</strong>');
    expect(last.html).toContain('<body');
    expect(last.html).toContain('</body>');
  });
});

test.describe('Keyboard shortcuts', () => {
  test('Ctrl+B toggles <strong> around the current selection', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#hw-root p', 0, 5);
    await page.keyboard.press('Control+b');
    expect(await getRootHtml(page)).toBe('<p><strong>hello</strong> world</p>');
  });

  test('Ctrl+I toggles <em>', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await focusEditor(page);
    await selectTextInside(page, '#hw-root p', 0, 5);
    await page.keyboard.press('Control+i');
    expect(await getRootHtml(page)).toBe('<p><em>hello</em> world</p>');
  });

  test('Ctrl+Shift+1..6 set heading levels; Ctrl+Shift+0 restores P', async ({ page }) => {
    await mountEditor(page, '<p>title</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#hw-root p');
    await page.keyboard.press('Control+Shift+2');
    expect(await getRootHtml(page)).toBe('<h2>title</h2>');

    await caretAtEnd(page, '#hw-root h2');
    await page.keyboard.press('Control+Shift+0');
    expect(await getRootHtml(page)).toBe('<p>title</p>');
  });
});
