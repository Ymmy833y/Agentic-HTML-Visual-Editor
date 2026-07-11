import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { caretAtEnd, focusEditor, getRootHtml, mountEditor, saveAndGetHtml } from './helpers/page';

async function pasteHtml(page: Page, html: string): Promise<void> {
  await page.evaluate((payload) => {
    const dt = new DataTransfer();
    dt.setData('text/html', payload);
    const evt = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    document.querySelector('#ahve-root')!.dispatchEvent(evt);
  }, html);
}

test.describe('Paste sanitization', () => {
  test('drops <script> elements from pasted HTML', async ({ page }) => {
    await mountEditor(page, '<p></p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');

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
    await caretAtEnd(page, '#ahve-root p');

    await pasteHtml(page, '<p onclick="alert(1)" onmouseover="x">hi</p>');

    const html = await getRootHtml(page);
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onmouseover');
    expect(html).toContain('hi');
  });

  test('removes javascript: URLs from pasted links', async ({ page }) => {
    await mountEditor(page, '<p></p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');

    await pasteHtml(page, '<a href="javascript:alert(1)">click</a>');

    const html = await getRootHtml(page);
    expect(html).toContain('click');
    expect(html).not.toContain('javascript:');
  });

  test('drops <iframe>, <link>, <style>, <meta> from pasted content', async ({ page }) => {
    await mountEditor(page, '<p></p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');

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

  test('strips CF_HTML fragment markers and computed-style noise', async ({ page }) => {
    await mountEditor(page, '<p></p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');

    await pasteHtml(
      page,
      '<!--StartFragment--><strong style="font-weight: 700; color: rgb(212, 212, 212); ' +
        'font-family: -apple-system, BlinkMacSystemFont, Arial; font-size: 14px; ' +
        'letter-spacing: normal; white-space: normal;">bold</strong><!--EndFragment-->',
    );

    const html = await getRootHtml(page);
    expect(html).not.toContain('StartFragment');
    expect(html).not.toContain('EndFragment');
    expect(html).not.toContain('font-family');
    expect(html).not.toContain('font-size');
    expect(html).not.toContain('letter-spacing');
    expect(html).not.toContain('white-space');
    // Color is in the allowlist and should survive.
    expect(html).toContain('color');
    expect(html).toContain('bold');
  });
});

test.describe('Copy / paste round-trip', () => {
  test('pasting twice over a backward paragraph selection does not leave a trailing empty shell', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'clipboard API is Chromium-only in CI');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await mountEditor(
      page,
      '  <h2>Heading2</h2>\n  <p>This is sample text.</p>\n',
    );
    await focusEditor(page);

    await page.evaluate(() => {
      const root = document.querySelector('#ahve-root')!;
      const paragraph = root.querySelector('p')!;
      const paragraphText = paragraph.firstChild!;
      const paragraphIndex = Array.from(root.childNodes).indexOf(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.setBaseAndExtent(
        paragraphText,
        paragraphText.textContent!.length,
        root,
        paragraphIndex,
      );
    });

    await page.keyboard.press('Control+C');
    await page.keyboard.press('Control+V');
    await page.keyboard.press('Control+V');

    expect(await saveAndGetHtml(page)).toBe(
      '  <h2>Heading2</h2>\n  <p>This is sample text.</p>\n  <p>This is sample text.</p>\n',
    );
  });

  test('pasting twice over the original paragraph selection does not leave its empty shell', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'clipboard API is Chromium-only in CI');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await mountEditor(
      page,
      '  <h2>Heading</h2>\n  <p>This is sample text.</p>\n',
    );
    await focusEditor(page);

    await page.evaluate(() => {
      const paragraph = document.querySelector('#ahve-root p')!;
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, 0);
      range.setEndAfter(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Control+C');
    await page.keyboard.press('Control+V');
    await page.keyboard.press('Control+V');

    expect(await saveAndGetHtml(page)).toBe(
      '  <h2>Heading</h2>\n  <p>This is sample text.</p>\n  <p>This is sample text.</p>\n',
    );
  });

  test('copying a paragraph and pasting it twice before a heading does not create empty blocks on save', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'clipboard API is Chromium-only in CI');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await mountEditor(
      page,
      '  <h2>Heading</h2>\n  <p>This is sample text.</p>\n' +
        '  <p><span style="font-size: 1.25em; font-weight: 600;">Level 3 heading</span></p>\n',
    );
    await focusEditor(page);

    await page.evaluate(() => {
      const paragraph = document.querySelector('#ahve-root p')!;
      const heading = document.querySelector('#ahve-root p:nth-of-type(2) span')!;
      const range = document.createRange();
      // A visual drag that starts at the first character and ends just after
      // the line can put the Range boundary at offset zero in the next heading
      // even though only the paragraph text is visibly highlighted (the
      // interaction in the GIF).
      range.setStart(paragraph.firstChild!, 0);
      range.setEnd(heading.firstChild!, 0);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Control+C');
    await page.evaluate(() => {
      const heading = document.querySelector('#ahve-root p:nth-of-type(2) span')!;
      const range = document.createRange();
      range.setStart(heading.firstChild!, 0);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+V');
    await page.keyboard.press('Control+V');

    expect(await saveAndGetHtml(page)).toBe(
      '  <h2>Heading</h2>\n  <p>This is sample text.</p>\n  <p>This is sample text.</p>\n' +
        '  <p>This is sample text.</p>\n' +
        '  <p><span style="font-size: 1.25em; font-weight: 600;">Level 3 heading</span></p>\n',
    );
  });

  test('copying then pasting within the editor produces clean HTML', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'clipboard API is Chromium-only in CI');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await mountEditor(page, '<p>foo <strong>bar</strong> baz</p><p></p>');
    await focusEditor(page);

    // Select "foo <strong>bar</strong> baz" inside the first paragraph.
    await page.evaluate(() => {
      const p = document.querySelector('#ahve-root p')!;
      const r = document.createRange();
      r.selectNodeContents(p);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
    });

    await page.keyboard.press('Control+C');

    // Place the caret in the empty second paragraph and paste.
    await caretAtEnd(page, '#ahve-root p:nth-of-type(2)');
    await page.keyboard.press('Control+V');

    const html = await getRootHtml(page);
    expect(html).not.toContain('StartFragment');
    expect(html).not.toContain('font-family');
    expect(html).not.toContain('font-size');
    // The semantic <strong> survives because it is the editor's own format.
    expect(html).toContain('<strong>bar</strong>');
  });

  // Regression for "copy <strong>sample</strong> inside, paste at <br>":
  // (1) the bold wrapper must travel with the clipboard payload, (2) no
  // stray \r\n from the OS CF_HTML wrapper may leak into the destination.
  test('selecting only the inner text of <strong> still pastes as <strong> with no \\n bleed', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'clipboard API is Chromium-only in CI');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await mountEditor(page, '<p>This is <strong>sample</strong> text.</p><p><br></p>');
    await focusEditor(page);

    // Select the text "sample" by its inner offsets — mirrors a double-click.
    await page.evaluate(() => {
      const text = document.querySelector('#ahve-root strong')!.firstChild!;
      const r = document.createRange();
      r.setStart(text, 0);
      r.setEnd(text, 6);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
    });
    await page.keyboard.press('Control+C');

    // Place the caret at the <br> in the second paragraph and paste.
    await page.evaluate(() => {
      const br = document.querySelector('#ahve-root p:nth-of-type(2) br')!;
      const r = document.createRange();
      r.setStartBefore(br);
      r.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
    });
    await page.keyboard.press('Control+V');

    const html = await getRootHtml(page);
    expect(html).toContain('<strong>sample</strong>');
    // No \n / \r should appear immediately next to the inserted bold text.
    expect(html).not.toMatch(/\s+<strong>sample<\/strong>\s+<br>/);
    // Strict expected shape.
    expect(html).toBe(
      '<p>This is <strong>sample</strong> text.</p><p><strong>sample</strong><br></p>',
    );
  });

  test('Ctrl+Shift+V pastes as plain text, stripping all tags', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'clipboard API is Chromium-only in CI');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await mountEditor(page, '<p></p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');

    // Seed the clipboard with rich HTML.
    await page.evaluate(async () => {
      const html = '<strong>BOLD</strong> and <em>italic</em>';
      const text = 'BOLD and italic';
      const blob = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([blob]);
    });

    await page.keyboard.press('Control+Shift+V');

    const html = await getRootHtml(page);
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<em>');
    expect(html).toContain('BOLD and italic');
  });
});

test.describe('Clear formatting', () => {
  test('Ctrl+\\ strips inline formatting from the current selection', async ({ page }) => {
    await mountEditor(page, '<p>plain <strong>bold</strong> <em>em</em> tail</p>');
    await focusEditor(page);

    // Select the entire paragraph contents.
    await page.evaluate(() => {
      const p = document.querySelector('#ahve-root p')!;
      const r = document.createRange();
      r.selectNodeContents(p);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
    });

    await page.keyboard.press('Control+\\');

    const html = await getRootHtml(page);
    expect(html).toBe('<p>plain bold em tail</p>');
  });
});
