import { devices, expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  MESSAGE_CATALOG_ELEMENT_ID,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import type { EditTransactionMessage } from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { CHANGE_POPUP_ELEMENT_ID } from '../../webview/ui/change-popup';
import { COMMENT_POPUP_ELEMENT_ID } from '../../webview/ui/comment-popup';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import { EDITOR_ROOT } from './helpers/editing';
import { PROBE_BUNDLE_PATH, getOutboundMessages, openWebviewHost, sendToWebview } from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const POPUP = `#${CHANGE_POPUP_ELEMENT_ID}`;
const COMMENT_POPUP = `#${COMMENT_POPUP_ELEMENT_ID}`;
const HEADER = `${POPUP} .change-popup-header`;
const META = `${POPUP} .change-popup-meta > span`;
const ACCEPT = `${POPUP} .change-popup-accept`;
const REJECT = `${POPUP} .change-popup-reject`;
const INSERTION = `${EDITOR_ROOT} ins`;
const DELETION = `${EDITOR_ROOT} del`;

/** The fixed colors of the two kinds and their translucent backgrounds, as the stylesheet defines them. */
const INSERTION_COLOR = 'rgb(31, 138, 58)';
const INSERTION_BACKGROUND = 'rgba(46, 160, 67, 0.22)';
const DELETION_COLOR = 'rgb(209, 52, 61)';
const DELETION_BACKGROUND = 'rgba(248, 81, 73, 0.2)';

/** An insertion by an agent between plain text, followed by another paragraph. */
const INSERTION_IN_TEXT = '<p>a<ins data-author="ai" data-updated="2026-10-07T01:02:03.000Z">b</ins>c</p><p>d</p>';

/** A deletion by an agent between plain text. */
const DELETION_IN_TEXT = '<p>a<del data-author="ai" data-updated="2026-10-07T01:02:03.000Z">b</del>c</p>';

/** A deletion followed at once by an insertion from the same agent: one replacement. */
const REPLACEMENT_IN_TEXT = '<p>The cache is cleared every '
  + '<del data-author="ai" data-updated="2026-10-07T01:02:03.000Z">hour</del>'
  + '<ins data-author="ai" data-updated="2026-10-07T01:02:03.000Z">30 minutes</ins>.</p>';

/** Theme variables of the light, dark and high contrast themes. */
const THEMES: Record<string, string>[] = [
  { '--vscode-editor-background': '#ffffff', '--vscode-editor-foreground': '#3b3b3b' },
  { '--vscode-editor-background': '#1f1f1f', '--vscode-editor-foreground': '#cccccc' },
  { '--vscode-editor-background': '#000000', '--vscode-editor-foreground': '#ffffff' },
];

// The view decides the primary modifier from the user agent, but the Desktop Chrome descriptor gives a Windows user
// agent regardless of the OS. Registered shortcuts are pressed with real keystrokes, so the user agent follows the OS.
const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
test.use({ userAgent: process.platform === 'darwin' ? MAC_USER_AGENT : devices['Desktop Chrome'].userAgent });

/**
 * Embeds the English message catalog and then mounts the body, so that the names users see can be checked.
 *
 * @param page The page to operate on.
 * @param body The body to mount.
 */
async function openChangeEditor(page: Page, body: string): Promise<void> {
  await openWebviewHost(page, PROBE_BUNDLE_PATH);
  await page.evaluate((argument) => {
    const element = document.createElement('script');
    element.type = 'application/json';
    element.id = argument.elementId;
    element.textContent = argument.catalog;
    document.head.append(element);
  }, { elementId: MESSAGE_CATALOG_ELEMENT_ID, catalog: JSON.stringify(englishMessages) });
  await sendToWebview(page, {
    type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
    text: `${PROLOGUE}${body}${EPILOGUE}`,
    documentUri: '',
    resourceRootUri: '',
  });
}

/**
 * Clicks the first element the selector matches and waits for the change popup to open.
 *
 * @param page The page to operate on.
 * @param selector The selector of the mark.
 */
async function openByClick(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().click({ position: { x: 2, y: 5 } });
  await expect(page.locator(POPUP)).toBeVisible();
}

/**
 * Moves focus to the editor root and places the caret in the first text of an element.
 *
 * @param page The page to operate on.
 * @param selector The selector of the element.
 * @param offset The offset in the text.
 */
async function placeCaretIn(page: Page, selector: string, offset: number): Promise<void> {
  await page.evaluate((argument) => {
    const node = document.querySelector(argument.selector)?.firstChild;
    if (node === null || node === undefined) {
      throw new Error(`node not found: ${argument.selector}`);
    }
    document.getElementById(argument.rootId)?.focus();
    const range = document.createRange();
    range.setStart(node, argument.offset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { selector, offset, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Reads the text from the start of the editor root to the start of the selection.
 *
 * @param page The page to operate on.
 * @returns The text. `null` if there is no selection.
 */
async function readCaretPrefix(page: Page): Promise<string | null> {
  return page.evaluate((rootId) => {
    const root = document.getElementById(rootId);
    const selection = window.getSelection();
    if (root === null || selection === null || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const before = document.createRange();
    before.setStart(root, 0);
    before.setEnd(range.startContainer, range.startOffset);
    return before.toString();
  }, EDITOR_ROOT_ELEMENT_ID);
}

/**
 * Describes where focus is: `editor` for the editor root, `popup` for the change popup itself, the text of a button
 * inside it, and the tag name otherwise.
 *
 * @param page The page to operate on.
 */
async function readFocus(page: Page): Promise<string> {
  return page.evaluate((ids) => {
    const active = document.activeElement;
    if (active === null) {
      return 'none';
    }
    if (active.id === ids.root) {
      return 'editor';
    }
    if (active.id === ids.popup) {
      return 'popup';
    }
    if (active.closest(`#${ids.popup}`) !== null) {
      return active.textContent ?? '';
    }
    return active.localName;
  }, { root: EDITOR_ROOT_ELEMENT_ID, popup: CHANGE_POPUP_ELEMENT_ID });
}

/**
 * Reads computed styles of the first element the selector matches.
 *
 * @param page The page to operate on.
 * @param selector The selector of the element.
 * @param properties The property names to read.
 */
async function readComputed(page: Page, selector: string, properties: readonly string[]): Promise<string[]> {
  return page.locator(selector).first().evaluate(
    (element, names) => names.map((name) => getComputedStyle(element).getPropertyValue(name)),
    properties,
  );
}

/**
 * Applies theme variables. VS Code puts them on the root element, so put them there too.
 *
 * @param page The page to operate on.
 * @param variables Variable names and values.
 */
async function applyTheme(page: Page, variables: Record<string, string>): Promise<void> {
  await page.evaluate((given) => {
    for (const [name, value] of Object.entries(given)) {
      document.documentElement.style.setProperty(name, value);
    }
  }, variables);
}

/**
 * Reads the body output.
 *
 * @param page The page to operate on.
 */
async function readBodyOutput(page: Page): Promise<string> {
  return page.evaluate(() => window.__serializationProbe?.()?.body ?? '');
}

/**
 * Reads the edit transactions sent to the host, in the order sent.
 *
 * @param page The page to operate on.
 */
async function readTransactions(page: Page): Promise<EditTransactionMessage[]> {
  const messages = await getOutboundMessages(page);
  return messages.filter(
    (message): message is EditTransactionMessage =>
      Reflect.get(Object(message), 'type') === VIEW_TO_HOST_MESSAGE_TYPE.editTransaction,
  );
}

/**
 * Replaces the body through the document replacement entry.
 *
 * @param page The page to operate on.
 * @param body The new body.
 */
async function replaceDocument(page: Page, body: string): Promise<boolean> {
  return page.evaluate((text) => window.__documentReplacementProbe?.(text) ?? false, `${PROLOGUE}${body}${EPILOGUE}`);
}

/**
 * Shows the overlay without content and stops input, with the same reason as the save round trip.
 *
 * @param page The page to operate on.
 */
async function stopInput(page: Page): Promise<void> {
  await page.evaluate((reason) => {
    window.__uiShellProbe?.()?.overlay.present(reason, { heading: '', descriptions: [], actions: [] });
  }, INPUT_STOP_REASON.saveRoundTrip);
}

test.describe('the look of change marks', () => {
  test('in light, dark and high contrast alike, an insertion is underlined in green and a deletion struck through in red, each on its tinted background, while ordinary strikethrough keeps the text color', async ({ page }) => {
    await openChangeEditor(page, '<p><ins>a</ins> <del>b</del> <s>c</s></p>');

    const drawn: unknown[][] = [];
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      const decoration = ['text-decoration-line', 'text-decoration-color', 'background-color'];
      const struck = await readComputed(page, `${EDITOR_ROOT} s`, [...decoration, 'color']);
      drawn.push([
        await readComputed(page, INSERTION, decoration),
        await readComputed(page, DELETION, decoration),
        [struck[0], struck[1] === struck[3]],
      ]);
    }

    // The colors of the kinds are fixed values rather than theme variables, so they are the same in every theme.
    expect(drawn).toEqual(THEMES.map(() => [
      ['underline', INSERTION_COLOR, INSERTION_BACKGROUND],
      ['line-through', DELETION_COLOR, DELETION_BACKGROUND],
      ['line-through', true],
    ]));
  });

  test('a table row that carries a deletion has each of its cells struck through on the tinted background', async ({ page }) => {
    await openChangeEditor(
      page,
      '<table><tbody><tr data-change="del" data-author="ai"><td>a</td><td>b</td></tr><tr><td>c</td></tr></tbody></table>',
    );

    const cells = await page.locator(`${EDITOR_ROOT} td`).evaluateAll((elements) => elements.map((element) => {
      const style = getComputedStyle(element);
      return [style.textDecorationLine, style.textDecorationColor, style.backgroundColor];
    }));

    expect(cells).toEqual([
      ['line-through', DELETION_COLOR, DELETION_BACKGROUND],
      ['line-through', DELETION_COLOR, DELETION_BACKGROUND],
      ['none', cells[2][1], 'rgba(0, 0, 0, 0)'],
    ]);
  });
});

test.describe('the change popup', () => {
  test('clicking an insertion opens a popup near it with the kind, the author and the time and the two decisions, leaves focus in the editor root, and frames the mark', async ({ page }) => {
    await openChangeEditor(page, INSERTION_IN_TEXT);

    await openByClick(page, INSERTION);

    const mark = await page.locator(INSERTION).boundingBox();
    const popup = await page.locator(POPUP).boundingBox();
    expect([
      await page.locator(POPUP).getAttribute('role'),
      await page.locator(POPUP).getAttribute('aria-label'),
      await page.locator(HEADER).textContent(),
      (await page.locator(META).allTextContents()).map((text, index) => (index === 0 ? text : text.length > 0)),
      await page.locator(`${POPUP} button`).allTextContents(),
      await readFocus(page),
      await readComputed(page, INSERTION, ['outline-style', 'outline-width', 'outline-color']),
      mark !== null && popup !== null && popup.y >= mark.y + mark.height && popup.x <= mark.x + mark.width,
    ]).toEqual([
      'dialog',
      'Change',
      'Insertion',
      ['AI', true],
      ['Accept', 'Reject'],
      'editor',
      ['solid', '2px', INSERTION_COLOR],
      true,
    ]);
  });

  test('accepting an insertion keeps its content without the mark in one edit transaction, closes the popup, and puts the caret at the end of the content', async ({ page }) => {
    await openChangeEditor(page, INSERTION_IN_TEXT);
    await openByClick(page, INSERTION);

    await page.locator(ACCEPT).click();

    await expect(page.locator(POPUP)).toBeHidden();
    const transactions = await readTransactions(page);
    expect([
      await readBodyOutput(page),
      transactions.length,
      await readCaretPrefix(page),
      await readFocus(page),
      await page.locator(INSERTION).count(),
    ]).toEqual(['<p>abc</p><p>d</p>', 1, 'ab', 'editor', 0]);
  });

  test('rejecting an insertion takes its content out leaving the caret where it was, and the one edit transaction carries the mark in its before state so that undo brings it back', async ({ page }) => {
    await openChangeEditor(page, INSERTION_IN_TEXT);
    await openByClick(page, INSERTION);

    await page.locator(REJECT).click();

    await expect(page.locator(POPUP)).toBeHidden();
    const transactions = await readTransactions(page);
    expect([
      await readBodyOutput(page),
      transactions.length,
      transactions[0]?.transaction.before.text.includes('<ins '),
      transactions[0]?.transaction.after.text.includes('<ins '),
      await readCaretPrefix(page),
    ]).toEqual(['<p>ac</p><p>d</p>', 1, true, false, 'a']);
  });

  test('accepting a deletion takes its content out, and rejecting one keeps the content without the mark', async ({ page }) => {
    await openChangeEditor(page, DELETION_IN_TEXT);
    await openByClick(page, DELETION);
    await page.locator(ACCEPT).click();
    await expect(page.locator(POPUP)).toBeHidden();
    const accepted = await readBodyOutput(page);

    await openChangeEditor(page, DELETION_IN_TEXT);
    await openByClick(page, DELETION);
    await page.locator(REJECT).click();
    await expect(page.locator(POPUP)).toBeHidden();

    expect([accepted, await readBodyOutput(page), await page.locator(HEADER).textContent()])
      .toEqual(['<p>ac</p>', '<p>abc</p>', 'Deletion']);
  });

  test('rejecting an insertion that fills its paragraph leaves the paragraph a placeholder, so that the line keeps its height and holds the caret', async ({ page }) => {
    await openChangeEditor(page, '<p><ins data-author="ai">only</ins></p><p>d</p>');
    await openByClick(page, INSERTION);

    await page.locator(REJECT).click();

    await expect(page.locator(POPUP)).toBeHidden();
    const heights = await page.locator(`${EDITOR_ROOT} p`).evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
    expect([
      await readBodyOutput(page),
      Math.abs(heights[0] - heights[1]) < 1,
      await page.evaluate((rootId) => {
        const selection = window.getSelection();
        if (selection === null || selection.rangeCount === 0) {
          return false;
        }
        return selection.getRangeAt(0).startContainer === document.getElementById(rootId)?.firstElementChild;
      }, EDITOR_ROOT_ELEMENT_ID),
    ]).toEqual(['<p><br></p><p>d</p>', true, true]);
  });

  test('clicking the insertion of a replacement pair opens one Replacement popup that frames both halves, and accepting keeps the insertion without the deletion in one edit transaction', async ({ page }) => {
    await openChangeEditor(page, REPLACEMENT_IN_TEXT);

    await openByClick(page, INSERTION);
    const header = await page.locator(HEADER).textContent();
    const framed = [
      await readComputed(page, DELETION, ['outline-style', 'outline-width', 'outline-color']),
      await readComputed(page, INSERTION, ['outline-style', 'outline-width', 'outline-color']),
    ];
    await page.locator(ACCEPT).click();

    await expect(page.locator(POPUP)).toBeHidden();
    expect([
      header,
      framed,
      await readBodyOutput(page),
      (await readTransactions(page)).length,
      await readCaretPrefix(page),
    ]).toEqual([
      'Replacement',
      [['solid', '2px', DELETION_COLOR], ['solid', '2px', INSERTION_COLOR]],
      '<p>The cache is cleared every 30 minutes.</p>',
      1,
      'The cache is cleared every 30 minutes',
    ]);
  });

  test('rejecting a replacement pair keeps the deletion without the insertion and puts the caret after it', async ({ page }) => {
    await openChangeEditor(page, REPLACEMENT_IN_TEXT);
    await openByClick(page, DELETION);

    await page.locator(REJECT).click();

    await expect(page.locator(POPUP)).toBeHidden();
    expect([await readBodyOutput(page), (await readTransactions(page)).length, await readCaretPrefix(page)]).toEqual([
      '<p>The cache is cleared every hour.</p>',
      1,
      'The cache is cleared every hour',
    ]);
  });

  test('accepting a row that carries an insertion removes only the three attributes, and rejecting it removes the row and puts the caret at the start of the next row', async ({ page }) => {
    const table = '<table><tbody><tr data-change="ins" data-author="ai" data-updated="2026-10-07T00:00:00.000Z"><td>a</td></tr>'
      + '<tr><td>b</td></tr></tbody></table>';
    await openChangeEditor(page, table);
    await openByClick(page, `${EDITOR_ROOT} td`);
    await page.locator(ACCEPT).click();
    await expect(page.locator(POPUP)).toBeHidden();
    const accepted = await readBodyOutput(page);

    await openChangeEditor(page, table);
    await openByClick(page, `${EDITOR_ROOT} td`);
    await page.locator(REJECT).click();
    await expect(page.locator(POPUP)).toBeHidden();

    expect([accepted, await readBodyOutput(page), await readCaretPrefix(page)]).toEqual([
      '<table><tbody><tr><td>a</td></tr><tr><td>b</td></tr></tbody></table>',
      '<table><tbody><tr><td>b</td></tr></tbody></table>',
      '',
    ]);
  });

  test('Alt+Enter inside an insertion opens the popup with focus on it, Tab cycles through the two decisions, and Esc returns to the caret', async ({ page }) => {
    await openChangeEditor(page, INSERTION_IN_TEXT);
    await placeCaretIn(page, INSERTION, 1);

    await page.keyboard.press('Alt+Enter');
    await expect(page.locator(POPUP)).toBeVisible();
    const visited = [await readFocus(page)];
    for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      visited.push(await readFocus(page));
    }
    await page.keyboard.press('Escape');

    await expect(page.locator(POPUP)).toBeHidden();
    expect([visited, await readFocus(page), await readCaretPrefix(page)]).toEqual([
      ['popup', 'Accept', 'Reject', 'Accept', 'Reject'],
      'editor',
      'ab',
    ]);
  });

  test('inside the annotated text of a comment within an insertion, a click and Alt+Enter open the comment popup and never the change popup', async ({ page }) => {
    await openChangeEditor(
      page,
      '<p><ins data-author="ai">x<comment id="c-a">yy<comment-body>note</comment-body></comment>z</ins></p>',
    );

    await page.locator(`${EDITOR_ROOT} comment`).click({ position: { x: 2, y: 5 } });
    await expect(page.locator(COMMENT_POPUP)).toBeVisible();
    const afterClick = await page.locator(POPUP).isVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(COMMENT_POPUP)).toBeHidden();
    await placeCaretIn(page, `${EDITOR_ROOT} comment`, 1);
    await page.keyboard.press('Alt+Enter');
    await expect(page.locator(COMMENT_POPUP)).toBeVisible();

    expect([afterClick, await page.locator(POPUP).isVisible()]).toEqual([false, false]);
  });

  test('a press outside the popup closes it, and so does moving the selection out of the mark with a key', async ({ page }) => {
    await openChangeEditor(page, INSERTION_IN_TEXT);
    await openByClick(page, INSERTION);
    await page.locator(`${EDITOR_ROOT} p`).last().click();
    await expect(page.locator(POPUP)).toBeHidden();
    const afterPress = await readBodyOutput(page);

    await openByClick(page, INSERTION);
    await page.keyboard.press('End');

    await expect(page.locator(POPUP)).toBeHidden();
    expect([afterPress, await readBodyOutput(page)]).toEqual(['<p>abc</p><p>d</p>'.replace('abc', 'a<ins data-author="ai" data-updated="2026-10-07T01:02:03.000Z">b</ins>c'), afterPress]);
  });

  test('a document replacement while the popup is open closes it', async ({ page }) => {
    await openChangeEditor(page, INSERTION_IN_TEXT);
    await openByClick(page, INSERTION);

    const replaced = await replaceDocument(page, '<p>a<ins data-author="ai">bb</ins>c</p>');

    await expect(page.locator(POPUP)).toBeHidden();
    expect(replaced).toBe(true);
  });

  test('while input is stopped, pressing Accept changes nothing', async ({ page }) => {
    await openChangeEditor(page, INSERTION_IN_TEXT);
    await openByClick(page, INSERTION);
    const before = await readBodyOutput(page);
    await stopInput(page);

    // The overlay covers the popup, so the press is dispatched to the button directly.
    await page.locator(ACCEPT).dispatchEvent('click');

    expect([await readBodyOutput(page), (await readTransactions(page)).length]).toEqual([before, 0]);
  });
});
