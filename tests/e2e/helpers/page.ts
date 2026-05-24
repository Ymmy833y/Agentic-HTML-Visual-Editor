import type { Page } from '@playwright/test';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOST_URL = pathToFileURL(
  path.resolve(__dirname, '../fixtures/webview-host.html'),
).href;

// Mirror webview/main.ts: edit messages are debounced by 250ms.
export const DEBOUNCE_MS = 250;

declare global {
  interface Window {
    __vscodeMessages: { type: string; [key: string]: unknown }[];
  }
}

export async function mountEditor(page: Page, initialHtml: string): Promise<void> {
  await page.goto(HOST_URL);

  // Wait for the bundle to finish booting and emit its 'ready' message.
  await page.waitForFunction(() =>
    Array.isArray(window.__vscodeMessages) &&
    window.__vscodeMessages.some((m) => m.type === 'ready'),
  );

  // Drop the 'ready' message so subsequent assertions see only edits.
  await page.evaluate(() => {
    window.__vscodeMessages = [];
  });

  // Push initial HTML, mirroring the extension host's first message.
  await page.evaluate((html) => {
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'init', html } }),
    );
  }, initialHtml);

  await page.locator('#hw-root').waitFor();
}

export async function getMessages(page: Page): Promise<{ type: string; [key: string]: unknown }[]> {
  return page.evaluate(() => window.__vscodeMessages.slice());
}

export async function getEditMessages(
  page: Page,
): Promise<{ type: 'edit'; html: string }[]> {
  return page.evaluate(
    () =>
      window.__vscodeMessages.filter(
        (m): m is { type: 'edit'; html: string } => m.type === 'edit',
      ),
  );
}

export async function getRootHtml(page: Page): Promise<string> {
  return page.locator('#hw-root').innerHTML();
}

/**
 * Select text inside a single text node of the editor by character offsets.
 * Pass a CSS selector that identifies the element whose first text node holds
 * the target string.
 */
export async function selectTextInside(
  page: Page,
  selector: string,
  start: number,
  end: number,
): Promise<void> {
  await page.evaluate(
    ({ selector, start, end }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`element not found: ${selector}`);
      const textNode = el.firstChild;
      if (!textNode) throw new Error(`element has no text node: ${selector}`);
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, end);
      const sel = window.getSelection();
      if (!sel) throw new Error('no selection');
      sel.removeAllRanges();
      sel.addRange(range);
    },
    { selector, start, end },
  );
}

/** Place a collapsed caret at the end of the contents of the given selector. */
export async function caretAtEnd(page: Page, selector: string): Promise<void> {
  await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`element not found: ${selector}`);
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    if (!sel) throw new Error('no selection');
    sel.removeAllRanges();
    sel.addRange(range);
  }, selector);
}

/** Focus the editor root (needed before dispatching keyboard input). */
export async function focusEditor(page: Page): Promise<void> {
  await page.locator('#hw-root').focus();
}
