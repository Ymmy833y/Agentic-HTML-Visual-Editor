import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { EDITOR_ROOT_ELEMENT_ID, VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import { ORDERED_LIST_DIGIT_PATHS } from '../../webview/ui/list-buttons';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import {
  EDITOR_ROOT,
  deleteWordBackward,
  focusEditor,
  openEditor,
  placeCaret,
  readBodyHtml,
  selectAll,
} from './helpers/editing';
import { IDLE_ICON_COLOR, getOutboundMessages, nameIconStroke } from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;

/** The 2 list slots. */
const LIST_SLOTS = [TOOLBAR_SLOT.bulletList, TOOLBAR_SLOT.orderedList];

/** The colours given by the light, dark and high-contrast themes. */
const THEME_COLORS = [
  { background: 'rgb(255, 255, 255)', foreground: 'rgb(31, 35, 40)' },
  { background: 'rgb(31, 31, 31)', foreground: 'rgb(204, 204, 204)' },
  { background: 'rgb(0, 0, 0)', foreground: 'rgb(255, 255, 255)' },
];

declare global {
  interface Window {
    /** The forwarded key record: the codes of keydown events that reached the window's bubbling phase, in arrival order. */
    __forwardedKeys?: string[];
  }
}

/** A position in text: which child of which element, and at which character. */
interface TextPoint {
  readonly selector: string;
  readonly childIndex: number;
  readonly offset: number;
}

/**
 * Moves focus to the editor root and places the caret in the text that is the first child of an element.
 *
 * @param page The page to operate on.
 * @param selector The selector of the element holding the text.
 * @param offset The offset within the text.
 */
async function placeCaretInText(page: Page, selector: string, offset: number): Promise<void> {
  await focusEditor(page);
  await placeCaret(page, { selector, childIndex: 0, offset });
}

/**
 * Moves focus to the editor root and places the caret at the start of an element without children.
 *
 * @param page The page to operate on.
 * @param selector The selector of the element.
 */
async function placeCaretAtElementStart(page: Page, selector: string): Promise<void> {
  await focusEditor(page);
  await page.evaluate((target) => {
    const element = document.querySelector(target);
    if (element === null) {
      throw new Error(`element not found: ${target}`);
    }
    const range = document.createRange();
    range.setStart(element, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, selector);
}

/**
 * Selects between two positions. Focus is put on the editor root.
 *
 * @param page The page to operate on.
 * @param start The start point.
 * @param end The end point.
 */
async function selectRange(page: Page, start: TextPoint, end: TextPoint): Promise<void> {
  await page.evaluate((argument) => {
    const readNode = (point: { selector: string; childIndex: number }): Node => {
      const node = document.querySelector(point.selector)?.childNodes[point.childIndex];
      if (node === undefined) {
        throw new Error(`text not found: ${point.selector}`);
      }
      return node;
    };

    const range = document.createRange();
    range.setStart(readNode(argument.start), argument.start.offset);
    range.setEnd(readNode(argument.end), argument.end.offset);
    document.getElementById(argument.rootId)?.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { start, end, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Presses a toolbar item.
 *
 * @param page The page to operate on.
 * @param slot The slot of the item to press.
 */
async function pressToolbarItem(page: Page, slot: string): Promise<void> {
  await page.locator(`${TOOLBAR} [data-slot="${slot}"] > button`).click();
}

/**
 * Reads the pressed state of a toolbar item.
 *
 * @param page The page to operate on.
 * @param slot The slot of the item to read.
 * @returns The value of `aria-pressed`, or `null` when the attribute is absent.
 */
async function readPressed(page: Page, slot: string): Promise<string | null> {
  return page.locator(`${TOOLBAR} [data-slot="${slot}"] > button`).getAttribute('aria-pressed');
}

/**
 * Waits for the coalescing wait (one frame) of the caret follow to end.
 *
 * @param page The page to operate on.
 */
async function settleFollow(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

/**
 * Reads the caret position as the text of its node and the offset.
 *
 * @param page The page to operate on.
 * @returns The text of the node holding the caret, and the offset within it.
 */
async function readCaret(page: Page): Promise<[string | null, number]> {
  return page.evaluate((): [string | null, number] => {
    const selection = window.getSelection();
    return [selection?.anchorNode?.textContent ?? null, selection?.anchorOffset ?? -1];
  });
}

/**
 * Determines whether the caret is inside an element.
 *
 * @param page The page to operate on.
 * @param selector The selector of the element.
 * @returns `true` when inside.
 */
async function isCaretInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((target) => {
    const anchor = window.getSelection()?.anchorNode ?? null;
    const element = document.querySelector(target);
    return anchor !== null && element !== null && element.contains(anchor);
  }, selector);
}

/**
 * Returns how many of the sent messages are of the given type.
 *
 * @param page The page to operate on.
 * @param type The message type.
 * @returns The count.
 */
async function countMessages(page: Page, type: string): Promise<number> {
  const messages = await getOutboundMessages(page);
  return messages.filter((message) => (
    typeof message === 'object' && message !== null && Reflect.get(message, 'type') === type
  )).length;
}

/**
 * Starts recording the codes of keydown events that reach the window's bubbling phase, mimicking VS Code's
 * forwarding.
 *
 * @param page The page to operate on.
 */
async function installForwardRecord(page: Page): Promise<void> {
  await page.evaluate(() => {
    const record: string[] = [];
    window.__forwardedKeys = record;
    window.addEventListener('keydown', (event) => record.push(event.code));
  });
}

/**
 * Reads the forwarded key record.
 *
 * @param page The page to operate on.
 * @returns The codes of the keydown events that arrived, in arrival order.
 */
async function readForwardedKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__forwardedKeys ?? []);
}

/**
 * Calls the replace document entry point to swap the body.
 *
 * @param page The page to operate on.
 * @param body The new body.
 */
async function replaceBody(page: Page, body: string): Promise<void> {
  await page.evaluate((text) => window.__documentReplacementProbe?.(text), `${PROLOGUE}${body}${EPILOGUE}`);
}

/**
 * Applies theme colours, then reads the colour the 2 icons are drawn in and the toolbar background colour.
 *
 * VS Code puts the theme colours on the root element, so they are reproduced in the same place.
 *
 * @param page The page to operate on.
 * @param colors The theme colours to apply.
 * @returns The stroke colours of the icons and the toolbar background colour.
 */
async function readIconColors(
  page: Page,
  colors: { background: string; foreground: string },
): Promise<{ strokes: string[]; background: string }> {
  await page.evaluate((given) => {
    document.documentElement.style.setProperty('--vscode-editor-background', given.background);
    document.documentElement.style.setProperty('--vscode-editor-foreground', given.foreground);
  }, colors);

  const strokes: string[] = [];
  for (const slot of LIST_SLOTS) {
    strokes.push(await nameIconStroke(page, await page
      .locator(`${TOOLBAR} [data-slot="${slot}"] button svg`)
      .evaluate((element) => getComputedStyle(element).stroke)));
  }
  // The page background rather than the strip's, which is translucent glass.
  const background = await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor);
  return { strokes, background };
}

/** The bounds of a path, in view box units. */
interface PathBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Draws each path on its own in a scratch `svg` and reads its bounds.
 *
 * An icon draws all of its parts as one path, so a part cannot be measured from the icon drawn in the toolbar.
 *
 * @param page The page to operate on.
 * @param paths The paths to measure.
 * @returns The bounds of each path, in the order given.
 */
async function readPathBounds(page: Page, paths: readonly string[]): Promise<PathBounds[]> {
  return page.evaluate((given) => given.map((data) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', data);
    svg.append(path);
    // Bounds are only computed for a path that is in the document.
    document.body.append(svg);
    const { x, y, width, height } = path.getBBox();
    svg.remove();
    return { x, y, width, height };
  }), paths);
}

test.describe('registering the entry points', () => {
  test('after mounting, the bulleted list and numbered list items appear between clear formatting and horizontal rule, in slot order', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');

    const slots = await page.locator(`${TOOLBAR} [data-slot]`)
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-slot')));

    expect(slots.slice(slots.indexOf(TOOLBAR_SLOT.clearFormatting), slots.indexOf(TOOLBAR_SLOT.horizontalRule) + 1))
      .toEqual([
        TOOLBAR_SLOT.clearFormatting,
        TOOLBAR_SLOT.link,
        TOOLBAR_SLOT.image,
        TOOLBAR_SLOT.bulletList,
        TOOLBAR_SLOT.orderedList,
        TOOLBAR_SLOT.horizontalRule,
      ]);
  });

  test('in each of the light, dark and high-contrast themes, the 2 icons are drawn in the idle icon colour, a softened foreground that differs from the background', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');

    const drawn: { strokes: string[]; background: string }[] = [];
    for (const colors of THEME_COLORS) {
      drawn.push(await readIconColors(page, colors));
    }

    expect(drawn).toEqual(THEME_COLORS.map((colors) => ({
      strokes: LIST_SLOTS.map(() => IDLE_ICON_COLOR),
      background: colors.background,
    })));
  });

  test('each digit of the numbered list icon sits at the top of its own row, leaving a gap before the next digit', async ({ page }) => {
    const digits = await readPathBounds(page, ORDERED_LIST_DIGIT_PATHS);

    // The lines lie 6 apart at 6, 12 and 18, so each row is 6 tall. A digit 3.5 tall is drawn 5 tall with the 1.5 wide
    // stroke; at the top of its row it leaves a gap of 1, which falls on a whole pixel row at 100% scale.
    expect(digits.map((digit) => [digit.y, digit.y + digit.height])).toEqual([
      [expect.closeTo(3.75, 3), expect.closeTo(7.25, 3)],
      [expect.closeTo(9.75, 3), expect.closeTo(13.25, 3)],
      [expect.closeTo(15.75, 3), expect.closeTo(19.25, 3)],
    ]);
  });

  test('an unopenable document shows neither item and raises no exception', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await openEditor(page, '\n<script>a</script>\n');

    expect([await page.locator(TOOLBAR).count(), pageErrors]).toEqual([0, []]);
  });
});

test.describe('creating, unwrapping and switching lists', () => {
  test('pressing bulleted list with the caret in a paragraph turns the paragraph into a ul item, and the caret stays before the same character', async ({ page }) => {
    await openEditor(page, '\n<p>abcd</p>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);

    await pressToolbarItem(page, TOOLBAR_SLOT.bulletList);

    expect([await readBodyHtml(page), await readCaret(page)]).toEqual(['\n<ul><li>abcd</li></ul>\n', ['abcd', 2]]);
  });

  test('pressing bulleted list in a bulleted list item turns the item back into a paragraph', async ({ page }) => {
    await openEditor(page, '\n<ul><li>abcd</li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li`, 2);

    await pressToolbarItem(page, TOOLBAR_SLOT.bulletList);

    expect(await readBodyHtml(page)).toBe('\n<p>abcd</p>\n');
  });

  test('turning the only item of a list with bare text directly under it back into a paragraph keeps the text in the body, wrapped in a paragraph', async ({ page }) => {
    await openEditor(page, '\n<ul>intro<li>abcd</li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li`, 2);

    await pressToolbarItem(page, TOOLBAR_SLOT.bulletList);

    expect(await readBodyHtml(page)).toBe('\n<p>intro</p>\n<p>abcd</p>\n');
  });

  test('pressing numbered list in a bulleted list item turns the whole list into an ol, leaving the nested list as a ul', async ({ page }) => {
    await openEditor(page, '\n<ul>\n<li>a<ul><li>b</li></ul></li>\n<li>c</li>\n</ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} > ul > li:last-child`, 1);

    await pressToolbarItem(page, TOOLBAR_SLOT.orderedList);

    expect(await readBodyHtml(page)).toBe('\n<ol>\n<li>a<ul><li>b</li></ul></li>\n<li>c</li>\n</ol>\n');
  });

  test('selecting all in a bulleted list with a nested list and pressing numbered list turns the nested list into an ol as well', async ({ page }) => {
    await openEditor(page, '\n<ul>\n<li>a<ul><li>b</li></ul></li>\n<li>c</li>\n</ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li`, 0);

    await selectAll(page);
    await pressToolbarItem(page, TOOLBAR_SLOT.orderedList);

    expect(await readBodyHtml(page)).toBe('\n<ol>\n<li>a<ol><li>b</li></ol></li>\n<li>c</li>\n</ol>\n');
  });

  test('pressing bulleted list right after opening an empty file, without clicking the body, materializes a paragraph and turns it into an item', async ({ page }) => {
    await openEditor(page, '');

    await pressToolbarItem(page, TOOLBAR_SLOT.bulletList);

    expect(await readBodyHtml(page)).toBe('\n<ul><li><br></li></ul>');
  });

  test('pressing bulleted list with a selection spanning paragraph, table and paragraph turns each paragraph into an item, leaving the table where it was', async ({ page }) => {
    const table = '<table><tbody><tr><td>cd</td></tr></tbody></table>';
    await openEditor(page, `\n<p>ab</p>\n${table}\n<p>ef</p>\n`);
    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} p:last-of-type`, childIndex: 0, offset: 1 },
    );

    await pressToolbarItem(page, TOOLBAR_SLOT.bulletList);

    expect(await readBodyHtml(page)).toBe(`\n<ul><li>ab</li></ul>\n${table}\n<ul><li>ef</li></ul>\n`);
  });

  test('pressing bulleted list with a selection including bare text directly under the editor root wraps it in a paragraph and then turns it into an item', async ({ page }) => {
    await openEditor(page, 'ab');
    await selectRange(
      page,
      { selector: EDITOR_ROOT, childIndex: 0, offset: 0 },
      { selector: EDITOR_ROOT, childIndex: 0, offset: 2 },
    );

    await pressToolbarItem(page, TOOLBAR_SLOT.bulletList);

    expect(await readBodyHtml(page)).toBe('\n<ul><li>ab</li></ul>');
  });

  test('after selecting several paragraphs and pressing bulleted list, the selection still covers the same text as before the operation', async ({ page }) => {
    await openEditor(page, '\n<p>abc</p>\n<p>def</p>\n');
    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} p:last-of-type`, childIndex: 0, offset: 2 },
    );

    await pressToolbarItem(page, TOOLBAR_SLOT.bulletList);

    expect(await page.evaluate(() => {
      const range = window.getSelection()?.getRangeAt(0);
      return [range?.startContainer.textContent, range?.startOffset, range?.endContainer.textContent, range?.endOffset];
    })).toEqual(['abc', 1, 'def', 2]);
  });

  test('pressing numbered list in a paragraph right after a numbered list makes it the last item of the existing list, continuing the numbering', async ({ page }) => {
    await openEditor(page, '\n<ol start="3">\n<li>a</li>\n</ol>\n<p>b</p>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 1);

    await pressToolbarItem(page, TOOLBAR_SLOT.orderedList);

    expect(await readBodyHtml(page)).toBe('\n<ol start="3">\n<li>a</li>\n<li>b</li>\n</ol>\n');
  });

  test('turning a paragraph between two lists of the same kind into an item merges all three into one list', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a</li></ul>\n<p>b</p>\n<ul><li>c</li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 1);

    await pressToolbarItem(page, TOOLBAR_SLOT.bulletList);

    expect(await readBodyHtml(page)).toBe('\n<ul><li>a</li>\n<li>b</li>\n<li>c</li></ul>\n');
  });

  test('a list is not merged even when switching its kind leaves it next to a list of the same kind', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a</li></ul>\n<ol><li>b</li></ol>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li`, 1);

    await pressToolbarItem(page, TOOLBAR_SLOT.orderedList);

    expect(await readBodyHtml(page)).toBe('\n<ol><li>a</li></ol>\n<ol><li>b</li></ol>\n');
  });

  test('pressing numbered list in a middle item of a numbered list puts a paragraph in between, and the tail continues the numbering', async ({ page }) => {
    await openEditor(page, '\n<ol>\n<li>a</li>\n<li>b</li>\n<li>c</li>\n</ol>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li:nth-child(2)`, 1);

    await pressToolbarItem(page, TOOLBAR_SLOT.orderedList);

    expect(await readBodyHtml(page))
      .toBe('\n<ol>\n<li>a</li>\n</ol>\n<p>b</p>\n<ol start="2">\n<li>c</li></ol>\n');
  });

  test('pressing bulleted list with a selection spanning 2 of 3 items turns only the selected items back into paragraphs', async ({ page }) => {
    await openEditor(page, '\n<ul>\n<li>a</li>\n<li>b</li>\n<li>c</li>\n</ul>\n');
    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} li`, childIndex: 0, offset: 0 },
      { selector: `${EDITOR_ROOT} li:nth-child(2)`, childIndex: 0, offset: 1 },
    );

    await pressToolbarItem(page, TOOLBAR_SLOT.bulletList);

    expect(await readBodyHtml(page)).toBe('\n\n<p>a</p>\n<p>b</p>\n<ul>\n<li>c</li>\n</ul>\n');
  });

  test('pressing bulleted list once sends exactly one edit unit pair to the host', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 1);

    await pressToolbarItem(page, TOOLBAR_SLOT.bulletList);

    await expect.poll(() => countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).toBe(1);
  });

  test('pressing bulleted list while an overlay is up leaves the tree unchanged', async ({ page }) => {
    const body = '\n<p>ab</p>\n';
    await openEditor(page, body);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 1);
    await page.evaluate((reason) => {
      window.__uiShellProbe?.()?.overlay.present(reason, { heading: '', descriptions: [], actions: [] });
    }, INPUT_STOP_REASON.saveRoundTrip);

    await page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.bulletList}"] > button`).dispatchEvent('click');

    expect(await readBodyHtml(page)).toBe(body);
  });

  test('pressing bulleted list in a paragraph in a cell inside an item leaves the outer list alone and creates a new list inside the cell', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a<table><tbody><tr><td><p>c</p></td></tr></tbody></table></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} td p`, 1);

    await pressToolbarItem(page, TOOLBAR_SLOT.bulletList);

    expect(await readBodyHtml(page))
      .toBe('\n<ul><li>a<table><tbody><tr><td><ul><li>c</li></ul></td></tr></tbody></table></li></ul>\n');
  });

  test('turning a paragraph into a bulleted list and back makes the saved body the same as the original body', async ({ page }) => {
    const body = '\n<p>abcd</p>\n';
    await openEditor(page, body);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);

    await pressToolbarItem(page, TOOLBAR_SLOT.bulletList);
    await pressToolbarItem(page, TOOLBAR_SLOT.bulletList);

    expect(await page.evaluate(() => window.__serializationProbe?.()?.current)).toBe(body);
  });
});

test.describe('indenting and outdenting with Tab and Shift+Tab', () => {
  test('pressing Tab in the second item makes it an item of the previous item\'s nested list', async ({ page }) => {
    await openEditor(page, '\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li:nth-child(2)`, 1);

    await page.keyboard.press('Tab');

    expect(await readBodyHtml(page)).toBe('\n<ul>\n<li>a\n<ul>\n<li>b</li></ul></li>\n</ul>\n');
  });

  test('pressing Shift+Tab in a nested item makes it an item of the list one level out', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a<ul><li>b</li></ul></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li li`, 1);

    await page.keyboard.press('Shift+Tab');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>a</li>\n<li>b</li></ul>\n');
  });

  test('pressing Shift+Tab in a top-level middle item turns it into a paragraph and splits the list around it', async ({ page }) => {
    await openEditor(page, '\n<ul>\n<li>a</li>\n<li>b</li>\n<li>c</li>\n</ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li:nth-child(2)`, 1);

    await page.keyboard.press('Shift+Tab');

    expect(await readBodyHtml(page)).toBe('\n<ul>\n<li>a</li>\n</ul>\n<p>b</p>\n<ul>\n<li>c</li></ul>\n');
  });

  test('pressing Tab in the first item changes neither the tree nor the focus, and the key does not reach the forwarded key record', async ({ page }) => {
    const body = '\n<ul><li>a</li><li>b</li></ul>\n';
    await openEditor(page, body);
    await placeCaretInText(page, `${EDITOR_ROOT} li`, 1);
    await installForwardRecord(page);

    await page.keyboard.press('Tab');

    expect([
      await readBodyHtml(page),
      await page.evaluate(() => document.activeElement?.id),
      (await readForwardedKeys(page)).includes('Tab'),
    ]).toEqual([body, EDITOR_ROOT_ELEMENT_ID, false]);
  });

  test('pressing Tab in a paragraph outside the list leaves the paragraph and the list unchanged, and the key does not reach the forwarded key record', async ({ page }) => {
    const body = '\n<p>a</p>\n<ul><li>b</li></ul>\n';
    await openEditor(page, body);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 1);
    await installForwardRecord(page);

    await page.keyboard.press('Tab');

    expect([await readBodyHtml(page), (await readForwardedKeys(page)).includes('Tab')]).toEqual([body, false]);
  });

  test('pressing Tab in a cell inside an item leaves the list unchanged', async ({ page }) => {
    // Tab in the last cell adds a row to the table, so press it where a next cell exists and check that the
    // tree does not change.
    const body = '\n<ul><li>a</li><li>b<table><tbody><tr><td>c</td><td>d</td></tr></tbody></table></li></ul>\n';
    await openEditor(page, body);
    await placeCaretInText(page, `${EDITOR_ROOT} td`, 1);

    await page.keyboard.press('Tab');

    expect(await readBodyHtml(page)).toBe(body);
  });

  test('pressing Tab in the second item of a list inside a cell nests it', async ({ page }) => {
    await openEditor(page, '\n<table><tbody><tr><td><ul><li>a</li><li>b</li></ul></td></tr></tbody></table>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li:nth-child(2)`, 1);

    await page.keyboard.press('Tab');

    expect(await readBodyHtml(page))
      .toBe('\n<table><tbody><tr><td><ul><li>a\n<ul><li>b</li></ul></li></ul></td></tr></tbody></table>\n');
  });

  test('pressing Tab with a selection spanning the last 2 of 3 items nests both together', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a</li><li>b</li><li>c</li></ul>\n');
    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} li:nth-child(2)`, childIndex: 0, offset: 0 },
      { selector: `${EDITOR_ROOT} li:nth-child(3)`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('Tab');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>a\n<ul><li>b</li>\n<li>c</li></ul></li></ul>\n');
  });

  test('pressing Shift+Tab in the first item of a nested list moves the following items into its nested list, keeping their visual level', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a<ul><li>b</li><li>c</li></ul></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li li`, 1);

    await page.keyboard.press('Shift+Tab');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>a</li>\n<li>b\n<ul><li>c</li></ul></li></ul>\n');
  });

  test('keeps document order after Shift+Tab when the parent item has a paragraph after the nested list', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a<ul><li>b</li></ul><p>p</p></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li li`, 1);

    await page.keyboard.press('Shift+Tab');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>a</li>\n<li>b\n<p>p</p></li></ul>\n');
  });

  test('keeps bare text after the nested list in the parent item after the placed item following Shift+Tab', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a<ul><li>b</li></ul>note</li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li li`, 1);

    await page.keyboard.press('Shift+Tab');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>a</li>\n<li>b\n<p>note</p></li></ul>\n');
  });
});

test.describe('Enter in list items', () => {
  test('pressing Enter in an empty nested item makes it an item of the list one level out', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a<ul><li><br></li></ul></li></ul>\n');
    await placeCaretAtElementStart(page, `${EDITOR_ROOT} li li`);

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>a</li>\n<li><br></li></ul>\n');
  });

  test('pressing Enter in an empty top-level item turns it into a paragraph, and the caret stays in that paragraph', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a</li><li><br></li></ul>\n');
    await placeCaretAtElementStart(page, `${EDITOR_ROOT} li:nth-child(2)`);

    await page.keyboard.press('Enter');

    expect([await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} p`)])
      .toEqual(['\n<ul><li>a</li></ul>\n<p><br></p>\n', true]);
  });

  test('pressing Enter twice in the last empty nested item leaves the top level and becomes a paragraph', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a<ul><li>b</li><li><br></li></ul></li></ul>\n');
    await placeCaretAtElementStart(page, `${EDITOR_ROOT} li li:nth-child(2)`);

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>a<ul><li>b</li></ul></li></ul>\n<p><br></p>\n');
  });

  test('pressing Enter at the end of the line of an item with a nested list creates an empty item at the start of the nested list', async ({ page }) => {
    await openEditor(page, '\n<ul><li>ab<ul><li>c</li></ul></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li`, 2);

    await page.keyboard.press('Enter');

    expect([await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} li li:first-of-type`)])
      .toEqual(['\n<ul><li>ab<ul>\n<li><br></li>\n<li>c</li></ul></li></ul>\n', true]);
  });

  test('pressing Enter in the middle of the line of an item with a nested list moves the following text and the nested list to a new item', async ({ page }) => {
    await openEditor(page, '\n<ul><li>ab<ul><li>c</li></ul></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li`, 1);

    await page.keyboard.press('Enter');

    expect([await readBodyHtml(page), await readCaret(page)])
      .toEqual(['\n<ul><li>a</li>\n<li>b<ul><li>c</li></ul></li></ul>\n', ['b', 0]]);
  });

  test('pressing Enter at the start of the line of an item with a nested list creates an empty item right before, and the caret stays in the original item', async ({ page }) => {
    await openEditor(page, '\n<ul><li>ab<ul><li>c</li></ul></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li`, 0);

    await page.keyboard.press('Enter');

    expect([await readBodyHtml(page), await readCaret(page)])
      .toEqual(['\n<ul>\n<li><br></li>\n<li>ab<ul><li>c</li></ul></li></ul>\n', ['ab', 0]]);
  });

  test('pressing Enter in the trailing empty paragraph of an item removes the paragraph and creates the next item', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a<ul><li>b</li></ul>\n<p><br></p></li></ul>\n');
    await placeCaretAtElementStart(page, `${EDITOR_ROOT} p`);

    await page.keyboard.press('Enter');

    expect([await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} > ul > li:last-child`)])
      .toEqual(['\n<ul><li>a<ul><li>b</li></ul></li>\n<li><br></li></ul>\n', true]);
  });

  test('pressing Enter at the end of an item whose line is a paragraph creates the next item, whose line is also a paragraph', async ({ page }) => {
    await openEditor(page, '\n<ul><li><p>ab</p></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<ul><li><p>ab</p></li>\n<li><p><br></p></li></ul>\n');
  });

  test('pressing Enter in an empty item whose line is a paragraph leaves the list and becomes a paragraph', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a</li><li><p><br></p></li></ul>\n');
    await placeCaretAtElementStart(page, `${EDITOR_ROOT} p`);

    await page.keyboard.press('Enter');

    expect([await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} > p`)])
      .toEqual(['\n<ul><li>a</li></ul>\n<p><br></p>\n', true]);
  });

  test('selecting from the line of an item with a nested list into a nested item and pressing Enter deletes the range and splits the item', async ({ page }) => {
    await openEditor(page, '\n<ul><li>abc<ul><li>def</li></ul></li></ul>\n');
    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} li`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} li li`, childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>a<ul>\n<li><br></li>\n<li>ef</li></ul></li></ul>\n');
  });

  test('pressing Enter in the middle of an inline-only item splits it into two items', async ({ page }) => {
    await openEditor(page, '\n<ul><li>ab</li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li`, 1);

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>a</li>\n<li>b</li></ul>\n');
  });

  test('pressing Shift+Enter on the line of an item with a nested list inserts a line break within the block without splitting', async ({ page }) => {
    await openEditor(page, '\n<ul><li>ab<ul><li>c</li></ul></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li`, 1);

    await page.keyboard.press('Shift+Enter');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>a<br>b<ul><li>c</li></ul></li></ul>\n');
  });

  test('pressing Enter in an empty item delivers exactly one settled edit unit to the host', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a</li><li><br></li></ul>\n');
    await placeCaretAtElementStart(page, `${EDITOR_ROOT} li:nth-child(2)`);

    await page.keyboard.press('Enter');

    await expect.poll(() => countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).toBe(1);
  });

  test('Enter in an empty item still leaves the list after the document is replaced', async ({ page }) => {
    await openEditor(page, '\n<p>x</p>\n');
    await replaceBody(page, '\n<ul><li>a</li><li><br></li></ul>\n');
    await placeCaretAtElementStart(page, `${EDITOR_ROOT} li:nth-child(2)`);

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>a</li></ul>\n<p><br></p>\n');
  });
});

test.describe('backward delete at the start of the first item', () => {
  test('pressing Backspace at the start of the first item turns it into a paragraph, and the caret stays before the same character', async ({ page }) => {
    await openEditor(page, '\n<ul><li>ab</li><li>cd</li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li`, 0);

    await page.keyboard.press('Backspace');

    expect([await readBodyHtml(page), await readCaret(page)])
      .toEqual(['\n\n<p>ab</p>\n<ul><li>cd</li></ul>\n', ['ab', 0]]);
  });

  test('pressing Backspace at the start of the first item of a nested list makes it an item of the list one level out', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a<ul><li>b</li></ul></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li li`, 0);

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>a</li>\n<li>b</li></ul>\n');
  });

  test('pressing Backspace twice in an empty first item turns it into an empty paragraph, then merges it into the end of the previous paragraph', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<ul><li><br></li></ul>\n');
    await placeCaretAtElementStart(page, `${EDITOR_ROOT} li`);

    await page.keyboard.press('Backspace');
    const afterFirst = await readBodyHtml(page);
    await page.keyboard.press('Backspace');

    expect([afterFirst, await readBodyHtml(page)]).toEqual(['\n<p>ab</p>\n<p><br></p>\n', '\n<p>ab</p>\n']);
  });

  test('a word-wise backward delete at the start of the first item turns it into a paragraph, just like a character-wise one', async ({ page }) => {
    await openEditor(page, '\n<ul><li>ab</li><li>cd</li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li`, 0);

    await deleteWordBackward(page);

    expect(await readBodyHtml(page)).toBe('\n\n<p>ab</p>\n<ul><li>cd</li></ul>\n');
  });

  test('pressing Backspace at the start of the heading of an item whose first child is a heading moves it out of the item as a heading', async ({ page }) => {
    await openEditor(page, '\n<ul><li><h2>ab</h2></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} h2`, 0);

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<h2>ab</h2>\n');
  });

  test('turning the only item of a list with an HTML comment back into a paragraph with Backspace at its start keeps the comment in the body', async ({ page }) => {
    await openEditor(page, '\n<ul><!-- memo --><li>ab</li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li`, 0);

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<!-- memo -->\n<p>ab</p>\n');
  });
});

test.describe('deleting at list boundaries', () => {
  test('pressing Backspace at the start of an item whose previous item has a nested list merges into the end of the last nested item', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a<ul><li>x</li></ul></li><li>b</li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} > ul > li:nth-child(2)`, 0);

    await page.keyboard.press('Backspace');

    expect([await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} li li`)])
      .toEqual(['\n<ul><li>a<ul><li>xb</li></ul></li></ul>\n', true]);
  });

  test('pressing Backspace at the start of an empty paragraph right after a list removes the paragraph and moves the caret to the end of the last item', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a</li></ul>\n<p><br></p>\n');
    await placeCaretAtElementStart(page, `${EDITOR_ROOT} p`);

    await page.keyboard.press('Backspace');

    expect([await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} li`)])
      .toEqual(['\n<ul><li>a</li></ul>\n', true]);
  });

  test('merging a paragraph between two numbered lists with Backspace merges the lists into one, continuing the numbering', async ({ page }) => {
    await openEditor(page, '\n<ol><li>a</li></ol>\n<p>b</p>\n<ol><li>c</li></ol>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 0);

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<ol><li>ab</li>\n<li>c</li></ol>\n');
  });

  test('pressing Backspace at the start of an item that has its own nested list moves its content to the previous item, keeping the nested items\' level', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} > ul > li:nth-child(2)`, 0);

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>ab\n<ul><li>c</li></ul></li></ul>\n');
  });

  test('pressing Backspace at the start of an item with text after its nested list keeps that text in the previous item, wrapped in a paragraph', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a</li><li>b<ul><li>c</li></ul>note</li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} > ul > li:nth-child(2)`, 0);

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>ab\n<ul><li>c</li></ul>\n<p>note</p></li></ul>\n');
  });

  test('pressing Backspace at the start of a paragraph inside an item with own content moves the paragraph content to the end of the own content', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a<p>p</p></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 0);

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>ap</li></ul>\n');
  });

  test('when the merge target is an empty item, that item is removed and the item holding the caret stays as it is', async ({ page }) => {
    await openEditor(page, '\n<ul><li><br></li><li>b<ul><li>c</li></ul></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} > ul > li:nth-child(2)`, 0);

    await page.keyboard.press('Backspace');

    expect([await readBodyHtml(page), await readCaret(page)])
      .toEqual(['\n<ul><li>b<ul><li>c</li></ul></li></ul>\n', ['b', 0]]);
  });

  test('pressing Backspace at the start of an item whose previous item ends with a code block leaves the tree unchanged', async ({ page }) => {
    const body = '\n<ul><li>a<pre><code>x</code></pre></li><li>b</li></ul>\n';
    await openEditor(page, body);
    await placeCaretInText(page, `${EDITOR_ROOT} > ul > li:nth-child(2)`, 0);

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe(body);
  });

  test('pressing Delete at the end of the own content of an item with a nested list leaves the tree unchanged', async ({ page }) => {
    const body = '\n<ul><li>ab<ul><li>c</li></ul></li></ul>\n';
    await openEditor(page, body);
    await placeCaretInText(page, `${EDITOR_ROOT} li`, 2);

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe(body);
  });

  test('pressing Delete at the end of the paragraph of an item whose line is a paragraph merges it with the following paragraph', async ({ page }) => {
    await openEditor(page, '\n<ul><li><p>ab</p><p>cd</p></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe('\n<ul><li><p>abcd</p></li></ul>\n');
  });

  test('pressing Backspace at the start of an item when both items are inline-only merges it with the previous item', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a</li><li>b</li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li:nth-child(2)`, 0);

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>ab</li></ul>\n');
  });
});

test.describe('inserting a horizontal rule or collapsible section from a list item', () => {
  test('pressing horizontal rule in a middle item of a numbered list splits the list, puts a horizontal rule and paragraph in between, and the tail continues the numbering', async ({ page }) => {
    await openEditor(page, '\n<ol>\n<li>a</li>\n<li>b</li>\n<li>c</li>\n</ol>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li:nth-child(2)`, 1);

    await pressToolbarItem(page, TOOLBAR_SLOT.horizontalRule);

    expect(await readBodyHtml(page))
      .toBe('\n<ol>\n<li>a</li>\n<li>b</li>\n</ol>\n<hr>\n<p><br></p>\n<ol start="3">\n<li>c</li></ol>\n');
  });

  test('pressing collapsible section in an item splits the list, puts the collapsible section in between, and moves the caret to the title', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a</li><li>b</li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li`, 1);

    await pressToolbarItem(page, TOOLBAR_SLOT.details);

    expect([await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} summary`)]).toEqual([
      '\n<ul><li>a</li></ul>\n<details open="">\n<summary><br></summary>\n<p><br></p>\n</details>\n<ul><li>b</li></ul>\n',
      true,
    ]);
  });

  test('inserting a horizontal rule from an empty item removes that item, and it is not counted in the numbering', async ({ page }) => {
    await openEditor(page, '\n<ol><li>a</li><li><br></li><li>c</li></ol>\n');
    await placeCaretAtElementStart(page, `${EDITOR_ROOT} li:nth-child(2)`);

    await pressToolbarItem(page, TOOLBAR_SLOT.horizontalRule);

    expect(await readBodyHtml(page))
      .toBe('\n<ol><li>a</li></ol>\n<hr>\n<p><br></p>\n<ol start="2"><li>c</li></ol>\n');
  });

  test('inserting a collapsible section from a list whose only item is empty leaves no list behind', async ({ page }) => {
    await openEditor(page, '\n<p>x</p>\n<ul><li><br></li></ul>\n');
    await placeCaretAtElementStart(page, `${EDITOR_ROOT} li`);

    await pressToolbarItem(page, TOOLBAR_SLOT.details);

    expect(await readBodyHtml(page)).toBe(
      '\n<p>x</p>\n<details open="">\n<summary><br></summary>\n<p><br></p>\n</details>\n<p><br></p>\n',
    );
  });

  test('inserting a horizontal rule from an item whose line is a paragraph splits the list instead of going inside the item', async ({ page }) => {
    await openEditor(page, '\n<ul><li><p>a</p></li><li><p>b</p></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 1);

    await pressToolbarItem(page, TOOLBAR_SLOT.horizontalRule);

    expect(await readBodyHtml(page))
      .toBe('\n<ul><li><p>a</p></li></ul>\n<hr>\n<p><br></p>\n<ul><li><p>b</p></li></ul>\n');
  });

  test('inserting a horizontal rule from a paragraph inside an item that is not its line goes inside the item without splitting the list', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a<p>b</p></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 1);

    await pressToolbarItem(page, TOOLBAR_SLOT.horizontalRule);

    expect(await readBodyHtml(page)).toBe('\n<ul><li>a<p>b</p>\n<hr>\n<p><br></p></li></ul>\n');
  });

  test('inserting a horizontal rule from a nested item splits only the nested list and puts the horizontal rule inside the parent item', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a<ul><li>b</li><li>c</li></ul></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li li`, 1);

    await pressToolbarItem(page, TOOLBAR_SLOT.horizontalRule);

    expect(await readBodyHtml(page))
      .toBe('\n<ul><li>a<ul><li>b</li></ul>\n<hr>\n<p><br></p>\n<ul><li>c</li></ul></li></ul>\n');
  });
});

test.describe('following the pressed state', () => {
  test('moving the caret into a bulleted list item presses only bulleted list, and into a numbered list item presses only numbered list', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a</li></ul>\n<ol><li>b</li></ol>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} ul > li`, 1);
    await settleFollow(page);
    const inBullet = [await readPressed(page, TOOLBAR_SLOT.bulletList), await readPressed(page, TOOLBAR_SLOT.orderedList)];

    await placeCaret(page, { selector: `${EDITOR_ROOT} ol > li`, childIndex: 0, offset: 1 });
    await settleFollow(page);

    expect([inBullet, [await readPressed(page, TOOLBAR_SLOT.bulletList), await readPressed(page, TOOLBAR_SLOT.orderedList)]])
      .toEqual([['true', 'false'], ['false', 'true']]);
  });

  test('moving the caret into a paragraph and into a cell inside an item leaves neither pressed', async ({ page }) => {
    await openEditor(page, '\n<p>p</p>\n<ul><li>a<table><tbody><tr><td>c</td></tr></tbody></table></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 1);
    await settleFollow(page);
    const inParagraph = [
      await readPressed(page, TOOLBAR_SLOT.bulletList),
      await readPressed(page, TOOLBAR_SLOT.orderedList),
    ];

    await placeCaret(page, { selector: `${EDITOR_ROOT} td`, childIndex: 0, offset: 1 });
    await settleFollow(page);

    expect([inParagraph, [await readPressed(page, TOOLBAR_SLOT.bulletList), await readPressed(page, TOOLBAR_SLOT.orderedList)]])
      .toEqual([['false', 'false'], ['false', 'false']]);
  });

  test('turning an item back into a paragraph with Shift+Tab clears the pressed state', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a</li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li`, 1);
    await settleFollow(page);
    const before = await readPressed(page, TOOLBAR_SLOT.bulletList);

    await page.keyboard.press('Shift+Tab');
    await settleFollow(page);

    expect([before, await readPressed(page, TOOLBAR_SLOT.bulletList)]).toEqual(['true', 'false']);
  });
});

test.describe('markdown-style autoformat', () => {
  test('typing "- " at the start of a paragraph removes the marker and turns it into a bulleted list item', async ({ page }) => {
    await openEditor(page, '\n<p>abcd</p>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 0);

    await page.keyboard.type('- ');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>abcd</li></ul>\n');
  });

  test('typing "* " and "1. " at the start of paragraphs turns them into a bulleted list item and a numbered list item respectively', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<p>cd</p>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 0);
    await page.keyboard.type('* ');

    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 0 });
    await page.keyboard.type('1. ');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>ab</li></ul>\n<ol><li>cd</li></ol>\n');
  });

  test('typing "- " in an item\'s own content or in the paragraph of an item whose line is a paragraph leaves it as plain text', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a</li><li><p>b</p></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li`, 0);
    await page.keyboard.type('- ');

    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 0 });
    await page.keyboard.type('- ');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>- a</li><li><p>- b</p></li></ul>\n');
  });

  test('typing "- " in a paragraph inside an item that is not its line creates a nested list at that position', async ({ page }) => {
    await openEditor(page, '\n<ul><li>a<p>b</p></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 0);

    await page.keyboard.type('- ');

    expect(await readBodyHtml(page)).toBe('\n<ul><li>a<ul><li>b</li></ul></li></ul>\n');
  });
});

test.describe('lists in the body of a collapsible section', () => {
  test('pressing bulleted list in a paragraph in the body of a collapsible section creates a list in the body', async ({ page }) => {
    await openEditor(page, '\n<details open="">\n<summary>t</summary>\n<p>b</p>\n</details>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} details > p`, 1);

    await pressToolbarItem(page, TOOLBAR_SLOT.bulletList);

    expect(await readBodyHtml(page)).toBe('\n<details open="">\n<summary>t</summary>\n<ul><li>b</li></ul>\n</details>\n');
  });

  test('pressing Tab in the second item of a list in the body of a collapsible section nests it', async ({ page }) => {
    await openEditor(page, '\n<details open="">\n<summary>t</summary>\n<ul><li>a</li><li>b</li></ul>\n</details>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li:nth-child(2)`, 1);

    await page.keyboard.press('Tab');

    expect(await readBodyHtml(page))
      .toBe('\n<details open="">\n<summary>t</summary>\n<ul><li>a\n<ul><li>b</li></ul></li></ul>\n</details>\n');
  });

  test('pressing Enter in an empty item in the body of a collapsible section turns it into a paragraph in the body', async ({ page }) => {
    await openEditor(page, '\n<details open="">\n<summary>t</summary>\n<ul><li><br></li></ul>\n</details>\n');
    await placeCaretAtElementStart(page, `${EDITOR_ROOT} li`);

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<details open="">\n<summary>t</summary>\n<p><br></p>\n</details>\n');
  });
});
