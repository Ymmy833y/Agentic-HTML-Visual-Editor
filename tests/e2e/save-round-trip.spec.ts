import { expect, test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';

import {
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import { OUTPUT_DEBOUNCE_MS } from '../../webview/editing/change-tracker';
import { OVERLAY_ELEMENT_ID } from '../../webview/ui/overlay-presenter';
import { EDITOR_ROOT, focusEditor, openEditor, placeCaret, readBodyHtml } from './helpers/editing';
import { PROBE_BUNDLE_PATH, getOutboundMessages, openWebviewHost, sendToWebview } from './helpers/page';

const BODY = '\n<p>ab</p>\n';

// The document openEditor assembles. These spellings are what confirm the prologue and epilogue survive verbatim.
const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

// A body whose disk spelling differs from the serializer's: `<img src="a.png"/>` closes with `>` when rebuilt from the tree.
const DISK_SPELLING_BODY = '\n<img src="a.png"/>\n<p>ab</p>\n';

const OVERLAY = `#${OVERLAY_ELEMENT_ID}`;

/** A wait comfortably longer than the debounce, used when waiting for the overlay to come down. */
const AFTER_DEBOUNCE_MS = OUTPUT_DEBOUNCE_MS + 150;

/**
 * Delivers a request body output message to the view.
 *
 * @param page The target page.
 * @param requestId The request ID the view should put on its response.
 */
async function requestBodyOutput(page: Page, requestId: string): Promise<void> {
  await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput, requestId });
}

/**
 * Reads the whole text of each body output response the view returned, in send order rather than request ID order.
 *
 * @param page The target page.
 * @returns The whole text each response carried, or `null` when the output could not be produced.
 */
async function readOutputResponses(page: Page): Promise<(string | null)[]> {
  const messages = await getOutboundMessages(page);
  return messages.flatMap((message) =>
    typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === VIEW_TO_HOST_MESSAGE_TYPE.bodyOutputResponse
      && 'text' in message
      ? [typeof message.text === 'string' ? message.text : null]
      : [],
  );
}

/**
 * Reads the unsaved content the view sent, as pairs of the whole text and the resend marker.
 *
 * @param page The target page.
 * @returns The whole text and the marker, in send order.
 */
async function readUnsavedContents(page: Page): Promise<{ text: string; resent: boolean }[]> {
  const messages = await getOutboundMessages(page);
  return messages.flatMap((message) =>
    typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent
      && 'text' in message
      ? [{ text: String(message.text), resent: 'resent' in message && message.resent === true }]
      : [],
  );
}

/**
 * Focuses the editor root and places the caret immediately after the 'ab' in the paragraph.
 *
 * @param page The target page.
 */
async function placeCaretAfterAb(page: Page): Promise<void> {
  await focusEditor(page);
  await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
}

/**
 * Opens the channel that drives the browser's IME.
 *
 * @param page The target page.
 */
async function openImeSession(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

test.describe('requesting output during a save round trip', () => {
  test('returns one body output response with the whole text, prologue and epilogue included, when a request is injected', async ({ page }) => {
    await openEditor(page, BODY);

    await requestBodyOutput(page, '1');

    expect(await readOutputResponses(page)).toEqual([`${PROLOGUE}${BODY}${EPILOGUE}`]);
  });

  test('includes a character typed just before the request in that body output response', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);

    await page.keyboard.type('X');
    await requestBodyOutput(page, '1');

    expect(await readOutputResponses(page)).toEqual([`${PROLOGUE}\n<p>abX</p>\n${EPILOGUE}`]);
  });

  test('includes the committed character in the body output response when a request arrives mid IME composition', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);
    const ime = await openImeSession(page);

    await ime.send('Input.imeSetComposition', { text: 'a', selectionStart: 1, selectionEnd: 1 });
    await requestBodyOutput(page, '1');

    expect(await readOutputResponses(page)).toEqual([`${PROLOGUE}\n<p>aba</p>\n${EPILOGUE}`]);
  });

  test('keeps a character typed after the request arrived out of both the body and the next output', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);

    await requestBodyOutput(page, '1');
    await page.keyboard.type('Z');
    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.saveReleased,
      resendUnsavedContent: false,
    });
    await requestBodyOutput(page, '2');

    expect([await readBodyHtml(page), await readOutputResponses(page)]).toEqual([
      BODY,
      [`${PROLOGUE}${BODY}${EPILOGUE}`, `${PROLOGUE}${BODY}${EPILOGUE}`],
    ]);
  });

  test('sends no debounced unsaved content for a character typed just before the request', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);

    await page.keyboard.type('X');
    await requestBodyOutput(page, '1');
    await page.waitForTimeout(AFTER_DEBOUNCE_MS);

    expect(await readUnsavedContents(page)).toEqual([]);
  });

  test('returns a response saying the output could not be produced when a request arrives before the mount', async ({ page }) => {
    await openWebviewHost(page, PROBE_BUNDLE_PATH);

    await requestBodyOutput(page, '1');

    expect(await readOutputResponses(page)).toEqual([null]);
  });
});

test.describe('save committed', () => {
  test('removes the overlay, returns the caret to its original position, and lets typing enter the body when a save committed message is injected', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);

    await requestBodyOutput(page, '1');
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.saveCommitted });
    await page.keyboard.type('X');

    await expect(page.locator(OVERLAY)).toHaveCount(0);
    expect(await readBodyHtml(page)).toBe('\n<p>abX</p>\n');
  });

  test('does not replace the baseline when only a commit arrives without an application request', async ({ page }) => {
    // Use body text whose disk spelling differs from its serialized spelling. If the baseline were replaced, the next
    // output would change even the unedited line to the serialized spelling.
    await openEditor(page, DISK_SPELLING_BODY);

    await requestBodyOutput(page, '1');
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.saveCommitted });
    await placeCaretAfterAb(page);
    await page.keyboard.type('X');
    await requestBodyOutput(page, '2');

    const responses = await readOutputResponses(page);
    expect(responses[1]).toBe(
      `${PROLOGUE}\n<img src="a.png"/>\n<p>abX</p>\n${EPILOGUE}`,
    );
  });
});

test.describe('save released', () => {
  test('delivers one marked unsaved content message after the overlay comes down when a save released message carrying a resend instruction is injected', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);

    await page.keyboard.type('X');
    await requestBodyOutput(page, '1');
    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.saveReleased,
      resendUnsavedContent: true,
    });

    await expect(page.locator(OVERLAY)).toHaveCount(0);
    expect(await readUnsavedContents(page)).toEqual([
      { text: `${PROLOGUE}\n<p>abX</p>\n${EPILOGUE}`, resent: true },
    ]);
  });

  test('sends no unsaved content and only lowers the overlay for a save released message with no instruction', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);

    await page.keyboard.type('X');
    await requestBodyOutput(page, '1');
    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.saveReleased,
      resendUnsavedContent: false,
    });
    await page.waitForTimeout(AFTER_DEBOUNCE_MS);

    await expect(page.locator(OVERLAY)).toHaveCount(0);
    expect(await readUnsavedContents(page)).toEqual([]);
  });
});

test.describe('the editor root ID', () => {
  test('places the overlay outside the editor root and leaves the body tree unchanged', async ({ page }) => {
    await openEditor(page, BODY);

    await requestBodyOutput(page, '1');

    await expect(page.locator(`#${EDITOR_ROOT_ELEMENT_ID} ${OVERLAY}`)).toHaveCount(0);
    await expect(page.locator(OVERLAY)).toHaveCount(1);
  });
});
