import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { ALERT_KINDS, EDITOR_ROOT_ELEMENT_ID, VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import type { AlertKind } from '../../common/index';
import { ALERT_MESSAGE_KEY } from '../../webview/ui/alert-items';
import { BLOCK_KIND_MESSAGE_KEY, BLOCK_TYPE_MENU_CLASS } from '../../webview/ui/block-type-menu';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import {
  EDITOR_ROOT,
  focusEditor,
  openEditor,
  placeCaret,
  readBodyHtml,
} from './helpers/editing';
import { getOutboundMessages } from './helpers/page';

const BODY = '\n<p>abcd</p>\n';
const QUOTE_BODY = '\n<blockquote>abcd</blockquote>\n';
const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;
const MENU = `.${BLOCK_TYPE_MENU_CLASS}`;
const QUOTE = `${EDITOR_ROOT} blockquote`;

// No catalog is embedded, so each message is displayed as its key.
const ALERT_ITEM_LABELS = ALERT_KINDS.map((kind) => ALERT_MESSAGE_KEY[kind]);

// The item that clears the alert: the quote item of the menu, which calls the alert operation with the selection none.
const QUOTE_ITEM_LABEL = BLOCK_KIND_MESSAGE_KEY.quote;

/** The colors a light, a dark, and a high contrast theme give. */
const THEME_COLORS = [
  { background: 'rgb(255, 255, 255)', foreground: 'rgb(31, 35, 40)' },
  { background: 'rgb(31, 31, 31)', foreground: 'rgb(204, 204, 204)' },
  { background: 'rgb(0, 0, 0)', foreground: 'rgb(255, 255, 255)' },
];

/**
 * Presses a toolbar item.
 *
 * @param page The page to operate.
 * @param slot The slot of the item to press.
 */
async function pressToolbarItem(page: Page, slot: string): Promise<void> {
  await page.locator(`${TOOLBAR} [data-slot="${slot}"] > button`).click();
}

/**
 * Opens the block type menu and presses an alert item, or the quote item that clears the alert.
 *
 * @param page The page to operate.
 * @param label The accessible name of the item to press.
 */
async function chooseAlertItem(page: Page, label: string): Promise<void> {
  await pressToolbarItem(page, TOOLBAR_SLOT.blockType);
  await page.locator(`${MENU} button[aria-label="${label}"]`).click();
}

/**
 * Delivers a press to an item of the open popup without going through its position.
 *
 * While the overlay is up, the overlay takes the pointer hit testing. The press is sent straight to the element so
 * that what is looked at is the press reaching the item and still nothing happening.
 *
 * @param page The page to operate.
 * @param label The accessible name of the item to press.
 */
async function pressItemDirectly(page: Page, label: string): Promise<void> {
  await page.locator(`${MENU} button[aria-label="${label}"]`).dispatchEvent('click');
}

/**
 * Reads the accessible names of the items in the open popup, in order.
 *
 * @param page The page to operate.
 * @returns The accessible names.
 */
async function readMenuLabels(page: Page): Promise<(string | null)[]> {
  return page.locator(`${MENU} button`)
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
}

/**
 * Places the caret at a position inside an element.
 *
 * @param page The page to operate.
 * @param selector The selector that finds the element.
 * @param offset The position within the element.
 */
async function placeCaretInElement(page: Page, selector: string, offset: number): Promise<void> {
  await page.evaluate((argument) => {
    const element = document.querySelector(argument.selector);
    if (element === null) {
      throw new Error(`element not found: ${argument.selector}`);
    }
    const range = document.createRange();
    range.setStart(element, argument.offset);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { selector, offset });
}

/**
 * Selects between two positions and leaves the focus on the editor root.
 *
 * @param page The page to operate.
 * @param selector The selector that finds the element holding the text.
 * @param start The character position of the start.
 * @param end The character position of the end.
 */
async function selectInElement(
  page: Page,
  selector: string,
  start: number,
  end: number,
): Promise<void> {
  await page.evaluate((argument) => {
    const text = document.querySelector(argument.selector)?.firstChild;
    if (text === null || text === undefined) {
      throw new Error(`text not found: ${argument.selector}`);
    }
    const range = document.createRange();
    range.setStart(text, argument.start);
    range.setEnd(text, argument.end);
    document.getElementById(argument.rootId)?.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { selector, start, end, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Reads a computed value of a pseudo-element.
 *
 * @param page The page to operate.
 * @param selector The selector that finds the element.
 * @param pseudo The pseudo-element.
 * @param property The property to read.
 * @returns The computed value.
 */
async function readPseudoStyle(
  page: Page,
  selector: string,
  pseudo: string,
  property: string,
): Promise<string> {
  return page.locator(selector).evaluate(
    (element, argument) =>
      getComputedStyle(element, argument.pseudo).getPropertyValue(argument.property),
    { pseudo, property },
  );
}

/**
 * Applies the colors of a theme. VS Code puts them on the root element, so they are reproduced in the same place.
 *
 * @param page The page to operate.
 * @param colors The theme colors to apply.
 */
async function applyTheme(
  page: Page,
  colors: { background: string; foreground: string },
): Promise<void> {
  await page.evaluate((given) => {
    document.documentElement.style.setProperty('--vscode-editor-background', given.background);
    document.documentElement.style.setProperty('--vscode-editor-foreground', given.foreground);
  }, colors);
}

/** Reads the current form built from the tree being edited. */
async function readCurrentForm(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__serializationProbe?.()?.current);
}

/**
 * Reads the two ends of what the current selection covers, as a pair of a string and a position.
 *
 * Reading the covered string itself would show the boundary between blocks as a different number of newlines for a
 * paragraph than for a blockquote. The characters covered have not changed, so what is looked at is which string
 * each end is in and at which character.
 *
 * @param page The page to operate.
 * @returns The string and the position of the start and of the end.
 */
async function readSelectionBounds(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const range = window.getSelection()?.getRangeAt(0);
    return {
      startText: range?.startContainer.textContent,
      startOffset: range?.startOffset,
      endText: range?.endContainer.textContent,
      endOffset: range?.endOffset,
    };
  });
}

/** Reads the displayed height of the blockquote. */
async function readQuoteHeight(page: Page): Promise<number> {
  return page.locator(QUOTE).evaluate((quote) => quote.getBoundingClientRect().height);
}

/**
 * Returns whether the caret sits inside an element.
 *
 * @param page The page to operate.
 * @param selector The selector that finds the element.
 * @returns `true` when it sits inside.
 */
async function isCaretInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((target) => {
    const anchor = window.getSelection()?.anchorNode ?? null;
    const element = document.querySelector(target);
    return anchor !== null && element !== null && element.contains(anchor);
  }, selector);
}

/**
 * Returns how many of the messages that were sent are of that type.
 *
 * @param page The page to operate.
 * @param type The type of the message.
 * @returns The number of messages.
 */
async function countMessages(page: Page, type: string): Promise<number> {
  const messages = await getOutboundMessages(page);
  return messages.filter((message) => (
    typeof message === 'object' && message !== null && Reflect.get(message, 'type') === type
  )).length;
}

/** Builds a body holding alert blockquotes alone. */
function buildKindsBody(): string {
  return `\n${ALERT_KINDS.map(
    (kind) => `<blockquote data-alert="${kind}">${kind}</blockquote>`,
  ).join('\n')}\n`;
}

/** The selector that points at the alert blockquote of a kind. */
function quoteOf(kind: AlertKind): string {
  return `${EDITOR_ROOT} blockquote[data-alert="${kind}"]`;
}

test.describe('registering the alert items', () => {
  test('lays the five kinds out after the eight kind items, in the order of the list, for thirteen items in all when the popup is opened', async ({ page }) => {
    await openEditor(page, BODY);

    await pressToolbarItem(page, TOOLBAR_SLOT.blockType);

    const labels = await readMenuLabels(page);
    expect([labels.length, labels.slice(8)]).toEqual([13, ALERT_ITEM_LABELS]);
  });

  test('lays out none of the alert items and raises no exception for a document that cannot be opened', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await openEditor(page, '\n<script>a</script>\n');

    expect([await page.locator(TOOLBAR).count(), await page.locator(MENU).count(), pageErrors])
      .toEqual([0, 0, []]);
  });

  test('leaves the tree unchanged when an item is pressed while the overlay is up', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    await pressToolbarItem(page, TOOLBAR_SLOT.blockType);
    await page.evaluate((reason) => {
      window.__uiShellProbe?.()?.overlay.present(reason, { heading: '', descriptions: [], actions: [] });
    }, INPUT_STOP_REASON.saveRoundTrip);

    await pressItemDirectly(page, ALERT_MESSAGE_KEY.note);

    expect(await readBodyHtml(page)).toBe(BODY);
  });
});

test.describe('applying an alert', () => {
  test('turns the paragraph holding the caret into an alert blockquote with a known value when Note is pressed', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await chooseAlertItem(page, ALERT_MESSAGE_KEY.note);

    expect(await readBodyHtml(page)).toBe('\n<blockquote data-alert="note">abcd</blockquote>\n');
  });

  test('turns an alert blockquote into an ordinary one and drops the attribute when the quote item is pressed', async ({ page }) => {
    await openEditor(page, '\n<blockquote data-alert="note">abcd</blockquote>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: QUOTE, childIndex: 0, offset: 2 });

    await chooseAlertItem(page, QUOTE_ITEM_LABEL);

    expect(await readBodyHtml(page)).toBe(QUOTE_BODY);
  });

  test('keeps the value in what gets saved when the quote item is pressed on a blockquote carrying an unknown value', async ({ page }) => {
    const body = '\n<blockquote data-alert="Note">abcd</blockquote>\n';
    await openEditor(page, body);
    await focusEditor(page);
    await placeCaret(page, { selector: QUOTE, childIndex: 0, offset: 2 });

    await chooseAlertItem(page, QUOTE_ITEM_LABEL);

    expect(await readCurrentForm(page)).toBe(body);
  });

  test('makes an ordinary blockquote without the attribute when the quote item is pressed on a paragraph left with a known alert attribute', async ({ page }) => {
    await openEditor(page, '\n<p data-alert="note">abcd</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await chooseAlertItem(page, QUOTE_ITEM_LABEL);

    expect(await readBodyHtml(page)).toBe(QUOTE_BODY);
  });

  test('turns every paragraph into an alert blockquote and leaves the selection covering the same string when a kind is pressed with a selection spanning several paragraphs', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n<p>cd</p>\n');
    await focusEditor(page);
    await page.evaluate((rootId) => {
      const paragraphs = document.getElementById(rootId)?.querySelectorAll('p') ?? [];
      const range = document.createRange();
      range.setStart(paragraphs[0].firstChild ?? paragraphs[0], 1);
      range.setEnd(paragraphs[1].firstChild ?? paragraphs[1], 1);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, EDITOR_ROOT_ELEMENT_ID);
    const covered = await readSelectionBounds(page);

    await chooseAlertItem(page, ALERT_MESSAGE_KEY.tip);

    expect([await readBodyHtml(page), await readSelectionBounds(page)]).toEqual([
      '\n<blockquote data-alert="tip">ab</blockquote>\n<blockquote data-alert="tip">cd</blockquote>\n',
      covered,
    ]);
  });

  test('sends exactly one committed edit unit to the host for a single alert operation', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await chooseAlertItem(page, ALERT_MESSAGE_KEY.note);

    await expect
      .poll(() => countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction))
      .toBe(1);
  });

  test('creates an empty alert blockquote when a kind is pressed in an empty document with nothing typed into it', async ({ page }) => {
    await openEditor(page, '');

    await chooseAlertItem(page, ALERT_MESSAGE_KEY.caution);

    expect(await readBodyHtml(page)).toBe('\n<blockquote data-alert="caution"><br></blockquote>');
  });

  test('returns the body to the same form as the input across a round trip of applying an alert and saving', async ({ page }) => {
    await openEditor(page, QUOTE_BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: QUOTE, childIndex: 0, offset: 2 });

    await chooseAlertItem(page, ALERT_MESSAGE_KEY.important);
    await chooseAlertItem(page, QUOTE_ITEM_LABEL);

    expect(await readCurrentForm(page)).toBe(QUOTE_BODY);
  });
});

test.describe('displaying an alert', () => {
  test('shows the label of the message of each kind on the blockquotes carrying the five known values', async ({ page }) => {
    await openEditor(page, buildKindsBody());

    const labels: string[] = [];
    for (const kind of ALERT_KINDS) {
      labels.push(await readPseudoStyle(page, quoteOf(kind), '::after', 'content'));
    }

    expect(labels).toEqual(ALERT_KINDS.map((kind) => `"${ALERT_MESSAGE_KEY[kind]}"`));
  });

  test('shows a different icon per kind, none of which matches the background color under any of the three themes', async ({ page }) => {
    await openEditor(page, buildKindsBody());

    const icons: string[] = [];
    for (const kind of ALERT_KINDS) {
      icons.push(await readPseudoStyle(page, quoteOf(kind), '::before', 'mask-image'));
    }
    const matched: string[] = [];
    for (const colors of THEME_COLORS) {
      await applyTheme(page, colors);
      const background = await page.locator('body')
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      for (const kind of ALERT_KINDS) {
        const drawn = await readPseudoStyle(page, quoteOf(kind), '::before', 'background-color');
        if (drawn === background) {
          matched.push(`${kind}: ${drawn}`);
        }
      }
    }

    // The shape itself differs per kind, so a kind can be told apart without relying on color. Were one to take
    // the same color as the background, that one would disappear.
    expect([new Set(icons).size, matched]).toEqual([ALERT_KINDS.length, []]);
  });

  test('gives an alert blockquote a border color different from that of an ordinary one', async ({ page }) => {
    await openEditor(page, '\n<blockquote data-alert="note">a</blockquote>\n<blockquote>b</blockquote>\n');

    const colors = await page.locator(QUOTE).evaluateAll(
      (quotes) => quotes.map((quote) => getComputedStyle(quote).borderLeftColor),
    );

    expect(colors[0]).not.toBe(colors[1]);
  });

  test('shows neither the label nor the icon in the tree or in the body output', async ({ page }) => {
    const body = '\n<blockquote data-alert="note">abcd</blockquote>\n';
    await openEditor(page, body);

    const text = await page.locator(QUOTE).evaluate((quote) => quote.textContent);

    expect([await readBodyHtml(page), text, await readCurrentForm(page)])
      .toEqual([body, 'abcd', body]);
  });

  test('gives a blockquote carrying an unknown value the same appearance as an ordinary one and keeps the value in the tree', async ({ page }) => {
    await openEditor(page, '\n<blockquote data-alert="Note">a</blockquote>\n<blockquote>b</blockquote>\n');

    const appearances = await page.locator(QUOTE).evaluateAll((quotes) => quotes.map((quote) => [
      getComputedStyle(quote).borderLeftColor,
      getComputedStyle(quote).paddingTop,
      getComputedStyle(quote, '::before').content,
      getComputedStyle(quote, '::after').content,
    ]));

    expect([appearances[0], await page.locator(`${EDITOR_ROOT} [data-alert="Note"]`).count()])
      .toEqual([appearances[1], 1]);
  });

  test('shows neither a label nor an icon for an alert attribute left on a paragraph', async ({ page }) => {
    await openEditor(page, '\n<p data-alert="note">a</p>\n');

    const contents = await page.locator(`${EDITOR_ROOT} p`).evaluate((paragraph) => [
      getComputedStyle(paragraph, '::before').content,
      getComputedStyle(paragraph, '::after').content,
    ]);

    expect(contents).toEqual(['none', 'none']);
  });
});

test.describe('Enter inside a bare blockquote', () => {
  test('inserts an in-block break without splitting the blockquote when Enter is pressed partway through a bare one', async ({ page }) => {
    await openEditor(page, QUOTE_BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: QUOTE, childIndex: 0, offset: 2 });

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<blockquote>ab<br>cd</blockquote>\n');
  });

  test('shows a blank line and moves the caret onto it when Enter is pressed at the end of the content of a bare blockquote', async ({ page }) => {
    await openEditor(page, QUOTE_BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: QUOTE, childIndex: 0, offset: 4 });
    const before = await readQuoteHeight(page);

    await page.keyboard.press('Enter');
    const inserted = await readBodyHtml(page);
    const grew = await readQuoteHeight(page) > before;
    await page.keyboard.type('X');

    // The trailing `br` does not make its own line show. Without another one, the line the caret was placed on
    // would stay invisible. That the caret is on that line shows in the typed character landing after the `br`.
    // A line holding a character shows on its own, so the browser drops the trailing `br` that was making it show.
    expect([inserted, grew, await readBodyHtml(page)]).toEqual([
      '\n<blockquote>abcd<br><br></blockquote>\n',
      true,
      '\n<blockquote>abcd<br>X</blockquote>\n',
    ]);
  });

  test('leaves the blockquote and moves the caret into the empty paragraph right after it when Enter is pressed twice at the end', async ({ page }) => {
    await openEditor(page, QUOTE_BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: QUOTE, childIndex: 0, offset: 4 });

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    expect([await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} p`)])
      .toEqual(['\n<blockquote>abcd<br></blockquote>\n<p><br></p>\n', true]);
  });

  test('leaves no blank line at the end of the blockquote in the body saved after the exit', async ({ page }) => {
    await openEditor(page, QUOTE_BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: QUOTE, childIndex: 0, offset: 4 });

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    expect(await readCurrentForm(page)).toBe('\n<blockquote>abcd</blockquote>\n<p><br></p>\n');
  });

  test('does not leave a blockquote with empty content on the first Enter but leaves on the second, keeping the blockquote empty', async ({ page }) => {
    await openEditor(page, '\n<blockquote><br></blockquote>\n');
    await focusEditor(page);
    await placeCaretInElement(page, QUOTE, 0);

    await page.keyboard.press('Enter');
    const afterFirst = await readBodyHtml(page);
    await page.keyboard.press('Enter');

    expect([afterFirst, await readBodyHtml(page)]).toEqual([
      '\n<blockquote><br><br></blockquote>\n',
      '\n<blockquote><br></blockquote>\n<p><br></p>\n',
    ]);
  });

  test('leaves a blockquote whose last line ends inside a format element as well when Enter is pressed twice at the end', async ({ page }) => {
    await openEditor(page, '\n<blockquote>ab<strong>cd</strong></blockquote>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${QUOTE} strong`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    // A break inside a format element is a trailing line of the blockquote too. Without counting it, breaks would
    // keep piling up and the blockquote could never be left.
    expect(await readBodyHtml(page))
      .toBe('\n<blockquote>ab<strong>cd<br></strong></blockquote>\n<p><br></p>\n');
  });

  test('deletes the range and inserts an in-block break for Enter with a range selected inside a bare blockquote', async ({ page }) => {
    await openEditor(page, QUOTE_BODY);
    await selectInElement(page, QUOTE, 1, 3);

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<blockquote>a<br>d</blockquote>\n');
  });

  test('splits the paragraph on Enter inside a blockquote that holds paragraphs as children', async ({ page }) => {
    await openEditor(page, '\n<blockquote><p>abcd</p></blockquote>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${QUOTE} p`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<blockquote><p>ab</p>\n<p>cd</p></blockquote>\n');
  });

  test('creates the paragraph right after the blockquote within the same cell for a blockquote inside a cell as well', async ({ page }) => {
    const body = '\n<table><tbody><tr><td><blockquote>ab<br><br></blockquote></td></tr></tbody></table>\n';
    await openEditor(page, body);
    await focusEditor(page);
    await placeCaretInElement(page, QUOTE, 2);

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe(
      '\n<table><tbody><tr><td><blockquote>ab<br></blockquote>\n<p><br></p></td></tr></tbody></table>\n',
    );
  });

  test('gives the same result for Enter whether or not the alert attribute is there, and keeps the attribute across the exit', async ({ page }) => {
    await openEditor(page, '\n<blockquote data-alert="note">abcd</blockquote>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: QUOTE, childIndex: 0, offset: 4 });

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page))
      .toBe('\n<blockquote data-alert="note">abcd<br></blockquote>\n<p><br></p>\n');
  });

  test('works the same way for Enter in a bare blockquote after the document is replaced, with the rule not lost', async ({ page }) => {
    await openEditor(page, BODY);
    await page.evaluate(
      (text) => window.__documentReplacementProbe?.(text),
      `${PROLOGUE}\n<blockquote>ab<br><br></blockquote>\n${EPILOGUE}`,
    );
    await focusEditor(page);
    await placeCaretInElement(page, QUOTE, 2);

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<blockquote>ab<br></blockquote>\n<p><br></p>\n');
  });
});

test.describe('Enter in the trailing quote paragraph', () => {
  test('leaves the blockquote and moves the caret into the empty paragraph right after it when Enter is pressed in the empty last paragraph of a blockquote holding paragraphs', async ({ page }) => {
    await openEditor(page, '\n<blockquote><p>ab</p>\n<p><br></p></blockquote>\n');
    await focusEditor(page);
    await placeCaretInElement(page, `${QUOTE} p:last-of-type`, 0);

    await page.keyboard.press('Enter');

    expect([await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} > p`)])
      .toEqual(['\n<blockquote><p>ab</p></blockquote>\n<p><br></p>\n', true]);
  });

  test('leaves the code block for a paragraph and then the blockquote when Enter is pressed three times at the end of a code block inside a blockquote', async ({ page }) => {
    await openEditor(page, '\n<blockquote><pre><code>ab</code></pre></blockquote>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${QUOTE} code`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    const leftCode = await readBodyHtml(page);
    await page.keyboard.press('Enter');

    expect([leftCode, await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} > p`)]).toEqual([
      '\n<blockquote><pre><code>ab</code></pre>\n<p><br></p></blockquote>\n',
      '\n<blockquote><pre><code>ab</code></pre></blockquote>\n<p><br></p>\n',
      true,
    ]);
  });

  test('splits the paragraph and stays inside the blockquote when Enter is pressed in an empty paragraph that is not the last', async ({ page }) => {
    await openEditor(page, '\n<blockquote><p><br></p>\n<p>ab</p></blockquote>\n');
    await focusEditor(page);
    await placeCaretInElement(page, `${QUOTE} p:first-of-type`, 0);

    await page.keyboard.press('Enter');

    expect([await readBodyHtml(page), await isCaretInside(page, QUOTE)])
      .toEqual(['\n<blockquote><p><br></p>\n<p><br></p>\n<p>ab</p></blockquote>\n', true]);
  });
});
