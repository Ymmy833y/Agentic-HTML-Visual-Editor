import { expect, test } from '@playwright/test';
import { getMessages, mountEditor } from './helpers/page';

test.describe('Relative file link navigation', () => {
  test('an unmodified click keeps the webview open without opening the link', async ({ page }) => {
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
    expect(messages).not.toContainEqual({ type: 'openRelativeFile', href: 'folder/a%20b.txt' });
  });

  test('Ctrl+click posts the literal relative href to the host', async ({ page }) => {
    await mountEditor(
      page,
      '<p><a href="folder/a%20b.txt"><strong>open file</strong></a></p>',
    );

    await page.locator('#ahve-root strong').click({ modifiers: ['Control'] });

    const messages = await getMessages(page);
    expect(messages).toContainEqual({ type: 'openRelativeFile', href: 'folder/a%20b.txt' });
  });

  test('Cmd+click posts the literal relative href to the host', async ({ page }) => {
    await mountEditor(
      page,
      '<p><a href="folder/a%20b.txt"><strong>open file</strong></a></p>',
    );

    await page.locator('#ahve-root strong').click({ modifiers: ['Meta'] });

    const messages = await getMessages(page);
    expect(messages).toContainEqual({ type: 'openRelativeFile', href: 'folder/a%20b.txt' });
  });

  test('an unmodified commented link opens only the comment popup', async ({ page }) => {
    await mountEditor(
      page,
      '<p><comment id="c-link"><a href="folder/note.html"><strong>note</strong></a>' +
        '<comment-body>review</comment-body></comment></p>',
    );

    await page.locator('#ahve-root strong').click();

    await expect(page.locator('#ahve-comment-popup')).toBeVisible();
    const messages = await getMessages(page);
    expect(messages).not.toContainEqual({ type: 'openRelativeFile', href: 'folder/note.html' });
  });

  test('Ctrl+click on a commented link opens only the link', async ({ page }) => {
    await mountEditor(
      page,
      '<p><comment id="c-link"><a href="folder/note.html"><strong>note</strong></a>' +
        '<comment-body>review</comment-body></comment></p>',
    );

    await page.locator('#ahve-root strong').click({ modifiers: ['Control'] });

    await expect(page.locator('#ahve-comment-popup')).toBeHidden();
    const messages = await getMessages(page);
    expect(messages).toContainEqual({ type: 'openRelativeFile', href: 'folder/note.html' });
  });

  test('Ctrl+click on a comment without a link still opens the comment popup', async ({ page }) => {
    await mountEditor(
      page,
      '<p><comment id="c-text">note<comment-body>review</comment-body></comment></p>',
    );

    await page.locator('#ahve-root comment').click({ modifiers: ['Control'] });

    await expect(page.locator('#ahve-comment-popup')).toBeVisible();
  });

  test('hovering a link hints at the modifier, and leaving it clears the hint', async ({ page }) => {
    await mountEditor(
      page,
      '<p><a href="folder/a%20b.txt"><strong>open file</strong></a></p><p>away</p>',
    );
    const hint = page.locator('#ahve-tooltip');

    await page.locator('#ahve-root strong').hover();

    await expect(hint).toHaveText('Follow link (Ctrl+Click)');
    await expect(hint).toHaveClass(/ahve-tooltip-visible/);

    await page.locator('#ahve-root p').nth(1).hover();

    await expect(hint).not.toHaveClass(/ahve-tooltip-visible/);
  });
});
