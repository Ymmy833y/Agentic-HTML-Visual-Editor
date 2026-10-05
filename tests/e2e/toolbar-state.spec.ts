import { chromium, expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { EDITOR_ROOT_ELEMENT_ID, MESSAGE_CATALOG_ELEMENT_ID } from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { BLOCK_KIND_MESSAGE_KEY, BLOCK_TYPE_MENU_CLASS } from '../../webview/ui/block-type-menu';
import { ALERT_MESSAGE_KEY } from '../../webview/ui/alert-items';
import { FLOATING_MENU_ELEMENT_ID } from '../../webview/ui/floating-menu';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { EDITOR_ROOT, focusEditor, openEditor, placeCaret, readBodyHtml } from './helpers/editing';
import { PROBE_BUNDLE_PATH, openWebviewHost, readToolbarColorToken, sendToWebview } from './helpers/page';

const BODY = '\n<p>abcd</p>\n';
const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;
const MENU = `.${BLOCK_TYPE_MENU_CLASS}`;
const FLOATING = `#${FLOATING_MENU_ELEMENT_ID}`;

// The button of the block type item. It holds the item label of the current kind and the chevron (the icon).
const BLOCK_TYPE_BUTTON = `${TOOLBAR} [data-slot="${TOOLBAR_SLOT.blockType}"] > button`;

// The slots of the frequently used items in the floating menu. All of them are registered by the time of the mount.
const FLOATING_SLOTS = [
  TOOLBAR_SLOT.bold,
  TOOLBAR_SLOT.italic,
  TOOLBAR_SLOT.inlineCode,
  TOOLBAR_SLOT.clearFormatting,
  TOOLBAR_SLOT.link,
  TOOLBAR_SLOT.comment,
];

/** A position within text: which child of which element, and at which character. */
interface TextPoint {
  readonly selector: string;
  readonly childIndex: number;
  readonly offset: number;
}

/** A theme: the variables VS Code puts on the root element, and whether it puts the high contrast class on the body. */
interface Theme {
  readonly highContrast: boolean;
  readonly variables: Readonly<Record<string, string>>;
}

// A light and a high contrast theme. The values are written as rgb, so that they compare as they are with computed
// colors.
const LIGHT_THEME: Theme = {
  highContrast: false,
  variables: {
    '--vscode-editor-background': 'rgb(255, 255, 255)',
    '--vscode-editor-foreground': 'rgb(59, 59, 59)',
    '--vscode-panel-border': 'rgb(229, 229, 229)',
    '--vscode-textLink-foreground': 'rgb(0, 95, 184)',
    '--vscode-textCodeBlock-background': 'rgb(240, 241, 242)',
  },
};
const HIGH_CONTRAST_THEME: Theme = {
  highContrast: true,
  variables: {
    '--vscode-editor-background': 'rgb(0, 0, 0)',
    '--vscode-editor-foreground': 'rgb(255, 255, 255)',
    '--vscode-panel-border': 'rgb(111, 195, 223)',
    '--vscode-textLink-foreground': 'rgb(33, 166, 255)',
    '--vscode-textCodeBlock-background': 'rgb(10, 10, 10)',
  },
};

/**
 * Applies a theme. VS Code puts the variables on the root element and, in a high contrast theme, a class on the body,
 * so they are put in the same places.
 *
 * @param page The target page.
 * @param theme The theme.
 */
async function applyTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((given) => {
    for (const [name, value] of Object.entries(given.variables)) {
      document.documentElement.style.setProperty(name, value);
    }
    document.body.classList.toggle('vscode-high-contrast', given.highContrast);
  }, theme);
}

/**
 * Selects between 2 positions. Keeps focus on the editor root.
 *
 * @param page The target page.
 * @param start The start.
 * @param end The end.
 */
async function selectRange(page: Page, start: TextPoint, end: TextPoint): Promise<void> {
  await page.evaluate((argument) => {
    const readText = (point: { selector: string; childIndex: number }): Node => {
      const node = document.querySelector(point.selector)?.childNodes[point.childIndex];
      if (node === undefined) {
        throw new Error(`Text not found: ${point.selector}`);
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
 * Selects characters within one element.
 *
 * @param page The target page.
 * @param selector Selector that finds the element.
 * @param start Character offset of the start.
 * @param end Character offset of the end.
 */
async function selectIn(page: Page, selector: string, start: number, end: number): Promise<void> {
  await selectRange(
    page,
    { selector, childIndex: 0, offset: start },
    { selector, childIndex: 0, offset: end },
  );
}

/** Clears the selection in the editor root. */
async function clearSelection(page: Page): Promise<void> {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
}

/**
 * Waits until the coalescing wait ends. Triggers are coalesced into 1 frame.
 *
 * @param page The target page.
 */
async function settleFollow(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

/**
 * Prevents selection changes from reaching the caret follow.
 *
 * With operations that reset the selection, such as the alert operation, reflection also proceeds via the
 * selection change, so it cannot be verified that the edit trigger alone drives it. Selection changes fire
 * on the document, so stopping them in the window capture phase keeps them from the document listeners.
 *
 * @param page The target page.
 */
async function blockSelectionChange(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.addEventListener('selectionchange', (event) => event.stopImmediatePropagation(), true);
  });
}

/**
 * Embeds the English message catalog. Call before initialization.
 *
 * Whether the label length changes the item width cannot be verified with messages shown as keys.
 *
 * @param page The target page.
 */
async function embedEnglishCatalog(page: Page): Promise<void> {
  await page.evaluate((argument) => {
    const element = document.createElement('script');
    element.type = 'application/json';
    element.id = argument.elementId;
    element.textContent = argument.catalog;
    document.head.append(element);
  }, { elementId: MESSAGE_CATALOG_ELEMENT_ID, catalog: JSON.stringify(englishMessages) });
}

/**
 * Reads the left edge of a fixed toolbar item.
 *
 * @param page The target page.
 * @param slot The slot of the item to read.
 * @returns The left edge position relative to the viewport.
 */
async function readItemLeft(page: Page, slot: string): Promise<number> {
  return page.locator(`${TOOLBAR} [data-slot="${slot}"] > button`)
    .evaluate((element) => element.getBoundingClientRect().left);
}

/**
 * Presses a fixed toolbar item.
 *
 * @param page The target page.
 * @param slot The slot of the item to press.
 */
async function pressToolbarItem(page: Page, slot: string): Promise<void> {
  // Popup contents go into the same container, so only the direct child button is targeted.
  await page.locator(`${TOOLBAR} [data-slot="${slot}"] > button`).click();
}

/**
 * Reads the pressed state of a fixed toolbar item.
 *
 * @param page The target page.
 * @param slot The slot of the item to read.
 * @returns The `aria-pressed` value, or `null` if the attribute is absent.
 */
async function readPressed(page: Page, slot: string): Promise<string | null> {
  return page.locator(`${TOOLBAR} [data-slot="${slot}"] > button`)
    .getAttribute('aria-pressed');
}

/**
 * Reads the item label of the block type item.
 *
 * @param page The target page.
 * @returns The item label, or `null` if the element is absent so it can be treated as the registered message.
 */
async function readBlockTypeLabel(page: Page): Promise<string | null> {
  return page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.blockType}"] .toolbar-label`)
    .evaluateAll((elements) => elements[0]?.textContent ?? null);
}

/**
 * Reads the accessible names of the marked items in the open popup.
 *
 * @param page The target page.
 * @returns The accessible names of the marked items.
 */
async function readMarkedLabels(page: Page): Promise<(string | null)[]> {
  return page.locator(`${MENU} button[data-marked]`)
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
}

/**
 * Reads the slots of the items in the floating menu, in layout order.
 *
 * @param page The target page.
 * @returns The slots of the laid-out items.
 */
async function readFloatingSlots(page: Page): Promise<(string | null)[]> {
  return page.locator(`${FLOATING} button`)
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('data-slot')));
}

/**
 * Reads whether the floating menu is shown.
 *
 * @param page The target page.
 * @returns `true` if shown.
 */
async function isFloatingVisible(page: Page): Promise<boolean> {
  return page.locator(FLOATING).evaluate((element) => !element.hasAttribute('hidden'));
}

test.describe('Observing follow triggers', () => {
  test('with selection changes blocked, applying an alert moves the popup marks to the current alert via the edit trigger alone', async ({ page }) => {
    await openEditor(page, '\n<blockquote>abcd</blockquote>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} blockquote`, childIndex: 0, offset: 2 });
    await settleFollow(page);
    await blockSelectionChange(page);

    await page.evaluate(() => window.__blockCommandProbe?.({ kind: 'alert', to: 'note' }));
    await settleFollow(page);
    await pressToolbarItem(page, TOOLBAR_SLOT.blockType);

    // An alert blockquote puts no menu mark on the quote item, so Note alone is marked.
    expect(await readMarkedLabels(page)).toEqual([ALERT_MESSAGE_KEY.note]);
  });

  test('after document replacement, applying an alert with selection changes blocked still moves the popup marks to the current alert', async ({ page }) => {
    await openEditor(page, BODY);
    await page.evaluate(
      (text) => window.__documentReplacementProbe?.(text),
      `${PROLOGUE}\n<blockquote>abcd</blockquote>\n${EPILOGUE}`,
    );
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} blockquote`, childIndex: 0, offset: 2 });
    await settleFollow(page);
    await blockSelectionChange(page);

    await page.evaluate(() => window.__blockCommandProbe?.({ kind: 'alert', to: 'note' }));
    await settleFollow(page);
    await pressToolbarItem(page, TOOLBAR_SLOT.blockType);

    expect(await readMarkedLabels(page)).toEqual([ALERT_MESSAGE_KEY.note]);
  });

  test('when the selection changes during IME composition, the pressed state updates without changing the tree', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<p><strong>cd</strong></p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    const ime = await page.context().newCDPSession(page);
    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    const composed = await readBodyHtml(page);

    await placeCaret(page, { selector: `${EDITOR_ROOT} strong`, childIndex: 0, offset: 1 });
    await settleFollow(page);

    expect([await readBodyHtml(page), await readPressed(page, TOOLBAR_SLOT.bold)])
      .toEqual([composed, 'true']);
  });

  test('for an unopenable document the caret follow is not attached and selection changes throw nothing', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openWebviewHost(page, PROBE_BUNDLE_PATH);
    await sendToWebview(page, {
      type: 'initialize',
      text: '<html><body><p>a</p><script>b</script></body></html>',
      documentUri: '',
      resourceRootUri: '',
    });

    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.body);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
    await settleFollow(page);

    expect([errors, await page.locator(FLOATING).count()]).toEqual([[], 0]);
  });
});

test.describe('Evaluating the current state', () => {
  test('selecting a range spanning 2 blocks takes the kind from the start and evaluates formats over all segments', async ({ page }) => {
    await openEditor(page, '\n<h2><strong>ab</strong></h2>\n<p>cd</p>\n');
    await focusEditor(page);

    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} strong`, childIndex: 0, offset: 0 },
      { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 },
    );
    await settleFollow(page);

    expect([await readBlockTypeLabel(page), await readPressed(page, TOOLBAR_SLOT.bold)])
      .toEqual([BLOCK_KIND_MESSAGE_KEY.heading2, 'false']);
  });

  test('clearing the editor root selection clears the pressed state and turns the block type label into the paragraph message instead of the registered message', async ({ page }) => {
    await openEditor(page, '\n<h2><strong>abcd</strong></h2>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} strong`, childIndex: 0, offset: 2 });
    await settleFollow(page);

    await clearSelection(page);
    await settleFollow(page);

    expect([await readPressed(page, TOOLBAR_SLOT.bold), await readBlockTypeLabel(page)])
      .toEqual(['false', BLOCK_KIND_MESSAGE_KEY.paragraph]);
  });
});

test.describe('Reflecting onto the fixed toolbar', () => {
  test('placing the caret inside bold makes the fixed toolbar bold pressed', async ({ page }) => {
    await openEditor(page, '\n<p><strong>abcd</strong></p>\n');
    await focusEditor(page);

    await placeCaret(page, { selector: `${EDITOR_ROOT} strong`, childIndex: 0, offset: 2 });

    await expect(page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.bold}"] > button`))
      .toHaveAttribute('aria-pressed', 'true');
  });

  test('moving the caret to a heading makes the block type item label the heading message', async ({ page }) => {
    await openEditor(page, '\n<p>abcd</p>\n<h3>efgh</h3>\n');
    await focusEditor(page);

    await placeCaret(page, { selector: `${EDITOR_ROOT} h3`, childIndex: 0, offset: 2 });

    await expect(page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.blockType}"] .toolbar-label`))
      .toHaveText(BLOCK_KIND_MESSAGE_KEY.heading3);
  });

  test('placing the caret in an alert blockquote makes the block type item label the message of that alert kind', async ({ page }) => {
    await openEditor(page, '\n<blockquote data-alert="warning">abcd</blockquote>\n');
    await focusEditor(page);

    await placeCaret(page, { selector: `${EDITOR_ROOT} blockquote`, childIndex: 0, offset: 2 });
    await settleFollow(page);

    expect(await readBlockTypeLabel(page)).toBe(ALERT_MESSAGE_KEY.warning);
  });

  test('placing the caret in a blockquote and opening the popup marks the quote item alone', async ({ page }) => {
    await openEditor(page, '\n<blockquote>abcd</blockquote>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} blockquote`, childIndex: 0, offset: 2 });
    await settleFollow(page);

    await pressToolbarItem(page, TOOLBAR_SLOT.blockType);

    expect(await readMarkedLabels(page)).toEqual([BLOCK_KIND_MESSAGE_KEY.quote]);
  });

  test('placing the caret in a blockquote with a paragraph child shows the paragraph label and no marks', async ({ page }) => {
    await openEditor(page, '\n<blockquote>abcd<p>efgh</p></blockquote>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} blockquote`, childIndex: 0, offset: 2 });
    await settleFollow(page);

    await pressToolbarItem(page, TOOLBAR_SLOT.blockType);

    expect([await readBlockTypeLabel(page), await readMarkedLabels(page)])
      .toEqual([BLOCK_KIND_MESSAGE_KEY.paragraph, []]);
  });

  test('placing the caret in a list item makes the block type label the paragraph message', async ({ page }) => {
    await openEditor(page, '\n<h2>abcd</h2>\n<ul><li>efgh</li></ul>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} h2`, childIndex: 0, offset: 2 });
    await settleFollow(page);

    await placeCaret(page, { selector: `${EDITOR_ROOT} li`, childIndex: 0, offset: 2 });
    await settleFollow(page);

    expect(await readBlockTypeLabel(page)).toBe(BLOCK_KIND_MESSAGE_KEY.paragraph);
  });

  test('placing the caret in a details title makes the block type label the paragraph message', async ({ page }) => {
    await openEditor(page, '\n<h2>abcd</h2>\n<details open><summary>efgh</summary><p>ijkl</p></details>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} h2`, childIndex: 0, offset: 2 });
    await settleFollow(page);

    await placeCaret(page, { selector: `${EDITOR_ROOT} summary`, childIndex: 0, offset: 2 });
    await settleFollow(page);

    expect(await readBlockTypeLabel(page)).toBe(BLOCK_KIND_MESSAGE_KEY.paragraph);
  });

  test('placing the caret in a code block and opening the popup shows the code block label and marks no item', async ({ page }) => {
    await openEditor(page, '\n<pre><code>abcd</code></pre>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 2 });
    await settleFollow(page);

    await pressToolbarItem(page, TOOLBAR_SLOT.blockType);

    expect([await readBlockTypeLabel(page), await readMarkedLabels(page)])
      .toEqual([BLOCK_KIND_MESSAGE_KEY.codeBlock, []]);
  });

  test('lays out the block type item with the current kind\'s label on the left and the chevron to its right', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    await settleFollow(page);

    const layout = await page.locator(BLOCK_TYPE_BUTTON).evaluate((button) => ({
      labelRight: button.querySelector('.toolbar-label')?.getBoundingClientRect().right ?? Number.NaN,
      markLeft: button.querySelector('svg')?.getBoundingClientRect().left ?? Number.NaN,
    }));

    expect(layout.labelRight <= layout.markLeft).toBe(true);
  });

  test('shows a marked item by an accent tint and bold text without a border in a light theme, and adds the accent border in a high contrast theme', async ({ page }) => {
    await openEditor(page, '\n<blockquote>abcd</blockquote>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} blockquote`, childIndex: 0, offset: 2 });
    await settleFollow(page);
    await applyTheme(page, LIGHT_THEME);
    await pressToolbarItem(page, TOOLBAR_SLOT.blockType);
    const marked = page.locator(`${MENU} button[data-marked]`);
    const light = await marked.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.fontWeight, style.borderTopColor];
    });
    // Read under the light theme, before the high contrast theme changes the accent.
    const tint = await readToolbarColorToken(page, '--bar-on');

    await applyTheme(page, HIGH_CONTRAST_THEME);

    expect([light, await marked.evaluate((element) => getComputedStyle(element).borderTopColor)]).toEqual([
      [tint, '600', 'rgba(0, 0, 0, 0)'],
      HIGH_CONTRAST_THEME.variables['--vscode-textLink-foreground'],
    ]);
  });

  test('moving the selection with the popup open keeps it open and moves only the marks', async ({ page }) => {
    await openEditor(page, '\n<p>abcd</p>\n<h3>efgh</h3>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    await settleFollow(page);
    await pressToolbarItem(page, TOOLBAR_SLOT.blockType);

    await placeCaret(page, { selector: `${EDITOR_ROOT} h3`, childIndex: 0, offset: 2 });
    await settleFollow(page);

    expect([await page.locator(MENU).count(), await readMarkedLabels(page)])
      .toEqual([1, [BLOCK_KIND_MESSAGE_KEY.heading3]]);
  });

  test('moving the caret between the kinds with the shortest and longest labels does not shift the item right of block type', async ({ page }) => {
    await openWebviewHost(page, PROBE_BUNDLE_PATH);
    await embedEnglishCatalog(page);
    await sendToWebview(page, {
      type: 'initialize',
      text: `${PROLOGUE}\n<blockquote data-alert="tip">abcd</blockquote>\n<pre><code>efgh</code></pre>\n${EPILOGUE}`,
      documentUri: '',
      resourceRootUri: '',
    });
    await focusEditor(page);
    // An alert blockquote shows its alert kind, and Tip is the shortest of all labels.
    await placeCaret(page, { selector: `${EDITOR_ROOT} blockquote`, childIndex: 0, offset: 2 });
    await settleFollow(page);
    const shortest = await readBlockTypeLabel(page);
    const before = await readItemLeft(page, TOOLBAR_SLOT.bold);

    await placeCaret(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 2 });
    await settleFollow(page);

    expect([shortest, await readBlockTypeLabel(page), await readItemLeft(page, TOOLBAR_SLOT.bold) - before])
      .toEqual([englishMessages['alert.tip'], englishMessages['blockType.codeBlock'], 0]);
  });
});

test.describe('Showing the floating menu', () => {
  test('selecting a range in the body shows the floating menu near the selection', async ({ page }) => {
    await openEditor(page, BODY);

    await selectIn(page, `${EDITOR_ROOT} p`, 1, 3);
    await settleFollow(page);

    // The placement is above or below the selection; if it is far away, it was placed somewhere else.
    expect(await page.evaluate((selector) => {
      const menu = document.querySelector(selector)?.getBoundingClientRect();
      const selected = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
      if (menu === undefined || selected === undefined) {
        return 'no rect';
      }
      return Math.min(
        Math.abs(selected.top - menu.bottom),
        Math.abs(menu.top - selected.bottom),
      ) < 20;
    }, FLOATING)).toBe(true);
  });

  test('selecting a range on the first line does not overlap the menu with the fixed toolbar', async ({ page }) => {
    await openEditor(page, BODY);

    await selectIn(page, `${EDITOR_ROOT} p`, 1, 3);
    await settleFollow(page);

    expect(await page.evaluate((argument) => {
      const menu = document.querySelector(argument.floating)?.getBoundingClientRect();
      const toolbar = document.querySelector(argument.toolbar)?.getBoundingClientRect();
      if (menu === undefined || toolbar === undefined) {
        return 'no rect';
      }
      return menu.top >= toolbar.bottom;
    }, { floating: FLOATING, toolbar: TOOLBAR })).toBe(true);
  });

  test('keeps the menu inside the visible width for a selection at the right end, even when its width has a fraction below half a pixel', async ({ page }) => {
    await openEditor(page, BODY);
    // A width that whole-pixel measurement rounds down, whatever the font. Centered on a selection at the right end,
    // it runs past the right edge and is pulled back in.
    await page.addStyleTag({ content: `${EDITOR_ROOT} p { text-align: right; } ${FLOATING} { box-sizing: border-box; width: 400.25px; }` });

    await selectIn(page, `${EDITOR_ROOT} p`, 1, 3);
    await settleFollow(page);

    expect(await page.locator(FLOATING).evaluate((element) => {
      const menu = element.getBoundingClientRect();
      return [menu.width, menu.right <= window.innerWidth];
    })).toEqual([400.25, true]);
  });

  test('a caret alone does not show it', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);

    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    await settleFollow(page);

    expect(await isFloatingVisible(page)).toBe(false);
  });

  test('clearing the selection while shown hides it', async ({ page }) => {
    await openEditor(page, BODY);
    await selectIn(page, `${EDITOR_ROOT} p`, 1, 3);
    await settleFollow(page);

    await clearSelection(page);
    await settleFollow(page);

    expect(await isFloatingVisible(page)).toBe(false);
  });

  test('selecting a bold range makes the menu bold pressed and gives clear formatting no pressed marker', async ({ page }) => {
    await openEditor(page, '\n<p><strong>abcd</strong></p>\n');

    await selectIn(page, `${EDITOR_ROOT} strong`, 1, 3);
    await settleFollow(page);

    expect(await page.locator(`${FLOATING} button`).evaluateAll((buttons) => buttons.map(
      (button) => [button.getAttribute('data-slot'), button.getAttribute('aria-pressed')],
    ))).toEqual([
      [TOOLBAR_SLOT.bold, 'true'],
      [TOOLBAR_SLOT.italic, 'false'],
      [TOOLBAR_SLOT.inlineCode, 'false'],
      [TOOLBAR_SLOT.clearFormatting, null],
      // The link item copies whether the link is formatted, so it has a pressed state, false for a bold range
      // outside links.
      [TOOLBAR_SLOT.link, 'false'],
      // Like Clear, the comment button does not represent a current state, so it has no pressed state.
      [TOOLBAR_SLOT.comment, null],
    ]);
  });

  test('selecting only inside pre still shows it, and pressing does not change the tree', async ({ page }) => {
    await openEditor(page, '\n<pre><code>abcd</code></pre>\n');
    await selectIn(page, `${EDITOR_ROOT} code`, 1, 3);
    await settleFollow(page);

    await page.locator(`${FLOATING} button[data-slot="${TOOLBAR_SLOT.bold}"]`).click();

    expect([await isFloatingVisible(page), await readBodyHtml(page)])
      .toEqual([true, '\n<pre><code>abcd</code></pre>\n']);
  });

  test('the component floats above the body as a bordered glass capsule, and lays items out horizontally', async ({ page }) => {
    await openEditor(page, BODY);

    await selectIn(page, `${EDITOR_ROOT} p`, 1, 3);
    await settleFollow(page);

    expect(await page.locator(FLOATING).evaluate((element) => {
      const style = getComputedStyle(element);
      const items = [...element.querySelectorAll('button')];
      return {
        position: style.position,
        glass: style.backdropFilter !== 'none',
        bordered: style.borderTopWidth !== '0px',
        lined: items[1].getBoundingClientRect().left > items[0].getBoundingClientRect().left,
      };
    })).toEqual({
      position: 'fixed',
      glass: true,
      bordered: true,
      lined: true,
    });
  });

  test('a menu item icon has the same shape as the same item icon in the fixed toolbar', async ({ page }) => {
    await openEditor(page, BODY);
    await selectIn(page, `${EDITOR_ROOT} p`, 1, 3);
    await settleFollow(page);

    const shapes = await page.evaluate((argument) => [
      argument.floating,
      argument.toolbar,
    ].map((selector) => document.querySelector(`${selector} path`)?.getAttribute('d') ?? null), {
      floating: `${FLOATING} button[data-slot="${TOOLBAR_SLOT.bold}"]`,
      toolbar: `${TOOLBAR} [data-slot="${TOOLBAR_SLOT.bold}"] > button`,
    });

    expect(shapes[0]).toBe(shapes[1]);
  });

  test('rounds the corners of the menu with a 0.95em radius and gives it a shadow', async ({ page }) => {
    await openEditor(page, BODY);

    await selectIn(page, `${EDITOR_ROOT} p`, 1, 3);
    await settleFollow(page);

    expect(await page.locator(FLOATING).evaluate((element) => {
      const style = getComputedStyle(element);
      const radius = 0.95 * parseFloat(style.fontSize);
      return [
        Math.abs(parseFloat(style.borderTopLeftRadius) - radius) < 0.01,
        Math.abs(parseFloat(style.borderBottomRightRadius) - radius) < 0.01,
        style.boxShadow !== 'none',
      ];
    })).toEqual([true, true, true]);
  });

  test('gives a menu item under the pointer the hover tile', async ({ page }) => {
    await openEditor(page, BODY);
    await applyTheme(page, LIGHT_THEME);
    await selectIn(page, `${EDITOR_ROOT} p`, 1, 3);
    await settleFollow(page);
    const italic = page.locator(`${FLOATING} button[data-slot="${TOOLBAR_SLOT.italic}"]`);

    await italic.hover();

    expect(await italic.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe(await readToolbarColorToken(page, '--bar-hover'));
  });
});

test.describe('Floating menu operations and updates', () => {
  test('pressing bold in the menu applies bold while keeping selection and focus, and the menu stays open', async ({ page }) => {
    await openEditor(page, BODY);
    await selectIn(page, `${EDITOR_ROOT} p`, 1, 3);
    await settleFollow(page);

    await page.locator(`${FLOATING} button[data-slot="${TOOLBAR_SLOT.bold}"]`).click();
    await settleFollow(page);

    expect([
      await readBodyHtml(page),
      await page.evaluate(() => window.getSelection()?.toString() ?? ''),
      await isFloatingVisible(page),
    ]).toEqual(['\n<p>a<strong>bc</strong>d</p>\n', 'bc', true]);
  });

  test('pressing a menu item during IME composition does not change the tree and composition continues', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 4 });
    const ime = await page.context().newCDPSession(page);
    await ime.send('Input.imeSetComposition', { text: 'あいう', selectionStart: 3, selectionEnd: 3 });
    await selectIn(page, `${EDITOR_ROOT} p`, 4, 7);
    await settleFollow(page);
    const composed = await readBodyHtml(page);

    await page.locator(`${FLOATING} button[data-slot="${TOOLBAR_SLOT.bold}"]`).click();

    expect([
      await readBodyHtml(page),
      await page.evaluate(() => window.__editingSessionProbe?.()?.isComposing ?? false),
    ]).toEqual([composed, true]);
  });

  test('adding an input stop reason does not hide it, and pressing in the meantime does not change the tree', async ({ page }) => {
    await openEditor(page, BODY);
    await selectIn(page, `${EDITOR_ROOT} p`, 1, 3);
    await settleFollow(page);

    await page.evaluate((reason) => {
      window.__uiShellProbe?.()?.overlay.present(reason, { heading: '', descriptions: [], actions: [] });
    }, INPUT_STOP_REASON.saveRoundTrip);
    await settleFollow(page);
    // The overlay covers the screen, so a real press would hit the overlay. Deliver the press to the item itself to verify the check.
    await page.locator(`${FLOATING} button[data-slot="${TOOLBAR_SLOT.bold}"]`).dispatchEvent('click');

    expect([await isFloatingVisible(page), await readBodyHtml(page)]).toEqual([true, BODY]);
  });

  test('opening an action dialog hides it, and it reappears when cancel restores the selection', async ({ page }) => {
    await openEditor(page, BODY);
    await selectIn(page, `${EDITOR_ROOT} p`, 1, 3);
    await settleFollow(page);

    await page.evaluate(() => {
      void window.__uiShellProbe?.()?.actionDialog.open({
        title: 'link',
        fields: [{ name: 'href', label: 'href', initialValue: '' }],
        confirmLabel: 'ok',
        cancelLabel: 'cancel',
      });
    });
    const whileOpen = await isFloatingVisible(page);
    await page.evaluate(() => window.__uiShellProbe?.()?.actionDialog.cancel());

    await expect.poll(async () => [whileOpen, await isFloatingVisible(page)]).toEqual([false, true]);
  });

  test('when scrolling moves the selection out of the viewport, the menu does not stay and leaves the screen too', async ({ page }) => {
    await openEditor(page, `\n<p>abcd</p>\n${'<p>x</p>\n'.repeat(200)}`);
    await selectIn(page, `${EDITOR_ROOT} p`, 1, 3);
    await settleFollow(page);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    await expect.poll(() => page.locator(FLOATING)
      .evaluate((element) => element.getBoundingClientRect().bottom < 0)).toBe(true);
  });

  test('lists the floating menu items in the order bold, italic, inline code, clear formatting, link, comment from the first display after a range is selected', async ({ page }) => {
    await openEditor(page, BODY);

    await selectIn(page, `${EDITOR_ROOT} p`, 1, 3);
    await settleFollow(page);

    expect(await readFloatingSlots(page)).toEqual(FLOATING_SLOTS);
  });

  test('reading the body output while shown does not include the menu element', async ({ page }) => {
    await openEditor(page, BODY);
    await selectIn(page, `${EDITOR_ROOT} p`, 1, 3);
    await settleFollow(page);

    const output = await page.evaluate(() => window.__serializationProbe?.()?.body ?? '');

    expect([await isFloatingVisible(page), output]).toEqual([true, BODY]);
  });

  test('after document replacement there is still one component, and the post-replacement evaluation decides its display', async ({ page }) => {
    await openEditor(page, BODY);
    await selectIn(page, `${EDITOR_ROOT} p`, 1, 3);
    await settleFollow(page);

    await page.evaluate(
      (text) => window.__documentReplacementProbe?.(text),
      `${PROLOGUE}\n<p>efgh</p>\n${EPILOGUE}`,
    );
    await clearSelection(page);
    await settleFollow(page);

    expect([await page.locator(FLOATING).count(), await isFloatingVisible(page)])
      .toEqual([1, false]);
  });

  test('opening an action dialog before mounting throws nothing when the close port is called', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openWebviewHost(page, PROBE_BUNDLE_PATH);

    await page.evaluate(() => {
      void window.__uiShellProbe?.()?.actionDialog.open({
        title: 'link',
        fields: [],
        confirmLabel: 'ok',
        cancelLabel: 'cancel',
      });
    });

    expect([errors, await page.locator(FLOATING).count()]).toEqual([[], 0]);
  });
});

test.describe('Placing the floating menu beside a scrollbar', () => {
  test('keeps the menu clear of a vertical scrollbar for a selection at the right end', async () => {
    // Headless Chromium hides scrollbars by default, which would hide the bug, and launch options cannot be set inside a
    // group. So this case launches its own browser with the native scrollbar shown.
    const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
    try {
      const page = await browser.newPage();
      await openEditor(page, `\n<p>abcd</p>\n<p style="height: 3000px">spacer</p>\n`);
      await page.addStyleTag({ content: `${EDITOR_ROOT} p { text-align: right; }` });
      // The view must have lost width to the scrollbar, or the check below would pass without checking anything.
      const visibleWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(visibleWidth).toBeLessThan(page.viewportSize()?.width ?? 0);

      await selectIn(page, `${EDITOR_ROOT} p`, 1, 4);
      await settleFollow(page);

      await expect(page.locator(FLOATING)).toBeVisible();
      const right = await page.locator(FLOATING).evaluate((element) => element.getBoundingClientRect().right);
      expect(right).toBeLessThanOrEqual(visibleWidth);
    } finally {
      await browser.close();
    }
  });
});
