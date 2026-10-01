import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { EDITOR_ROOT_ELEMENT_ID } from '../../common/index';
import { RENDERING_SOURCE_ATTRIBUTE_NAME } from '../../webview/document/image-source-resolver';
import {
  FIXTURE_DIRECTORY_URL,
  FIXTURE_PAGE_URL,
  getOutboundMessages,
  openWebviewHost,
  sendToWebview,
} from './helpers/page';

declare global {
  interface Window {
    // A marker that disappears with the page if navigation or reloading occurs.
    __documentMarker?: string;
  }
}

const VIEW_READY = { type: 'viewReady' };

const EDITOR_ROOT = `#${EDITOR_ROOT_ELEMENT_ID}`;

// Treat the fixture page as the open file. This makes it possible to verify that an image in the
// same directory is actually loaded from the author's relative path.
function initialize(body: string, rootAttributes = ''): Record<string, unknown> {
  return {
    type: 'initialize',
    text: `<html${rootAttributes}>\n<body>${body}</body>\n</html>\n`,
    documentUri: FIXTURE_PAGE_URL,
    resourceRootUri: FIXTURE_DIRECTORY_URL,
  };
}

// Determine that neither navigation nor reloading occurred by checking that the page marker remains.
async function markPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__documentMarker = 'before';
  });
}

async function readPageMarker(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__documentMarker);
}

test.describe('body rendering', () => {
  test('mounts a body element under the editor root from one initialize message', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, initialize('<p id="mounted">a</p>'));

    await expect(page.locator(`${EDITOR_ROOT} #mounted`)).toHaveText('a');
  });

  test('still sends only the view ready message after rendering the body', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize('<p id="mounted">a</p>'));
    await expect(page.locator(`${EDITOR_ROOT} #mounted`)).toHaveText('a');

    expect(await getOutboundMessages(page)).toEqual([VIEW_READY]);
  });

  test('loads and displays an image next to the fixture page from a relative path', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, initialize('<img src="sample.png" alt="a">'));

    const image = page.locator(`${EDITOR_ROOT} img`);

    // The intrinsic width is greater than zero only after the image loads successfully.
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);
  });

  test("preserves the author's relative path in the displayed image's rendering source attribute", async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, initialize('<img src="sample.png" alt="a">'));

    await expect(page.locator(`${EDITOR_ROOT} img`)).toHaveAttribute(
      RENDERING_SOURCE_ATTRIBUTE_NAME,
      'sample.png',
    );
  });

  test('renders an image that points outside the resource root without loading it', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize('<img src="../outside.png" alt="a">'));

    const image = page.locator(`${EDITOR_ROOT} img`);
    await expect(image).toHaveJSProperty('complete', true);

    expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(0);
  });

  test("applies the open file's language declaration to the editor root", async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, initialize('<p id="mounted">a</p>', ' lang="ja"'));

    await expect(page.locator(EDITOR_ROOT)).toHaveAttribute('lang', 'ja');
  });

  test('does not add a language declaration to the editor root when the file has none', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize('<p id="mounted">a</p>'));
    await expect(page.locator(`${EDITOR_ROOT} #mounted`)).toHaveText('a');

    const root = page.locator(EDITOR_ROOT);
    expect(await root.evaluate((element) => element.hasAttribute('lang'))).toBe(false);
  });

  test('displays the form and its controls', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(
      page,
      initialize('<form action="/submit"><input name="a"><button type="submit">Submit</button></form>'),
    );

    await expect(page.locator(`${EDITOR_ROOT} form input`)).toBeVisible();
  });

  test('does not navigate or reload when the submit button is clicked', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(
      page,
      initialize('<form action="/submit"><input name="a"><button type="submit">Submit</button></form>'),
    );
    await expect(page.locator(`${EDITOR_ROOT} form input`)).toBeVisible();
    await markPage(page);

    await page.locator(`${EDITOR_ROOT} button[type="submit"]`).click();

    expect(await readPageMarker(page)).toBe('before');
  });

  test('preserves every space and line break inside pre after mounting', async ({ page }) => {
    const content = '  a\n\n    b\n';
    await openWebviewHost(page);

    await sendToWebview(page, initialize(`<pre>${content}</pre>`));

    // Read without text-matching normalization so whitespace compaction is also checked.
    const preformatted = page.locator(`${EDITOR_ROOT} pre`);
    expect(await preformatted.evaluate((element) => element.textContent)).toBe(content);
  });

  test('preserves whitespace between table rows and cells in the mounted tree', async ({ page }) => {
    const rows = '\n<tr>\n<td>a</td>\n<td>b</td>\n</tr>\n';
    await openWebviewHost(page);

    await sendToWebview(page, initialize(`<table>\n<tbody>${rows}</tbody>\n</table>`));

    const body = page.locator(`${EDITOR_ROOT} tbody`);
    expect(await body.evaluate((element) => element.innerHTML)).toBe(rows);
  });

  test('does not run a removed onerror handler when image loading fails', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(
      page,
      initialize('<img src="missing.png" alt="a" onerror="window.__documentMarker = \'onerror\'">'),
    );

    await expect(page.locator(`${EDITOR_ROOT} img`)).toHaveJSProperty('complete', true);

    expect(await readPageMarker(page)).toBeUndefined();
  });

  test('does not navigate when a link with a removed javascript: URL is clicked', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(
      page,
      initialize('<a href="javascript:window.location.replace(\'about:blank\')">link</a>'),
    );
    await expect(page.locator(`${EDITOR_ROOT} a`)).toBeVisible();
    await markPage(page);

    await page.locator(`${EDITOR_ROOT} a`).click();

    expect(await readPageMarker(page)).toBe('before');
  });
});
