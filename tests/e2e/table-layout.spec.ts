import { devices, expect, test } from '@playwright/test';
import type { Frame, Locator, Page } from '@playwright/test';

import {
  DOCUMENT_APPLY_KIND,
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  MESSAGE_CATALOG_ELEMENT_ID,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import type { EditTransaction } from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { CELL_RANGE_MARK_NAME, CELL_RANGE_MARK_NAMESPACE } from '../../webview/editing/cell-range';
import type { TableOperation } from '../../webview/editing/table-command';
import { COLUMN_RESIZE_CURSOR_ATTRIBUTE, COLUMN_RESIZE_MARKER_ID } from '../../webview/ui/column-resize';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import type { InputStopReason } from '../../webview/ui/input-stop';
import { TABLE_MENU_ELEMENT_ID } from '../../webview/ui/table-menu';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import type { ToolbarSlot } from '../../webview/ui/toolbar-slots';
import { EDITOR_ROOT, focusEditor, paste, readBodyHtml } from './helpers/editing';
import {
  PROBE_BUNDLE_PATH,
  getOutboundMessages,
  openFramedWebviewHost,
  openWebviewHost,
  sendToFrame,
  sendToWebview,
} from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const MENU = `#${TABLE_MENU_ELEMENT_ID}`;
const MARKER = `#${COLUMN_RESIZE_MARKER_ID}`;
const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;
const TABLE = `${EDITOR_ROOT} > table`;
const OUTSIDE_FIELD = '#outside-field';

/** A body with just a 2-row, 3-column table. Its columns have no widths, so the table width unit is %. */
const TABLE_BODY = '\n<table>\n<tbody>\n'
  + '<tr><td id="a">ab</td><td id="b">cd</td><td id="c">ef</td></tr>\n'
  + '<tr><td id="d">gh</td><td id="e">ij</td><td id="f">kl</td></tr>\n'
  + '</tbody>\n</table>\n';

/** A body with just a percent table whose columns all render as written. */
const PERCENT_BODY = '\n<table>\n<colgroup><col style="width: 25%"><col style="width: 25%"><col style="width: 50%"></colgroup>\n'
  + '<tbody>\n<tr><td id="a">ab</td><td id="b">cd</td><td id="c">ef</td></tr>\n</tbody>\n</table>\n';

/** A body with just a pixel table whose columns all render as written. */
const PIXEL_BODY = '\n<table style="width: auto">\n<colgroup><col style="width: 100px"><col style="width: 150px"></colgroup>\n'
  + '<tbody>\n<tr><td id="a">ab</td><td id="b">cd</td></tr>\n</tbody>\n</table>\n';

/** A table with a header section and a body section. A range that spans sections cannot be merged. */
const SECTIONED_BODY = '\n<table>\n<thead>\n<tr><th id="h1">h</th><th id="h2">i</th></tr>\n</thead>\n'
  + '<tbody>\n<tr><td id="a">ab</td><td id="b">cd</td></tr>\n</tbody>\n</table>\n';

/** Paragraphs placed before the table so that the floating menu of a range selection does not cover toolbar items. */
const LEADING_PARAGRAPHS = '\n<p>x</p>\n<p>y</p>\n<p>z</p>';

/**
 * Creates a body with just a one-row table, with the given cell contents.
 *
 * @param cells The cell contents. The ids are a, b, c and so on, in order.
 * @returns The body.
 */
function oneRowBody(...cells: readonly string[]): string {
  const ids = ['a', 'b', 'c', 'd'];
  return `\n<table>\n<tbody>\n<tr>${cells.map((cell, index) => `<td id="${ids[index]}">${cell}</td>`).join('')}</tr>\n</tbody>\n</table>\n`;
}

/**
 * Creates a body that places the table in the body of an open details section.
 *
 * @param table The table's HTML.
 * @returns The body.
 */
function inDetails(table: string): string {
  return `\n<details open="">\n<summary>t</summary>${table}</details>\n`;
}

/**
 * The item texts, in the prototype order, for a cell of a percent table that is neither in a range nor merged.
 * Separators are shown as `-`.
 */
const PLAIN_MENU_LABELS = [
  'Insert Row Above',
  'Insert Row Below',
  '-',
  'Insert Column Left',
  'Insert Column Right',
  '-',
  'Delete Row',
  'Delete Column',
  '-',
  'Set Header Row',
  'Set Header Column',
  'Use Pixel Widths',
  '-',
  'Delete Table',
];

/** A theme: the colors VS Code passes on the root element, and whether it puts the high contrast class on the body. */
interface Theme {
  readonly highContrast: boolean;
  readonly variables: Record<string, string>;
}

/** The light, dark and high-contrast themes. */
const THEMES: readonly Theme[] = [
  {
    highContrast: false,
    variables: {
      '--vscode-editor-background': '#ffffff',
      '--vscode-editor-foreground': '#3b3b3b',
      '--vscode-panel-border': '#e5e5e5',
      '--vscode-textLink-foreground': '#005fb8',
      '--vscode-focusBorder': '#005fb8',
      '--vscode-descriptionForeground': '#616161',
    },
  },
  {
    highContrast: false,
    variables: {
      '--vscode-editor-background': '#1f1f1f',
      '--vscode-editor-foreground': '#cccccc',
      '--vscode-panel-border': '#2b2b2b',
      '--vscode-textLink-foreground': '#4daafc',
      '--vscode-focusBorder': '#0078d4',
      '--vscode-descriptionForeground': '#9d9d9d',
    },
  },
  {
    highContrast: true,
    variables: {
      '--vscode-editor-background': '#000000',
      '--vscode-editor-foreground': '#ffffff',
      '--vscode-panel-border': '#6fc3df',
      '--vscode-textLink-foreground': '#21a6ff',
      '--vscode-focusBorder': '#f38518',
      '--vscode-descriptionForeground': '#ffffff',
    },
  },
];

// The view decides the primary modifier from the userAgent, but the Desktop Chrome descriptor returns a Windows
// userAgent regardless of the OS. To press the registered keys with real keystrokes, the userAgent is matched to the
// OS the tests run on.
const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
test.use({ userAgent: process.platform === 'darwin' ? MAC_USER_AGENT : devices['Desktop Chrome'].userAgent });

declare global {
  interface Window {
    /** The forwarded key record. Holds the code of each keydown that reached the window's bubble phase, in order. */
    __forwardedKeys?: string[];
    /** For each menu request that reached the window's bubble phase, whether its default was prevented. */
    __contextMenuPrevented?: boolean[];
  }
}

/**
 * The table operations that hold no elements. Elements cannot be passed as evaluate arguments, so cell merging is
 * excluded.
 */
type SerializableTableOperation = Exclude<TableOperation, { readonly kind: 'mergeCells' }>;

/** A position in text: which child of which element, and at which character. */
interface TextPoint {
  readonly selector: string;
  readonly childIndex: number;
  readonly offset: number;
}

/** A rectangle in viewport coordinates. */
interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Embeds the English message catalog and then mounts the body.
 *
 * If the messages stayed as keys, it could not be confirmed that the item texts come from the catalog.
 *
 * @param page The page to operate.
 * @param body The body to mount.
 */
async function openLayoutEditor(page: Page, body: string): Promise<void> {
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
 * Opens the view in a framed page and returns the frame with the body mounted.
 *
 * @param page The page to operate.
 * @param body The body to mount.
 * @returns The view's frame.
 */
async function openFramedLayoutView(page: Page, body: string): Promise<Frame> {
  const view = await openFramedWebviewHost(page);
  await sendToFrame(view, {
    type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
    text: `${PROLOGUE}${body}${EPILOGUE}`,
    documentUri: '',
    resourceRootUri: '',
  });
  return view;
}

/**
 * Moves focus to the input field outside the frame and confirms that the view lost focus.
 *
 * @param page The page to operate.
 * @param view The view's frame.
 */
async function leaveView(page: Page, view: Frame): Promise<void> {
  await page.locator(OUTSIDE_FIELD).focus();
  await expect.poll(() => view.evaluate(() => document.hasFocus())).toBe(false);
}

/**
 * Returns focus to the view. As when coming back to the tab from another editor, focus goes to the view's window
 * rather than to an element.
 *
 * @param view The view's frame.
 */
async function returnToView(view: Frame): Promise<void> {
  await view.evaluate(() => window.focus());
  await expect.poll(() => view.evaluate(() => document.hasFocus())).toBe(true);
}

/**
 * Moves focus to the editor root and places the caret in a child text of an element.
 *
 * @param target The page or frame to operate.
 * @param selector The selector of the element holding the text.
 * @param offset The position in the text.
 * @param childIndex Which child of the element the text is.
 */
async function placeCaretInText(target: Page | Frame, selector: string, offset: number, childIndex = 0): Promise<void> {
  await target.evaluate((argument) => {
    const root = document.getElementById(argument.rootId);
    const node = document.querySelector(argument.selector)?.childNodes[argument.childIndex];
    if (root === null || node === undefined) {
      throw new Error(`text not found: ${argument.selector}`);
    }
    root.focus();
    const range = document.createRange();
    range.setStart(node, argument.offset);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  }, { selector, offset, childIndex, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Moves focus to the editor root and places the caret on a boundary between an element's children.
 *
 * @param page The page to operate.
 * @param selector The element's selector.
 * @param offset The position of the boundary between children.
 */
async function placeCaretAtElement(page: Page, selector: string, offset: number): Promise<void> {
  await focusEditor(page);
  await page.evaluate((argument) => {
    const element = document.querySelector(argument.selector);
    if (element === null) {
      throw new Error(`element not found: ${argument.selector}`);
    }
    const range = document.createRange();
    range.setStart(element, argument.offset);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  }, { selector, offset });
}

/**
 * Selects between two positions. Focus is put on the editor root.
 *
 * @param page The page to operate.
 * @param start The start.
 * @param end The end.
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
 * Reads the selection as the pair of texts from the start of the editor root to its start and to its end, so that it
 * can be compared regardless of how the positions are expressed.
 *
 * @param target The page or frame to operate.
 * @returns The text up to the start and up to the end, or `null` when there is no selection.
 */
async function readSelectionPrefixes(target: Page | Frame): Promise<[string, string] | null> {
  return target.evaluate((rootSelector): [string, string] | null => {
    const root = document.querySelector(rootSelector);
    const selection = window.getSelection();
    if (root === null || selection === null || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const before = document.createRange();
    before.setStart(root, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const through = document.createRange();
    through.setStart(root, 0);
    through.setEnd(range.endContainer, range.endOffset);
    return [before.toString(), through.toString()];
  }, EDITOR_ROOT);
}

/**
 * Reads at which character in an element the caret (the start, for a range) is.
 *
 * @param target The page or frame to operate.
 * @param selector The element's selector.
 * @returns The number of characters from the start of the element to the start, or `null` when the start is outside
 *   the element.
 */
async function readCaretOffsetIn(target: Page | Frame, selector: string): Promise<number | null> {
  return target.evaluate((element) => {
    const found = document.querySelector(element);
    const selection = window.getSelection();
    if (found === null || selection === null || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (!found.contains(range.startContainer)) {
      return null;
    }
    const before = document.createRange();
    before.setStart(found, 0);
    before.setEnd(range.startContainer, range.startOffset);
    return before.toString().length;
  }, selector);
}

/**
 * Right-clicks a cell and waits for the menu to open.
 *
 * @param page The page to operate.
 * @param selector The cell's selector.
 */
async function openMenuAt(page: Page, selector: string): Promise<void> {
  await page.locator(selector).click({ button: 'right' });
  await expect(page.locator(MENU)).toBeVisible();
}

/**
 * Opens the menu with Shift+F10 and waits for it to open.
 *
 * @param page The page to operate.
 */
async function openMenuByKey(page: Page): Promise<void> {
  await page.keyboard.press('Shift+F10');
  await expect(page.locator(MENU)).toBeVisible();
}

/**
 * Returns a menu item by its text.
 *
 * @param target The page or frame to operate.
 * @param label The item's text.
 * @returns The item.
 */
function menuItem(target: Page | Frame, label: string): Locator {
  return target.locator(MENU).getByRole('menuitem', { name: label, exact: true });
}

/**
 * Reads the list of menu items and separators. Separators are shown as `-`.
 *
 * @param page The page to operate.
 * @returns The list of item texts and separators.
 */
async function readMenuLabels(page: Page): Promise<string[]> {
  return page.locator(`${MENU} > *`).evaluateAll((children) => children.map((child) => (
    child.getAttribute('role') === 'separator' ? '-' : child.textContent ?? ''
  )));
}

/**
 * Reads the text of the focused element.
 *
 * @param page The page to operate.
 * @returns The text.
 */
async function readFocusedText(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.textContent ?? null);
}

/**
 * Reads the body that a save writes out.
 *
 * @param page The page to operate.
 * @returns The body, or `undefined` before mounting.
 */
async function readSavedBody(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__serializationProbe?.()?.body);
}

/**
 * Runs a table operation through the same entry point as the product.
 *
 * @param page The page to operate.
 * @param operation The table operation.
 * @param selector The selector of the reference cell.
 * @returns `true` when the tree was changed.
 */
async function runTableCommand(page: Page, operation: SerializableTableOperation, selector: string): Promise<boolean> {
  return page.evaluate((argument) => {
    const cell = document.querySelector(argument.selector);
    if (cell === null) {
      throw new Error(`cell not found: ${argument.selector}`);
    }
    return window.__tableCommandProbe?.(argument.operation, cell) ?? false;
  }, { operation, selector });
}

/**
 * Replaces the body by calling the document replacement entry point.
 *
 * @param page The page to operate.
 * @param body The new body.
 */
async function replaceBody(page: Page, body: string): Promise<void> {
  await page.evaluate((text) => window.__documentReplacementProbe?.(text), `${PROLOGUE}${body}${EPILOGUE}`);
}

/**
 * Reads the sent edit transactions in the order they were sent.
 *
 * @param page The page to operate.
 * @returns The edit transactions.
 */
async function readTransactions(page: Page): Promise<EditTransaction[]> {
  const messages = await getOutboundMessages(page);
  return messages.flatMap((message) => {
    if (
      typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === VIEW_TO_HOST_MESSAGE_TYPE.editTransaction
      && 'transaction' in message
    ) {
      // Already narrowed by type and shape, and messages of this type carry only an edit transaction.
      return [message.transaction as EditTransaction];
    }
    return [];
  });
}

/**
 * Returns the number of sent messages of the given type.
 *
 * @param page The page to operate.
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
 * Returns the number of messages of the given type sent by the view inside the frame.
 *
 * @param view The view's frame.
 * @param type The message type.
 * @returns The count.
 */
async function countFrameMessages(view: Frame, type: string): Promise<number> {
  return view.evaluate((expected) => (window.__stubHost?.record ?? []).filter((message) => (
    typeof message === 'object' && message !== null && Reflect.get(message, 'type') === expected
  )).length, type);
}

/**
 * Requests that pending edit transactions be sent and waits for the response.
 *
 * Pending edit transactions are sent before the response, so counting afterwards does not miss any that arrive late.
 *
 * @param page The page to operate.
 * @param requestId The request ID.
 */
async function flushEditTransactions(page: Page, requestId: string): Promise<void> {
  await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestEditTransactionFlush, requestId });
  await expect.poll(async () => (await getOutboundMessages(page)).some((message) => (
    typeof message === 'object'
    && message !== null
    && Reflect.get(message, 'type') === VIEW_TO_HOST_MESSAGE_TYPE.editTransactionFlushResult
    && Reflect.get(message, 'requestId') === requestId
  ))).toBe(true);
}

/**
 * Applies the before state of a received edit transaction as an undo.
 *
 * @param page The page to operate.
 * @param transaction The received edit transaction.
 */
async function applyUndo(page: Page, transaction: EditTransaction): Promise<void> {
  await sendToWebview(page, {
    type: HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument,
    requestId: 'layout-undo',
    kind: DOCUMENT_APPLY_KIND.editHistory,
    text: transaction.before.text,
    targetText: transaction.after.text,
    targetSelection: transaction.before.selection,
    editRange: { start: 0, count: 0 },
  });
}

/**
 * Imitates VS Code's forwarding and starts recording the code of each keydown that reaches the window's bubble phase.
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
 * Reads the forwarded key record.
 *
 * @param page The page to operate.
 * @returns The code of each keydown that arrived.
 */
async function readForwardedKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__forwardedKeys ?? []);
}

/**
 * Like the VS Code webview, receives menu requests in the window's bubble phase and starts recording whether their
 * default was prevented.
 *
 * @param page The page to operate.
 */
async function installContextMenuRecord(page: Page): Promise<void> {
  await page.evaluate(() => {
    const record: boolean[] = [];
    window.__contextMenuPrevented = record;
    window.addEventListener('contextmenu', (event) => record.push(event.defaultPrevented));
  });
}

/**
 * Reads the menu request record.
 *
 * @param page The page to operate.
 * @returns For each request that arrived, whether its default was prevented.
 */
async function readContextMenuRecord(page: Page): Promise<boolean[]> {
  return page.evaluate(() => window.__contextMenuPrevented ?? []);
}

/**
 * Applies a theme. VS Code puts the variables on the root element and, in a high contrast theme, a class on the body,
 * so they are put in the same places.
 *
 * @param page The page to operate.
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
 * Presents an overlay. Without a heading it is a blank overlay.
 *
 * @param page The page to operate.
 * @param reason The overlay's reason.
 * @param heading The heading.
 */
async function presentOverlay(page: Page, reason: InputStopReason, heading = ''): Promise<void> {
  await page.evaluate((argument) => {
    window.__uiShellProbe?.()?.overlay.present(argument.reason, { heading: argument.heading, descriptions: [], actions: [] });
  }, { reason, heading });
}

/**
 * Dismisses an overlay.
 *
 * @param page The page to operate.
 * @param reason The overlay's reason.
 */
async function dismissOverlay(page: Page, reason: InputStopReason): Promise<void> {
  await page.evaluate((value: InputStopReason) => window.__uiShellProbe?.()?.overlay.dismiss(value), reason);
}

/**
 * Reads an element's rectangle.
 *
 * @param target The page or frame to operate.
 * @param selector The element's selector.
 * @returns The rectangle in viewport coordinates.
 */
async function readRect(target: Page | Frame, selector: string): Promise<Rect> {
  return target.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
  });
}

/**
 * Reads the rendered widths of the cells in the table's first row.
 *
 * @param target The page or frame to operate.
 * @param selector The table's selector.
 * @returns The rendered width of each cell.
 */
async function readColumnWidths(target: Page | Frame, selector: string): Promise<number[]> {
  return target.locator(selector).evaluate((table) => {
    const row = table.querySelector(':scope > tbody > tr, :scope > tr');
    return row === null ? [] : [...row.children].map((cell) => cell.getBoundingClientRect().width);
  });
}

/**
 * Reads the style width of the table's cols in document order. Cols of nested tables are not included.
 *
 * @param target The page or frame to operate.
 * @param selector The table's selector.
 * @returns The style width of each col.
 */
async function readColumnValues(target: Page | Frame, selector: string): Promise<string[]> {
  return target.locator(selector).evaluate((table) => [...table.querySelectorAll(':scope > colgroup > col')]
    .map((col) => (col instanceof HTMLElement ? col.style.width : '')));
}

/**
 * Reads the width in an element's style attribute.
 *
 * @param page The page to operate.
 * @param selector The element's selector.
 * @returns The style width.
 */
async function readStyleWidth(page: Page, selector: string): Promise<string> {
  return page.locator(selector).evaluate((element) => (element instanceof HTMLElement ? element.style.width : ''));
}

/**
 * Reads the available width: the content width of the table's parent minus the table's left and right margins.
 *
 * @param page The page to operate.
 * @param selector The table's selector.
 * @returns The available width.
 */
async function readAvailableWidth(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((table) => {
    const parent = table.parentElement;
    if (parent === null) {
      return 0;
    }
    const parentStyle = getComputedStyle(parent);
    const tableStyle = getComputedStyle(table);
    return parent.clientWidth
      - Number.parseFloat(parentStyle.paddingLeft) - Number.parseFloat(parentStyle.paddingRight)
      - Number.parseFloat(tableStyle.marginLeft) - Number.parseFloat(tableStyle.marginRight);
  });
}

/**
 * Reads the cell texts of each row of the table. Rows of nested tables are not included.
 *
 * @param page The page to operate.
 * @param selector The table's selector.
 * @returns The cell texts of each row.
 */
async function readRowTexts(page: Page, selector: string): Promise<string[][]> {
  return page.locator(selector).evaluate((table) => [...table.querySelectorAll(':scope > tbody > tr, :scope > thead > tr')]
    .map((row) => [...row.children].map((cell) => cell.textContent ?? '')));
}

/**
 * Reads the names of an element's child elements in order.
 *
 * @param page The page to operate.
 * @param selector The element's selector.
 * @returns The names of the child elements.
 */
async function readChildNames(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluate((element) => [...element.children].map((child) => child.localName));
}

/**
 * Reads the number of lines the text inside an element is rendered on.
 *
 * @param page The page to operate.
 * @param selector The element's selector.
 * @returns The number of lines.
 */
async function countTextLines(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
}

/**
 * Moves the pointer over the band at a cell's right edge. The band is the 6px range inward from the right edge, and
 * the pointer goes to around its middle.
 *
 * @param target The page or frame to operate.
 * @param selector The cell's selector.
 * @returns The position the pointer was placed at (page coordinates).
 */
async function hoverBand(target: Page | Frame, selector: string): Promise<{ x: number; y: number }> {
  const box = await target.locator(selector).boundingBox();
  if (box === null) {
    throw new Error(`cell not rendered: ${selector}`);
  }
  const point = { x: box.x + box.width - 2, y: box.y + box.height / 2 };
  const mouse = 'mouse' in target ? target.mouse : target.page().mouse;
  await mouse.move(point.x, point.y);
  return point;
}

/**
 * Presses the band at a cell's right edge, moves horizontally and releases.
 *
 * @param page The page to operate.
 * @param selector The cell's selector.
 * @param delta The horizontal difference from the press position to the release position.
 */
async function dragBand(page: Page, selector: string, delta: number): Promise<void> {
  const point = await hoverBand(page, selector);
  await page.mouse.down();
  await page.mouse.move(point.x + delta, point.y, { steps: 4 });
  await page.mouse.up();
}

/**
 * Reads the x of the marker's center.
 *
 * @param target The page or frame to operate.
 * @returns The x of the marker's center (viewport coordinates).
 */
async function readMarkerCenter(target: Page | Frame): Promise<number> {
  return target.locator(MARKER).evaluate((marker) => {
    const rect = marker.getBoundingClientRect();
    return rect.left + rect.width / 2;
  });
}

/**
 * Reads an element's computed values.
 *
 * @param target The page or frame to operate.
 * @param selector The element's selector.
 * @param properties The names of the computed values to read.
 * @returns The computed value for each name.
 */
async function readComputed(target: Page | Frame, selector: string, properties: readonly string[]): Promise<string[]> {
  return target.locator(selector).evaluate(
    (element, names) => names.map((name) => getComputedStyle(element).getPropertyValue(name)),
    properties,
  );
}

/**
 * Presses a toolbar item.
 *
 * @param page The page to operate.
 * @param slot The item's slot.
 */
async function pressToolbarItem(page: Page, slot: ToolbarSlot): Promise<void> {
  await page.locator(`${TOOLBAR} [data-slot="${slot}"] > button`).click();
}

/**
 * Chooses an item from the block type popup.
 *
 * @param page The page to operate.
 * @param label The item's accessible name.
 */
async function chooseBlockType(page: Page, label: string): Promise<void> {
  await pressToolbarItem(page, TOOLBAR_SLOT.blockType);
  await page.locator(`${TOOLBAR} [role="menu"] button[aria-label="${label}"]`).click();
}

/**
 * Reads the texts of the cells with the cell range mark, in document order.
 *
 * @param page The page to operate.
 * @returns The texts of the marked cells.
 */
async function readMarkedTexts(page: Page): Promise<string[]> {
  return page.evaluate((argument) => [...document.querySelectorAll(`#${argument.rootId} *`)]
    .filter((element) => element.hasAttributeNS(argument.namespace, argument.name))
    .map((element) => element.textContent ?? ''), {
    rootId: EDITOR_ROOT_ELEMENT_ID,
    namespace: CELL_RANGE_MARK_NAMESPACE,
    name: CELL_RANGE_MARK_NAME,
  });
}

/**
 * Creates a range that spans sections and cannot be merged, and opens the menu on a cell of that range.
 *
 * @param page The page to operate.
 */
async function openMenuOnUnmergeableRange(page: Page): Promise<void> {
  await openLayoutEditor(page, SECTIONED_BODY);
  await placeCaretInText(page, '#h1', 0);
  await page.locator('#b').click({ modifiers: ['Shift'] });
  await openMenuAt(page, '#b');
}

test.describe('attaching the entry points', () => {
  test('opens the menu on a right-click inside a cell even after the document is replaced', async ({ page }) => {
    await openLayoutEditor(page, '\n<p>x</p>\n');
    await replaceBody(page, TABLE_BODY);

    await openMenuAt(page, '#a');

    expect(await readMenuLabels(page)).toEqual(PLAIN_MENU_LABELS);
  });

  test('changes the column width by dragging a column boundary even after the document is replaced', async ({ page }) => {
    await openLayoutEditor(page, '\n<p>x</p>\n');
    await replaceBody(page, TABLE_BODY);
    const before = await readColumnWidths(page, TABLE);

    await dragBand(page, '#a', 40);

    expect(Math.abs((await readColumnWidths(page, TABLE))[0] - (before[0] + 40)) <= 1).toBe(true);
  });

  test('turns the cell content into paragraphs and splits it on Enter in a bare cell even after the document is replaced', async ({ page }) => {
    await openLayoutEditor(page, '\n<p>x</p>\n');
    await replaceBody(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);

    await page.keyboard.press('Enter');

    expect(await page.locator('#a').innerHTML()).toBe('\n<p>a</p>\n<p>b</p>');
  });

  test('closes the menu and returns focus to the editor root when the document is replaced while the menu is open', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await openMenuByKey(page);

    await replaceBody(page, TABLE_BODY.replace('>ab<', '>xy<'));

    await expect(page.locator(MENU)).toHaveCount(0);
    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
  });

  test('closes the menu when replaced by a full text apply (external change) while the menu is open, and returns focus to the editor root when the stop ends', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await openMenuByKey(page);

    // As with the product's remount, replaces via a full text apply request. The apply happens inside an input stop,
    // and the stop ends with the host's release.
    const replaced = TABLE_BODY.replace('>ab<', '>xy<');
    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument,
      requestId: 'layout-external',
      kind: DOCUMENT_APPLY_KIND.externalChange,
      text: `${PROLOGUE}${replaced}${EPILOGUE}`,
    });
    await expect.poll(() => readBodyHtml(page)).toBe(replaced);
    await expect(page.locator(MENU)).toHaveCount(0);
    const focusedWhileStopped = await page.evaluate((id) => document.activeElement?.id === id, EDITOR_ROOT_ELEMENT_ID);
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.saveReleased, resendUnsavedContent: false });

    expect(focusedWhileStopped).toBe(false);
    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
  });

  test('hides the marker when the document is replaced during a drag, and sends no view edited message on a later release', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    const point = await hoverBand(page, '#a');
    await page.mouse.down();
    await page.mouse.move(point.x + 30, point.y, { steps: 2 });

    await replaceBody(page, TABLE_BODY);
    const hidden = await page.locator(MARKER).isHidden();
    await page.mouse.move(point.x + 60, point.y, { steps: 2 });
    await page.mouse.up();
    await flushEditTransactions(page, 'layout-remount');

    expect([
      hidden,
      await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.viewEdited),
      await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction),
    ]).toEqual([true, 0, 0]);
  });
});

test.describe('deciding the menu items', () => {
  test('lists the items in the prototype order with its separators on a right-click on a cell, each with the English text from the catalog', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);

    await openMenuAt(page, '#a');

    expect(await readMenuLabels(page)).toEqual(PLAIN_MENU_LABELS);
  });

  test('lists Merge Cells as enabled on a right-click on a cell of a range made with Shift+click', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await page.locator('#e').click({ modifiers: ['Shift'] });

    await openMenuAt(page, '#e');

    await expect(menuItem(page, 'Merge Cells')).toHaveCount(1);
    await expect(menuItem(page, 'Merge Cells')).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('lists Split Cell as enabled on a right-click on a colspan 2 cell', async ({ page }) => {
    await openLayoutEditor(
      page,
      '\n<table>\n<tbody>\n<tr><td id="a" colspan="2">ab</td></tr>\n<tr><td>c</td><td>d</td></tr>\n</tbody>\n</table>\n',
    );

    await openMenuAt(page, '#a');

    await expect(menuItem(page, 'Split Cell')).toHaveCount(1);
    await expect(menuItem(page, 'Split Cell')).not.toHaveAttribute('aria-disabled', 'true');
  });
});

test.describe('showing and operating the menu', () => {
  test('opens the menu at the pressed position on a right-click inside a cell, and prevents the request\'s default', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await installContextMenuRecord(page);
    const cell = await readRect(page, '#e');
    const point = { x: cell.left + 10, y: cell.top + 5 };

    await page.mouse.click(point.x, point.y, { button: 'right' });

    await expect(page.locator(MENU)).toBeVisible();
    const menu = await readRect(page, MENU);
    expect([Math.abs(menu.left - point.x) <= 1, Math.abs(menu.top - point.y) <= 1, await readContextMenuRecord(page)])
      .toEqual([true, true, [true]]);
  });

  test('does not open the menu or prevent the request\'s default on a right-click on a paragraph outside the table', async ({ page }) => {
    await openLayoutEditor(page, `\n<p id="p">xy</p>${TABLE_BODY}`);
    await installContextMenuRecord(page);

    await page.locator('#p').click({ button: 'right' });

    expect([await page.locator(MENU).count(), await readContextMenuRecord(page)]).toEqual([0, [false]]);
  });

  test('puts focus on the menu itself when opened by right-click, and moves to the first item with Down and the last item with Up', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await openMenuAt(page, '#a');
    const focusedAtOpen = await page.evaluate(() => document.activeElement?.id);
    await page.keyboard.press('ArrowDown');
    const down = await readFocusedText(page);
    await page.keyboard.press('Escape');
    await openMenuAt(page, '#a');

    await page.keyboard.press('ArrowUp');

    expect([focusedAtOpen, down, await readFocusedText(page)]).toEqual([TABLE_MENU_ELEMENT_ID, 'Insert Row Above', 'Delete Table']);
  });

  test('opens the menu below the reference cell with focus on the first item on Shift+F10 with the caret in a cell', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#e', 1);
    const cell = await readRect(page, '#e');

    await openMenuByKey(page);

    const menu = await readRect(page, MENU);
    expect([Math.abs(menu.left - cell.left) <= 1, Math.abs(menu.top - cell.bottom) <= 1, await readFocusedText(page)])
      .toEqual([true, true, 'Insert Row Above']);
  });

  test('does not forward the Shift+F10 that opened the menu to VS Code', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await installForwardRecord(page);

    await openMenuByKey(page);

    expect((await readForwardedKeys(page)).includes('F10')).toBe(false);
  });

  test('opens the menu on the Menu key with the caret in a cell, without forwarding the key to VS Code', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await installForwardRecord(page);

    await page.keyboard.press('ContextMenu');

    await expect(page.locator(MENU)).toBeVisible();
    expect((await readForwardedKeys(page)).includes('ContextMenu')).toBe(false);
  });

  test('does not open the menu on Shift+F10 with the caret outside cells, and forwards it to VS Code as before', async ({ page }) => {
    await openLayoutEditor(page, `\n<p id="p">xy</p>${TABLE_BODY}`);
    await placeCaretInText(page, '#p', 1);
    await installForwardRecord(page);

    await page.keyboard.press('Shift+F10');

    expect([await page.locator(MENU).count(), (await readForwardedKeys(page)).includes('F10')]).toEqual([0, true]);
  });

  test('wraps to the first item with Down on the last item and to the last item with Up on the first item', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await openMenuByKey(page);

    await page.keyboard.press('ArrowUp');
    const wrappedUp = await readFocusedText(page);
    await page.keyboard.press('ArrowDown');

    expect([wrappedUp, await readFocusedText(page)]).toEqual(['Delete Table', 'Insert Row Above']);
  });

  test('moves to the first item with Home and the last item with End', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await openMenuByKey(page);
    await page.keyboard.press('ArrowDown');

    await page.keyboard.press('End');
    const end = await readFocusedText(page);
    await page.keyboard.press('Home');

    expect([end, await readFocusedText(page)]).toEqual(['Delete Table', 'Insert Row Above']);
  });

  test('stops focus on the disabled merge item too when pressing Down around it', async ({ page }) => {
    await openMenuOnUnmergeableRange(page);
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    const before = await readFocusedText(page);

    await page.keyboard.press('ArrowDown');
    const merge = await readFocusedText(page);
    const disabled = await page.evaluate(() => document.activeElement?.getAttribute('aria-disabled'));
    await page.keyboard.press('ArrowDown');

    expect([before, merge, disabled, await readFocusedText(page)])
      .toEqual(['Use Pixel Widths', 'Merge Cells', 'true', 'Delete Table']);
  });

  test('closes the menu on Escape and returns focus and the selection at opening to the editor root', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await selectRange(page, { selector: '#e', childIndex: 0, offset: 0 }, { selector: '#e', childIndex: 0, offset: 1 });
    const selection = await readSelectionPrefixes(page);
    await openMenuByKey(page);

    await page.keyboard.press('Escape');

    await expect(page.locator(MENU)).toHaveCount(0);
    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
    expect(await readSelectionPrefixes(page)).toEqual(selection);
  });

  test('does not forward the Escape that closed the menu to VS Code', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await openMenuByKey(page);
    await installForwardRecord(page);

    await page.keyboard.press('Escape');

    await expect(page.locator(MENU)).toHaveCount(0);
    expect((await readForwardedKeys(page)).includes('Escape')).toBe(false);
  });

  test('closes the menu on Tab, returns focus and the selection to the editor root, and does not forward Tab', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#e', 1);
    const selection = await readSelectionPrefixes(page);
    await openMenuByKey(page);
    await installForwardRecord(page);

    await page.keyboard.press('Tab');

    await expect(page.locator(MENU)).toHaveCount(0);
    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
    expect([await readSelectionPrefixes(page), (await readForwardedKeys(page)).includes('Tab')]).toEqual([selection, false]);
  });

  test('closes the menu on Shift+Tab, returns focus and the selection to the editor root, and does not forward the key', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#e', 1);
    const selection = await readSelectionPrefixes(page);
    await openMenuByKey(page);
    await installForwardRecord(page);

    await page.keyboard.press('Shift+Tab');

    await expect(page.locator(MENU)).toHaveCount(0);
    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
    expect([await readSelectionPrefixes(page), (await readForwardedKeys(page)).includes('Tab')]).toEqual([selection, false]);
  });

  test('keeps the range mark when a menu opened on a cell of the range is closed with Escape', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await page.locator('#e').click({ modifiers: ['Shift'] });
    await openMenuAt(page, '#e');

    await page.keyboard.press('Escape');

    await expect(page.locator(MENU)).toHaveCount(0);
    expect(await readMarkedTexts(page)).toEqual(['ab', 'cd', 'gh', 'ij']);
  });

  test('closes the menu and moves the caret to the pressed position when another cell outside the menu is pressed', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await openMenuByKey(page);

    await page.locator('#f').click();

    await expect(page.locator(MENU)).toHaveCount(0);
    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
    expect(await readCaretOffsetIn(page, '#f')).not.toBeNull();
  });

  test('neither forwards the key nor changes the body when the bold shortcut is pressed while the menu is open', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await selectRange(page, { selector: '#a', childIndex: 0, offset: 0 }, { selector: '#a', childIndex: 0, offset: 2 });
    await openMenuByKey(page);
    await installForwardRecord(page);

    await page.keyboard.press('ControlOrMeta+KeyB');

    expect([(await readForwardedKeys(page)).includes('KeyB'), await readBodyHtml(page)]).toEqual([false, TABLE_BODY]);
  });

  test('prevents the request\'s default and keeps the menu open on a right-click over the menu', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await openMenuByKey(page);
    await installContextMenuRecord(page);

    await menuItem(page, 'Delete Row').click({ button: 'right' });

    await expect(page.locator(MENU)).toBeVisible();
    expect(await readContextMenuRecord(page)).toEqual([true]);
  });

  test('keeps the menu open while an overlay with content is presented, and returns focus to the menu item when it is dismissed', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await openMenuByKey(page);

    await presentOverlay(page, INPUT_STOP_REASON.saveRoundTrip, 'Saving');
    const openDuringOverlay = await page.locator(MENU).isVisible();
    await dismissOverlay(page, INPUT_STOP_REASON.saveRoundTrip);

    expect(openDuringOverlay).toBe(true);
    await expect(menuItem(page, 'Insert Row Above')).toBeFocused();
  });

  test('closes the menu when focus moves outside the frame in a framed page, and restores the caret at opening in the editor root on returning to the view', async ({ page }) => {
    const view = await openFramedLayoutView(page, TABLE_BODY);
    await placeCaretInText(view, '#e', 1);
    const selection = await readSelectionPrefixes(view);
    await page.keyboard.press('Shift+F10');
    await expect(view.locator(MENU)).toBeVisible();

    await leaveView(page, view);
    await expect(view.locator(MENU)).toHaveCount(0);
    await returnToView(view);

    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
    expect(await readSelectionPrefixes(view)).toEqual(selection);
  });

  test('returns focus and the selection at opening to the editor root when the blank overlay is dismissed, after closing with Escape while it was presented', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#e', 1);
    const selection = await readSelectionPrefixes(page);
    await openMenuByKey(page);
    await presentOverlay(page, INPUT_STOP_REASON.saveRoundTrip);

    await page.keyboard.press('Escape');
    await expect(page.locator(MENU)).toHaveCount(0);
    const focusedWhileStopped = await page.evaluate((id) => document.activeElement?.id === id, EDITOR_ROOT_ELEMENT_ID);
    await dismissOverlay(page, INPUT_STOP_REASON.saveRoundTrip);

    expect(focusedWhileStopped).toBe(false);
    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
    expect(await readSelectionPrefixes(page)).toEqual(selection);
  });

  test('does not close the menu when the view is scrolled while it is open, and keeps its position relative to the table', async ({ page }) => {
    await openLayoutEditor(page, `${TABLE_BODY}<p style="height: 2000px">z</p>\n`);
    await placeCaretInText(page, '#a', 1);
    await openMenuByKey(page);
    const before = [(await readRect(page, MENU)).top - (await readRect(page, TABLE)).top];

    await page.evaluate(() => window.scrollBy(0, 100));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(100);

    await expect(page.locator(MENU)).toBeVisible();
    const after = (await readRect(page, MENU)).top - (await readRect(page, TABLE)).top;
    expect(Math.abs(after - before[0]) <= 1).toBe(true);
  });

  test('fits the whole menu in the visible area even when opened on a cell near the bottom right of the visible area', async ({ page }) => {
    await openLayoutEditor(page, `\n<p style="height: 560px">x</p>${TABLE_BODY}`);
    const cell = await readRect(page, '#f');
    const viewport = page.viewportSize();

    await page.mouse.click(cell.right - 20, cell.bottom - 5, { button: 'right' });

    await expect(page.locator(MENU)).toBeVisible();
    const menu = await readRect(page, MENU);
    expect([
      menu.left >= 0,
      menu.right <= (viewport?.width ?? 0),
      menu.top >= 0,
      menu.bottom <= (viewport?.height ?? 0),
    ]).toEqual([true, true, true, true]);
  });

  test('fits the whole menu in the visible area near the bottom right even when its size has a fraction below half a pixel', async ({ page }) => {
    await openLayoutEditor(page, `\n<p style="height: 560px">x</p>${TABLE_BODY}`);
    // Sizes that whole-pixel measurement rounds down, whatever the font. Both are larger than the menu's contents.
    await page.addStyleTag({ content: `${MENU} { box-sizing: border-box; width: 150.25px; height: 400.25px; }` });
    const cell = await readRect(page, '#f');
    const viewport = page.viewportSize();

    await page.mouse.click(cell.right - 20, cell.bottom - 5, { button: 'right' });

    await expect(page.locator(MENU)).toBeVisible();
    const menu = await readRect(page, MENU);
    expect([
      menu.width,
      menu.height,
      menu.right <= (viewport?.width ?? 0),
      menu.bottom <= (viewport?.height ?? 0),
    ]).toEqual([150.25, 400.25, true, true]);
  });

  test('gives the menu the menu role and the catalog name, the items the menuitem role, and disabled items aria-disabled="true"', async ({ page }) => {
    await openMenuOnUnmergeableRange(page);

    const menu = page.getByRole('menu', { name: 'Table Actions', exact: true });
    await expect(menu).toHaveCount(1);
    await expect(menu.getByRole('menuitem')).toHaveCount(11);
    await expect(menuItem(page, 'Merge Cells')).toHaveAttribute('aria-disabled', 'true');
  });

  test('shows a disabled item in the muted text color without a dashed border in light and dark themes, and with a dashed border in a color that differs from the background in a high-contrast theme', async ({ page }) => {
    await openMenuOnUnmergeableRange(page);

    const drawn: { style: string; text: string; matchesBackground: boolean }[] = [];
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      const [style, color, text] = await readComputed(
        page,
        `${MENU} [aria-disabled="true"]`,
        ['border-top-style', 'border-top-color', 'color'],
      );
      const [background] = await readComputed(page, MENU, ['background-color']);
      drawn.push({ style, text, matchesBackground: color === background });
    }

    // The text colors are the description foregrounds the themes give.
    expect(drawn).toEqual([
      { style: 'solid', text: 'rgb(97, 97, 97)', matchesBackground: false },
      { style: 'solid', text: 'rgb(157, 157, 157)', matchesBackground: false },
      { style: 'dashed', text: 'rgb(255, 255, 255)', matchesBackground: false },
    ]);
  });

  test('rounds the corners of the menu with a 6px radius and gives it a shadow', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);

    await openMenuAt(page, '#a');

    const [topLeft, bottomRight, shadow] = await readComputed(
      page,
      MENU,
      ['border-top-left-radius', 'border-bottom-right-radius', 'box-shadow'],
    );
    expect([topLeft, bottomRight, shadow !== 'none']).toEqual(['6px', '6px', true]);
  });

  test('gives an enabled item under the pointer the code background, and a disabled item under the pointer none', async ({ page }) => {
    await openMenuOnUnmergeableRange(page);
    await applyTheme(page, { highContrast: false, variables: { '--vscode-textCodeBlock-background': 'rgb(240, 241, 242)' } });

    await menuItem(page, 'Insert Row Above').hover();
    const enabled = await menuItem(page, 'Insert Row Above').evaluate((item) => getComputedStyle(item).backgroundColor);
    await menuItem(page, 'Merge Cells').hover();
    const disabled = await menuItem(page, 'Merge Cells').evaluate((item) => getComputedStyle(item).backgroundColor);

    expect([enabled, disabled]).toEqual(['rgb(240, 241, 242)', 'rgba(0, 0, 0, 0)']);
  });

  test('shows a 2px solid outline on an item reached by keyboard in a color that differs from the background in light, dark and high-contrast themes', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await openMenuByKey(page);
    await page.keyboard.press('ArrowDown');

    const drawn: { style: string; width: string; matchesBackground: boolean }[] = [];
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      const [style, width, color] = await readComputed(page, `${MENU} button:focus`, ['outline-style', 'outline-width', 'outline-color']);
      const [background] = await readComputed(page, MENU, ['background-color']);
      drawn.push({ style, width, matchesBackground: color === background });
    }

    expect(drawn).toEqual(THEMES.map(() => ({ style: 'solid', width: '2px', matchesBackground: false })));
  });

  test('gives the menu border and separators colors that differ from the background in light, dark and high-contrast themes', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await openMenuAt(page, '#a');

    const drawn: { border: boolean; separator: boolean }[] = [];
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      const [border, background] = await readComputed(page, MENU, ['border-top-color', 'background-color']);
      const [separator] = await readComputed(page, `${MENU} [role="separator"] >> nth=0`, ['background-color']);
      drawn.push({ border: border === background, separator: separator === background });
    }

    expect(drawn).toEqual(THEMES.map(() => ({ border: false, separator: false })));
  });

  test('places the menu outside the editor root, so it does not appear in the body output while open', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);

    await openMenuAt(page, '#a');

    const insideRoot = await page.evaluate((argument) => document.getElementById(argument.rootId)
      ?.contains(document.getElementById(argument.menuId)) ?? true, { rootId: EDITOR_ROOT_ELEMENT_ID, menuId: TABLE_MENU_ELEMENT_ID });
    expect([insideRoot, await readSavedBody(page)]).toEqual([false, TABLE_BODY]);
  });

  test('opens the menu on a right-click on a cell even in a table inside the body of a details section', async ({ page }) => {
    await openLayoutEditor(page, inDetails(TABLE_BODY));

    await openMenuAt(page, '#a');

    expect(await readMenuLabels(page)).toEqual(PLAIN_MENU_LABELS);
  });
});

test.describe('running an item', () => {
  test('adds a row above the reference cell when Insert Row Above is run with Enter, and delivers exactly one settled edit transaction', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#e', 1);
    await openMenuByKey(page);

    await page.keyboard.press('Enter');
    await flushEditTransactions(page, 'layout-insert-above');

    expect([await readRowTexts(page, TABLE), (await readTransactions(page)).length])
      .toEqual([[['ab', 'cd', 'ef'], ['', '', ''], ['gh', 'ij', 'kl']], 1]);
  });

  test('adds a row below the reference cell when Insert Row Below is run by a press', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await openMenuByKey(page);

    await menuItem(page, 'Insert Row Below').click();

    expect(await readRowTexts(page, TABLE)).toEqual([['ab', 'cd', 'ef'], ['', '', ''], ['gh', 'ij', 'kl']]);
  });

  test('adds a column to the left of the reference cell when Insert Column Left is run', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#b', 1);
    await openMenuByKey(page);

    await menuItem(page, 'Insert Column Left').click();

    expect(await readRowTexts(page, TABLE)).toEqual([['ab', '', 'cd', 'ef'], ['gh', '', 'ij', 'kl']]);
  });

  test('adds a column to the right of the reference cell when Insert Column Right is run', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#b', 1);
    await openMenuByKey(page);

    await menuItem(page, 'Insert Column Right').click();

    expect(await readRowTexts(page, TABLE)).toEqual([['ab', 'cd', '', 'ef'], ['gh', 'ij', '', 'kl']]);
  });

  test('removes the reference cell\'s row when Delete Row is run', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#e', 1);
    await openMenuByKey(page);

    await menuItem(page, 'Delete Row').click();

    expect(await readRowTexts(page, TABLE)).toEqual([['ab', 'cd', 'ef']]);
  });

  test('removes the reference cell\'s column when Delete Column is run', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#b', 1);
    await openMenuByKey(page);

    await menuItem(page, 'Delete Column').click();

    expect(await readRowTexts(page, TABLE)).toEqual([['ab', 'ef'], ['gh', 'kl']]);
  });

  test('turns the reference cell\'s row into th when the header row toggle is run, and gives the same item the unset text in the next menu', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await openMenuByKey(page);

    await menuItem(page, 'Set Header Row').click();
    const names = await readChildNames(page, `${TABLE} tr:first-child`);
    await openMenuByKey(page);

    expect(names).toEqual(['th', 'th', 'th']);
    await expect(menuItem(page, 'Unset Header Row')).toHaveCount(1);
  });

  test('turns the cells of the reference cell\'s column that are not in a header row into th when the header column toggle is run', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await openMenuByKey(page);

    await menuItem(page, 'Set Header Column').click();

    expect(await page.locator(`${TABLE} tr > :first-child`).evaluateAll((cells) => cells.map((cell) => cell.localName)))
      .toEqual(['th', 'th']);
  });

  test('turns the cols of all columns of a percent table into px when the column width unit toggle is run', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await openMenuByKey(page);

    await menuItem(page, 'Use Pixel Widths').click();

    const values = await readColumnValues(page, TABLE);
    expect([values.length, values.every((value) => /^\d+px$/u.test(value))]).toEqual([3, true]);
  });

  test('turns the range\'s rectangle into one cell when Merge Cells is run from the menu of a cell of the range', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await page.locator('#e').click({ modifiers: ['Shift'] });
    await openMenuAt(page, '#e');

    await menuItem(page, 'Merge Cells').click();

    const merged = await page.locator('#a').evaluate((cell) => [cell.getAttribute('rowspan'), cell.getAttribute('colspan')]);
    expect([merged, await page.locator(`${TABLE} td`).count()]).toEqual([['2', '2'], 3]);
  });

  test('removes the span and inserts empty cells when Split Cell is run from the menu of a merged cell', async ({ page }) => {
    await openLayoutEditor(
      page,
      '\n<table>\n<tbody>\n<tr><td id="a" colspan="2">ab</td></tr>\n<tr><td>c</td><td>d</td></tr>\n</tbody>\n</table>\n',
    );
    await openMenuAt(page, '#a');

    await menuItem(page, 'Split Cell').click();

    expect([await page.locator('#a').getAttribute('colspan'), await readRowTexts(page, TABLE)])
      .toEqual([null, [['ab', ''], ['c', 'd']]]);
  });

  test('removes the table when Delete Table is run, leaving the caret in the placement paragraph', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await openMenuByKey(page);

    await menuItem(page, 'Delete Table').click();

    expect([await readBodyHtml(page), await readCaretOffsetIn(page, `${EDITOR_ROOT} > p`)]).toEqual(['\n<p><br></p>\n', 0]);
  });

  test('does not let the Enter that runs an item reach the editor root as a paragraph insertion', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await openMenuByKey(page);
    await page.keyboard.press('ArrowDown');

    await page.keyboard.press('Enter');

    expect([await page.locator('#a').innerHTML(), await readRowTexts(page, TABLE)])
      .toEqual(['ab', [['ab', 'cd', 'ef'], ['', '', ''], ['gh', 'ij', 'kl']]]);
  });

  test('leaves the body unchanged and the menu open when Enter is pressed on, or a press is made on, the disabled merge item', async ({ page }) => {
    await openMenuOnUnmergeableRange(page);
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowUp');

    await page.keyboard.press('Enter');
    const openAfterEnter = await page.locator(MENU).isVisible();
    // Playwright keeps waiting on an aria-disabled item as not pressable, so the checks are skipped for the press.
    await menuItem(page, 'Merge Cells').click({ force: true });

    // The range mark is in the tree as an internal attribute, so the body is compared through the save output.
    await expect(page.locator(MENU)).toBeVisible();
    expect([openAfterEnter, await readSavedBody(page)]).toEqual([true, SECTIONED_BODY]);
  });

  test('keeps the caret at its position at opening, with focus in the editor root, after running Insert Column Left, which returns no placement', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#b', 1);
    await openMenuByKey(page);

    await menuItem(page, 'Insert Column Left').click();

    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
    expect(await readCaretOffsetIn(page, '#b')).toBe(1);
  });

  test('runs Insert Row Below from the menu the same way in a table inside the body of a details section as outside it', async ({ page }) => {
    await openLayoutEditor(page, inDetails(TABLE_BODY));
    await placeCaretInText(page, '#a', 1);
    await openMenuByKey(page);

    await menuItem(page, 'Insert Row Below').click();

    expect(await readRowTexts(page, `${EDITOR_ROOT} details > table`)).toEqual([['ab', 'cd', 'ef'], ['', '', ''], ['gh', 'ij', 'kl']]);
  });
});

test.describe('the column boundary marker and drag', () => {
  test('shows the marker at the boundary with the table\'s height and gives the pointer the col-resize shape when the pointer is on the band at a cell\'s right edge', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    const cell = await readRect(page, '#a');
    const table = await readRect(page, TABLE);

    await hoverBand(page, '#a');

    await expect(page.locator(MARKER)).toBeVisible();
    const marker = await readRect(page, MARKER);
    expect([
      Math.abs(await readMarkerCenter(page) - cell.right) <= 1,
      Math.abs(marker.top - table.top) <= 1,
      Math.abs(marker.height - table.height) <= 1,
      (await readComputed(page, '#a', ['cursor']))[0],
    ]).toEqual([true, true, true, 'col-resize']);
  });

  test('hides the marker and restores the pointer shape when the pointer leaves the band', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    const cell = await readRect(page, '#a');
    await hoverBand(page, '#a');
    await expect(page.locator(MARKER)).toBeVisible();

    await page.mouse.move(cell.left + cell.width / 2, cell.top + cell.height / 2);

    await expect(page.locator(MARKER)).toBeHidden();
    expect((await readComputed(page, '#a', ['cursor']))[0]).not.toBe('col-resize');
  });

  test('shows no marker at the right edge of the rightmost column of a percent table, and a press there moves the caret to the pressed position', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);

    await hoverBand(page, '#c');
    const hidden = await page.locator(MARKER).isHidden();
    await page.mouse.down();
    await page.mouse.up();

    expect([hidden, await readCaretOffsetIn(page, '#c')]).toEqual([true, 2]);
  });

  test('puts the boundary at the release position (±1px) and narrows the right neighbor by the difference when a boundary of a percent table is dragged right and released', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    const before = await readColumnWidths(page, TABLE);
    const boundary = (await readRect(page, '#a')).right;

    await dragBand(page, '#a', 60);

    const after = await readColumnWidths(page, TABLE);
    expect([
      Math.abs((await readRect(page, '#a')).right - (boundary + 60)) <= 1,
      Math.abs(after[1] - (before[1] - 60)) <= 1,
      Math.abs(after[2] - before[2]) <= 1,
    ]).toEqual([true, true, true]);
  });

  test('leaves the col values of columns other than the target and its right neighbor unchanged when dragging a boundary of a percent table whose columns all render as written', async ({ page }) => {
    await openLayoutEditor(page, PERCENT_BODY);

    await dragBand(page, '#a', 30);

    const values = await readColumnValues(page, TABLE);
    expect([values[0] === '25%', values[1] === '25%', values[2]]).toEqual([false, false, '50%']);
  });

  test('changes only the target column up to the release position and the table width by the same amount when a boundary of a pixel table is dragged', async ({ page }) => {
    await openLayoutEditor(page, PIXEL_BODY);
    const before = await readColumnWidths(page, TABLE);
    const beforeTable = await readRect(page, TABLE);

    await dragBand(page, '#a', 50);

    const after = await readColumnWidths(page, TABLE);
    const afterTable = await readRect(page, TABLE);
    expect([
      Math.abs(after[0] - (before[0] + 50)) <= 1,
      Math.abs(after[1] - before[1]) <= 1,
      Math.abs(afterTable.width - (beforeTable.width + 50)) <= 1,
    ]).toEqual([true, true, true]);
  });

  test('leaves the body output unchanged and sends no view edited message during a drag, with only the marker following the pointer', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    const boundary = (await readRect(page, '#a')).right;
    const point = await hoverBand(page, '#a');
    await page.mouse.down();

    await page.mouse.move(point.x + 30, point.y, { steps: 3 });

    const during = [
      Math.abs(await readMarkerCenter(page) - (boundary + 30)) <= 1,
      await readSavedBody(page),
      await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.viewEdited),
    ];
    await page.mouse.up();
    expect(during).toEqual([true, TABLE_BODY, 0]);
  });

  test('delivers exactly one settled edit transaction when dragged and released', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);

    await dragBand(page, '#a', 40);
    await flushEditTransactions(page, 'layout-drag');

    expect((await readTransactions(page)).map((transaction) => transaction.before.text))
      .toEqual([`${PROLOGUE}${TABLE_BODY}${EPILOGUE}`]);
  });

  test('sends neither a view edited message nor an edit transaction when the band is pressed and released at the same position', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await hoverBand(page, '#a');

    await page.mouse.down();
    await page.mouse.up();
    await flushEditTransactions(page, 'layout-still');

    expect([
      await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.viewEdited),
      await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction),
    ]).toEqual([0, 0]);
  });

  test('leaves the caret position and the selection unchanged before release when the band is pressed', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await selectRange(page, { selector: '#e', childIndex: 0, offset: 0 }, { selector: '#e', childIndex: 0, offset: 1 });
    const selection = await readSelectionPrefixes(page);
    await hoverBand(page, '#a');

    await page.mouse.down();

    const during = await readSelectionPrefixes(page);
    await page.mouse.up();
    expect(during).toEqual(selection);
  });

  test('leaves the range mark unchanged before release when the band is Shift+pressed while a range exists', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);
    await page.locator('#e').click({ modifiers: ['Shift'] });
    const marked = await readMarkedTexts(page);
    await hoverBand(page, '#b');

    await page.keyboard.down('Shift');
    await page.mouse.down();

    const during = await readMarkedTexts(page);
    await page.mouse.up();
    await page.keyboard.up('Shift');
    expect([marked, during]).toEqual([['ab', 'cd', 'gh', 'ij'], ['ab', 'cd', 'gh', 'ij']]);
  });

  test('keeps the marker and the written width where the target column does not fall below 20px, even when the boundary is dragged far to the left', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    const cell = await readRect(page, '#a');
    const point = await hoverBand(page, '#a');
    await page.mouse.down();

    await page.mouse.move(1, point.y, { steps: 4 });
    const marker = await readMarkerCenter(page);
    await page.mouse.up();

    const tableWidth = (await readRect(page, TABLE)).width;
    const written = Number.parseFloat((await readColumnValues(page, TABLE))[0]) / 100 * tableWidth;
    expect([Math.abs(marker - (cell.left + 20)) <= 1, Math.abs(written - 20) <= 1]).toEqual([true, true]);
  });

  test('stops where the right neighbor does not fall below 20px, even when a boundary of a percent table is dragged far to the right', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    const point = await hoverBand(page, '#a');
    await page.mouse.down();

    await page.mouse.move((page.viewportSize()?.width ?? 1) - 1, point.y, { steps: 4 });
    await page.mouse.up();

    const tableWidth = (await readRect(page, TABLE)).width;
    const written = Number.parseFloat((await readColumnValues(page, TABLE))[1]) / 100 * tableWidth;
    expect(Math.abs(written - 20) <= 1).toBe(true);
  });

  test('stops where the table width does not exceed the available width, even when a boundary of a pixel table is dragged far to the right', async ({ page }) => {
    await openLayoutEditor(page, PIXEL_BODY);
    const available = await readAvailableWidth(page, TABLE);
    const point = await hoverBand(page, '#a');
    await page.mouse.down();

    await page.mouse.move((page.viewportSize()?.width ?? 1) - 1, point.y, { steps: 4 });
    await page.mouse.up();

    expect(Math.abs((await readRect(page, TABLE)).width - available) <= 1).toBe(true);
  });

  test('does not move the boundary on a drag to the right, and narrows the column on a drag to the left, for a pixel table whose width is set wider than the available width', async ({ page }) => {
    await openLayoutEditor(
      page,
      '\n<table style="width: 2000px">\n<colgroup><col style="width: 1000px"><col style="width: 1000px"></colgroup>\n'
      + '<tbody>\n<tr><td id="a">ab</td><td id="b">cd</td></tr>\n</tbody>\n</table>\n',
    );
    const before = await readColumnWidths(page, TABLE);

    await dragBand(page, '#a', 50);
    const afterRight = await readColumnWidths(page, TABLE);
    await dragBand(page, '#a', -50);

    const afterLeft = await readColumnWidths(page, TABLE);
    expect([Math.abs(afterRight[0] - before[0]) <= 1, afterLeft[0] < before[0] - 1]).toEqual([true, true]);
  });

  test('moves the boundary of the rightmost column a colspan 2 cell covers when its right edge is dragged', async ({ page }) => {
    await openLayoutEditor(
      page,
      '\n<table>\n<tbody>\n<tr><td id="a" colspan="2">ab</td><td id="c">ef</td></tr>\n'
      + '<tr><td id="d">gh</td><td id="e">ij</td><td id="f">kl</td></tr>\n</tbody>\n</table>\n',
    );
    const before = [(await readRect(page, '#d')).width, (await readRect(page, '#e')).right];

    await dragBand(page, '#a', 40);

    expect([
      Math.abs((await readRect(page, '#d')).width - before[0]) <= 1,
      Math.abs((await readRect(page, '#e')).right - (before[1] + 40)) <= 1,
    ]).toEqual([true, true]);
  });

  test('changes only the inner table\'s cols, not the outer table, when a boundary of a nested table\'s cell is dragged', async ({ page }) => {
    await openLayoutEditor(
      page,
      '\n<table id="outer">\n<tbody>\n<tr><td id="a">ab</td><td id="b">'
      + '<table id="inner"><tbody><tr><td id="i1">x</td><td id="i2">y</td></tr></tbody></table></td></tr>\n'
      + '</tbody>\n</table>\n',
    );
    const outer = await readColumnWidths(page, '#outer');

    await dragBand(page, '#i1', 30);

    expect([
      (await readColumnValues(page, '#inner')).length,
      await readColumnValues(page, '#outer'),
      (await readColumnWidths(page, '#outer')).map((width, index) => Math.abs(width - outer[index]) <= 1),
    ]).toEqual([2, [], [true, true]]);
  });

  test('closes the menu and then starts a drag when the band is pressed while the menu is open, changing the column width on release', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#e', 1);
    await openMenuByKey(page);
    const before = await readColumnWidths(page, TABLE);

    await dragBand(page, '#a', 40);

    await expect(page.locator(MENU)).toHaveCount(0);
    expect(Math.abs((await readColumnWidths(page, TABLE))[0] - (before[0] + 40)) <= 1).toBe(true);
  });

  test('does not open the menu on a right-click inside a cell during a drag', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    const point = await hoverBand(page, '#a');
    await page.mouse.down();
    await page.mouse.move(point.x + 20, point.y, { steps: 2 });

    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });

    const opened = await page.locator(MENU).count();
    await page.mouse.up();
    expect(opened).toBe(0);
  });

  test('hides the marker when focus moves outside the frame during a drag in a framed page, and sends no view edited message on release', async ({ page }) => {
    const view = await openFramedLayoutView(page, TABLE_BODY);
    await placeCaretInText(view, '#e', 1);
    const point = await hoverBand(view, '#a');
    await page.mouse.down();
    await page.mouse.move(point.x + 30, point.y, { steps: 2 });

    await leaveView(page, view);
    const hidden = await view.locator(MARKER).isHidden();
    await page.mouse.move(point.x + 60, point.y, { steps: 2 });
    await page.mouse.up();

    expect([
      hidden,
      await countFrameMessages(view, VIEW_TO_HOST_MESSAGE_TYPE.viewEdited),
      await view.locator(`${TABLE} > colgroup`).count(),
    ]).toEqual([true, 0, 0]);
  });

  test('changes the column width by dragging even in a table inside the body of a details section, without toggling the details section', async ({ page }) => {
    await openLayoutEditor(page, inDetails(TABLE_BODY));
    const table = `${EDITOR_ROOT} details > table`;
    const before = await readColumnWidths(page, table);

    await dragBand(page, '#a', 40);

    expect([
      Math.abs((await readColumnWidths(page, table))[0] - (before[0] + 40)) <= 1,
      await page.locator(`${EDITOR_ROOT} details`).getAttribute('open'),
    ]).toEqual([true, '']);
  });

  test('places the marker outside the editor root, so neither the marker nor the cursor attribute appears in the body output while it is shown', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);

    await hoverBand(page, '#a');
    await expect(page.locator(MARKER)).toBeVisible();

    const insideRoot = await page.evaluate((argument) => document.getElementById(argument.rootId)
      ?.contains(document.getElementById(argument.markerId)) ?? true, { rootId: EDITOR_ROOT_ELEMENT_ID, markerId: COLUMN_RESIZE_MARKER_ID });
    const saved = await readSavedBody(page) ?? '';
    expect([insideRoot, saved.includes(COLUMN_RESIZE_MARKER_ID), saved.includes(COLUMN_RESIZE_CURSOR_ATTRIBUTE), saved])
      .toEqual([false, false, false, TABLE_BODY]);
  });

  test('gives the marker a color that differs from the background in light, dark and high-contrast themes', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await hoverBand(page, '#a');
    await expect(page.locator(MARKER)).toBeVisible();

    const matches: boolean[] = [];
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      const [marker] = await readComputed(page, MARKER, ['background-color']);
      const [background] = await readComputed(page, 'body', ['background-color']);
      matches.push(marker === background);
    }

    expect(matches).toEqual(THEMES.map(() => false));
  });
});

test.describe('the column resize drag with a macOS userAgent', () => {
  test.use({ userAgent: MAC_USER_AGENT });

  test('neither starts a drag nor makes the marker follow when the band is Ctrl+pressed with a macOS userAgent', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    const before = await readColumnWidths(page, TABLE);
    const point = await hoverBand(page, '#a');

    await page.keyboard.down('Control');
    await page.mouse.down();
    await page.mouse.move(point.x + 40, point.y, { steps: 3 });
    const hidden = await page.locator(MARKER).isHidden();
    await page.mouse.up();
    await page.keyboard.up('Control');

    expect([hidden, Math.abs((await readColumnWidths(page, TABLE))[0] - before[0]) <= 1]).toEqual([true, true]);
  });
});

test.describe('setting a column width', () => {
  test('adds a colgroup on its own line and lists cols with % widths for all columns without whitespace between them when setting a column width on a table without widths', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    const width = (await readRect(page, '#a')).width;

    await runTableCommand(page, { kind: 'setColumnWidth', width: width + 30 }, '#a');

    expect(await readBodyHtml(page))
      .toMatch(/^\n<table>\n<colgroup>(<col style="width: [\d.]+%;">){3}<\/colgroup>\n<tbody>\n/u);
  });

  test('leaves the text of every line other than the colgroup line unchanged in the saved content of a table with an added colgroup', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    const width = (await readRect(page, '#a')).width;

    await runTableCommand(page, { kind: 'setColumnWidth', width: width + 30 }, '#a');

    const lines = (await readSavedBody(page) ?? '').split('\n');
    expect(lines.filter((line) => !line.startsWith('<colgroup>'))).toEqual(TABLE_BODY.split('\n'));
  });

  test('rewrites all columns to their current rendered widths and puts the target column\'s boundary at the requested position (±1px) when writing to a table of four 25% columns with one deleted', async ({ page }) => {
    await openLayoutEditor(
      page,
      '\n<table>\n<colgroup><col style="width: 25%"><col style="width: 25%"><col style="width: 25%"><col style="width: 25%"></colgroup>\n'
      + '<tbody>\n<tr><td id="a">ab</td><td id="b">cd</td><td id="c">ef</td><td id="d">gh</td></tr>\n</tbody>\n</table>\n',
    );
    await runTableCommand(page, { kind: 'deleteColumn' }, '#d');
    const cell = await readRect(page, '#a');

    await runTableCommand(page, { kind: 'setColumnWidth', width: cell.width + 40 }, '#a');

    const values = await readColumnValues(page, TABLE);
    expect([
      values.length,
      values.every((value) => value.endsWith('%') && value !== '25%'),
      Math.abs((await readRect(page, '#a')).right - (cell.right + 40)) <= 1,
    ]).toEqual([3, true, true]);
  });

  test('changes only the target column\'s col value and sets the table\'s style width to auto when writing to a pixel table whose columns all render as written', async ({ page }) => {
    // Sets the table width to the sum of the columns, so all columns still render as written while the table width is
    // not auto.
    await openLayoutEditor(page, PIXEL_BODY.replace('width: auto', 'width: 250px'));

    await runTableCommand(page, { kind: 'setColumnWidth', width: 120 }, '#a');

    expect([await readColumnValues(page, TABLE), await readStyleWidth(page, TABLE)]).toEqual([['120px', '150px'], 'auto']);
  });

  test('sends neither a view edited message nor an edit transaction when writing the same width as the current value', async ({ page }) => {
    await openLayoutEditor(page, PIXEL_BODY);

    const changed = await runTableCommand(page, { kind: 'setColumnWidth', width: 100 }, '#a');
    await flushEditTransactions(page, 'layout-same');

    expect([
      changed,
      await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.viewEdited),
      await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction),
    ]).toEqual([false, 0, 0]);
  });

  test('leaves the rows, cells, cell contents and cell widths as they were before writing after setting a column width', async ({ page }) => {
    await openLayoutEditor(
      page,
      '\n<table>\n<tbody>\n<tr><td id="a" style="width: 200px">ab</td><td id="b" width="100">cd</td><td id="c">ef</td></tr>\n'
      + '<tr><td>gh</td><td>ij</td><td>kl</td></tr>\n</tbody>\n</table>\n',
    );
    const body = await page.locator(`${TABLE} > tbody`).evaluate((element) => element.outerHTML);
    const width = (await readRect(page, '#a')).width;

    await runTableCommand(page, { kind: 'setColumnWidth', width: width + 30 }, '#a');

    expect([
      (await readColumnValues(page, TABLE)).length,
      await page.locator(`${TABLE} > tbody`).evaluate((element) => element.outerHTML),
    ]).toEqual([3, body]);
  });

  test('writes the style width and keeps the width attribute when writing to the column of a col with a width attribute', async ({ page }) => {
    await openLayoutEditor(
      page,
      '\n<table>\n<colgroup><col width="30%"><col width="70%"></colgroup>\n'
      + '<tbody>\n<tr><td id="a">ab</td><td id="b">cd</td></tr>\n</tbody>\n</table>\n',
    );
    const width = (await readRect(page, '#a')).width;

    await runTableCommand(page, { kind: 'setColumnWidth', width: width + 20 }, '#a');

    const col = page.locator(`${TABLE} col >> nth=0`);
    expect([
      (await col.evaluate((element) => (element instanceof HTMLElement ? element.style.width : ''))).endsWith('%'),
      await col.getAttribute('width'),
    ]).toEqual([true, '30%']);
  });

  test('splits a span 2 col with a background color when writing to its column, leaving the background color of both split columns unchanged', async ({ page }) => {
    await openLayoutEditor(
      page,
      '\n<table>\n<colgroup><col span="2" style="background-color: rgb(255, 0, 0)"><col></colgroup>\n'
      + '<tbody>\n<tr><td id="a">ab</td><td id="b">cd</td><td id="c">ef</td></tr>\n</tbody>\n</table>\n',
    );
    const [before] = await readComputed(page, `${TABLE} col >> nth=0`, ['background-color']);
    const width = (await readRect(page, '#a')).width;

    await runTableCommand(page, { kind: 'setColumnWidth', width: width + 20 }, '#a');

    const colors = await page.locator(`${TABLE} col`).evaluateAll((cols) => cols.map((col) => getComputedStyle(col).backgroundColor));
    expect([before, colors.length, colors[0], colors[1]]).toEqual(['rgb(255, 0, 0)', 3, before, before]);
  });

  test('restores the colgroup and col shape from before writing when setting a column width is undone', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    const width = (await readRect(page, '#a')).width;
    await runTableCommand(page, { kind: 'setColumnWidth', width: width + 30 }, '#a');
    await flushEditTransactions(page, 'layout-set');
    const transactions = await readTransactions(page);

    await applyUndo(page, transactions[0]);

    await expect.poll(() => readBodyHtml(page)).toBe(TABLE_BODY);
  });

  test('keeps the caret at the same position as before the operation after setting a column width', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#e', 1);

    await dragBand(page, '#a', 40);

    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
    expect([(await readColumnValues(page, TABLE)).length, await readCaretOffsetIn(page, '#e')]).toEqual([3, 1]);
  });

  test('sets all columns to their current rendered widths without the table exceeding the available width when writing to a table whose col px widths add up to more than the available width and are rendered shrunk', async ({ page }) => {
    await openLayoutEditor(
      page,
      '\n<table style="width: auto">\n<colgroup><col style="width: 800px"><col style="width: 800px"></colgroup>\n'
      + '<tbody>\n<tr><td id="a">ab</td><td id="b">cd</td></tr>\n</tbody>\n</table>\n',
    );
    const available = await readAvailableWidth(page, TABLE);
    const before = await readColumnWidths(page, TABLE);

    await runTableCommand(page, { kind: 'setColumnWidth', width: 300 }, '#a');

    const values = await readColumnValues(page, TABLE);
    expect([
      values[0],
      Math.abs(Number.parseFloat(values[1]) - before[1]) <= 1,
      (await readRect(page, TABLE)).width <= available + 1,
    ]).toEqual(['300px', true, true]);
  });
});

test.describe('toggling the width unit', () => {
  test('makes all columns integer px, the table\'s style width auto, and keeps the table width (±1px) when a percent table is switched to px', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    const before = (await readRect(page, TABLE)).width;

    await runTableCommand(page, { kind: 'toggleWidthUnit' }, '#a');

    const values = await readColumnValues(page, TABLE);
    expect([
      values.every((value) => /^\d+px$/u.test(value)),
      await readStyleWidth(page, TABLE),
      Math.abs((await readRect(page, TABLE)).width - before) <= 1,
    ]).toEqual([true, 'auto', true]);
  });

  test('makes all columns %, removes the table\'s style, and renders the table at the full available width when a pixel table is switched to %', async ({ page }) => {
    await openLayoutEditor(page, PIXEL_BODY);
    const available = await readAvailableWidth(page, TABLE);

    await runTableCommand(page, { kind: 'toggleWidthUnit' }, '#a');

    const values = await readColumnValues(page, TABLE);
    expect([
      values.every((value) => value.endsWith('%')),
      await page.locator(TABLE).getAttribute('style'),
      Math.abs((await readRect(page, TABLE)).width - available) <= 1,
    ]).toEqual([true, null, true]);
  });

  test('sets auto when a table with width: 50% in its style is switched to px, and removes the width when it is then switched to %', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY.replace('<table>', '<table style="width: 50%">'));

    await runTableCommand(page, { kind: 'toggleWidthUnit' }, '#a');
    const toPixel = await readStyleWidth(page, TABLE);
    await runTableCommand(page, { kind: 'toggleWidthUnit' }, '#a');

    expect([toPixel, await page.locator(TABLE).getAttribute('style')]).toEqual(['auto', null]);
  });

  test('makes toggling the width unit one settled edit transaction, and undo restores the cols from before the switch', async ({ page }) => {
    await openLayoutEditor(page, PERCENT_BODY);

    await runTableCommand(page, { kind: 'toggleWidthUnit' }, '#a');
    await flushEditTransactions(page, 'layout-toggle');
    const transactions = await readTransactions(page);
    await applyUndo(page, transactions[0]);

    expect(transactions.length).toBe(1);
    await expect.poll(() => readBodyHtml(page)).toBe(PERCENT_BODY);
  });
});

test.describe('block operations from a bare run in a cell', () => {
  test('turns the cell content into a heading inside the cell with the caret at the same character position when Heading 2 is chosen in a bare text cell', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);

    await chooseBlockType(page, 'Heading 2');

    expect([await page.locator('#a').innerHTML(), await readCaretOffsetIn(page, '#a h2')]).toEqual(['\n<h2>ab</h2>', 1]);
  });

  test('creates a list inside the cell whose item holds the cell content when a bulleted list is chosen in a bare text cell', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);

    await pressToolbarItem(page, TOOLBAR_SLOT.bulletList);

    expect(await page.locator('#a').innerHTML()).toBe('\n<ul><li>ab</li></ul>');
  });

  test('turns the cell content into a code block inside the cell when a code block is chosen in a bare text cell', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);

    await pressToolbarItem(page, TOOLBAR_SLOT.codeBlock);

    expect(await page.locator('#a').innerHTML()).toBe('\n<pre><code>ab</code></pre>');
  });

  test('turns the cell content into an alert blockquote inside the cell when an alert (note) is chosen in a bare text cell', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);

    await chooseBlockType(page, 'Note');

    expect(await page.locator('#a').innerHTML()).toBe('\n<blockquote data-alert="note">ab</blockquote>');
  });

  test('inserts a horizontal rule inside the cell after the wrapping paragraph when a horizontal rule is chosen in a bare text cell', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);

    await pressToolbarItem(page, TOOLBAR_SLOT.horizontalRule);

    expect(await page.locator('#a').innerHTML()).toBe('\n<p>ab</p>\n<hr>\n<p><br></p>');
  });

  test('inserts a details section inside the cell after the wrapping paragraph when insert details is chosen in a bare text cell', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);

    await pressToolbarItem(page, TOOLBAR_SLOT.details);

    expect(await readChildNames(page, '#a')).toEqual(['p', 'details', 'p']);
  });

  test('inserts a nested table inside the cell after the wrapping paragraph when a table is inserted from the table picker in a bare text cell', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 2);
    await pressToolbarItem(page, TOOLBAR_SLOT.table);

    await page.locator(`${TOOLBAR} [role="grid"] [role="gridcell"] >> nth=0`).click();

    expect(await readChildNames(page, '#a')).toEqual(['p', 'table', 'p']);
  });

  test('turns both runs and the paragraph into headings when a heading is chosen with a range over two bare runs before and after a paragraph in the same cell', async ({ page }) => {
    await openLayoutEditor(page, `${LEADING_PARAGRAPHS}${oneRowBody('ab<p>cd</p>ef', 'gh')}`);
    await selectRange(page, { selector: '#a', childIndex: 0, offset: 1 }, { selector: '#a', childIndex: 2, offset: 1 });

    await chooseBlockType(page, 'Heading 2');

    expect(await page.locator('#a').innerHTML()).toBe('\n<h2>ab</h2><h2>cd</h2>\n<h2>ef</h2>');
  });

  test('does not wrap the neighboring cell\'s content in a paragraph when a heading is chosen with a range spanning from a bare cell into the neighboring bare cell', async ({ page }) => {
    await openLayoutEditor(page, `${LEADING_PARAGRAPHS}${oneRowBody('ab', 'cd')}`);
    await selectRange(page, { selector: '#a', childIndex: 0, offset: 1 }, { selector: '#b', childIndex: 0, offset: 1 });

    await chooseBlockType(page, 'Heading 2');

    expect([await page.locator('#a').innerHTML(), await page.locator('#b').innerHTML()]).toEqual(['\n<h2>ab</h2>', 'cd']);
  });

  test('creates one empty heading inside the cell before the list when a heading is chosen right after moving by Tab into a cell that starts with a list', async ({ page }) => {
    await openLayoutEditor(page, oneRowBody('ab', '<ul><li>x</li></ul>'));
    await placeCaretInText(page, '#a', 1);
    await page.keyboard.press('Tab');

    await chooseBlockType(page, 'Heading 2');

    expect(await page.locator('#b').innerHTML()).toBe('\n<h2><br></h2><ul><li>x</li></ul>');
  });

  test('changes the paragraph as before when a heading or a bulleted list is chosen in a cell with a paragraph', async ({ page }) => {
    await openLayoutEditor(page, oneRowBody('<p>ab</p>', '<p>cd</p>'));
    await placeCaretInText(page, '#a p', 1);
    await chooseBlockType(page, 'Heading 2');
    await placeCaretInText(page, '#b p', 1);

    await pressToolbarItem(page, TOOLBAR_SLOT.bulletList);

    expect([await page.locator('#a').innerHTML(), await page.locator('#b').innerHTML()])
      .toEqual(['<h2>ab</h2>', '<ul><li>cd</li></ul>']);
  });

  test('does not wrap the cell content in a paragraph when typing or deleting characters in a bare cell', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 2);

    await page.keyboard.type('X');
    const typed = await page.locator('#a').innerHTML();
    await page.keyboard.press('Backspace');

    expect([typed, await page.locator('#a').innerHTML()]).toEqual(['abX', 'ab']);
  });

  test('does not wrap the cell content in a paragraph when bold is applied to text in a bare cell', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await selectRange(page, { selector: '#a', childIndex: 0, offset: 0 }, { selector: '#a', childIndex: 0, offset: 2 });

    await page.keyboard.press('ControlOrMeta+KeyB');

    expect(await page.locator('#a').innerHTML()).toBe('<strong>ab</strong>');
  });

  test('does not make a heading when "# " is typed at the start of a bare cell, leaving the typed characters as they are', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 0);

    await page.keyboard.type('# ');

    expect(await page.locator('#a').innerHTML()).toMatch(/^#( |&nbsp;)ab$/u);
  });

  test('turns the cell content into a heading when a heading is chosen even in a bare cell of a table inside the body of a details section', async ({ page }) => {
    await openLayoutEditor(page, inDetails(TABLE_BODY));
    await placeCaretInText(page, '#a', 1);

    await chooseBlockType(page, 'Heading 2');

    expect(await page.locator('#a').innerHTML()).toBe('\n<h2>ab</h2>');
  });
});

test.describe('pasting into a bare cell', () => {
  // Allows reading and writing the clipboard, so that pasting is done with real keystrokes.
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('does not wrap the cell content in a paragraph when text is pasted into a bare cell', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 2);

    await paste(page, { 'text/plain': 'Z' });

    expect(await page.locator('#a').innerHTML()).toBe('abZ');
  });
});

test.describe('Enter directly inside a cell', () => {
  test('splits into two paragraphs on Enter in the middle of a bare cell\'s text, with the caret at the start of the latter paragraph', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);

    await page.keyboard.press('Enter');

    expect([await page.locator('#a').innerHTML(), await readCaretOffsetIn(page, '#a p:last-child')])
      .toEqual(['\n<p>a</p>\n<p>b</p>', 0]);
  });

  test('creates an empty paragraph after the content paragraph on Enter at the end of a bare cell, with the caret in it', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 2);

    await page.keyboard.press('Enter');

    expect([await page.locator('#a').innerHTML(), await readCaretOffsetIn(page, '#a p:last-child')])
      .toEqual(['\n<p>ab</p>\n<p><br></p>', 0]);
  });

  test('creates an empty paragraph before the content paragraph on Enter at the start of a bare cell, leaving the caret at the start of the content paragraph', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 0);

    await page.keyboard.press('Enter');

    expect([await page.locator('#a').innerHTML(), await readCaretOffsetIn(page, '#a p:last-child')])
      .toEqual(['\n\n<p><br></p>\n<p>ab</p>', 0]);
  });

  test('makes two empty paragraphs on Enter in an empty cell, with the caret in the latter paragraph', async ({ page }) => {
    await openLayoutEditor(page, oneRowBody('<br>', 'cd'));
    await placeCaretAtElement(page, '#a', 0);

    await page.keyboard.press('Enter');

    expect([await page.locator('#a').innerHTML(), await readCaretOffsetIn(page, '#a p:last-child')])
      .toEqual(['\n<p><br></p>\n<p><br></p>', 0]);
  });

  test('deletes the range and then splits into two paragraphs at that position on Enter with a range selection inside a bare run', async ({ page }) => {
    await openLayoutEditor(page, oneRowBody('abcd', 'ef'));
    await selectRange(page, { selector: '#a', childIndex: 0, offset: 1 }, { selector: '#a', childIndex: 0, offset: 3 });

    await page.keyboard.press('Enter');

    expect(await page.locator('#a').innerHTML()).toBe('\n<p>a</p>\n<p>d</p>');
  });

  test('deletes the range, joins back into one and then splits into two on Enter with a range from a bare run to the middle of a paragraph in the same cell', async ({ page }) => {
    await openLayoutEditor(page, oneRowBody('ab<p>cd</p>', 'ef'));
    await selectRange(page, { selector: '#a', childIndex: 0, offset: 1 }, { selector: '#a p', childIndex: 0, offset: 1 });

    await page.keyboard.press('Enter');

    expect(await page.locator('#a').innerHTML()).toBe('\n<p>a</p>\n<p>d</p>');
  });

  test('adds exactly one empty paragraph before the list on Enter right after moving by Tab into a cell that starts with a list, with the caret in that paragraph', async ({ page }) => {
    await openLayoutEditor(page, oneRowBody('ab', '<ul><li>x</li></ul>'));
    await placeCaretInText(page, '#a', 1);
    await page.keyboard.press('Tab');

    await page.keyboard.press('Enter');

    expect([await page.locator('#b').innerHTML(), await readCaretOffsetIn(page, '#b p')])
      .toEqual(['\n<p><br></p><ul><li>x</li></ul>', 0]);
  });

  test('inserts a br on Shift+Enter in a bare cell without wrapping the cell content in a paragraph', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);

    await page.keyboard.press('Shift+Enter');

    expect(await page.locator('#a').innerHTML()).toBe('a<br>b');
  });

  test('splits only that paragraph, as before, on Enter inside a paragraph of a cell with paragraphs', async ({ page }) => {
    await openLayoutEditor(page, oneRowBody('<p>abc</p>', 'de'));
    await placeCaretInText(page, '#a p', 1);

    await page.keyboard.press('Enter');

    expect(await page.locator('#a').innerHTML()).toBe('<p>a</p>\n<p>bc</p>');
  });

  test('makes Enter in a bare cell one settled edit transaction, and undo restores the bare cell', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 1);

    await page.keyboard.press('Enter');
    await flushEditTransactions(page, 'layout-enter');
    const transactions = await readTransactions(page);
    await applyUndo(page, transactions[0]);

    expect(transactions.length).toBe(1);
    await expect.poll(() => readBodyHtml(page)).toBe(TABLE_BODY);
  });

  test('places the wrapping paragraph and the new paragraph each after one line break in the saved content after Enter in a bare cell', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    await placeCaretInText(page, '#a', 2);

    await page.keyboard.press('Enter');

    expect(await readSavedBody(page)).toContain('<td id="a">\n<p>ab</p>\n<p><br></p></td>');
  });

  test('splits into two paragraphs on Enter even in a bare cell of a table inside the body of a details section', async ({ page }) => {
    await openLayoutEditor(page, inDetails(TABLE_BODY));
    await placeCaretInText(page, '#a', 1);

    await page.keyboard.press('Enter');

    expect(await page.locator('#a').innerHTML()).toBe('\n<p>a</p>\n<p>b</p>');
  });
});

test.describe('table display rules', () => {
  test('keeps the vertical position of the cell\'s first character (±1px) when a bare cell is wrapped in a paragraph by Enter', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY);
    // After wrapping, the cell's first text is the line break before the paragraph, which is not rendered. The text
    // holding the first character a is measured instead.
    const readFirstCharacterTop = (): Promise<number> => page.locator('#a').evaluate((cell) => {
      const text = document.evaluate('.//text()[contains(., "a")]', cell, null, XPathResult.FIRST_ORDERED_NODE_TYPE).singleNodeValue;
      const range = document.createRange();
      if (text !== null) {
        range.setStart(text, 0);
        range.setEnd(text, 1);
      }
      return range.getBoundingClientRect().top;
    });
    const before = await readFirstCharacterTop();
    await placeCaretInText(page, '#a', 2);

    await page.keyboard.press('Enter');

    expect(Math.abs(await readFirstCharacterTop() - before) <= 1).toBe(true);
  });

  test('makes the row height of a cell with a single paragraph the same as that of a bare cell with the same text (±1px)', async ({ page }) => {
    await openLayoutEditor(
      page,
      '\n<table id="bare"><tbody><tr><td>ab</td></tr></tbody></table>\n'
      + '<table id="wrapped"><tbody><tr><td><p>ab</p></td></tr></tbody></table>\n',
    );

    const heights = [(await readRect(page, '#bare tr')).height, (await readRect(page, '#wrapped tr')).height];

    expect(Math.abs(heights[0] - heights[1]) <= 1).toBe(true);
  });

  test('does not widen a table without widths beyond the available width for a long URL in a cell, and the view does not scroll horizontally', async ({ page }) => {
    await openLayoutEditor(page, oneRowBody(`https://example.com/${'a'.repeat(300)}`, 'cd'));

    const available = await readAvailableWidth(page, TABLE);

    expect([
      (await readRect(page, TABLE)).width <= available + 1,
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    ]).toEqual([true, true]);
  });

  test('does not widen the table beyond the available width even for long inline code in a cell', async ({ page }) => {
    await openLayoutEditor(page, oneRowBody(`<code>${'x'.repeat(300)}</code>`, 'cd'));

    const available = await readAvailableWidth(page, TABLE);

    expect((await readRect(page, TABLE)).width <= available + 1).toBe(true);
  });

  test('keeps a cell\'s word on one line without breaking in a table without widths that fits the available width when rendered without breaking', async ({ page }) => {
    await openLayoutEditor(page, oneRowBody('Internationalization', 'b', 'c', 'd'));

    expect(await countTextLines(page, '#a')).toBe(1);
  });

  test('breaks a word that does not fit the specified width at that width in a column whose width is set by a col, even when the table fits the available width', async ({ page }) => {
    await openLayoutEditor(
      page,
      '\n<table style="width: auto">\n<colgroup><col style="width: 60px"><col style="width: 200px"></colgroup>\n'
      + '<tbody>\n<tr><td id="a">Internationalization</td><td id="b">cd</td></tr>\n</tbody>\n</table>\n',
    );

    expect(await countTextLines(page, '#a')).toBeGreaterThan(1);
  });

  test('does not widen the table beyond the available width for a long line in a code block in a cell, and the inside of the code block can scroll horizontally', async ({ page }) => {
    await openLayoutEditor(page, oneRowBody(`<pre><code>${'x'.repeat(400)}</code></pre>`, 'cd'));

    const available = await readAvailableWidth(page, TABLE);

    expect([
      (await readRect(page, TABLE)).width <= available + 1,
      await page.locator('#a pre').evaluate((pre) => pre.scrollWidth > pre.clientWidth),
    ]).toEqual([true, true]);
  });

  test('shows the whole line without horizontal scrolling for a code block whose lines fit the available width', async ({ page }) => {
    await openLayoutEditor(page, oneRowBody('<pre><code>short line</code></pre>', 'cd'));

    expect(await page.locator('#a pre').evaluate((pre) => pre.scrollWidth <= pre.clientWidth)).toBe(true);
  });

  test('shows characters typed into an empty code block in a cell inside the code block\'s code', async ({ page }) => {
    await openLayoutEditor(page, oneRowBody('<br>', 'cd'));
    await placeCaretAtElement(page, '#a', 0);
    await pressToolbarItem(page, TOOLBAR_SLOT.codeBlock);

    await page.keyboard.type('X');

    const code = await readRect(page, '#a pre code');
    const pre = await readRect(page, '#a pre');
    expect([
      await page.locator('#a pre code').textContent(),
      code.width > 0 && code.left >= pre.left && code.right <= pre.right,
    ]).toEqual(['X', true]);
  });

  test('does not widen the outer table beyond the available width even for a long word in a nested table\'s cell', async ({ page }) => {
    await openLayoutEditor(
      page,
      oneRowBody(`<table><tbody><tr><td>${'y'.repeat(300)}</td><td>z</td></tr></tbody></table>`, 'cd'),
    );

    const available = await readAvailableWidth(page, TABLE);

    expect((await readRect(page, TABLE)).width <= available + 1).toBe(true);
  });

  test('renders a table whose style width is wider than the available width as specified, and the view scrolls horizontally', async ({ page }) => {
    await openLayoutEditor(page, TABLE_BODY.replace('<table>', '<table style="width: 2000px">'));

    expect([
      Math.abs((await readRect(page, TABLE)).width - 2000) <= 1,
      await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    ]).toEqual([true, true]);
  });

  test('renders a table, where only the sum of the col px widths is wider than the available width, shrunk to the available width', async ({ page }) => {
    await openLayoutEditor(
      page,
      '\n<table>\n<colgroup><col style="width: 800px"><col style="width: 800px"></colgroup>\n'
      + '<tbody>\n<tr><td id="a">ab</td><td id="b">cd</td></tr>\n</tbody>\n</table>\n',
    );

    const available = await readAvailableWidth(page, TABLE);

    expect((await readRect(page, TABLE)).width <= available + 1).toBe(true);
  });

  test('renders the margin-top of a cell\'s first paragraph with the value set in its style attribute', async ({ page }) => {
    await openLayoutEditor(page, oneRowBody('<p style="margin-top: 12px">ab</p>', 'cd'));

    expect(await readComputed(page, '#a p', ['margin-top'])).toEqual(['12px']);
  });
});
