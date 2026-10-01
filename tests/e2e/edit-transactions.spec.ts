import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  HOST_TO_VIEW_MESSAGE_TYPE,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import type { EditTransaction } from '../../common/index';
import { OVERLAY_ELEMENT_ID } from '../../webview/ui/overlay-presenter';
import {
  EDITOR_ROOT,
  focusEditor,
  openEditor,
  paste,
  placeCaret,
  readBodyHtml,
} from './helpers/editing';
import { getOutboundMessages, sendToWebview, setSendFailure } from './helpers/page';

const BODY = '\n<p>ab</p>\n';
const BEFORE_TEXT = '<!DOCTYPE html>\n<html><body>\n<p>ab</p>\n</body></html>';
const OVERLAY = `#${OVERLAY_ELEMENT_ID}`;

// Allow reads and writes to verify pasting through the real clipboard.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

async function placeAfterAb(page: Page): Promise<void> {
  await focusEditor(page);
  await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
}

async function readTransactions(page: Page): Promise<EditTransaction[]> {
  const messages = await getOutboundMessages(page);
  return messages.flatMap((message) => {
    if (
      typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === VIEW_TO_HOST_MESSAGE_TYPE.editTransaction
      && 'transaction' in message
    ) {
      return [message.transaction as EditTransaction];
    }
    return [];
  });
}

async function readFlushResults(page: Page): Promise<{ requestId: string; success: boolean }[]> {
  const messages = await getOutboundMessages(page);
  return messages.flatMap((message) => {
    if (
      typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === VIEW_TO_HOST_MESSAGE_TYPE.editTransactionFlushResult
      && 'requestId' in message
      && 'success' in message
    ) {
      return [{ requestId: String(message.requestId), success: message.success === true }];
    }
    return [];
  });
}

async function waitForTransactions(page: Page, count: number): Promise<void> {
  await expect.poll(() => readTransactions(page)).toHaveLength(count);
}

/** Reads, in send order, the edit unit ids carried by messages of the given type. */
async function readUnitIds(page: Page, type: string): Promise<string[]> {
  const messages = await getOutboundMessages(page);
  return messages.flatMap((message) => {
    if (
      typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === type
    ) {
      if ('unitId' in message) {
        return [String(message.unitId)];
      }
      if ('transaction' in message) {
        return [String((message.transaction as EditTransaction).unitId)];
      }
    }
    return [];
  });
}

/**
 * Returns the position in send order where the given type first appears.
 *
 * @returns -1 if not found.
 */
async function indexOfType(page: Page, type: string): Promise<number> {
  const messages = await getOutboundMessages(page);
  return messages.findIndex((message) => (
    typeof message === 'object' && message !== null && 'type' in message && message.type === type
  ));
}

test.describe('edit transactions', () => {
  test('sends three characters typed within the timeout as one transaction with text and selection endpoints', async ({ page }) => {
    await openEditor(page, BODY);
    await placeAfterAb(page);

    await page.keyboard.type('XYZ');
    await waitForTransactions(page, 1);

    const [transaction] = await readTransactions(page);
    expect(transaction.before).toEqual(expect.objectContaining({ text: BEFORE_TEXT }));
    expect(transaction.after.text).toBe(
      '<!DOCTYPE html>\n<html><body>\n<p>abXYZ</p>\n</body></html>',
    );
    expect([transaction.before.selection, transaction.after.selection]).not.toContain(null);
  });

  test('delivers the start and then the pair with the same edit unit id on real key input', async ({ page }) => {
    await openEditor(page, BODY);
    await placeAfterAb(page);

    await page.keyboard.type('X');
    await waitForTransactions(page, 1);

    const starts = await readUnitIds(page, VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart);
    expect(starts).toHaveLength(1);
    // Unless the start arrives first, the host cannot set the dirty mark until the pair is complete.
    expect(await indexOfType(page, VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart))
      .toBeLessThan(await indexOfType(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction));
    expect(await readUnitIds(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).toEqual(starts);
  });

  test('turns a unit whose input was undone back to the same full text into an unchanged terminator on flush', async ({ page }) => {
    await openEditor(page, BODY);
    await placeAfterAb(page);

    // No keystroke reverts input while staying in the same grouping kind, so build it with a command edit of the
    // same kind as typing.
    await page.evaluate(() => {
      const paragraph = document.querySelector('#editor-root p');
      window.__editingSessionProbe?.()?.runCommandEdit('insertText', () => {
        paragraph?.append('X');
        return true;
      });
      window.__editingSessionProbe?.()?.runCommandEdit('insertText', () => {
        paragraph?.lastChild?.remove();
        return true;
      });
    });
    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.requestEditTransactionFlush,
      requestId: 'unchanged',
    });
    await expect.poll(() => readFlushResults(page)).toEqual([
      { requestId: 'unchanged', success: true },
    ]);

    expect(await readTransactions(page)).toEqual([]);
    expect(await readUnitIds(page, VIEW_TO_HOST_MESSAGE_TYPE.editUnitUnchanged))
      .toEqual(await readUnitIds(page, VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart));
  });

  test('sends typing as a separate earlier transaction when Backspace immediately follows it', async ({ page }) => {
    await openEditor(page, BODY);
    await placeAfterAb(page);

    await page.keyboard.type('X');
    await page.keyboard.press('Backspace');
    await waitForTransactions(page, 1);

    const [typing] = await readTransactions(page);
    expect([typing.before.text, typing.after.text]).toEqual([
      BEFORE_TEXT,
      '<!DOCTYPE html>\n<html><body>\n<p>abX</p>\n</body></html>',
    ]);
  });

  test('sends one transaction at the idle timeout after one character without another action', async ({ page }) => {
    await openEditor(page, BODY);
    await placeAfterAb(page);

    await page.keyboard.type('X');
    await waitForTransactions(page, 1);

    expect(await readTransactions(page)).toHaveLength(1);
  });

  test('sends a paste from the real clipboard immediately as one standalone transaction', async ({ page }) => {
    await openEditor(page, BODY);
    await placeAfterAb(page);

    await paste(page, { 'text/plain': 'pasted' });
    await waitForTransactions(page, 1);

    expect((await readTransactions(page))[0].after.text).toContain('<p>abpasted</p>');
  });

  test('groups consecutive Backspace and Delete edits into separate transactions by direction', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Backspace');
    await page.keyboard.press('Delete');
    await waitForTransactions(page, 2);

    expect((await readTransactions(page)).map((entry) => entry.after.text)).toEqual([
      '<!DOCTYPE html>\n<html><body>\n<p>ac</p>\n</body></html>',
      '<!DOCTYPE html>\n<html><body>\n<p>a</p>\n</body></html>',
    ]);
  });

  test('sends a command edit with no captured selection when the selection is outside the editor root', async ({ page }) => {
    await openEditor(page, BODY);

    const command = await page.evaluate(() => {
      const outside = document.createElement('p');
      outside.textContent = 'outside';
      document.body.append(outside);
      const range = document.createRange();
      range.selectNodeContents(outside);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const changed = window.__editingSessionProbe?.()?.runCommandEdit('appendCommand', () => {
        document.querySelector('#editor-root p')?.append('X');
        return true;
      });
      return { changed, html: document.querySelector('#editor-root')?.innerHTML };
    });
    expect(command).toEqual({ changed: true, html: '\n<p>abX</p>\n' });
    await waitForTransactions(page, 1);

    const [transaction] = await readTransactions(page);
    expect([transaction.before.selection, transaction.after.selection]).toEqual([null, null]);
  });

  test('blocks input after delivery failure, then retries in retained order and restores input', async ({ page }) => {
    await openEditor(page, BODY);
    await placeAfterAb(page);
    await setSendFailure(page, true);

    const command = await page.evaluate(() => {
      const changed = window.__editingSessionProbe?.()?.runCommandEdit('appendCommand', () => {
        document.querySelector('#editor-root p')?.append('X');
        return true;
      });
      return { changed, html: document.querySelector('#editor-root')?.innerHTML };
    });
    expect(command).toEqual({ changed: true, html: '\n<p>abX</p>\n' });
    await page.locator(OVERLAY).waitFor();
    await page.keyboard.type('Y');
    expect(await readBodyHtml(page)).toBe('\n<p>abX</p>\n');

    await setSendFailure(page, false);
    await page.locator(`${OVERLAY} button`).click();
    await expect(page.locator(OVERLAY)).toHaveCount(0);
    expect(await readTransactions(page)).toHaveLength(1);

    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 1, offset: 1 });
    await page.keyboard.type('Y');
    expect(await readBodyHtml(page)).toBe('\n<p>abXY</p>\n');
  });

  test('sends the transaction before a successful result with the same ID for a pre-timeout request', async ({ page }) => {
    await openEditor(page, BODY);
    await placeAfterAb(page);
    await page.keyboard.type('X');

    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.requestEditTransactionFlush,
      requestId: 'flush-1',
    });
    await expect.poll(() => readFlushResults(page)).toEqual([
      { requestId: 'flush-1', success: true },
    ]);

    const messages = await getOutboundMessages(page);
    const historyIndex = messages.findIndex((message) => (
      typeof message === 'object' && message !== null && 'type' in message
      && message.type === VIEW_TO_HOST_MESSAGE_TYPE.editTransaction
    ));
    const resultIndex = messages.findIndex((message) => (
      typeof message === 'object' && message !== null && 'type' in message
      && message.type === VIEW_TO_HOST_MESSAGE_TYPE.editTransactionFlushResult
    ));
    expect(historyIndex).toBeLessThan(resultIndex);
  });

  test('returns the same result without duplicating transactions when the same request ID arrives twice', async ({ page }) => {
    await openEditor(page, BODY);
    await placeAfterAb(page);
    await page.keyboard.type('X');
    const request = {
      type: HOST_TO_VIEW_MESSAGE_TYPE.requestEditTransactionFlush,
      requestId: 'same',
    } as const;

    await sendToWebview(page, request);
    await sendToWebview(page, request);
    await expect.poll(() => readFlushResults(page)).toHaveLength(2);

    expect(await readTransactions(page)).toHaveLength(1);
    expect(await readFlushResults(page)).toEqual([
      { requestId: 'same', success: true },
      { requestId: 'same', success: true },
    ]);
  });

  test('answers a request during IME composition after commit by sending one transaction', async ({ page }) => {
    await openEditor(page, BODY);
    await placeAfterAb(page);
    await page.evaluate(() => {
      document.querySelector('#editor-root')?.dispatchEvent(new CompositionEvent('compositionstart'));
    });

    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.requestEditTransactionFlush,
      requestId: 'ime',
    });
    expect(await readFlushResults(page)).toEqual([]);
    await page.evaluate(() => {
      const paragraph = document.querySelector('#editor-root p');
      paragraph?.append('composition');
      document.querySelector('#editor-root')?.dispatchEvent(
        new CompositionEvent('compositionend', { data: 'composition' }),
      );
    });

    await expect.poll(() => readFlushResults(page)).toEqual([{ requestId: 'ime', success: true }]);
    expect(await readTransactions(page)).toHaveLength(1);
  });
});
