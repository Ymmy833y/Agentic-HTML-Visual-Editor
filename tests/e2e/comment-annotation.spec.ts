import { chromium, devices, expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  MESSAGE_CATALOG_ELEMENT_ID,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { CELL_RANGE_MARK_NAME, CELL_RANGE_MARK_NAMESPACE } from '../../webview/editing/cell-range';
import { DETAILS_TOGGLE_EDIT_KIND } from '../../webview/editing/details-toggle';
import { BLOCK_TYPE_MENU_CLASS } from '../../webview/ui/block-type-menu';
import { COMMENT_OPEN_MARK_NAME, COMMENT_OPEN_MARK_NAMESPACE, COMMENT_POPUP_ELEMENT_ID } from '../../webview/ui/comment-popup';
import { FLOATING_MENU_ELEMENT_ID } from '../../webview/ui/floating-menu';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import { OVERLAY_ELEMENT_ID } from '../../webview/ui/overlay-presenter';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { EDITOR_ROOT, installReceiver, paste, readBodyHtml, readRecord } from './helpers/editing';
import {
  PROBE_BUNDLE_PATH,
  getOutboundMessages,
  openWebviewHost,
  readIdleIconColor,
  sendToWebview,
} from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;
const FLOATING = `#${FLOATING_MENU_ELEMENT_ID}`;
const POPUP = `#${COMMENT_POPUP_ELEMENT_ID}`;
const REPLY_FIELD = `${POPUP} textarea[aria-label="${englishMessages['commentThread.replyField']}"]`;
// An item with a popup puts its contents in the same container, so point only at the direct child button.
const COMMENT_ITEM = `${TOOLBAR} [data-slot="${TOOLBAR_SLOT.comment}"] > button`;
const BOLD_ITEM = `${TOOLBAR} [data-slot="${TOOLBAR_SLOT.bold}"] > button`;
const FLOATING_COMMENT_ITEM = `${FLOATING} button[data-slot="${TOOLBAR_SLOT.comment}"]`;
const COMMENT = `${EDITOR_ROOT} comment`;
// The popup's body field. Found by the field name.
const BODY_FIELD = `${POPUP} textarea[aria-label="${englishMessages['commentThread.bodyField']}"]`;

/** The format of the ID of a created comment. */
const ID_PATTERN = /^c-[a-z0-9]{8}$/u;

/** A comment in a paragraph whose only entry is one body. */
const BODY_WITH_COMMENT = '<p>x<comment id="c-1">abcd<comment-body>note</comment-body></comment>y</p><p>outside</p>';

/** A comment with a thread taller than half the view, between spacers that let it scroll to any height. */
const LONG_THREAD_IN_MIDDLE = '<p style="height: 2000px">spacer</p><p>x<comment id="c-1">abcd<comment-body>note</comment-body>'
  + Array.from({ length: 40 }, (_, index) => `<comment-reply>reply ${index}</comment-reply>`).join('')
  + '</comment>y</p><p style="height: 2000px">spacer</p>';

/** An unopenable document (the body contains a forbidden tag). */
const UNOPENABLE_DOCUMENT = '<html><body><p>a</p><script>b</script></body></html>';

/**
 * Colors passed by the light, dark and high contrast themes. They include the comment and chart colors, so the tests also
 * show that the author colors do not follow them.
 */
const THEMES: { readonly variables: Record<string, string> }[] = [
  {
    variables: {
      '--vscode-editor-background': '#ffffff',
      '--vscode-editor-foreground': '#3b3b3b',
      '--vscode-panel-border': '#e5e5e5',
      '--vscode-focusBorder': '#005fb8',
      '--vscode-editorCommentsWidget-rangeBackground': 'rgba(0, 95, 184, 0.1)',
      '--vscode-editorCommentsWidget-unresolvedBorder': '#005fb8',
      '--vscode-charts-orange': '#d18616',
    },
  },
  {
    variables: {
      '--vscode-editor-background': '#1f1f1f',
      '--vscode-editor-foreground': '#cccccc',
      '--vscode-panel-border': '#2b2b2b',
      '--vscode-focusBorder': '#0078d4',
      '--vscode-editorCommentsWidget-rangeBackground': 'rgba(55, 148, 255, 0.1)',
      '--vscode-editorCommentsWidget-unresolvedBorder': '#3794ff',
      '--vscode-charts-orange': '#cd861a',
    },
  },
  {
    variables: {
      '--vscode-editor-background': '#000000',
      '--vscode-editor-foreground': '#ffffff',
      '--vscode-panel-border': '#6fc3df',
      '--vscode-focusBorder': '#f38518',
      '--vscode-editorCommentsWidget-rangeBackground': 'rgba(111, 195, 223, 0.2)',
      '--vscode-editorCommentsWidget-unresolvedBorder': '#6fc3df',
    },
  },
];

// The view decides the primary modifier from the userAgent, but the Desktop Chrome descriptor returns a Windows userAgent on any OS.
// Registered shortcuts are pressed with real keystrokes, so match the userAgent to the running OS. Paste uses real keystrokes,
// so allow reading and writing the clipboard.
const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
test.use({
  userAgent: process.platform === 'darwin' ? MAC_USER_AGENT : devices['Desktop Chrome'].userAgent,
  permissions: ['clipboard-read', 'clipboard-write'],
});

declare global {
  interface Window {
    /** The forwarding record. Holds the code of each keydown that reached the window's bubbling phase, in arrival order. */
    __forwardedKeys?: string[];
    /** The record of changes to the popup's hidden attribute. */
    __popupHiddenChanges?: number;
  }
}

/** A position in text: which child of which element, at which character. */
interface TextPoint {
  readonly selector: string;
  readonly childIndex: number;
  readonly offset: number;
}

/** The rectangle of an element (viewport coordinates). */
interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/**
 * Creates a position in text.
 *
 * @param selector The selector of the element.
 * @param childIndex The index of the child of that element.
 * @param offset The offset within the child.
 * @returns The position.
 */
function at(selector: string, childIndex: number, offset: number): TextPoint {
  return { selector, childIndex, offset };
}

/**
 * Embeds the English message catalog, then mounts the body.
 *
 * With messages left as keys, the popup's name and the empty message could not be checked as the text users see.
 *
 * @param page The page to operate.
 * @param body The body to mount.
 */
async function openCommentEditor(page: Page, body: string): Promise<void> {
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
 * Selects between two positions. With focus, moves focus to the editor root first.
 *
 * @param page The page to operate.
 * @param start The start.
 * @param end The end.
 * @param focus Whether to move focus to the editor root.
 */
async function selectRange(page: Page, start: TextPoint, end: TextPoint, focus = true): Promise<void> {
  await page.evaluate((argument) => {
    const readNode = (point: { selector: string; childIndex: number }): Node => {
      const node = document.querySelector(point.selector)?.childNodes[point.childIndex];
      if (node === undefined) {
        throw new Error(`node not found: ${point.selector}`);
      }
      return node;
    };
    const range = document.createRange();
    range.setStart(readNode(argument.start), argument.start.offset);
    range.setEnd(readNode(argument.end), argument.end.offset);
    if (argument.focus) {
      document.getElementById(argument.rootId)?.focus();
    }
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { start, end, focus, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Places the caret. With focus, moves focus to the editor root first.
 *
 * @param page The page to operate.
 * @param point The caret position.
 * @param focus Whether to move focus to the editor root.
 */
async function placeCaretAt(page: Page, point: TextPoint, focus = true): Promise<void> {
  await selectRange(page, point, point, focus);
}

/**
 * Reads the rectangle of an element.
 *
 * @param page The page to operate.
 * @param selector The selector of the element.
 * @returns The rectangle.
 */
async function readBox(page: Page, selector: string): Promise<Box> {
  return page.locator(selector).first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
  });
}

/**
 * Reads computed styles.
 *
 * @param page The page to operate.
 * @param selector The selector of the element.
 * @param properties The property names to read.
 * @returns The values.
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
 * @param page The page to operate.
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
 * Simulates VS Code's forwarding and starts recording the code of each keydown that reaches the window's bubbling phase.
 *
 * @param page The page to operate.
 */
async function installForwardRecord(page: Page): Promise<void> {
  await page.evaluate(() => {
    const record: string[] = [];
    window.__forwardedKeys = record;
    window.addEventListener('keydown', (event) => record.push(event.code));
  });
}

/**
 * Reads the forwarding record.
 *
 * @param page The page to operate.
 * @returns The codes of the keydowns that arrived.
 */
async function readForwardedKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__forwardedKeys ?? []);
}

/**
 * Scrolls the view so that the middle of the annotated text sits at the given share of the view height from the top.
 *
 * @param page The page to operate.
 * @param ratio The share of the view height, from 0 (top) to 1 (bottom).
 */
async function scrollCommentTo(page: Page, ratio: number): Promise<void> {
  await page.locator(COMMENT).evaluate((comment, share) => {
    const rect = comment.getBoundingClientRect();
    window.scrollBy(0, rect.top + rect.height / 2 - document.documentElement.clientHeight * share);
  }, ratio);
}

/**
 * Reads the body output.
 *
 * @param page The page to operate.
 * @returns The body output. Empty before mounting.
 */
async function readBodyOutput(page: Page): Promise<string> {
  return page.evaluate(() => window.__serializationProbe?.()?.body ?? '');
}

/**
 * Replaces the body through the document replacement entry.
 *
 * @param page The page to operate.
 * @param body The new body.
 * @returns Whether it was replaced.
 */
async function replaceDocument(page: Page, body: string): Promise<boolean> {
  return page.evaluate((text) => window.__documentReplacementProbe?.(text) ?? false, `${PROLOGUE}${body}${EPILOGUE}`);
}

/**
 * Raises a blank overlay to stop input.
 *
 * @param page The page to operate.
 */
async function stopInput(page: Page): Promise<void> {
  await page.evaluate((reason) => {
    window.__uiShellProbe?.()?.overlay.present(reason, { heading: '', descriptions: [], actions: [] });
  }, INPUT_STOP_REASON.saveRoundTrip);
}

/**
 * Dismisses the overlay to end the input stop.
 *
 * @param page The page to operate.
 */
async function resumeInput(page: Page): Promise<void> {
  await page.evaluate((reason) => window.__uiShellProbe?.()?.overlay.dismiss(reason), INPUT_STOP_REASON.saveRoundTrip);
}

/**
 * Reads the text of the entries listed in the popup.
 *
 * @param page The page to operate.
 * @returns The texts of the entries.
 */
async function readPopupEntries(page: Page): Promise<string[]> {
  return page.locator(`${POPUP} .comment-popup-entry`).allTextContents();
}

/**
 * Reads the ID of the focused element.
 *
 * @param page The page to operate.
 * @returns The ID. Empty if none.
 */
async function readFocusedId(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.id ?? '');
}

/**
 * Reads the text from the start of the editor root to the start of the selection.
 *
 * @param page The page to operate.
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
 * Reads both ends of the selection (the container text and offset).
 *
 * @param page The page to operate.
 * @returns The container texts and offsets of the start and the end.
 */
async function readSelectionEnds(page: Page): Promise<(string | number | null)[]> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    return [
      selection?.anchorNode?.textContent ?? null,
      selection?.anchorOffset ?? null,
      selection?.focusNode?.textContent ?? null,
      selection?.focusOffset ?? null,
    ];
  });
}

/**
 * Reads the contents of an element with the IDs of created comments replaced by a fixed spelling.
 *
 * @param page The page to operate.
 * @param selector The selector of the element.
 * @returns The contents.
 */
async function readHtmlWithoutId(page: Page, selector: string): Promise<string> {
  const html = await page.locator(selector).first().innerHTML();
  return html.replace(/ id="c-[a-z0-9]{8}"/gu, ' id="ID"');
}

/**
 * Reads the types of the sent messages from the given index on.
 *
 * @param page The page to operate.
 * @param from The index to start reading from.
 * @returns The set of types.
 */
async function readMessageTypes(page: Page, from: number): Promise<string[]> {
  const messages = await getOutboundMessages(page);
  return [...new Set(messages.slice(from).map((message) => String(Reflect.get(Object(message), 'type'))))];
}

test.describe('Creating comments', () => {
  test('selecting a range in a paragraph and pressing the comment button in the fixed toolbar wraps the range in a comment with only an id and no entries', async ({ page }) => {
    await openCommentEditor(page, '<p>abcd</p>');
    await selectRange(page, at(`${EDITOR_ROOT} p`, 0, 1), at(`${EDITOR_ROOT} p`, 0, 3));

    await page.locator(COMMENT_ITEM).click();

    expect(await readHtmlWithoutId(page, `${EDITOR_ROOT} p`)).toBe('a<comment id="ID" data-ahve-comment-open="">bc</comment>d');
  });

  test('the id of the created comment consists of c- and 8 lowercase letters and digits', async ({ page }) => {
    await openCommentEditor(page, '<p>abcd</p>');
    await selectRange(page, at(`${EDITOR_ROOT} p`, 0, 1), at(`${EDITOR_ROOT} p`, 0, 3));

    await page.locator(COMMENT_ITEM).click();

    expect(await page.locator(COMMENT).getAttribute('id')).toMatch(ID_PATTERN);
  });

  test('creating twice in the same document gives two different ids', async ({ page }) => {
    await openCommentEditor(page, '<p>abcd</p><p>efgh</p>');
    await selectRange(page, at(`${EDITOR_ROOT} p:nth-of-type(1)`, 0, 1), at(`${EDITOR_ROOT} p:nth-of-type(1)`, 0, 3));
    await page.locator(COMMENT_ITEM).click();
    await page.keyboard.press('Escape');
    await selectRange(page, at(`${EDITOR_ROOT} p:nth-of-type(2)`, 0, 1), at(`${EDITOR_ROOT} p:nth-of-type(2)`, 0, 3));

    await page.locator(COMMENT_ITEM).click();

    const ids = await page.locator(COMMENT).evaluateAll((comments) => comments.map((comment) => comment.id));
    expect([ids.length, new Set(ids).size, ids.every((id) => ID_PATTERN.test(id))]).toEqual([2, 2, true]);
  });

  test('creating moves focus to the body field of the new comment\'s popup and shows the empty message', async ({ page }) => {
    await openCommentEditor(page, '<p>abcd</p>');
    await selectRange(page, at(`${EDITOR_ROOT} p`, 0, 1), at(`${EDITOR_ROOT} p`, 0, 3));

    await page.locator(COMMENT_ITEM).click();

    await expect(page.locator(BODY_FIELD)).toBeFocused();
    await expect(page.locator(`${POPUP} .comment-popup-empty`)).toHaveText(englishMessages['commentPopup.empty']);
  });

  test('creation sends the immediate edit notification exactly once, with comment:create', async ({ page }) => {
    await openCommentEditor(page, '<p>abcd</p>');
    await installReceiver(page);
    await selectRange(page, at(`${EDITOR_ROOT} p`, 0, 1), at(`${EDITOR_ROOT} p`, 0, 3));

    await page.locator(COMMENT_ITEM).click();

    expect((await readRecord(page)).kinds).toEqual(['comment:create']);
  });

  test('the body output after creation contains the new comment', async ({ page }) => {
    await openCommentEditor(page, '<p>abcd</p>');
    await selectRange(page, at(`${EDITOR_ROOT} p`, 0, 1), at(`${EDITOR_ROOT} p`, 0, 3));

    await page.locator(COMMENT_ITEM).click();

    expect(await readBodyOutput(page)).toMatch(/^<p>a<comment id="c-[a-z0-9]{8}">bc<\/comment>d<\/p>$/u);
  });

  test('while creating a comment and opening and closing it, only the message types sent by typing go to the host', async ({ page }) => {
    await openCommentEditor(page, '<p>abcd</p><p>efgh</p>');
    // Collect the types sent by typing, waiting until the edit is settled.
    await page.locator(`${EDITOR_ROOT} p:nth-of-type(2)`).click();
    const beforeTyping = (await getOutboundMessages(page)).length;
    await page.keyboard.type('x');
    await expect.poll(() => readMessageTypes(page, beforeTyping), { timeout: 5000 })
      .toEqual(expect.arrayContaining([VIEW_TO_HOST_MESSAGE_TYPE.editTransaction, VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent]));
    const typingTypes = await readMessageTypes(page, beforeTyping);
    const beforeComment = (await getOutboundMessages(page)).length;

    await selectRange(page, at(`${EDITOR_ROOT} p:nth-of-type(1)`, 0, 1), at(`${EDITOR_ROOT} p:nth-of-type(1)`, 0, 3));
    await page.locator(COMMENT_ITEM).click();
    await page.keyboard.press('Escape');
    await page.locator(COMMENT).click();
    await page.locator(`${EDITOR_ROOT} p:nth-of-type(2)`).click();
    await expect.poll(() => readMessageTypes(page, beforeComment), { timeout: 5000 })
      .toContain(VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent);

    const commentTypes = await readMessageTypes(page, beforeComment);
    expect(commentTypes.filter((type) => !typingTypes.includes(type))).toEqual([]);
  });

  test('creating a comment and opening and closing it writes nothing to localStorage or sessionStorage', async ({ page }) => {
    await openCommentEditor(page, '<p>abcd</p><p>outside</p>');
    const readStorage = (): Promise<string[][]> => page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]);
    const before = await readStorage();
    await selectRange(page, at(`${EDITOR_ROOT} p:nth-of-type(1)`, 0, 1), at(`${EDITOR_ROOT} p:nth-of-type(1)`, 0, 3));

    await page.locator(COMMENT_ITEM).click();
    await page.keyboard.press('Escape');
    await page.locator(COMMENT).click();
    await page.locator(`${EDITOR_ROOT} p:nth-of-type(2)`).click();

    expect([before, await readStorage()]).toEqual([[[], []], [[], []]]);
  });

  test('pressing the comment button in the floating menu also creates a comment over the range', async ({ page }) => {
    await openCommentEditor(page, '<p>abcd</p>');
    await selectRange(page, at(`${EDITOR_ROOT} p`, 0, 1), at(`${EDITOR_ROOT} p`, 0, 3));
    await expect(page.locator(FLOATING)).toBeVisible();

    await page.locator(FLOATING_COMMENT_ITEM).click();

    expect(await readHtmlWithoutId(page, `${EDITOR_ROOT} p`)).toBe('a<comment id="ID" data-ahve-comment-open="">bc</comment>d');
  });

  test('moving from Alt+F10 to the comment button with arrows and pressing Enter creates a comment and moves focus to the body field', async ({ page }) => {
    await openCommentEditor(page, '<p>abcd</p>');
    await selectRange(page, at(`${EDITOR_ROOT} p`, 0, 1), at(`${EDITOR_ROOT} p`, 0, 3));
    await page.keyboard.press('Alt+F10');
    // Moving left once from the first item wraps around to the opposite end (the copy button at the end), and moving
    // once more reaches the comment button.
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator(COMMENT_ITEM)).toBeFocused();

    await page.keyboard.press('Enter');

    await expect(page.locator(BODY_FIELD)).toBeFocused();
    expect(await readHtmlWithoutId(page, `${EDITOR_ROOT} p`)).toBe('a<comment id="ID" data-ahve-comment-open="">bc</comment>d');
  });

  test('pressing with the caret inside the annotated text of an existing comment creates nothing and moves focus to the popup of that comment', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    const before = await readBodyOutput(page);
    await placeCaretAt(page, at(COMMENT, 0, 2));

    await page.locator(COMMENT_ITEM).click();

    await expect(page.locator(POPUP)).toBeFocused();
    expect([await readBodyOutput(page), await readPopupEntries(page)]).toEqual([before, ['note']]);
  });

  test('pressing with a range spanning two paragraphs changes neither the tree nor the selection', async ({ page }) => {
    await openCommentEditor(page, '<p>ab</p><p>cd</p>');
    await selectRange(page, at(`${EDITOR_ROOT} p:nth-of-type(1)`, 0, 1), at(`${EDITOR_ROOT} p:nth-of-type(2)`, 0, 1));
    const before = [await readBodyHtml(page), await readSelectionEnds(page)];

    await page.locator(COMMENT_ITEM).click();

    expect([await readBodyHtml(page), await readSelectionEnds(page)]).toEqual(before);
  });

  test('pressing with a range overlapping an existing comment does not change the tree', async ({ page }) => {
    await openCommentEditor(page, '<p>ab<comment id="c-1">cd</comment>ef</p>');
    const before = await readBodyHtml(page);
    await selectRange(page, at(`${EDITOR_ROOT} p`, 0, 1), at(COMMENT, 0, 1));

    await page.locator(COMMENT_ITEM).click();

    expect(await readBodyHtml(page)).toBe(before);
  });

  test('pressing with only a caret outside any comment neither changes the tree nor opens the popup', async ({ page }) => {
    await openCommentEditor(page, '<p>ab<comment id="c-1">cd</comment></p>');
    const before = await readBodyHtml(page);
    await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 0, 1));

    await page.locator(COMMENT_ITEM).click();

    await expect(page.locator(POPUP)).toBeHidden();
    expect(await readBodyHtml(page)).toBe(before);
  });

  test('for a range starting in the middle of bold text, the bold is split at the start and the comment wraps only the selected text', async ({ page }) => {
    await openCommentEditor(page, '<p>a<strong>bc</strong>de</p>');
    await selectRange(page, at(`${EDITOR_ROOT} strong`, 0, 1), at(`${EDITOR_ROOT} p`, 2, 1));

    await page.locator(COMMENT_ITEM).click();

    expect(await readHtmlWithoutId(page, `${EDITOR_ROOT} p`))
      .toBe('a<strong>b</strong><comment id="ID" data-ahve-comment-open=""><strong>c</strong>d</comment>e');
  });

  test('for a range of bare text directly under the editor root, it is wrapped in a paragraph and then the comment is created', async ({ page }) => {
    await openCommentEditor(page, 'abcd');
    await selectRange(page, at(EDITOR_ROOT, 0, 1), at(EDITOR_ROOT, 0, 3));

    await page.locator(COMMENT_ITEM).click();

    expect([
      await page.locator(`${EDITOR_ROOT} > p > comment`).allTextContents(),
      await page.locator(`${EDITOR_ROOT} > p`).allTextContents(),
    ]).toEqual([['bc'], ['abcd']]);
  });

  test('for a range inside a code block, the comment is created inside code', async ({ page }) => {
    await openCommentEditor(page, '<pre><code>abcd</code></pre>');
    await selectRange(page, at(`${EDITOR_ROOT} code`, 0, 1), at(`${EDITOR_ROOT} code`, 0, 3));

    await page.locator(COMMENT_ITEM).click();

    expect(await page.locator(`${EDITOR_ROOT} pre > code > comment`).allTextContents()).toEqual(['bc']);
  });

  test('a comment is also created for a range inside a table cell', async ({ page }) => {
    await openCommentEditor(page, '<table><tbody><tr><td>abcd</td></tr></tbody></table>');
    await selectRange(page, at(`${EDITOR_ROOT} td`, 0, 1), at(`${EDITOR_ROOT} td`, 0, 3));

    await page.locator(COMMENT_ITEM).click();

    expect(await page.locator(`${EDITOR_ROOT} td comment`).allTextContents()).toEqual(['bc']);
  });

  test('a comment is also created for a range inside a list item', async ({ page }) => {
    await openCommentEditor(page, '<ul><li>abcd</li></ul>');
    await selectRange(page, at(`${EDITOR_ROOT} li`, 0, 1), at(`${EDITOR_ROOT} li`, 0, 3));

    await page.locator(COMMENT_ITEM).click();

    expect(await page.locator(`${EDITOR_ROOT} li > comment`).allTextContents()).toEqual(['bc']);
  });

  test('a comment is also created for a range inside a details title', async ({ page }) => {
    await openCommentEditor(page, '<details open=""><summary>abcd</summary><p>x</p></details>');
    await selectRange(page, at(`${EDITOR_ROOT} summary`, 0, 1), at(`${EDITOR_ROOT} summary`, 0, 3));

    await page.locator(COMMENT_ITEM).click();

    expect(await page.locator(`${EDITOR_ROOT} summary > comment`).allTextContents()).toEqual(['bc']);
  });

  test('a comment is also created for a range inside a paragraph of a details body', async ({ page }) => {
    await openCommentEditor(page, '<details open=""><summary>t</summary><p>abcd</p></details>');
    await selectRange(page, at(`${EDITOR_ROOT} details > p`, 0, 1), at(`${EDITOR_ROOT} details > p`, 0, 3));

    await page.locator(COMMENT_ITEM).click();

    expect(await page.locator(`${EDITOR_ROOT} details > p > comment`).allTextContents()).toEqual(['bc']);
  });
});

test.describe('Highlighting the annotated text', () => {
  test('in the light, dark and high contrast themes, the annotated text background differs from the page background and the underline uses the human author color (orange)', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);

    const drawn: { distinct: boolean; line: string; mark: string }[] = [];
    for (const theme of THEMES) {
      await applyTheme(page, theme.variables);
      const [background, line, mark] = await readComputed(
        page,
        COMMENT,
        ['background-color', 'text-decoration-line', 'text-decoration-color'],
      );
      const [pageBackground] = await readComputed(page, 'body', ['background-color']);
      drawn.push({ distinct: background !== pageBackground, line, mark });
    }

    expect(drawn).toEqual(THEMES.map(() => ({ distinct: true, line: 'underline', mark: 'rgb(217, 119, 6)' })));
  });

  test('bodies and replies have no rectangles regardless of contenteditable', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p><comment id="c-1">ab<comment-body contenteditable="false">note</comment-body>'
      + '<comment-reply>reply</comment-reply></comment></p>',
    );

    const rects = await page.locator(`${EDITOR_ROOT} :is(comment-body, comment-reply)`)
      .evaluateAll((entries) => entries.map((entry) => entry.getClientRects().length));

    expect(rects).toEqual([0, 0]);
  });

  test('pressing Right Arrow at the end of the annotated text does not move the caret into an entry', async ({ page }) => {
    await openCommentEditor(page, '<p>a<comment id="c-1">bc<comment-body>xyz</comment-body></comment>d</p>');
    await placeCaretAt(page, at(COMMENT, 0, 2));

    await page.keyboard.press('ArrowRight');

    const inEntry = await page.evaluate(() => {
      const node = window.getSelection()?.anchorNode ?? null;
      const element = node instanceof Element ? node : node?.parentElement ?? null;
      return element?.closest('comment-body, comment-reply') !== null && element !== null;
    });
    expect(inEntry).toBe(false);
  });

  test('nested comments (handwritten) are highlighted both inner and outer', async ({ page }) => {
    await openCommentEditor(page, '<p><comment id="o">a<comment id="i">b</comment>c</comment></p>');
    const [pageBackground] = await readComputed(page, 'body', ['background-color']);

    const drawn = await page.locator(COMMENT).evaluateAll((comments) => comments.map((comment) => {
      const style = getComputedStyle(comment);
      return [style.backgroundColor, style.textDecorationLine];
    }));

    expect(drawn.map(([background, line]) => [background !== pageBackground, line]))
      .toEqual([[true, 'underline'], [true, 'underline']]);
  });

  test('for a comment with a background in an inline style, the inline background wins', async ({ page }) => {
    await openCommentEditor(page, '<p><comment id="c-1" style="background-color: rgb(255, 0, 0)">ab</comment></p>');

    expect(await readComputed(page, COMMENT, ['background-color'])).toEqual(['rgb(255, 0, 0)']);
  });

  test('a comment in the body of an open details is also highlighted', async ({ page }) => {
    await openCommentEditor(page, '<details open=""><summary>t</summary><p><comment id="c-1">ab</comment></p></details>');
    const [pageBackground] = await readComputed(page, 'body', ['background-color']);

    const [background, line] = await readComputed(page, COMMENT, ['background-color', 'text-decoration-line']);

    expect([background !== pageBackground, line]).toEqual([true, 'underline']);
  });

  test('a comment in a details title is also highlighted', async ({ page }) => {
    await openCommentEditor(page, '<details open=""><summary>t<comment id="c-1">ab</comment></summary><p>x</p></details>');
    const [pageBackground] = await readComputed(page, 'body', ['background-color']);

    const [background, line] = await readComputed(page, COMMENT, ['background-color', 'text-decoration-line']);

    expect([background !== pageBackground, line]).toEqual([true, 'underline']);
  });

  test('opening by click thickens the border of only that comment, and closing with Esc returns it to 1px', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p>x<comment id="a">ab<comment-body>one</comment-body></comment>y'
      + '<comment id="b">cd<comment-body>two</comment-body></comment>z</p>',
    );

    await page.locator(`${EDITOR_ROOT} #a`).click();
    await expect(page.locator(POPUP)).toBeVisible();
    const open = [
      await readComputed(page, `${EDITOR_ROOT} #a`, ['outline-width']),
      await readComputed(page, `${EDITOR_ROOT} #b`, ['outline-width']),
    ];
    await page.keyboard.press('Escape');
    await expect(page.locator(POPUP)).toBeHidden();

    expect([open, await readComputed(page, `${EDITOR_ROOT} #a`, ['outline-width'])])
      .toEqual([[['2px'], ['1px']], ['1px']]);
  });

  test('opening and closing sends no view edited message, and the open mark does not appear in the body output', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await installReceiver(page);

    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();
    const marked = await page.locator(COMMENT).evaluate(
      (comment, mark) => comment.hasAttributeNS(mark.namespace, mark.name),
      { namespace: COMMENT_OPEN_MARK_NAMESPACE, name: COMMENT_OPEN_MARK_NAME },
    );
    const output = await readBodyOutput(page);
    await page.keyboard.press('Escape');
    await expect(page.locator(POPUP)).toBeHidden();

    expect([marked, output.includes(COMMENT_OPEN_MARK_NAME), (await readRecord(page)).kinds]).toEqual([true, false, []]);
  });
});

test.describe('Opening and closing the popup by clicking', () => {
  test('clicking the annotated text opens the popup below it', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);

    await page.locator(COMMENT).click();

    await expect(page.locator(POPUP)).toBeVisible();
    const [comment, popup] = [await readBox(page, COMMENT), await readBox(page, POPUP)];
    expect(Math.round(popup.top - comment.bottom)).toBe(6);
  });

  test('opening by click keeps focus in the editor root and places the caret at the clicked position', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);

    await page.locator(COMMENT).click();

    await expect(page.locator(POPUP)).toBeVisible();
    const caret = await page.evaluate(() => {
      const selection = window.getSelection();
      return [selection?.isCollapsed, selection?.anchorNode?.parentElement?.localName];
    });
    expect([await readFocusedId(page), caret]).toEqual([EDITOR_ROOT_ELEMENT_ID, [true, 'comment']]);
  });

  test('the popup shows the text of the body and replies in document order', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p><comment id="c-1">ab<comment-body>note</comment-body><comment-reply>reply 1</comment-reply>'
      + '<comment-reply>reply 2</comment-reply></comment></p>',
    );

    await page.locator(COMMENT).click();

    await expect(page.locator(POPUP)).toBeVisible();
    expect(await readPopupEntries(page)).toEqual(['note', 'reply 1', 'reply 2']);
  });

  test('code in an entry is shown as plain text in the popup, not monospaced', async ({ page }) => {
    await openCommentEditor(page, '<p><comment id="c-1">ab<comment-body>see <code>x</code></comment-body></comment></p>');

    await page.locator(COMMENT).click();

    await expect(page.locator(POPUP)).toBeVisible();
    expect([await page.locator(`${POPUP} code`).count(), await readPopupEntries(page)]).toEqual([0, ['see x']]);
  });

  test('line breaks in an entry also separate lines in the popup', async ({ page }) => {
    await openCommentEditor(page, '<p><comment id="c-1">ab<comment-body>line1\nline2</comment-body></comment></p>');

    await page.locator(COMMENT).click();

    await expect(page.locator(POPUP)).toBeVisible();
    const lines = await page.locator(`${POPUP} .comment-popup-entry`).evaluate((entry) => {
      const range = document.createRange();
      range.selectNodeContents(entry);
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    });
    expect(lines).toBe(2);
  });

  test('for annotated text near the bottom of the screen, the popup opens above it', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p style="height: 2000px">spacer</p><p>x<comment id="c-1">abcd<comment-body>note</comment-body></comment>y</p>'
      + '<p style="height: 2000px">spacer</p>',
    );
    // Scroll until the bottom of the annotated text is 20px above the bottom of the view.
    await page.locator(COMMENT).evaluate((comment) => {
      window.scrollBy(0, comment.getBoundingClientRect().bottom - (window.innerHeight - 20));
    });

    await page.locator(COMMENT).click();

    await expect(page.locator(POPUP)).toBeVisible();
    const [comment, popup] = [await readBox(page, COMMENT), await readBox(page, POPUP)];
    expect(Math.round(comment.top - popup.bottom)).toBe(6);
  });

  test('for annotated text in the middle of the view with a long thread, the popup stays inside the view and scrolls inside', async ({ page }) => {
    await openCommentEditor(page, LONG_THREAD_IN_MIDDLE);
    await scrollCommentTo(page, 0.5);

    await page.locator(COMMENT).click();

    await expect(page.locator(POPUP)).toBeVisible();
    const [toolbar, popup] = [await readBox(page, TOOLBAR), await readBox(page, POPUP)];
    const [viewHeight, scrollable] = await page.locator(POPUP).evaluate((element) => [
      document.documentElement.clientHeight,
      element.scrollHeight > element.clientHeight,
    ]);
    expect([popup.top >= toolbar.bottom, popup.bottom <= viewHeight, scrollable]).toEqual([true, true, true]);
  });

  test('scrolling a popup with a limited height to the bottom reaches the end of its contents', async ({ page }) => {
    await openCommentEditor(page, LONG_THREAD_IN_MIDDLE);
    await scrollCommentTo(page, 0.5);
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();

    // The popup's own listener runs after the capture-phase listener that places the popup again, so the values are read
    // after that placement.
    const [scrollTop, end] = await page.locator(POPUP).evaluate((element) => new Promise<number[]>((resolve) => {
      element.addEventListener('scroll', () => resolve([element.scrollTop, element.scrollHeight - element.clientHeight]), { once: true });
      element.scrollTop = element.scrollHeight;
    }));

    expect(end - scrollTop).toBeLessThan(1);
  });

  test('after opening with a limited height, scrolling until it fits below returns the popup to its full height', async ({ page }) => {
    await openCommentEditor(page, LONG_THREAD_IN_MIDDLE);
    await scrollCommentTo(page, 0.5);
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();
    const limited = await readBox(page, POPUP);

    await scrollCommentTo(page, 0.15);

    await expect.poll(() => page.locator(POPUP).evaluate((element) => (element as HTMLElement).style.maxHeight)).toBe('');
    const full = await readBox(page, POPUP);
    expect(full.bottom - full.top > limited.bottom - limited.top).toBe(true);
  });

  test('keeps the popup inside the visible width for annotated text at the right end, even when its width has a fraction below half a pixel', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    // A width that whole-pixel measurement rounds down, whatever the font. Its left edge at the annotated text would run
    // past the right edge, so it is pulled back in.
    await page.addStyleTag({ content: `${EDITOR_ROOT} p { text-align: right; } ${POPUP} { width: 200.25px; }` });

    await page.locator(COMMENT).click();

    await expect(page.locator(POPUP)).toBeVisible();
    const popup = await readBox(page, POPUP);
    expect([popup.right - popup.left, popup.right <= (page.viewportSize()?.width ?? 0)]).toEqual([200.25, true]);
  });

  test('scrolling while open moves the popup along with the annotated text', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p>x<comment id="c-1">abcd<comment-body>note</comment-body></comment>y</p><p style="height: 3000px">spacer</p>',
    );
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();
    const before = await readBox(page, COMMENT);

    await page.evaluate(() => window.scrollBy(0, 40));

    await expect.poll(async () => Math.round((await readBox(page, POPUP)).top - (await readBox(page, COMMENT)).bottom))
      .toBe(6);
    expect(Math.round(before.bottom - (await readBox(page, COMMENT)).bottom)).toBe(40);
  });

  test('Ctrl+click does not open it', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);

    await page.locator(COMMENT).click({ modifiers: ['ControlOrMeta'] });

    await expect(page.locator(POPUP)).toBeHidden();
  });

  test('right-click does not open it', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);

    await page.locator(COMMENT).click({ button: 'right' });

    await expect(page.locator(POPUP)).toBeHidden();
  });

  test('a click that made a range by dragging over the annotated text does not open it', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    const comment = await readBox(page, COMMENT);
    const middle = (comment.top + comment.bottom) / 2;

    await page.mouse.move(comment.left + 1, middle);
    await page.mouse.down();
    await page.mouse.move(comment.right - 1, middle, { steps: 5 });
    await page.mouse.up();

    expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(false);
    await expect(page.locator(POPUP)).toBeHidden();
  });

  test('on a double click of the annotated text, the popup opened by the first click stays open with the same contents after the second selects a word', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);

    await page.locator(COMMENT).dblclick();

    await expect(page.locator(POPUP)).toBeVisible();
    expect([await page.evaluate(() => window.getSelection()?.isCollapsed), await readPopupEntries(page)])
      .toEqual([false, ['note']]);
  });

  test('clicking the inner annotated text while the outer nested comment is open switches to the inner entries without closing', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p><comment id="o">aaaa <comment id="i">bbbb<comment-body>inner</comment-body></comment> cccc'
      + '<comment-body>outer</comment-body></comment></p>',
    );
    await page.locator(`${EDITOR_ROOT} #o`).click({ position: { x: 3, y: 5 } });
    await expect(page.locator(POPUP)).toHaveText('outer');
    // Count how many times the hidden attribute of the popup changed, including reopening.
    await page.locator(POPUP).evaluate((popup) => {
      window.__popupHiddenChanges = 0;
      new MutationObserver((records) => {
        window.__popupHiddenChanges = (window.__popupHiddenChanges ?? 0) + records.length;
      }).observe(popup, { attributes: true, attributeFilter: ['hidden'] });
    });

    await page.locator(`${EDITOR_ROOT} #i`).click();

    await expect(page.locator(POPUP)).toHaveText('inner');
    expect(await page.evaluate(() => window.__popupHiddenChanges)).toBe(0);
  });

  test('pressing body text outside the popup closes it', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();

    await page.locator(`${EDITOR_ROOT} p:nth-of-type(2)`).click();

    await expect(page.locator(POPUP)).toBeHidden();
  });

  test('pressing inside the popup does not close it', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();

    await page.locator(POPUP).click();

    await expect(page.locator(POPUP)).toBeVisible();
  });

  test('pressing over the annotated text of the open comment does not close it', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();

    await page.locator(COMMENT).click();

    await expect(page.locator(POPUP)).toBeVisible();
  });

  test('clicking annotated text in a details title opens the popup without toggling the details', async ({ page }) => {
    await openCommentEditor(
      page,
      '<details><summary>t<comment id="c-1">abcd<comment-body>note</comment-body></comment></summary><p>x</p></details>',
    );

    await page.locator(COMMENT).click();

    await expect(page.locator(POPUP)).toHaveText('note');
    expect(await page.locator(`${EDITOR_ROOT} details`).getAttribute('open')).toBeNull();
  });
});

test.describe('Opening a comment popup from the caret', () => {
  test('Alt+Enter opens the thread at the caret and focuses the reply field without editing or forwarding Enter', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await placeCaretAt(page, at(COMMENT, 0, 2));
    await installReceiver(page);
    await installForwardRecord(page);
    const before = await readBodyOutput(page);

    await page.keyboard.press('Alt+Enter');

    await expect(page.locator(REPLY_FIELD)).toBeFocused();
    expect(await readBodyOutput(page)).toBe(before);
    expect((await readRecord(page)).kinds).toEqual([]);
    expect(await readForwardedKeys(page)).not.toContain('Enter');
  });

  test('Alt+Enter focuses the body field when the comment has no entries', async ({ page }) => {
    await openCommentEditor(page, '<p>x<comment id="c-1">abcd</comment>y</p>');
    await placeCaretAt(page, at(COMMENT, 0, 2));

    await page.keyboard.press('Alt+Enter');

    await expect(page.locator(BODY_FIELD)).toBeFocused();
  });

  test('Alt+Enter focuses the reply field when the comment has replies but no body', async ({ page }) => {
    await openCommentEditor(page, '<p><comment id="c-1">abcd<comment-reply>reply</comment-reply></comment></p>');
    await placeCaretAt(page, at(COMMENT, 0, 2));

    await page.keyboard.press('Alt+Enter');

    await expect(page.locator(REPLY_FIELD)).toBeFocused();
  });

  test('Alt+Enter opens the innermost thread containing the caret', async ({ page }) => {
    await openCommentEditor(page, '<p><comment id="outer">ab<comment id="inner">cd'
      + '<comment-body>inner note</comment-body></comment>ef<comment-body>outer note</comment-body></comment></p>');
    await placeCaretAt(page, at('#inner', 0, 1));

    await page.keyboard.press('Alt+Enter');

    expect(await readPopupEntries(page)).toEqual(['inner note']);
    await expect(page.locator(REPLY_FIELD)).toBeFocused();
  });

  test('Alt+Enter enters the reply field of a thread already opened by clicking', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();
    await placeCaretAt(page, at(COMMENT, 0, 2));

    await page.keyboard.press('Alt+Enter');

    await expect(page.locator(REPLY_FIELD)).toBeFocused();
  });

  test('Tab and Shift+Tab cycle through the popup after Alt+Enter opens it', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await placeCaretAt(page, at(COMMENT, 0, 2));
    await page.keyboard.press('Alt+Enter');
    await expect(page.locator(REPLY_FIELD)).toBeFocused();

    await page.keyboard.press('Tab');

    await expect(page.locator(`${POPUP} button[aria-label="${englishMessages['commentThread.resolved']}"]`)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator(REPLY_FIELD)).toBeFocused();
  });

  test('Escape from the empty field after Alt+Enter restores the original caret', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await placeCaretAt(page, at(COMMENT, 0, 2));
    const before = await readSelectionEnds(page);
    await page.keyboard.press('Alt+Enter');
    await expect(page.locator(REPLY_FIELD)).toBeFocused();

    await page.keyboard.press('Escape');

    await expect(page.locator(POPUP)).toBeHidden();
    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
    expect(await readSelectionEnds(page)).toEqual(before);
  });

  test('Alt+Enter does not open a thread for a caret outside annotations', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await placeCaretAt(page, at(`${EDITOR_ROOT} p:nth-of-type(2)`, 0, 2));

    await page.keyboard.press('Alt+Enter');

    await expect(page.locator(POPUP)).toBeHidden();
  });

  test('Alt+Enter does not open a thread for a range selection', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await selectRange(page, at(COMMENT, 0, 1), at(COMMENT, 0, 3));

    await page.keyboard.press('Alt+Enter');

    await expect(page.locator(POPUP)).toBeHidden();
  });

  test('Alt+Enter does not open a thread during composition', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await placeCaretAt(page, at(COMMENT, 0, 2));
    await page.locator(EDITOR_ROOT).dispatchEvent('compositionstart', { data: '' });

    // Physical keys commit composition first, so send the keystroke while the editing session still holds it.
    await page.locator(EDITOR_ROOT).dispatchEvent('keydown', {
      key: 'Enter', code: 'Enter', altKey: true, bubbles: true, cancelable: true,
    });

    await expect(page.locator(POPUP)).toBeHidden();
    await page.locator(EDITOR_ROOT).dispatchEvent('compositionend', { data: '' });
  });

  test('Alt+Enter does not open a thread during an input stop', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await placeCaretAt(page, at(COMMENT, 0, 2));
    await stopInput(page);

    // The input stop moves focus out of the root; a queued root event must also leave the popup closed.
    await page.locator(EDITOR_ROOT).dispatchEvent('keydown', {
      key: 'Enter', code: 'Enter', altKey: true, bubbles: true, cancelable: true,
    });

    await expect(page.locator(POPUP)).toBeHidden();
    await resumeInput(page);
  });
});

test.describe('Editor root keys and the popup', () => {
  test('pressing Escape in the editor root closes the popup', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.locator(POPUP)).toBeHidden();
  });

  test('the Escape in the editor root that closed the popup does not reach VS Code', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();
    await installForwardRecord(page);

    await page.keyboard.press('Escape');

    await expect(page.locator(POPUP)).toBeHidden();
    expect(await readForwardedKeys(page)).not.toContain('Escape');
  });

  test('when the block type popup is also open, the first Escape closes only the block type popup', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();
    // Pressing with the pointer would close the comment popup, so open it with a slot activation that takes the same path as a press.
    await page.evaluate((slot) => window.__toolbarProbe?.()?.activateSlot(slot), TOOLBAR_SLOT.blockType);
    await expect(page.locator(`.${BLOCK_TYPE_MENU_CLASS}`)).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.locator(`.${BLOCK_TYPE_MENU_CLASS}`)).toHaveCount(0);
    await expect(page.locator(POPUP)).toBeVisible();
  });

  test('with both a cell range and the popup, the first Escape closes only the popup and the range remains', async ({ page }) => {
    await openCommentEditor(
      page,
      '<table><tbody><tr><td id="a">ab</td><td id="b"><comment id="c-1">cd<comment-body>note</comment-body></comment></td>'
      + '</tr></tbody></table>',
    );
    await placeCaretAt(page, at(`${EDITOR_ROOT} #a`, 0, 1));
    await page.locator(COMMENT).click({ modifiers: ['Shift'] });
    // Making the range returns the selection to the anchor (outside the comment), so opening it first would close it when Shift is released. To open
    // without clearing the range, send only a click with no press.
    await page.locator(COMMENT).dispatchEvent('click', { button: 0 });
    await expect(page.locator(POPUP)).toBeVisible();
    const readMarkedCells = (): Promise<string[]> => page.evaluate((mark) => [...document.querySelectorAll('td')]
      .filter((cell) => cell.hasAttributeNS(mark.namespace, mark.name))
      .map((cell) => cell.id), { namespace: CELL_RANGE_MARK_NAMESPACE, name: CELL_RANGE_MARK_NAME });
    expect(await readMarkedCells()).toEqual(['a', 'b']);

    await page.keyboard.press('Escape');

    await expect(page.locator(POPUP)).toBeHidden();
    expect(await readMarkedCells()).toEqual(['a', 'b']);
  });

  test('the popup closes when the arrow keys move the caret outside the annotated text', async ({ page }) => {
    await openCommentEditor(page, '<p>x<comment id="c-1">ab<comment-body>note</comment-body></comment>yz</p>');
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();
    await placeCaretAt(page, at(COMMENT, 0, 1), false);

    for (let count = 0; count < 3; count += 1) {
      await page.keyboard.press('ArrowRight');
    }

    await expect(page.locator(POPUP)).toBeHidden();
  });

  test('the popup stays open while the arrow keys move the caret within the annotated text', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();
    await placeCaretAt(page, at(COMMENT, 0, 1), false);

    await page.keyboard.press('ArrowRight');

    expect(await readCaretPrefix(page)).toBe('xab');
    await expect(page.locator(POPUP)).toBeVisible();
  });

  test('the popup closes when Shift+arrow moves the selection end outside the annotated text', async ({ page }) => {
    await openCommentEditor(page, '<p>x<comment id="c-1">ab<comment-body>note</comment-body></comment>yz</p>');
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();
    await placeCaretAt(page, at(COMMENT, 0, 1), false);

    for (let count = 0; count < 3; count += 1) {
      await page.keyboard.press('Shift+ArrowRight');
    }

    await expect(page.locator(POPUP)).toBeHidden();
  });
});

test.describe('Following tree changes', () => {
  test('typing in the annotated text keeps the popup open and places it again below the annotated text', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p style="width: 12em">x<comment id="c-1">ab<comment-body>note</comment-body></comment></p>',
    );
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();
    await placeCaretAt(page, at(COMMENT, 0, 2), false);
    const before = await readBox(page, COMMENT);

    // Wrap past the paragraph width to move the bottom of the annotated text.
    await page.keyboard.type(' aa bb cc dd ee ff gg hh ii jj');

    const after = await readBox(page, COMMENT);
    await expect(page.locator(POPUP)).toBeVisible();
    expect([after.bottom > before.bottom, Math.round((await readBox(page, POPUP)).top - after.bottom)]).toEqual([true, 6]);
  });

  test('deleting a range containing the open comment closes the popup', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();
    await selectRange(page, at(`${EDITOR_ROOT} p:nth-of-type(1)`, 0, 0), at(`${EDITOR_ROOT} p:nth-of-type(1)`, 2, 1), false);

    await page.keyboard.press('Backspace');

    await expect(page.locator(COMMENT)).toHaveCount(0);
    await expect(page.locator(POPUP)).toBeHidden();
  });

  test('closing a details whose body holds the open comment closes the popup', async ({ page }) => {
    await openCommentEditor(
      page,
      '<details open=""><summary>t</summary><p><comment id="c-1">ab<comment-body>note</comment-body></comment></p></details>',
    );
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();

    // As with the details toggle, remove the open attribute as one edit.
    await page.evaluate((kind) => window.__editingSessionProbe?.()?.runCommandEdit(kind, () => {
      document.querySelector('details')?.removeAttribute('open');
      return true;
    }), DETAILS_TOGGLE_EDIT_KIND);

    await expect(page.locator(POPUP)).toBeHidden();
  });

  test('an edit that changes the entry text in the tree while open makes the popup show the new text', async ({ page }) => {
    await openCommentEditor(page, '<p><comment id="c-1">ab<comment-body>old</comment-body></comment></p>');
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toHaveText('old');

    await page.evaluate(() => window.__editingSessionProbe?.()?.runCommandEdit('insertText', () => {
      const body = document.querySelector('comment-body');
      if (body !== null) {
        body.textContent = 'new';
      }
      return true;
    }));

    await expect(page.locator(POPUP)).toHaveText('new');
  });

  test('when exactly one comment of the same ID remains after replacement, the popup stays open and shows the new entries', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toHaveText('note');

    await replaceDocument(page, '<p>z<comment id="c-1">abcd<comment-body>replaced</comment-body></comment></p>');

    await expect(page.locator(POPUP)).toBeVisible();
    await expect(page.locator(POPUP)).toHaveText('replaced');
  });

  test('the popup closes when replacement leaves no comment of the same ID', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();

    await replaceDocument(page, '<p>xy</p>');

    await expect(page.locator(POPUP)).toBeHidden();
  });

  test('the popup closes when replacement leaves two comments of the same ID', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();

    await replaceDocument(
      page,
      '<p><comment id="c-1">ab<comment-body>one</comment-body></comment><comment id="c-1">cd<comment-body>two</comment-body></comment></p>',
    );

    await expect(page.locator(POPUP)).toBeHidden();
  });

  test('opening the popup leaves the body output as it was before opening', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    const before = await readBodyOutput(page);

    await page.locator(COMMENT).click();

    await expect(page.locator(POPUP)).toBeVisible();
    expect(await readBodyOutput(page)).toBe(before);
  });

  test('opening and closing comments with an off-format ID, no ID, or children out of order does not change the body output', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p><comment id="X!">ab<comment-reply>reply</comment-reply><comment-body>note</comment-body></comment> '
      + '<comment>cd<comment-body>note</comment-body></comment></p><p>outside</p>',
    );
    const before = await readBodyOutput(page);

    await page.locator(COMMENT).first().click();
    await expect(page.locator(POPUP)).toBeVisible();
    await page.locator(COMMENT).nth(1).click();
    await page.locator(`${EDITOR_ROOT} p:nth-of-type(2)`).click();

    await expect(page.locator(POPUP)).toBeHidden();
    expect(await readBodyOutput(page)).toBe(before);
  });
});

test.describe('Popup appearance and key handling', () => {
  test('in the light, dark and high contrast themes, the popup border and the entry text can be told apart from the background', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();

    const drawn: boolean[][] = [];
    for (const theme of THEMES) {
      await applyTheme(page, theme.variables);
      const [border, background] = await readComputed(page, POPUP, ['border-top-color', 'background-color']);
      const [text] = await readComputed(page, `${POPUP} .comment-popup-entry`, ['color']);
      drawn.push([border !== background, text !== background]);
    }

    expect(drawn).toEqual(THEMES.map(() => [true, true]));
  });

  test('pressing Escape in a popup opened from the comment button closes it and returns focus and the selection to the editor root selection from before opening', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await placeCaretAt(page, at(COMMENT, 0, 2));
    const before = await readCaretPrefix(page);
    await page.locator(COMMENT_ITEM).click();
    await expect(page.locator(POPUP)).toBeFocused();

    await page.keyboard.press('Escape');

    await expect(page.locator(POPUP)).toBeHidden();
    expect([await readFocusedId(page), await readCaretPrefix(page)]).toEqual([EDITOR_ROOT_ELEMENT_ID, before]);
  });

  test('pressing inside a popup opened by click and then pressing Escape returns to the editor root selection from before the press', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await page.locator(COMMENT).click();
    await expect(page.locator(POPUP)).toBeVisible();
    const before = await readCaretPrefix(page);
    // Clicking an entry text opens the edit field, so press on the empty middle of the header. A corner is out: the
    // rounded corner leaves its outer edge to the editor root, which would take the press.
    await page.locator(POPUP).click({ position: { x: 200, y: 10 } });
    await expect(page.locator(POPUP)).toBeFocused();

    await page.keyboard.press('Escape');

    await expect(page.locator(POPUP)).toBeHidden();
    expect([await readFocusedId(page), await readCaretPrefix(page)]).toEqual([EDITOR_ROOT_ELEMENT_ID, before]);
  });

  test('pressing Tab and Shift+Tab in the popup keeps focus on the controls inside the popup', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await placeCaretAt(page, at(COMMENT, 0, 2));
    await page.locator(COMMENT_ITEM).click();
    await expect(page.locator(POPUP)).toBeFocused();
    const readFocusOnPart = (): Promise<boolean> => page.locator(POPUP).evaluate(
      (popup) => document.activeElement !== popup && popup.contains(document.activeElement),
    );

    await page.keyboard.press('Tab');
    const afterTab = await readFocusOnPart();
    await page.keyboard.press('Shift+Tab');

    expect([afterTab, await readFocusOnPart()]).toEqual([true, true]);
  });

  test('Tab in the popup does not reach VS Code', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await placeCaretAt(page, at(COMMENT, 0, 2));
    await page.locator(COMMENT_ITEM).click();
    await expect(page.locator(POPUP)).toBeFocused();
    await installForwardRecord(page);

    await page.keyboard.press('Tab');

    expect(await readForwardedKeys(page)).not.toContain('Tab');
  });

  test('pressing Ctrl+B in the popup does not bold the comment contents', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await selectRange(page, at(COMMENT, 0, 1), at(COMMENT, 0, 3));
    await page.locator(COMMENT_ITEM).click();
    await expect(page.locator(POPUP)).toBeFocused();
    const before = await readBodyHtml(page);

    await page.keyboard.press('ControlOrMeta+B');

    expect(await readBodyHtml(page)).toBe(before);
  });

  test('Ctrl+B in the popup does not reach VS Code', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await placeCaretAt(page, at(COMMENT, 0, 2));
    await page.locator(COMMENT_ITEM).click();
    await expect(page.locator(POPUP)).toBeFocused();
    await installForwardRecord(page);

    await page.keyboard.press('ControlOrMeta+B');

    expect(await readForwardedKeys(page)).not.toContain('KeyB');
  });

  test('Ctrl+Z in the popup is not taken over and reaches VS Code', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await placeCaretAt(page, at(COMMENT, 0, 2));
    await page.locator(COMMENT_ITEM).click();
    await expect(page.locator(POPUP)).toBeFocused();
    await installForwardRecord(page);

    await page.keyboard.press('ControlOrMeta+Z');

    expect(await readForwardedKeys(page)).toContain('KeyZ');
  });

  test('pressing Escape in the popup during an input stop does not close it, and focus stays in the popup', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await placeCaretAt(page, at(COMMENT, 0, 2));
    await page.locator(COMMENT_ITEM).click();
    await expect(page.locator(POPUP)).toBeFocused();
    await stopInput(page);

    await page.keyboard.press('Escape');

    await expect(page.locator(POPUP)).toBeVisible();
    await expect(page.locator(POPUP)).toBeFocused();
  });

  test('the popup has the dialog role and the catalog name, and its description target holds the entry text', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);

    await page.locator(COMMENT).click();

    const dialog = page.getByRole('dialog', { name: englishMessages['commentPopup.name'], exact: true });
    await expect(dialog).toBeVisible();
    const description = await dialog.evaluate(
      (popup) => document.getElementById(popup.getAttribute('aria-describedby') ?? '')?.textContent ?? null,
    );
    expect(description).toBe('note');
  });

  test('a popup opened from the keyboard shows a focus ring in the theme token color, right on its border', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await applyTheme(page, THEMES[2].variables);
    await placeCaretAt(page, at(COMMENT, 0, 2));
    await page.keyboard.press('Alt+F10');
    // Wrap around to the copy button at the end, then move back one to the comment button.
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator(COMMENT_ITEM)).toBeFocused();

    await page.keyboard.press('Enter');

    // No offset, so no gap shows between the ring and the border of the popup.
    await expect(page.locator(POPUP)).toBeFocused();
    expect(await readComputed(page, POPUP, ['outline-style', 'outline-width', 'outline-color', 'outline-offset']))
      .toEqual(['solid', '2px', 'rgb(243, 133, 24)', '0px']);
  });

  test('pressing Bold in the fixed toolbar while focus is in the popup closes the popup and applies bold to the restored selection', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await selectRange(page, at(COMMENT, 0, 1), at(COMMENT, 0, 3));
    await page.locator(COMMENT_ITEM).click();
    await expect(page.locator(POPUP)).toBeFocused();

    await page.locator(BOLD_ITEM).click();

    await expect(page.locator(POPUP)).toBeHidden();
    expect(await page.locator(COMMENT).innerHTML()).toBe('a<strong>bc</strong>d<comment-body>note</comment-body>');
  });

  test('pressing the comment button in the fixed toolbar while focus is in the popup reopens the popup of the same comment and moves focus to it', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await placeCaretAt(page, at(COMMENT, 0, 2));
    await page.locator(COMMENT_ITEM).click();
    await expect(page.locator(POPUP)).toBeFocused();

    await page.locator(COMMENT_ITEM).click();

    await expect(page.locator(POPUP)).toBeFocused();
    expect(await readPopupEntries(page)).toEqual(['note']);
  });

  test('when a focused popup closes on replacement during an input stop, focus returns to the editor root when the stop ends', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);
    await placeCaretAt(page, at(COMMENT, 0, 2));
    await page.locator(COMMENT_ITEM).click();
    await expect(page.locator(POPUP)).toBeFocused();
    await stopInput(page);
    await replaceDocument(page, '<p>replaced</p>');
    await expect(page.locator(POPUP)).toBeHidden();

    await resumeInput(page);

    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
  });
});

test.describe('Keeping comments whole when splitting', () => {
  test('pressing Enter at the end of a comment at the end of a paragraph keeps the whole comment in the earlier paragraph and adds an empty paragraph after it', async ({ page }) => {
    await openCommentEditor(page, '<p>ab<comment id="c-1">cd</comment></p>');
    await placeCaretAt(page, at(COMMENT, 0, 2));

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c-1">cd</comment></p>\n<p><br></p>');
  });

  test('pressing Enter at the start of a comment at the start of a paragraph adds an empty paragraph before it and keeps the whole comment in the later paragraph', async ({ page }) => {
    await openCommentEditor(page, '<p><comment id="c-1">ab</comment>cd</p>');
    await placeCaretAt(page, at(COMMENT, 0, 0));

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('\n<p><br></p>\n<p><comment id="c-1">ab</comment>cd</p>');
  });

  test('pressing Enter at the end of a comment at the end of a heading makes the next line a paragraph, not a heading', async ({ page }) => {
    await openCommentEditor(page, '<h2>ab<comment id="c-1">cd</comment></h2>');
    await placeCaretAt(page, at(COMMENT, 0, 2));

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('<h2>ab<comment id="c-1">cd</comment></h2>\n<p><br></p>');
  });

  test('pressing Enter in the middle of the annotated text inserts br inside the comment without splitting the block', async ({ page }) => {
    await openCommentEditor(page, '<p>a<comment id="c-1">bc</comment>d</p>');
    await placeCaretAt(page, at(COMMENT, 0, 1));

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('<p>a<comment id="c-1">b<br>c</comment>d</p>');
  });

  test('pasting two lines of text in the middle of the annotated text joins them with br inside the comment, keeping the character order', async ({ page }) => {
    await openCommentEditor(page, '<p>a<comment id="c-1">bc</comment>d</p>');
    await placeCaretAt(page, at(COMMENT, 0, 1));

    await paste(page, { 'text/plain': 'X\nY' });

    expect(await readBodyHtml(page)).toBe('<p>a<comment id="c-1">bX<br>Yc</comment>d</p>');
  });

  test('pasting two lines at the end of a comment keeps the whole comment in the earlier paragraph and puts the second line in the later paragraph', async ({ page }) => {
    await openCommentEditor(page, '<p>a<comment id="c-1">bc</comment></p>');
    await placeCaretAt(page, at(COMMENT, 0, 2));

    await paste(page, { 'text/plain': 'X\nY' });

    expect(await readBodyHtml(page)).toBe('<p>a<comment id="c-1">bcX</comment></p>\n<p>Y</p>');
  });

  test('pressing Enter at the end of a comment at the end of the line of an item with a nested list adds an empty item at the start of the nested list', async ({ page }) => {
    await openCommentEditor(page, '<ul><li>ab<comment id="c-1">cd</comment><ul><li>e</li></ul></li></ul>');
    await placeCaretAt(page, at(COMMENT, 0, 2));

    await page.keyboard.press('Enter');

    expect([
      await page.locator(`${EDITOR_ROOT} li li`).evaluateAll((items) => items.map((item) => item.innerHTML)),
      await page.locator(`${EDITOR_ROOT} ul > li > comment`).count(),
    ]).toEqual([['<br>', 'e'], 1]);
  });

  test('pressing Enter in the middle of the annotated text in an item with only inline children inserts br without splitting the item', async ({ page }) => {
    await openCommentEditor(page, '<ul><li>a<comment id="c-1">bc</comment>d</li></ul>');
    await placeCaretAt(page, at(COMMENT, 0, 1));

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('<ul><li>a<comment id="c-1">b<br>c</comment>d</li></ul>');
  });

  test('pressing Enter in the middle of the annotated text in a cell of bare text inserts br without splitting the comment', async ({ page }) => {
    await openCommentEditor(page, '<table><tbody><tr><td>a<comment id="c-1">bc</comment>d</td></tr></tbody></table>');
    await placeCaretAt(page, at(COMMENT, 0, 1));

    await page.keyboard.press('Enter');

    expect([
      await page.locator(COMMENT).evaluateAll((comments) => comments.map((comment) => comment.innerHTML)),
      await page.locator(`${EDITOR_ROOT} td > p`).count(),
    ]).toEqual([['b<br>c'], 1]);
  });

  test('pressing Enter in the middle of the annotated text in a paragraph of a details body does not split the comment', async ({ page }) => {
    await openCommentEditor(page, '<details open=""><summary>t</summary><p>a<comment id="c-1">bc</comment>d</p></details>');
    await placeCaretAt(page, at(COMMENT, 0, 1));

    await page.keyboard.press('Enter');

    expect([
      await page.locator(COMMENT).evaluateAll((comments) => comments.map((comment) => comment.innerHTML)),
      await page.locator(`${EDITOR_ROOT} details > p`).count(),
    ]).toEqual([['b<br>c'], 1]);
  });

  test('at the end of the inner of nested comments (handwritten), if it is in the middle of the outer, br is inserted and nothing is split', async ({ page }) => {
    await openCommentEditor(page, '<p><comment id="o">a<comment id="i">b</comment>c</comment></p>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} #i`, 0, 1));

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('<p><comment id="o">a<comment id="i">b<br></comment>c</comment></p>');
  });

  test('after replacement, Enter in the middle of the annotated text still inserts br', async ({ page }) => {
    await openCommentEditor(page, '<p>xy</p>');
    await replaceDocument(page, '<p>a<comment id="c-1">bc</comment>d</p>');
    await placeCaretAt(page, at(COMMENT, 0, 1));

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe('<p>a<comment id="c-1">b<br>c</comment>d</p>');
  });
});

test.describe('Other edits that keep comments whole', () => {
  test('bolding a range that includes part of a comment leaves the comment as one, unsplit', async ({ page }) => {
    await openCommentEditor(page, '<p>ab<comment id="c-1">cd</comment>ef</p>');
    await selectRange(page, at(`${EDITOR_ROOT} p`, 0, 1), at(COMMENT, 0, 1));

    await page.keyboard.press('ControlOrMeta+B');

    expect(await page.locator(COMMENT).evaluateAll((comments) => comments.map((comment) => comment.textContent)))
      .toEqual(['cd']);
  });

  test('converting a paragraph containing a comment to a heading keeps the whole comment', async ({ page }) => {
    await openCommentEditor(page, '<p>a<comment id="c-1">bc<comment-body>note</comment-body></comment>d</p>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 0, 1));

    await page.evaluate(() => window.__blockCommandProbe?.({ kind: 'convert', to: 'heading1' }));

    expect(await readBodyHtml(page)).toBe('<h1>a<comment id="c-1">bc<comment-body>note</comment-body></comment>d</h1>');
  });

  test('merging by Backspace at the start of the paragraph after one ending in a comment keeps the whole comment', async ({ page }) => {
    await openCommentEditor(page, '<p>ab<comment id="c-1">cd</comment></p><p>ef</p>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} p:nth-of-type(2)`, 0, 0));

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c-1">cd</comment>ef</p>');
  });
});

test.describe('Registering the comment button', () => {
  test('the comment button with the accessible name Comment follows the diagram button in the fixed toolbar', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);

    const slots = await page.locator(`${TOOLBAR} [data-slot]`)
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-slot')));

    expect([
      slots.slice(slots.indexOf(TOOLBAR_SLOT.diagram), slots.indexOf(TOOLBAR_SLOT.diagram) + 2),
      await page.locator(COMMENT_ITEM).getAttribute('aria-label'),
    ]).toEqual([[TOOLBAR_SLOT.diagram, TOOLBAR_SLOT.comment], englishMessages['toolbar.comment']]);
  });

  test('selecting a range copies the comment button to the end of the floating menu', async ({ page }) => {
    await openCommentEditor(page, '<p>abcd</p>');
    await selectRange(page, at(`${EDITOR_ROOT} p`, 0, 1), at(`${EDITOR_ROOT} p`, 0, 3));

    await expect(page.locator(FLOATING)).toBeVisible();
    const slots = await page.locator(`${FLOATING} button[data-slot]`)
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('data-slot')));
    expect(slots.at(-1)).toBe(TOOLBAR_SLOT.comment);
  });

  test('in the light, dark and high contrast themes, the comment button icon is drawn in the idle icon color, a softened foreground, not the background color', async ({ page }) => {
    await openCommentEditor(page, BODY_WITH_COMMENT);

    const drawn: boolean[][] = [];
    for (const theme of THEMES) {
      await applyTheme(page, theme.variables);
      const [stroke] = await readComputed(page, `${COMMENT_ITEM} svg`, ['stroke']);
      const idle = await readIdleIconColor(page);
      const [background] = await readComputed(page, 'body', ['background-color']);
      drawn.push([stroke === idle, stroke !== background]);
    }

    expect(drawn).toEqual(THEMES.map(() => [true, true]));
  });

  test('an unopenable document has neither the comment button nor the popup', async ({ page }) => {
    await openWebviewHost(page, PROBE_BUNDLE_PATH);
    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
      text: UNOPENABLE_DOCUMENT,
      documentUri: '',
      resourceRootUri: '',
    });

    await expect(page.locator(`#${OVERLAY_ELEMENT_ID}`)).toBeVisible();
    expect([await page.locator(COMMENT_ITEM).count(), await page.locator(POPUP).count()]).toEqual([0, 0]);
  });
});

test.describe('Placing the popup beside a scrollbar', () => {
  test('keeps the popup clear of a vertical scrollbar for annotated text at the right end', async () => {
    // Headless Chromium hides scrollbars by default, which would hide the bug, and launch options cannot be set inside a
    // group. So this case launches its own browser with the native scrollbar shown.
    const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
    try {
      const page = await browser.newPage();
      await openCommentEditor(page, `${BODY_WITH_COMMENT}<p style="height: 3000px">spacer</p>`);
      await page.addStyleTag({ content: `${EDITOR_ROOT} p { text-align: right; }` });
      // The view must have lost width to the scrollbar, or the check below would pass without checking anything.
      const visibleWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(visibleWidth).toBeLessThan(page.viewportSize()?.width ?? 0);

      await page.locator(COMMENT).click();

      await expect(page.locator(POPUP)).toBeVisible();
      expect((await readBox(page, POPUP)).right).toBeLessThanOrEqual(visibleWidth);
    } finally {
      await browser.close();
    }
  });
});
