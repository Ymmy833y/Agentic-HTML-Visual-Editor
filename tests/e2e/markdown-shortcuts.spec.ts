import { expect, test } from '@playwright/test';
import { caretAtEnd, focusEditor, getRootHtml, mountEditor } from './helpers/page';

test.describe('Markdown-style shortcuts', () => {
  test('"# " at the start of a paragraph converts it to <h1>', async ({ page }) => {
    await mountEditor(page, '<p>#</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');
    await page.keyboard.press('Space');
    expect(await getRootHtml(page)).toBe('<h1><br></h1>');
  });

  test('"###### " produces an <h6>', async ({ page }) => {
    await mountEditor(page, '<p>######</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');
    await page.keyboard.press('Space');
    await expect(page.locator('#ahve-root h6')).toHaveCount(1);
  });

  test('"---" + Enter becomes <hr> followed by a fresh paragraph', async ({ page }) => {
    await mountEditor(page, '<p>---</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');
    await page.keyboard.press('Enter');
    expect(await getRootHtml(page)).toBe('<hr><p><br></p>');
  });

  test('"- " at the start of a paragraph starts a bulleted list', async ({ page }) => {
    await mountEditor(page, '<p>-</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');
    await page.keyboard.press('Space');
    expect(await getRootHtml(page)).toBe('<ul><li><br></li></ul>');
  });

  test('"1. " at the start of a paragraph starts a numbered list', async ({ page }) => {
    await mountEditor(page, '<p>1.</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');
    await page.keyboard.press('Space');
    expect(await getRootHtml(page)).toBe('<ol><li><br></li></ol>');
  });

  test('"> " at the start of a paragraph starts a blockquote', async ({ page }) => {
    await mountEditor(page, '<p>&gt;</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');
    await page.keyboard.press('Space');
    expect(await getRootHtml(page)).toBe('<blockquote><br></blockquote>');
  });

  for (const type of ['note', 'tip', 'important', 'warning', 'caution'] as const) {
    test(`">${type} " starts a ${type} alert`, async ({ page }) => {
      await mountEditor(page, '<p><br></p>');
      await focusEditor(page);
      await page.keyboard.type(`>${type} `);
      expect(await getRootHtml(page)).toBe(
        `<blockquote data-alert="${type}"><br></blockquote>`,
      );
    });
  }

  test('">info " remains ordinary text', async ({ page }) => {
    await mountEditor(page, '<p><br></p>');
    await focusEditor(page);
    await page.keyboard.type('>info ');
    await expect(page.locator('#ahve-root blockquote')).toHaveCount(0);
    await expect(page.locator('#ahve-root p')).toHaveText('>info ');
  });

  test('formal alert shortcut also works in bare root text', async ({ page }) => {
    await mountEditor(page, '&gt;caution');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root');
    await page.keyboard.press('Space');
    expect(await getRootHtml(page)).toBe(
      '<blockquote data-alert="caution"><br></blockquote>',
    );
  });

  test('alert shortcut is one undoable edit and can be redone', async ({ page }) => {
    await mountEditor(page, '<p><br></p>');
    await focusEditor(page);
    await page.keyboard.type('>warning ');
    expect(await getRootHtml(page)).toBe(
      '<blockquote data-alert="warning"><br></blockquote>',
    );

    await page.keyboard.press('Control+z');
    expect(await getRootHtml(page)).toBe('<p>&gt;warning</p>');

    await page.keyboard.press('Control+y');
    expect(await getRootHtml(page)).toBe(
      '<blockquote data-alert="warning"><br></blockquote>',
    );
  });

  test('recognized alert types render labels, icons, and distinct accent colors', async ({ page }) => {
    await mountEditor(
      page,
      '<blockquote data-alert="note">N</blockquote>' +
        '<blockquote data-alert="tip">T</blockquote>' +
        '<blockquote data-alert="important">I</blockquote>' +
        '<blockquote data-alert="warning">W</blockquote>' +
        '<blockquote data-alert="caution">C</blockquote>' +
        '<blockquote data-alert="future">F</blockquote>',
    );

    const rendered = await page.locator('#ahve-root blockquote').evaluateAll((quotes) =>
      quotes.map((quote) => {
        const style = getComputedStyle(quote);
        const before = getComputedStyle(quote, '::before');
        const after = getComputedStyle(quote, '::after');
        return {
          borderColor: style.borderLeftColor,
          label: before.content,
          icon: after.maskImage,
        };
      }),
    );

    expect(rendered.slice(0, 5).map((item) => item.label)).toEqual([
      '"Note"',
      '"Tip"',
      '"Important"',
      '"Warning"',
      '"Caution"',
    ]);
    expect(new Set(rendered.slice(0, 5).map((item) => item.borderColor)).size).toBe(5);
    for (const item of rendered.slice(0, 5)) {
      expect(item.icon).toContain('data:image/svg+xml');
    }
    expect(rendered[5].label).toBe('none');
    expect(rendered[5].icon).toBe('none');
  });

  test('"```" + Enter opens a code block', async ({ page }) => {
    await mountEditor(page, '<p>```</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');
    await page.keyboard.press('Enter');
    expect(await getRootHtml(page)).toBe('<pre><br></pre>');
  });

  // Typing the marker (rather than pre-seeding it) leaves an empty text node
  // behind when the marker is deleted; without normalizing it the emptied
  // <li>/<blockquote> would hold an invisible empty text node instead of the
  // <br> placeholder, so the list/quote appears to "not show up".
  test('typing "- " into an empty paragraph yields a visible empty item', async ({ page }) => {
    await mountEditor(page, '<p><br></p>');
    await focusEditor(page);
    await page.keyboard.type('- ');
    expect(await getRootHtml(page)).toBe('<ul><li><br></li></ul>');
  });

  test('typing "1. " into an empty paragraph yields a visible empty item', async ({ page }) => {
    await mountEditor(page, '<p><br></p>');
    await focusEditor(page);
    await page.keyboard.type('1. ');
    expect(await getRootHtml(page)).toBe('<ol><li><br></li></ol>');
  });

  test('typing "> " into an empty paragraph yields a visible empty blockquote', async ({ page }) => {
    await mountEditor(page, '<p><br></p>');
    await focusEditor(page);
    await page.keyboard.type('> ');
    expect(await getRootHtml(page)).toBe('<blockquote><br></blockquote>');
  });

  test('typing "- text" keeps the text inside the item', async ({ page }) => {
    await mountEditor(page, '<p><br></p>');
    await focusEditor(page);
    await page.keyboard.type('- hello');
    expect(await getRootHtml(page)).toBe('<ul><li>hello</li></ul>');
  });

  // The line a user lands on after a heading is created by contenteditable's
  // default Enter. It must become a <p> (not the browser default <div>) so the
  // output stays consistent and the markdown shortcuts keep working there.
  test('Enter after a heading creates a <p>, not a <div>', async ({ page }) => {
    await mountEditor(page, '<h1>Title</h1>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root h1');
    await page.keyboard.press('Enter');
    await page.keyboard.type('body');
    expect(await getRootHtml(page)).toBe('<h1>Title</h1><p>body</p>');
  });

  // The shortcuts must also fire inside a <div> block, since existing documents
  // and AI output can contain them.
  test('typing "- " inside a <div> starts a list', async ({ page }) => {
    await mountEditor(page, '<div><br></div>');
    await focusEditor(page);
    await page.keyboard.type('- item');
    expect(await getRootHtml(page)).toBe('<ul><li>item</li></ul>');
  });

  test('does not fire when "#" is not at the start of the block', async ({ page }) => {
    await mountEditor(page, '<p>hello#</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');
    await page.keyboard.press('Space');
    const html = await getRootHtml(page);
    // The space is inserted normally (browser default). The block must NOT
    // have been promoted to a heading.
    await expect(page.locator('#ahve-root h1, #ahve-root h2, #ahve-root h3')).toHaveCount(0);
    expect(html.startsWith('<p>')).toBe(true);
  });

  // A table cell has no block wrapper, so the shortcut must wrap the cell's
  // inline content in a <p> on demand and create the list inside the cell.
  test('typing "- " inside a table cell starts a list in the cell', async ({ page }) => {
    await mountEditor(page, '<table><tbody><tr><td><br></td></tr></tbody></table>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root td');
    await page.keyboard.type('- item');
    expect(await page.locator('#ahve-root td').innerHTML()).toBe('<ul><li>item</li></ul>');
  });
});
