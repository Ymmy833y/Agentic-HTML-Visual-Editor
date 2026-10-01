import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { HOST_TO_VIEW_MESSAGE_TYPE, VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import { OVERLAY_ELEMENT_ID } from '../../webview/ui/overlay-presenter';
import { EDITOR_ROOT, focusEditor, placeCaret, readBodyHtml } from './helpers/editing';
import { getOutboundMessages, openWebviewHost, sendToWebview } from './helpers/page';

// The overlay is a single element, with the section for each reason laid out inside it.
const OVERLAY = `#${OVERLAY_ELEMENT_ID}`;

const BODY = '\n<p>ab</p>\n';
const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const RESTORE_INITIALIZATION_ID = 'restore-1';

// No resource is embedded, so messages are displayed as their keys.
const CAUSE_TEXT = 'restoreFailure.backupUnreadable';
const RETRY_TEXT = 'restore.retry';
const DISCARD_TEXT = 'restore.discard';

/**
 * Sends a restoring display initialize message.
 *
 * @param page The target page.
 * @param text The full text to mount.
 */
async function initializeForRestore(page: Page, text: string): Promise<void> {
  await sendToWebview(page, {
    type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
    text,
    documentUri: '',
    resourceRootUri: '',
    initializationId: RESTORE_INITIALIZATION_ID,
    restoring: true,
  });
}

/** Reads the initialization results returned by the view, in send order. */
async function readInitializationResults(page: Page): Promise<unknown[]> {
  const messages = await getOutboundMessages(page);
  return messages.filter((message) => typeof message === 'object'
    && message !== null
    && Reflect.get(message, 'type') === VIEW_TO_HOST_MESSAGE_TYPE.documentInitialized);
}

/** Reads the restore choices returned by the view, in send order. */
async function readSelections(page: Page): Promise<unknown[]> {
  const messages = await getOutboundMessages(page);
  return messages.filter((message) => typeof message === 'object'
    && message !== null
    && Reflect.get(message, 'type') === VIEW_TO_HOST_MESSAGE_TYPE.restoreActionSelected);
}

/**
 * Delivers a restore failure to the view.
 *
 * @param page The target page.
 */
async function sendRestoreFailure(page: Page): Promise<void> {
  await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.restoreFailed, cause: 'backupUnreadable' });
}

test.describe('input stop during the restoring display', () => {
  test('displays the body on a restoring display initialization and responds with display success while staying non-editable', async ({ page }) => {
    await openWebviewHost(page);

    await initializeForRestore(page, `${PROLOGUE}${BODY}${EPILOGUE}`);

    await expect.poll(() => readInitializationResults(page)).toEqual([
      {
        type: VIEW_TO_HOST_MESSAGE_TYPE.documentInitialized,
        initializationId: RESTORE_INITIALIZATION_ID,
        success: true,
      },
    ]);
    expect(await readBodyHtml(page)).toBe(BODY);
    await expect(page.locator(EDITOR_ROOT)).toHaveAttribute('contenteditable', 'false');
    await expect(page.locator(OVERLAY)).toHaveCount(1);
  });

  test('lets real key input into the body after the restore completes', async ({ page }) => {
    await openWebviewHost(page);
    await initializeForRestore(page, `${PROLOGUE}${BODY}${EPILOGUE}`);
    await expect.poll(() => readInitializationResults(page)).toHaveLength(1);

    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.restoreCompleted });
    await expect(page.locator(OVERLAY)).toHaveCount(0);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe('\n<p>abX</p>\n');
  });
});

test.describe('restore failure dialog', () => {
  test('shows the cause and the retry and discard buttons on a restore failure in an empty view', async ({ page }) => {
    await openWebviewHost(page);

    await sendRestoreFailure(page);

    const dialog = page.locator(OVERLAY);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(CAUSE_TEXT);
    await expect(page.locator(`${OVERLAY} button`)).toHaveCount(2);
  });

  test('sends the retry choice when the retry button is clicked', async ({ page }) => {
    await openWebviewHost(page);
    await sendRestoreFailure(page);

    await page.locator(`${OVERLAY} button`, { hasText: RETRY_TEXT }).click();

    await expect.poll(() => readSelections(page)).toEqual([
      { type: VIEW_TO_HOST_MESSAGE_TYPE.restoreActionSelected, action: 'retry' },
    ]);
  });

  test('sends the discard choice when the discard button is clicked', async ({ page }) => {
    await openWebviewHost(page);
    await sendRestoreFailure(page);

    await page.locator(`${OVERLAY} button`, { hasText: DISCARD_TEXT }).click();

    await expect.poll(() => readSelections(page)).toEqual([
      { type: VIEW_TO_HOST_MESSAGE_TYPE.restoreActionSelected, action: 'discard' },
    ]);
  });

  test('keeps the buttons clickable in a failure dialog shown over a body with input stopped', async ({ page }) => {
    await openWebviewHost(page);
    await initializeForRestore(page, `${PROLOGUE}${BODY}${EPILOGUE}`);
    await expect.poll(() => readInitializationResults(page)).toHaveLength(1);

    await sendRestoreFailure(page);
    await page.locator(`${OVERLAY} button`, { hasText: RETRY_TEXT }).click();

    await expect.poll(() => readSelections(page)).toEqual([
      { type: VIEW_TO_HOST_MESSAGE_TYPE.restoreActionSelected, action: 'retry' },
    ]);
    await expect(page.locator(EDITOR_ROOT)).toHaveAttribute('contenteditable', 'false');
  });

  test('adds the buttons while keeping the unopenable reason when a failure reaches a restoring display that a forbidden tag made unopenable', async ({ page }) => {
    await openWebviewHost(page);
    await initializeForRestore(page, `${PROLOGUE}\n<iframe src="about:blank"></iframe>\n${EPILOGUE}`);
    await expect.poll(() => readInitializationResults(page)).toEqual([
      {
        type: VIEW_TO_HOST_MESSAGE_TYPE.documentInitialized,
        initializationId: RESTORE_INITIALIZATION_ID,
        success: false,
      },
    ]);

    await sendRestoreFailure(page);

    const dialog = page.locator(OVERLAY);
    await expect(dialog).toContainText('unopenableDocument.forbiddenTag');
    await expect(dialog).toContainText(CAUSE_TEXT);
    // The switch button stays, with the two restore failure actions laid out after it.
    await expect(page.locator(`${OVERLAY} button`)).toHaveText([
      'unopenableDocument.openInTextEditor',
      RETRY_TEXT,
      DISCARD_TEXT,
    ]);
  });
});
