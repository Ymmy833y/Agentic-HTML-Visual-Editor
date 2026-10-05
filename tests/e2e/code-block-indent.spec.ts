import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  DOCUMENT_APPLY_KIND,
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import type { EditTransaction } from '../../common/index';
import { EDITOR_ROOT, openEditor, readBodyHtml } from './helpers/editing';
import { getOutboundMessages, sendToWebview } from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

declare global {
  interface Window {
    /** The codes of keydown events that reached the window's bubbling phase, as VS Code would forward them. */
    __forwardedKeys?: string[];
  }
}

/** A position in text: which character of which text child of which element. */
interface TextPoint {
  readonly selector: string;
  readonly childIndex: number;
  readonly offset: number;
}

/**
 * Selects between two text positions, with focus on the editor root.
 *
 * @param page The page.
 * @param start The start.
 * @param end The end. The caret goes to the start when omitted.
 */
async function select(page: Page, start: TextPoint, end: TextPoint = start): Promise<void> {
  await page.evaluate((argument) => {
    const root = document.getElementById(argument.rootId);
    root?.focus();
    const resolve = (point: TextPoint): [Node, number] => {
      const element = document.querySelector(point.selector);
      if (element === null) {
        throw new Error(`Element not found: ${point.selector}`);
      }
      return [element.childNodes[point.childIndex], point.offset];
    };
    const range = document.createRange();
    range.setStart(...resolve(argument.start));
    range.setEnd(...resolve(argument.end));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { rootId: EDITOR_ROOT_ELEMENT_ID, start, end });
}

/**
 * Reads the selected text.
 *
 * @param page The page.
 * @returns The text of the selection.
 */
async function readSelectedText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

/**
 * Starts recording the keys that reach the window's bubbling phase, where VS Code picks them up.
 *
 * @param page The page.
 */
async function installForwardRecord(page: Page): Promise<void> {
  await page.evaluate(() => {
    const record: string[] = [];
    window.__forwardedKeys = record;
    window.addEventListener('keydown', (event) => record.push(event.code));
  });
}

/**
 * Asks for pending edit units and returns every unit sent so far.
 *
 * @param page The page.
 * @param requestId The request id of the flush.
 * @returns The edit units.
 */
async function flushTransactions(page: Page, requestId: string): Promise<EditTransaction[]> {
  await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestEditTransactionFlush, requestId });
  await expect.poll(async () => (await getOutboundMessages(page)).some((message) => (
    typeof message === 'object'
    && message !== null
    && Reflect.get(message, 'type') === VIEW_TO_HOST_MESSAGE_TYPE.editTransactionFlushResult
    && Reflect.get(message, 'requestId') === requestId
  ))).toBe(true);
  return (await getOutboundMessages(page)).flatMap((message) => (
    typeof message === 'object'
    && message !== null
    && Reflect.get(message, 'type') === VIEW_TO_HOST_MESSAGE_TYPE.editTransaction
      ? [Reflect.get(message, 'transaction') as EditTransaction]
      : []
  ));
}

test.describe('Tab in a code block', () => {
  test('puts four spaces at the caret, keeps focus, sends one edit unit, and keeps the key from VS Code', async ({ page }) => {
    const body = '\n<pre><code>ab\ncd\n</code></pre>\n';
    await openEditor(page, body);
    await select(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 1 });
    await installForwardRecord(page);

    await page.keyboard.press('Tab');
    const transactions = await flushTransactions(page, 'indent');

    expect([
      await readBodyHtml(page),
      await page.evaluate((id) => document.activeElement?.id === id, EDITOR_ROOT_ELEMENT_ID),
      transactions.map((transaction) => transaction.before.text),
      await page.evaluate(() => window.__forwardedKeys?.includes('Tab') ?? false),
    ]).toEqual([
      '\n<pre><code>a    b\ncd\n</code></pre>\n',
      true,
      [`${PROLOGUE}${body}${EPILOGUE}`],
      false,
    ]);
  });

  test('Shift+Tab removes one level of indent from the line of the caret', async ({ page }) => {
    await openEditor(page, '\n<pre><code>a\n      b\n</code></pre>\n');
    await select(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 9 });

    await page.keyboard.press('Shift+Tab');

    expect(await readBodyHtml(page)).toBe('\n<pre><code>a\n  b\n</code></pre>\n');
  });

  test('Tab and Shift+Tab over a range add and remove one level on each line it touches, keeping the selection', async ({ page }) => {
    await openEditor(page, '\n<pre><code>ab\ncd\nef\n</code></pre>\n');
    await select(
      page,
      { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 4 },
    );

    await page.keyboard.press('Tab');
    const indented = [await readBodyHtml(page), await readSelectedText(page)];
    await page.keyboard.press('Shift+Tab');

    expect([...indented, await readBodyHtml(page), await readSelectedText(page)]).toEqual([
      '\n<pre><code>    ab\n    cd\nef\n</code></pre>\n',
      'b\n    c',
      '\n<pre><code>ab\ncd\nef\n</code></pre>\n',
      'b\nc',
    ]);
  });

  test('puts the spaces inside the code of an empty code block', async ({ page }) => {
    await openEditor(page, '\n<pre><code></code></pre>\n');
    await page.evaluate((id) => {
      const root = document.getElementById(id);
      root?.focus();
      const pre = root?.querySelector('pre');
      if (pre !== null && pre !== undefined) {
        window.getSelection()?.collapse(pre, 0);
      }
    }, EDITOR_ROOT_ELEMENT_ID);

    await page.keyboard.press('Tab');

    expect(await readBodyHtml(page)).toBe('\n<pre><code>    </code></pre>\n');
  });

  test('indents the code of a code block inside a list item without nesting the item', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a</li><li>b<pre><code>x\n</code></pre></li></ul>\n');
    await select(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Tab');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>a</li><li>b<pre><code>    x\n</code></pre></li></ul>\n');
  });

  test('indents the code of a code block inside a table cell without moving to the next cell', async ({ page }) => {
    await openEditor(page, '\n<table>\n<tbody>\n<tr><td><pre><code>x\n</code></pre></td><td>y</td></tr>\n</tbody>\n</table>\n');
    await select(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Tab');

    expect([
      await page.locator(`${EDITOR_ROOT} code`).textContent(),
      await page.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.localName),
    ]).toEqual(['    x\n', 'code']);
  });

  test('undo returns the code to before the indent', async ({ page }) => {
    const body = '\n<pre><code>ab\n</code></pre>\n';
    await openEditor(page, body);
    await select(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 0 });
    await page.keyboard.press('Tab');
    const [transaction] = await flushTransactions(page, 'indent-undo');

    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument,
      requestId: 'indent-undo-apply',
      kind: DOCUMENT_APPLY_KIND.editHistory,
      text: transaction.before.text,
      targetText: transaction.after.text,
      targetSelection: transaction.before.selection,
      editRange: { start: 0, count: 0 },
    });

    await expect.poll(() => readBodyHtml(page)).toBe(body);
  });
});
