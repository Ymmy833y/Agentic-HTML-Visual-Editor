import type { Page } from '@playwright/test';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOST_URL = pathToFileURL(
  path.resolve(__dirname, '../fixtures/webview-host.html'),
).href;

// Mirror webview/core/editor-core.ts: change notifications (state backup)
// are debounced by 250ms.
export const DEBOUNCE_MS = 250;

declare global {
  interface Window {
    __vscodeMessages: { type: string; [key: string]: unknown }[];
    /** Last value passed to the mocked vscode.setState (see webview-host.html). */
    __lastState: unknown;
  }
}

/** Load the webview bundle and wait for its 'ready' message, without `init`. */
export async function openHost(page: Page): Promise<void> {
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
}

export async function mountEditor(page: Page, initialHtml: string): Promise<void> {
  await openHost(page);

  // Push initial HTML, mirroring the extension host's first message.
  await page.evaluate((html) => {
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'init', html } }),
    );
  }, initialHtml);

  await page.locator('#ahve-root').waitFor();
}

export async function getMessages(page: Page): Promise<{ type: string; [key: string]: unknown }[]> {
  return page.evaluate(() => window.__vscodeMessages.slice());
}

/** The view's answer to a host `getFileData` snapshot request. */
export interface FileDataMessage {
  type: 'fileData';
  requestId: number;
  html: string | null;
  baseHtml: string | null;
}

/** A snapshot from an initialized view (what the host's save flow merges). */
export interface SaveSnapshot {
  html: string;
  baseHtml: string;
}

let nextRequestId = 1;

/**
 * Emulate the host side of a save: dispatch a `getFileData` snapshot request
 * and return the `fileData` answer the view posts. The host would then merge
 * `html` against `baseHtml` into the document and reply with a `saveResult`.
 */
export async function requestFileData(page: Page): Promise<FileDataMessage> {
  const requestId = nextRequestId++;
  await page.evaluate((requestId) => {
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'getFileData', requestId } }),
    );
  }, requestId);
  await page.waitForFunction(
    (id) =>
      window.__vscodeMessages.some((m) => m.type === 'fileData' && m.requestId === id),
    requestId,
  );
  const messages = await getMessages(page);
  return messages.find(
    (m) => m.type === 'fileData' && m.requestId === requestId,
  ) as FileDataMessage;
}

/** Count of committed WYSIWYG transactions posted to the custom-editor host. */
export async function getEditCommittedCount(page: Page): Promise<number> {
  return page.evaluate(
    () => window.__vscodeMessages.filter((m) => m.type === 'editCommitted').length,
  );
}

export interface BackupMessage {
  type: 'backup';
  html: string;
  baseHtml: string;
}

/**
 * Backup messages carry the unsaved view content to the extension host, which
 * persists it (workspaceState) so a disposed/reopened view can restore it.
 */
export async function getBackupMessages(page: Page): Promise<BackupMessage[]> {
  return page.evaluate(
    () =>
      window.__vscodeMessages.filter(
        (m): m is { type: 'backup'; html: string; baseHtml: string } => m.type === 'backup',
      ),
  );
}

/**
 * Trigger the editor's save action through the integration-test message. In
 * VS Code, Ctrl/Cmd+S is owned by the `ahve.save` workbench keybinding and does
 * not enter the webview DOM; this message exercises the toolbar-equivalent
 * request path in the standalone browser host.
 */
export async function triggerSave(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'testRequestSave' } }),
    );
  });
}

/**
 * Run the user save flow end to end against an initialized view: trigger the
 * save action, wait for its `requestSave` message, then perform the host's
 * snapshot handshake. Returns what the host's save would merge.
 */
export async function saveAndGetFileData(page: Page): Promise<SaveSnapshot> {
  const before = await page.evaluate(
    () => window.__vscodeMessages.filter((m) => m.type === 'requestSave').length,
  );
  await triggerSave(page);
  await page.waitForFunction(
    (n) => window.__vscodeMessages.filter((m) => m.type === 'requestSave').length > n,
    before,
  );
  const data = await requestFileData(page);
  if (data.html === null || data.baseHtml === null) {
    throw new Error('The view answered the save snapshot request before it was initialized.');
  }
  return { html: data.html, baseHtml: data.baseHtml };
}

/**
 * Trigger a save and return the html of the snapshot it produces. Edits are
 * held in the webview until a save action, so this is how tests observe the
 * serialized document.
 */
export async function saveAndGetHtml(page: Page): Promise<string> {
  const snapshot = await saveAndGetFileData(page);
  return snapshot.html;
}

export async function getRootHtml(page: Page): Promise<string> {
  return page.locator('#ahve-root').innerHTML();
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
  await page.locator('#ahve-root').focus();
}
