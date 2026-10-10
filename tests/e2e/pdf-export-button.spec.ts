import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { HOST_TO_VIEW_MESSAGE_TYPE, MESSAGE_CATALOG_ELEMENT_ID, VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { PROBE_BUNDLE_PATH, getOutboundMessages, openWebviewHost, sendToWebview } from './helpers/page';

const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;
const EXPORT_ITEM = `${TOOLBAR} [data-slot="${TOOLBAR_SLOT.pdfExport}"] button`;

/**
 * Embeds the English message catalog and then mounts a body.
 *
 * @param page The page to operate on.
 * @param body The body to mount.
 */
async function openExportEditor(page: Page, body: string): Promise<void> {
  await openWebviewHost(page, PROBE_BUNDLE_PATH);
  await page.evaluate((argument) => {
    const element = document.createElement('script');
    element.type = 'application/json';
    element.id = argument.elementId;
    element.textContent = argument.catalog;
    document.head.append(element);
  }, { elementId: MESSAGE_CATALOG_ELEMENT_ID, catalog: JSON.stringify(englishMessages) });
  await sendToWebview(page, {
    type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
    text: `<!DOCTYPE html>\n<html><body>${body}</body></html>`,
    documentUri: '',
    resourceRootUri: '',
  });
}

test.describe('the toolbar export button', () => {
  test('sits right after the copy button, with no separator between them, and is named Export as PDF', async ({ page }) => {
    await openExportEditor(page, '<p>a</p>');

    const placement = await page.evaluate((argument) => {
      const copy = document.querySelector(`${argument.toolbar} [data-slot="${argument.copy}"]`);
      return copy?.nextElementSibling?.getAttribute('data-slot');
    }, { toolbar: TOOLBAR, copy: TOOLBAR_SLOT.copy });

    expect([placement, await page.locator(EXPORT_ITEM).getAttribute('aria-label')])
      .toEqual([TOOLBAR_SLOT.pdfExport, 'Export as PDF']);
  });

  test('pressing the export button sends exactly one export request carrying only the type', async ({ page }) => {
    await openExportEditor(page, '<p>a</p>');
    const sentBefore = (await getOutboundMessages(page)).length;

    await page.locator(EXPORT_ITEM).click();

    expect((await getOutboundMessages(page)).slice(sentBefore))
      .toEqual([{ type: VIEW_TO_HOST_MESSAGE_TYPE.pdfExportRequested }]);
  });
});
