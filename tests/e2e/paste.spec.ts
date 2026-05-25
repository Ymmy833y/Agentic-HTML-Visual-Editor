import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { caretAtEnd, focusEditor, getRootHtml, mountEditor } from './helpers/page';

async function pasteHtml(page: Page, html: string): Promise<void> {
  await page.evaluate((payload) => {
    const dt = new DataTransfer();
    dt.setData('text/html', payload);
    const evt = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    document.querySelector('#hw-root')!.dispatchEvent(evt);
  }, html);
}

test.describe('Paste sanitization', () => {
  test('drops <script> elements from pasted HTML', async ({ page }) => {
    await mountEditor(page, '<p></p>');
    await focusEditor(page);
    await caretAtEnd(page, '#hw-root p');

    await pasteHtml(page, '<p>safe</p><script>window.__pwned = true</script>');

    const html = await getRootHtml(page);
    expect(html).not.toContain('<script');
    expect(html).toContain('safe');
    // The sanitizer should not allow the script to have executed.
    const pwned = await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned);
    expect(pwned).toBeUndefined();
  });

  test('strips on* attributes from pasted markup', async ({ page }) => {
    await mountEditor(page, '<p></p>');
    await focusEditor(page);
    await caretAtEnd(page, '#hw-root p');

    await pasteHtml(page, '<p onclick="alert(1)" onmouseover="x">hi</p>');

    const html = await getRootHtml(page);
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onmouseover');
    expect(html).toContain('hi');
  });

  test('removes javascript: URLs from pasted links', async ({ page }) => {
    await mountEditor(page, '<p></p>');
    await focusEditor(page);
    await caretAtEnd(page, '#hw-root p');

    await pasteHtml(page, '<a href="javascript:alert(1)">click</a>');

    const html = await getRootHtml(page);
    expect(html).toContain('click');
    expect(html).not.toContain('javascript:');
  });

  test('drops <iframe>, <link>, <style>, <meta> from pasted content', async ({ page }) => {
    await mountEditor(page, '<p></p>');
    await focusEditor(page);
    await caretAtEnd(page, '#hw-root p');

    await pasteHtml(
      page,
      '<iframe src="x"></iframe><link rel="stylesheet" href="x"><style>p{}</style><meta name="x"><p>kept</p>',
    );

    const html = await getRootHtml(page);
    for (const tag of ['iframe', 'link', 'style', 'meta']) {
      expect(html, `<${tag}> should have been stripped`).not.toContain(`<${tag}`);
    }
    expect(html).toContain('kept');
  });
});
