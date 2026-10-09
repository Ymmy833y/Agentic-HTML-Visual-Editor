import { devices, expect, test } from '@playwright/test';
import type { CDPSession, Locator, Page } from '@playwright/test';

import {
  DOCUMENT_APPLY_KIND,
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  MESSAGE_CATALOG_ELEMENT_ID,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import type { EditTransaction } from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import type { TableOperation } from '../../webview/editing/table-command';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import { TABLE_PICKER_CLASS } from '../../webview/ui/table-picker';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { EDITOR_ROOT, focusEditor, placeCaret, readBodyHtml } from './helpers/editing';
import {
  IDLE_ICON_COLOR,
  PROBE_BUNDLE_PATH,
  getOutboundMessages,
  nameIconStroke,
  openWebviewHost,
  sendToWebview,
} from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;
// The popup contents go into the same container as the item, so point only at the direct child button.
const TABLE_ITEM = `${TOOLBAR} [data-slot="${TOOLBAR_SLOT.table}"] > button`;
const PICKER = `${TOOLBAR} .${TABLE_PICKER_CLASS}`;
const GRID = `${PICKER} [role="grid"]`;

/** A body with a single paragraph. */
const BODY = '\n<p>abcd</p>\n';

/** A body with only a 2-by-2 table whose cells each hold different text. */
const TABLE_BODY = '\n<table>\n<tbody>\n<tr><td>ab</td><td>cd</td></tr>\n<tr><td>ef</td><td>gh</td></tr>\n</tbody>\n</table>\n';

/** The 1-by-1 table insertion produces. A single-row table gets no header row. */
const INSERTED_TABLE_1X1 = '<table>\n<tbody>\n<tr><td><br></td></tr>\n</tbody>\n</table>';

/** The 2-by-2 table insertion produces. The first row becomes a header row. */
const INSERTED_TABLE_2X2 = '<table>\n<tbody>\n'
  + '<tr><th scope="col"><br></th><th scope="col"><br></th></tr>\n'
  + '<tr><td><br></td><td><br></td></tr>\n'
  + '</tbody>\n</table>';

/** The 2-by-3 table insertion produces. The first row becomes a header row. */
const INSERTED_TABLE_2X3 = '<table>\n<tbody>\n'
  + '<tr><th scope="col"><br></th><th scope="col"><br></th><th scope="col"><br></th></tr>\n'
  + '<tr><td><br></td><td><br></td><td><br></td></tr>\n'
  + '</tbody>\n</table>';

/** The 3-by-3 table insertion produces. The first row becomes a header row. */
const INSERTED_TABLE_3X3 = '<table>\n<tbody>\n'
  + '<tr><th scope="col"><br></th><th scope="col"><br></th><th scope="col"><br></th></tr>\n'
  + '<tr><td><br></td><td><br></td><td><br></td></tr>\n'
  + '<tr><td><br></td><td><br></td><td><br></td></tr>\n'
  + '</tbody>\n</table>';

/**
 * The colors given by the light, dark and high-contrast themes, and whether VS Code puts the high contrast class on the
 * body.
 */
const THEME_COLORS = [
  { background: 'rgb(255, 255, 255)', foreground: 'rgb(31, 35, 40)', border: 'rgb(229, 229, 229)', highContrast: false },
  { background: 'rgb(31, 31, 31)', foreground: 'rgb(204, 204, 204)', border: 'rgb(43, 43, 43)', highContrast: false },
  { background: 'rgb(0, 0, 0)', foreground: 'rgb(255, 255, 255)', border: 'rgb(111, 195, 223)', highContrast: true },
];

// The view decides the primary modifier from the userAgent, but the Desktop Chrome descriptor returns a Windows
// userAgent regardless of the OS. Registered keys are pressed with real keystrokes, so match the userAgent to the
// running OS.
const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
test.use({ userAgent: process.platform === 'darwin' ? MAC_USER_AGENT : devices['Desktop Chrome'].userAgent });

declare global {
  interface Window {
    /** The forwarded key record: the codes of keydown events that reached the window's bubbling phase, in arrival order. */
    __forwardedKeys?: string[];
  }
}

/** A position in text: which child of which element, and which character within it. */
interface TextPoint {
  readonly selector: string;
  readonly childIndex: number;
  readonly offset: number;
}

/**
 * Embeds the English message catalog, then mounts the body.
 *
 * With messages left as keys, the grid cell names and the size display would not contain the numbers of rows and
 * columns, so whether they convey the size could not be checked.
 *
 * @param page The page to operate on.
 * @param body The body to mount.
 */
async function openTableEditor(page: Page, body: string): Promise<void> {
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
 * Returns the selector of the cell at a row and column of a table without nesting.
 *
 * @param row The row counted from the top.
 * @param column The cell counted from the left within the row.
 * @returns The selector.
 */
function cellAt(row: number, column: number): string {
  return `${EDITOR_ROOT} tr:nth-child(${row}) > :nth-child(${column})`;
}

/**
 * Moves focus to the editor root and places the caret in the text of the element's first child.
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
 * Selects between two positions. Focus is placed in the editor root.
 *
 * @param page The page to operate on.
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
 * Reads the caret position as a pair of the node's text and the offset.
 *
 * @param page The page to operate on.
 * @returns The text of the node with the caret and the offset within it.
 */
async function readCaret(page: Page): Promise<[string | null, number]> {
  return page.evaluate((): [string | null, number] => {
    const selection = window.getSelection();
    return [selection?.anchorNode?.textContent ?? null, selection?.anchorOffset ?? -1];
  });
}

/**
 * Returns whether the selection is collapsed.
 *
 * @param page The page to operate on.
 * @returns `true` if collapsed.
 */
async function isCollapsed(page: Page): Promise<boolean | undefined> {
  return page.evaluate(() => window.getSelection()?.isCollapsed);
}

/**
 * Returns whether the caret is inside an element.
 *
 * @param page The page to operate on.
 * @param selector The selector of the element.
 * @returns `true` if inside.
 */
async function isCaretInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((target) => {
    const anchor = window.getSelection()?.anchorNode ?? null;
    const element = document.querySelector(target);
    return anchor !== null && element !== null && element.contains(anchor);
  }, selector);
}

/**
 * Reads the slot of the focused item.
 *
 * @param page The page to operate on.
 * @returns The slot, or `null` outside an item.
 */
async function readFocusedSlot(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.closest('[data-slot]')?.getAttribute('data-slot') ?? null);
}

/**
 * Reads the name of the focused element.
 *
 * @param page The page to operate on.
 * @returns The `aria-label`, or the text if there is none.
 */
async function readFocusedName(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? null);
}

/**
 * Presses the table button with the pointer and waits for the picker to open.
 *
 * @param page The page to operate on.
 */
async function openPicker(page: Page): Promise<void> {
  await page.locator(TABLE_ITEM).click();
  await expect(page.locator(PICKER)).toBeVisible();
}

/**
 * Moves to the toolbar with Alt+F10 and advances to the table button with →.
 *
 * Does not hard-code the number of items; otherwise the number of presses would need fixing every time a later
 * feature unit adds an item.
 *
 * @param page The page to operate on.
 */
async function reachTableItem(page: Page): Promise<void> {
  await page.keyboard.press('Alt+F10');
  for (let press = 0; press < Object.keys(TOOLBAR_SLOT).length; press += 1) {
    if (await readFocusedSlot(page) === TOOLBAR_SLOT.table) {
      return;
    }
    await page.keyboard.press('ArrowRight');
  }
  throw new Error('the arrow keys did not reach the table button');
}

/**
 * Opens the table button by keyboard and waits for focus to move to the grid.
 *
 * @param page The page to operate on.
 */
async function openPickerByKeyboard(page: Page): Promise<void> {
  await reachTableItem(page);
  await page.keyboard.press('Enter');
  await expect(page.locator(GRID)).toBeFocused();
}

/**
 * Narrows the view until the table button sits at the right end of the first row of the strip.
 *
 * Adds a little more than the strip's inner padding to the button's right edge, so the items after it wrap to the
 * next row and the table button stays at the right end.
 *
 * @param page The page to operate on.
 */
async function narrowToTableItem(page: Page): Promise<void> {
  const right = await page.locator(TABLE_ITEM).evaluate((element) => element.getBoundingClientRect().right);
  await page.setViewportSize({ width: Math.ceil(right) + 16, height: 720 });
}

/**
 * Returns a grid cell of the grid.
 *
 * @param page The page to operate on.
 * @param rows The number of rows counted from the top left.
 * @param columns The number of columns counted from the top left.
 * @returns The grid cell.
 */
function pickerCell(page: Page, rows: number, columns: number): Locator {
  return page.locator(`${GRID} [role="row"]:nth-child(${rows}) [role="gridcell"]:nth-child(${columns})`);
}

/**
 * Returns the input field for the number of rows.
 *
 * @param page The page to operate on.
 * @returns The input field.
 */
function rowsInput(page: Page): Locator {
  return page.locator(PICKER).getByRole('textbox', { name: 'Rows', exact: true });
}

/**
 * Returns the input field for the number of columns.
 *
 * @param page The page to operate on.
 * @returns The input field.
 */
function columnsInput(page: Page): Locator {
  return page.locator(PICKER).getByRole('textbox', { name: 'Columns', exact: true });
}

/**
 * Returns the insert button.
 *
 * @param page The page to operate on.
 * @returns The button.
 */
function insertButton(page: Page): Locator {
  return page.locator(PICKER).getByRole('button', { name: 'Insert', exact: true });
}

/**
 * Reads the names of the chosen grid cells in document order.
 *
 * @param page The page to operate on.
 * @returns The grid cell names.
 */
async function readSelectedLabels(page: Page): Promise<(string | null)[]> {
  return page.locator(`${GRID} [role="gridcell"][aria-selected="true"]`)
    .evaluateAll((cells) => cells.map((cell) => cell.getAttribute('aria-label')));
}

/**
 * Reads the size display.
 *
 * @param page The page to operate on.
 * @returns The displayed message.
 */
async function readSizeText(page: Page): Promise<string | null> {
  return page.locator(`${GRID} + div`).textContent();
}

/**
 * Reads the body that saving writes out.
 *
 * @param page The page to operate on.
 * @returns The body, or `undefined` before mounting.
 */
async function readSavedBody(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__serializationProbe?.()?.body);
}

/**
 * Table operations holding no elements. Cell merge holds the element of the other cell, and elements cannot be passed
 * as evaluate arguments, so it is excluded.
 */
type SerializableTableOperation = Exclude<TableOperation, { readonly kind: 'mergeCells' }>;

/**
 * Calls a table operation through the same entry point as the product.
 *
 * @param page The page to operate on.
 * @param operation The table operation.
 * @param selector The selector of the reference cell.
 * @returns `true` when the tree changed.
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
 * Calls the document replacement entry point to swap the body.
 *
 * @param page The page to operate on.
 * @param body The new body.
 */
async function replaceBody(page: Page, body: string): Promise<void> {
  await page.evaluate((text) => window.__documentReplacementProbe?.(text), `${PROLOGUE}${body}${EPILOGUE}`);
}

/**
 * Reads the sent edit units in the order they were sent.
 *
 * @param page The page to operate on.
 * @returns The edit units.
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
      // The value is already narrowed by type and shape, and messages of this type carry only edit units.
      return [message.transaction as EditTransaction];
    }
    return [];
  });
}

/**
 * Returns how many of the sent messages have the given type.
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
 * Asks for pending edit units to be sent and waits until the response arrives.
 *
 * Pending edit units are sent before the response, so counting after this does not miss edit units that arrive
 * late.
 *
 * @param page The page to operate on.
 * @param requestId The request id.
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
 * Applies the before state of a received edit unit as an undo.
 *
 * @param page The page to operate on.
 * @param transaction The received edit unit.
 */
async function applyUndo(page: Page, transaction: EditTransaction): Promise<void> {
  await sendToWebview(page, {
    type: HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument,
    requestId: 'table-undo',
    kind: DOCUMENT_APPLY_KIND.editHistory,
    text: transaction.before.text,
    targetText: transaction.after.text,
    targetSelection: transaction.before.selection,
    editRange: { start: 0, count: 0 },
  });
}

/**
 * Imitates VS Code forwarding and starts recording the codes of keydown events that reach the window's bubbling
 * phase.
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
 * @returns The codes of the keydown events that arrived.
 */
async function readForwardedKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__forwardedKeys ?? []);
}

/**
 * Applies theme colors. VS Code puts them on the root element and, in a high contrast theme, a class on the body, so
 * they are reproduced in the same places.
 *
 * @param page The page to operate on.
 * @param colors The theme colors to apply.
 */
async function applyTheme(
  page: Page,
  colors: { background: string; foreground: string; border: string; highContrast: boolean },
): Promise<void> {
  await page.evaluate((given) => {
    document.documentElement.style.setProperty('--vscode-editor-background', given.background);
    document.documentElement.style.setProperty('--vscode-editor-foreground', given.foreground);
    document.documentElement.style.setProperty('--vscode-panel-border', given.border);
    document.body.classList.toggle('vscode-high-contrast', given.highContrast);
  }, colors);
}

/**
 * Applies theme variables as they are, on the root element where VS Code puts them.
 *
 * @param page The page to operate on.
 * @param variables The variable names and values.
 */
async function applyThemeVariables(page: Page, variables: Record<string, string>): Promise<void> {
  await page.evaluate((given) => {
    for (const [name, value] of Object.entries(given)) {
      document.documentElement.style.setProperty(name, value);
    }
  }, variables);
}

/**
 * Reads the computed values of the focus ring.
 *
 * @param locator The target element.
 * @returns The line style and width.
 */
async function readOutline(locator: Locator): Promise<{ style: string; width: string }> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
}

/** Opens the channel that drives the browser IME. */
async function openImeSession(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/**
 * Normalizes the boxes of table cells to have no border, padding or spacing.
 *
 * With the default appearance, collapsed borders make the boxes of adjacent cells touch and overlap, so gaps and
 * overlaps could not be counted by area.
 *
 * @param page The page to operate on.
 */
async function applyMeasurableTableStyle(page: Page): Promise<void> {
  await page.addStyleTag({
    content: [
      `${EDITOR_ROOT} table { table-layout: fixed !important; border-collapse: separate !important;`
      + ' border-spacing: 0 !important; border: 0 !important; padding: 0 !important; width: 480px !important; }',
      `${EDITOR_ROOT} td, ${EDITOR_ROOT} th { border: 0 !important; padding: 0 !important; }`,
    ].join('\n'),
  });
}

/**
 * Counts, in the rendered table, the number of cell pairs whose boxes overlap and the area no cell covers.
 *
 * @param page The page to operate on.
 * @returns The number of overlapping pairs and the uncovered area (square pixels, rounded).
 */
async function readLayoutDefects(page: Page): Promise<{ overlaps: number; uncoveredArea: number }> {
  return page.locator(`${EDITOR_ROOT} > table`).evaluate((table) => {
    const boxes = [...table.querySelectorAll('td, th')].map((cell) => cell.getBoundingClientRect());
    let overlaps = 0;
    boxes.forEach((box, index) => {
      for (const other of boxes.slice(index + 1)) {
        const width = Math.min(box.right, other.right) - Math.max(box.left, other.left);
        const height = Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top);
        // An intrusion of less than 1 pixel from rounding fractional coordinates is not counted as an overlap.
        if (width > 0.5 && height > 0.5) {
          overlaps += 1;
        }
      }
    });
    const covered = boxes.reduce((sum, box) => sum + box.width * box.height, 0);
    const whole = table.getBoundingClientRect();
    return { overlaps, uncoveredArea: Math.round(whole.width * whole.height - covered) };
  });
}

test.describe('registering the table button', () => {
  test('after mounting, the table button follows the details item and can be found closed, with a name and a dialog popup', async ({ page }) => {
    await openTableEditor(page, BODY);

    const slots = await page.locator(`${TOOLBAR} [data-slot]`)
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-slot')));

    expect(slots.slice(slots.indexOf(TOOLBAR_SLOT.details), slots.indexOf(TOOLBAR_SLOT.details) + 2))
      .toEqual([TOOLBAR_SLOT.details, TOOLBAR_SLOT.table]);
    const item = page.getByRole('button', { name: 'Table', exact: true, expanded: false });
    await expect(item).toHaveCount(1);
    await expect(item).toHaveAttribute('aria-haspopup', 'dialog');
  });

  test('in light, dark and high-contrast themes alike, the icon is drawn in the idle icon color, a softened foreground, and does not match the background', async ({ page }) => {
    await openTableEditor(page, BODY);

    const drawn: { stroke: string; background: string }[] = [];
    for (const colors of THEME_COLORS) {
      await applyTheme(page, colors);
      drawn.push({
        stroke: await nameIconStroke(
          page,
          await page.locator(`${TABLE_ITEM} svg`).evaluate((element) => getComputedStyle(element).stroke),
        ),
        // The page background rather than the strip's, which is translucent glass.
        background: await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor),
      });
    }

    // Foreground and background colors differ in every theme, so drawing in the foreground color means not matching
    // the background.
    expect(drawn).toEqual(THEME_COLORS.map((colors) => ({
      stroke: IDLE_ICON_COLOR,
      background: colors.background,
    })));
  });

  test('for an unopenable document, no table button appears and no exception occurs', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await openTableEditor(page, '\n<script>a</script>\n');

    expect([await page.locator(TOOLBAR).count(), pageErrors]).toEqual([0, []]);
  });
});

test.describe('table picker', () => {
  test('pressing the table button in a paragraph opens the picker with nothing chosen, keeping focus and selection in the editor root', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);

    await page.locator(TABLE_ITEM).click();

    await expect(page.locator(PICKER)).toBeVisible();
    expect([
      await readSelectedLabels(page),
      await page.evaluate(() => document.activeElement?.id),
      await readCaret(page),
    ]).toEqual([[], EDITOR_ROOT_ELEMENT_ID, ['abcd', 2]]);
  });

  test('moving the pointer over a grid cell chooses from the top left to that grid cell and updates the size display', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPicker(page);

    await pickerCell(page, 2, 3).hover();

    expect([await readSelectedLabels(page), await readSizeText(page)]).toEqual([
      ['1 × 1', '1 × 2', '1 × 3', '2 × 1', '2 × 2', '2 × 3'],
      '2 × 3',
    ]);
  });

  test('pressing a grid cell inserts a table of that size right after the paragraph and closes the picker', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPicker(page);

    await pickerCell(page, 2, 3).click();

    expect([await readBodyHtml(page), await page.locator(PICKER).count()])
      .toEqual([`\n<p>abcd</p>\n${INSERTED_TABLE_2X3}\n<p><br></p>\n`, 0]);
  });

  test('opening the table button reached with Alt+F10 and arrow keys by Enter moves focus to the grid with 1 × 1 chosen', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await reachTableItem(page);

    await page.keyboard.press('Enter');

    await expect(page.locator(GRID)).toBeFocused();
    expect([await readSelectedLabels(page), await readSizeText(page)]).toEqual([['1 × 1'], '1 × 1']);
  });

  test('keeps the picker\'s right edge inside the visible width and its top below the button when opened with the pointer at a width that puts the table button near the right edge', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await narrowToTableItem(page);

    await openPicker(page);

    const placement = await page.evaluate((selectors) => {
      const pickerElement = document.querySelector(selectors.picker);
      const picker = pickerElement?.getBoundingClientRect();
      const item = document.querySelector(selectors.item)?.getBoundingClientRect();
      // The picker hangs a little below the button, so the expected top is the button's bottom plus that gap.
      const gap = pickerElement === null ? 0 : Number.parseFloat(getComputedStyle(pickerElement).marginTop);
      return {
        inside: picker !== undefined && picker.right <= document.documentElement.clientWidth,
        below: picker !== undefined && item !== undefined && Math.abs(picker.top - item.bottom - gap) <= 1,
      };
    }, { picker: PICKER, item: TABLE_ITEM });
    expect(placement).toEqual({ inside: true, below: true });
  });

  test('keeps the picker inside the visible width without scrolling the view sideways when opened by keyboard at the same width', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await narrowToTableItem(page);

    await openPickerByKeyboard(page);

    const placement = await page.evaluate((selector) => ({
      inside: (document.querySelector(selector)?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY)
        <= document.documentElement.clientWidth,
      scrollX: window.scrollX,
    }), PICKER);
    expect(placement).toEqual({ inside: true, scrollX: 0 });
  });

  test('pressing → and ↓ then Enter on the grid inserts a 2-by-2 table without a line break in the first cell', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPickerByKeyboard(page);

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    expect([await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} th`)])
      .toEqual([`\n<p>abcd</p>\n${INSERTED_TABLE_2X2}\n<p><br></p>\n`, true]);
  });

  test('pressing → at 10 columns or ↑ at 1 row on the grid keeps the size within 1 to 10', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPickerByKeyboard(page);
    for (let press = 1; press < 10; press += 1) {
      await page.keyboard.press('ArrowRight');
    }
    const widest = await readSizeText(page);

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');

    expect([widest, await readSizeText(page), (await readSelectedLabels(page)).length])
      .toEqual(['1 × 10', '1 × 10', 10]);
  });

  test('entering 12 and 15 in the input fields and pressing the insert button inserts a 12-by-15 table', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPicker(page);
    await rowsInput(page).fill('12');
    await columnsInput(page).fill('15');

    await insertButton(page).click();

    // The first row becomes a header row and the remaining 11 rows become body rows.
    const headerRow = `<tr>${'<th scope="col"><br></th>'.repeat(15)}</tr>\n`;
    const bodyRow = `<tr>${'<td><br></td>'.repeat(15)}</tr>\n`;
    expect(await readBodyHtml(page)).toBe(
      `\n<p>abcd</p>\n<table>\n<tbody>\n${headerRow}${bodyRow.repeat(11)}</tbody>\n</table>\n<p><br></p>\n`,
    );
  });

  test('pressing Enter in an input field inserts the table without a line break in the first cell', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPicker(page);
    await rowsInput(page).click();

    await page.keyboard.press('Enter');

    expect([await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} th`)])
      .toEqual([`\n<p>abcd</p>\n${INSERTED_TABLE_3X3}\n<p><br></p>\n`, true]);
  });

  test('pressing an input field after opening by pointer moves focus to it, and running inserts the table at the selection from before opening', async ({ page }) => {
    await openTableEditor(page, '\n<p>ab</p>\n<p>cd</p>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 1);
    await openPicker(page);

    await rowsInput(page).click();
    await expect(rowsInput(page)).toBeFocused();
    await insertButton(page).click();

    expect(await readBodyHtml(page)).toBe(`\n<p>ab</p>\n${INSERTED_TABLE_3X3}\n<p>cd</p>\n`);
  });

  test('pressing Enter or Esc during IME composition in an input field inserts no table and leaves the picker open', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPicker(page);
    await rowsInput(page).click();
    const ime = await openImeSession(page);
    await ime.send('Input.imeSetComposition', { text: '５', selectionStart: 1, selectionEnd: 1 });

    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');

    expect([await readBodyHtml(page), await page.locator(PICKER).count()]).toEqual([BODY, 1]);
    await expect(rowsInput(page)).toBeFocused();
  });

  test('Esc with focus in the picker closes it and returns focus to the table button', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPickerByKeyboard(page);

    await page.keyboard.press('Escape');

    await expect(page.locator(TABLE_ITEM)).toBeFocused();
    expect([await page.locator(PICKER).count(), await readBodyHtml(page)]).toEqual([0, BODY]);
  });

  test('Tab and Shift+Tab inside move between the grid, input fields and insert button, and leaving closes the picker', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPickerByKeyboard(page);

    const visited: (string | null)[] = [];
    for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      visited.push(await readFocusedName(page));
    }
    // Leaving the grid with Shift+Tab returns to the table button by the default focus move.
    await page.keyboard.press('Shift+Tab');
    const backward = [await page.locator(PICKER).count(), await readFocusedSlot(page)];
    // After reopening, leaving the insert button with Tab enters the editor root by the default focus move.
    await page.keyboard.press('Enter');
    await expect(page.locator(GRID)).toBeFocused();
    for (let press = 0; press < 4; press += 1) {
      await page.keyboard.press('Tab');
    }

    expect([visited, backward, await page.locator(PICKER).count()]).toEqual([
      ['Rows', 'Columns', 'Insert', 'Columns', 'Rows', 'Table Size'],
      [0, TOOLBAR_SLOT.table],
      0,
    ]);
    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
  });

  test('returning to the grid from an input field with Shift+Tab after opening by pointer chooses 1 × 1', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPicker(page);
    await rowsInput(page).click();

    await page.keyboard.press('Shift+Tab');

    await expect(page.locator(GRID)).toBeFocused();
    expect([await readSelectedLabels(page), await readSizeText(page)]).toEqual([['1 × 1'], '1 × 1']);
  });

  test('pressing the bold item with focus on the grid closes the picker, returns to the captured selection, and applies bold there', async ({ page }) => {
    // A range selection shows the floating menu. Selecting the first paragraph would put the menu over the toolbar,
    // so select the third paragraph.
    await openTableEditor(page, '\n<p>x</p>\n<p>y</p>\n<p>abcd</p>\n');
    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} p:last-of-type`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} p:last-of-type`, childIndex: 0, offset: 3 },
    );
    await openPickerByKeyboard(page);

    await page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.bold}"] > button`).click();

    expect([await readBodyHtml(page), await page.locator(PICKER).count()])
      .toEqual(['\n<p>x</p>\n<p>y</p>\n<p>a<strong>bc</strong>d</p>\n', 0]);
    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
  });

  test('pressing a registered key on the grid is not forwarded to VS Code and changes neither the chosen size nor the tree', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPickerByKeyboard(page);
    await installForwardRecord(page);

    await page.keyboard.press('ControlOrMeta+KeyB');
    await page.keyboard.press('Alt+F10');

    // Keydown events of the modifier keys themselves match no shortcut and pass through, so look only at
    // non-modifier keys.
    const forwarded = await readForwardedKeys(page);
    expect([
      ['KeyB', 'F10'].filter((code) => forwarded.includes(code)),
      await readSizeText(page),
      await readBodyHtml(page),
    ]).toEqual([[], '1 × 1', BODY]);
    await expect(page.locator(GRID)).toBeFocused();
  });

  test('while an overlay is up, pressing a grid cell inserts no table and leaves the picker open', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPicker(page);
    await page.evaluate((reason) => {
      window.__uiShellProbe?.()?.overlay.present(reason, { heading: '', descriptions: [], actions: [] });
    }, INPUT_STOP_REASON.saveRoundTrip);

    // The overlay receives the pointer, so send the press directly to the grid cell.
    await pickerCell(page, 1, 1).dispatchEvent('click');

    expect([await readBodyHtml(page), await page.locator(PICKER).count()]).toEqual([BODY, 1]);
  });

  test('in light and dark themes chosen and unchosen grid cells both have solid borders with different backgrounds, in a high-contrast theme unchosen ones are dashed, and in all three the popup border does not match the background', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPicker(page);
    await pickerCell(page, 2, 2).hover();

    const drawn: { selected: string; unselected: string; backgroundsDiffer: boolean; boxBorderMatchesBackground: boolean }[] = [];
    for (const colors of THEME_COLORS) {
      await applyTheme(page, colors);
      drawn.push(await page.locator(PICKER).evaluate((picker) => {
        const readStyle = (selector: string): { border: string; background: string } => {
          const cell = picker.querySelector(selector);
          const style = cell === null ? undefined : getComputedStyle(cell);
          return { border: style?.borderTopStyle ?? '', background: style?.backgroundColor ?? '' };
        };
        const selected = readStyle('[role="gridcell"][aria-selected="true"]');
        const unselected = readStyle('[role="gridcell"][aria-selected="false"]');
        const box = getComputedStyle(picker);
        // The popup paints its surface with a gradient, so the page background is the color to tell the border apart
        // from.
        return {
          selected: selected.border,
          unselected: unselected.border,
          backgroundsDiffer: selected.background !== unselected.background,
          boxBorderMatchesBackground: box.borderTopColor === getComputedStyle(document.body).backgroundColor,
        };
      }));
    }

    expect(drawn).toEqual(THEME_COLORS.map((colors) => ({
      selected: 'solid',
      unselected: colors.highContrast ? 'dashed' : 'solid',
      backgroundsDiffer: true,
      boxBorderMatchesBackground: false,
    })));
  });

  test('rounds the corners of the picker with a 14px radius and gives it a shadow', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);

    await openPicker(page);

    expect(await page.locator(PICKER).evaluate((picker) => {
      const style = getComputedStyle(picker);
      return [style.borderTopLeftRadius, style.borderBottomRightRadius, style.boxShadow !== 'none'];
    })).toEqual(['14px', '14px', true]);
  });

  test('choosing the first size on the grid does not change the height of the picker', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPicker(page);
    const readHeight = (): Promise<number> => page.locator(PICKER).evaluate(
      (picker) => picker.getBoundingClientRect().height,
    );
    // Opened by pointer, nothing is chosen yet, so the size display is still empty.
    const before = [await readSizeText(page), await readHeight()];

    await pickerCell(page, 3, 4).hover();

    expect([before[0], await readSizeText(page), await readHeight()]).toEqual(['', '3 × 4', before[1]]);
  });

  test('gives the rows and columns input fields VS Code\'s input field colors from the variables', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await applyThemeVariables(page, {
      '--vscode-input-background': 'rgb(49, 49, 51)',
      '--vscode-input-foreground': 'rgb(204, 204, 206)',
      '--vscode-input-border': 'rgb(60, 60, 61)',
    });

    await openPicker(page);

    const readColors = (field: Locator): Promise<string[]> => field.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.color, style.borderTopColor];
    });
    const expected = ['rgb(49, 49, 51)', 'rgb(204, 204, 206)', 'rgb(60, 60, 61)'];
    expect([await readColors(rowsInput(page)), await readColors(columnsInput(page))]).toEqual([expected, expected]);
  });

  test('gives the insert button the primary button colors from the variables', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await applyThemeVariables(page, {
      '--vscode-button-background': 'rgb(0, 120, 212)',
      '--vscode-button-foreground': 'rgb(255, 255, 254)',
    });

    await openPicker(page);

    expect(await insertButton(page).evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.color];
    })).toEqual(['rgb(0, 120, 212)', 'rgb(255, 255, 254)']);
  });

  test('moving keyboard focus to the grid, input fields and insert button shows the focus ring', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPickerByKeyboard(page);

    const outlines = [await readOutline(page.locator(GRID))];
    for (const target of [rowsInput(page), columnsInput(page), insertButton(page)]) {
      await page.keyboard.press('Tab');
      await expect(target).toBeFocused();
      outlines.push(await readOutline(target));
    }

    expect(outlines).toEqual([
      { style: 'solid', width: '2px' },
      { style: 'solid', width: '2px' },
      { style: 'solid', width: '2px' },
      { style: 'solid', width: '2px' },
    ]);
  });

  test('the open picker is found as a dialog with the same name as the item and the grid as a grid, and the chosen grid cell name conveys the size', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPickerByKeyboard(page);

    await page.keyboard.press('ArrowRight');

    const dialog = page.getByRole('dialog', { name: 'Table', exact: true });
    const grid = dialog.getByRole('grid', { name: 'Table Size', exact: true });
    await expect(dialog).toHaveCount(1);
    await expect(grid).toHaveCount(1);
    const active = page.locator(`#${await grid.getAttribute('aria-activedescendant') ?? ''}`);
    await expect(active).toHaveAccessibleName('1 × 2');
    await expect(active).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('insert table', () => {
  test('text typed right after inserting goes into the first cell, which holds only that text in the saved content', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPicker(page);
    await pickerCell(page, 2, 2).click();

    await page.keyboard.type('X');

    expect(await readSavedBody(page)).toBe(
      '\n<p>abcd</p>\n<table>\n<tbody>\n<tr><th scope="col">X</th><th scope="col"><br></th></tr>\n'
      + '<tr><td><br></td><td><br></td></tr>\n</tbody>\n</table>\n<p><br></p>\n',
    );
  });

  test('inserting in an empty document with no input leaves an empty paragraph after the table', async ({ page }) => {
    await openTableEditor(page, '');
    await openPicker(page);

    await pickerCell(page, 2, 2).click();

    // In an empty editor root, the materialized paragraph becomes the empty reference and stays as the line after the
    // table.
    expect(await readBodyHtml(page)).toBe(`\n\n${INSERTED_TABLE_2X2}\n<p><br></p>`);
  });

  test('one insertion delivers exactly one settled edit unit, and undo returns to before the insertion', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPicker(page);

    await pickerCell(page, 2, 2).click();
    await flushEditTransactions(page, 'table-insert');

    const transactions = await readTransactions(page);
    expect(transactions.map((transaction) => transaction.before.text)).toEqual([`${PROLOGUE}${BODY}${EPILOGUE}`]);
    await applyUndo(page, transactions[0]);
    await expect.poll(() => readBodyHtml(page)).toBe(BODY);
  });

  test('inserting in a paragraph with a range selection keeps the text in the range and inserts the table right after the paragraph', async ({ page }) => {
    await openTableEditor(page, BODY);
    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 3 },
    );
    // Open by keyboard so the floating menu shown for the range selection does not block the pointer press.
    await openPickerByKeyboard(page);

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe(`\n<p>abcd</p>\n${INSERTED_TABLE_1X1}\n<p><br></p>\n`);
  });

  test('inserting in the second item of an ordered list puts the table inside the item, and the third item stays numbered 3', async ({ page }) => {
    await openTableEditor(page, '\n<ol>\n<li>a</li>\n<li>b</li>\n<li>c</li>\n</ol>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} li:nth-child(2)`, 1);
    await openPicker(page);

    await pickerCell(page, 1, 1).click();

    // If the list remains a single list, the third item number is determined by the start number and its position.
    const numberOfThird = await page.locator(`${EDITOR_ROOT} > ol`).evaluate((list) => {
      if (!(list instanceof HTMLOListElement)) {
        return -1;
      }
      const items = [...list.children].filter((child) => child.localName === 'li');
      return list.start + items.findIndex((item) => item.textContent === 'c');
    });
    expect([await readBodyHtml(page), numberOfThird]).toEqual([
      `\n<ol>\n<li>a</li>\n<li>b\n${INSERTED_TABLE_1X1}\n<p><br></p></li>\n<li>c</li>\n</ol>\n`,
      3,
    ]);
  });

  test('saving and reloading an inserted table returns the body to the same form', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 2);
    await openPicker(page);
    await pickerCell(page, 2, 2).click();
    await page.keyboard.type('X');
    const saved = await readSavedBody(page) ?? '';

    await replaceBody(page, saved);

    expect(await readBodyHtml(page)).toBe(saved);
  });

  test('inserting on an empty line of a blockquote puts the table inside the blockquote before that line, which stays after the table', async ({ page }) => {
    await openTableEditor(page, '\n<blockquote data-alert="note">ab<br><br>cd</blockquote>\n');
    await page.evaluate((argument) => {
      const quote = document.querySelector(argument.selector);
      if (quote === null) {
        throw new Error('blockquote not found');
      }
      document.getElementById(argument.rootId)?.focus();
      const range = document.createRange();
      range.setStart(quote, 2);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }, { selector: `${EDITOR_ROOT} blockquote`, rootId: EDITOR_ROOT_ELEMENT_ID });
    await openPicker(page);

    await pickerCell(page, 1, 1).click();

    expect(await readBodyHtml(page)).toBe(
      `\n<blockquote data-alert="note"><p>ab</p>\n\n${INSERTED_TABLE_1X1}\n<p><br></p>\n<p>cd</p></blockquote>\n`,
    );
  });

  test('inserting in a paragraph of a details body puts the table inside the body', async ({ page }) => {
    await openTableEditor(page, '\n<details open="">\n<summary>title</summary>\n<p>body</p>\n</details>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} details > p`, 2);
    await openPicker(page);

    await pickerCell(page, 1, 1).click();

    expect(await readBodyHtml(page)).toBe(
      `\n<details open="">\n<summary>title</summary>\n<p>body</p>\n${INSERTED_TABLE_1X1}\n<p><br></p>\n</details>\n`,
    );
  });
});

test.describe('move to adjacent cell', () => {
  test('Tab in a cell moves the caret to the start of the next cell without changing the tree', async ({ page }) => {
    await openTableEditor(page, TABLE_BODY);
    await placeCaretInText(page, cellAt(1, 1), 1);

    await page.keyboard.press('Tab');

    expect([await readCaret(page), await readBodyHtml(page)]).toEqual([['cd', 0], TABLE_BODY]);
  });

  test('Shift+Tab moves to the start of the previous cell, and from the first cell of a row to the last cell of the previous row', async ({ page }) => {
    await openTableEditor(page, TABLE_BODY);
    await placeCaretInText(page, cellAt(2, 1), 1);

    await page.keyboard.press('Shift+Tab');
    const fromRowStart = await readCaret(page);
    await page.keyboard.press('Shift+Tab');

    expect([fromRowStart, await readCaret(page)]).toEqual([['cd', 0], ['ab', 0]]);
  });

  test('Tab in the last cell appends one row and moves the caret to the first cell of the new row', async ({ page }) => {
    await openTableEditor(page, TABLE_BODY);
    await placeCaretInText(page, cellAt(2, 2), 2);

    await page.keyboard.press('Tab');

    expect([await readBodyHtml(page), await isCaretInside(page, cellAt(3, 1))]).toEqual([
      '\n<table>\n<tbody>\n<tr><td>ab</td><td>cd</td></tr>\n<tr><td>ef</td><td>gh</td></tr>\n'
      + '<tr><td><br></td><td><br></td></tr>\n</tbody>\n</table>\n',
      true,
    ]);
  });

  test('Shift+Tab in the first cell changes neither the tree nor the selection, and focus stays in the editor root', async ({ page }) => {
    await openTableEditor(page, TABLE_BODY);
    await placeCaretInText(page, cellAt(1, 1), 1);

    await page.keyboard.press('Shift+Tab');

    expect([await readBodyHtml(page), await readCaret(page), await page.evaluate(() => document.activeElement?.id)])
      .toEqual([TABLE_BODY, ['ab', 1], EDITOR_ROOT_ELEMENT_ID]);
  });

  test('with a range selection spanning several cells, moves to the cell after the one containing the start and collapses the range', async ({ page }) => {
    await openTableEditor(page, TABLE_BODY);
    await selectRange(
      page,
      { selector: cellAt(1, 1), childIndex: 0, offset: 1 },
      { selector: cellAt(2, 1), childIndex: 0, offset: 1 },
    );

    await page.keyboard.press('Tab');

    expect([await readCaret(page), await isCollapsed(page), await readBodyHtml(page)])
      .toEqual([['cd', 0], true, TABLE_BODY]);
  });

  test('Tab in a list item inside a cell indents the list instead of moving to another cell', async ({ page }) => {
    await openTableEditor(page, '\n<table><tbody><tr><td><ul><li>ab</li><li>cd</li></ul></td><td>ef</td></tr></tbody></table>\n');
    // After indenting, the selection is restored by character count and snaps to the start of the later text at a
    // text seam. At a seam, moving to another cell could not be told apart, so place it in the middle of the item
    // text.
    await placeCaretInText(page, `${EDITOR_ROOT} li:nth-child(2)`, 1);

    await page.keyboard.press('Tab');

    expect([await readBodyHtml(page), await readCaret(page)]).toEqual([
      '\n<table><tbody><tr><td><ul><li>ab\n<ul><li>cd</li></ul></li></ul></td><td>ef</td></tr></tbody></table>\n',
      ['cd', 1],
    ]);
  });

  test('Tab moves between cells in a table inside a list item and in a details body inside an item inside a cell', async ({ page }) => {
    await openTableEditor(page, '\n<ul><li>a<table><tbody><tr><td>c</td><td>d</td></tr></tbody></table></li></ul>\n');
    await placeCaretInText(page, `${EDITOR_ROOT} td`, 1);
    await page.keyboard.press('Tab');
    const fromItem = await readCaret(page);

    await replaceBody(
      page,
      '\n<table><tbody><tr><td><ul><li><details open=""><summary>t</summary><p>x</p></details></li></ul></td>'
      + '<td>y</td></tr></tbody></table>\n',
    );
    await placeCaretInText(page, `${EDITOR_ROOT} details > p`, 1);
    await page.keyboard.press('Tab');

    expect([fromItem, await readCaret(page)]).toEqual([['d', 0], ['y', 0]]);
  });

  test('Tab in the last cell of a nested table appends a row to the inner table', async ({ page }) => {
    await openTableEditor(
      page,
      '\n<table><tbody><tr><td><table><tbody><tr><td>in</td></tr></tbody></table></td><td>out</td></tr></tbody></table>\n',
    );
    await placeCaretInText(page, `${EDITOR_ROOT} td td`, 2);

    await page.keyboard.press('Tab');

    expect([await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} td tr:last-child > td`)]).toEqual([
      '\n<table><tbody><tr><td><table><tbody><tr><td>in</td></tr>\n<tr><td><br></td></tr></tbody></table></td>'
      + '<td>out</td></tr></tbody></table>\n',
      true,
    ]);
  });

  test('Tab during IME composition changes neither the caret nor the tree', async ({ page }) => {
    await openTableEditor(page, TABLE_BODY);
    await placeCaretInText(page, cellAt(1, 1), 2);
    const ime = await openImeSession(page);
    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    const composing = [await readBodyHtml(page), await readCaret(page)];

    await page.keyboard.press('Tab');

    expect([await readBodyHtml(page), await readCaret(page)]).toEqual(composing);
    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
  });

  test('even when the destination cell starts with a line break and indentation or a paragraph, the next typed text goes right before the first character', async ({ page }) => {
    await openTableEditor(page, '\n<table>\n<tbody>\n<tr><td>ab</td><td>\n  cd</td><td><p>ef</p></td></tr>\n</tbody>\n</table>\n');
    await placeCaretInText(page, cellAt(1, 1), 1);

    await page.keyboard.press('Tab');
    await page.keyboard.type('X');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Y');

    // The leading line break and indentation are not drawn and the browser may remove them on typing, so check the
    // visible text order.
    const cells = await page.locator(`${EDITOR_ROOT} td`)
      .evaluateAll((elements) => elements.map((cell) => (cell instanceof HTMLElement ? cell.innerText : null)));
    expect([cells, await page.locator(`${EDITOR_ROOT} td p`).innerHTML()]).toEqual([['ab', 'Xcd', 'Yef'], 'Yef']);
  });

  test('Tab that moves between cells sets no dirty mark and sends no edit unit', async ({ page }) => {
    await openTableEditor(page, TABLE_BODY);
    await placeCaretInText(page, cellAt(1, 1), 1);

    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await flushEditTransactions(page, 'table-move');

    expect([
      await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.viewEdited),
      await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart),
      await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction),
    ]).toEqual([0, 0, 0]);
  });

  test('a row added by Tab in the last cell arrives as one edit unit and is removed by undo', async ({ page }) => {
    await openTableEditor(page, TABLE_BODY);
    await placeCaretInText(page, cellAt(2, 2), 2);

    await page.keyboard.press('Tab');
    await flushEditTransactions(page, 'table-append');

    const transactions = await readTransactions(page);
    expect(transactions.map((transaction) => transaction.before.text))
      .toEqual([`${PROLOGUE}${TABLE_BODY}${EPILOGUE}`]);
    await applyUndo(page, transactions[0]);
    await expect.poll(() => readBodyHtml(page)).toBe(TABLE_BODY);
  });

  test('Tab in a cell still moves between cells after document replacement', async ({ page }) => {
    await openTableEditor(page, '\n<p>x</p>\n');
    await replaceBody(page, TABLE_BODY);
    await placeCaretInText(page, cellAt(1, 1), 1);

    await page.keyboard.press('Tab');

    expect(await readCaret(page)).toEqual(['cd', 0]);
  });

  test('Tab in a table inside a details body moves between cells, and appends a row in the last cell', async ({ page }) => {
    await openTableEditor(
      page,
      '\n<details open="">\n<summary>t</summary>\n<table>\n<tbody>\n<tr><td>ab</td><td>cd</td></tr>\n</tbody>\n</table>\n</details>\n',
    );
    await placeCaretInText(page, cellAt(1, 1), 1);

    await page.keyboard.press('Tab');
    const moved = await readCaret(page);
    await page.keyboard.press('Tab');

    expect([moved, await readBodyHtml(page), await isCaretInside(page, cellAt(2, 1))]).toEqual([
      ['cd', 0],
      '\n<details open="">\n<summary>t</summary>\n<table>\n<tbody>\n<tr><td>ab</td><td>cd</td></tr>\n'
      + '<tr><td><br></td><td><br></td></tr>\n</tbody>\n</table>\n</details>\n',
      true,
    ]);
  });
});

test.describe('table operations', () => {
  test('after adding a row, the caret stays at the same position in the same cell as before the operation', async ({ page }) => {
    await openTableEditor(page, TABLE_BODY);
    await placeCaretInText(page, cellAt(1, 2), 1);

    const changed = await runTableCommand(page, { kind: 'insertRow', direction: 'above' }, cellAt(1, 2));

    expect([changed, await readBodyHtml(page), await readCaret(page)]).toEqual([
      true,
      '\n<table>\n<tbody>\n<tr><td><br></td><td><br></td></tr>\n<tr><td>ab</td><td>cd</td></tr>\n'
      + '<tr><td>ef</td><td>gh</td></tr>\n</tbody>\n</table>\n',
      ['cd', 1],
    ]);
  });

  test('adding a column before the caret keeps the caret before the same character', async ({ page }) => {
    await openTableEditor(page, TABLE_BODY);
    await placeCaretInText(page, cellAt(1, 2), 1);

    await runTableCommand(page, { kind: 'insertColumn', direction: 'left' }, cellAt(1, 2));

    expect([await readBodyHtml(page), await readCaret(page)]).toEqual([
      '\n<table>\n<tbody>\n<tr><td>ab</td><td><br></td><td>cd</td></tr>\n'
      + '<tr><td>ef</td><td><br></td><td>gh</td></tr>\n</tbody>\n</table>\n',
      ['cd', 1],
    ]);
  });

  test('deleting the row with the caret moves the caret to the start of the cell in the same column of the next row', async ({ page }) => {
    await openTableEditor(page, TABLE_BODY);
    await placeCaretInText(page, cellAt(1, 2), 1);

    await runTableCommand(page, { kind: 'deleteRow' }, cellAt(1, 2));

    expect([await readBodyHtml(page), await readCaret(page)]).toEqual([
      '\n<table>\n<tbody>\n<tr><td>ef</td><td>gh</td></tr>\n</tbody>\n</table>\n',
      ['gh', 0],
    ]);
  });

  test('deleting the column with the caret moves the caret to the start of the cell in the next column of the same row', async ({ page }) => {
    await openTableEditor(page, TABLE_BODY);
    await placeCaretInText(page, cellAt(2, 1), 1);

    await runTableCommand(page, { kind: 'deleteColumn' }, cellAt(2, 1));

    expect([await readBodyHtml(page), await readCaret(page)]).toEqual([
      '\n<table>\n<tbody>\n<tr><td>cd</td></tr>\n<tr><td>gh</td></tr>\n</tbody>\n</table>\n',
      ['gh', 0],
    ]);
  });

  test('deleting a freshly inserted table moves the caret to the empty paragraph, leaving only one empty paragraph', async ({ page }) => {
    await openTableEditor(page, BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} p`, 4);
    await openPicker(page);
    await pickerCell(page, 2, 2).click();

    await runTableCommand(page, { kind: 'deleteTable' }, `${EDITOR_ROOT} th`);

    expect([await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} > p:last-of-type`)])
      .toEqual(['\n<p>abcd</p>\n<p><br></p>\n', true]);
  });

  test('when only one end of a range selection is in the removed row, the range collapses and the caret moves to the placement', async ({ page }) => {
    await openTableEditor(
      page,
      '\n<table>\n<tbody>\n<tr><td>ab</td><td>cd</td></tr>\n<tr><td>ef</td><td>gh</td></tr>\n'
      + '<tr><td>ij</td><td>kl</td></tr>\n</tbody>\n</table>\n',
    );
    await selectRange(
      page,
      { selector: cellAt(1, 1), childIndex: 0, offset: 1 },
      { selector: cellAt(2, 1), childIndex: 0, offset: 1 },
    );

    await runTableCommand(page, { kind: 'deleteRow' }, cellAt(2, 1));

    expect([await readBodyHtml(page), await readCaret(page), await isCollapsed(page)]).toEqual([
      '\n<table>\n<tbody>\n<tr><td>ab</td><td>cd</td></tr>\n<tr><td>ij</td><td>kl</td></tr>\n</tbody>\n</table>\n',
      ['ij', 0],
      true,
    ]);
  });

  test('the caret inside a cell whose element name changed by toggling the header row stays at the same position', async ({ page }) => {
    await openTableEditor(page, TABLE_BODY);
    await placeCaretInText(page, cellAt(1, 2), 1);

    await runTableCommand(page, { kind: 'toggleHeaderRow' }, cellAt(1, 2));

    expect([await readBodyHtml(page), await readCaret(page), await isCaretInside(page, `${EDITOR_ROOT} th:nth-child(2)`)])
      .toEqual([
        '\n<table>\n<tbody>\n<tr><th scope="col">ab</th><th scope="col">cd</th></tr>\n'
        + '<tr><td>ef</td><td>gh</td></tr>\n</tbody>\n</table>\n',
        ['cd', 1],
        true,
      ]);
  });

  test('in the saved content after toggling the header column, the cell becomes th (scope="row") and the text of untoggled rows is unchanged', async ({ page }) => {
    // Unquoted attributes change spelling on serialization. This spelling tells whether untouched lines keep their
    // original spelling.
    const headerLine = '<tr><th scope=col>h1</th><th scope=col>h2</th></tr>';
    await openTableEditor(
      page,
      `\n<table>\n<tbody>\n${headerLine}\n<tr><td>a</td><td>b</td></tr>\n<tr><td>c</td><td>d</td></tr>\n</tbody>\n</table>\n`,
    );
    await placeCaretInText(page, cellAt(2, 1), 1);

    await runTableCommand(page, { kind: 'toggleHeaderColumn' }, cellAt(2, 1));

    expect(await readSavedBody(page)).toBe(
      `\n<table>\n<tbody>\n${headerLine}\n<tr><th scope="row">a</th><td>b</td></tr>\n`
      + '<tr><th scope="row">c</th><td>d</td></tr>\n</tbody>\n</table>\n',
    );
  });

  test('one table operation delivers one settled edit unit, and undo returns to the table before the operation', async ({ page }) => {
    await openTableEditor(page, TABLE_BODY);
    await placeCaretInText(page, cellAt(1, 1), 1);

    await runTableCommand(page, { kind: 'insertColumn', direction: 'right' }, cellAt(1, 1));
    await flushEditTransactions(page, 'table-operation');

    const transactions = await readTransactions(page);
    expect(transactions.map((transaction) => transaction.before.text))
      .toEqual([`${PROLOGUE}${TABLE_BODY}${EPILOGUE}`]);
    await applyUndo(page, transactions[0]);
    await expect.poll(() => readBodyHtml(page)).toBe(TABLE_BODY);
  });

  test('in the saved content after adding a row, untouched lines keep their text and the new row appears on its own line', async ({ page }) => {
    // Unquoted attributes change spelling on serialization. This spelling tells whether untouched lines keep their
    // original spelling.
    // Adjacent lines with changed spelling would be rewritten as one segment, so put a line whose spelling does not
    // change between them.
    const firstLine = '<tr><td class=a>ab</td><td>cd</td></tr>';
    const secondLine = '<tr><td>ef</td><td>gh</td></tr>';
    const thirdLine = '<tr><td class=c>ij</td><td>kl</td></tr>';
    await openTableEditor(page, `\n<table>\n<tbody>\n${firstLine}\n${secondLine}\n${thirdLine}\n</tbody>\n</table>\n`);
    await placeCaretInText(page, cellAt(1, 1), 1);

    await runTableCommand(page, { kind: 'insertRow', direction: 'below' }, cellAt(1, 1));

    expect(await readSavedBody(page)).toBe(
      `\n<table>\n<tbody>\n${firstLine}\n<tr><td><br></td><td><br></td></tr>\n${secondLine}\n${thirdLine}\n`
      + '</tbody>\n</table>\n',
    );
  });

  test('adding rows and columns to a gapless table with rowspan and colspan creates neither gaps nor overlaps in real browser rendering', async ({ page }) => {
    await openTableEditor(
      page,
      '\n<table>\n<tbody>\n<tr><td id="a" rowspan="2">a</td><td id="b">b</td><td id="c">c</td></tr>\n'
      + '<tr><td id="d" colspan="2">d</td></tr>\n<tr><td id="e">e</td><td id="f">f</td><td id="g">g</td></tr>\n'
      + '</tbody>\n</table>\n',
    );
    await applyMeasurableTableStyle(page);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    const before = await readLayoutDefects(page);

    // Add at positions touching the middle and bottom edge of a rowspan and the middle and left edge of a colspan.
    await runTableCommand(page, { kind: 'insertRow', direction: 'below' }, `${EDITOR_ROOT} #a`);
    await runTableCommand(page, { kind: 'insertRow', direction: 'above' }, `${EDITOR_ROOT} #d`);
    await runTableCommand(page, { kind: 'insertColumn', direction: 'right' }, `${EDITOR_ROOT} #b`);
    await runTableCommand(page, { kind: 'insertColumn', direction: 'left' }, `${EDITOR_ROOT} #d`);

    expect([before, await readLayoutDefects(page)]).toEqual([
      { overlaps: 0, uncoveredArea: 0 },
      { overlaps: 0, uncoveredArea: 0 },
    ]);
  });

  test('in a table inside a details body, adding a column and deleting a row work the same as outside the body', async ({ page }) => {
    const table = '<table>\n<tbody>\n<tr><td>ab</td><td>cd</td></tr>\n<tr><td>ef</td><td>gh</td></tr>\n</tbody>\n</table>';
    await openTableEditor(page, `\n${table}\n<details open="">\n<summary>t</summary>\n${table}\n</details>\n`);

    const results: string[] = [];
    for (const scope of [`${EDITOR_ROOT} > table`, `${EDITOR_ROOT} details > table`]) {
      await placeCaretInText(page, `${scope} tr:nth-child(1) > td:nth-child(1)`, 1);
      await runTableCommand(page, { kind: 'insertColumn', direction: 'right' }, `${scope} tr:nth-child(1) > td:nth-child(1)`);
      await runTableCommand(page, { kind: 'deleteRow' }, `${scope} tr:nth-child(2) > td:nth-child(1)`);
      results.push(await page.locator(scope).evaluate((element) => element.outerHTML));
    }

    const expected = '<table>\n<tbody>\n<tr><td>ab</td><td><br></td><td>cd</td></tr>\n</tbody>\n</table>';
    expect(results).toEqual([expected, expected]);
  });
});
