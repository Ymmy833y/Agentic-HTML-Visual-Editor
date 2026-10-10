import { expect, test } from '@playwright/test';

import {
  EDITOR_ROOT,
  focusEditor,
  installReceiver,
  openEditor,
  paste,
  selectAll,
  placeCaret,
  readBodyHtml,
  readRecord,
  readRuleMarks,
  registerMarkingRule,
} from './helpers/editing';

// Permit clipboard reads and writes so paste can use a real keyboard operation.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.describe('plain-text paste', () => {
  test('places the second line in a new paragraph when two lines are pasted within a paragraph', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 });

    await paste(page, { 'text/plain': 'X\nY' });

    expect(await readBodyHtml(page)).toBe('\n<p>aX</p>\n<p>Yb</p>\n');
  });

  test('pastes into an empty body inside a paragraph without leaving bare text', async ({ page }) => {
    await openEditor(page, '');
    await focusEditor(page);

    await paste(page, { 'text/plain': 'X' });

    expect(await readBodyHtml(page)).toBe('\n<p>X</p>');
  });

  test('splits pasted CRLF text into paragraphs without retaining CR', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 0 });

    await paste(page, { 'text/plain': 'X\r\nY' });

    expect(await readBodyHtml(page)).toBe('\n<p>X</p>\n<p>Yab</p>\n');
  });

  test('pastes multiple lines into one pre using line-break characters', async ({ page }) => {
    await openEditor(page, '\n<pre>ab</pre>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} pre`, childIndex: 0, offset: 1 });

    await paste(page, { 'text/plain': 'X\nY' });

    expect(await readBodyHtml(page)).toBe('\n<pre>aX\nYb</pre>\n');
  });

  test('reports replacement through notification and output after selecting all and pasting', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<p>cd</p>\n');
    await installReceiver(page);
    await focusEditor(page);
    await selectAll(page);

    await paste(page, { 'text/plain': 'X' });

    await page.waitForFunction(() => (window.__editingRecord?.bodies.length ?? 0) > 0);
    const record = await readRecord(page);
    expect(record.kinds).toEqual(['insertFromPaste']);
    expect(record.bodies[0]).toContain('X');
    expect(record.bodies[0]).not.toContain('ab');
  });

  test('replaces the selected range when pasting', async ({ page }) => {
    await openEditor(page, '\n<p>abcd</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 });
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');

    await paste(page, { 'text/plain': 'X' });

    expect(await readBodyHtml(page)).toBe('\n<p>aXd</p>\n');
  });
});

test.describe('paste with an HTML form and rule order', () => {
  test('Ctrl+V with both a text form and an HTML form inserts the HTML form b and span with color into the paragraph', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await paste(page, {
      'text/plain': 'XY',
      'text/html': '<b>X</b><span style="color:red">Y</span>',
    });

    expect(await readBodyHtml(page)).toBe('\n<p>ab<b>X</b><span style="color: red;">Y</span></p>\n');
  });

  test('Ctrl+V with no text form and an HTML form without visible content (only meta) changes neither the tree nor sends an immediate notification', async ({ page }) => {
    const body = '\n<p>ab</p>\n';
    await openEditor(page, body);
    await installReceiver(page);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await paste(page, { 'text/html': '<meta charset="utf-8">' });

    expect([await readBodyHtml(page), (await readRecord(page)).kinds]).toEqual([body, []]);
  });

  test('when a rule registered later for paste returns consumed, the built-in paste is not tried and no text is inserted', async ({ page }) => {
    const body = '\n<p>ab</p>\n';
    await openEditor(page, body);
    await registerMarkingRule(page, 'insertFromPaste', 'later', 'consumed');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await paste(page, { 'text/plain': 'X' });

    expect([await readBodyHtml(page), await readRuleMarks(page)]).toEqual([body, ['later']]);
  });
});
