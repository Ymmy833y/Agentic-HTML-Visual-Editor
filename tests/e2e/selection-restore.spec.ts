import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { EDITOR_ROOT, openEditor, placeCaret, readBodyHtml } from './helpers/editing';

/** A snapshot of the selection after document replacement. */
interface SelectionSnapshot {
  /** The start boundary: text content for text, or the element name and offset for an element. */
  readonly start: string;
  /** Text from the start of the editor root to the start of the selection. */
  readonly prefix: string;
  /** The selected text. */
  readonly selected: string;
}

/**
 * Builds complete document text.
 *
 * @param body The body HTML.
 * @param language The language declaration. Omit it to create a document without one.
 * @returns The complete document text.
 */
function documentText(body: string, language?: string): string {
  const openingTag = language === undefined ? '<html>' : `<html lang="${language}">`;
  return `<!DOCTYPE html>\n${openingTag}<body>${body}</body></html>`;
}

/**
 * Replaces the document while preserving the selection.
 *
 * @param page The target page.
 * @param text The complete text of the new document.
 * @returns `true` if the document was replaced.
 */
async function replaceDocument(page: Page, text: string): Promise<boolean> {
  return page.evaluate(
    (argument) => window.__documentReplacementProbe?.(argument) ?? false,
    text,
  );
}

/**
 * Reads the current selection.
 *
 * @param page The target page.
 * @returns A snapshot of the selection.
 */
async function readSelection(page: Page): Promise<SelectionSnapshot> {
  return page.evaluate((rootSelector) => {
    const root = document.querySelector(rootSelector);
    const range = window.getSelection()?.getRangeAt(0);
    if (root === null || range === undefined) {
      throw new Error('The editor root or selection is missing');
    }

    const container = range.startContainer;
    const name = container instanceof Text
      ? `#text(${container.data})`
      : (container instanceof Element ? container.localName : 'unknown');

    const before = document.createRange();
    before.setStart(root, 0);
    before.setEnd(container, range.startOffset);
    return {
      start: `${name}:${range.startOffset}`,
      prefix: before.toString(),
      selected: range.toString(),
    };
  }, EDITOR_ROOT);
}

test.describe('selection restoration across document replacement', () => {
  test('restores a caret within a paragraph after the same character when a preceding line is added', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n');
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await replaceDocument(page, documentText('\n<p>x</p>\n<p>abc</p>\n'));

    expect((await readSelection(page)).start).toBe('#text(abc):2');
  });

  test('restores both endpoints of a range selection to the same character offsets', async ({ page }) => {
    await openEditor(page, '\n<p>abcdef</p>\n');
    await page.evaluate((selector) => {
      const text = document.querySelector(selector)?.firstChild;
      if (text === null || text === undefined) {
        throw new Error('The test input contains no text node');
      }
      const range = document.createRange();
      range.setStart(text, 1);
      range.setEnd(text, 4);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, `${EDITOR_ROOT} p`);

    await replaceDocument(page, documentText('\n<p>x</p>\n<p>abcdef</p>\n'));

    expect((await readSelection(page)).selected).toBe('bcd');
  });

  test('restores a caret within an empty block to the same empty block', async ({ page }) => {
    await openEditor(page, '\n<p>a</p>\n<p><br></p>\n');
    await page.evaluate((selector) => {
      const block = document.querySelectorAll(selector)[1];
      const range = document.createRange();
      range.setStart(block, 0);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, `${EDITOR_ROOT} p`);

    await replaceDocument(page, documentText('\n<p>x</p>\n<p>a</p>\n<p><br></p>\n'));

    expect((await readSelection(page)).start).toBe('p:0');
  });

  test('restores a caret immediately after an img to the same position', async ({ page }) => {
    await openEditor(page, '\n<p><img src="a.png">b</p>\n');
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 1, offset: 0 });

    await replaceDocument(page, documentText('\n<p>x</p>\n<p><img src="a.png">b</p>\n'));

    expect((await readSelection(page)).start).toBe('p:1');
  });

  test('restores a caret to its original character with an empty inline element and trailing br', async ({ page }) => {
    const body = '\n<p>ab<em></em>cd<br></p>\n';
    await openEditor(page, body);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 2, offset: 1 });

    await replaceDocument(page, documentText(`\n<p>x</p>${body}`));

    expect((await readSelection(page)).start).toBe('#text(cd):1');
  });

  test('restores to the preceding line end when replacement deletes the caret line', async ({ page }) => {
    await openEditor(page, '\n<p>a</p>\n<p>b</p>\n');
    await placeCaret(page, { selector: `${EDITOR_ROOT} p + p`, childIndex: 0, offset: 1 });

    await replaceDocument(page, documentText('\n<p>a</p>\n'));

    expect((await readSelection(page)).prefix).toBe('\na');
  });

  test('places the caret at the editor root start when replacement makes the body empty', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n');
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await replaceDocument(page, documentText(''));

    expect((await readSelection(page)).start).toBe('div:0');
  });

  test('places the caret at the editor root start when the previous selection was outside it', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n');
    await page.evaluate(() => {
      const outside = document.createElement('p');
      outside.textContent = 'outside';
      document.body.append(outside);
      const range = document.createRange();
      range.selectNodeContents(outside);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });

    await replaceDocument(page, documentText('\n<p>x</p>\n<p>abc</p>\n'));

    // Verify that no text precedes the selection, placing it at the editor root start.
    expect((await readSelection(page)).prefix).toBe('');
  });

  test('replaces the editor root content with the new body', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n');

    await replaceDocument(page, documentText('\n<p>def</p>\n'));

    expect(await readBodyHtml(page)).toBe('\n<p>def</p>\n');
  });

  test('continues editing by typing directly in the editor root after replacement', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n');
    await replaceDocument(page, documentText('\n<p>def</p>\n'));
    await page.locator(EDITOR_ROOT).focus();
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 3 });

    await page.keyboard.type('Z');

    expect(await readBodyHtml(page)).toBe('\n<p>defZ</p>\n');
  });

  test('removes lang from the editor root when replacing a declared language with none', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n');
    await replaceDocument(page, documentText('\n<p>abc</p>\n', 'ja'));

    await replaceDocument(page, documentText('\n<p>abc</p>\n'));

    await expect(page.locator(EDITOR_ROOT)).not.toHaveAttribute('lang');
  });

  test('does not change the body when replacement text contains a forbidden tag', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n');
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await replaceDocument(page, documentText('\n<script>a</script>\n'));

    expect(await readBodyHtml(page)).toBe('\n<p>abc</p>\n');
  });

  test('does not change the caret when replacement text contains a forbidden tag', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n');
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await replaceDocument(page, documentText('\n<script>a</script>\n'));

    expect((await readSelection(page)).start).toBe('#text(abc):2');
  });
});
