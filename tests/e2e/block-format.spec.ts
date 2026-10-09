import { expect, test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';

import { EDITOR_ROOT_ELEMENT_ID, VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import type { MessageKey } from '../../common/index';
import type { BlockOperation } from '../../webview/editing/block-command';
import { BLOCK_KIND } from '../../webview/editing/block-format';
import { CODE_BLOCK_BRACKETS_PATH, CODE_BLOCK_FRAME_PATH } from '../../webview/ui/block-buttons';
import { BLOCK_KIND_MESSAGE_KEY, BLOCK_TYPE_MENU_CLASS } from '../../webview/ui/block-type-menu';
import type { BlockTypeMenuKind } from '../../webview/ui/block-type-menu';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import {
  EDITOR_ROOT,
  deleteWordBackward,
  focusEditor,
  openEditor,
  paste,
  placeCaret,
  readBodyHtml,
} from './helpers/editing';
import { IDLE_ICON_COLOR, getOutboundMessages, nameIconStroke } from './helpers/page';

const BODY = '\n<p>abcd</p>\n';
const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;
const MENU = `.${BLOCK_TYPE_MENU_CLASS}`;

// No message catalog is embedded, so messages are displayed as their keys.
const ADDED_ITEM_LABEL: MessageKey = 'restore.retry';

// An item with a long message, added to widen the menu. No catalog is embedded, so the key itself shows as the message.
const WIDE_ITEM_LABEL: MessageKey = 'protection.closedWithoutBackup.message';

// The container of the block type item. The menu hangs from its bottom edge.
const BLOCK_TYPE_ITEM = `${TOOLBAR} [data-slot="${TOOLBAR_SLOT.blockType}"]`;

declare global {
  interface Window {
    /** A record of the added item's operation being called. */
    __blockRuns?: string[];
  }
}

/** A position in text: which child of which element, and which character within it. */
interface TextPoint {
  readonly selector: string;
  readonly childIndex: number;
  readonly offset: number;
}

/**
 * Selects between two positions, keeping focus on the editor root.
 *
 * @param page The page to act on.
 * @param start The start point.
 * @param end The end point.
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
 * @param page The page to act on.
 * @param start The character position of the start point.
 * @param end The character position of the end point.
 */
async function selectInParagraph(page: Page, start: number, end: number): Promise<void> {
  await selectRange(
    page,
    { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: start },
    { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: end },
  );
}

/**
 * Places the caret at the start of an element with no children.
 *
 * @param page The page to act on.
 * @param selector The CSS selector that finds the element.
 */
async function placeCaretAtElementStart(page: Page, selector: string): Promise<void> {
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
 * Presses a toolbar item.
 *
 * @param page The page to act on.
 * @param slot The slot of the item to press.
 */
async function pressToolbarItem(page: Page, slot: string): Promise<void> {
  // The contents of the popup live in the same container, so only the button directly beneath it is targeted.
  await page.locator(`${TOOLBAR} [data-slot="${slot}"] > button`).click();
}

/**
 * Opens the block type menu and presses the item for a kind.
 *
 * @param page The page to act on.
 * @param kind The kind to choose.
 */
async function chooseBlockKind(page: Page, kind: BlockTypeMenuKind): Promise<void> {
  await pressToolbarItem(page, TOOLBAR_SLOT.blockType);
  await pressBlockKindItem(page, kind);
}

/**
 * Presses the item for a kind in the popup that is already open.
 *
 * @param page The page to act on.
 * @param kind The kind to choose.
 */
async function pressBlockKindItem(page: Page, kind: BlockTypeMenuKind): Promise<void> {
  await page.locator(`${MENU} button[aria-label="${BLOCK_KIND_MESSAGE_KEY[kind]}"]`).click();
}

/**
 * Reads the accessible names of the items in the open popup, in order.
 *
 * @param page The page to act on.
 * @returns The accessible names.
 */
async function readMenuLabels(page: Page): Promise<(string | null)[]> {
  return page.locator(`${MENU} button`)
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
}

/**
 * Calls the entry point that runs a block operation.
 *
 * @param page The page to act on.
 * @param operation The block operation.
 * @returns Whether the tree was changed.
 */
async function runBlockCommand(page: Page, operation: BlockOperation): Promise<boolean> {
  return page.evaluate((argument) => window.__blockCommandProbe?.(argument) ?? false, operation);
}

/**
 * Returns how many of the messages that were sent have the given type.
 *
 * @param page The page to act on.
 * @param type The message type.
 * @returns The number of messages.
 */
async function countMessages(page: Page, type: string): Promise<number> {
  const messages = await getOutboundMessages(page);
  return messages.filter((message) => (
    typeof message === 'object' && message !== null && Reflect.get(message, 'type') === type
  )).length;
}

/**
 * Reads the rectangle of an element in viewport coordinates.
 *
 * @param page The page to act on.
 * @param selector The CSS selector that finds the element.
 * @returns The left, right, top and bottom edges.
 */
async function readRect(
  page: Page,
  selector: string,
): Promise<{ left: number; right: number; top: number; bottom: number }> {
  return page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  });
}

/** Returns the string the current selection covers. */
async function readSelectedText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

/**
 * Determines whether the caret sits inside an element.
 *
 * @param page The page to act on.
 * @param selector The CSS selector that finds the element.
 * @returns `true` when the caret is inside it.
 */
async function isCaretInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((target) => {
    const anchor = window.getSelection()?.anchorNode ?? null;
    const element = document.querySelector(target);
    return anchor !== null && element !== null && element.contains(anchor);
  }, selector);
}

/** Opens the path that drives the IME. */
async function openImeSession(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/** The colors given by the light, dark, and high contrast themes. */
const THEME_COLORS = [
  { background: 'rgb(255, 255, 255)', foreground: 'rgb(31, 35, 40)' },
  { background: 'rgb(31, 31, 31)', foreground: 'rgb(204, 204, 204)' },
  { background: 'rgb(0, 0, 0)', foreground: 'rgb(255, 255, 255)' },
];

// The three slots this feature registers.
const BLOCK_SLOTS = [TOOLBAR_SLOT.blockType, TOOLBAR_SLOT.codeBlock, TOOLBAR_SLOT.horizontalRule];

/**
 * Applies the theme colors, then reads the color the three icons are drawn in and the toolbar's background color.
 *
 * VS Code puts the theme colors on the root element, so they are reproduced in the same place.
 *
 * @param page The page to act on.
 * @param colors The theme colors to apply.
 * @returns The stroke color of the icons and the background color of the toolbar.
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
  for (const slot of BLOCK_SLOTS) {
    strokes.push(await nameIconStroke(page, await page
      .locator(`${TOOLBAR} [data-slot="${slot}"] button svg`)
      .evaluate((element) => getComputedStyle(element).stroke)));
  }
  // The page background rather than the strip's, which is translucent glass.
  const background = await page
    .locator('body')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
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
 * @param page The page to act on.
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
  test('shows the block type, code block, and horizontal rule items in slot order after mounting', async ({ page }) => {
    await openEditor(page, BODY);

    const slots = await page.evaluate((toolbarId) => [
      ...document.querySelectorAll(`#${toolbarId} [data-slot]`),
    ].map((container) => container.getAttribute('data-slot')), TOOLBAR_ELEMENT_ID);

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

  test('draws the icons in the theme foreground color, never matching the background, under all three themes', async ({ page }) => {
    await openEditor(page, BODY);

    const drawn: { strokes: string[]; background: string }[] = [];
    for (const colors of THEME_COLORS) {
      drawn.push(await readIconColors(page, colors));
    }

    // Drawn in the idle icon color (a softened foreground) and never matching the background, the icons stay legible
    // under any theme.
    expect(drawn).toEqual(THEME_COLORS.map((colors) => ({
      strokes: BLOCK_SLOTS.map(() => IDLE_ICON_COLOR),
      background: colors.background,
    })));
  });

  test('draws the horizontal rule icon as a single long line across the middle', async ({ page }) => {
    await openEditor(page, BODY);

    const line = await page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.horizontalRule}"] button svg path`)
      .evaluate((element) => {
        if (!(element instanceof SVGGeometryElement)) {
          throw new Error('the icon is not drawn with a path');
        }
        const { x, y, width, height } = element.getBBox();
        return { x, y, width, height, length: element.getTotalLength() };
      });

    // A path exactly as long as it is wide is one straight stroke, so nothing is drawn above or below the line.
    expect(line).toEqual({ x: 3, y: 12, width: 18, height: 0, length: 18 });
  });

  test('centers the angle brackets of the code block icon in its frame', async ({ page }) => {
    const [frame, brackets] = await readPathBounds(page, [CODE_BLOCK_FRAME_PATH, CODE_BLOCK_BRACKETS_PATH]);

    expect([brackets.x + brackets.width / 2, brackets.y + brackets.height / 2])
      .toEqual([frame.x + frame.width / 2, frame.y + frame.height / 2]);
  });

  test('lays out none of the three items and throws nothing for an unopenable document', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await openEditor(page, '\n<script>a</script>\n');

    expect([await page.locator(TOOLBAR).count(), pageErrors]).toEqual([0, []]);
  });

  test('lists only the eight kind items, paragraph through quote, when the block type item is pressed', async ({ page }) => {
    await openEditor(page, BODY);

    await pressToolbarItem(page, TOOLBAR_SLOT.blockType);

    // Items added by other feature units are laid out after these. What is looked at here is that the eight items of
    // this feature come first, in order, and that no other kind item (code block or div) is listed.
    const labels = await readMenuLabels(page);
    expect([labels.slice(0, 8), labels.filter((label) => label?.startsWith('blockType.')).length]).toEqual([
      [
        BLOCK_KIND_MESSAGE_KEY.paragraph,
        BLOCK_KIND_MESSAGE_KEY.heading1,
        BLOCK_KIND_MESSAGE_KEY.heading2,
        BLOCK_KIND_MESSAGE_KEY.heading3,
        BLOCK_KIND_MESSAGE_KEY.heading4,
        BLOCK_KIND_MESSAGE_KEY.heading5,
        BLOCK_KIND_MESSAGE_KEY.heading6,
        BLOCK_KIND_MESSAGE_KEY.quote,
      ],
      8,
    ]);
  });

  test('floats the popup off the bar as an opaque bordered card, and stacks its items', async ({ page }) => {
    await openEditor(page, BODY);

    await pressToolbarItem(page, TOOLBAR_SLOT.blockType);

    // Without floating, the bar's height would change on every press; without a fill, the body underneath would show
    // through and make it unreadable. The fill is a gradient that ends in the page background, so it is not
    // translucent like the strip's glass.
    expect(await page.locator(MENU).evaluate((element) => {
      const style = getComputedStyle(element);
      const items = [...element.querySelectorAll('button')];
      return {
        position: style.position,
        filled: style.backgroundImage.includes('linear-gradient'),
        bordered: style.borderTopWidth !== '0px',
        stacked: items[1].getBoundingClientRect().top > items[0].getBoundingClientRect().top,
      };
    })).toEqual({
      position: 'absolute',
      filled: true,
      bordered: true,
      stacked: true,
    });
  });

  test('rounds the corners of the popup with a 0.95em radius and gives it a shadow', async ({ page }) => {
    await openEditor(page, BODY);

    await pressToolbarItem(page, TOOLBAR_SLOT.blockType);

    expect(await page.locator(MENU).evaluate((element) => {
      const style = getComputedStyle(element);
      const radius = 0.95 * parseFloat(style.fontSize);
      return [
        Math.abs(parseFloat(style.borderTopLeftRadius) - radius) < 0.01,
        Math.abs(parseFloat(style.borderBottomRightRadius) - radius) < 0.01,
        style.boxShadow !== 'none',
      ];
    })).toEqual([true, true, true]);
  });

  test('closes the popup on a press outside it and leaves the selection in the editor root as it was', async ({ page }) => {
    await openEditor(page, BODY);
    await selectInParagraph(page, 1, 3);
    await pressToolbarItem(page, TOOLBAR_SLOT.blockType);
    await expect(page.locator(MENU)).toHaveCount(1);

    // Press the empty padding of the toolbar. A press does not move focus, so the selection stays as it was.
    await page.locator(TOOLBAR).click({ position: { x: 2, y: 2 } });

    expect([await page.locator(MENU).count(), await readSelectedText(page)]).toEqual([0, 'bc']);
  });

  test('lays an added item out after the items added so far and calls its operation when it is pressed', async ({ page }) => {
    await openEditor(page, BODY);
    await page.evaluate((messageKey) => {
      window.__blockRuns = [];
      window.__blockTypeMenuProbe?.()?.addItem({
        messageKey,
        run: () => window.__blockRuns?.push('added'),
      });
    }, ADDED_ITEM_LABEL);

    await pressToolbarItem(page, TOOLBAR_SLOT.blockType);
    const labels = await readMenuLabels(page);
    await page.locator(`${MENU} button[aria-label="${ADDED_ITEM_LABEL}"]`).click();

    // An added item goes at the end of the list. That it comes after the eight items of this feature is covered by
    // the check on the order above.
    expect([labels.at(-1), await page.evaluate(() => window.__blockRuns ?? [])])
      .toEqual([ADDED_ITEM_LABEL, ['added']]);
  });

  test('keeps the menu\'s right edge inside the visible width and its top below the item when opened at a width where it would run past the right edge', async ({ page }) => {
    await openEditor(page, BODY);
    await page.evaluate((messageKey) => {
      window.__blockTypeMenuProbe?.()?.addItem({ messageKey, run: () => undefined });
    }, WIDE_ITEM_LABEL);
    await pressToolbarItem(page, TOOLBAR_SLOT.blockType);
    const wide = await readRect(page, MENU);
    await pressToolbarItem(page, TOOLBAR_SLOT.blockType);
    // A width the menu fits in, but 20px short when counted from the left edge of the item.
    await page.setViewportSize({ width: Math.floor(wide.right) - 20, height: 720 });

    await pressToolbarItem(page, TOOLBAR_SLOT.blockType);

    const menu = await readRect(page, MENU);
    const item = await readRect(page, BLOCK_TYPE_ITEM);
    const visibleWidth = await page.evaluate(() => document.documentElement.clientWidth);
    // The popup hangs a little below the item: a gap of 0.4em of its own font size.
    const gap = await page.locator(MENU).evaluate((element) => parseFloat(getComputedStyle(element).marginTop));
    expect([menu.right <= visibleWidth, menu.left >= 0, Math.abs(menu.top - item.bottom - gap) <= 1])
      .toEqual([true, true, true]);
  });
});

test.describe('block conversion', () => {
  test('turns the paragraph into an h2 when the caret is in the body and Heading 2 is chosen', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await chooseBlockKind(page, BLOCK_KIND.heading2);

    expect(await readBodyHtml(page)).toBe('\n<h2>abcd</h2>\n');
  });

  test('makes each a bare blockquote and leaves the table it spans in place when Quote is chosen across paragraphs', async ({ page }) => {
    const body = '\n<p>ab</p>\n<table><tbody><tr><td>cd</td></tr></tbody></table>\n<p>ef</p>\n';
    await openEditor(page, body);
    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} p:last-of-type`, childIndex: 0, offset: 1 },
    );

    await chooseBlockKind(page, BLOCK_KIND.quote);

    expect(await readBodyHtml(page)).toBe(
      '\n<blockquote>ab</blockquote>\n<table><tbody><tr><td>cd</td></tr></tbody></table>'
      + '\n<blockquote>ef</blockquote>\n',
    );
  });

  test('wraps a bare run directly beneath the editor root in a paragraph before converting it to a heading', async ({ page }) => {
    await openEditor(page, 'ab');
    await selectRange(
      page,
      { selector: EDITOR_ROOT, childIndex: 0, offset: 0 },
      { selector: EDITOR_ROOT, childIndex: 0, offset: 2 },
    );

    await chooseBlockKind(page, BLOCK_KIND.heading2);

    expect(await readBodyHtml(page)).toBe('\n<h2>ab</h2>');
  });

  test('leaves the selection after the conversion covering the same string as before the operation', async ({ page }) => {
    await openEditor(page, BODY);
    await selectInParagraph(page, 1, 3);

    await chooseBlockKind(page, BLOCK_KIND.heading2);

    expect(await readSelectedText(page)).toBe('bc');
  });

  test('sends the host exactly one settled edit unit for a single conversion to a heading', async ({ page }) => {
    await openEditor(page, BODY);
    await selectInParagraph(page, 1, 3);

    await chooseBlockKind(page, BLOCK_KIND.heading2);

    await expect
      .poll(() => countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction))
      .toBe(1);
  });

  test('changes nothing when the block type item is pressed during an IME composition, and works once it is committed', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    const ime = await openImeSession(page);

    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    await pressToolbarItem(page, TOOLBAR_SLOT.blockType);
    await pressBlockKindItem(page, BLOCK_KIND.heading2);
    const duringComposition = await page.locator(`${EDITOR_ROOT} h2`).count();

    // A press during a composition does nothing and leaves the popup open, so it is pressed again after the
    // composition is committed.
    await ime.send('Input.insertText', { text: 'あ' });
    await pressBlockKindItem(page, BLOCK_KIND.heading2);

    expect([duringComposition, await page.locator(`${EDITOR_ROOT} h2`).count()]).toEqual([0, 1]);
  });

  test('changes nothing when the entry point is called while an overlay is up', async ({ page }) => {
    await openEditor(page, BODY);
    await selectInParagraph(page, 1, 3);
    await page.evaluate((reason) => {
      window.__uiShellProbe?.()?.overlay.present(reason, { heading: '', descriptions: [], actions: [] });
    }, INPUT_STOP_REASON.saveRoundTrip);

    const changed = await runBlockCommand(page, { kind: 'convert', to: BLOCK_KIND.heading2 });

    expect([changed, await readBodyHtml(page)]).toEqual([false, BODY]);
  });

  test('turns the paragraph into a pre with a code on the first press of the code block button and back on the second', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await pressToolbarItem(page, TOOLBAR_SLOT.codeBlock);
    const afterFirst = await readBodyHtml(page);
    await pressToolbarItem(page, TOOLBAR_SLOT.codeBlock);

    expect([afterFirst, await readBodyHtml(page)])
      .toEqual(['\n<pre><code>abcd</code></pre>\n', BODY]);
  });

  test('materializes a paragraph as an h1 when Heading 1 is chosen without clicking the body of a newly opened empty file', async ({ page }) => {
    await openEditor(page, '');

    await chooseBlockKind(page, BLOCK_KIND.heading1);

    expect(await readBodyHtml(page)).toBe('\n<h1><br></h1>');
  });

  test('keeps the caret in the same block rather than the neighbour when a heading is chosen in an empty block', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<p><br></p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p:last-of-type`, childIndex: 0, offset: 0 });

    await chooseBlockKind(page, BLOCK_KIND.heading2);

    expect([await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} h2`)])
      .toEqual(['\n<p>ab</p>\n<h2><br></h2>\n', true]);
  });

  test('keeps the height of the line right after an empty paragraph is converted to a code block', async ({ page }) => {
    await openEditor(page, '\n<p><br></p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 0 });

    await pressToolbarItem(page, TOOLBAR_SLOT.codeBlock);

    // Even with empty text, the background and padding hold the height of the line. At zero height the line
    // would look as though it had disappeared.
    const height = await page.locator(`${EDITOR_ROOT} pre`)
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(height).toBeGreaterThan(0);
  });

  test('puts characters typed right after an empty paragraph becomes a code block inside the code', async ({ page }) => {
    await openEditor(page, '\n<p><br></p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 0 });
    await pressToolbarItem(page, TOOLBAR_SLOT.codeBlock);

    await page.keyboard.type('ab');

    // Left to the browser, they would go outside the empty code and leave it behind.
    expect(await readBodyHtml(page)).toBe('\n<pre><code>ab</code></pre>\n');
  });

  test('puts the newline character of an Enter pressed right after the conversion inside the code', async ({ page }) => {
    await openEditor(page, '\n<p><br></p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 0 });
    await pressToolbarItem(page, TOOLBAR_SLOT.codeBlock);

    await page.keyboard.press('Enter');

    // Inserted without moving the range in, the newline character would go outside the code and leave two
    // children directly beneath the pre. The second newline is the display line break that lets the new line show.
    expect(await readBodyHtml(page)).toBe('\n<pre><code>\n\n</code></pre>\n');
  });

  test('returns the output to the same shape as the input when a body whose kind was converted back and forth is saved', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await chooseBlockKind(page, BLOCK_KIND.heading2);
    await chooseBlockKind(page, BLOCK_KIND.paragraph);

    expect(await page.evaluate(() => window.__serializationProbe?.()?.current)).toBe(BODY);
  });
});

test.describe('horizontal rule', () => {
  test('inserts an hr and an empty paragraph after the reference and moves the caret there on a button press', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await pressToolbarItem(page, TOOLBAR_SLOT.horizontalRule);

    expect([
      await readBodyHtml(page),
      await isCaretInside(page, `${EDITOR_ROOT} p:last-of-type`),
    ]).toEqual(['\n<p>abcd</p>\n<hr>\n<p><br></p>\n', true]);
  });

  test('inserts the hr before an empty block and keeps the caret in that block on a button press', async ({ page }) => {
    await openEditor(page, '\n<p><br></p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 0 });

    await pressToolbarItem(page, TOOLBAR_SLOT.horizontalRule);

    // A line break is inserted on the reference's side as well, so the existing one stays before the new block.
    expect([
      await readBodyHtml(page),
      await isCaretInside(page, `${EDITOR_ROOT} p`),
    ]).toEqual(['\n\n<hr>\n<p><br></p>\n', true]);
  });

  test('pressing the horizontal rule button with the caret in a list item inserts a horizontal rule and a paragraph after the list', async ({ page }) => {
    await openEditor(page, '\n<ul><li>ab</li></ul>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} li`, childIndex: 0, offset: 1 });

    await pressToolbarItem(page, TOOLBAR_SLOT.horizontalRule);

    expect(await readBodyHtml(page)).toBe('\n<ul><li>ab</li></ul>\n<hr>\n<p><br></p>\n');
  });

  test('pressing the horizontal rule button on the second of three lines of an alert blockquote inserts it inside the blockquote after that line', async ({ page }) => {
    await openEditor(page, '\n<blockquote data-alert="note">ab<br>cd<br>ef</blockquote>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} blockquote`, childIndex: 2, offset: 2 });

    await pressToolbarItem(page, TOOLBAR_SLOT.horizontalRule);

    expect([
      await readBodyHtml(page),
      await isCaretInside(page, `${EDITOR_ROOT} blockquote > hr + p`),
    ]).toEqual([
      '\n<blockquote data-alert="note"><p>ab</p>\n<p>cd</p>\n<hr>\n<p><br></p>\n<p>ef</p></blockquote>\n',
      true,
    ]);
  });

  test('removes only the hr and leaves the paragraph intact on Backspace at the start of the paragraph after it', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<hr>\n<p>cd</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p:last-of-type`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<p>ab</p>\n<p>cd</p>\n');
  });

  test('likewise removes only the hr on Delete at the end of the paragraph before it', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<hr>\n<p>cd</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe('\n<p>ab</p>\n<p>cd</p>\n');
  });

  test('removes only the hr on a word-wise delete next to it, just as a character-wise delete does', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<hr>\n<p>cd</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p:last-of-type`, childIndex: 0, offset: 0 });

    await deleteWordBackward(page);

    expect(await readBodyHtml(page)).toBe('\n<p>ab</p>\n<p>cd</p>\n');
  });

  test('Backspace at the start of the first item, with an hr adjacent outside the list, keeps the hr and turns the item into a paragraph', async ({ page }) => {
    await openEditor(page, '\n<hr>\n<ul><li>ab</li></ul>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} li`, childIndex: 0, offset: 0 });

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('\n<hr>\n<p>ab</p>\n');
  });

  test('removes the hr on a Backspace right after inserting a horizontal rule, and the empty paragraph on the next', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 4 });
    await pressToolbarItem(page, TOOLBAR_SLOT.horizontalRule);

    await page.keyboard.press('Backspace');
    const afterFirst = await readBodyHtml(page);
    await page.keyboard.press('Backspace');

    expect([afterFirst, await readBodyHtml(page)])
      .toEqual(['\n<p>abcd</p>\n<p><br></p>\n', BODY]);
  });
});

test.describe('code block inside a bare blockquote', () => {
  const QUOTE = '\n<blockquote>ab<br>cd<br>ef</blockquote>\n';

  test('turns only the caret\'s line into a code block inside the blockquote and the lines around it into paragraphs when the code block button is pressed on the second line', async ({ page }) => {
    await openEditor(page, QUOTE);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} blockquote`, childIndex: 2, offset: 1 });

    await pressToolbarItem(page, TOOLBAR_SLOT.codeBlock);

    expect(await readBodyHtml(page))
      .toBe('\n<blockquote><p>ab</p>\n<pre><code>cd</code></pre>\n<p>ef</p></blockquote>\n');
  });

  test('keeps the caret at the same character inside the code block after the same operation', async ({ page }) => {
    await openEditor(page, QUOTE);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} blockquote`, childIndex: 2, offset: 1 });

    await pressToolbarItem(page, TOOLBAR_SLOT.codeBlock);

    const caret = await page.evaluate(() => {
      const selection = window.getSelection();
      return [selection?.anchorNode?.textContent, selection?.anchorOffset, selection?.isCollapsed];
    });
    expect([await isCaretInside(page, `${EDITOR_ROOT} code`), caret]).toEqual([true, ['cd', 1, true]]);
  });

  test('turns two lines into one code block inside the blockquote when the button is pressed with a range over them', async ({ page }) => {
    await openEditor(page, QUOTE);
    await focusEditor(page);
    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} blockquote`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} blockquote`, childIndex: 2, offset: 1 },
    );

    await pressToolbarItem(page, TOOLBAR_SLOT.codeBlock);

    expect(await readBodyHtml(page))
      .toBe('\n<blockquote><pre><code>ab\ncd</code></pre>\n<p>ef</p></blockquote>\n');
  });

  test('leaves the selection covering the same string when the button is pressed with a range from a line of the blockquote into the paragraph after it', async ({ page }) => {
    await openEditor(page, `${QUOTE}<p>gh</p>\n`);
    await focusEditor(page);
    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} blockquote`, childIndex: 2, offset: 1 },
      { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 },
    );
    const before = await readSelectedText(page);

    await pressToolbarItem(page, TOOLBAR_SLOT.codeBlock);

    // The br before the covered lines leaves the tree, so the end after the blockquote is found by a count less that br.
    expect([before, await readBodyHtml(page), await readSelectedText(page)]).toEqual([
      'd\nef\ng',
      '\n<blockquote><p>ab</p>\n<pre><code>cd\nef</code></pre></blockquote>\n<pre><code>gh</code></pre>\n',
      before,
    ]);
  });

  test('keeps a blockquote of a single line and puts the code block inside it when the button is pressed', async ({ page }) => {
    await openEditor(page, '\n<blockquote>ab</blockquote>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} blockquote`, childIndex: 0, offset: 1 });

    await pressToolbarItem(page, TOOLBAR_SLOT.codeBlock);

    expect(await readBodyHtml(page)).toBe('\n<blockquote><pre><code>ab</code></pre></blockquote>\n');
  });
});

test.describe('leaving a code block', () => {
  test('inserts a newline and a display line break on the first Enter at the end of a code block, and leaves for an empty paragraph on the second with no newline left at the end of the pre', async ({ page }) => {
    await openEditor(page, '\n<pre><code>ab</code></pre>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Enter');
    const afterFirst = await readBodyHtml(page);
    await page.keyboard.press('Enter');

    expect([afterFirst, await readBodyHtml(page)]).toEqual([
      '\n<pre><code>ab\n\n</code></pre>\n',
      '\n<pre><code>ab</code></pre>\n<p><br></p>\n',
    ]);
  });

  test('grows the pre by one line on Enter at the end of a code block and puts the characters typed next on the new line', async ({ page }) => {
    await openEditor(page, '\n<pre><code>ab</code></pre>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 2 });
    const readHeight = async (): Promise<number> => page.locator(`${EDITOR_ROOT} pre`)
      .evaluate((element) => element.getBoundingClientRect().height);
    const lineHeight = await page.locator(`${EDITOR_ROOT} pre`)
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight));
    const before = await readHeight();

    await page.keyboard.press('Enter');
    const grown = await readHeight() - before;
    await page.keyboard.type('c');

    // Without the display line break, the newline would be the last character of the content and form no line.
    // A line holding a character shows on its own, so the browser drops the display line break once one is typed.
    expect([Math.abs(grown - lineHeight) < 1, await readBodyHtml(page)])
      .toEqual([true, '\n<pre><code>ab\nc</code></pre>\n']);
  });

  test('inserts a newline character without leaving on Enter partway through a code block', async ({ page }) => {
    await openEditor(page, '\n<pre><code>ab</code></pre>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 1 });

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<pre><code>a\nb</code></pre>\n');
  });

  test('inserts a newline and a display line break without leaving on Enter in an empty code block', async ({ page }) => {
    await openEditor(page, '\n<pre><code></code></pre>\n');
    await focusEditor(page);
    await placeCaretAtElementStart(page, `${EDITOR_ROOT} code`);

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<pre><code>\n\n</code></pre>\n');
  });

  test('inserts a newline and a display line break without leaving on Shift+Enter at the end of a code block', async ({ page }) => {
    await openEditor(page, '\n<pre><code>ab</code></pre>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Shift+Enter');

    expect(await readBodyHtml(page)).toBe('\n<pre><code>ab\n\n</code></pre>\n');
  });

  test('still leaves on Enter at the end of a code block after the document is replaced, so the rule was not lost', async ({ page }) => {
    await openEditor(page, BODY);
    await page.evaluate(
      (text) => window.__documentReplacementProbe?.(text),
      `${PROLOGUE}\n<pre><code>ab\n</code></pre>\n${EPILOGUE}`,
    );
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 3 });

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<pre><code>ab</code></pre>\n<p><br></p>\n');
  });
});

test.describe('pasting into an empty code block', () => {
  // The paste goes through real key presses, so reading and writing the clipboard is allowed.
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('puts two lines pasted right after an empty paragraph becomes a code block inside the code as newline characters', async ({ page }) => {
    await openEditor(page, '\n<p><br></p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 0 });
    await pressToolbarItem(page, TOOLBAR_SLOT.codeBlock);

    await paste(page, { 'text/plain': 'a\nb' });

    // Inserted without moving the range in, the content would pile up outside the `code` the caret sits in and
    // leave that `code` empty.
    expect(await readBodyHtml(page)).toBe('\n<pre><code>a\nb</code></pre>\n');
  });
});
