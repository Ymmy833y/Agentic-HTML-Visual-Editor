import { expect, test } from '@playwright/test';

import { FLOATING_MENU_ELEMENT_ID } from '../../webview/ui/floating-menu';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { EDITOR_ROOT, focusEditor, openEditor, selectAll } from './helpers/editing';

const FLOATING = `#${FLOATING_MENU_ELEMENT_ID}`;

// A document of a few thousand paragraphs, one per line as an agent writes them.
const PARAGRAPH_COUNT = 3000;
const LARGE_BODY = `\n${Array.from(
  { length: PARAGRAPH_COUNT },
  (_, index) => `<p>Paragraph ${index} with some ordinary text in it.</p>`,
).join('\n')}\n`;

// The longest selecting all, or deleting the whole document, may hold the view before input is accepted again.
const OPERATION_LIMIT_MS = 1000;

test.describe('large documents', () => {
  test('selection updates comment availability within one second in a 3,000-paragraph document with comments', async ({ page }) => {
    const body = Array.from({ length: PARAGRAPH_COUNT }, (_, index) =>
      `<p>Text to select <comment id="c-${index}">annotated</comment></p>`,
    ).join('\n');
    await openEditor(page, body);
    await focusEditor(page);
    const started = Date.now();

    await page.evaluate(() => {
      const text = document.querySelector('#editor-root p')?.firstChild;
      if (text === undefined || text === null) {
        throw new Error('The first paragraph is missing');
      }
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 4);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
    await expect(page.locator(`#${TOOLBAR_ELEMENT_ID} [data-slot="${TOOLBAR_SLOT.comment}"] > button`))
      .toHaveAttribute('aria-disabled', 'false');
    await expect(page.locator(`${FLOATING} button[data-slot="${TOOLBAR_SLOT.comment}"]`))
      .toHaveAttribute('aria-disabled', 'false');

    expect(Date.now() - started).toBeLessThan(OPERATION_LIMIT_MS);
  });
  test('selecting all of a 3,000-paragraph document shows the floating menu within one second', async ({ page }) => {
    await openEditor(page, LARGE_BODY);
    await focusEditor(page);

    const started = Date.now();
    await selectAll(page);
    // The floating menu appears once the toolbar has read the new selection, so the wait spans that read.
    await page.locator(FLOATING).waitFor({ state: 'visible' });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(OPERATION_LIMIT_MS);
  });

  test('selecting all of a 3,000-paragraph document and pressing Delete returns within one second', async ({ page }) => {
    await openEditor(page, LARGE_BODY);
    await focusEditor(page);
    await selectAll(page);
    // The floating menu appears once the toolbar has read the new selection. Deleting before that read would leave
    // out whatever the read leaves behind.
    await expect(page.locator(FLOATING)).toBeVisible();

    const started = Date.now();
    // The press resolves only after the view has handled the key, so it spans the whole delete.
    await page.keyboard.press('Delete');
    const elapsed = Date.now() - started;

    await expect(page.locator(`${EDITOR_ROOT} p`)).toHaveCount(1);
    expect(elapsed).toBeLessThan(OPERATION_LIMIT_MS);
  });
});
