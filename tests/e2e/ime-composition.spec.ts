import { expect, test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';

import {
  EDITOR_ROOT,
  dispatchBeforeInput,
  focusEditor,
  installReceiver,
  openEditor,
  placeCaret,
  readBodyHtml,
  readRecord,
} from './helpers/editing';

// Payload used to cancel composition. An empty composition string means it ended without a commit.
const CANCEL_COMPOSITION = { text: '', selectionStart: -1, selectionEnd: -1 };

/**
 * Opens a channel for driving the browser IME.
 *
 * @param page The target page.
 * @returns The opened channel.
 */
async function openImeSession(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

test.describe('IME composition', () => {
  test('sends no notification during composition and one after commit', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await installReceiver(page);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    const ime = await openImeSession(page);

    await ime.send('Input.imeSetComposition', { text: '\u3042', selectionStart: 1, selectionEnd: 1 });
    const duringComposition = (await readRecord(page)).kinds;
    await ime.send('Input.insertText', { text: '\u4e9c' });

    expect(duringComposition).toEqual([]);
    expect((await readRecord(page)).kinds).toEqual(['insertCompositionText']);
  });

  test('sends the committed composition body once after the deadline', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await installReceiver(page);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    const ime = await openImeSession(page);

    await ime.send('Input.imeSetComposition', { text: '\u3042', selectionStart: 1, selectionEnd: 1 });
    await ime.send('Input.insertText', { text: '\u4e9c' });

    await page.waitForFunction(() => (window.__editingRecord?.bodies.length ?? 0) > 0);
    expect((await readRecord(page)).bodies).toEqual(['\n<p>ab\u4e9c</p>\n']);
  });

  test('places composing text inside a paragraph when composition starts in an empty body', async ({ page }) => {
    await openEditor(page, '');
    await focusEditor(page);
    const ime = await openImeSession(page);

    await ime.send('Input.imeSetComposition', { text: '\u3042', selectionStart: 1, selectionEnd: 1 });

    await expect(page.locator(`${EDITOR_ROOT} p`)).toHaveText('\u3042');
  });

  test('restores an empty body after canceling composition in it', async ({ page }) => {
    await openEditor(page, '');
    await focusEditor(page);
    const ime = await openImeSession(page);
    await ime.send('Input.imeSetComposition', { text: '\u3042', selectionStart: 1, selectionEnd: 1 });

    await ime.send('Input.imeSetComposition', CANCEL_COMPOSITION);

    expect(await readBodyHtml(page)).toBe('');
  });

  test('sends no notification after canceling composition in an empty body', async ({ page }) => {
    await openEditor(page, '');
    await installReceiver(page);
    await focusEditor(page);
    const ime = await openImeSession(page);
    await ime.send('Input.imeSetComposition', { text: '\u3042', selectionStart: 1, selectionEnd: 1 });

    await ime.send('Input.imeSetComposition', CANCEL_COMPOSITION);

    expect((await readRecord(page)).kinds).toEqual([]);
  });

  test('restores the break after canceling composition in a body containing one break', async ({ page }) => {
    await openEditor(page, '<br>');
    await focusEditor(page);
    const ime = await openImeSession(page);
    await ime.send('Input.imeSetComposition', { text: '\u3042', selectionStart: 1, selectionEnd: 1 });

    await ime.send('Input.imeSetComposition', CANCEL_COMPOSITION);

    expect(await readBodyHtml(page)).toBe('<br>');
  });

  test('preserves the tree and sends no notification after canceling composition in a nonempty paragraph', async ({ page }) => {
    const body = '\n<p>ab</p>\n';
    await openEditor(page, body);
    await installReceiver(page);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    const ime = await openImeSession(page);
    await ime.send('Input.imeSetComposition', { text: '\u3042', selectionStart: 1, selectionEnd: 1 });

    await ime.send('Input.imeSetComposition', CANCEL_COMPOSITION);

    expect(await readBodyHtml(page)).toBe(body);
    expect((await readRecord(page)).kinds).toEqual([]);
  });

  test('does not split for Enter during composition and splits after commit', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    const ime = await openImeSession(page);
    await ime.send('Input.imeSetComposition', { text: '\u3042', selectionStart: 1, selectionEnd: 1 });

    // A physical Enter key arrives after committing composition, so dispatch paragraph insertion directly while composing.
    await dispatchBeforeInput(page, 'insertParagraph');
    const duringComposition = await page.locator(`${EDITOR_ROOT} p`).count();
    await ime.send('Input.insertText', { text: '\u4e9c' });
    await page.keyboard.press('Enter');

    expect(duringComposition).toBe(1);
    await expect(page.locator(`${EDITOR_ROOT} p`)).toHaveCount(2);
  });
});
