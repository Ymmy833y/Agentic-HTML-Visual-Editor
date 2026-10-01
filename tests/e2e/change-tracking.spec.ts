import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  EDITOR_ROOT,
  focusEditor,
  installReceiver,
  openEditor,
  placeCaret,
  readBodyHtml,
  readRecord,
  selectAll,
} from './helpers/editing';

// A body with variant spelling used to verify that untouched lines remain verbatim.
const SPELLING_BODY = '\n<p id ="kept" >untouched</p>\n<p>edited</p>\n';

/**
 * Waits for body output.
 *
 * @param page The target page.
 * @param count The number of outputs to await.
 */
async function waitForOutputs(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) => (window.__editingRecord?.bodies.length ?? 0) >= expected,
    count,
  );
}

test.describe('change tracking and output', () => {
  test('sends three immediate notifications after typing three consecutive characters', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await installReceiver(page);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await page.keyboard.type('XYZ');

    expect((await readRecord(page)).kinds).toEqual(['insertText', 'insertText', 'insertText']);
  });

  test('sends one output containing all three consecutive characters', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await installReceiver(page);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await page.keyboard.type('XYZ');

    await waitForOutputs(page, 1);
    expect((await readRecord(page)).bodies).toEqual(['\n<p>abXYZ</p>\n']);
  });

  test('reports paragraph insertion as the input type for Enter', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await installReceiver(page);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Enter');

    expect((await readRecord(page)).kinds).toEqual(['insertParagraph']);
  });

  test('flushes output immediately after typing without waiting for the deadline', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await installReceiver(page);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    await page.keyboard.type('X');

    await page.evaluate(() => window.__editingSessionProbe?.()?.flush());

    expect((await readRecord(page)).bodies).toEqual(['\n<p>abX</p>\n']);
  });

  test('reports only subsequent edits when the receiver is registered later', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    await page.keyboard.type('X');

    await installReceiver(page);
    await page.keyboard.type('Y');

    expect((await readRecord(page)).kinds).toEqual(['insertText']);
  });

  test('preserves untouched disk-body lines verbatim in output after an edit', async ({ page }) => {
    await openEditor(page, SPELLING_BODY);
    await installReceiver(page);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p:nth-of-type(2)`, childIndex: 0, offset: 6 });

    await page.keyboard.type('X');

    await waitForOutputs(page, 1);
    expect((await readRecord(page)).bodies).toEqual([
      '\n<p id ="kept" >untouched</p>\n<p>editedX</p>\n',
    ]);
  });

  test('preserves a block line verbatim after pressing Enter at its start', async ({ page }) => {
    await openEditor(page, '\n<p>edited</p>\n<p id ="kept" >untouched</p>\n');
    await installReceiver(page);
    await focusEditor(page);
    await placeCaret(page, {
      selector: `${EDITOR_ROOT} p:nth-of-type(2)`,
      childIndex: 0,
      offset: 0,
    });

    await page.keyboard.press('Enter');

    await waitForOutputs(page, 1);
    expect((await readRecord(page)).bodies).toEqual([
      '\n<p>edited</p>\n\n<p><br></p>\n<p id ="kept" >untouched</p>\n',
    ]);
  });

  test('reports deleted content through notification and output after selecting all and pressing Enter', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<p>cd</p>\n');
    await installReceiver(page);
    await focusEditor(page);
    await selectAll(page);

    await page.keyboard.press('Enter');

    await waitForOutputs(page, 1);
    const record = await readRecord(page);
    expect(record.kinds).toEqual(['insertParagraph']);
    expect(record.bodies).toEqual(['\n<p><br></p>\n<p><br></p>\n']);
  });

  test('sends nothing to the receiver when typing after session disposal', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await installReceiver(page);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await page.evaluate(() => window.__editingSessionProbe?.()?.dispose());
    await page.keyboard.type('X');

    expect(await readRecord(page)).toEqual({ kinds: [], bodies: [] });
  });

  test('creates a paragraph and places the caret inside when ensuring a target in an empty body', async ({ page }) => {
    await openEditor(page, '');
    await focusEditor(page);

    await page.evaluate(() => window.__editingSessionProbe?.()?.ensureTargetBlock());
    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe('\n<p>X</p>');
  });

  test('returns the current paragraph without changing the tree when ensuring a target inside it', async ({ page }) => {
    const body = '\n<p>ab</p>\n';
    await openEditor(page, body);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 });

    const tagName = await page.evaluate(
      () => window.__editingSessionProbe?.()?.ensureTargetBlock()?.localName,
    );

    expect(tagName).toBe('p');
    expect(await readBodyHtml(page)).toBe(body);
  });

  test('does not ensure a target or change the tree when the selection is outside the editor root', async ({ page }) => {
    const body = '\n<p>ab</p>\n';
    await openEditor(page, body);

    const target = await page.evaluate(() => {
      const outside = document.createElement('p');
      outside.textContent = 'outside';
      document.body.append(outside);
      const range = document.createRange();
      range.selectNodeContents(outside);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return window.__editingSessionProbe?.()?.ensureTargetBlock()?.localName;
    });

    expect(target).toBeUndefined();
    expect(await readBodyHtml(page)).toBe(body);
  });

  test('inserts exactly one line break before a block inserted through the primitive', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await installReceiver(page);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 });

    await page.evaluate(() => {
      const session = window.__editingSessionProbe?.();
      const target = session?.ensureTargetBlock();
      if (session === undefined || target === undefined) {
        throw new Error('Unable to ensure target block');
      }
      const inserted = document.createElement('h2');
      inserted.textContent = 'inserted';
      session.runCommandEdit('insertBlockCommand', () => {
        session.insertBlock(inserted, target, 'after');
        return true;
      });
    });

    await waitForOutputs(page, 1);
    expect((await readRecord(page)).bodies).toEqual(['\n<p>ab</p>\n<h2>inserted</h2>\n']);
  });
});
