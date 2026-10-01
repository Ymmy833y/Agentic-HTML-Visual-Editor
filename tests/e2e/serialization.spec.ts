import { expect, test } from '@playwright/test';

import { EDITOR_ROOT_ELEMENT_ID } from '../../common/index';
import { PROBE_BUNDLE_PATH, openWebviewHost, sendToWebview } from './helpers/page';

const AUTHORING_GUIDE_BODY = [
  '<h1>Design notes</h1>',
  '<p>This is the body.</p>',
  '<blockquote data-alert="important"><p>Take note</p></blockquote>',
  '<details><summary>Details</summary><p>Content</p></details>',
  '<table><tbody><tr><th>Item</th><td>Value</td></tr></tbody></table>',
].join('\n');

function initialize(body: string): Record<string, unknown> {
  return {
    type: 'initialize',
    text: `<!DOCTYPE html>\n<html><body>${body}</body></html>`,
    documentUri: '',
    resourceRootUri: '',
  };
}

test.describe('serialization', () => {
  test('mounts a body in the authoring guide format with content matching the input', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, initialize(AUTHORING_GUIDE_BODY));

    await expect(page.locator(`#${EDITOR_ROOT_ELEMENT_ID}`)).toHaveJSProperty(
      'innerHTML',
      AUTHORING_GUIDE_BODY,
    );
  });

  test('builds an output matching the input after mounting a body in the authoring guide format', async ({ page }) => {
    await openWebviewHost(page, PROBE_BUNDLE_PATH);

    await sendToWebview(page, initialize(AUTHORING_GUIDE_BODY));

    // Look at the serialized current form. With no edit, the output body simply
    // returns the disk body, so it cannot show what the browser's serializer
    // produced.
    const current = await page.evaluate(() => window.__serializationProbe?.()?.current);
    expect(current).toBe(AUTHORING_GUIDE_BODY);
  });

  test('does not expose the original attribute names after mounting a body with dangerous attributes', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(
      page,
      initialize('<p onclick="alert(1)">a</p><a href="javascript:alert(2)">b</a>'),
    );

    await expect(page.locator(`#${EDITOR_ROOT_ELEMENT_ID} [onclick]`)).toHaveCount(0);
    await expect(page.locator(`#${EDITOR_ROOT_ELEMENT_ID} [href]`)).toHaveCount(0);
  });
});
