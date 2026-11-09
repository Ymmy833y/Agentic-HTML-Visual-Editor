import { expect, test } from '@playwright/test';

import {
  EDITOR_ROOT,
  deleteWordBackward,
  dispatchBeforeInput,
  focusEditor,
  installReceiver,
  openEditor,
  placeCaret,
  pressPrimaryShortcut,
  readBodyHtml,
  readRecord,
  selectAll,
} from './helpers/editing';

test.describe('block merge', () => {
  test('merges at the start of the second paragraph without inserting a span', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<p>cd</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p:nth-of-type(2)`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<p>abcd</p>\n');
  });

  test('inserts text typed at the post-merge caret into the merge point', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<p>cd</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p:nth-of-type(2)`, childIndex: 0, offset: 0 });
    await page.keyboard.press('Backspace');

    await page.keyboard.type('X');

    await expect(page.locator(`${EDITOR_ROOT} p`)).toHaveText('abXcd');
  });

  test('merges with the next paragraph when Delete is pressed at the end of the first', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<p>cd</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p:nth-of-type(1)`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe('\n<p>abcd</p>\n');
  });

  test('removes only an empty paragraph after a heading when Backspace is pressed', async ({ page }) => {
    await openEditor(page, '\n<h2>ab</h2>\n<p><br></p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<h2>ab</h2>\n');
  });

  test('performs the same merge for backward word deletion at the second paragraph start', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<p>cd</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p:nth-of-type(2)`, childIndex: 0, offset: 0 });

    await deleteWordBackward(page);

    expect(await readBodyHtml(page)).toBe('\n<p>abcd</p>\n');
  });

  test('Backspace at the start of a paragraph right after a list moves the paragraph content to the end of the last item and notifies one edit', async ({ page }) => {
    await openEditor(page, '\n<ul><li>ab</li></ul>\n<p>cd</p>\n');
    await installReceiver(page);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect([await readBodyHtml(page), (await readRecord(page)).kinds])
      .toEqual(['\n<ul><li>abcd</li></ul>\n', ['deleteContentBackward']]);
  });

  test('does not delete pre content at the start of the following paragraph', async ({ page }) => {
    const body = '\n<pre>ab</pre>\n<p>cd</p>\n';
    await openEditor(page, body);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe(body);
  });

  test('suppresses backward line deletion at the start of a block', async ({ page }) => {
    const body = '\n<p>ab</p>\n<p>cd</p>\n';
    await openEditor(page, body);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p:nth-of-type(2)`, childIndex: 0, offset: 0 });

    const prevented = await dispatchBeforeInput(page, 'deleteHardLineBackward');

    expect(prevented).toBe(true);
    expect(await readBodyHtml(page)).toBe(body);
  });

  test('preserves a heading when Backspace deletes a selection crossing into a paragraph', async ({ page }) => {
    await openEditor(page, '\n<h2>abc</h2>\n<p>def</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} h2`, childIndex: 0, offset: 1 });
    for (let index = 0; index < 5; index += 1) {
      await page.keyboard.press('Shift+ArrowRight');
    }

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<h2>af</h2>\n');
  });

  test('leaves both ends separated by a line break when Delete removes a selection crossing into a list', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n<ul><li>def</li></ul>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 });
    for (let index = 0; index < 5; index += 1) {
      await page.keyboard.press('Shift+ArrowRight');
    }

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe('\n<p>a</p>\n<ul><li>f</li></ul>\n');
  });

  test('keeps a paragraph whose whole text is selected and deleted as an empty line, and the next character goes into it', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<p>cd</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 0 });
    for (let index = 0; index < 2; index += 1) {
      await page.keyboard.press('Shift+ArrowRight');
    }

    await page.keyboard.press('Delete');
    const emptied = await readBodyHtml(page);
    await page.keyboard.type('Z');

    expect([emptied, await readBodyHtml(page)]).toEqual(['\n<p><br></p>\n<p>cd</p>\n', '\n<p>Z</p>\n<p>cd</p>\n']);
  });

  test('leaves one empty paragraph and reports notification and output after selecting all and pressing Backspace', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<p>cd</p>\n');
    await installReceiver(page);
    await focusEditor(page);
    await selectAll(page);

    await page.keyboard.press('Backspace');

    await page.waitForFunction(() => (window.__editingRecord?.bodies.length ?? 0) > 0);
    const record = await readRecord(page);
    expect(record.kinds).toEqual(['deleteContentBackward']);
    expect(record.bodies).toEqual(['\n<p><br></p>\n']);
  });

  test('deletes only the preceding character when Backspace is pressed within a paragraph', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Backspace');

    await expect(page.locator(`${EDITOR_ROOT} p`)).toHaveText('ac');
  });

  test('puts only the bold character into the heading when Ctrl+B and typing follow Backspace in the empty paragraph after an empty heading', async ({ page }) => {
    await openEditor(page, '\n<h2><br></h2>\n<p><br></p>\n');
    await focusEditor(page);
    // The fourth child of the editor root is the empty paragraph, so the caret goes to its start.
    await placeCaret(page, { selector: EDITOR_ROOT, childIndex: 3, offset: 0 });
    await page.keyboard.press('Backspace');

    await pressPrimaryShortcut(page, 'B');
    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe('\n<h2><strong>X</strong></h2>\n');
  });

  test('moves the next paragraph into the empty last line when Backspace is pressed at its start after a paragraph that ends with a line break', async ({ page }) => {
    await openEditor(page, '\n<p>ab<br><br></p>\n<p>cd</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p:nth-of-type(2)`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<p>ab<br>cd</p>\n');
  });

  test('leaves only one empty paragraph after selecting all of a document starting with a heading and pressing Delete', async ({ page }) => {
    await openEditor(page, '\n<h2>ab</h2>\n<p>cd</p>\n');
    await focusEditor(page);
    await selectAll(page);

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe('\n<p><br></p>\n');
  });

  test('leaves only one empty paragraph after selecting all of a document starting with a code block and pressing Backspace', async ({ page }) => {
    await openEditor(page, '\n<pre><code>ab</code></pre>\n<p>cd</p>\n');
    await focusEditor(page);
    await selectAll(page);

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<p><br></p>\n');
  });

  test('leaves no list when Delete removes a selection from the middle of a paragraph to the end of the last item', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n<ul><li>def</li></ul>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 });
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press('Shift+ArrowRight');
    }

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe('\n<p>a</p>\n');
  });

  test('leaves no code block when Delete removes a selection from the middle of a paragraph to the end of the code block', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n<pre><code>def</code></pre>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 });
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press('Shift+ArrowRight');
    }

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe('\n<p>a</p>\n');
  });

  test('leaves only one empty paragraph after selecting all of a document starting with a code block whose code has a class and pressing Backspace', async ({ page }) => {
    await openEditor(page, '\n<pre><code class="language-js">ab</code></pre>\n<p>cd</p>\n');
    await focusEditor(page);
    await selectAll(page);

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<p><br></p>\n');
  });

  test('leaves no code block when Delete removes a selection from the middle of a paragraph to the end of a code block whose code has a class', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n<pre><code class="language-js">def</code></pre>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 });
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press('Shift+ArrowRight');
    }

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe('\n<p>a</p>\n');
  });

  test('leaves only one empty paragraph after selecting all of a document starting with a heading whose text is a link and pressing Backspace', async ({ page }) => {
    await openEditor(page, '\n<h2><a href="#x">ab</a></h2>\n<p>cd</p>\n');
    await focusEditor(page);
    await selectAll(page);

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<p><br></p>\n');
  });
});
