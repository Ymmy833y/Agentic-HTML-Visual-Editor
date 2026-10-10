import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  BACKUP_TEST_OPERATION,
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  TEST_MESSAGE_TYPE,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import { OVERLAY_ELEMENT_ID } from '../../webview/ui/overlay-presenter';
import { EDITOR_ROOT, focusEditor, openEditor, placeCaret, readBodyHtml } from './helpers/editing';
import {
  PROBE_BUNDLE_PATH,
  getOutboundMessages,
  openWebviewHost,
  sendToWebview,
  setSendFailureTypes,
} from './helpers/page';

const BODY = '\n<p>ab</p>\n';
const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

declare global {
  interface Window {
    __editableWhenInitialized?: string | null;
  }
}

/**
 * Sends an initialize message with an identifier.
 *
 * @param page The target page.
 * @param text The full document text to initialize.
 */
async function initializeForRecovery(page: Page, text: string): Promise<void> {
  await sendToWebview(page, {
    type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
    text,
    documentUri: '',
    resourceRootUri: '',
    initializationId: 'recovery-1',
  });
}

/** Reads the initialization results returned by the view, in send order. */
async function readInitializationResults(page: Page): Promise<unknown[]> {
  const messages = await getOutboundMessages(page);
  return messages.filter((message) => typeof message === 'object'
    && message !== null
    && Reflect.get(message, 'type') === VIEW_TO_HOST_MESSAGE_TYPE.documentInitialized);
}

/** Reads the test control results returned by the view, in send order. */
async function readTestControlResults(page: Page): Promise<unknown[]> {
  const messages = await getOutboundMessages(page);
  return messages.filter((message) => typeof message === 'object'
    && message !== null
    && Reflect.get(message, 'type') === TEST_MESSAGE_TYPE.backupTestControlResult);
}

test.describe('recovery initialization result', () => {
  test('responds with success for a recovery initialization id only after an editable mount finishes', async ({ page }) => {
    await openWebviewHost(page);
    // Record whether the root is editable at the moment the response is sent. Becoming editable only after the
    // response would not confirm that display completed.
    await page.evaluate((rootId) => {
      const record = window.__stubHost?.record;
      if (record === undefined) {
        throw new Error('the stub host is not installed');
      }
      const push = record.push.bind(record);
      record.push = (...items: unknown[]) => {
        if (items.some((item) => typeof item === 'object' && item !== null && Reflect.get(item, 'type') === 'documentInitialized')) {
          window.__editableWhenInitialized = document.getElementById(rootId)?.getAttribute('contenteditable');
        }
        return push(...items);
      };
    }, EDITOR_ROOT_ELEMENT_ID);

    await initializeForRecovery(page, `${PROLOGUE}${BODY}${EPILOGUE}`);

    await expect.poll(() => readInitializationResults(page)).toEqual([
      { type: VIEW_TO_HOST_MESSAGE_TYPE.documentInitialized, initializationId: 'recovery-1', success: true },
    ]);
    expect(await page.evaluate(() => window.__editableWhenInitialized)).toBe('true');
  });

  test('responds with a display failure when the recovery initialization text has no body boundary', async ({ page }) => {
    await openWebviewHost(page);

    await initializeForRecovery(page, '<!DOCTYPE html>\n<html><p>no body</p></html>');

    await expect.poll(() => readInitializationResults(page)).toEqual([
      { type: VIEW_TO_HOST_MESSAGE_TYPE.documentInitialized, initializationId: 'recovery-1', success: false },
    ]);
  });

  test('responds with a display failure when the recovery initialization text contains a forbidden tag', async ({ page }) => {
    await openWebviewHost(page);

    await initializeForRecovery(page, `${PROLOGUE}\n<iframe src="about:blank"></iframe>\n${EPILOGUE}`);

    await expect.poll(() => readInitializationResults(page)).toEqual([
      { type: VIEW_TO_HOST_MESSAGE_TYPE.documentInitialized, initializationId: 'recovery-1', success: false },
    ]);
  });

  test('responds with a display failure when the editor root for the recovery initialization is missing', async ({ page }) => {
    await openWebviewHost(page);
    await page.evaluate((rootId) => document.getElementById(rootId)?.remove(), EDITOR_ROOT_ELEMENT_ID);

    await initializeForRecovery(page, `${PROLOGUE}${BODY}${EPILOGUE}`);

    await expect.poll(() => readInitializationResults(page)).toEqual([
      { type: VIEW_TO_HOST_MESSAGE_TYPE.documentInitialized, initializationId: 'recovery-1', success: false },
    ]);
  });
});

test.describe('save commit after unresponsiveness', () => {
  test('receives a save commit after the output response to real input was lost, lowers the overlay, and keeps the body, baseline, and selection', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    await page.keyboard.type('X');

    await setSendFailureTypes(page, [VIEW_TO_HOST_MESSAGE_TYPE.bodyOutputResponse]);
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput, requestId: 'lost' });
    await expect(page.locator(`#${OVERLAY_ELEMENT_ID}`)).toHaveCount(1);
    await setSendFailureTypes(page, []);
    // The host writes the retained copy and sends only the commit. The view handed over no output, so it does not
    // replace its baseline.
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.saveCommitted });
    await page.keyboard.type('Y');

    await expect(page.locator(`#${OVERLAY_ELEMENT_ID}`)).toHaveCount(0);
    expect(await readBodyHtml(page)).toBe('\n<p>abXY</p>\n');
    // If the baseline was kept, the next output is also built from the original disk body's spelling.
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput, requestId: 'next' });
    await expect.poll(async () => (await getOutboundMessages(page)).filter(
      (message) => typeof message === 'object' && message !== null && Reflect.get(message, 'requestId') === 'next',
    )).toEqual([
      { type: VIEW_TO_HOST_MESSAGE_TYPE.bodyOutputResponse, requestId: 'next', text: `${PROLOGUE}\n<p>abXY</p>\n${EPILOGUE}` },
    ]);
  });
});

test.describe('test-only controls', () => {
  test('rejects the output suspension and edit preparation controls in a normal view without the test mode meta', async ({ page }) => {
    await openWebviewHost(page, PROBE_BUNDLE_PATH);
    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
      text: `${PROLOGUE}${BODY}${EPILOGUE}`,
      documentUri: '',
      resourceRootUri: '',
    });

    for (const operation of [BACKUP_TEST_OPERATION.suspendOutputResponses, BACKUP_TEST_OPERATION.prepareUnsentEdit]) {
      await sendToWebview(page, {
        type: TEST_MESSAGE_TYPE.backupTestControl,
        controlId: operation,
        operation,
        text: 'Z',
      });
    }
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput, requestId: 'after-control' });

    await expect.poll(() => readTestControlResults(page)).toEqual([
      { type: TEST_MESSAGE_TYPE.backupTestControlResult, controlId: 'suspendOutputResponses', success: false },
      { type: TEST_MESSAGE_TYPE.backupTestControlResult, controlId: 'prepareUnsentEdit', success: false },
    ]);
    expect(await readBodyHtml(page)).toBe(BODY);
    // Output suspension was rejected, so the output request gets a response.
    await expect.poll(async () => (await getOutboundMessages(page)).some(
      (message) => typeof message === 'object' && message !== null && Reflect.get(message, 'requestId') === 'after-control',
    )).toBe(true);
  });
});
