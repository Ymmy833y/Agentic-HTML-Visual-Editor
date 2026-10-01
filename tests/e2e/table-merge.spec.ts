import { devices, expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import {
  DOCUMENT_APPLY_KIND,
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import type { EditTransaction } from '../../common/index';
import { CELL_RANGE_MARK_NAME, CELL_RANGE_MARK_NAMESPACE } from '../../webview/editing/cell-range';
import { OUTPUT_DEBOUNCE_MS } from '../../webview/editing/change-tracker';
import type { TableOperation } from '../../webview/editing/table-command';
import { BLOCK_TYPE_MENU_CLASS } from '../../webview/ui/block-type-menu';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { EDITOR_ROOT, focusEditor, openEditor, placeCaret, readBodyHtml } from './helpers/editing';
import { getOutboundMessages, sendToWebview } from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;
// The popup contents go into the same container as the item, so point only at the direct child button.
const BLOCK_TYPE_ITEM = `${TOOLBAR} [data-slot="${TOOLBAR_SLOT.blockType}"] > button`;
const BLOCK_TYPE_MENU = `${TOOLBAR} .${BLOCK_TYPE_MENU_CLASS}`;

/** A body holding only a 3 by 3 table whose cells each have different text. */
const TABLE_BODY = '\n<table>\n<tbody>\n'
  + '<tr><td id="a">ab</td><td id="b">cd</td><td id="c">ef</td></tr>\n'
  + '<tr><td id="d">gh</td><td id="e">ij</td><td id="f">kl</td></tr>\n'
  + '<tr><td id="g">mn</td><td id="h">op</td><td id="i">qr</td></tr>\n'
  + '</tbody>\n</table>\n';

/** Text of the cells of the rectangle from A (top left) to E (center). */
const MARKED_A_TO_E = ['ab', 'cd', 'gh', 'ij'];

/** Colors given by the light, dark and high contrast themes. The link color becomes the color of the mark outline. */
const THEMES = [
  {
    '--vscode-editor-background': '#ffffff',
    '--vscode-editor-foreground': '#3b3b3b',
    '--vscode-textLink-foreground': '#005fb8',
  },
  {
    '--vscode-editor-background': '#1f1f1f',
    '--vscode-editor-foreground': '#cccccc',
    '--vscode-textLink-foreground': '#4daafc',
  },
  {
    '--vscode-editor-background': '#000000',
    '--vscode-editor-foreground': '#ffffff',
    '--vscode-textLink-foreground': '#21a6ff',
  },
];

// The view decides the primary modifier from the userAgent, but the Desktop Chrome descriptor returns a Windows
// userAgent regardless of the OS. Registered keys are pressed as real keystrokes, so match the userAgent to the
// running OS.
const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
test.use({ userAgent: process.platform === 'darwin' ? MAC_USER_AGENT : devices['Desktop Chrome'].userAgent });

declare global {
  interface Window {
    /** The forwarded key record. Holds the code of each keydown that reached the window bubbling phase, in order. */
    __forwardedKeys?: string[];
  }
}

/** Table operations holding no elements. Elements cannot be passed as evaluate arguments, so cell merge is excluded. */
type SerializableTableOperation = Exclude<TableOperation, { readonly kind: 'mergeCells' }>;

/** The range obtained from the query. Cells are represented by id. */
interface MergeRange {
  readonly referenceCell: string;
  readonly otherCell: string;
  readonly mergeable: boolean;
}

/**
 * Moves focus to the editor root and places the caret in the text of the element's first child.
 *
 * @param page The page to operate on.
 * @param selector Selector of the element holding the text.
 * @param offset Position within the text.
 */
async function placeCaretInText(page: Page, selector: string, offset: number): Promise<void> {
  await focusEditor(page);
  await placeCaret(page, { selector, childIndex: 0, offset });
}

/**
 * Shift+clicks an element.
 *
 * @param page The page to operate on.
 * @param selector Selector of the element to press.
 */
async function shiftClick(page: Page, selector: string): Promise<void> {
  await page.locator(selector).click({ modifiers: ['Shift'] });
}

/**
 * Reads the text of the elements carrying the mark in the editor root, in document order.
 *
 * @param page The page to operate on.
 * @returns The text of the elements carrying the mark.
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
 * Queries a cell through the same entry point as the product and reads the range by id.
 *
 * @param page The page to operate on.
 * @param selector Selector of the cell to query.
 * @returns The range, or `null` if the cell is not in the range.
 */
async function readMergeRange(page: Page, selector: string): Promise<MergeRange | null> {
  return page.evaluate((target) => {
    const cell = document.querySelector(target);
    if (cell === null) {
      throw new Error(`Cell not found: ${target}`);
    }
    const range = window.__cellMergeStateProbe?.(cell).range;
    return range === undefined
      ? null
      : { referenceCell: range.referenceCell.id, otherCell: range.otherCell.id, mergeable: range.mergeable };
  }, selector);
}

/**
 * Calls cell merge through the same entry point as the product, with the ends of the range obtained by querying a cell.
 * This is the same way the later menu calls it.
 *
 * @param page The page to operate on.
 * @param selector Selector of a cell in the range.
 * @returns `true` when the tree was changed.
 */
async function mergeRange(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((target) => {
    const cell = document.querySelector(target);
    const range = cell === null ? undefined : window.__cellMergeStateProbe?.(cell).range;
    if (range === undefined) {
      throw new Error(`Not a cell in the range: ${target}`);
    }
    return window.__tableCommandProbe?.({ kind: 'mergeCells', otherCell: range.otherCell }, range.referenceCell) ?? false;
  }, selector);
}

/**
 * Calls cell merge through the same entry point as the product, with the reference cell and the other cell given by
 * selectors.
 *
 * @param page The page to operate on.
 * @param referenceSelector Selector of the reference cell.
 * @param otherSelector Selector of the other cell.
 * @returns `true` when the tree was changed.
 */
async function mergeCells(page: Page, referenceSelector: string, otherSelector: string): Promise<boolean> {
  return page.evaluate((argument) => {
    const reference = document.querySelector(argument.referenceSelector);
    const other = document.querySelector(argument.otherSelector);
    if (reference === null || other === null) {
      throw new Error(`Cell not found: ${argument.referenceSelector} ${argument.otherSelector}`);
    }
    return window.__tableCommandProbe?.({ kind: 'mergeCells', otherCell: other }, reference) ?? false;
  }, { referenceSelector, otherSelector });
}

/**
 * Calls a table operation through the same entry point as the product.
 *
 * @param page The page to operate on.
 * @param operation The table operation.
 * @param selector Selector of the reference cell.
 * @returns `true` when the tree was changed.
 */
async function runTableCommand(page: Page, operation: SerializableTableOperation, selector: string): Promise<boolean> {
  return page.evaluate((argument) => {
    const cell = document.querySelector(argument.selector);
    if (cell === null) {
      throw new Error(`Cell not found: ${argument.selector}`);
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
 * Reads the caret position as a pair of the node text and the offset.
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
 * Returns whether the selection is collapsed.
 *
 * @param page The page to operate on.
 * @returns `true` if collapsed.
 */
async function isCollapsed(page: Page): Promise<boolean | undefined> {
  return page.evaluate(() => window.getSelection()?.isCollapsed);
}

/**
 * Returns whether the anchor and the focus of the selection are each inside an element.
 *
 * @param page The page to operate on.
 * @param anchorSelector Selector of the element expected to contain the anchor.
 * @param focusSelector Selector of the element expected to contain the focus.
 * @returns Whether the anchor and the focus are each inside.
 */
async function readSelectionEnds(page: Page, anchorSelector: string, focusSelector: string): Promise<[boolean, boolean]> {
  return page.evaluate((argument): [boolean, boolean] => {
    const selection = window.getSelection();
    const anchor = document.querySelector(argument.anchorSelector);
    const focus = document.querySelector(argument.focusSelector);
    return [
      anchor !== null && selection?.anchorNode !== null && selection?.anchorNode !== undefined
        && anchor.contains(selection.anchorNode),
      focus !== null && selection?.focusNode !== null && selection?.focusNode !== undefined
        && focus.contains(selection.focusNode),
    ];
  }, { anchorSelector, focusSelector });
}

/**
 * Returns whether the caret is inside an element.
 *
 * @param page The page to operate on.
 * @param selector Selector of the element.
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
 * Reads the body that saving writes out.
 *
 * @param page The page to operate on.
 * @returns The body. `undefined` before mounting.
 */
async function readSavedBody(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__serializationProbe?.()?.body);
}

/**
 * Reads the sent edit transactions in the order they were sent.
 *
 * @param page The page to operate on.
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
      // Already narrowed by type and shape; messages of this type carry only an edit transaction.
      return [message.transaction as EditTransaction];
    }
    return [];
  });
}

/**
 * Reads the full text of the sent unsaved content messages, in the order they were sent.
 *
 * @param page The page to operate on.
 * @returns The full texts of the unsaved content.
 */
async function readUnsavedTexts(page: Page): Promise<string[]> {
  const messages = await getOutboundMessages(page);
  return messages.flatMap((message) => {
    if (
      typeof message === 'object'
      && message !== null
      && Reflect.get(message, 'type') === VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent
    ) {
      return [String(Reflect.get(message, 'text'))];
    }
    return [];
  });
}

/**
 * Returns the number of sent messages of the given type.
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
 * Requests a flush of pending edit transactions and waits for the response.
 *
 * Pending edit transactions are sent before the response, so counting after this does not miss transactions that
 * arrive late.
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
 * Applies the before side of a received edit transaction as an undo.
 *
 * @param page The page to operate on.
 * @param transaction The received edit transaction.
 */
async function applyUndo(page: Page, transaction: EditTransaction): Promise<void> {
  await sendToWebview(page, {
    type: HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument,
    requestId: 'table-merge-undo',
    kind: DOCUMENT_APPLY_KIND.editHistory,
    text: transaction.before.text,
    targetText: transaction.after.text,
    targetSelection: transaction.before.selection,
    editRange: { start: 0, count: 0 },
  });
}

/**
 * Imitates VS Code forwarding and starts recording the code of each keydown that reaches the window bubbling phase.
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
 * @returns The codes of the keydowns that arrived.
 */
async function readForwardedKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__forwardedKeys ?? []);
}

/**
 * Applies theme variables. VS Code puts them on the root element, so they are reproduced there.
 *
 * @param page The page to operate on.
 * @param variables The theme variables to apply.
 */
async function applyThemeVariables(page: Page, variables: Record<string, string>): Promise<void> {
  await page.evaluate((given) => {
    for (const [name, value] of Object.entries(given)) {
      document.documentElement.style.setProperty(name, value);
    }
  }, variables);
}

/**
 * Reads the computed outline of a cell and compares it with a background color.
 *
 * @param locator The cell.
 * @param background Selector of the element whose background color is read.
 * @returns The line style and width, and whether the outline color differs from the background color.
 */
async function readOutline(
  locator: Locator,
  background: string,
): Promise<{ style: string; width: string; differsFromBackground: boolean }> {
  return locator.evaluate((element, selector) => {
    const style = getComputedStyle(element);
    const backdrop = document.querySelector(selector) ?? element;
    return {
      style: style.outlineStyle,
      width: style.outlineWidth,
      differsFromBackground: style.outlineColor !== getComputedStyle(backdrop).backgroundColor,
    };
  }, background);
}

/**
 * Normalizes the boxes of table cells to have no border, padding or spacing.
 *
 * With the default appearance, collapsed borders make adjacent cell boxes touch and overlap, so gaps and overlaps
 * cannot be counted by area.
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
 * Counts, in the rendered table, the pairs of cells whose boxes overlap and the area covered by no cell.
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
        // Intrusions of less than one pixel caused by rounding fractional coordinates are not counted as overlaps.
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

/**
 * Reads the rendered left edge of cells.
 *
 * @param page The page to operate on.
 * @param ids The ids of the cells.
 * @returns The left edge for each id (rounded), or `null` if not found.
 */
async function readCellLefts(page: Page, ids: readonly string[]): Promise<(number | null)[]> {
  return page.evaluate((targets) => targets.map((id) => {
    const cell = document.getElementById(id);
    return cell === null ? null : Math.round(cell.getBoundingClientRect().left);
  }), ids);
}

test.describe('attaching the entry points', () => {
  test('creates a range with Shift+click and clears it with Escape even after document replacement', async ({ page }) => {
    await openEditor(page, '\n<p>x</p>\n');
    await replaceBody(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);

    await shiftClick(page, `${EDITOR_ROOT} #e`);
    const marked = await readMarkedTexts(page);
    await page.keyboard.press('Escape');

    expect([marked, await readMarkedTexts(page)]).toEqual([MARKED_A_TO_E, []]);
  });

  test('resets the range when the document is replaced while a range exists, and the query reports not in the range', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);
    // Keep a cell of the tree before replacement. If the range remained, this cell would be reported as in the range.
    const previousCell = await page.evaluateHandle(() => document.querySelector('#e'));

    await replaceBody(page, TABLE_BODY);

    const previousInRange = await previousCell.evaluate(
      (cell) => cell !== null && window.__cellMergeStateProbe?.(cell).range !== undefined,
    );
    expect([previousInRange, await readMergeRange(page, `${EDITOR_ROOT} #e`)]).toEqual([false, null]);
  });

  test('clears a range created after replacement when typing', async ({ page }) => {
    await openEditor(page, '\n<p>x</p>\n');
    await replaceBody(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);
    const marked = await readMarkedTexts(page);

    await page.keyboard.type('X');

    expect([marked, await readMarkedTexts(page)]).toEqual([MARKED_A_TO_E, []]);
  });
});

test.describe('selecting and clearing a cell range', () => {
  test('marks the cells of the rectangle of A and B when Shift+clicking cell B of the same table with the caret in cell A', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);

    await shiftClick(page, `${EDITOR_ROOT} #e`);

    expect(await readMarkedTexts(page)).toEqual(MARKED_A_TO_E);
  });

  test('collapses the selection to a caret at the original position in A and keeps focus on the editor root after the Shift+click that created the range', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);

    await shiftClick(page, `${EDITOR_ROOT} #e`);

    expect([await readCaret(page), await isCollapsed(page), await page.evaluate(() => document.activeElement?.id)])
      .toEqual([['ab', 1], true, EDITOR_ROOT_ELEMENT_ID]);
  });

  test('moves the marks to the cells of the new rectangle and removes them from cells only in the old one when Shift+clicking another cell while a range exists', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);

    await shiftClick(page, `${EDITOR_ROOT} #c`);

    expect(await readMarkedTexts(page)).toEqual(['ab', 'cd', 'ef']);
  });

  test('removes the marks, clears the range and moves the caret to the pressed position when pressing a cell without Shift while a range exists', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);

    await page.locator(`${EDITOR_ROOT} #i`).click();

    expect([await readMarkedTexts(page), await readMergeRange(page, `${EDITOR_ROOT} #a`), await isCaretInside(page, `${EDITOR_ROOT} #i`)])
      .toEqual([[], null, true]);
  });

  test('removes the marks and clears the range on Escape while a range exists', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);

    await page.keyboard.press('Escape');

    expect([await readMarkedTexts(page), await readMergeRange(page, `${EDITOR_ROOT} #a`)]).toEqual([[], null]);
  });

  test('does not forward an Escape that cleared the range to VS Code', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);
    await installForwardRecord(page);

    await page.keyboard.press('Escape');

    expect(await readForwardedKeys(page)).not.toContain('Escape');
  });

  test('inserts typed text at the caret at the anchor while a range exists', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);

    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe(TABLE_BODY.replace('>ab<', '>aXb<'));
  });

  test('removes the marks and clears the range when typing while a range exists', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);

    await page.keyboard.type('X');

    expect([await readMarkedTexts(page), await readMergeRange(page, `${EDITOR_ROOT} #e`)]).toEqual([[], null]);
  });

  test('forwards Escape to VS Code as before when there is no range', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await installForwardRecord(page);

    await page.keyboard.press('Escape');

    expect(await readForwardedKeys(page)).toContain('Escape');
  });

  test('closes only the popup and keeps the range on Escape with the block type popup opened by pointer, and clears the range on the next Escape', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);
    await page.locator(BLOCK_TYPE_ITEM).click();
    await expect(page.locator(BLOCK_TYPE_MENU)).toBeVisible();

    await page.keyboard.press('Escape');
    const afterFirst = [await page.locator(BLOCK_TYPE_MENU).count(), await readMarkedTexts(page)];
    await page.keyboard.press('Escape');

    expect([afterFirst, await readMarkedTexts(page)]).toEqual([[0, MARKED_A_TO_E], []]);
  });

  test('keeps the marks and reports the cell in the range when right-clicking a cell of the range while a range exists', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);

    await page.locator(`${EDITOR_ROOT} #d`).click({ button: 'right' });

    expect([await readMarkedTexts(page), await readMergeRange(page, `${EDITOR_ROOT} #d`)])
      .toEqual([MARKED_A_TO_E, { referenceCell: 'a', otherCell: 'e', mergeable: true }]);
  });

  test('keeps the marks when moving the caret to another cell with an arrow key while a range exists, and the next Shift+click uses that cell as the anchor cell', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 2);
    await shiftClick(page, `${EDITOR_ROOT} #e`);

    await page.keyboard.press('ArrowRight');
    const afterMove = [await isCaretInside(page, `${EDITOR_ROOT} #b`), await readMarkedTexts(page)];
    await shiftClick(page, `${EDITOR_ROOT} #i`);

    expect([afterMove, await readMergeRange(page, `${EDITOR_ROOT} #i`)])
      .toEqual([[true, MARKED_A_TO_E], { referenceCell: 'b', otherCell: 'i', mergeable: true }]);
  });

  test('creates no range and extends the selection by the browser default when Shift+clicking inside the anchor cell', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 0);

    await shiftClick(page, `${EDITOR_ROOT} #a`);

    expect([await readMarkedTexts(page), await isCollapsed(page)]).toEqual([[], false]);
  });

  test('creates no range and extends the selection by the browser default when Shift+clicking a cell with the anchor in a paragraph outside the table', async ({ page }) => {
    await openEditor(page, `\n<p id="p">xyz</p>${TABLE_BODY}`);
    await placeCaretInText(page, `${EDITOR_ROOT} #p`, 1);

    await shiftClick(page, `${EDITOR_ROOT} #e`);

    expect([await readMarkedTexts(page), await readSelectionEnds(page, `${EDITOR_ROOT} #p`, `${EDITOR_ROOT} #e`)])
      .toEqual([[], [true, true]]);
  });

  test('marks all cells of the grown rectangle when a colspan cell partly overlaps the two pressed cells', async ({ page }) => {
    await openEditor(
      page,
      '\n<table>\n<tbody>\n<tr><td id="a">ab</td><td id="b">cd</td><td id="c">ef</td></tr>\n'
      + '<tr><td id="d">gh</td><td id="e" colspan="2">ij</td></tr>\n</tbody>\n</table>\n',
    );
    await placeCaretInText(page, `${EDITOR_ROOT} #b`, 1);

    await shiftClick(page, `${EDITOR_ROOT} #d`);

    expect(await readMarkedTexts(page)).toEqual(['ab', 'cd', 'ef', 'gh', 'ij']);
  });

  test('creates a range with marks even for two cells spanning thead and tbody, and the query reports not mergeable', async ({ page }) => {
    await openEditor(
      page,
      '\n<table>\n<thead>\n<tr><th id="h">hh</th><th id="i">ii</th></tr>\n</thead>\n'
      + '<tbody>\n<tr><td id="a">ab</td><td id="b">cd</td></tr>\n</tbody>\n</table>\n',
    );
    await placeCaretInText(page, `${EDITOR_ROOT} #h`, 1);

    await shiftClick(page, `${EDITOR_ROOT} #b`);

    expect([await readMarkedTexts(page), await readMergeRange(page, `${EDITOR_ROOT} #b`)])
      .toEqual([['hh', 'ii', 'ab', 'cd'], { referenceCell: 'h', otherCell: 'b', mergeable: false }]);
  });

  test('does not toggle a details section when creating a range by Shift+clicking its marker inside a cell', async ({ page }) => {
    await openEditor(
      page,
      '\n<table>\n<tbody>\n<tr><td id="a">ab</td>'
      + '<td id="b"><details open=""><summary>tt</summary><p>body</p></details></td></tr>\n</tbody>\n</table>\n',
    );
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);

    // The marker area is at the start of the first line of the title.
    await page.locator(`${EDITOR_ROOT} #b summary`).click({ modifiers: ['Shift'], position: { x: 4, y: 4 } });

    expect([
      await page.locator(`${EDITOR_ROOT} #b details`).evaluate((element) => element.hasAttribute('open')),
      await readMarkedTexts(page),
    ]).toEqual([true, ['ab', 'ttbody']]);
  });

  test('creates a range and moves focus to the editor root when Shift+clicking with focus on a toolbar item, and the following Escape clears the range', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await page.keyboard.press('Alt+F10');
    await expect(page.locator(EDITOR_ROOT)).not.toBeFocused();

    await shiftClick(page, `${EDITOR_ROOT} #e`);
    const created = [await readMarkedTexts(page), await page.evaluate(() => document.activeElement?.id)];
    await page.keyboard.press('Escape');

    expect([created, await readMarkedTexts(page)]).toEqual([[MARKED_A_TO_E, EDITOR_ROOT_ELEMENT_ID], []]);
  });

  test('deletes only the character before the anchor on Backspace while a range exists, leaving the other cells of the range unchanged', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe(TABLE_BODY.replace('>ab<', '>b<'));
  });

  test('does not format the content of the other cells of the range when pressing the bold shortcut while a range exists', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);

    await page.keyboard.press('ControlOrMeta+KeyB');

    const others = await page.locator(`${EDITOR_ROOT} #b, ${EDITOR_ROOT} #d, ${EDITOR_ROOT} #e`)
      .evaluateAll((cells) => cells.map((cell) => cell.innerHTML));
    expect(others).toEqual(['cd', 'gh', 'ij']);
  });

  test('leaves no marked element in the editor root, including cells whose element name was replaced, when toggling the header row of the range while a range exists', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);

    await runTableCommand(page, { kind: 'toggleHeaderRow' }, `${EDITOR_ROOT} #a`);

    expect([await page.locator(`${EDITOR_ROOT} th`).count(), await readMarkedTexts(page)]).toEqual([3, []]);
  });

  test('does not show the mark attribute in the body output while a range exists', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);

    expect([await readMarkedTexts(page), await readSavedBody(page)]).toEqual([MARKED_A_TO_E, TABLE_BODY]);
  });

  test('sends no view edited, unsaved content or edit transaction to the host when creating a range with Shift+click and clearing it with Escape', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);

    await shiftClick(page, `${EDITOR_ROOT} #e`);
    await page.keyboard.press('Escape');
    await flushEditTransactions(page, 'table-merge-range');
    // Unsaved content is sent after the change tracker debounce, so wait until that time has passed before counting.
    await page.waitForTimeout(OUTPUT_DEBOUNCE_MS * 2);

    expect([
      await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.viewEdited),
      await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent),
      await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart),
      await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction),
    ]).toEqual([0, 0, 0, 0]);
  });

  test('does not show the mark attribute in the sent unsaved content or in the before and after full texts of the edit transaction when typing after creating a range', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);

    await page.keyboard.type('X');
    await expect.poll(async () => (await readUnsavedTexts(page)).length).toBeGreaterThan(0);
    await flushEditTransactions(page, 'table-merge-typing');

    const transactions = await readTransactions(page);
    const texts = [
      ...await readUnsavedTexts(page),
      ...transactions.flatMap((transaction) => [transaction.before.text, transaction.after.text]),
    ];
    expect([transactions.length, texts.filter((text) => text.includes(CELL_RANGE_MARK_NAME))]).toEqual([1, []]);
  });

  test('shows a 2px solid outline on marked cells whose color differs from the background in light, dark and high contrast themes', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);

    const drawn: { style: string; width: string; differsFromBackground: boolean }[] = [];
    for (const theme of THEMES) {
      await applyThemeVariables(page, theme);
      drawn.push(await readOutline(page.locator(`${EDITOR_ROOT} #e`), 'body'));
    }

    expect(drawn).toEqual(THEMES.map(() => ({ style: 'solid', width: '2px', differsFromBackground: true })));
  });

  test('shows the outline even on a marked cell whose style attribute sets a background color', async ({ page }) => {
    await openEditor(
      page,
      '\n<table>\n<tbody>\n<tr><td id="a">ab</td><td id="b" style="background-color: rgb(255, 255, 0)">cd</td></tr>\n'
      + '</tbody>\n</table>\n',
    );
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);

    await shiftClick(page, `${EDITOR_ROOT} #b`);

    expect(await readOutline(page.locator(`${EDITOR_ROOT} #b`), `${EDITOR_ROOT} #b`))
      .toEqual({ style: 'solid', width: '2px', differsFromBackground: true });
  });

  test('creates a range with marks by Shift+click in a table inside the body of a details section', async ({ page }) => {
    await openEditor(page, `\n<details open="">\n<summary>t</summary>${TABLE_BODY}</details>\n`);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);

    await shiftClick(page, `${EDITOR_ROOT} #e`);

    expect(await readMarkedTexts(page)).toEqual(MARKED_A_TO_E);
  });
});

test.describe('macOS userAgent', () => {
  test.use({ userAgent: MAC_USER_AGENT });

  test('keeps the marks and reports the cell in the range when Ctrl+clicking a cell of the range with a macOS userAgent', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);

    await page.locator(`${EDITOR_ROOT} #d`).click({ modifiers: ['Control'] });

    expect([await readMarkedTexts(page), await readMergeRange(page, `${EDITOR_ROOT} #d`)])
      .toEqual([MARKED_A_TO_E, { referenceCell: 'a', otherCell: 'e', mergeable: true }]);
  });
});

test.describe('merging cells', () => {
  test('delivers exactly one settled edit transaction when merging with the ends obtained by querying a Shift+click range', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);

    const changed = await mergeRange(page, `${EDITOR_ROOT} #e`);
    await flushEditTransactions(page, 'table-merge');

    const transactions = await readTransactions(page);
    expect([changed, transactions.map((transaction) => transaction.before.text)])
      .toEqual([true, [`${PROLOGUE}${TABLE_BODY}${EPILOGUE}`]]);
  });

  test('places the caret just before the first content of the merged cell when merging with the ends of the range', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);

    await mergeRange(page, `${EDITOR_ROOT} #e`);

    expect([await readCaret(page), await isCaretInside(page, `${EDITOR_ROOT} #a`)]).toEqual([['ab', 0], true]);
  });

  test('removes the marks and clears the range when merging with the ends of the range', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);

    await mergeRange(page, `${EDITOR_ROOT} #e`);

    expect([await readMarkedTexts(page), await readMergeRange(page, `${EDITOR_ROOT} #a`)]).toEqual([[], null]);
  });

  test('restores the table and cell contents from before the merge on undo', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);
    await mergeRange(page, `${EDITOR_ROOT} #e`);
    await flushEditTransactions(page, 'table-merge-before-undo');
    const merged = await readBodyHtml(page);

    await applyUndo(page, (await readTransactions(page))[0]);

    await expect.poll(() => readBodyHtml(page)).toBe(TABLE_BODY);
    expect(merged).not.toBe(TABLE_BODY);
  });

  test('leaves the text of untouched rows unchanged in the saved content of a merged table', async ({ page }) => {
    // Unquoted attributes change spelling when serialized. That spelling tells whether untouched rows keep their
    // original spelling. Adjacent rows whose spelling changes are rewritten as one segment, so a row whose spelling
    // does not change is placed between them.
    const untouchedLine = '<tr><td class=z>ij</td><td>kl</td></tr>';
    await openEditor(
      page,
      '\n<table>\n<tbody>\n<tr><td id=a class=x>ab</td><td id=b>cd</td></tr>\n<tr><td>ef</td><td>gh</td></tr>\n'
      + `${untouchedLine}\n</tbody>\n</table>\n`,
    );
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #b`);

    await mergeRange(page, `${EDITOR_ROOT} #b`);

    expect(await readSavedBody(page)).toBe(
      '\n<table>\n<tbody>\n<tr><td id="a" class="x" colspan="2">ab<br>cd</td></tr>\n<tr><td>ef</td><td>gh</td></tr>\n'
      + `${untouchedLine}\n</tbody>\n</table>\n`,
    );
  });

  test('creates neither gaps nor overlaps in real browser rendering when merging in a gapless table with rowspan and colspan', async ({ page }) => {
    await openEditor(
      page,
      '\n<table>\n<tbody>\n<tr><td id="a" rowspan="2">a</td><td id="b">b</td><td id="c">c</td></tr>\n'
      + '<tr><td id="d" colspan="2">d</td></tr>\n<tr><td id="e">e</td><td id="f">f</td><td id="g">g</td></tr>\n'
      + '</tbody>\n</table>\n',
    );
    await applyMeasurableTableStyle(page);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    const before = await readLayoutDefects(page);

    // Merge a rectangle next to the rowspan that includes the colspan, and a rectangle in the row below the colspan.
    const merged = [
      await mergeCells(page, `${EDITOR_ROOT} #b`, `${EDITOR_ROOT} #d`),
      await mergeCells(page, `${EDITOR_ROOT} #f`, `${EDITOR_ROOT} #g`),
    ];

    expect([merged, before, await readLayoutDefects(page)]).toEqual([
      [true, true],
      { overlaps: 0, uncoveredArea: 0 },
      { overlaps: 0, uncoveredArea: 0 },
    ]);
  });

  test('merges a range in a table inside the body of a details section the same as outside it', async ({ page }) => {
    const table = '<table>\n<tbody>\n<tr><td>ab</td><td>cd</td></tr>\n<tr><td>ef</td><td>gh</td></tr>\n</tbody>\n</table>';
    await openEditor(page, `\n${table}\n<details open="">\n<summary>t</summary>\n${table}\n</details>\n`);

    const results: string[] = [];
    for (const scope of [`${EDITOR_ROOT} > table`, `${EDITOR_ROOT} details > table`]) {
      await placeCaretInText(page, `${scope} tr:nth-child(1) > td:nth-child(1)`, 1);
      await shiftClick(page, `${scope} tr:nth-child(2) > td:nth-child(2)`);
      await mergeRange(page, `${scope} tr:nth-child(2) > td:nth-child(2)`);
      results.push(await page.locator(scope).evaluate((element) => element.outerHTML));
    }

    const expected = '<table>\n<tbody>\n<tr><td rowspan="2" colspan="2">ab<br>cd<br>ef<br>gh</td></tr>\n<tr></tr>\n'
      + '</tbody>\n</table>';
    expect(results).toEqual([expected, expected]);
  });
});

test.describe('splitting a cell', () => {
  /** A body holding only a table whose first row is a merged cell covering 2 columns. */
  const MERGED_BODY = '\n<table>\n<tbody>\n<tr><td id="a" colspan="2">ab</td></tr>\n'
    + '<tr><td>ef</td><td>gh</td></tr>\n</tbody>\n</table>\n';

  test('delivers exactly one settled edit transaction when splitting a merged cell', async ({ page }) => {
    await openEditor(page, MERGED_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);

    const changed = await runTableCommand(page, { kind: 'splitCell' }, `${EDITOR_ROOT} #a`);
    await flushEditTransactions(page, 'table-split');

    const transactions = await readTransactions(page);
    expect([changed, transactions.map((transaction) => transaction.before.text)])
      .toEqual([true, [`${PROLOGUE}${MERGED_BODY}${EPILOGUE}`]]);
  });

  test('keeps the caret at the same position as before the operation when splitting a merged cell', async ({ page }) => {
    await openEditor(page, MERGED_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);

    await runTableCommand(page, { kind: 'splitCell' }, `${EDITOR_ROOT} #a`);

    expect([await readCaret(page), await isCaretInside(page, `${EDITOR_ROOT} #a`)]).toEqual([['ab', 1], true]);
  });

  test('keeps the columns of the other cells and has neither gaps nor overlaps in real browser rendering when splitting a cell with rowspan and colspan', async ({ page }) => {
    await openEditor(
      page,
      '\n<table>\n<tbody>\n<tr><td id="x">x</td><td id="a" rowspan="2" colspan="2">a</td><td id="y">y</td></tr>\n'
      + '<tr><td id="p">p</td><td id="q">q</td></tr>\n'
      + '<tr><td id="r">r</td><td id="s">s</td><td id="t">t</td><td id="u">u</td></tr>\n</tbody>\n</table>\n',
    );
    await applyMeasurableTableStyle(page);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    const others = ['x', 'y', 'p', 'q', 'r', 's', 't', 'u'];
    const before = await readCellLefts(page, others);

    await runTableCommand(page, { kind: 'splitCell' }, `${EDITOR_ROOT} #a`);

    expect([await readCellLefts(page, others), await readLayoutDefects(page)])
      .toEqual([before, { overlaps: 0, uncoveredArea: 0 }]);
  });

  test('writes the new cells without whitespace in the row and leaves the text of untouched rows unchanged in the saved content of a split table', async ({ page }) => {
    // Unquoted attributes change spelling when serialized. That spelling tells whether untouched rows keep their
    // original spelling.
    const untouchedLine = '<tr><td class=z>ij</td><td>kl</td></tr>';
    await openEditor(
      page,
      '\n<table>\n<tbody>\n<tr><td id=a colspan=2>ab</td></tr>\n<tr><td>ef</td><td>gh</td></tr>\n'
      + `${untouchedLine}\n</tbody>\n</table>\n`,
    );
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);

    await runTableCommand(page, { kind: 'splitCell' }, `${EDITOR_ROOT} #a`);

    expect(await readSavedBody(page)).toBe(
      '\n<table>\n<tbody>\n<tr><td id="a">ab</td><td><br></td></tr>\n<tr><td>ef</td><td>gh</td></tr>\n'
      + `${untouchedLine}\n</tbody>\n</table>\n`,
    );
  });

  test('splits in a table inside the body of a details section the same as outside it', async ({ page }) => {
    const table = '<table>\n<tbody>\n<tr><td colspan="2">ab</td></tr>\n<tr><td>ef</td><td>gh</td></tr>\n</tbody>\n</table>';
    await openEditor(page, `\n${table}\n<details open="">\n<summary>t</summary>\n${table}\n</details>\n`);

    const results: string[] = [];
    for (const scope of [`${EDITOR_ROOT} > table`, `${EDITOR_ROOT} details > table`]) {
      await placeCaretInText(page, `${scope} tr:nth-child(1) > td:nth-child(1)`, 1);
      await runTableCommand(page, { kind: 'splitCell' }, `${scope} tr:nth-child(1) > td:nth-child(1)`);
      results.push(await page.locator(scope).evaluate((element) => element.outerHTML));
    }

    const expected = '<table>\n<tbody>\n<tr><td>ab</td><td><br></td></tr>\n<tr><td>ef</td><td>gh</td></tr>\n</tbody>\n</table>';
    expect(results).toEqual([expected, expected]);
  });
});

test.describe('merge and split query', () => {
  test('returns the anchor cell as the reference cell, the pressed cell as the other cell and mergeable when querying a cell of a Shift+click range', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);

    await shiftClick(page, `${EDITOR_ROOT} #e`);

    expect(await readMergeRange(page, `${EDITOR_ROOT} #d`)).toEqual({ referenceCell: 'a', otherCell: 'e', mergeable: true });
  });

  test('reports not in the range when querying a cell outside the range while a range exists', async ({ page }) => {
    await openEditor(page, TABLE_BODY);
    await placeCaretInText(page, `${EDITOR_ROOT} #a`, 1);
    await shiftClick(page, `${EDITOR_ROOT} #e`);

    expect([await readMergeRange(page, `${EDITOR_ROOT} #i`), await readMergeRange(page, `${EDITOR_ROOT} #d`)])
      .toEqual([null, { referenceCell: 'a', otherCell: 'e', mergeable: true }]);
  });
});
