import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { EDITOR_ROOT_ELEMENT_ID, MESSAGE_CATALOG_ELEMENT_ID } from '../../common/index';
import { OVERLAY_ELEMENT_ID } from '../../webview/ui/overlay-presenter';
import { getOutboundMessages, openWebviewHost, sendToWebview, setSendFailure } from './helpers/page';

const VIEW_READY = { type: 'viewReady' };
const TEXT_EDITOR_SWITCH_REQUESTED = { type: 'textEditorSwitchRequested' };

const OPENABLE_DOCUMENT = '<html><body><p>a</p></body></html>';
const UNCLOSED_DOCUMENT = '<html><body><p>a</p></html>';
const FORBIDDEN_TAG_DOCUMENT = '<html><body><p>a</p><script>b</script></body></html>';

// Use empty strings for the base URIs. These tests cover openability and do not need resolution.
// rendering.spec.ts verifies resolution with a real file.
function initialize(text: string): Record<string, unknown> {
  return { type: 'initialize', text, documentUri: '', resourceRootUri: '' };
}

// The fixture does not embed a message catalog, so every message is displayed as its key.
const HEADING_TEXT = 'unopenableDocument.heading';
const CONDITION_TEXT = 'unopenableDocument.condition';

// Substitution of the tag name cannot be verified while the message is displayed as its key, so
// provide a catalog only for this case.
const FORBIDDEN_TAG_TEXT = 'found {tagName} in the body';

// The fixture does not embed a message catalog, so the text editor switch button's label is also shown as its message
// key.
function switchButton(page: Page): Locator {
  return page
    .locator(`#${OVERLAY_ELEMENT_ID}`)
    .getByRole('button', { name: 'unopenableDocument.openInTextEditor' });
}

async function embedForbiddenTagMessage(page: Page): Promise<void> {
  await page.evaluate(
    (argument: { elementId: string; catalog: string }) => {
      const element = document.createElement('script');
      element.type = 'application/json';
      element.id = argument.elementId;
      element.textContent = argument.catalog;
      document.head.append(element);
    },
    {
      elementId: MESSAGE_CATALOG_ELEMENT_ID,
      catalog: JSON.stringify({ 'unopenableDocument.forbiddenTag': FORBIDDEN_TAG_TEXT }),
    },
  );
}

test.describe('view startup and document boundary', () => {
  test('sends one view ready message to the host when the bundle loads', async ({ page }) => {
    await openWebviewHost(page);

    expect(await getOutboundMessages(page)).toEqual([VIEW_READY]);
  });

  test('sends only the view ready message to the host until an initialize message arrives', async ({ page }) => {
    await openWebviewHost(page);

    expect(await getOutboundMessages(page)).toHaveLength(1);
  });

  test('does not make the editor root editable until an initialize message arrives', async ({ page }) => {
    await openWebviewHost(page);

    await expect(page.locator(`#${EDITOR_ROOT_ELEMENT_ID}`)).not.toHaveAttribute('contenteditable', 'true');
  });

  test('makes the editor root editable after receiving an initialize message with a valid boundary', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, initialize(OPENABLE_DOCUMENT));

    await expect(page.locator(`#${EDITOR_ROOT_ELEMENT_ID}`)).toHaveAttribute('contenteditable', 'true');
  });

  test('sends another view ready message from the recreated view after a reload', async ({ page }) => {
    await openWebviewHost(page);

    // Reloading also recreates the stub host, so its record starts empty.
    await openWebviewHost(page);

    expect(await getOutboundMessages(page)).toEqual([VIEW_READY]);
  });

  test('shows a dialog without an editing area after receiving an initialize message for an empty document', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, initialize(''));

    await expect(page.locator(`#${OVERLAY_ELEMENT_ID}`)).toBeVisible();
    await expect(page.locator(`#${EDITOR_ROOT_ELEMENT_ID}`)).not.toHaveAttribute('contenteditable', 'true');
  });

  test('shows a dialog without an editing area for a document without a closing tag', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, initialize(UNCLOSED_DOCUMENT));

    await expect(page.locator(`#${OVERLAY_ELEMENT_ID}`)).toBeVisible();
    await expect(page.locator(`#${EDITOR_ROOT_ELEMENT_ID}`)).not.toHaveAttribute('contenteditable', 'true');
  });

  test('overlays the dialog on the screen', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, initialize(''));

    // Verify that the dialog covers the center of the view. Without the overlay styles, the dialog
    // becomes only a strip above the document body and does not reach the center.
    const covers = await page
      .locator(`#${OVERLAY_ELEMENT_ID}`)
      .evaluate((element) =>
        element.contains(document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)),
      );

    expect(covers).toBe(true);
  });

  test('shows both the editing restriction and opening condition in the dialog', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, initialize(''));

    const dialog = page.locator(`#${OVERLAY_ELEMENT_ID}`);
    await expect(dialog).toContainText(HEADING_TEXT);
    await expect(dialog).toContainText(CONDITION_TEXT);
  });

  test('still sends only the view ready message to the host after showing the dialog', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, initialize(''));

    expect(await getOutboundMessages(page)).toEqual([VIEW_READY]);
  });

  test('keeps the editing area without showing a dialog when an invalid initialize message follows a valid one', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize(OPENABLE_DOCUMENT));

    await sendToWebview(page, initialize(''));

    await expect(page.locator(`#${OVERLAY_ELEMENT_ID}`)).toHaveCount(0);
    await expect(page.locator(`#${EDITOR_ROOT_ELEMENT_ID}`)).toHaveAttribute('contenteditable', 'true');
  });

  test('sends one diagnostic message to the host for a message type outside the contract', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, { type: 'not-in-the-contract' });

    expect(await getOutboundMessages(page)).toEqual([
      VIEW_READY,
      { type: 'viewDiagnostic', detail: expect.stringContaining('not-in-the-contract') },
    ]);
  });

  test('makes the editor root editable with a subsequent initialize message after discarding an unsupported message', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, { type: 'not-in-the-contract' });

    await sendToWebview(page, initialize(OPENABLE_DOCUMENT));

    await expect(page.locator(`#${EDITOR_ROOT_ELEMENT_ID}`)).toHaveAttribute('contenteditable', 'true');
  });

  test('does not raise a page error for a message type outside the contract', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await openWebviewHost(page);

    await sendToWebview(page, { type: 'not-in-the-contract' });

    // Make one round trip to the page and wait for any thrown exception to arrive.
    await getOutboundMessages(page);
    expect(pageErrors).toEqual([]);
  });

  test('shows a dialog without an editing area for a document containing a forbidden tag', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, initialize(FORBIDDEN_TAG_DOCUMENT));

    await expect(page.locator(`#${OVERLAY_ELEMENT_ID}`)).toBeVisible();
    await expect(page.locator(`#${EDITOR_ROOT_ELEMENT_ID}`)).not.toHaveAttribute('contenteditable', 'true');
  });

  test('shows the detected forbidden tag name in the dialog', async ({ page }) => {
    await openWebviewHost(page);
    await embedForbiddenTagMessage(page);

    await sendToWebview(page, initialize(FORBIDDEN_TAG_DOCUMENT));

    await expect(page.locator(`#${OVERLAY_ELEMENT_ID}`)).toContainText(
      'found script in the body',
    );
  });

  test('shows the encoding explanation without an editing area for text decoded with a mismatched encoding, even when its boundary is valid', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, { ...initialize(OPENABLE_DOCUMENT), encodingMismatch: true });

    await expect(page.locator(`#${OVERLAY_ELEMENT_ID}`)).toContainText('unopenableDocument.encodingMismatch');
    await expect(page.locator(`#${EDITOR_ROOT_ELEMENT_ID}`)).not.toHaveAttribute('contenteditable', 'true');
  });

  test('still sends only the view ready message after showing a dialog for a forbidden tag', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, initialize(FORBIDDEN_TAG_DOCUMENT));

    await expect(page.locator(`#${OVERLAY_ELEMENT_ID}`)).toBeVisible();
    expect(await getOutboundMessages(page)).toEqual([VIEW_READY]);
  });
});

test.describe('editor switch requests from the unopenable document dialog', () => {
  test('sends one editor switch request to the host when the switch button is pressed after initializing an empty document', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize(''));

    await switchButton(page).click();

    expect(await getOutboundMessages(page)).toEqual([VIEW_READY, TEXT_EDITOR_SWITCH_REQUESTED]);
  });

  test('sends two editor switch requests when the switch button is pressed twice', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize(''));

    await switchButton(page).click();
    await switchButton(page).click();

    expect(await getOutboundMessages(page)).toEqual([
      VIEW_READY,
      TEXT_EDITOR_SWITCH_REQUESTED,
      TEXT_EDITOR_SWITCH_REQUESTED,
    ]);
  });

  test('sends one editor switch request when the button is pressed while sending fails and again after sending recovers', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize(''));
    await setSendFailure(page, true);
    await switchButton(page).click();
    await setSendFailure(page, false);

    await switchButton(page).click();

    expect(await getOutboundMessages(page)).toEqual([VIEW_READY, TEXT_EDITOR_SWITCH_REQUESTED]);
  });
});
