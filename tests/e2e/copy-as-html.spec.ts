import { expect, test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';

import {
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  MESSAGE_CATALOG_ELEMENT_ID,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { CELL_RANGE_MARK_NAME, CELL_RANGE_MARK_NAMESPACE } from '../../webview/editing/cell-range';
import { COMMENT_POPUP_ELEMENT_ID } from '../../webview/ui/comment-popup';
import { COPIED_ICON_PATH, COPIED_ICON_TIMEOUT_MS, COPY_ICON_PATH } from '../../webview/ui/copy-button';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import { BLANK_OVERLAY_CONTENT } from '../../webview/ui/overlay-presenter';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { EDITOR_ROOT } from './helpers/editing';
import {
  PROBE_BUNDLE_PATH,
  getOutboundMessages,
  openWebviewHost,
  sendToWebview,
  setSendFailureTypes,
} from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const COPY_ITEM = `#${TOOLBAR_ELEMENT_ID} [data-slot="${TOOLBAR_SLOT.copy}"] button`;
const COPY_ICON = `${COPY_ITEM} svg path`;
const POPUP = `#${COMMENT_POPUP_ELEMENT_ID}`;
const ENTRY_TEXT = `${POPUP} .comment-popup-entry`;
const PARAGRAPH = `${EDITOR_ROOT} p`;
const COMMENT = `${EDITOR_ROOT} comment`;

// A paragraph containing a bold word. The starting point for selecting "ol".
const BOLD_BODY = '<p>a <strong>bold</strong></p>';
// A closed collapsible section followed by a paragraph.
const CLOSED_DETAILS_BODY = '<details><summary>Title</summary>\n<p>Body</p>\n</details>\n<p>Next</p>';
// A paragraph with text on both sides of a comment that has the annotated text cd and a body.
const COMMENT_BODY = '<p>ab<comment id="c">cd<comment-body>note</comment-body></comment>ef</p>';
// A thread with a human entry. The entry text is selected by dragging, so it has two words.
const HUMAN_THREAD = '<p>x<comment id="c">ab<comment-body data-author="human" '
  + 'data-updated="2026-01-01T00:00:00.000Z">hello world</comment-body></comment>y</p>';

/** A position. When the child index is omitted, it is a position inside the element itself. */
interface Point {
  readonly selector: string;
  readonly childIndex?: number;
  readonly offset: number;
}

/**
 * Creates a position.
 *
 * @param selector The element's selector.
 * @param offset The offset.
 * @param childIndex For a position inside text, which child of the element that text is.
 */
function at(selector: string, offset: number, childIndex?: number): Point {
  return { selector, offset, childIndex };
}

/**
 * Embeds the English message catalog and then mounts the body.
 *
 * @param page The page to operate on.
 * @param body The body to mount.
 */
async function openCopyEditor(page: Page, body: string): Promise<void> {
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
        throw new Error(`no node: ${point.selector}`);
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
    const node = document.querySelector(argument.start.selector)?.childNodes[argument.start.childIndex ?? 0];
    if (node === undefined) {
      throw new Error(`no node: ${argument.start.selector}`);
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
 * Injects a request copy HTML message as though it arrived from the host.
 *
 * @param page The page to operate on.
 * @param requestId The request id.
 */
async function requestCopyHtml(page: Page, requestId: string): Promise<void> {
  await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestCopyHtml, requestId });
}

/**
 * Returns the messages of the given type sent to the host, in the order sent.
 *
 * @param page The page to operate on.
 * @param type The message type.
 */
async function readMessages(page: Page, type: string): Promise<object[]> {
  return (await getOutboundMessages(page)).filter((message): message is object => (
    typeof message === 'object' && message !== null && Reflect.get(message, 'type') === type
  ));
}

/**
 * Returns the html of the copy HTML responses sent to the host, in the order sent.
 *
 * @param page The page to operate on.
 */
async function readResponseHtmls(page: Page): Promise<unknown[]> {
  return (await readMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.copyHtmlResponse))
    .map((message) => Reflect.get(message, 'html'));
}

/**
 * Reads the contents of the editor root and the anchor and focus of the selection.
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
 * Drags across the element's text, from just inside the left edge of the first character to just inside the right
 * edge of the last.
 *
 * @param page The page to operate on.
 * @param selector The element's selector.
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
 * Reads the number of elements in the editor root that carry the cell range mark.
 *
 * @param page The page to operate on.
 */
async function countCellRangeMarks(page: Page): Promise<number> {
  return page.evaluate((argument) => [...document.querySelectorAll(`#${argument.rootId} *`)]
    .filter((element) => element.hasAttributeNS(argument.namespace, argument.name)).length, {
    rootId: EDITOR_ROOT_ELEMENT_ID,
    namespace: CELL_RANGE_MARK_NAMESPACE,
    name: CELL_RANGE_MARK_NAME,
  });
}

/** Opens a channel that drives the browser's IME. */
async function openImeSession(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

test.describe('the toolbar copy button', () => {
  test('pressing the copy button sends exactly one copy request carrying only the type, and no message carries HTML', async ({ page }) => {
    await openCopyEditor(page, BOLD_BODY);
    await selectRange(page, at(`${EDITOR_ROOT} strong`, 1, 0), at(`${EDITOR_ROOT} strong`, 3, 0));
    const sentBefore = (await getOutboundMessages(page)).length;

    await page.locator(COPY_ITEM).click();

    expect((await getOutboundMessages(page)).slice(sentBefore))
      .toEqual([{ type: VIEW_TO_HOST_MESSAGE_TYPE.copyRequested }]);
  });

  test('pressing the copy button twice sends two copy requests', async ({ page }) => {
    await openCopyEditor(page, BOLD_BODY);

    await page.locator(COPY_ITEM).click();
    await page.locator(COPY_ITEM).click();

    expect(await readMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.copyRequested)).toHaveLength(2);
  });
});

test.describe('showing the copy result on the copy button', () => {
  test('pressing the copy button leaves its icon as the clipboard while no copy succeeded message arrives', async ({ page }) => {
    await openCopyEditor(page, BOLD_BODY);

    await page.locator(COPY_ITEM).click();

    // Also check that the press sent a copy request. Otherwise this would not verify the icon after a press.
    expect([
      await readMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.copyRequested),
      await page.locator(COPY_ICON).getAttribute('d'),
    ]).toEqual([[{ type: VIEW_TO_HOST_MESSAGE_TYPE.copyRequested }], COPY_ICON_PATH]);
  });

  test('injecting a copy succeeded message turns the copy button icon into the check mark while its name stays Copy as HTML', async ({ page }) => {
    await openCopyEditor(page, BOLD_BODY);

    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.copySucceeded });

    expect([
      await page.locator(COPY_ICON).getAttribute('d'),
      await page.locator(COPY_ITEM).getAttribute('aria-label'),
    ]).toEqual([COPIED_ICON_PATH, 'Copy as HTML']);
  });

  test('2 seconds after the copy succeeded message, the copy button icon returns to the clipboard', async ({ page }) => {
    await page.clock.install();
    await openCopyEditor(page, BOLD_BODY);
    // From here on only runFor moves the page clock. With the clock running, how long each step takes would decide
    // whether the icon is read before or after the time runs out.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.copySucceeded });

    await page.clock.runFor(COPIED_ICON_TIMEOUT_MS - 1);
    const justBefore = await page.locator(COPY_ICON).getAttribute('d');
    await page.clock.runFor(1);

    expect([justBefore, await page.locator(COPY_ICON).getAttribute('d')]).toEqual([COPIED_ICON_PATH, COPY_ICON_PATH]);
  });
});

test.describe('creating and responding with HTML', () => {
  test('selecting "ol" in <p>a <strong>bold</strong></p> and injecting a copy HTML request responds with the HTML form <strong>ol</strong> and the same request id', async ({ page }) => {
    await openCopyEditor(page, BOLD_BODY);
    await selectRange(page, at(`${EDITOR_ROOT} strong`, 1, 0), at(`${EDITOR_ROOT} strong`, 3, 0));

    await requestCopyHtml(page, '5');

    await expect.poll(() => readMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.copyHtmlResponse)).toEqual([
      { type: VIEW_TO_HOST_MESSAGE_TYPE.copyHtmlResponse, requestId: '5', html: '<strong>ol</strong>' },
    ]);
  });

  test('injecting a request with only a caret responds with the whole body HTML minus the leading and trailing empty paragraphs', async ({ page }) => {
    await openCopyEditor(page, '<p><br></p>\n<p>ab</p>\n<p>cd</p>\n<p><br></p>');
    await placeCaretAt(page, at(`${PARAGRAPH}:nth-of-type(2)`, 1, 0));

    await requestCopyHtml(page, '1');

    await expect.poll(() => readResponseHtmls(page)).toEqual(['<p>ab</p>\n<p>cd</p>']);
  });

  test('with only a caret in a document containing a closed collapsible section, the response HTML includes the closed body', async ({ page }) => {
    await openCopyEditor(page, CLOSED_DETAILS_BODY);
    await placeCaretAt(page, at(`${EDITOR_ROOT} details + p`, 2, 0));

    await requestCopyHtml(page, '1');

    await expect.poll(() => readResponseHtmls(page)).toEqual([CLOSED_DETAILS_BODY]);
  });

  test('selecting from a paragraph in the editor root to outside it and injecting a request responds with the whole body HTML', async ({ page }) => {
    await openCopyEditor(page, '<p>abcd</p>\n<p>ef</p>');
    await selectToOutside(page, at(PARAGRAPH, 1, 0));

    await requestCopyHtml(page, '1');

    await expect.poll(() => readResponseHtmls(page)).toEqual(['<p>abcd</p>\n<p>ef</p>']);
  });

  test('selecting entry text in the comment popup and injecting a request responds with the whole body HTML', async ({ page }) => {
    await openCopyEditor(page, HUMAN_THREAD);
    await page.locator(COMMENT).first().click({ position: { x: 2, y: 5 } });
    await expect(page.locator(POPUP)).toBeVisible();
    await dragAcross(page, ENTRY_TEXT);
    const selected = await page.evaluate(() => window.getSelection()?.toString());

    await requestCopyHtml(page, '1');

    // Also check that the selection landed in the entry. Otherwise this would not verify the behavior for a
    // selection inside the popup.
    await expect.poll(async () => [selected, await readResponseHtmls(page)])
      .toEqual(['hello world', ['<p>xaby</p>']]);
  });

  test('injecting a request while a cell range exists responds with the whole body HTML, not just the cells in the range', async ({ page }) => {
    const body = '<p>xy</p>\n<table><tbody><tr><td id="a">ab</td><td id="b">cd</td><td>ef</td></tr></tbody></table>';
    await openCopyEditor(page, body);
    await placeCaretAt(page, at(`${EDITOR_ROOT} #a`, 1, 0));
    await page.locator(`${EDITOR_ROOT} #b`).click({ modifiers: ['Shift'] });

    await requestCopyHtml(page, '1');

    // Also check that the marks remain in the tree. If the range were gone, this would not verify the behavior while
    // a range exists.
    await expect.poll(async () => [await countCellRangeMarks(page), await readResponseHtmls(page)])
      .toEqual([2, [body]]);
  });

  test('injecting a request with only a caret while an overlay suspends input still responds with the whole body HTML rather than failing', async ({ page }) => {
    await openCopyEditor(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));
    await page.evaluate((argument) => {
      window.__uiShellProbe?.()?.overlay.present(argument.reason, argument.content);
    }, {
      reason: INPUT_STOP_REASON.saveRoundTrip,
      // Only the serializable fields are passed. The content's own parts are an element, which cannot cross into the
      // page, and its type is too deep for the argument check.
      content: {
        heading: BLANK_OVERLAY_CONTENT.heading,
        descriptions: BLANK_OVERLAY_CONTENT.descriptions,
        actions: BLANK_OVERLAY_CONTENT.actions,
      },
    });

    await requestCopyHtml(page, '1');

    // Also check that input is suspended. Otherwise this would not verify the behavior while it is suspended.
    await expect.poll(async () => [
      await page.locator(EDITOR_ROOT).getAttribute('contenteditable'),
      await readResponseHtmls(page),
    ]).toEqual(['false', ['<p>abcd</p>']]);
  });

  test('injecting a request during IME composition does not interrupt the composition', async ({ page }) => {
    await openCopyEditor(page, '<p>ab</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));
    const ime = await openImeSession(page);
    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });

    await requestCopyHtml(page, '1');

    await expect.poll(() => readMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.copyHtmlResponse)).toHaveLength(1);
    expect(await page.evaluate(() => window.__editingSessionProbe?.()?.isComposing)).toBe(true);
  });

  test('with only a caret in a document of just an empty paragraph, responds with an empty HTML form', async ({ page }) => {
    await openCopyEditor(page, '<p><br></p>');
    await placeCaretAt(page, at(PARAGRAPH, 0));

    await requestCopyHtml(page, '1');

    await expect.poll(() => readResponseHtmls(page)).toEqual(['']);
  });

  test('injecting a request into an unopenable document (containing script) returns a response with the same request id and a null html', async ({ page }) => {
    await openCopyEditor(page, '\n<script>a</script>\n');

    await requestCopyHtml(page, '3');

    await expect.poll(() => readMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.copyHtmlResponse)).toEqual([
      { type: VIEW_TO_HOST_MESSAGE_TYPE.copyHtmlResponse, requestId: '3', html: null },
    ]);
  });

  test('after responding, the editor root tree and selection are unchanged, and neither a view edited message nor an edit transaction is sent', async ({ page }) => {
    await openCopyEditor(page, `${COMMENT_BODY}\n${CLOSED_DETAILS_BODY}`);
    await selectRange(page, at(COMMENT, 1, 0), at(`${EDITOR_ROOT} details + p`, 2, 0));
    const before = await readTreeAndSelection(page);

    await requestCopyHtml(page, '1');
    await expect.poll(() => readMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.copyHtmlResponse)).toHaveLength(1);

    expect([
      await readTreeAndSelection(page),
      (await readMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.viewEdited)).length,
      (await readMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).length,
    ]).toEqual([before, 0, 0]);
  });

  test('when sending the copy HTML response fails, no exception occurs and one diagnostic line is sent', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await openCopyEditor(page, '<p>ab</p>');
    const diagnosticsBefore = (await readMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.viewDiagnostic)).length;
    await setSendFailureTypes(page, [VIEW_TO_HOST_MESSAGE_TYPE.copyHtmlResponse]);

    await requestCopyHtml(page, '1');

    await expect.poll(async () => (await readMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.viewDiagnostic)).length)
      .toBe(diagnosticsBefore + 1);
    expect(pageErrors).toEqual([]);
  });
});
