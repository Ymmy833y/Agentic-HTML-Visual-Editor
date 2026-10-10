import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { EDITOR_ROOT_ELEMENT_ID, VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import { OVERLAY_ELEMENT_ID } from '../../webview/ui/overlay-presenter';
import {
  EDITOR_ROOT,
  focusEditor,
  openEditor,
  placeCaret,
  readBodyHtml,
} from './helpers/editing';
import { getOutboundMessages, setSendFailure, setSendFailureTypes } from './helpers/page';

const BODY = '\n<p>ab</p>\n';

// The document assembled by openEditor. These spellings verify that the prologue and epilogue are
// preserved verbatim.
const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const OVERLAY = `#${OVERLAY_ELEMENT_ID}`;

/** Reads the types of messages sent to the host, in send order. */
async function readSentTypes(page: Page): Promise<string[]> {
  const messages = await getOutboundMessages(page);
  return messages.map((message) =>
    typeof message === 'object' && message !== null && 'type' in message
      ? String(message.type)
      : '',
  );
}

/** Reads the complete document text from unsaved content messages, in send order. */
async function readSentContents(page: Page): Promise<string[]> {
  const messages = await getOutboundMessages(page);
  return messages.flatMap((message) =>
    typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent
      && 'text' in message
      ? [String(message.text)]
      : [],
  );
}

/**
 * Waits until a message of the specified type arrives.
 *
 * @param page The target page.
 * @param type The message type to wait for.
 */
async function waitForSent(page: Page, type: string): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      (window.__stubHost?.record ?? []).some(
        (message) =>
          typeof message === 'object'
          && message !== null
          && 'type' in message
          && message.type === expected,
      ),
    type,
  );
}

/** Reads the ID of the element that has focus. */
async function readActiveElementId(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.id ?? '');
}

/**
 * Places the caret immediately after 'ab' in the paragraph.
 *
 * @param page The target page.
 */
async function placeCaretAfterAb(page: Page): Promise<void> {
  await focusEditor(page);
  await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
}

test.describe('sending unsaved content to the host', () => {
  test('records three view edited messages after typing three consecutive characters', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);

    await page.keyboard.type('XYZ');

    const edited = (await readSentTypes(page)).filter(
      (type) => type === VIEW_TO_HOST_MESSAGE_TYPE.viewEdited,
    );
    expect(edited).toHaveLength(3);
  });

  test('records a view edited message but no unsaved content immediately after input', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);

    await page.keyboard.type('XYZ');

    expect(await readSentContents(page)).toEqual([]);
  });

  test('sends one unsaved content message with complete document text after three characters', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);

    await page.keyboard.type('XYZ');

    await waitForSent(page, VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent);
    expect(await readSentContents(page)).toEqual([
      `${PROLOGUE}\n<p>abXYZ</p>\n${EPILOGUE}`,
    ]);
  });

  test('sends view edited and unsaved content messages after document replacement', async ({ page }) => {
    await openEditor(page, BODY);
    await page.evaluate(
      (text) => window.__documentReplacementProbe?.(text),
      `${PROLOGUE}\n<p>cd</p>\n${EPILOGUE}`,
    );
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await page.keyboard.type('X');

    await waitForSent(page, VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent);
    expect(await readSentContents(page)).toEqual([`${PROLOGUE}\n<p>cdX</p>\n${EPILOGUE}`]);
  });

  test('sends unsaved content without waiting when the unload trigger follows input', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);
    await page.keyboard.type('X');

    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));

    expect(await readSentContents(page)).toEqual([`${PROLOGUE}\n<p>abX</p>\n${EPILOGUE}`]);
  });

  test('sends edit history before unsaved content during unload', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);
    await page.keyboard.type('X');

    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));

    const types = await readSentTypes(page);
    expect(types.indexOf(VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).toBeLessThan(
      types.indexOf(VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent),
    );
  });

  test('sends unsaved content even when edit history delivery fails during unload', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);
    await setSendFailureTypes(page, [VIEW_TO_HOST_MESSAGE_TYPE.editTransaction]);
    await page.keyboard.type('X');

    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));

    const types = await readSentTypes(page);
    expect(types).not.toContain(VIEW_TO_HOST_MESSAGE_TYPE.editTransaction);
    expect(types).toContain(VIEW_TO_HOST_MESSAGE_TYPE.viewDiagnostic);
    expect(await readSentContents(page)).toEqual([`${PROLOGUE}\n<p>abX</p>\n${EPILOGUE}`]);
  });

  test('sends edit history even when unsaved content delivery fails during unload', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);
    await setSendFailureTypes(page, [VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent]);
    await page.keyboard.type('X');

    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));

    expect(await readSentContents(page)).toEqual([]);
    expect(await readSentTypes(page)).toContain(VIEW_TO_HOST_MESSAGE_TYPE.editTransaction);
  });

  test('sends nothing when the unload trigger fires without input', async ({ page }) => {
    await openEditor(page, BODY);

    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));

    expect(await readSentTypes(page)).toEqual([VIEW_TO_HOST_MESSAGE_TYPE.viewReady]);
  });
});

test.describe('send failure overlay', () => {
  test('shows the overlay and blocks further input when sending fails', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);
    await setSendFailure(page, true);

    await page.keyboard.type('X');
    await page.locator(OVERLAY).waitFor();
    await page.keyboard.type('Y');

    expect(await readBodyHtml(page)).toBe('\n<p>abX</p>\n');
  });

  test('delivers unsent content, removes the overlay, and resumes input after a successful retry', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);
    await setSendFailure(page, true);
    await page.keyboard.type('X');
    await page.locator(OVERLAY).waitFor();
    // Also fail the pending body output to create unsent content without relying on the debounce
    // duration.
    await page.evaluate(() => window.__editingSessionProbe?.()?.flush());

    await setSendFailure(page, false);
    await page.locator(`${OVERLAY} button`).click();
    // Place only the caret to determine the keystroke destination. The next case verifies that focus
    // is restored.
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 3 });
    await page.keyboard.type('Y');

    expect([await readSentContents(page), await page.locator(OVERLAY).count()]).toEqual([
      [`${PROLOGUE}\n<p>abX</p>\n${EPILOGUE}`],
      0,
    ]);
    expect(await readBodyHtml(page)).toBe('\n<p>abXY</p>\n');
  });

  test('returns focus to the editor root and accepts input without replacing the caret', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);
    await setSendFailure(page, true);
    await page.keyboard.type('X');
    await page.locator(OVERLAY).waitFor();

    await setSendFailure(page, false);
    await page.locator(`${OVERLAY} button`).click();
    await page.keyboard.type('Y');

    expect([await readActiveElementId(page), await readBodyHtml(page)]).toEqual([
      EDITOR_ROOT_ELEMENT_ID,
      '\n<p>abXY</p>\n',
    ]);
  });
});

