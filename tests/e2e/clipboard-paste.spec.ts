import { devices, expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { EDITOR_ROOT_ELEMENT_ID, HOST_TO_VIEW_MESSAGE_TYPE, VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import {
  EDITOR_ROOT,
  installReceiver,
  paste,
  pressPrimaryShortcut,
  readBodyHtml,
  readRecord,
  writeClipboard,
} from './helpers/editing';
import { FIXTURE_DIRECTORY_URL, PROBE_BUNDLE_PATH, getOutboundMessages, openWebviewHost, sendToWebview } from './helpers/page';

// The view decides the primary modifier from userAgent, but the Desktop Chrome descriptor returns a Windows userAgent
// on every OS. To send primary modifier+Shift+V as real key presses, match userAgent to the running OS. Paste and plain
// text paste read the real clipboard, so reading and writing it are allowed.
const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
test.use({
  userAgent: process.platform === 'darwin' ? MAC_USER_AGENT : devices['Desktop Chrome'].userAgent,
  permissions: ['clipboard-read', 'clipboard-write'],
});

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const PARAGRAPH = `${EDITOR_ROOT} p`;
const COMMENT = `${EDITOR_ROOT} comment`;

// A paragraph with text on both sides of a comment that has annotated text cd and a body.
const COMMENT_BODY = '<p>ab<comment id="c">cd<comment-body>note</comment-body></comment>ef</p>';
// A document URI in a directory other than the fixture's. Relative image paths point at the fixture images only when
// resolved against it.
const NESTED_DOCUMENT_URI = `${FIXTURE_DIRECTORY_URL}docs/page.html`;

// Clipboard HTML that Word writes for two list items. The root element declares Office namespaces, and comments mark
// the extent of the fragment. Bullets are surrounded by the list conditional comment, and English parts go in spans with
// lang.
const WORD_LIST_ITEM = (text: string): string => '<p class="MsoListParagraph" style="margin-left:18.0pt;mso-list:l0 level1 lfo1">'
  + '<![if !supportLists]><span lang="EN-US" style="font-family:Symbol">·<span style="font:7.0pt">&nbsp;&nbsp; </span>'
  + `</span><![endif]><span lang="EN-US">${text}<o:p></o:p></span></p>`;
const WORD_LIST_HTML = '<html xmlns:o="urn:schemas-microsoft-com:office:office" '
  + 'xmlns:w="urn:schemas-microsoft-com:office:word">\r\n<head><meta charset="utf-8">'
  + '<style><!-- p.MsoListParagraph { margin-left: 18pt; } --></style></head>\r\n<body lang="JA">\r\n'
  + `<!--StartFragment-->\r\n${WORD_LIST_ITEM('One')}\r\n${WORD_LIST_ITEM('Two')}\r\n<!--EndFragment-->\r\n</body>\r\n</html>`;

// HTML that Google Docs writes. Everything is wrapped in a b with an id, and the bold is canceled with style.
const GOOGLE_DOCS_HTML = '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1a2b3c">'
  + '<span style="font-size:11pt;font-weight:700;">Hi</span></b>';

// HTML Google Docs writes for bold, italic, and strikethrough words. Each format is only a declaration on a span, and
// every span also carries the default black text and transparent background.
const GOOGLE_DOCS_FORMATS_HTML = '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-4d5e6f">'
  + ['font-weight:700;', 'font-style:italic;', 'text-decoration:line-through;']
    .map((format, index) => '<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;'
      + `background-color:transparent;${format}white-space:pre-wrap;">${'BIS'.charAt(index)}</span>`)
    .join('')
  + '</b>';

// HTML Word writes for a bold English word in a Japanese document. Bold is a b element, and the text color is black.
const WORD_BOLD_HTML = '<html xmlns:o="urn:schemas-microsoft-com:office:office">\r\n<body lang="JA">\r\n'
  + '<!--StartFragment--><b><span lang="EN-US" style="font-family:Century;color:black;mso-themecolor:text1">X</span></b>'
  + '<!--EndFragment-->\r\n</body>\r\n</html>';

// HTML Chromium writes when copying a paragraph selected up to its break. The end of the selection is a paragraph break,
// so a line break mark br is added at the end.
const CHROMIUM_PARAGRAPH_HTML = '<meta charset="utf-8"><p style="margin: 0px;">X</p><br class="Apple-interchange-newline">';

// HTML copied from a Gmail message across colored text and strikethrough. The formatting is written with font and
// strike elements.
const GMAIL_HTML = '<meta charset="utf-8"><font color="#ff0000" style="font-family: Arial;">X</font> '
  + '<strike style="font-size: small;">Y</strike>';

// A word with ruby copied from an Aozora Bunko text. The base text is written with rb.
const AOZORA_RUBY = '<ruby><rb>\u6f22\u5b57</rb><rp>\uff08</rp><rt>\u304b\u3093\u3058</rt><rp>\uff09</rp></ruby>';

// An emoji copied from a GitHub comment. It is written with a custom element.
const GITHUB_EMOJI = '<g-emoji class="g-emoji" alias="tada">🎉</g-emoji>';

// HTML Evernote writes, which puts a nested list directly under the list instead of inside an item.
const EVERNOTE_NESTED_LIST_HTML = '<ul><li>b</li><ul><li>c</li></ul></ul>';

// A code block that draws its lines with div. It has no newline characters but displays as two lines.
const DIV_LINES_CODE_BLOCK_HTML = '<pre><div>x</div><div>y</div></pre>';

// Table HTML that Google Sheets writes. Everything is wrapped in its own element, and the table width is set to 0 and
// paired with the declaration that sizes the table by its column widths.
const GOOGLE_SHEETS_HTML = '<meta charset="utf-8"><google-sheets-html-origin>'
  + '<style type="text/css"><!--td {border: 1px solid #cccccc;}--></style>'
  + '<table cellspacing="0" cellpadding="0" dir="ltr" border="1" '
  + 'style="table-layout:fixed;font-size:10pt;font-family:Arial;width:0px;border-collapse:collapse;border:none">'
  + '<colgroup><col width="100"><col width="100"></colgroup><tbody><tr style="height:21px;">'
  + '<td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;">a</td>'
  + '<td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;">b</td>'
  + '</tr></tbody></table></google-sheets-html-origin>';

declare global {
  interface Window {
    /** The forwarding record. Holds the code of each keydown that reached the window bubbling phase, in arrival order. */
    __forwardedKeys?: string[];
    /** A flag set if a pasted script runs. */
    __pasteExecuted?: boolean;
  }
}

/** A position. Without a child index, it is a position inside the element itself. */
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
 * @param childIndex For a position inside text, which child of the element that text is.
 * @returns The position.
 */
function at(selector: string, offset: number, childIndex?: number): Point {
  return { selector, offset, childIndex };
}

/**
 * Mounts a body.
 *
 * @param page The page to operate on.
 * @param body The body to mount.
 * @param documentUri The document URI. If empty, relative paths are not resolved.
 * @param resourceRootUri The resource root URI. If empty, relative paths are not resolved.
 */
async function openPasteEditor(page: Page, body: string, documentUri = '', resourceRootUri = ''): Promise<void> {
  await openWebviewHost(page, PROBE_BUNDLE_PATH);
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
 * Dispatches a paste input event to the editor root.
 *
 * The event is dispatched without going through the clipboard, so that HTML written by external apps reaches the rules
 * as is.
 *
 * @param page The page to operate on.
 * @param data The content per form.
 * @returns Whether the default action was stopped.
 */
async function dispatchPaste(page: Page, data: Record<string, string>): Promise<boolean> {
  return page.evaluate((argument) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(argument.data)) {
      transfer.setData(type, value);
    }
    const event = new InputEvent('beforeinput', {
      inputType: 'insertFromPaste',
      dataTransfer: transfer,
      cancelable: true,
      bubbles: true,
    });
    document.getElementById(argument.rootId)?.dispatchEvent(event);
    return event.defaultPrevented;
  }, { data, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/** Dispatches only the clipboard event, as VS Code's native paste omits beforeinput. */
async function dispatchClipboardPaste(page: Page, data: Record<string, string>): Promise<boolean> {
  return page.evaluate((argument) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(argument.data)) {
      transfer.setData(type, value);
    }
    const event = new ClipboardEvent('paste', { clipboardData: transfer, cancelable: true, bubbles: true });
    document.getElementById(argument.rootId)?.dispatchEvent(event);
    return event.defaultPrevented;
  }, { data, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/** Reads both forms written by the editor's real copy command. */
async function readClipboardForms(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const forms: Record<string, string> = {};
    for (const item of await navigator.clipboard.read()) {
      for (const type of item.types) {
        forms[type] = await (await item.getType(type)).text();
      }
    }
    return forms;
  });
}

/**
 * Presses primary modifier+Shift+V.
 *
 * @param page The page to operate on.
 */
async function pastePlainText(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+Shift+V');
}

/**
 * Reads the clipboard text from the page and waits until the read finishes.
 *
 * Clipboard reads finish in the order they were requested, so once this finishes, a read started earlier by a key press
 * and the processing after it have also finished. Used to wait for the read before checking that nothing happened.
 *
 * @param page The page to operate on.
 */
async function waitForClipboardRead(page: Page): Promise<void> {
  await page.evaluate(() => navigator.clipboard.readText());
}

/**
 * Returns how many messages of a type were sent to the host.
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
 * Replaces the body by calling the replace document entry point.
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
 * Imitates VS Code forwarding by starting to record the code of each keydown that reaches the window bubbling phase.
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
 * Reads the forwarding record.
 *
 * @param page The page to operate on.
 * @returns The code of each keydown that arrived.
 */
async function readForwardedKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__forwardedKeys ?? []);
}

/**
 * Starts IME composition.
 *
 * @param page The page to operate on.
 */
async function startComposition(page: Page): Promise<void> {
  const ime = await page.context().newCDPSession(page);
  await ime.send('Input.imeSetComposition', { text: '\u3042', selectionStart: 1, selectionEnd: 1 });
}

test.describe('registration', () => {
  test('after replacing the document, pasting an HTML form <b>X</b> into the middle of a paragraph keeps b', async ({ page }) => {
    await openPasteEditor(page, '<p>xyz</p>');
    await replaceDocument(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'X', 'text/html': '<b>X</b>' });

    expect(await readBodyHtml(page)).toBe('<p>ab<b>X</b>cd</p>');
  });

  test('after replacing the document, pressing Ctrl+Shift+V once inserts the clipboard text exactly once', async ({ page }) => {
    await openPasteEditor(page, '<p>xyz</p>');
    await replaceDocument(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));
    await writeClipboard(page, { 'text/plain': 'X' });

    await pastePlainText(page);
    await waitForClipboardRead(page);

    expect(await readBodyHtml(page)).toBe('<p>abXcd</p>');
  });
});

test.describe('clipboard paste events', () => {
  for (const source of ['th', 'td']) {
    for (const destination of ['th', 'td']) {
      test(`a paste without beforeinput from ${source} to ${destination} records exactly one table edit`, async ({ page }) => {
        const body = `<table><tbody><tr><${source}>あああいいい</${source}></tr>`
          + `<tr><${destination}><br></${destination}></tr></tbody></table><p><br></p>`;
        await openPasteEditor(page, body);
        const before = await readBodyOutput(page);
        const sourceCell = `${EDITOR_ROOT} tr:first-child ${source}`;
        await selectRange(page, at(sourceCell, 3, 0), at(sourceCell, 6, 0));
        await pressPrimaryShortcut(page, 'C');
        const forms = await readClipboardForms(page);
        expect(forms['text/plain']).toBe('いいい');
        await placeCaretAt(page, at(`${EDITOR_ROOT} tr:last-child ${destination}`, 0));

        expect(await dispatchClipboardPaste(page, forms)).toBe(true);

        const after = body.replace(`<${destination}><br></${destination}>`, `<${destination}>いいい</${destination}>`);
        expect(await readBodyHtml(page)).toBe(after);
        await expect.poll(() => countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).toBe(1);
        expect(await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.viewEdited)).toBe(1);
        const transactions = (await getOutboundMessages(page)).filter((message) => (
          typeof message === 'object' && message !== null
          && Reflect.get(message, 'type') === VIEW_TO_HOST_MESSAGE_TYPE.editTransaction
        ));
        expect(transactions).toEqual([expect.objectContaining({
          transaction: expect.objectContaining({
            before: expect.objectContaining({ text: `${PROLOGUE}${before}${EPILOGUE}` }),
            after: expect.objectContaining({ text: `${PROLOGUE}${after}${EPILOGUE}` }),
          }),
        })]);
      });
    }
  }

  test('normal Ctrl+V between cells inserts the copied text and records the edit once', async ({ page }) => {
    const body = '<table><tbody><tr><th>あああいいい</th></tr><tr><td><br></td></tr></tbody></table><p><br></p>';
    await openPasteEditor(page, body);
    const sourceCell = `${EDITOR_ROOT} th`;
    await selectRange(page, at(sourceCell, 3, 0), at(sourceCell, 6, 0));
    await pressPrimaryShortcut(page, 'C');
    await placeCaretAt(page, at(`${EDITOR_ROOT} td`, 0));

    await pressPrimaryShortcut(page, 'V');

    expect(await readBodyHtml(page)).toBe(body.replace('<td><br></td>', '<td>いいい</td>'));
    await expect.poll(() => countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).toBe(1);
    expect(await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.viewEdited)).toBe(1);
  });

  test('a clipboard paste during composition is canceled without changing the composed tree', async ({ page }) => {
    await openPasteEditor(page, '<p>ab</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));
    await startComposition(page);
    const composed = await readBodyHtml(page);

    expect(await dispatchClipboardPaste(page, { 'text/plain': 'X', 'text/html': '<b>X</b>' })).toBe(true);

    expect(await readBodyHtml(page)).toBe(composed);
    expect(await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).toBe(0);
  });

  test('a clipboard paste while input is stopped leaves the document and history unchanged', async ({ page }) => {
    await openPasteEditor(page, '<p>ab</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput, requestId: 'paste-stop' });
    await expect(page.locator(EDITOR_ROOT)).toHaveAttribute('contenteditable', 'false');

    expect(await dispatchClipboardPaste(page, { 'text/plain': 'X', 'text/html': '<b>X</b>' })).toBe(true);

    expect(await readBodyHtml(page)).toBe('<p>ab</p>');
    expect(await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).toBe(0);
    expect(await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.viewEdited)).toBe(0);
  });
});

test.describe('accepting a paste', () => {
  test('pasting an HTML form into the middle of a paragraph sends one immediate notification for insertFromPaste and one edit transaction', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await installReceiver(page);
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await paste(page, { 'text/plain': 'X', 'text/html': '<b>X</b>' });

    await expect.poll(() => countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).toBe(1);
    expect((await readRecord(page)).kinds).toEqual(['insertFromPaste']);
  });

  test('selecting part of a paragraph and pasting a paragraph fragment splits the paragraph where the range was deleted and inserts it there', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await selectRange(page, at(PARAGRAPH, 1, 0), at(PARAGRAPH, 3, 0));

    await dispatchPaste(page, { 'text/plain': 'X', 'text/html': '<p>X</p>' });

    expect(await readBodyHtml(page)).toBe('<p>a</p>\n<p>X</p>\n<p>d</p>');
  });

  test('selecting from the middle of annotated text to the middle of a later paragraph and pasting a bold fragment keeps the entries, and the bold goes where the range deletion placed the caret (right after comment)', async ({ page }) => {
    await openPasteEditor(page, `${COMMENT_BODY}\n<p>gh</p>`);
    await selectRange(page, at(COMMENT, 1, 0), at(`${EDITOR_ROOT} p + p`, 1, 0));

    await dispatchPaste(page, { 'text/plain': 'X', 'text/html': '<b>X</b>' });

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">c<comment-body>note</comment-body></comment><b>X</b>h</p>');
  });

  test('selecting from before the title directly under a collapsible section to the middle of a body paragraph and pasting a two-paragraph fragment keeps the title, and the text form goes into the title with br', async ({ page }) => {
    await openPasteEditor(page, '<details open=""><summary>Title</summary>\n<p>Body</p>\n</details>');
    await selectRange(page, at(`${EDITOR_ROOT} details`, 0), at(`${EDITOR_ROOT} details p`, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'A\n\nB', 'text/html': '<p>A</p><p>B</p>' });

    expect([
      await page.locator(`${EDITOR_ROOT} summary`).innerHTML(),
      await page.locator(`${EDITOR_ROOT} details p`).textContent(),
    ]).toEqual(['A<br><br>B', 'dy']);
  });

  test('selecting from the paragraph before a table to the middle of the first cell and pasting a paragraph fragment keeps the table skeleton, and the fragment goes between the preceding paragraph and the table', async ({ page }) => {
    await openPasteEditor(page, '<p>ab</p>\n<table><tbody><tr><td>cd</td><td>ef</td></tr></tbody></table>');
    await selectRange(page, at(PARAGRAPH, 1, 0), at(`${EDITOR_ROOT} td`, 1, 0));

    await dispatchPaste(page, { 'text/plain': 'X', 'text/html': '<p>X</p>' });

    expect(await readBodyHtml(page))
      .toBe('<p>a</p>\n<p>X</p>\n<table><tbody><tr><td>d</td><td>ef</td></tr></tbody></table>');
  });

  test('when a paste input arrives during IME composition, the default is stopped and the tree changes only by the composed character', async ({ page }) => {
    await openPasteEditor(page, '<p>ab</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));
    await startComposition(page);
    const composed = await readBodyHtml(page);

    const prevented = await dispatchPaste(page, { 'text/plain': 'X', 'text/html': '<b>X</b>' });

    expect([prevented, await readBodyHtml(page)]).toEqual([true, composed]);
  });
});

test.describe('building the fragment', () => {
  test('pasting Word HTML for two list items after a paragraph inserts two paragraphs without bullets, lang, o:p, class, or style', async ({ page }) => {
    await openPasteEditor(page, '<p>x</p>');
    await placeCaretAt(page, at(PARAGRAPH, 1, 0));

    await dispatchPaste(page, { 'text/plain': 'One\nTwo', 'text/html': WORD_LIST_HTML });

    expect(await readBodyHtml(page)).toBe('<p>x</p>\n<p>One</p>\n<p>Two</p>');
  });

  test('pasting Google Docs HTML into the middle of a paragraph inserts the bold text as strong, without the wrapping b or span', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'Hi', 'text/html': GOOGLE_DOCS_HTML });

    expect(await readBodyHtml(page)).toBe('<p>ab<strong>Hi</strong>cd</p>');
  });

  test('pasting a paragraph fragment ending with the Chromium line break mark after a paragraph inserts only the fragment paragraph and adds no empty paragraph', async ({ page }) => {
    await openPasteEditor(page, '<p>ab</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'X\n', 'text/html': CHROMIUM_PARAGRAPH_HTML });

    expect(await readBodyHtml(page)).toBe('<p>ab</p>\n<p>X</p>');
  });

  test('pasting Google Sheets HTML after a paragraph inserts an unwrapped table directly under the editor root, with no style left on the table', async ({ page }) => {
    await openPasteEditor(page, '<p>ab</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'a\tb', 'text/html': GOOGLE_SHEETS_HTML });

    expect(await page.locator(`${EDITOR_ROOT} > table`).evaluateAll((tables) => tables.map((table) => table.getAttribute('style'))))
      .toEqual([null]);
  });
});

test.describe('sanitizing the fragment', () => {
  test('pasting an HTML form with <p>safe</p> and script inserts the safe paragraph, and script is neither inserted nor run', async ({ page }) => {
    await openPasteEditor(page, '<p>ab</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, {
      'text/plain': 'safe',
      'text/html': '<p>safe</p><script>window.__pasteExecuted = true;</script>',
    });

    expect([await readBodyHtml(page), await page.evaluate(() => window.__pasteExecuted ?? false)])
      .toEqual(['<p>ab</p>\n<p>safe</p>', false]);
  });

  test('pasting an HTML form with comment and entries into the middle of a paragraph inserts only the annotated text, and no comment is added to the editor root', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, {
      'text/plain': 'note',
      'text/html': '<comment id="z">note<comment-body>body</comment-body></comment>',
    });

    expect([await readBodyHtml(page), await page.locator(COMMENT).count()]).toEqual(['<p>abnotecd</p>', 0]);
  });
});

test.describe('pruning attributes', () => {
  test('pasting Google Docs HTML with bold, italic, and strikethrough words inserts strong, em, and s without the black text or transparent background', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'BIS', 'text/html': GOOGLE_DOCS_FORMATS_HTML });

    expect(await readBodyHtml(page)).toBe('<p>ab<strong>B</strong><em>I</em><s>S</s>cd</p>');
  });

  test('pasting MathML with a bold declaration inserts it without adding strong inside it', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'x', 'text/html': '<math style="font-weight: 700"><mi>x</mi></math>' });

    expect(await readBodyHtml(page)).toBe('<p>ab<math><mi>x</mi></math>cd</p>');
  });

  test('pasting Word HTML with a black bold word inserts only b, without the black text color', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'X', 'text/html': WORD_BOLD_HTML });

    expect(await readBodyHtml(page)).toBe('<p>ab<b>X</b>cd</p>');
  });

  test('pasting HTML from an external page (span with font-family, font-size, white-space, and color) inserts a span with only color', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, {
      'text/plain': 'X',
      'text/html': '<span style="font-family: Arial; font-size: 14px; white-space: pre-wrap; color: rgb(255, 0, 0);">X</span>',
    });

    expect(await readBodyHtml(page)).toBe('<p>ab<span style="color: rgb(255, 0, 0);">X</span>cd</p>');
  });

  test('pasting an alert blockquote (data-alert="note") after a paragraph keeps the type attribute', async ({ page }) => {
    await openPasteEditor(page, '<p>ab</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'N', 'text/html': '<blockquote data-alert="note"><p>N</p></blockquote>' });

    expect(await readBodyHtml(page)).toBe('<p>ab</p>\n<blockquote data-alert="note">\n<p>N</p>\n</blockquote>');
  });

  test('pasting an open collapsible section keeps open, and a closed one is inserted closed', async ({ page }) => {
    await openPasteEditor(page, '<p>ab</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, {
      'text/plain': 'O',
      'text/html': '<details open=""><summary>O</summary><p>o</p></details><details><summary>C</summary><p>c</p></details>',
    });

    expect(await page.locator(`${EDITOR_ROOT} details`).evaluateAll((sections) => sections.map((section) => section.hasAttribute('open'))))
      .toEqual([true, false]);
  });

  test('pasting a table with column widths (width on col) keeps the column widths', async ({ page }) => {
    await openPasteEditor(page, '<p>ab</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, {
      'text/plain': 'a\tb',
      'text/html': '<table><colgroup><col style="width: 40%;"><col style="width: 60%;"></colgroup>'
        + '<tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
    });

    expect(await page.locator(`${EDITOR_ROOT} col`).evaluateAll((columns) => columns.map((column) => column.getAttribute('style'))))
      .toEqual(['width: 40%;', 'width: 60%;']);
  });
});

test.describe('inserting the fragment', () => {
  test('pasting <strong>X</strong> into <p>ab|cd</p> gives <p>ab<strong>X</strong>cd</p> with the caret right after strong', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'X', 'text/html': '<strong>X</strong>' });

    expect([
      await readBodyHtml(page),
      await page.evaluate(() => {
        const selection = window.getSelection();
        return [selection?.anchorNode?.nodeName, selection?.anchorOffset];
      }),
    ]).toEqual(['<p>ab<strong>X</strong>cd</p>', ['P', 2]]);
  });

  test('pasting <pre><code>x</code></pre> into <p>ab|cd</p> gives <p>ab<code>x</code>cd</p>', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'x', 'text/html': '<pre><code>x</code></pre>' });

    expect(await readBodyHtml(page)).toBe('<p>ab<code>x</code>cd</p>');
  });

  test('pasting a two-line pre that draws lines with div into <p>ab|cd</p> splits the paragraph and inserts pre between the halves as a code block', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'x\ny', 'text/html': DIV_LINES_CODE_BLOCK_HTML });

    expect(await readBodyHtml(page)).toBe(`<p>ab</p>\n${DIV_LINES_CODE_BLOCK_HTML}\n<p>cd</p>`);
  });

  test('pasting <p>X</p> into <h2>ab|cd</h2> lines up h2, p, and h2 separated by one line break each', async ({ page }) => {
    await openPasteEditor(page, '<h2>abcd</h2>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} h2`, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'X', 'text/html': '<p>X</p>' });

    expect(await readBodyHtml(page)).toBe('<h2>ab</h2>\n<p>X</p>\n<h2>cd</h2>');
  });

  test('pasting a paragraph fragment at the start and end of a paragraph inserts it before and after without splitting the paragraph', async ({ page }) => {
    await openPasteEditor(page, '<p>ab</p>');
    await placeCaretAt(page, at(PARAGRAPH, 0, 0));
    await dispatchPaste(page, { 'text/plain': 'X', 'text/html': '<p>X</p>' });
    await placeCaretAt(page, at(`${EDITOR_ROOT} p + p`, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'Y', 'text/html': '<p>Y</p>' });

    expect(await readBodyHtml(page)).toBe('\n<p>X</p>\n<p>ab</p>\n<p>Y</p>');
  });

  test('pasting a heading and paragraph fragment into an empty paragraph replaces the empty paragraph with the fragment blocks', async ({ page }) => {
    await openPasteEditor(page, '<p>a</p>\n<p><br></p>\n<p>b</p>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} p + p`, 0));

    await dispatchPaste(page, { 'text/plain': 'H\n\nP', 'text/html': '<h2>H</h2><p>P</p>' });

    expect(await readBodyHtml(page)).toBe('<p>a</p>\n<h2>H</h2>\n<p>P</p>\n<p>b</p>');
  });

  test('pasting <p>X</p> into <li>ab|</li> inserts a paragraph after ab inside the item', async ({ page }) => {
    await openPasteEditor(page, '<ul><li>ab</li></ul>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} li`, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'X', 'text/html': '<p>X</p>' });

    expect(await readBodyHtml(page)).toBe('<ul><li>ab\n<p>X</p></li></ul>');
  });

  test('pasting a list with two items b and c into <li>a|x</li> gives four items a, b, c, and x', async ({ page }) => {
    await openPasteEditor(page, '<ul><li>ax</li></ul>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} li`, 1, 0));

    await dispatchPaste(page, { 'text/plain': 'b\nc', 'text/html': '<ul><li>b</li><li>c</li></ul>' });

    expect(await page.locator(`${EDITOR_ROOT} ul > li`).allTextContents()).toEqual(['a', 'b', 'c', 'x']);
  });

  test('pasting a two-item list into an empty item replaces the empty item with the two items', async ({ page }) => {
    await openPasteEditor(page, '<ul><li>a</li><li><br></li></ul>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} li + li`, 0));

    await dispatchPaste(page, { 'text/plain': 'b\nc', 'text/html': '<ul><li>b</li><li>c</li></ul>' });

    expect(await page.locator(`${EDITOR_ROOT} ul > li`).allTextContents()).toEqual(['a', 'b', 'c']);
  });

  test('pasting a fragment with a nested list directly under the list into <li>a|x</li> inserts it, including c, as a nested list after a', async ({ page }) => {
    await openPasteEditor(page, '<ul><li>ax</li></ul>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} li`, 1, 0));

    await dispatchPaste(page, { 'text/plain': 'b\nc', 'text/html': EVERNOTE_NESTED_LIST_HTML });

    expect(await readBodyHtml(page)).toBe('<ul><li>a\n<ul>\n<li>b</li>\n<ul>\n<li>c</li>\n</ul>\n</ul>x</li></ul>');
  });

  test('pasting a fragment with a nested list directly under the list into an empty item inserts it, including c, as a list inside the item', async ({ page }) => {
    await openPasteEditor(page, '<ul><li>a</li><li><br></li></ul>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} li + li`, 0));

    await dispatchPaste(page, { 'text/plain': 'b\nc', 'text/html': EVERNOTE_NESTED_LIST_HTML });

    expect(await readBodyHtml(page)).toBe('<ul><li>a</li><li>\n<ul>\n<li>b</li>\n<ul>\n<li>c</li>\n</ul>\n</ul></li></ul>');
  });

  test('pasting a paragraph fragment into the middle of cell text inserts it at the caret inside the cell, and the text before and after is not wrapped in paragraphs', async ({ page }) => {
    await openPasteEditor(page, '<table><tbody><tr><td>ab</td></tr></tbody></table>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} td`, 1, 0));

    await dispatchPaste(page, { 'text/plain': 'X', 'text/html': '<p>X</p>' });

    expect(await page.locator(`${EDITOR_ROOT} td`).innerHTML()).toBe('a\n<p>X</p>b');
  });

  test('pasting a table into the middle of a paragraph splits the paragraph and inserts the table between the halves', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'x', 'text/html': '<table><tbody><tr><td>x</td></tr></tbody></table>' });

    expect(await readBodyHtml(page))
      .toBe('<p>ab</p>\n<table>\n<tbody>\n<tr><td>x</td></tr>\n</tbody>\n</table>\n<p>cd</p>');
  });

  test('pasting a fragment containing another link into a link unwraps the fragment link and inserts only its text inside the link', async ({ page }) => {
    await openPasteEditor(page, '<p><a href="a.html">link</a></p>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} a`, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'Y', 'text/html': '<a href="b.html">Y</a>' });

    expect(await readBodyHtml(page)).toBe('<p><a href="a.html">liYnk</a></p>');
  });

  test('pasting a bold fragment at the end of annotated text (the inside edge) inserts it inside the annotated text, and pasting after moving to the outside neighbor with the right arrow inserts it outside comment', async ({ page }) => {
    await openPasteEditor(page, COMMENT_BODY);
    await placeCaretAt(page, at(COMMENT, 2, 0));
    await dispatchPaste(page, { 'text/plain': 'X', 'text/html': '<b>X</b>' });
    await page.keyboard.press('ArrowRight');

    await dispatchPaste(page, { 'text/plain': 'Y', 'text/html': '<b>Y</b>' });

    expect(await readBodyHtml(page))
      .toBe('<p>ab<comment id="c">cd<b>X</b><comment-body>note</comment-body></comment><b>Y</b>ef</p>');
  });

  test('pasting a paragraph fragment at the end of annotated text in a paragraph (the inside edge) splits the paragraph outside comment, and comment remains a single element', async ({ page }) => {
    await openPasteEditor(page, COMMENT_BODY);
    await placeCaretAt(page, at(COMMENT, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'X', 'text/html': '<p>X</p>' });

    expect(await readBodyHtml(page))
      .toBe('<p>ab<comment id="c">cd<comment-body>note</comment-body></comment></p>\n<p>X</p>\n<p>ef</p>');
  });

  test('pasting a paragraph fragment at the end of annotated text in an item does not split comment, and there is one comment with the same ID', async ({ page }) => {
    await openPasteEditor(page, '<ul><li>ab<comment id="c">cd<comment-body>note</comment-body></comment>ef</li></ul>');
    await placeCaretAt(page, at(COMMENT, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'X', 'text/html': '<p>X</p>' });

    expect([await page.locator(`${EDITOR_ROOT} comment[id="c"]`).count(), await page.locator(`${EDITOR_ROOT} li p`).count()])
      .toEqual([1, 1]);
  });

  test('pasting a two-paragraph fragment into the middle of annotated text inserts the text form inside it with br, and comment is not split', async ({ page }) => {
    await openPasteEditor(page, COMMENT_BODY);
    await placeCaretAt(page, at(COMMENT, 1, 0));

    await dispatchPaste(page, { 'text/plain': 'A\n\nB', 'text/html': '<p>A</p><p>B</p>' });

    expect(await readBodyHtml(page))
      .toBe('<p>ab<comment id="c">cA<br><br>Bd<comment-body>note</comment-body></comment>ef</p>');
  });

  test('pasting a two-paragraph fragment (text form A, blank line, B) at the end of a title gives <summary>TA<br><br>B</summary>', async ({ page }) => {
    await openPasteEditor(page, '<details open=""><summary>T</summary>\n<p>x</p>\n</details>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} summary`, 1, 0));

    await dispatchPaste(page, { 'text/plain': 'A\n\nB', 'text/html': '<p>A</p><p>B</p>' });

    expect(await page.locator(`${EDITOR_ROOT} summary`).evaluate((title) => title.outerHTML))
      .toBe('<summary>TA<br><br>B</summary>');
  });

  test('pasting a paragraph fragment into the middle of a body paragraph of an open collapsible section splits the paragraph inside the body and inserts it there', async ({ page }) => {
    await openPasteEditor(page, '<details open=""><summary>T</summary>\n<p>abcd</p>\n</details>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} details p`, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'X', 'text/html': '<p>X</p>' });

    expect(await readBodyHtml(page))
      .toBe('<details open=""><summary>T</summary>\n<p>ab</p>\n<p>X</p>\n<p>cd</p>\n</details>');
  });

  test('pasting a paragraph fragment into a code block inserts the text form with newline characters instead of using the HTML form', async ({ page }) => {
    await openPasteEditor(page, '<pre><code>abcd</code></pre>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} code`, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'X\nY', 'text/html': '<p>X</p><p>Y</p>' });

    expect(await readBodyHtml(page)).toBe('<pre><code>abX\nYcd</code></pre>');
  });

  test('pasting an indented nested list gives one line break before each block in the body output, with no indentation left', async ({ page }) => {
    await openPasteEditor(page, '<p>x</p>');
    await placeCaretAt(page, at(PARAGRAPH, 1, 0));

    await dispatchPaste(page, {
      'text/plain': 'a\nb',
      'text/html': '<ul>\n  <li>a<ul>\n      <li>b</li>\n    </ul>\n  </li>\n</ul>',
    });

    expect(await readBodyOutput(page)).toBe('<p>x</p>\n<ul>\n<li>a\n<ul>\n<li>b</li>\n</ul>\n</li>\n</ul>');
  });

  test('with the document URI in a directory other than the fixture, pasting an image with a relative path resolves it for display, and src in the body output stays relative', async ({ page }) => {
    await openPasteEditor(page, '<p>ab</p>', NESTED_DOCUMENT_URI, FIXTURE_DIRECTORY_URL);
    await placeCaretAt(page, at(PARAGRAPH, 1, 0));

    await dispatchPaste(page, { 'text/html': '<img src="../sample.png" alt="s">' });

    expect([await page.locator(`${EDITOR_ROOT} img`).getAttribute('src'), await readBodyOutput(page)])
      .toEqual([`${FIXTURE_DIRECTORY_URL}sample.png`, '<p>a<img src="../sample.png" alt="s">b</p>']);
  });

  test('pasting a bold fragment into the middle of a bold word leaves no directly nested strong', async ({ page }) => {
    await openPasteEditor(page, '<p><strong>abcd</strong></p>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} strong`, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'X', 'text/html': '<strong>X</strong>' });

    expect(await readBodyHtml(page)).toBe('<p><strong>abXcd</strong></p>');
  });

  test('pasting an inline fragment into an empty paragraph leaves no placeholder br', async ({ page }) => {
    await openPasteEditor(page, '<p><br></p>');
    await placeCaretAt(page, at(PARAGRAPH, 0));

    await dispatchPaste(page, { 'text/plain': 'X', 'text/html': '<b>X</b>' });

    expect(await readBodyHtml(page)).toBe('<p><b>X</b></p>');
  });

  test('pasting a font fragment into an empty paragraph inserts its text inside the paragraph, leaving no font', async ({ page }) => {
    await openPasteEditor(page, '<p><br></p>');
    await placeCaretAt(page, at(PARAGRAPH, 0));

    await dispatchPaste(page, { 'text/plain': 'X', 'text/html': '<font color="#ff0000">X</font>' });

    expect(await readBodyHtml(page)).toBe('<p>X</p>');
  });

  test('pasting a fragment containing font and strike into the middle of a paragraph unwraps font, turns strike into s, and does not split the paragraph', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'X Y', 'text/html': GMAIL_HTML });

    expect(await readBodyHtml(page)).toBe('<p>abX <s>Y</s>cd</p>');
  });

  test('pasting a fragment containing ruby with rb and g-emoji into the middle of a paragraph inserts it at the caret without splitting the paragraph', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, { 'text/plain': '\u6f22\u5b57\uff08\u304b\u3093\u3058\uff09🎉', 'text/html': `<meta charset="utf-8">${AOZORA_RUBY}${GITHUB_EMOJI}` });

    expect(await readBodyHtml(page)).toBe(`<p>ab${AOZORA_RUBY}<g-emoji alias="tada">🎉</g-emoji>cd</p>`);
  });

  test('pasting a fragment of ruby with rb into an empty paragraph inserts it inside the paragraph, leaving no ruby directly under the editor root', async ({ page }) => {
    await openPasteEditor(page, '<p><br></p>');
    await placeCaretAt(page, at(PARAGRAPH, 0));

    await dispatchPaste(page, { 'text/plain': '\u6f22\u5b57\uff08\u304b\u3093\u3058\uff09', 'text/html': `<meta charset="utf-8">${AOZORA_RUBY}` });

    expect(await readBodyHtml(page)).toBe(`<p>${AOZORA_RUBY}</p>`);
  });

  test('pasting a fragment ending with hr into the middle of a paragraph puts the caret right after hr', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'X', 'text/html': '<p>X</p><hr>' });

    expect(await page.evaluate(() => {
      const selection = window.getSelection();
      return selection?.anchorNode?.childNodes[(selection.anchorOffset) - 1]?.nodeName;
    })).toBe('HR');
  });

  test('pasting a fragment ending with a closed collapsible section puts the caret at the end of its title', async ({ page }) => {
    await openPasteEditor(page, '<p>ab</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));

    await dispatchPaste(page, { 'text/plain': 'T', 'text/html': '<details><summary>T</summary><p>B</p></details>' });

    expect(await page.evaluate(() => {
      const selection = window.getSelection();
      return [selection?.anchorNode?.parentElement?.localName, selection?.anchorNode?.textContent, selection?.anchorOffset];
    })).toEqual(['summary', 'T', 1]);
  });

  test('pasting an image-only HTML form (no text form) into a paragraph with Ctrl+V inserts img into the paragraph', async ({ page }) => {
    await openPasteEditor(page, '<p>ab</p>');
    await placeCaretAt(page, at(PARAGRAPH, 1, 0));

    await paste(page, { 'text/html': '<img src="sample.png" alt="s">' });

    expect(await page.locator(`${PARAGRAPH} img`).count()).toBe(1);
  });

  test('copying a heading and paragraph with Ctrl+C and pressing Ctrl+V in the middle of another paragraph splits it and inserts the heading and paragraph', async ({ page }) => {
    await openPasteEditor(page, '<h2>T</h2>\n<p>P</p>\n<p>abcd</p>');
    await selectRange(page, at(`${EDITOR_ROOT} h2`, 0, 0), at(`${EDITOR_ROOT} h2 + p`, 1, 0));
    await pressPrimaryShortcut(page, 'C');
    await placeCaretAt(page, at(`${EDITOR_ROOT} p + p`, 2, 0));

    await pressPrimaryShortcut(page, 'V');

    expect(await readBodyHtml(page)).toBe('<h2>T</h2>\n<p>P</p>\n<p>ab</p>\n<h2>T</h2>\n<p>P</p>\n<p>cd</p>');
  });
});

test.describe('plain text paste', () => {
  test('pressing Ctrl+Shift+V in the middle of a paragraph inserts only the two lines of text, splitting the paragraph, even if the clipboard has an HTML form', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));
    await writeClipboard(page, { 'text/plain': 'X\nY', 'text/html': '<b>Z</b>' });

    await pastePlainText(page);

    await expect.poll(() => readBodyHtml(page)).toBe('<p>abX</p>\n<p>Ycd</p>');
  });

  test('Ctrl+Shift+V does not appear in the forwarding record', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await installForwardRecord(page);
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));
    await writeClipboard(page, { 'text/plain': 'X' });

    await pastePlainText(page);
    await waitForClipboardRead(page);

    expect((await readForwardedKeys(page)).filter((code) => code === 'KeyV')).toEqual([]);
  });

  test('Ctrl+Shift+V with a range selection deletes the range before inserting and sends one edit transaction', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await selectRange(page, at(PARAGRAPH, 1, 0), at(PARAGRAPH, 3, 0));
    await writeClipboard(page, { 'text/plain': 'X' });

    await pastePlainText(page);

    await expect.poll(() => countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).toBe(1);
    expect(await readBodyHtml(page)).toBe('<p>aXd</p>');
  });

  test('Ctrl+Shift+V inside a code block inserts two lines with a newline character instead of splitting them into lines', async ({ page }) => {
    await openPasteEditor(page, '<pre><code>abcd</code></pre>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} code`, 2, 0));
    await writeClipboard(page, { 'text/plain': 'X\nY' });

    await pastePlainText(page);

    await expect.poll(() => readBodyHtml(page)).toBe('<pre><code>abX\nYcd</code></pre>');
  });

  test('Ctrl+Shift+V during IME composition changes the tree only by the composed character', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await placeCaretAt(page, at(PARAGRAPH, 2, 0));
    await writeClipboard(page, { 'text/plain': 'X' });
    await startComposition(page);
    const composed = await readBodyHtml(page);

    await pastePlainText(page);
    await waitForClipboardRead(page);

    expect(await readBodyHtml(page)).toBe(composed);
  });

  test('Ctrl+Shift+V with empty clipboard text does not change the tree', async ({ page }) => {
    await openPasteEditor(page, '<p>abcd</p>');
    await selectRange(page, at(PARAGRAPH, 1, 0), at(PARAGRAPH, 3, 0));
    await writeClipboard(page, { 'text/plain': '' });

    await pastePlainText(page);
    await waitForClipboardRead(page);

    expect(await readBodyHtml(page)).toBe('<p>abcd</p>');
  });
});
