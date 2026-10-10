import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  MESSAGE_CATALOG_ELEMENT_ID,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { CELL_RANGE_MARK_NAME, CELL_RANGE_MARK_NAMESPACE } from '../../webview/editing/cell-range';
import { COMMENT_POPUP_ELEMENT_ID } from '../../webview/ui/comment-popup';
import { EDITOR_ROOT, pressPrimaryShortcut, readBodyHtml } from './helpers/editing';
import {
  FIXTURE_DIRECTORY_URL,
  PROBE_BUNDLE_PATH,
  getOutboundMessages,
  openWebviewHost,
  sendToWebview,
} from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const POPUP = `#${COMMENT_POPUP_ELEMENT_ID}`;
const ENTRY_TEXT = `${POPUP} .comment-popup-entry`;
const REPLY_FIELD = `${POPUP} textarea[aria-label="${englishMessages['commentThread.replyField']}"]`;
const PARAGRAPH = `${EDITOR_ROOT} p`;
const COMMENT = `${EDITOR_ROOT} comment`;

// A paragraph with a bold word. The starting point for the cases that select "ol".
const BOLD_BODY = '<p>a <strong>bold</strong></p>';
// A closed collapsible section and the paragraph after it.
const CLOSED_DETAILS_BODY = '<details><summary>Title</summary>\n<p>Body</p>\n</details>\n<p>Next</p>';
// A paragraph with characters on both sides of a comment that has the annotated text cd and a body.
const COMMENT_BODY = '<p>ab<comment id="c">cd<comment-body>note</comment-body></comment>ef</p>';
// A thread with a human entry. The entry text is selected by dragging, so it has two words.
const HUMAN_THREAD = '<p>x<comment id="c">ab<comment-body data-author="human" '
  + 'data-updated="2026-01-01T00:00:00.000Z">hello world</comment-body></comment>y</p>';
// The document URI of a document assumed to live in docs under the fixture. Without this as the base, the relative
// image path does not point to the image.
const NESTED_DOCUMENT_URI = `${FIXTURE_DIRECTORY_URL}docs/page.html`;

/** One clipboard event that reached the bubbling phase on window. */
interface ClipboardRecord {
  /** The event type (copy or cut). */
  readonly type: string;
  /** Whether the default had been prevented when the event arrived. */
  readonly prevented: boolean;
  /** The HTML form written to the clipboard data when the event arrived. */
  readonly html: string;
  /** The text form written to the clipboard data when the event arrived. */
  readonly text: string;
  /**
   * The list of formats written to the clipboard data when the event arrived. Writing an empty string still lists the
   * format, so this tells whether anything was written.
   */
  readonly types: string[];
}

declare global {
  interface Window {
    /** The clipboard event record. Holds the copies and cuts that reached the bubbling phase on window, in arrival order. */
    __clipboardRecord?: ClipboardRecord[];
  }
}

/** A position. Omitting the child index makes it a position within the element itself. */
interface Point {
  readonly selector: string;
  readonly childIndex?: number;
  readonly offset: number;
}

/**
 * Creates a position.
 *
 * @param selector The element selector.
 * @param offset The offset.
 * @param childIndex For a position within text, the index of that text among the element's children.
 * @returns The position.
 */
function at(selector: string, offset: number, childIndex?: number): Point {
  return { selector, offset, childIndex };
}

/**
 * Embeds the English message catalog and then mounts the body. With messages left as keys, the popup fields cannot be
 * found by the names the user sees, and alert labels are not displayed.
 *
 * @param page The page to operate on.
 * @param body The body to mount.
 * @param documentUri The document URI. Empty means relative paths are not resolved.
 * @param resourceRootUri The resource root URI. Empty means relative paths are not resolved.
 */
async function openClipboardEditor(page: Page, body: string, documentUri = '', resourceRootUri = ''): Promise<void> {
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
    documentUri,
    resourceRootUri,
  });
}

/**
 * Selects between two positions. Moves focus to the editor root first.
 *
 * @param page The page to operate on.
 * @param start The start.
 * @param end The end.
 */
async function selectRange(page: Page, start: Point, end: Point): Promise<void> {
  await page.evaluate((argument) => {
    const readNode = (point: { selector: string; childIndex?: number }): Node => {
      const element = document.querySelector(point.selector);
      const node = point.childIndex === undefined ? element : element?.childNodes[point.childIndex];
      if (node === null || node === undefined) {
        throw new Error(`No node: ${point.selector}`);
      }
      return node;
    };
    document.getElementById(argument.rootId)?.focus();
    const range = document.createRange();
    range.setStart(readNode(argument.start), argument.start.offset);
    range.setEnd(readNode(argument.end), argument.end.offset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { start, end, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Places the caret. Moves focus to the editor root first.
 *
 * @param page The page to operate on.
 * @param point The caret position.
 */
async function placeCaretAt(page: Page, point: Point): Promise<void> {
  await selectRange(page, point, point);
}

/**
 * Selects from a position to the end of body, outside the editor root. Moves focus to the editor root first.
 *
 * @param page The page to operate on.
 * @param start The start.
 */
async function selectToOutside(page: Page, start: Point): Promise<void> {
  await page.evaluate((argument) => {
    const element = document.querySelector(argument.start.selector);
    const node = element?.childNodes[argument.start.childIndex ?? 0];
    if (node === undefined) {
      throw new Error(`No node: ${argument.start.selector}`);
    }
    document.getElementById(argument.rootId)?.focus();
    const range = document.createRange();
    range.setStart(node, argument.start.offset);
    range.setEnd(document.body, document.body.childNodes.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { start, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Starts recording the copies and cuts that reach the bubbling phase on window. Records, per event, what the editor
 * root listeners wrote and whether the default was prevented.
 *
 * @param page The page to operate on.
 */
async function installClipboardRecord(page: Page): Promise<void> {
  await page.evaluate(() => {
    const record: ClipboardRecord[] = [];
    window.__clipboardRecord = record;
    const listener = (event: ClipboardEvent): void => {
      record.push({
        type: event.type,
        prevented: event.defaultPrevented,
        html: event.clipboardData?.getData('text/html') ?? '',
        text: event.clipboardData?.getData('text/plain') ?? '',
        types: [...(event.clipboardData?.types ?? [])],
      });
    };
    window.addEventListener('copy', listener);
    window.addEventListener('cut', listener);
  });
}

/**
 * Reads the clipboard event record.
 *
 * @param page The page to operate on.
 * @returns The events that arrived.
 */
async function readClipboardRecord(page: Page): Promise<ClipboardRecord[]> {
  return page.evaluate(() => window.__clipboardRecord ?? []);
}

/**
 * Returns the number of messages of the given type sent to the host.
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
 * Calls the replacement entry point to replace the body.
 *
 * @param page The page to operate on.
 * @param body The new body.
 */
async function replaceDocument(page: Page, body: string): Promise<void> {
  await page.evaluate((text) => window.__documentReplacementProbe?.(text), `${PROLOGUE}${body}${EPILOGUE}`);
}

/**
 * Reads the body output.
 *
 * @param page The page to operate on.
 * @returns The body of the body output. Empty before mounting.
 */
async function readBodyOutput(page: Page): Promise<string> {
  return page.evaluate(() => window.__serializationProbe?.()?.body ?? '');
}

/**
 * Reads the contents of the editor root and the selection endpoints.
 *
 * The selection text is not compared. The text of a selection over a closed collapsible section varies with whether
 * the selection has been rendered.
 *
 * @param page The page to operate on.
 * @returns The editor root's `innerHTML`, and the text and offset of the selection's anchor and focus nodes.
 */
async function readTreeAndSelection(page: Page): Promise<unknown[]> {
  return page.evaluate((rootId) => {
    const selection = window.getSelection();
    return [
      document.getElementById(rootId)?.innerHTML,
      selection?.anchorNode?.textContent,
      selection?.anchorOffset,
      selection?.focusNode?.textContent,
      selection?.focusOffset,
    ];
  }, EDITOR_ROOT_ELEMENT_ID);
}

/**
 * Clicks the annotated text to open the popup. Focus stays in the editor root.
 *
 * @param page The page to operate on.
 */
async function openByClick(page: Page): Promise<void> {
  await page.locator(COMMENT).first().click({ position: { x: 2, y: 5 } });
  await expect(page.locator(POPUP)).toBeVisible();
}

/**
 * Drags across an element's characters, from just inside the left edge of the first character to just inside the right
 * edge of the last.
 *
 * Dragging past the characters selects up to the boundary of the following section.
 *
 * @param page The page to operate on.
 * @param selector The element selector.
 */
async function dragAcross(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right, middle: (rect.top + rect.bottom) / 2 };
  });
  await page.mouse.move(box.left + 1, box.middle);
  await page.mouse.down();
  await page.mouse.move(box.right - 1, box.middle, { steps: 8 });
  await page.mouse.up();
}

/**
 * Reads the number of elements in the editor root that have the cell range mark.
 *
 * @param page The page to operate on.
 * @returns The number of elements with the mark.
 */
async function countCellRangeMarks(page: Page): Promise<number> {
  return page.evaluate((argument) => [...document.querySelectorAll(`#${argument.rootId} *`)]
    .filter((element) => element.hasAttributeNS(argument.namespace, argument.name)).length, {
    rootId: EDITOR_ROOT_ELEMENT_ID,
    namespace: CELL_RANGE_MARK_NAMESPACE,
    name: CELL_RANGE_MARK_NAME,
  });
}

test.describe('entry point registration', () => {
  test('selecting part of a bold word and pressing Ctrl+C after replacing the document prevents the default and makes the HTML form <strong>ol</strong>', async ({ page }) => {
    await openClipboardEditor(page, '<p>xyz</p>');
    await replaceDocument(page, BOLD_BODY);
    await installClipboardRecord(page);
    await selectRange(page, at(`${EDITOR_ROOT} strong`, 1, 0), at(`${EDITOR_ROOT} strong`, 3, 0));

    await pressPrimaryShortcut(page, 'C');

    expect((await readClipboardRecord(page)).map((entry) => [entry.prevented, entry.html]))
      .toEqual([[true, '<strong>ol</strong>']]);
  });

  test('selecting a word in a paragraph and pressing Ctrl+X after replacing the document deletes the word and sends one edit transaction', async ({ page }) => {
    await openClipboardEditor(page, '<p>xyz</p>');
    await replaceDocument(page, '<p>one two three</p>');
    await selectRange(page, at(PARAGRAPH, 4, 0), at(PARAGRAPH, 8, 0));

    await pressPrimaryShortcut(page, 'X');

    await expect.poll(() => countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).toBe(1);
    expect(await readBodyHtml(page)).toBe('<p>one three</p>');
  });
});

test.describe('handling copy', () => {
  test('pressing Ctrl+C on "ol" in <p>a <strong>bold</strong></p> prevents the default, with the HTML form <strong>ol</strong> and the text form ol', async ({ page }) => {
    await openClipboardEditor(page, BOLD_BODY);
    await installClipboardRecord(page);
    await selectRange(page, at(`${EDITOR_ROOT} strong`, 1, 0), at(`${EDITOR_ROOT} strong`, 3, 0));

    await pressPrimaryShortcut(page, 'C');

    expect(await readClipboardRecord(page)).toEqual([
      { type: 'copy', prevented: true, html: '<strong>ol</strong>', text: 'ol', types: ['text/html', 'text/plain'] },
    ]);
  });

  test('after Ctrl+C, the editor root tree and the selection are unchanged and no edit transaction is sent', async ({ page }) => {
    await openClipboardEditor(page, `${COMMENT_BODY}\n${CLOSED_DETAILS_BODY}`);
    await selectRange(page, at(COMMENT, 1, 0), at(`${EDITOR_ROOT} details + p`, 2, 0));
    const before = await readTreeAndSelection(page);

    await pressPrimaryShortcut(page, 'C');

    expect([await readTreeAndSelection(page), await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)])
      .toEqual([before, 0]);
  });

  test('pressing Ctrl+C with only a caret does not prevent the default, and this feature writes no HTML form', async ({ page }) => {
    await openClipboardEditor(page, BOLD_BODY);
    await installClipboardRecord(page);
    await placeCaretAt(page, at(`${EDITOR_ROOT} strong`, 2, 0));

    await pressPrimaryShortcut(page, 'C');

    expect((await readClipboardRecord(page)).map((entry) => [entry.prevented, entry.html])).toEqual([[false, '']]);
  });

  test('selecting from a paragraph in the editor root to a position outside it and pressing Ctrl+C does not prevent the default', async ({ page }) => {
    await openClipboardEditor(page, '<p>abcd</p>');
    await installClipboardRecord(page);
    await selectToOutside(page, at(PARAGRAPH, 1, 0));

    await pressPrimaryShortcut(page, 'C');

    expect((await readClipboardRecord(page)).map((entry) => entry.prevented)).toEqual([false]);
  });

  test('dragging to select entry text in the popup and pressing Ctrl+C does not prevent the default, and this feature writes no HTML form', async ({ page }) => {
    await openClipboardEditor(page, HUMAN_THREAD);
    await openByClick(page);
    await installClipboardRecord(page);
    await dragAcross(page, ENTRY_TEXT);

    await pressPrimaryShortcut(page, 'C');

    expect((await readClipboardRecord(page)).map((entry) => [entry.prevented, entry.html])).toEqual([[false, '']]);
  });
});

test.describe('handling cut', () => {
  test('pressing Ctrl+X on "ol" turns the paragraph into <p>a <strong>bd</strong></p>, with the HTML form <strong>ol</strong> and the text form ol', async ({ page }) => {
    await openClipboardEditor(page, BOLD_BODY);
    await installClipboardRecord(page);
    await selectRange(page, at(`${EDITOR_ROOT} strong`, 1, 0), at(`${EDITOR_ROOT} strong`, 3, 0));

    await pressPrimaryShortcut(page, 'X');

    expect([await readBodyHtml(page), await readClipboardRecord(page)]).toEqual([
      '<p>a <strong>bd</strong></p>',
      [{ type: 'cut', prevented: true, html: '<strong>ol</strong>', text: 'ol', types: ['text/html', 'text/plain'] }],
    ]);
  });

  test('Ctrl+X on a range spanning two paragraphs also sends one edit transaction', async ({ page }) => {
    await openClipboardEditor(page, '<p>ab</p>\n<p>cd</p>');
    await selectRange(page, at(PARAGRAPH, 1, 0), at(`${EDITOR_ROOT} p + p`, 1, 0));

    await pressPrimaryShortcut(page, 'X');

    await expect.poll(() => countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).toBe(1);
  });

  test('typing after Ctrl+X inserts at the start of the deleted range', async ({ page }) => {
    await openClipboardEditor(page, '<p>abcd</p>');
    await selectRange(page, at(PARAGRAPH, 1, 0), at(PARAGRAPH, 3, 0));
    await pressPrimaryShortcut(page, 'X');

    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe('<p>aXd</p>');
  });

  test('Ctrl+X on a range covering only part of a comment keeps the entries, and the HTML form contains neither comment nor entries', async ({ page }) => {
    await openClipboardEditor(page, COMMENT_BODY);
    await installClipboardRecord(page);
    await selectRange(page, at(COMMENT, 1, 0), at(PARAGRAPH, 1, 2));

    await pressPrimaryShortcut(page, 'X');

    expect([
      await page.locator(`${COMMENT} comment-body`).textContent(),
      (await readClipboardRecord(page)).map((entry) => entry.html),
    ]).toEqual(['note', ['de']]);
  });

  test('Ctrl+X on a range wholly containing a comment deletes the comment with its entries, and the HTML form contains only the annotated text', async ({ page }) => {
    await openClipboardEditor(page, COMMENT_BODY);
    await installClipboardRecord(page);
    await selectRange(page, at(PARAGRAPH, 1, 0), at(PARAGRAPH, 1, 2));

    await pressPrimaryShortcut(page, 'X');

    expect([await readBodyHtml(page), (await readClipboardRecord(page)).map((entry) => entry.html)])
      .toEqual(['<p>af</p>', ['bcde']]);
  });

  test('Ctrl+X from the middle of the title of a closed collapsible section to the middle of the following paragraph keeps the body, and the HTML form is a collapsible section without a body plus the paragraph', async ({ page }) => {
    await openClipboardEditor(page, CLOSED_DETAILS_BODY);
    await installClipboardRecord(page);
    await selectRange(page, at(`${EDITOR_ROOT} summary`, 2, 0), at(`${EDITOR_ROOT} details + p`, 2, 0));

    await pressPrimaryShortcut(page, 'X');

    expect([
      await page.locator(`${EDITOR_ROOT} details p`).textContent(),
      (await readClipboardRecord(page)).map((entry) => entry.html),
    ]).toEqual(['Body', ['<details><summary>tle</summary></details>\n<p>Ne</p>']]);
  });

  test('Ctrl+X from the middle of the title of an open collapsible section to the middle of a body paragraph keeps the title and the body paragraph separate, and the HTML form is wrapped in an open collapsible section', async ({ page }) => {
    await openClipboardEditor(page, '<details open=""><summary>Title</summary>\n<p>Body</p>\n</details>');
    await installClipboardRecord(page);
    await selectRange(page, at(`${EDITOR_ROOT} summary`, 2, 0), at(`${EDITOR_ROOT} details p`, 2, 0));

    await pressPrimaryShortcut(page, 'X');

    expect([
      await page.locator(`${EDITOR_ROOT} summary`).textContent(),
      await page.locator(`${EDITOR_ROOT} details p`).textContent(),
      (await readClipboardRecord(page)).map((entry) => entry.html),
    ]).toEqual(['Ti', 'dy', ['<details open=""><summary>tle</summary>\n<p>Bo</p></details>']]);
  });

  test('Ctrl+X from the paragraph before a table to the middle of a cell keeps the table skeleton, and the HTML form is the paragraph part plus a table of the covered row and cell', async ({ page }) => {
    await openClipboardEditor(page, '<p>ab</p>\n<table><tbody><tr><td>cd</td><td>ef</td></tr></tbody></table>');
    await installClipboardRecord(page);
    await selectRange(page, at(PARAGRAPH, 1, 0), at(`${EDITOR_ROOT} td`, 1, 0));

    await pressPrimaryShortcut(page, 'X');

    expect([
      await page.locator(`${EDITOR_ROOT} table tr > td`).count(),
      (await readClipboardRecord(page)).map((entry) => entry.html),
    ]).toEqual([2, ['<p>b</p>\n<table><tbody><tr><td>c</td></tr></tbody></table>']]);
  });

  test('Ctrl+X from the middle of the second list item to the middle of the third merges the two items into one, and the HTML form is a two-item list', async ({ page }) => {
    await openClipboardEditor(page, '<ul><li>a</li><li>bc</li><li>de</li></ul>');
    await installClipboardRecord(page);
    await selectRange(page, at(`${EDITOR_ROOT} li + li`, 1, 0), at(`${EDITOR_ROOT} li + li + li`, 1, 0));

    await pressPrimaryShortcut(page, 'X');

    expect([
      await page.locator(`${EDITOR_ROOT} li`).allTextContents(),
      (await readClipboardRecord(page)).map((entry) => entry.html),
    ]).toEqual([['a', 'be'], ['<ul><li>c</li><li>d</li></ul>']]);
  });

  test('Ctrl+X on a selection from the end of a paragraph to the start of a following list item prevents the default, leaves the tree unchanged, and writes neither form', async ({ page }) => {
    const body = '<p>abc</p>\n<ul><li>def</li></ul>';
    await openClipboardEditor(page, body);
    await installClipboardRecord(page);
    await selectRange(page, at(PARAGRAPH, 3, 0), at(`${EDITOR_ROOT} li`, 0, 0));

    await pressPrimaryShortcut(page, 'X');

    expect([await readBodyHtml(page), (await readClipboardRecord(page)).map((entry) => [entry.prevented, entry.types])])
      .toEqual([body, [[true, []]]]);
  });

  test('pressing Ctrl+X with only a caret leaves the tree unchanged and sends no edit transaction', async ({ page }) => {
    await openClipboardEditor(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await pressPrimaryShortcut(page, 'X');

    expect([await readBodyHtml(page), await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)])
      .toEqual(['<p>abcd</p>', 0]);
  });

  test('selecting from a paragraph in the editor root to a position outside it and pressing Ctrl+X does not prevent the default and leaves the tree unchanged', async ({ page }) => {
    await openClipboardEditor(page, '<p>abcd</p>');
    await installClipboardRecord(page);
    await selectToOutside(page, at(PARAGRAPH, 1, 0));

    await pressPrimaryShortcut(page, 'X');

    expect([(await readClipboardRecord(page)).map((entry) => entry.prevented), await readBodyHtml(page)])
      .toEqual([[false], '<p>abcd</p>']);
  });

  test('selecting characters in a popup field and pressing Ctrl+X deletes them from the field by the default cut and leaves the editor root tree unchanged', async ({ page }) => {
    await openClipboardEditor(page, HUMAN_THREAD);
    await openByClick(page);
    await page.locator(REPLY_FIELD).click();
    await page.keyboard.type('abc');
    await page.locator(REPLY_FIELD).evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(0, 2));
    const before = await readBodyHtml(page);

    await pressPrimaryShortcut(page, 'X');

    expect([await page.locator(REPLY_FIELD).inputValue(), await readBodyHtml(page)]).toEqual(['c', before]);
  });
});

test.describe('extracting the range', () => {
  test('Ctrl+C on a range spanning the second and third list items makes the HTML form a list of those two items', async ({ page }) => {
    await openClipboardEditor(page, '<ul><li>a</li><li>b</li><li>c</li></ul>');
    await installClipboardRecord(page);
    await selectRange(page, at(`${EDITOR_ROOT} li + li`, 0, 0), at(`${EDITOR_ROOT} li + li + li`, 1, 0));

    await pressPrimaryShortcut(page, 'C');

    expect((await readClipboardRecord(page)).map((entry) => entry.html)).toEqual(['<ul><li>b</li><li>c</li></ul>']);
  });

  test('Ctrl+C on a range spanning two cells in the same row makes the HTML form the two cells wrapped in a table and row', async ({ page }) => {
    await openClipboardEditor(page, '<table><tbody><tr><td>ab</td><td>cd</td></tr></tbody></table>');
    await installClipboardRecord(page);
    await selectRange(page, at(`${EDITOR_ROOT} td`, 1, 0), at(`${EDITOR_ROOT} td + td`, 1, 0));

    await pressPrimaryShortcut(page, 'C');

    expect((await readClipboardRecord(page)).map((entry) => entry.html))
      .toEqual(['<table><tbody><tr><td>b</td><td>c</td></tr></tbody></table>']);
  });

  test('Ctrl+C from the middle of a body paragraph of an open collapsible section to the middle of the following paragraph makes the HTML form a collapsible section with the body part plus the paragraph part', async ({ page }) => {
    await openClipboardEditor(page, CLOSED_DETAILS_BODY.replace('<details>', '<details open="">'));
    await installClipboardRecord(page);
    await selectRange(page, at(`${EDITOR_ROOT} details p`, 2, 0), at(`${EDITOR_ROOT} details + p`, 2, 0));

    await pressPrimaryShortcut(page, 'C');

    expect((await readClipboardRecord(page)).map((entry) => entry.html))
      .toEqual(['<details open=""><p>dy</p>\n</details>\n<p>Ne</p>']);
  });
});

test.describe('removing annotations', () => {
  test('Ctrl+C on a sentence containing a comment leaves no comment or entries in the HTML form while keeping the annotated text formatting, and no entry text in the text form', async ({ page }) => {
    await openClipboardEditor(page, '<p>ab<comment id="c"><em>cd</em>e<comment-body>note</comment-body></comment>fg</p>');
    await installClipboardRecord(page);
    await selectRange(page, at(PARAGRAPH, 0, 0), at(PARAGRAPH, 2, 2));

    await pressPrimaryShortcut(page, 'C');

    expect((await readClipboardRecord(page)).map((entry) => [entry.html, entry.text]))
      .toEqual([['ab<em>cd</em>efg', 'abcdefg']]);
  });

  test('Ctrl+C on a range starting in the middle of annotated text puts only the covered part of the annotated text into the HTML form', async ({ page }) => {
    await openClipboardEditor(page, COMMENT_BODY);
    await installClipboardRecord(page);
    await selectRange(page, at(COMMENT, 1, 0), at(PARAGRAPH, 1, 2));

    await pressPrimaryShortcut(page, 'C');

    expect((await readClipboardRecord(page)).map((entry) => entry.html)).toEqual(['de']);
  });
});

test.describe('excluding closed collapsible section bodies', () => {
  test('Ctrl+C from the middle of the title of a closed collapsible section to the middle of the following paragraph puts the body in neither form', async ({ page }) => {
    await openClipboardEditor(page, CLOSED_DETAILS_BODY);
    await installClipboardRecord(page);
    await selectRange(page, at(`${EDITOR_ROOT} summary`, 2, 0), at(`${EDITOR_ROOT} details + p`, 2, 0));

    await pressPrimaryShortcut(page, 'C');

    expect((await readClipboardRecord(page)).map((entry) => [entry.html.includes('Body'), entry.text.includes('Body')]))
      .toEqual([[false, false]]);
  });
});

test.describe('removing boundary empty blocks', () => {
  test('Ctrl+C on a selection from the end of paragraph A to the start of paragraph C makes the HTML form just <p>B</p>', async ({ page }) => {
    await openClipboardEditor(page, '<p>A</p>\n<p>B</p>\n<p>C</p>');
    await installClipboardRecord(page);
    await selectRange(page, at(PARAGRAPH, 1, 0), at(`${EDITOR_ROOT} p + p + p`, 0, 0));

    await pressPrimaryShortcut(page, 'C');

    expect((await readClipboardRecord(page)).map((entry) => entry.html)).toEqual(['<p>B</p>']);
  });

  test('Ctrl+C on a selection from the end of the paragraph right before a table to the end of its last cell leaves no empty paragraph in the HTML form and keeps the col elements with column widths', async ({ page }) => {
    const table = '<table><colgroup><col style="width: 40%;"><col style="width: 60%;"></colgroup>'
      + '<tbody><tr><td>cd</td><td>ef</td></tr></tbody></table>';
    await openClipboardEditor(page, `<p>ab</p>\n${table}`);
    await installClipboardRecord(page);
    await selectRange(page, at(PARAGRAPH, 2, 0), at(`${EDITOR_ROOT} td + td`, 2, 0));

    await pressPrimaryShortcut(page, 'C');

    expect((await readClipboardRecord(page)).map((entry) => entry.html)).toEqual([table]);
  });
});

test.describe('finishing', () => {
  test('with the document URI in a directory other than the fixture, Ctrl+C on a paragraph containing a relative-path image puts the author-written relative path in the src of the HTML form', async ({ page }) => {
    await openClipboardEditor(page, '<p>a<img src="../sample.png" alt="s">b</p>', NESTED_DOCUMENT_URI, FIXTURE_DIRECTORY_URL);
    await installClipboardRecord(page);
    await selectRange(page, at(PARAGRAPH, 0), at(PARAGRAPH, 3));

    await pressPrimaryShortcut(page, 'C');

    // Also check that the tree holds the src resolved for display. If it were not resolved, there would be no way to
    // tell whether it was restored.
    expect([
      await page.locator(`${EDITOR_ROOT} img`).getAttribute('src'),
      (await readClipboardRecord(page)).map((entry) => entry.html),
    ]).toEqual([`${FIXTURE_DIRECTORY_URL}sample.png`, ['a<img src="../sample.png" alt="s">b']]);
  });

  test('Ctrl+C from a paragraph with onclick to the next paragraph leaves neither onclick nor internal attributes in the HTML form, while the body output keeps onclick', async ({ page }) => {
    await openClipboardEditor(page, '<p onclick="alert(1)">ab</p>\n<p>cd</p>');
    await installClipboardRecord(page);
    await selectRange(page, at(PARAGRAPH, 1, 0), at(`${EDITOR_ROOT} p + p`, 1, 0));

    await pressPrimaryShortcut(page, 'C');

    expect([
      (await readClipboardRecord(page)).map((entry) => entry.html),
      (await readBodyOutput(page)).includes('<p onclick="alert(1)">ab</p>'),
    ]).toEqual([['<p>b</p>\n<p>c</p>'], true]);
  });

  test('pressing Ctrl+A and Ctrl+C while a cell range exists leaves no cell range mark in the HTML form', async ({ page }) => {
    const table = '<table><tbody><tr><td id="a">ab</td><td id="b">cd</td></tr></tbody></table>';
    await openClipboardEditor(page, table);
    await placeCaretAt(page, at(`${EDITOR_ROOT} #a`, 1, 0));
    await page.locator(`${EDITOR_ROOT} #b`).click({ modifiers: ['Shift'] });
    await installClipboardRecord(page);

    await pressPrimaryShortcut(page, 'A');
    await pressPrimaryShortcut(page, 'C');

    // Also check that the marks remain in the tree. If they were gone, there would be no way to tell whether they were
    // dropped from the copy content.
    expect([await countCellRangeMarks(page), (await readClipboardRecord(page)).map((entry) => entry.html)])
      .toEqual([2, [table]]);
  });
});

test.describe('writing the copy content', () => {
  test('Ctrl+C on a selection from a heading to the next paragraph makes the HTML form only the elements and author-written attributes, without style attributes or formatting spans', async ({ page }) => {
    const body = '<h2 id="t">Title</h2>\n<p class="c">Body</p>';
    await openClipboardEditor(page, body);
    await installClipboardRecord(page);
    await selectRange(page, at(`${EDITOR_ROOT} h2`, 0, 0), at(PARAGRAPH, 4, 0));

    await pressPrimaryShortcut(page, 'C');

    expect((await readClipboardRecord(page)).map((entry) => entry.html)).toEqual([body]);
  });

  test('Ctrl+C on a word selected inside an alert blockquote puts the label message in neither form', async ({ page }) => {
    await openClipboardEditor(page, '<blockquote data-alert="note"><p>Hello world</p></blockquote>');
    await installClipboardRecord(page);
    await selectRange(page, at(PARAGRAPH, 6, 0), at(PARAGRAPH, 11, 0));

    await pressPrimaryShortcut(page, 'C');

    // Also check that the label is displayed. If it were not, there would be no way to tell that it is left out.
    expect([
      await page.locator(`${EDITOR_ROOT} blockquote`).evaluate((quote) => getComputedStyle(quote, '::after').content),
      (await readClipboardRecord(page)).map((entry) => [entry.html, entry.text]),
    ]).toEqual([`"${englishMessages['alert.note']}"`, [['world', 'world']]]);
  });

  test('Ctrl+C on a selection from the preceding paragraph into an alert blockquote puts the label message in neither form', async ({ page }) => {
    await openClipboardEditor(page, '<p>ab</p>\n<blockquote data-alert="note"><p>Hello</p></blockquote>');
    await installClipboardRecord(page);
    await selectRange(page, at(PARAGRAPH, 1, 0), at(`${EDITOR_ROOT} blockquote p`, 2, 0));

    await pressPrimaryShortcut(page, 'C');

    expect((await readClipboardRecord(page)).map((entry) => [entry.html, entry.text.includes(englishMessages['alert.note'])]))
      .toEqual([['<p>b</p>\n<blockquote data-alert="note"><p>He</p></blockquote>', false]]);
  });
});
