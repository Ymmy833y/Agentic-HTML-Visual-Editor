import { expect, test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';

import { EDITOR_ROOT_ELEMENT_ID, VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import type { FormatOperation } from '../../webview/editing/format-command';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import {
  EDITOR_ROOT,
  focusEditor,
  openEditor,
  placeCaret,
  pressPrimaryShortcut,
  readBodyHtml,
} from './helpers/editing';
import { IDLE_ICON_COLOR, getOutboundMessages, nameIconStroke } from './helpers/page';

const BODY = '\n<p>abcd</p>\n';
const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;

/** A text position, given as which child of an element and which character within it. */
interface TextPoint {
  readonly selector: string;
  readonly childIndex: number;
  readonly offset: number;
}

/**
 * Selects the range between two positions, keeping the editor root focused.
 *
 * @param page The target page.
 * @param start The start position.
 * @param end The end position.
 */
async function selectRange(page: Page, start: TextPoint, end: TextPoint): Promise<void> {
  await page.evaluate((argument) => {
    const readText = (point: { selector: string; childIndex: number }): Node => {
      const node = document.querySelector(point.selector)?.childNodes[point.childIndex];
      if (node === undefined) {
        throw new Error(`text not found: ${point.selector}`);
      }
      return node;
    };

    const range = document.createRange();
    range.setStart(readText(argument.start), argument.start.offset);
    range.setEnd(readText(argument.end), argument.end.offset);
    document.getElementById(argument.rootId)?.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { start, end, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Selects characters inside the paragraph.
 *
 * @param page The target page.
 * @param start The start's character offset.
 * @param end The end's character offset.
 */
async function selectInParagraph(page: Page, start: number, end: number): Promise<void> {
  await selectRange(
    page,
    { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: start },
    { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: end },
  );
}

/**
 * Presses a toolbar item.
 *
 * @param page The target page.
 * @param slot The slot of the item to press.
 */
async function pressToolbarItem(page: Page, slot: string): Promise<void> {
  await page.locator(`${TOOLBAR} [data-slot="${slot}"] button`).click();
}

/**
 * Calls the entry point that runs a format operation.
 *
 * @param page The target page.
 * @param operation The format operation.
 * @returns Whether the tree was changed.
 */
async function runFormatCommand(page: Page, operation: FormatOperation): Promise<boolean> {
  return page.evaluate(
    (argument) => window.__formatCommandProbe?.(argument) ?? false,
    operation,
  );
}

/**
 * Returns how many of the messages that were sent are of the given type.
 *
 * @param page The target page.
 * @param type The message type.
 * @returns The count.
 */
async function countMessages(page: Page, type: string): Promise<number> {
  const messages = await getOutboundMessages(page);
  return messages.filter((message) => (
    typeof message === 'object' && message !== null && Reflect.get(message, 'type') === type
  )).length;
}

/** Returns the string the current selection covers. */
async function readSelectedText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

/** Opens the session used to drive the IME. */
async function openImeSession(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/** The colors given by the light, dark, and high contrast themes. */
const THEME_COLORS = [
  { background: 'rgb(255, 255, 255)', foreground: 'rgb(31, 35, 40)' },
  { background: 'rgb(31, 31, 31)', foreground: 'rgb(204, 204, 204)' },
  { background: 'rgb(0, 0, 0)', foreground: 'rgb(255, 255, 255)' },
];

/**
 * Gives the theme colors, then reads the color the bold button's icon is drawn in and the toolbar's
 * background color.
 *
 * VS Code puts the theme colors on the root element, so they are reproduced in the same place.
 *
 * @param page The target page.
 * @param colors The theme colors to give.
 * @returns The icon's stroke color and the toolbar's background color.
 */
async function readIconColors(
  page: Page,
  colors: { background: string; foreground: string },
): Promise<{ stroke: string; background: string }> {
  await page.evaluate((given) => {
    document.documentElement.style.setProperty('--vscode-editor-background', given.background);
    document.documentElement.style.setProperty('--vscode-editor-foreground', given.foreground);
  }, colors);

  const stroke = await nameIconStroke(page, await page
    .locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.bold}"] button svg`)
    .evaluate((element) => getComputedStyle(element).stroke));
  // The page background rather than the strip's, which is translucent glass.
  const background = await page
    .locator('body')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  return { stroke, background };
}

test.describe('registering the format entry points', () => {
  test('shows the five buttons in the order of the slots once mounted', async ({ page }) => {
    await openEditor(page, BODY);

    const slots = await page.evaluate((toolbarId) => [
      ...document.querySelectorAll(`#${toolbarId} [data-slot]`),
    ].map((container) => container.getAttribute('data-slot')), TOOLBAR_ELEMENT_ID);

    // The order follows the slots. This expectation grows with every feature unit that registers an item.
    expect(slots).toEqual([
      TOOLBAR_SLOT.sidebar,
      TOOLBAR_SLOT.save,
      TOOLBAR_SLOT.blockType,
      TOOLBAR_SLOT.bold,
      TOOLBAR_SLOT.italic,
      TOOLBAR_SLOT.strikethrough,
      TOOLBAR_SLOT.inlineCode,
      TOOLBAR_SLOT.codeBlock,
      TOOLBAR_SLOT.clearFormatting,
      TOOLBAR_SLOT.link,
      TOOLBAR_SLOT.image,
      TOOLBAR_SLOT.bulletList,
      TOOLBAR_SLOT.orderedList,
      TOOLBAR_SLOT.horizontalRule,
      TOOLBAR_SLOT.details,
      TOOLBAR_SLOT.table,
      TOOLBAR_SLOT.diagram,
      TOOLBAR_SLOT.comment,
      TOOLBAR_SLOT.copy,
    ]);
  });

  test('draws the icons in the theme foreground color under each of the three themes', async ({ page }) => {
    await openEditor(page, BODY);

    const drawn: { stroke: string; background: string }[] = [];
    for (const colors of THEME_COLORS) {
      drawn.push(await readIconColors(page, colors));
    }

    // Drawn in the foreground color and never matching the background means the icon can be told apart
    // under any theme.
    expect(drawn).toEqual(THEME_COLORS.map(
      (colors) => ({ stroke: IDLE_ICON_COLOR, background: colors.background }),
    ));
  });

  test('turns only the selected range into a strong when content is selected and the bold button is pressed', async ({ page }) => {
    await openEditor(page, BODY);
    await selectInParagraph(page, 1, 3);

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);

    expect(await readBodyHtml(page)).toBe('\n<p>a<strong>bc</strong>d</p>\n');
  });

  test('produces the same tree from Ctrl+B as from the button', async ({ page }) => {
    await openEditor(page, BODY);
    await selectInParagraph(page, 1, 3);

    await pressPrimaryShortcut(page, 'B');

    expect(await readBodyHtml(page)).toBe('\n<p>a<strong>bc</strong>d</p>\n');
  });

  test('creates no b, i, font, or span style from Ctrl+B and Ctrl+I', async ({ page }) => {
    await openEditor(page, BODY);
    await selectInParagraph(page, 1, 3);

    await pressPrimaryShortcut(page, 'B');
    await pressPrimaryShortcut(page, 'I');

    expect(await page.locator(`${EDITOR_ROOT} b, ${EDITOR_ROOT} i, ${EDITOR_ROOT} font, ${EDITOR_ROOT} span[style]`).count())
      .toBe(0);
  });

  test('leaves the tree unchanged for Ctrl+U, underline, which has no rule', async ({ page }) => {
    await openEditor(page, BODY);
    await selectInParagraph(page, 1, 3);

    await pressPrimaryShortcut(page, 'U');

    expect(await readBodyHtml(page)).toBe(BODY);
  });

  test('keeps Ctrl+B working after the tree is replaced, so the rules are not lost', async ({ page }) => {
    await openEditor(page, BODY);

    await page.evaluate(
      (text) => window.__documentReplacementProbe?.(text),
      `${PROLOGUE}\n<p>efgh</p>\n${EPILOGUE}`,
    );
    await selectInParagraph(page, 1, 3);
    await pressPrimaryShortcut(page, 'B');

    expect(await readBodyHtml(page)).toBe('\n<p>e<strong>fg</strong>h</p>\n');
  });

  test('shows no buttons and raises no exception for a document that cannot be opened', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await openEditor(page, '\n<script>a</script>\n');

    expect([await page.locator(TOOLBAR).count(), pageErrors]).toEqual([0, []]);
  });
});

test.describe('toggling a format', () => {
  test('returns the format state to where it was when bold is pressed twice on the same selection', async ({ page }) => {
    await openEditor(page, BODY);
    await selectInParagraph(page, 1, 3);

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);
    await pressToolbarItem(page, TOOLBAR_SLOT.bold);

    expect(await readBodyHtml(page)).toBe(BODY);
  });

  test('applies the format to the whole partly bold selection on the first press and removes it on the second', async ({ page }) => {
    await openEditor(page, '\n<p><strong>ab</strong>cd</p>\n');
    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} strong`, childIndex: 0, offset: 0 },
      { selector: `${EDITOR_ROOT} p`, childIndex: 1, offset: 2 },
    );

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);
    const afterApply = await readBodyHtml(page);
    await pressToolbarItem(page, TOOLBAR_SLOT.bold);

    expect([afterApply, await readBodyHtml(page)])
      .toEqual(['\n<p><strong>abcd</strong></p>\n', '\n<p>abcd</p>\n']);
  });

  test('removes the format without rewriting the b into a strong when bold is pressed inside a b', async ({ page }) => {
    await openEditor(page, '\n<p><b>abcd</b></p>\n');
    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} b`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} b`, childIndex: 0, offset: 3 },
    );

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);

    expect(await readBodyHtml(page)).toBe('\n<p><b>a</b>bc<b>d</b></p>\n');
  });
});

test.describe('handling structures the selection spans', () => {
  test('leaves a table, a details, and a list in their original places even when the selection spans them', async ({ page }) => {
    const body = '\n<p>ab</p>\n<table><tbody><tr><td>cd</td></tr></tbody></table>'
      + '\n<details><summary>ef</summary></details>\n<ul><li>gh</li></ul>\n<p>ij</p>\n';
    await openEditor(page, body);
    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} p:last-of-type`, childIndex: 0, offset: 1 },
    );

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);

    expect(await readBodyHtml(page)).toBe(
      '\n<p>a<strong>b</strong></p>\n<table><tbody><tr><td><strong>cd</strong></td></tr></tbody></table>'
      + '\n<details><summary><strong>ef</strong></summary></details>'
      + '\n<ul><li><strong>gh</strong></li></ul>\n<p><strong>i</strong>j</p>\n',
    );
  });

  test('leaves the code characters unchanged when bold is pressed on a selection entirely inside a pre', async ({ page }) => {
    const body = '\n<pre><code>ab</code></pre>\n';
    await openEditor(page, body);
    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 0 },
      { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 2 },
    );

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);

    expect(await readBodyHtml(page)).toBe(body);
  });

  test('does not duplicate a comment id even when the selection spans the comment', async ({ page }) => {
    await openEditor(page, '\n<p>a<comment id="c1">bc</comment>d</p>\n');
    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 0 },
      { selector: `${EDITOR_ROOT} p`, childIndex: 2, offset: 1 },
    );

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);

    expect([
      await page.locator(`${EDITOR_ROOT} comment`).count(),
      await page.locator(`${EDITOR_ROOT} comment[id="c1"]`).count(),
    ]).toEqual([1, 1]);
  });
});

test.describe('accepting and running an operation', () => {
  test('leaves the selection after the operation covering the same string as before it', async ({ page }) => {
    await openEditor(page, BODY);
    await selectInParagraph(page, 1, 3);

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);

    expect(await readSelectedText(page)).toBe('bc');
  });

  test('sends exactly one edit transaction to the host for one press of bold', async ({ page }) => {
    await openEditor(page, BODY);
    await selectInParagraph(page, 1, 3);

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);

    await expect
      .poll(() => countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction))
      .toBe(1);
  });

  test('changes no tree and sends no edit unit when bold is pressed with a bare caret', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);

    expect([
      await readBodyHtml(page),
      await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction),
      await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart),
    ]).toEqual([BODY, 0, 0]);
  });

  test('changes no tree for a Ctrl+B sent during an IME composition, and works once the composition is committed and it is pressed again', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    const ime = await openImeSession(page);

    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    await pressPrimaryShortcut(page, 'B');
    const duringComposition = await page.locator(`${EDITOR_ROOT} strong`).count();

    await ime.send('Input.insertText', { text: 'あ' });
    await selectInParagraph(page, 0, 2);
    await pressPrimaryShortcut(page, 'B');

    expect([duringComposition, await page.locator(`${EDITOR_ROOT} strong`).count()]).toEqual([0, 1]);
  });

  test('wraps a bare run directly inside the editor root in a paragraph and then applies the format', async ({ page }) => {
    await openEditor(page, 'ab');
    await selectRange(
      page,
      { selector: EDITOR_ROOT, childIndex: 0, offset: 0 },
      { selector: EDITOR_ROOT, childIndex: 0, offset: 2 },
    );

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);

    expect(await readBodyHtml(page)).toBe('\n<p><strong>ab</strong></p>');
  });

  test('changes no tree from a call to the entry point while an overlay is up', async ({ page }) => {
    await openEditor(page, BODY);
    await selectInParagraph(page, 1, 3);
    await page.evaluate((reason) => {
      window.__uiShellProbe?.()?.overlay.present(reason, { heading: '', descriptions: [], actions: [] });
    }, INPUT_STOP_REASON.saveRoundTrip);

    const changed = await runFormatCommand(page, { kind: 'toggle', format: 'bold' });

    expect([changed, await readBodyHtml(page)]).toEqual([false, BODY]);
  });
});

test.describe('links and clearing', () => {
  test('turns only the selected range into a link when a URL is given for the selection', async ({ page }) => {
    await openEditor(page, BODY);
    await selectInParagraph(page, 1, 3);

    await runFormatCommand(page, { kind: 'link', url: 'https://example.test/' });

    expect(await readBodyHtml(page))
      .toBe('\n<p>a<a href="https://example.test/">bc</a>d</p>\n');
  });

  test('removes the whole link when the caret is placed inside it and it is unlinked', async ({ page }) => {
    await openEditor(page, '\n<p>a<a href="x.html">bc</a>d</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} a`, childIndex: 0, offset: 1 });

    await runFormatCommand(page, { kind: 'unlink' });

    expect(await readBodyHtml(page)).toBe('\n<p>abcd</p>\n');
  });

  test('removes the four formats and keeps the link when clear formatting is pressed on a selection mixing bold and italic', async ({ page }) => {
    await openEditor(page, '\n<p><strong>a</strong><em>b</em><a href="x.html">c</a></p>\n');
    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} strong`, childIndex: 0, offset: 0 },
      { selector: `${EDITOR_ROOT} a`, childIndex: 0, offset: 1 },
    );

    await pressToolbarItem(page, TOOLBAR_SLOT.clearFormatting);

    expect(await readBodyHtml(page)).toBe('\n<p>ab<a href="x.html">c</a></p>\n');
  });
});

test.describe('format element normalization and the output', () => {
  test('leaves no adjacent elements of the same spelling and no empty format element after applying to an adjoining format', async ({ page }) => {
    await openEditor(page, BODY);
    await selectInParagraph(page, 0, 2);
    await pressToolbarItem(page, TOOLBAR_SLOT.bold);

    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} p`, childIndex: 1, offset: 0 },
      { selector: `${EDITOR_ROOT} p`, childIndex: 1, offset: 2 },
    );
    await pressToolbarItem(page, TOOLBAR_SLOT.bold);

    expect(await readBodyHtml(page)).toBe('\n<p><strong>abcd</strong></p>\n');
  });

  test('returns the output to the same shape as the input when content whose format was applied and removed is saved', async ({ page }) => {
    await openEditor(page, BODY);
    await selectInParagraph(page, 1, 3);

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);
    await pressToolbarItem(page, TOOLBAR_SLOT.bold);

    expect(await page.evaluate(() => window.__serializationProbe?.()?.current)).toBe(BODY);
  });
});

test.describe('typing under a pending format', () => {
  test('wraps the character typed after pressing bold at a bare caret, keeps the next character in the same element, and sends one edit unit', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);
    await page.keyboard.type('xy');

    await expect
      .poll(() => countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction))
      .toBe(1);
    expect(await readBodyHtml(page)).toBe('\n<p>ab<strong>xy</strong>cd</p>\n');
  });

  test('puts the character typed after Ctrl+B inside bold outside the element, splitting it', async ({ page }) => {
    await openEditor(page, '\n<p><strong>abcd</strong></p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} strong`, childIndex: 0, offset: 2 });

    await pressPrimaryShortcut(page, 'B');
    await page.keyboard.type('x');

    expect(await readBodyHtml(page)).toBe('\n<p><strong>ab</strong>x<strong>cd</strong></p>\n');
  });

  test('gives no format to the character typed after the caret was moved with an arrow key', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('x');

    expect(await readBodyHtml(page)).toBe('\n<p>abcxd</p>\n');
  });

  test('gives no format after bold is pressed twice, nor after Enter is pressed in between', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 4 });

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);
    await pressToolbarItem(page, TOOLBAR_SLOT.bold);
    await page.keyboard.type('x');
    await pressToolbarItem(page, TOOLBAR_SLOT.bold);
    await page.keyboard.press('Enter');
    await page.keyboard.type('y');

    expect(await readBodyHtml(page)).toBe('\n<p>abcdx</p>\n<p>y</p>\n');
  });

  test('puts the committed composition inside bold with no placeholder left, and returns the tree when the composition is cancelled', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    const ime = await openImeSession(page);

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);
    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    await ime.send('Input.insertText', { text: 'あ' });
    const committed = await readBodyHtml(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 });
    await pressToolbarItem(page, TOOLBAR_SLOT.italic);
    await ime.send('Input.imeSetComposition', { text: 'い', selectionStart: 1, selectionEnd: 1 });
    await ime.send('Input.imeSetComposition', { text: '', selectionStart: -1, selectionEnd: -1 });

    expect([committed, await readBodyHtml(page)]).toEqual([
      '\n<p>ab<strong>あ</strong>cd</p>\n',
      '\n<p>ab<strong>あ</strong>cd</p>\n',
    ]);
  });

  test('wraps the character typed just after a comment in bold outside the comment', async ({ page }) => {
    await openEditor(page, '\n<p>a<comment id="c1">bc<comment-body>n</comment-body></comment>d</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 2, offset: 0 });

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);
    await page.keyboard.type('x');

    expect(await page.evaluate(() => window.__serializationProbe?.()?.body))
      .toBe('\n<p>a<comment id="c1">bc<comment-body>n</comment-body></comment><strong>x</strong>d</p>\n');
  });
});

test.describe('typing under a pending format into a materialized paragraph', () => {
  test('wraps the first character typed into an empty body in bold inside the created paragraph', async ({ page }) => {
    await openEditor(page, '');
    await focusEditor(page);

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);
    await page.keyboard.type('x');

    expect(await readBodyHtml(page)).toBe('\n<p><strong>x</strong></p>');
  });

  test('wraps the character typed right before a table in bold inside the paragraph created there', async ({ page }) => {
    const table = '<table><tbody><tr><td>cd</td></tr></tbody></table>';
    await openEditor(page, `\n<p>ab</p>\n${table}\n`);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    // Right at the end of the paragraph puts the caret directly under the editor root, right before the table.
    await page.keyboard.press('ArrowRight');

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);
    await page.keyboard.type('x');

    expect(await readBodyHtml(page)).toBe(`\n<p>ab</p>\n<p><strong>x</strong></p>\n${table}\n`);
  });
});

test.describe('moving the caret into another block under a pending format', () => {
  test('gives no format to the character typed after Right moves the caret from the end of one paragraph to the start of the next', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<p>cd</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('x');

    expect(await readBodyHtml(page)).toBe('\n<p>ab</p>\n<p>xcd</p>\n');
  });

  test('gives no format to the character typed after Right moves the caret from right before a table into its first cell', async ({ page }) => {
    const table = '<table><tbody><tr><td>cd</td></tr></tbody></table>';
    await openEditor(page, `\n<p>ab</p>\n${table}\n`);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    // Right at the end of the paragraph puts the caret directly under the editor root, right before the table.
    await page.keyboard.press('ArrowRight');

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('x');

    expect(await readBodyHtml(page)).toBe('\n<p>ab</p>\n<table><tbody><tr><td>xcd</td></tr></tbody></table>\n');
  });
});

test.describe('moving the caret past an element with no text under a pending format', () => {
  test('gives no format to the character typed after Right moves the caret from right before a horizontal rule to right after it', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<hr>\n<p>cd</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    // Right at the end of the paragraph puts the caret directly under the editor root, right before the rule.
    await page.keyboard.press('ArrowRight');

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('x');

    expect(await readBodyHtml(page)).toBe('\n<p>ab</p>\n<hr>\n<p>x</p>\n<p>cd</p>\n');
  });

  test('gives no format to the character typed after a click moves the caret from the end of a bare run to the start of the run after a horizontal rule', async ({ page }) => {
    await openEditor(page, 'ab<hr>cd');
    await focusEditor(page);
    await placeCaret(page, { selector: EDITOR_ROOT, childIndex: 0, offset: 2 });

    await pressToolbarItem(page, TOOLBAR_SLOT.bold);
    const start = await page.evaluate((selector) => {
      const text = document.querySelector(selector)?.childNodes[2];
      if (text === undefined) {
        throw new Error('Run after the rule not found');
      }
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    }, EDITOR_ROOT);
    // A click at the start of the next run lands in its text at the same text position as the end of the first run.
    await page.mouse.click(start.x, start.y);
    await page.keyboard.type('x');

    expect(await readBodyHtml(page)).toBe('ab<hr>xcd');
  });
});
