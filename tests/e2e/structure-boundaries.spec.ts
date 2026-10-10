import { expect, test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';

import { EDITOR_ROOT_ELEMENT_ID } from '../../common/index';
import { BLOCK_KIND } from '../../webview/editing/block-format';
import { OUTPUT_DEBOUNCE_MS } from '../../webview/editing/change-tracker';
import { BLOCK_KIND_MESSAGE_KEY, BLOCK_TYPE_MENU_CLASS } from '../../webview/ui/block-type-menu';
import type { BlockTypeMenuKind } from '../../webview/ui/block-type-menu';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import {
  EDITOR_ROOT,
  deleteWordBackward,
  dispatchBeforeInput,
  installReceiver,
  openEditor,
  paste,
  readBodyHtml,
  readRecord,
  selectAll,
} from './helpers/editing';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;
const MENU = `.${BLOCK_TYPE_MENU_CLASS}`;

/** A table with ab in a single cell. */
const TABLE = '<table><tbody><tr><td>ab</td></tr></tbody></table>';

/** A body with a paragraph after a table. */
const TABLE_THEN_PARAGRAPH = `\n${TABLE}\n<p>cd</p>\n`;

/** A body with only an open details section. */
const OPEN_DETAILS = '\n<details open="">\n<summary>title</summary>\n<p>body</p>\n</details>\n';

/** An instruction that ends a composition without committing. An empty composition string means it was not committed. */
const CANCEL_COMPOSITION = { text: '', selectionStart: -1, selectionEnd: -1 };

// Grant permissions so that paste can be checked with the real clipboard.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

/** A position. Omitting the child index of the element gives a position inside the element itself. */
interface Point {
  readonly selector: string;
  readonly childIndex?: number;
  readonly offset: number;
}

/** A summary of where the caret is. */
interface CaretSummary {
  /** The element name of the element containing the caret (the parent if inside text). */
  readonly inside: string;
  /** The text of that element. */
  readonly text: string;
  /** The number of characters from the start of that element to the caret. */
  readonly offset: number;
}

/**
 * Selects between two positions and focuses the editor root.
 *
 * @param page The page to operate on.
 * @param start The start.
 * @param end The end.
 */
async function selectBetween(page: Page, start: Point, end: Point): Promise<void> {
  await page.evaluate((argument) => {
    const resolve = (point: { selector: string; childIndex?: number }): Node => {
      const element = document.querySelector(point.selector);
      const node = point.childIndex === undefined ? element : element?.childNodes[point.childIndex];
      if (node === null || node === undefined) {
        throw new Error(`position not found: ${point.selector}`);
      }
      return node;
    };
    const range = document.createRange();
    range.setStart(resolve(argument.start), argument.start.offset);
    range.setEnd(resolve(argument.end), argument.end.offset);
    document.getElementById(argument.rootId)?.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { start, end, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Places the caret at a position and focuses the editor root.
 *
 * @param page The page to operate on.
 * @param point The caret position.
 */
async function placeCaretAt(page: Page, point: Point): Promise<void> {
  await selectBetween(page, point, point);
}

/**
 * Reads where the caret is.
 *
 * The end of a paragraph can be expressed both as the end of its text and as the position after the text in the paragraph. To give the same summary either way, it is
 * expressed as the number of characters from the start of the element.
 *
 * @param page The page to operate on.
 * @returns A summary of where the caret is.
 */
async function readCaret(page: Page): Promise<CaretSummary> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode ?? null;
    const element = anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
    if (anchor === null || element === null || selection === null) {
      return { inside: '', text: '', offset: -1 };
    }
    const before = document.createRange();
    before.setStart(element, 0);
    before.setEnd(anchor, selection.anchorOffset);
    return { inside: element.localName, text: element.textContent ?? '', offset: before.toString().length };
  });
}

/**
 * Determines whether the caret is inside an element.
 *
 * @param page The page to operate on.
 * @param selector The CSS selector that finds the element.
 * @returns `true` if it is inside.
 */
async function isCaretInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((target) => {
    const anchor = window.getSelection()?.anchorNode ?? null;
    const element = document.querySelector(target);
    return anchor !== null && element !== null && element.contains(anchor);
  }, selector);
}

/**
 * Reads the saved content produced from the tree being edited.
 *
 * @param page The page to operate on.
 * @returns The body of the saved content.
 */
async function readCurrentForm(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__serializationProbe?.()?.current);
}

/**
 * Opens the channel that drives the browser's IME.
 *
 * @param page The page to operate on.
 * @returns The opened channel.
 */
async function openImeSession(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/**
 * Composes a hiragana character with the IME and commits it as a kanji.
 *
 * @param page The page to operate on.
 */
async function composeAndCommit(page: Page): Promise<void> {
  const ime = await openImeSession(page);
  await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
  await ime.send('Input.insertText', { text: '亜' });
}

/**
 * Deletes one word after the caret with the platform's key combination.
 *
 * macOS assigns word deletion to Option.
 *
 * @param page The page to operate on.
 */
async function deleteWordForward(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Alt+Delete' : 'Control+Delete');
}

/**
 * Opens the block type menu and presses a kind item.
 *
 * @param page The page to operate on.
 * @param kind The kind to choose.
 */
async function chooseBlockKind(page: Page, kind: BlockTypeMenuKind): Promise<void> {
  await page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.blockType}"] > button`).click();
  await page.locator(`${MENU} button[aria-label="${BLOCK_KIND_MESSAGE_KEY[kind]}"]`).click();
}

test.describe('noop for deletes at a structure boundary', () => {
  test('pressing Backspace at the start of the paragraph right after a table does not pull the paragraph into a cell and leaves the tree unchanged', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe(TABLE_THEN_PARAGRAPH);
  });

  test('pressing Backspace at the start of bare text directly under the editor root right after a table leaves the text outside the table', async ({ page }) => {
    const body = `\n${TABLE}cd\n`;
    await openEditor(page, body);
    await placeCaretAt(page, { selector: EDITOR_ROOT, childIndex: 2, offset: 0 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe(body);
  });

  test('pressing Delete directly under the editor root right after a table (the same position as a click in the margin to its right) does not turn the following paragraph into bare text', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await placeCaretAt(page, { selector: EDITOR_ROOT, offset: 2 });

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe(TABLE_THEN_PARAGRAPH);
  });

  test('pressing Backspace directly under the editor root right before a table keeps the line break before the preceding paragraph and does not pull the table onto its line', async ({ page }) => {
    const body = `\n<p>ab</p>\n${TABLE}\n`;
    await openEditor(page, body);
    await placeCaretAt(page, { selector: EDITOR_ROOT, offset: 3 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe(body);
  });

  test('pressing Delete at the end of the last cell does not pull the paragraph after the table into the cell', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} td`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe(TABLE_THEN_PARAGRAPH);
  });

  test('pressing Backspace at the start of the second cell does not merge it with the previous cell', async ({ page }) => {
    const body = '\n<table><tbody><tr><td>ab</td><td>cd</td></tr></tbody></table>\n';
    await openEditor(page, body);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} td:last-child`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe(body);
  });

  test('pressing Backspace at the start of the first paragraph of an open details body does not merge the title and the body', async ({ page }) => {
    await openEditor(page, OPEN_DETAILS);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} details > p`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe(OPEN_DETAILS);
  });

  test('in a details section whose body is bare text, Backspace at the start of the body is a noop', async ({ page }) => {
    const body = '\n<details open="">\n<summary>title</summary>body\n</details>\n';
    await openEditor(page, body);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} details`, childIndex: 2, offset: 0 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe(body);
  });

  test('pressing Delete at the end of the title does not pull the body into the title', async ({ page }) => {
    await openEditor(page, OPEN_DETAILS);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} summary`, childIndex: 0, offset: 5 });

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe(OPEN_DETAILS);
  });

  test('pressing Backspace at the start of the paragraph right after a code block does not pull the paragraph into pre', async ({ page }) => {
    const body = '\n<pre><code>ab</code></pre>\n<p>cd</p>\n';
    await openEditor(page, body);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe(body);
  });

  test('pressing Delete at the end of code neither pulls characters of the following paragraph into code nor moves code characters out', async ({ page }) => {
    const body = '\n<pre><code>ab</code></pre>\n<p>cd</p>\n';
    await openEditor(page, body);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe(body);
  });

  test('pressing Delete at the end of bare text right before a table inside a cell does not pull the text into the table', async ({ page }) => {
    const body = `\n<table><tbody><tr><td>xy${TABLE}</td></tr></tbody></table>\n`;
    await openEditor(page, body);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} td`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe(body);
  });

  test('a noop at a boundary sends no immediate notification', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await installReceiver(page);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect((await readRecord(page)).kinds).toEqual([]);
  });

  test('pressing Ctrl+Backspace at the start of the paragraph right after a table does not pull the paragraph into a cell', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 0 });

    await deleteWordBackward(page);

    expect(await readBodyHtml(page)).toBe(TABLE_THEN_PARAGRAPH);
  });

  test('pressing Ctrl+Delete at the end of the title does not pull the body into the title', async ({ page }) => {
    await openEditor(page, OPEN_DETAILS);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} summary`, childIndex: 0, offset: 5 });

    await deleteWordForward(page);

    expect(await readBodyHtml(page)).toBe(OPEN_DETAILS);
  });

  test('sending a line-wise backward delete beforeinput at the start of the paragraph right after a table stops the default and leaves the tree unchanged', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 0 });

    const prevented = await dispatchBeforeInput(page, 'deleteSoftLineBackward');

    expect([prevented, await readBodyHtml(page)]).toEqual([true, TABLE_THEN_PARAGRAPH]);
  });

  test('sending a line-wise forward delete beforeinput directly under the editor root right after a table stops the default and leaves the tree unchanged', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await placeCaretAt(page, { selector: EDITOR_ROOT, offset: 2 });

    const prevented = await dispatchBeforeInput(page, 'deleteSoftLineForward');

    expect([prevented, await readBodyHtml(page)]).toEqual([true, TABLE_THEN_PARAGRAPH]);
  });
});

test.describe('protecting the code element', () => {
  test('deleting the last character of code with Backspace keeps code, and characters typed next go inside code', async ({ page }) => {
    await openEditor(page, '\n<pre><code>a</code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 1 });

    await page.keyboard.press('Backspace');
    const cleared = await readBodyHtml(page);
    await page.keyboard.type('X');

    expect([cleared, await readBodyHtml(page)])
      .toEqual(['\n<pre><code></code></pre>\n', '\n<pre><code>X</code></pre>\n']);
  });

  test('deleting the last word of code with Ctrl+Backspace still keeps code', async ({ page }) => {
    await openEditor(page, '\n<pre><code>abc</code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 3 });

    await deleteWordBackward(page);

    expect(await readBodyHtml(page)).toBe('\n<pre><code></code></pre>\n');
  });

  test('pressing Delete at the start of a one-character code still keeps code', async ({ page }) => {
    await openEditor(page, '\n<pre><code>a</code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe('\n<pre><code></code></pre>\n');
  });

  test('sending a line-wise backward delete beforeinput at the end of a one-line code deletes only the content and keeps code', async ({ page }) => {
    await openEditor(page, '\n<pre><code>abc</code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 3 });

    const prevented = await dispatchBeforeInput(page, 'deleteSoftLineBackward');

    expect([prevented, await readBodyHtml(page)]).toEqual([true, '\n<pre><code></code></pre>\n']);
  });

  test('pressing Backspace at the end of a two-character code deletes only one character by the browser default', async ({ page }) => {
    await openEditor(page, '\n<pre><code>ab</code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<pre><code>a</code></pre>\n');
  });

  test('deleting all characters of a code ending with a line break leaves a code with only the line break, and the next Backspace replaces it with an empty paragraph', async ({ page }) => {
    await openEditor(page, '\n<pre><code>a\n</code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 1 });

    await page.keyboard.press('Backspace');
    const cleared = await readBodyHtml(page);
    await page.keyboard.press('Backspace');

    expect([cleared, await readBodyHtml(page)])
      .toEqual(['\n<pre><code>\n</code></pre>\n', '\n<p><br></p>\n']);
  });

  test('pressing Backspace in a blank code block replaces it with an empty paragraph carrying over the id, with the caret in that paragraph', async ({ page }) => {
    await openEditor(page, '\n<pre id="k"><code></code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, offset: 0 });

    await page.keyboard.press('Backspace');

    expect([await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} > p`)])
      .toEqual(['\n<p id="k"><br></p>\n', true]);
  });

  test('pressing Delete in a blank code block also replaces it with an empty paragraph', async ({ page }) => {
    await openEditor(page, '\n<pre><code></code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, offset: 0 });

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe('\n<p><br></p>\n');
  });

  test('pressing Backspace twice in a blank code block after a paragraph removes the code block and puts the caret at the end of the preceding paragraph', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<pre><code></code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, offset: 0 });

    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');

    expect([await readBodyHtml(page), await readCaret(page)])
      .toEqual(['\n<p>ab</p>\n', { inside: 'p', text: 'ab', offset: 2 }]);
  });

  test('in <pre>$ <code>npm</code></pre>, Backspace after deleting all of npm deletes only the space and keeps code', async ({ page }) => {
    await openEditor(page, '\n<pre>$ <code>npm</code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 3 });

    for (let press = 0; press < 3; press += 1) {
      await page.keyboard.press('Backspace');
    }
    const cleared = await readBodyHtml(page);
    await page.keyboard.press('Backspace');

    expect([cleared, await readBodyHtml(page)])
      .toEqual(['\n<pre>$ <code></code></pre>\n', '\n<pre>$<code></code></pre>\n']);
  });

  test('in the same shape, characters typed after emptying code go inside code', async ({ page }) => {
    await openEditor(page, '\n<pre>$ <code>npm</code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 3 });

    for (let press = 0; press < 3; press += 1) {
      await page.keyboard.press('Backspace');
    }
    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe('\n<pre>$ <code>X</code></pre>\n');
  });

  test('in a pre with a space and characters after an empty code, Delete inside code deletes only the space and keeps code', async ({ page }) => {
    await openEditor(page, '\n<pre><code></code> x</pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, offset: 0 });

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe('\n<pre><code></code>x</pre>\n');
  });

  test('committing with the IME after emptying code puts the characters inside code and leaves no placeholder in the saved content', async ({ page }) => {
    await openEditor(page, '\n<pre><code>a</code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 1 });

    await page.keyboard.press('Backspace');
    await composeAndCommit(page);

    expect(await readCurrentForm(page)).toBe('\n<pre><code>亜</code></pre>\n');
  });

  test('committing with the IME right after converting an empty paragraph to a code block puts the characters inside code', async ({ page }) => {
    await openEditor(page, '\n<p><br></p>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} p`, offset: 0 });

    await page.evaluate(() => window.__blockCommandProbe?.({ kind: 'toggleCodeBlock' }));
    await composeAndCommit(page);

    expect(await readBodyHtml(page)).toBe('\n<pre><code>亜</code></pre>\n');
  });

  test('in a pre with content before code, committing with the IME after emptying code puts the characters inside code and leaves no br', async ({ page }) => {
    await openEditor(page, '\n<pre>$ <code>a</code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 1 });

    await page.keyboard.press('Backspace');
    await composeAndCommit(page);

    expect(await readBodyHtml(page)).toBe('\n<pre>$ <code>亜</code></pre>\n');
  });

  test('even in a pre with only a line break after code, the committed characters go inside code and no placeholder remains', async ({ page }) => {
    await openEditor(page, '\n<pre><code>a</code>\n</pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 1 });

    await page.keyboard.press('Backspace');
    await composeAndCommit(page);

    expect(await readCurrentForm(page)).toBe('\n<pre><code>亜</code>\n</pre>\n');
  });

  test('ending a composition in an empty code without committing restores the tree and sends no immediate notification', async ({ page }) => {
    const body = '\n<pre><code></code></pre>\n';
    await openEditor(page, body);
    await installReceiver(page);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, offset: 0 });
    const ime = await openImeSession(page);

    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    await ime.send('Input.imeSetComposition', CANCEL_COMPOSITION);

    expect([await readBodyHtml(page), (await readRecord(page)).kinds]).toEqual([body, []]);
  });

  test('starting a composition right after emptying code keeps the placeholder out of the body output that arrives mid-composition', async ({ page }) => {
    await openEditor(page, '\n<pre><code>a</code></pre>\n');
    await installReceiver(page);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 1 });
    const ime = await openImeSession(page);

    await page.keyboard.press('Backspace');
    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    // The body output arrives after the deferral deadline, so keep composing and wait until that time has passed before counting.
    await page.waitForTimeout(OUTPUT_DEBOUNCE_MS * 2);

    expect((await readRecord(page)).bodies).toEqual(['\n<pre><code></code></pre>\n']);
  });
});

test.describe('block edges inside pre', () => {
  test('when code starts with a line break, Backspace at the start of the second line deletes the line break', async ({ page }) => {
    await openEditor(page, '\n<pre><code>\nab</code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 1 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<pre><code>ab</code></pre>\n');
  });

  test('pressing Backspace after the indentation of the first line of code deletes one space', async ({ page }) => {
    await openEditor(page, '\n<pre><code>  ab</code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<pre><code> ab</code></pre>\n');
  });

  test('pressing Delete before the line break that forms a blank line in code deletes that line break', async ({ page }) => {
    await openEditor(page, '\n<pre><code>ab\n\n</code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe('\n<pre><code>ab\n</code></pre>\n');
  });

  test('pressing Delete at the end of the last line of a code ending with a line break leaves the tree unchanged', async ({ page }) => {
    const body = '\n<pre><code>ab\n</code></pre>\n<p>cd</p>\n';
    await openEditor(page, body);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe(body);
  });

  test('in a code block starting with a blank line right after a horizontal rule, Backspace after the blank line deletes only the line break and keeps the horizontal rule', async ({ page }) => {
    await openEditor(page, '\n<hr>\n<pre><code>\nab</code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 1 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<hr>\n<pre><code>ab</code></pre>\n');
  });
});

test.describe('empty standalone block next to a structure', () => {
  /** A body with an empty paragraph between a table with two cells and a paragraph. */
  const EMPTY_AFTER_TABLE = '\n<table><tbody><tr><td>ab</td><td>cd</td></tr></tbody></table>\n<p><br></p>\n<p>ef</p>\n';

  test('pressing Backspace in the empty paragraph between a table and a paragraph removes it and puts the caret at the end of the last cell', async ({ page }) => {
    await openEditor(page, EMPTY_AFTER_TABLE);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, offset: 0 });

    await page.keyboard.press('Backspace');

    expect([await readBodyHtml(page), await readCaret(page)]).toEqual([
      '\n<table><tbody><tr><td>ab</td><td>cd</td></tr></tbody></table>\n<p>ef</p>\n',
      { inside: 'td', text: 'cd', offset: 2 },
    ]);
  });

  test('pressing Backspace in the empty paragraph between a closed details section and a paragraph puts the caret at the end of the title', async ({ page }) => {
    await openEditor(page, '\n<details>\n<summary>title</summary>\n<p>body</p>\n</details>\n<p><br></p>\n<p>ef</p>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, offset: 0 });

    await page.keyboard.press('Backspace');

    expect([await readBodyHtml(page), await readCaret(page)]).toEqual([
      '\n<details>\n<summary>title</summary>\n<p>body</p>\n</details>\n<p>ef</p>\n',
      { inside: 'summary', text: 'title', offset: 5 },
    ]);
  });

  test('pressing Backspace in the empty paragraph right after an open details section puts the caret at the end of the last body paragraph', async ({ page }) => {
    await openEditor(page, `${OPEN_DETAILS}<p><br></p>\n<p>ef</p>\n`);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, offset: 0 });

    await page.keyboard.press('Backspace');

    expect([await readCaret(page), await isCaretInside(page, `${EDITOR_ROOT} details > p`)])
      .toEqual([{ inside: 'p', text: 'body', offset: 4 }, true]);
  });

  test('pressing Delete in the empty paragraph between a paragraph and a table removes it and puts the caret at the start of the first cell', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<p><br></p>\n<table><tbody><tr><td>cd</td><td>ef</td></tr></tbody></table>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p:nth-of-type(2)`, offset: 0 });

    await page.keyboard.press('Delete');

    expect([await readBodyHtml(page), await readCaret(page)]).toEqual([
      '\n<p>ab</p>\n<table><tbody><tr><td>cd</td><td>ef</td></tr></tbody></table>\n',
      { inside: 'td', text: 'cd', offset: 0 },
    ]);
  });

  test('pressing Delete in the empty paragraph between a paragraph and a list removes it and puts the caret at the start of the first item line', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<p><br></p>\n<ul>\n<li>cd</li>\n</ul>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p:nth-of-type(2)`, offset: 0 });

    await page.keyboard.press('Delete');

    expect([await readBodyHtml(page), await readCaret(page)]).toEqual([
      '\n<p>ab</p>\n<ul>\n<li>cd</li>\n</ul>\n',
      { inside: 'li', text: 'cd', offset: 0 },
    ]);
  });

  test('pressing Backspace in the empty paragraph between a list whose last item ends with a table and a paragraph removes it and puts the caret at the end of the last cell of the table', async ({ page }) => {
    await openEditor(
      page,
      '\n<ul>\n<li>ab<table><tbody><tr><td>cd</td></tr></tbody></table></li>\n</ul>\n<p><br></p>\n<p>ef</p>\n',
    );
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, offset: 0 });

    await page.keyboard.press('Backspace');

    expect([await readBodyHtml(page), await readCaret(page)]).toEqual([
      '\n<ul>\n<li>ab<table><tbody><tr><td>cd</td></tr></tbody></table></li>\n</ul>\n<p>ef</p>\n',
      { inside: 'td', text: 'cd', offset: 2 },
    ]);
  });

  test('pressing Backspace in the empty paragraph right after a list whose last item ends with a table, at the end of the document, keeps the paragraph and moves only the caret into the table', async ({ page }) => {
    const body = '\n<ul>\n<li>ab<table><tbody><tr><td>cd</td></tr></tbody></table></li>\n</ul>\n<p><br></p>\n';
    await openEditor(page, body);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, offset: 0 });

    await page.keyboard.press('Backspace');

    expect([await readBodyHtml(page), await readCaret(page)])
      .toEqual([body, { inside: 'td', text: 'cd', offset: 2 }]);
  });

  test('pressing Backspace in the empty paragraph right after a list whose last item ends with a paragraph merges into the end of the last item by the list rule as before', async ({ page }) => {
    await openEditor(page, '\n<ul>\n<li>\n<p>ab</p>\n</li>\n</ul>\n<p><br></p>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, offset: 0 });

    await page.keyboard.press('Backspace');

    expect([await readBodyHtml(page), await readCaret(page)])
      .toEqual(['\n<ul>\n<li>\n<p>ab</p>\n</li>\n</ul>\n', { inside: 'p', text: 'ab', offset: 2 }]);
  });

  test('pressing Backspace in the empty paragraph right after a table at the end of the document keeps the paragraph and moves only the caret into the last cell', async ({ page }) => {
    const body = `\n${TABLE}\n<p><br></p>\n`;
    await openEditor(page, body);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, offset: 0 });

    await page.keyboard.press('Backspace');

    expect([await readBodyHtml(page), await readCaret(page)])
      .toEqual([body, { inside: 'td', text: 'ab', offset: 2 }]);
  });

  test('pressing Backspace in the empty paragraph between two tables keeps the paragraph and moves the caret into the previous table', async ({ page }) => {
    const body = `\n${TABLE}\n<p><br></p>\n<table><tbody><tr><td>cd</td></tr></tbody></table>\n`;
    await openEditor(page, body);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, offset: 0 });

    await page.keyboard.press('Backspace');

    expect([await readBodyHtml(page), await readCaret(page)])
      .toEqual([body, { inside: 'td', text: 'ab', offset: 2 }]);
  });

  test('pressing Delete at the end of code removes only the empty paragraph right after it and keeps the caret in code', async ({ page }) => {
    await openEditor(page, '\n<pre><code>ab</code></pre>\n<p><br></p>\n<p>cd</p>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Delete');

    expect([await readBodyHtml(page), await readCaret(page)]).toEqual([
      '\n<pre><code>ab</code></pre>\n<p>cd</p>\n',
      { inside: 'code', text: 'ab', offset: 2 },
    ]);
  });

  test('pressing Backspace in the empty paragraph right after a table whose last cell contains a table puts the caret in the last cell of the inner table', async ({ page }) => {
    await openEditor(
      page,
      `\n<table><tbody><tr><td>xy<table><tbody><tr><td>cd</td></tr></tbody></table></td></tr></tbody></table>\n`
      + '<p><br></p>\n<p>ef</p>\n',
    );
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, offset: 0 });

    await page.keyboard.press('Backspace');

    expect([await readCaret(page), await isCaretInside(page, `${EDITOR_ROOT} td td`)])
      .toEqual([{ inside: 'td', text: 'cd', offset: 2 }, true]);
  });

  test('pressing Backspace in the empty paragraph right after a closed details section without a title changes neither the tree nor the caret', async ({ page }) => {
    const body = '\n<details>\n<p>body</p>\n</details>\n<p><br></p>\n<p>ef</p>\n';
    await openEditor(page, body);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, offset: 0 });

    await page.keyboard.press('Backspace');

    expect([await readBodyHtml(page), await readCaret(page)])
      .toEqual([body, { inside: 'p', text: '', offset: 0 }]);
  });

  test('pressing Ctrl+Backspace in the empty paragraph between a table and a paragraph removes the empty paragraph just like Backspace', async ({ page }) => {
    await openEditor(page, EMPTY_AFTER_TABLE);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, offset: 0 });

    await deleteWordBackward(page);

    expect(await readBodyHtml(page))
      .toBe('\n<table><tbody><tr><td>ab</td><td>cd</td></tr></tbody></table>\n<p>ef</p>\n');
  });

  test('removing the empty paragraph sends exactly one immediate notification and leaves no blank line in the saved content', async ({ page }) => {
    await openEditor(page, EMPTY_AFTER_TABLE);
    await installReceiver(page);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, offset: 0 });

    await page.keyboard.press('Backspace');

    expect([(await readRecord(page)).kinds, await readCurrentForm(page)]).toEqual([
      ['deleteContentBackward'],
      '\n<table><tbody><tr><td>ab</td><td>cd</td></tr></tbody></table>\n<p>ef</p>\n',
    ]);
  });
});

test.describe('unwrapping a details section from the start of its title', () => {
  /** A body with only a closed details section. */
  const CLOSED_DETAILS = '\n<details>\n<summary>title</summary>\n<p>body</p>\n</details>\n';

  /** The body after unwrapping the details section with the title and body paragraph. */
  const UNWRAPPED = '\n<p>title</p>\n<p>body</p>\n';

  test('pressing Backspace at the start of the title of an open details section at the start of the document turns the title into a paragraph followed by the body, with the caret at the start of that paragraph', async ({ page }) => {
    await openEditor(page, OPEN_DETAILS);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} summary`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect([await readBodyHtml(page), await readCaret(page)])
      .toEqual([UNWRAPPED, { inside: 'p', text: 'title', offset: 0 }]);
  });

  test('pressing Backspace at the start of the title of a closed details section keeps the body and shows it', async ({ page }) => {
    await openEditor(page, CLOSED_DETAILS);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} summary`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect([
      await readBodyHtml(page),
      await page.locator(`${EDITOR_ROOT} > p`, { hasText: 'body' }).isVisible(),
    ]).toEqual([UNWRAPPED, true]);
  });

  test('pressing Ctrl+Backspace at the start of the title unwraps the details section the same way as Backspace', async ({ page }) => {
    await openEditor(page, OPEN_DETAILS);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} summary`, childIndex: 0, offset: 0 });

    await deleteWordBackward(page);

    expect(await readBodyHtml(page)).toBe(UNWRAPPED);
  });

  test('sending a line-wise backward delete beforeinput at the start of the title stops the default and leaves the tree unchanged', async ({ page }) => {
    await openEditor(page, OPEN_DETAILS);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} summary`, childIndex: 0, offset: 0 });

    const prevented = await dispatchBeforeInput(page, 'deleteSoftLineBackward');

    expect([prevented, await readBodyHtml(page)]).toEqual([true, OPEN_DETAILS]);
  });

  test('unwrapping a details section whose body is bare text wraps the body in a paragraph', async ({ page }) => {
    await openEditor(page, '\n<details open="">\n<summary>title</summary>body\n</details>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} summary`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<p>title</p>\n<p>body\n</p>\n');
  });

  test('pressing Backspace inside the start of an annotation at the start of the title unwraps the details section, keeps the annotation and its entry in the paragraph, and puts the caret outside the annotation at the start of the paragraph', async ({ page }) => {
    await openEditor(
      page,
      '\n<details open="">\n<summary><comment id="c-a1b2c3d4">ab<comment-body contenteditable="false" data-author="ai" '
      + 'data-updated="2026-01-01T00:00:00Z">note</comment-body></comment>cd</summary>\n<p>body</p>\n</details>\n',
    );
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} comment`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    const shape = await page.locator(`${EDITOR_ROOT} comment`).evaluate((comment) => ({
      parent: comment.parentElement?.localName,
      grandparent: comment.parentElement?.parentElement?.id,
      annotated: comment.firstChild?.textContent,
      body: comment.querySelector('comment-body')?.textContent,
    }));
    expect([shape, await page.locator(`${EDITOR_ROOT} details`).count(), await readCaret(page)]).toEqual([
      { parent: 'p', grandparent: EDITOR_ROOT_ELEMENT_ID, annotated: 'ab', body: 'note' },
      0,
      { inside: 'p', text: 'abnotecd', offset: 0 },
    ]);
  });

  test('unwrapping a details section sends one immediate notification', async ({ page }) => {
    await openEditor(page, OPEN_DETAILS);
    await installReceiver(page);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} summary`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect((await readRecord(page)).kinds).toEqual(['deleteContentBackward']);
  });
});

test.describe('protecting the skeleton on range delete', () => {
  /** A three-by-two table with a paragraph before and after it. Each row has a line break. */
  const GRID = '\n<p>ab</p>\n<table>\n<tbody>\n<tr><td>c1</td><td>d1</td></tr>\n<tr><td>c2</td><td>d2</td></tr>\n'
    + '<tr><td>c3</td><td>d3</td></tr>\n</tbody>\n</table>\n<p>ef</p>\n';

  test('backspacing from the paragraph before a table to the middle of a second-row cell keeps the numbers of rows, cells and columns and empties the first-row cells', async ({ page }) => {
    await openEditor(page, GRID);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} tr:nth-child(2) td`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe(
      '\n<p>a</p>\n<table>\n<tbody>\n<tr><td><br></td><td><br></td></tr>\n<tr><td>2</td><td>d2</td></tr>\n'
      + '<tr><td>c3</td><td>d3</td></tr>\n</tbody>\n</table>\n<p>ef</p>\n',
    );
  });

  test('the same operation leaves the saved lines of rows the range does not touch unchanged', async ({ page }) => {
    await openEditor(page, GRID);
    const before = (await readCurrentForm(page))?.split('\n') ?? [];
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} tr:nth-child(2) td`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('Backspace');

    const after = (await readCurrentForm(page))?.split('\n') ?? [];
    const untouched = (lines: string[]): string[] => lines.slice(lines.indexOf('<tr><td>c3</td><td>d3</td></tr>'));
    expect([after.length, untouched(after)]).toEqual([before.length, untouched(before)]);
  });

  test('deleting from the middle of a cell to the middle of the paragraph after the table leaves the rest of the paragraph on the line after </table>', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} td`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<table><tbody><tr><td>a</td></tr></tbody></table>\n<p>d</p>\n');
  });

  test('deleting from a table cell to a cell of a later table keeps both skeletons and creates one empty paragraph between the tables', async ({ page }) => {
    await openEditor(page, `\n${TABLE}\n<p>mid</p>\n<table><tbody><tr><td>cd</td></tr></tbody></table>\n`);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} td`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} table:last-of-type td`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe(
      '\n<table><tbody><tr><td>a</td></tr></tbody></table>\n<p><br></p>\n'
      + '<table><tbody><tr><td>d</td></tr></tbody></table>\n',
    );
  });

  test('deleting a range that contains a whole table removes the table', async ({ page }) => {
    await openEditor(page, `\n<p>xy</p>\n${TABLE}\n<p>cd</p>\n`);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} > p:last-of-type`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<p>xd</p>\n');
  });

  test('deleting a range spanning into a cell of another row of the same table with Delete keeps the line breaks between rows', async ({ page }) => {
    await openEditor(page, '\n<table>\n<tbody>\n<tr><td>ab</td></tr>\n<tr><td>cd</td></tr>\n</tbody>\n</table>\n');
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} td`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} tr:last-child td`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page))
      .toBe('\n<table>\n<tbody>\n<tr><td>a</td></tr>\n<tr><td>d</td></tr>\n</tbody>\n</table>\n');
  });

  test('pressing Enter over a range from the paragraph before a table into a cell keeps the table skeleton', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<table><tbody><tr><td>c1</td></tr><tr><td>c2</td></tr></tbody></table>\n');
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} tr:last-child td`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('Enter');

    expect([
      await page.locator(`${EDITOR_ROOT} tr`).count(),
      await page.locator(`${EDITOR_ROOT} td`).count(),
    ]).toEqual([2, 2]);
  });

  test('deleting from the middle of the title of a closed details section to the following paragraph keeps the rest of the title and the body, with the rest of the paragraph on the line after the details section', async ({ page }) => {
    await openEditor(page, '\n<details>\n<summary>title</summary>\n<p>body</p>\n</details>\n<p>cd</p>\n');
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} summary`, childIndex: 0, offset: 2 },
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page))
      .toBe('\n<details>\n<summary>ti</summary>\n<p>body</p>\n</details>\n<p>d</p>\n');
  });

  test('deleting from before to after a closed details section removes the whole details section', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<details>\n<summary>title</summary>\n<p>body</p>\n</details>\n<p>cd</p>\n');
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} > p:last-of-type`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<p>ad</p>\n');
  });

  test('deleting from the middle of the title of a closed details section to the middle of a cell of a later table keeps the closed body and the table skeleton, with one empty paragraph between them', async ({ page }) => {
    await openEditor(
      page,
      `\n<details>\n<summary>title</summary>\n<p>body</p>\n</details>\n<p>mid</p>\n${TABLE}\n`,
    );
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} summary`, childIndex: 0, offset: 2 },
      { selector: `${EDITOR_ROOT} td`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe(
      '\n<details>\n<summary>ti</summary>\n<p>body</p>\n</details>\n<p><br></p>\n'
      + '<table><tbody><tr><td>b</td></tr></tbody></table>\n',
    );
  });

  test('deleting from the middle of a table cell to the middle of the body of a later open details section keeps both the table skeleton and the title protected by the title guard', async ({ page }) => {
    await openEditor(page, `\n${TABLE}${OPEN_DETAILS}`);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} td`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} details > p`, childIndex: 0, offset: 2 },
    );

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe(
      '\n<table><tbody><tr><td>a</td></tr></tbody></table>\n<details open="">\n<summary><br></summary>\n<p>dy</p>\n</details>\n',
    );
  });
});

test.describe('format and block kind targets', () => {
  test('applying bold to a selection from the paragraph before a table to the paragraph after it bolds only the characters outside and inside the table, and the table stays in place', async ({ page }) => {
    await openEditor(page, `\n<p>xy</p>\n${TABLE}\n<p>ef</p>\n`);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} > p:last-of-type`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('ControlOrMeta+B');

    expect(await readBodyHtml(page)).toBe(
      '\n<p>x<strong>y</strong></p>\n<table><tbody><tr><td><strong>ab</strong></td></tr></tbody></table>\n'
      + '<p><strong>e</strong>f</p>\n',
    );
  });

  test('applying bold to a selection crossing a code block does not bold the code characters, and pre stays in place', async ({ page }) => {
    await openEditor(page, '\n<p>xy</p>\n<pre><code>cd</code></pre>\n<p>ef</p>\n');
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} > p:last-of-type`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('ControlOrMeta+B');

    expect(await readBodyHtml(page))
      .toBe('\n<p>x<strong>y</strong></p>\n<pre><code>cd</code></pre>\n<p><strong>e</strong>f</p>\n');
  });

  test('applying bold to a selection crossing a closed details section bolds only the title and the characters outside, leaving the body unchanged', async ({ page }) => {
    await openEditor(page, '\n<p>xy</p>\n<details>\n<summary>title</summary>\n<p>body</p>\n</details>\n<p>ef</p>\n');
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} > p:last-of-type`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('ControlOrMeta+B');

    expect(await readBodyHtml(page)).toBe(
      '\n<p>x<strong>y</strong></p>\n<details>\n<summary><strong>title</strong></summary>\n<p>body</p>\n</details>\n'
      + '<p><strong>e</strong>f</p>\n',
    );
  });

  test('converting a selection crossing a closed details section to a heading leaves the body paragraphs unchanged', async ({ page }) => {
    await openEditor(page, '\n<p>xy</p>\n<details>\n<summary>title</summary>\n<p>body</p>\n</details>\n<p>ef</p>\n');
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} > p:last-of-type`, childIndex: 0, offset: 1 },
    );

    await chooseBlockKind(page, BLOCK_KIND.heading2);

    expect(await readBodyHtml(page))
      .toBe('\n<h2>xy</h2>\n<details>\n<summary>title</summary>\n<p>body</p>\n</details>\n<h2>ef</h2>\n');
  });

  test('applying bold to a selection crossing an open details section also bolds the body characters', async ({ page }) => {
    await openEditor(page, `\n<p>xy</p>${OPEN_DETAILS}<p>ef</p>\n`);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} > p:last-of-type`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('ControlOrMeta+B');

    expect(await readBodyHtml(page)).toBe(
      '\n<p>x<strong>y</strong></p>\n<details open="">\n<summary><strong>title</strong></summary>\n'
      + '<p><strong>body</strong></p>\n</details>\n<p><strong>e</strong>f</p>\n',
    );
  });

  test('applying bold to a selection crossing a comment annotation keeps the annotation element, its body and replies in place', async ({ page }) => {
    await openEditor(
      page,
      '\n<p>xy<comment id="c-a1b2c3d4">cd<comment-body contenteditable="false" data-author="ai" '
      + 'data-updated="2026-01-01T00:00:00Z">note</comment-body><comment-reply contenteditable="false" '
      + 'data-author="human" data-updated="2026-01-02T00:00:00Z">reply</comment-reply></comment>ef</p>\n',
    );
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} > p`, childIndex: 2, offset: 1 },
    );

    await page.keyboard.press('ControlOrMeta+B');

    const shape = await page.locator(`${EDITOR_ROOT} comment`).evaluate((comment) => ({
      parent: comment.parentElement?.localName,
      children: [...comment.children].map((child) => child.localName),
      body: comment.querySelector('comment-body')?.textContent,
      reply: comment.querySelector('comment-reply')?.textContent,
    }));
    expect(shape).toEqual({
      parent: 'p',
      children: ['strong', 'comment-body', 'comment-reply'],
      body: 'note',
      reply: 'reply',
    });
  });
});

test.describe('input over a structure-crossing range', () => {
  /** A two-row table with a paragraph before it. */
  const TWO_ROWS = '\n<p>ab</p>\n<table><tbody><tr><td>c1</td></tr><tr><td>c2</td></tr></tbody></table>\n';

  test('selecting from a paragraph to the middle of a cell and typing keeps the skeleton and puts the characters at the start', async ({ page }) => {
    await openEditor(page, TWO_ROWS);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} tr:last-child td`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.type('X');

    expect(await readBodyHtml(page))
      .toBe('\n<p>aX</p>\n<table><tbody><tr><td><br></td></tr><tr><td>2</td></tr></tbody></table>\n');
  });

  test('selecting from the middle of a cell to the middle of the paragraph after the table and typing leaves the rest of the paragraph after the table', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} td`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe('\n<table><tbody><tr><td>aX</td></tr></tbody></table>\n<p>d</p>\n');
  });

  test('selecting from a paragraph to the middle of code and typing keeps the rest of code inside code, and the following paragraph does not enter pre', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<pre><code>cd</code></pre>\n<p>ef</p>\n');
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe('\n<p>aX</p>\n<pre><code>d</code></pre>\n<p>ef</p>\n');
  });

  test('selecting from the middle of code to the middle of the paragraph after pre and typing puts the characters at the start inside code', async ({ page }) => {
    await openEditor(page, '\n<pre><code>ab</code></pre>\n<p>cd</p>\n');
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe('\n<pre><code>aX</code></pre>\n<p>d</p>\n');
  });

  test('pressing Enter over the same range puts the line break at the start inside code and leaves the rest of the paragraph after pre', async ({ page }) => {
    await openEditor(page, '\n<pre><code>ab</code></pre>\n<p>cd</p>\n');
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('Enter');

    // The newline ends up last in the content, so the display line break follows it to let the new line show.
    expect([await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} code`)])
      .toEqual(['\n<pre><code>a\n\n</code></pre>\n<p>d</p>\n', true]);
  });

  test('typing over a range spanning into a cell of another row of the same table keeps the line breaks between rows', async ({ page }) => {
    await openEditor(page, '\n<table>\n<tbody>\n<tr><td>ab</td></tr>\n<tr><td>cd</td></tr>\n</tbody>\n</table>\n');
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} td`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} tr:last-child td`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.type('X');

    expect(await readBodyHtml(page))
      .toBe('\n<table>\n<tbody>\n<tr><td>aX</td></tr>\n<tr><td>d</td></tr>\n</tbody>\n</table>\n');
  });

  test('pressing Shift+Enter over a range crossing a table keeps the skeleton and puts a line break at the start, showing a new line', async ({ page }) => {
    await openEditor(page, TWO_ROWS);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} tr:last-child td`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('Shift+Enter');

    expect(await readBodyHtml(page))
      .toBe('\n<p>a<br><br></p>\n<table><tbody><tr><td><br></td></tr><tr><td>2</td></tr></tbody></table>\n');
  });

  test('pressing Shift+Enter over a range crossing a details section keeps the title and puts a line break at the start', async ({ page }) => {
    await openEditor(page, `\n<p>ab</p>${OPEN_DETAILS}`);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} details > p`, childIndex: 0, offset: 2 },
    );

    await page.keyboard.press('Shift+Enter');

    expect(await readBodyHtml(page))
      .toBe('\n<p>a<br><br></p>\n<details open="">\n<summary><br></summary>\n<p>dy</p>\n</details>\n');
  });

  test('starting an IME composition over a range crossing a table does not delete the range, and the committed characters go at the start', async ({ page }) => {
    await openEditor(page, `\n<p>xy</p>\n${TABLE}\n`);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} td`, childIndex: 0, offset: 1 },
    );

    await composeAndCommit(page);

    expect(await readBodyHtml(page)).toBe(`\n<p>x亜y</p>\n${TABLE}\n`);
  });

  test('typing over a range within one cell replaces it by the browser default', async ({ page }) => {
    await openEditor(page, '\n<table><tbody><tr><td>abcd</td></tr></tbody></table>\n');
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} td`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} td`, childIndex: 0, offset: 3 },
    );

    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe('\n<table><tbody><tr><td>aXd</td></tr></tbody></table>\n');
  });

  test('typing over a range containing a whole table removes the table and inserts the characters', async ({ page }) => {
    await openEditor(page, `\n<p>xy</p>\n${TABLE}\n<p>cd</p>\n`);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} > p:last-of-type`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe('\n<p>xXd</p>\n');
  });

  test('one character input over a structure-crossing range sends exactly one immediate notification', async ({ page }) => {
    await openEditor(page, TWO_ROWS);
    await installReceiver(page);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} tr:last-child td`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.type('X');

    expect((await readRecord(page)).kinds).toEqual(['insertText']);
  });

  test('typing over a range selected from the middle of the paragraph after a table back past its start puts the characters at the start of the paragraph, leaving no bare text right after the table', async ({ page }) => {
    await openEditor(page, `\n${TABLE}\n<p>cdef</p>\n`);
    await selectBetween(
      page,
      { selector: EDITOR_ROOT, offset: 2 },
      { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 2 },
    );

    await page.keyboard.type('X');

    // Check that the element after the table is the paragraph with the characters, and that there is no non-whitespace text directly under the editor root.
    const shape = await page.locator(EDITOR_ROOT).evaluate((root) => ({
      next: root.querySelector(':scope > table')?.nextElementSibling?.outerHTML,
      bare: [...root.childNodes].filter((node) => node instanceof Text && node.data.trim() !== '').length,
    }));
    expect(shape).toEqual({ next: '<p>Xef</p>', bare: 0 });
  });

  test('selecting all in a document starting with a table and typing turns the document into a single paragraph with only the characters', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 });

    await selectAll(page);
    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe('\n<p>X</p>\n');
  });

  test('pressing Shift+Enter over the same select-all puts a line break inside a paragraph, not a bare br', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 });

    await selectAll(page);
    await page.keyboard.press('Shift+Enter');

    expect(await readBodyHtml(page)).toBe('\n<p><br><br></p>\n');
  });

  test('in a document starting with a table, committing with the IME over a range selected from a cell with Ctrl+Shift+Home puts the characters in the paragraph created before the table', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} td`, childIndex: 0, offset: 1 });

    await page.keyboard.press('ControlOrMeta+Shift+Home');
    await composeAndCommit(page);

    expect(await readBodyHtml(page)).toBe(`\n<p>亜</p>${TABLE_THEN_PARAGRAPH}`);
  });
});

test.describe('input at a between-blocks position', () => {
  test('typing directly under the editor root right after a table (the same position as a click in the margin to its right) puts the characters in a paragraph created right after the table', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await placeCaretAt(page, { selector: EDITOR_ROOT, offset: 2 });

    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe(`\n${TABLE}\n<p>X</p>\n<p>cd</p>\n`);
  });

  test('pressing → at the end of the paragraph before a table to move right before the table and then typing puts the characters in a paragraph created right before the table', async ({ page }) => {
    await openEditor(page, `\n<p>xy</p>\n${TABLE}\n`);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 2 });

    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe(`\n<p>xy</p>\n<p>X</p>\n${TABLE}\n`);
  });

  test('in a document starting with a table, typing after Ctrl+Home creates a paragraph before the table with the characters in it', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 });

    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe(`\n<p>X</p>${TABLE_THEN_PARAGRAPH}`);
  });

  test('committing an IME composition at the position right after a table puts the characters in a paragraph created right after the table', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await placeCaretAt(page, { selector: EDITOR_ROOT, offset: 2 });

    await composeAndCommit(page);

    expect(await readBodyHtml(page)).toBe(`\n${TABLE}\n<p>亜</p>\n<p>cd</p>\n`);
  });

  test('ending a composition without committing at the position right after a table leaves no paragraph, restores the tree and sends no immediate notification', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await installReceiver(page);
    await placeCaretAt(page, { selector: EDITOR_ROOT, offset: 2 });
    const ime = await openImeSession(page);

    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    await ime.send('Input.imeSetComposition', CANCEL_COMPOSITION);

    expect([await readBodyHtml(page), (await readRecord(page)).kinds]).toEqual([TABLE_THEN_PARAGRAPH, []]);
  });

  test('pressing Shift+Enter at the position right after a table puts a line break inside a paragraph, not a bare br', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await placeCaretAt(page, { selector: EDITOR_ROOT, offset: 2 });

    await page.keyboard.press('Shift+Enter');

    expect(await readBodyHtml(page)).toBe(`\n${TABLE}\n<p><br><br></p>\n<p>cd</p>\n`);
  });

  test('pressing Enter at the position right after a table creates two empty paragraphs right after the table', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await placeCaretAt(page, { selector: EDITOR_ROOT, offset: 2 });

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe(`\n${TABLE}\n<p><br></p>\n<p><br></p>\n<p>cd</p>\n`);
  });

  test('pasting at the position right after a table puts the content in a paragraph created right after the table', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await placeCaretAt(page, { selector: EDITOR_ROOT, offset: 2 });

    await paste(page, { 'text/plain': 'XY' });

    expect(await readBodyHtml(page)).toBe(`\n${TABLE}\n<p>XY</p>\n<p>cd</p>\n`);
  });

  test('changing the block type to a heading at the position right after a table turns the paragraph created right after the table into a heading', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await placeCaretAt(page, { selector: EDITOR_ROOT, offset: 2 });

    await chooseBlockKind(page, BLOCK_KIND.heading2);

    expect(await readBodyHtml(page)).toBe(`\n${TABLE}\n<h2><br></h2>\n<p>cd</p>\n`);
  });

  test('selecting all in a document starting with a table and pressing Backspace leaves one empty paragraph', async ({ page }) => {
    await openEditor(page, TABLE_THEN_PARAGRAPH);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 1 });

    await selectAll(page);
    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<p><br></p>\n');
  });

  test('in a document starting with a table and followed by a details section, typing over a range selected from the body with Ctrl+Shift+Home puts the characters in the paragraph before the table', async ({ page }) => {
    await openEditor(page, `\n${TABLE}${OPEN_DETAILS}`);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} details > p`, childIndex: 0, offset: 2 });

    await page.keyboard.press('ControlOrMeta+Shift+Home');
    await page.keyboard.type('X');

    expect(await readBodyHtml(page))
      .toBe('\n<p>X</p>\n<details open="">\n<summary><br></summary>\n<p>dy</p>\n</details>\n');
  });
});

test.describe('rule order and document replacement', () => {
  test('a horizontal rule right before a code block is removed by Backspace at the start of code (the horizontal rule rule is tried first)', async ({ page }) => {
    await openEditor(page, '\n<hr>\n<pre><code>ab</code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<pre><code>ab</code></pre>\n');
  });

  test('pressing Backspace at the start of the first item of a list right after a table turns the item back into a paragraph (the list rule is tried first)', async ({ page }) => {
    await openEditor(page, `\n${TABLE}\n<ul>\n<li>cd</li>\n</ul>\n`);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} li`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe(`\n${TABLE}\n<p>cd</p>\n`);
  });

  test('after the document is replaced, Backspace at the start of the paragraph right after a table remains a noop', async ({ page }) => {
    await openEditor(page, '\n<p>xy</p>\n');
    await page.evaluate((text) => window.__documentReplacementProbe?.(text), `${PROLOGUE}${TABLE_THEN_PARAGRAPH}${EPILOGUE}`);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe(TABLE_THEN_PARAGRAPH);
  });
});
