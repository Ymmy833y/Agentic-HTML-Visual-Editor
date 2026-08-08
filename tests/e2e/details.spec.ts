import { expect, test } from '@playwright/test';
import {
  caretAtEnd,
  caretAtStart,
  focusEditor,
  getRootHtml,
  mountEditor,
  saveAndGetHtml,
} from './helpers/page';

test.describe('Details / summary', () => {
  const BOUNDARY_HTML =
    '<p>lead</p><details open=""><summary>Title</summary>' +
    '<p>Hidden body</p></details><p>tail</p>';

  test('Details toolbar button inserts a collapsible section', async ({ page }) => {
    await mountEditor(page, '<p>hello</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');

    await page.locator('#ahve-toolbar button', { hasText: 'Details' }).click();

    expect(await getRootHtml(page)).toBe(
      '<p>hello</p><details open=""><summary>Details</summary><p><br></p></details>',
    );
  });

  test('Enter inside the summary drops into the body without splitting it', async ({ page }) => {
    await mountEditor(page, '<details open=""><summary>title</summary><p>body</p></details>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root summary');

    await page.keyboard.press('Enter');
    await page.keyboard.type('Z');

    // Exactly one summary survived, and the typed text landed in the body.
    expect(await page.locator('#ahve-root summary').count()).toBe(1);
    expect(await getRootHtml(page)).toContain('<p>Zbody</p>');
  });

  test('Backspace at the start of summary preserves the entire details structure', async ({ page }) => {
    await mountEditor(page, BOUNDARY_HTML);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root summary');

    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe(BOUNDARY_HTML);
  });

  test('Delete at the end of summary preserves the entire details structure', async ({ page }) => {
    await mountEditor(page, BOUNDARY_HTML);
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root summary');

    await page.keyboard.press('Delete');

    expect(await getRootHtml(page)).toBe(BOUNDARY_HTML);
  });

  test('Backspace at the start of a non-empty details body preserves the summary', async ({ page }) => {
    await mountEditor(page, BOUNDARY_HTML);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root details > p');

    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe(BOUNDARY_HTML);
  });

  test('Backspace immediately after details preserves the entire details structure', async ({ page }) => {
    await mountEditor(page, BOUNDARY_HTML);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p:last-child');

    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe(BOUNDARY_HTML);
  });

  test('Delete immediately before details preserves its summary and body', async ({ page }) => {
    await mountEditor(page, BOUNDARY_HTML);
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root > p:first-child');

    await page.keyboard.press('Delete');

    expect(await getRootHtml(page)).toBe(BOUNDARY_HTML);
  });

  test('Clicking the disclosure marker toggles open/closed', async ({ page }) => {
    await mountEditor(page, '<details open=""><summary>title</summary><p>body</p></details>');

    const summary = page.locator('#ahve-root summary');
    // Click the marker zone (left edge) to collapse.
    await summary.click({ position: { x: 4, y: 8 } });
    await expect(page.locator('#ahve-root details')).not.toHaveAttribute('open', '');

    // Click again to expand.
    await summary.click({ position: { x: 4, y: 8 } });
    await expect(page.locator('#ahve-root details')).toHaveAttribute('open', '');
  });

  test('Clicking the summary title text does not toggle', async ({ page }) => {
    await mountEditor(
      page,
      '<details open=""><summary>A long summary title to click</summary><p>body</p></details>',
    );

    // Click well past the marker zone, on the title text.
    await page.locator('#ahve-root summary').click({ position: { x: 120, y: 8 } });
    await expect(page.locator('#ahve-root details')).toHaveAttribute('open', '');
  });

  test('Toggling persists into the saved document', async ({ page }) => {
    await mountEditor(page, '<details open=""><summary>title</summary><p>body</p></details>');

    await page.locator('#ahve-root summary').click({ position: { x: 4, y: 8 } });

    const html = await saveAndGetHtml(page);
    expect(html).toContain('<summary>title</summary>');
    expect(html).not.toContain('<details open');
  });

  test('Mouse drag selects across the details body paragraphs', async ({ page }) => {
    await mountEditor(
      page,
      '<details open=""><summary>Details</summary>' +
        '<h3>internl header</h3>' +
        '<p>Internal text1.</p>' +
        '<p>Internal text2.</p></details>',
    );

    const p1 = page.locator('#ahve-root p').nth(0);
    const p2 = page.locator('#ahve-root p').nth(1);
    const box1 = await p1.boundingBox();
    const box2 = await p2.boundingBox();
    if (!box1 || !box2) throw new Error('paragraph has no bounding box');

    // Drag from the start of "Internal text1." to the end of "Internal text2.".
    await page.mouse.move(box1.x, box1.y + box1.height / 2);
    await page.mouse.down();
    await page.mouse.move(box2.x + box2.width - 2, box2.y + box2.height / 2, { steps: 12 });
    await page.mouse.up();

    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    expect(selected).toContain('Internal text1.');
    expect(selected).toContain('Internal text2.');
  });

  test('Shift+ArrowDown extends the selection into the next details paragraph', async ({ page }) => {
    await mountEditor(
      page,
      '<details open=""><summary>Details</summary>' +
        '<p>Internal text1.</p>' +
        '<p>Internal text2.</p></details>',
    );
    await focusEditor(page);
    // Collapsed caret at the start of "Internal text1.".
    await page.evaluate(() => {
      const p1 = document.querySelectorAll('#ahve-root p')[0];
      const r = document.createRange();
      r.setStart(p1.firstChild!, 0);
      r.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
    });
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+End');
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    expect(selected).toContain('Internal text1.');
    expect(selected).toContain('Internal text2.');
  });

  test('Shift+ArrowDown from a full first-line selection reaches the same column below', async ({ page }) => {
    await mountEditor(
      page,
      '<details open=""><summary>Details</summary>' +
        '<p>Internal text1.</p>' +
        '<p>Internal text2.</p></details>',
    );
    await focusEditor(page);
    // Select all of "Internal text1." with the focus at its end.
    await page.evaluate(() => {
      const t1 = document.querySelectorAll('#ahve-root p')[0].firstChild as Text;
      window.getSelection()!.setBaseAndExtent(t1, 0, t1, t1.data.length);
    });
    // A single Shift+ArrowDown extends into the next paragraph at the same
    // column (its end), so both lines end up fully selected.
    await page.keyboard.press('Shift+ArrowDown');
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    expect(selected).toContain('Internal text1.');
    expect(selected).toContain('Internal text2.');
  });
});
