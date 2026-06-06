import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { focusEditor, getRootHtml, mountEditor } from './helpers/page';

// Simulate the extension host echoing the saved file back to the webview via a
// `documentChanged` message. The host posts this whenever the on-disk document
// text changes (e.g. Ctrl+S with insertFinalNewline, or the serializer adding a
// `\n` between freshly-created blocks). The webview remounts the whole DOM in
// response, which is exactly the path that used to lose the caret and leave
// empty blocks uneditable.
async function dispatchDocumentChanged(page: Page, html: string): Promise<void> {
  await page.evaluate((html) => {
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'documentChanged', html } }),
    );
  }, html);
}

test.describe('Save echo — caret preservation', () => {
  test('keeps the caret in place instead of jumping to the top after a save echo', async ({
    page,
  }) => {
    await mountEditor(page, '<p>hello world</p><p>second</p>');
    await focusEditor(page);

    // Caret in the middle of the first paragraph ("hello |world").
    await page.evaluate(() => {
      const p = document.querySelector('#hw-root p')!;
      const range = document.createRange();
      range.setStart(p.firstChild!, 6);
      range.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    // The save echo carries a whitespace-different but content-equal document,
    // so the webview's identity guard does not short-circuit the remount.
    await dispatchDocumentChanged(page, '<p>hello world</p>\n<p>second</p>\n');

    const state = await page.evaluate(() => {
      const sel = window.getSelection()!;
      const firstP = document.querySelector('#hw-root p');
      return {
        anchorText: sel.anchorNode?.textContent ?? null,
        anchorOffset: sel.anchorOffset,
        inFirstP: !!firstP && !!sel.anchorNode && firstP.contains(sel.anchorNode),
      };
    });

    expect(state.inFirstP).toBe(true);
    expect(state.anchorText).toBe('hello world');
    expect(state.anchorOffset).toBe(6);
  });
});

test.describe('Save echo — empty block editability', () => {
  test('reinjects the <br> placeholder so a saved empty formatted paragraph stays editable', async ({
    page,
  }) => {
    await mountEditor(page, '<p><strong>Sample text.</strong></p>');

    // After pressing Enter at the end of fully-bold text and saving, the file
    // holds an empty formatted paragraph. The serializer strips the live `<br>`,
    // so the echoed source has none.
    await dispatchDocumentChanged(
      page,
      '<p><strong>Sample text.</strong></p>\n<p><strong></strong></p>',
    );

    // The placeholder must be reinjected on mount so the block is editable.
    expect(await getRootHtml(page)).toContain('<strong><br></strong>');

    // And the block must actually accept input: place a caret inside the empty
    // <strong> and type a character.
    await focusEditor(page);
    await page.evaluate(() => {
      const blocks = document.querySelectorAll('#hw-root p');
      const strong = blocks[blocks.length - 1].querySelector('strong')!;
      const range = document.createRange();
      range.selectNodeContents(strong);
      range.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.type('X');

    const lastStrongText = await page.evaluate(() => {
      const blocks = document.querySelectorAll('#hw-root p');
      return blocks[blocks.length - 1].querySelector('strong')?.textContent ?? null;
    });
    expect(lastStrongText).toBe('X');
  });
});
