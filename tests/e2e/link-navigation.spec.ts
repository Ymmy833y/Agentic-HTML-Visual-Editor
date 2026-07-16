import { expect, test } from '@playwright/test';
import { getMessages, mountEditor } from './helpers/page';

test.describe('Relative file link navigation', () => {
  test('keeps the webview open and posts the literal href to the host', async ({ page }) => {
    await mountEditor(
      page,
      '<p><a href="folder/a%20b.txt"><strong>open file</strong></a></p>',
    );
    const urlBefore = page.url();
    await page.evaluate(() => {
      const testWindow = window as typeof window & { __injectedLinkClicks?: number };
      testWindow.__injectedLinkClicks = 0;
      window.addEventListener('click', (event) => {
        if (event.composedPath().some((node) => node instanceof HTMLAnchorElement)) {
          testWindow.__injectedLinkClicks!++;
        }
      });
    });

    await page.locator('#ahve-root strong').click();

    expect(page.url()).toBe(urlBefore);
    expect(await page.evaluate(() => {
      const testWindow = window as typeof window & { __injectedLinkClicks?: number };
      return testWindow.__injectedLinkClicks;
    })).toBe(0);
    const messages = await getMessages(page);
    expect(messages).toContainEqual({ type: 'openRelativeFile', href: 'folder/a%20b.txt' });
  });
});
