// Editing a document with no block structure yet — a fresh .html file opened
// straight in the WYSIWYG view — and the operations that used to break once
// bare root-level text existed. Chromium's defaults write directly under the
// root here (the typed character became a bare text node with no <p>), and
// commands that resolve their target through a block ancestor then silently
// failed or produced invalid HTML. Real keyboard input is required: jsdom
// carries no editing defaults, so only Chromium can show where a typed
// character actually lands.

import { expect, test } from '@playwright/test';
import {
  caretAtStart,
  caretInBareTail,
  focusEditor,
  getRootHtml,
  mountEditor,
} from './helpers/page';

const TABLE = '<table><tbody><tr><td>x</td></tr></tbody></table>';

test.describe('Typing into an empty document', () => {
  test('the first typed characters are wrapped in a paragraph', async ({ page }) => {
    await mountEditor(page, '');
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root');

    await page.keyboard.type('abc');

    expect(await getRootHtml(page)).toBe('<p>abc</p>');
  });

  test('a whitespace-only document gets a paragraph too', async ({ page }) => {
    await mountEditor(page, '\n  ');
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root');

    await page.keyboard.type('a');

    expect(await page.locator('#ahve-root > p').evaluate((n) => n.textContent)).toBe('a');
  });

  test('Enter first creates the canonical paragraph pair and typing continues on the second line', async ({ page }) => {
    await mountEditor(page, '');
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root');

    await page.keyboard.press('Enter');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe('<p><br></p><p>x</p>');
  });

  // Shift+Enter reaches the same browser default the cases above stand in front
  // of, and only Chromium can say whether the two-break shape the handler builds
  // actually puts the caret on the second line — a paragraph holding one <br>
  // renders a single line, so a caret with no line box would make the keystroke
  // invisible. The typed character is what measures it: it has to land AFTER
  // the break, and the placeholder has to be gone by the time it does.
  test('Shift+Enter breaks the line inside a paragraph, not under the root', async ({ page }) => {
    await mountEditor(page, '');
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root');

    await page.keyboard.press('Shift+Enter');

    await expect(page.locator('#ahve-root > br')).toHaveCount(0);
    await expect(page.locator('#ahve-root > p')).toHaveCount(1);
    await expect(page.locator('#ahve-root > p > br')).toHaveCount(2);
  });

  test('typing after Shift+Enter continues on the second line', async ({ page }) => {
    await mountEditor(page, '');
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root');

    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('xy');

    // Chromium collapses the trailing <br> it recognises as a placeholder, so
    // the second line holds the text and nothing else. This is the assertion
    // that says the stub must stay unmarked: sweeping it ourselves would take
    // the line box away from the NEXT native break instead.
    expect(await getRootHtml(page)).toBe('<p><br>xy</p>');
  });

  test('a second Shift+Enter is left to the browser and stays in the paragraph', async ({ page }) => {
    // Once the paragraph exists the document is no longer empty, so the handler
    // declines and Chromium's own line break takes over. It must still stay
    // inside the block rather than escaping to the root.
    await mountEditor(page, '');
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root');

    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('x');

    await expect(page.locator('#ahve-root > br')).toHaveCount(0);
    await expect(page.locator('#ahve-root > p')).toHaveCount(1);
    // Three lines, the third holding the text — the second break really did
    // something, which is what says the handler handed over cleanly rather than
    // leaving a shape Chromium's own line break cannot build on.
    expect(await getRootHtml(page)).toBe('<p><br><br>x</p>');
  });

  test('an IME composition commits inside the materialized paragraph', async ({ page }) => {
    // The one path that cannot be reproduced without a browser: the paragraph
    // is created in the compositionstart handler, and insertCompositionText is
    // not cancelable, so only a real composition can show whether Chromium
    // honours the DOM change and commits the text inside the paragraph — or
    // cancels the composition, which is what this editor otherwise assumes a
    // mid-composition DOM rewrite does.
    await mountEditor(page, '');
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root');

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', {
      text: 'にほんご',
      selectionStart: 4,
      selectionEnd: 4,
    });
    // Asserted BEFORE the commit, and this is the assertion that carries the
    // test: the UNCONFIRMED text has to be sitting inside the paragraph. The
    // final shape alone proves nothing, because Input.insertText writes at the
    // caret whether or not a composition is still running — so a composition
    // the DOM rewrite had cancelled would produce the very same <p>日本語</p>.
    // Reading the composing text out of the paragraph is what says Chromium
    // carried the live composition into the block we created under it.
    await expect(page.locator('#ahve-root > p')).toHaveText('にほんご');

    await cdp.send('Input.insertText', { text: '日本語' });

    expect(await getRootHtml(page)).toBe('<p>日本語</p>');
  });

  test('a composition that commits nothing leaves the document empty', async ({ page }) => {
    // The mirror of the case above, and the half jsdom cannot answer: the
    // paragraph is materialized at compositionstart, so a composition the user
    // abandons has to take it back with it. Whether Chromium reports that
    // abandonment as a compositionend with empty data — the signal the rollback
    // keys off — can only be measured against a real composition. Without the
    // rollback an untouched document would go on to save as <p><br></p>.
    await mountEditor(page, '');
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root');

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', {
      text: 'にほんご',
      selectionStart: 4,
      selectionEnd: 4,
    });
    expect(await page.locator('#ahve-root > p').count()).toBe(1);
    // The composing text has to be IN that paragraph, not merely beside it: a
    // composition the materialization had cancelled would leave the paragraph
    // standing and nothing to roll back, which is a different test passing for
    // the wrong reason.
    await expect(page.locator('#ahve-root > p')).toHaveText('にほんご');

    // How Chromium is told the composition was abandoned (what Escape does).
    await cdp.send('Input.imeSetComposition', {
      text: '',
      selectionStart: -1,
      selectionEnd: -1,
    });

    expect(await getRootHtml(page)).toBe('');
  });

  test('the paragraph created by typing supports the list command', async ({ page }) => {
    await mountEditor(page, '');
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root');

    await page.keyboard.type('item');
    await page.locator('#ahve-tb-ul').click();

    expect(await getRootHtml(page)).toBe('<ul><li>item</li></ul>');
  });
});

// The other way into an empty document, and the one the cases above cannot
// stand in for: they all type first, which materializes the paragraph through
// the beforeinput path. Reaching for the toolbar BEFORE typing goes through
// the command layer instead, which resolves its target from a child of the
// root — and an untouched document has none, so every one of these buttons
// used to do nothing at all, silently. Driven through real clicks because the
// command runs on the selection the browser actually holds after the click,
// which is the part a programmatic Range cannot stand in for.
test.describe('Toolbar commands on an untouched empty document', () => {
  test('the list button creates a list without typing first', async ({ page }) => {
    await mountEditor(page, '');
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root');

    await page.locator('#ahve-tb-ul').click();

    expect(await getRootHtml(page)).toBe('<ul><li><br></li></ul>');
  });

  test('the block dropdown creates the heading and typing lands inside it', async ({ page }) => {
    await mountEditor(page, '');
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root');

    await page.locator('.ahve-tb-blk-btn').click();
    await page.locator('.ahve-tb-blk-opt[data-value="h1"]').click();
    await page.keyboard.type('Title');

    expect(await getRootHtml(page)).toBe('<h1>Title</h1>');
  });

  test('the created block is a real editing surface the list command accepts', async ({ page }) => {
    // The materialized block has to be an ordinary block, not a shell the next
    // command fails on the same way.
    await mountEditor(page, '');
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root');

    await page.locator('#ahve-tb-ul').click();
    await page.keyboard.type('item');

    expect(await getRootHtml(page)).toBe('<ul><li>item</li></ul>');
  });
});

test.describe('Commands on existing bare root-level text', () => {
  test('the list button converts bare text after a table', async ({ page }) => {
    await mountEditor(page, TABLE + 'para');
    await focusEditor(page);
    await caretInBareTail(page);

    await page.locator('#ahve-tb-ul').click();

    expect(await getRootHtml(page)).toBe(TABLE + '<ul><li>para</li></ul>');
  });

  test('Ctrl+A then Ctrl+B never wraps the table in the inline tag', async ({ page }) => {
    await mountEditor(page, TABLE + 'para');
    await focusEditor(page);
    await caretInBareTail(page);

    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+b');

    // The bare run is formatted on its own; the table must never end up
    // inside the inline wrapper (invalid HTML that used to reach the file).
    expect(await page.locator('#ahve-root strong table').count()).toBe(0);
    expect(await getRootHtml(page)).toContain('<strong>para</strong>');
    expect(await page.locator('#ahve-root table').count()).toBe(1);
  });

  test('Ctrl+B twice over the whole document leaves it as it started', async ({ page }) => {
    // Exactly the keys a user presses — no re-selection in between. Two things
    // have to hold for that: applying and removing must agree on which text is
    // in scope (the cell text is inside the selection, so both passes have to
    // reach it), and the selection has to survive the first toggle, which
    // rewrites the very children the range is anchored on.
    const html = TABLE + 'para';
    await mountEditor(page, html);
    await focusEditor(page);
    await caretInBareTail(page);

    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+b');
    expect(await getRootHtml(page)).toBe(
      '<table><tbody><tr><td><strong>x</strong></td></tr></tbody></table><strong>para</strong>',
    );

    await page.keyboard.press('Control+b');

    expect(await getRootHtml(page)).toBe(html);
  });

  test('Ctrl+A then the list button converts the bare text and keeps the table', async ({ page }) => {
    await mountEditor(page, TABLE + 'para');
    await focusEditor(page);
    await caretInBareTail(page);

    await page.keyboard.press('Control+a');
    await page.locator('#ahve-tb-ul').click();

    expect(await getRootHtml(page)).toBe(TABLE + '<ul><li>para</li></ul>');
  });
});
