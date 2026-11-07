import { devices, expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { HOST_TO_VIEW_MESSAGE_TYPE, MESSAGE_CATALOG_ELEMENT_ID, VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import type { MessageKey } from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { ACTION_DIALOG_ELEMENT_ID } from '../../webview/ui/action-dialog';
import { ALERT_MESSAGE_KEY } from '../../webview/ui/alert-items';
import { BLOCK_KIND_MESSAGE_KEY, BLOCK_TYPE_MENU_CLASS } from '../../webview/ui/block-type-menu';
import { CODE_BLOCK_COPY_ELEMENT_ID } from '../../webview/ui/code-block-copy';
import { COMMENT_POPUP_ELEMENT_ID } from '../../webview/ui/comment-popup';
import { DIAGRAM_ZOOM_ELEMENT_ID } from '../../webview/ui/diagram-zoom';
import { FLOATING_MENU_ELEMENT_ID } from '../../webview/ui/floating-menu';
import { TABLE_MENU_ELEMENT_ID } from '../../webview/ui/table-menu';
import { TABLE_PICKER_CLASS } from '../../webview/ui/table-picker';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import type { ToolbarSlot } from '../../webview/ui/toolbar-slots';
import { FIELD_UNAVAILABLE_SLOTS } from '../../webview/ui/toolbar-state';
import { TOOLTIP_ELEMENT_ID } from '../../webview/ui/tooltip';
import { EDITOR_ROOT, paste, pressPrimaryShortcut, readBodyHtml, writeClipboard } from './helpers/editing';
import { FIXTURE_DIRECTORY_URL, PROBE_BUNDLE_PATH, getOutboundMessages, openWebviewHost, sendToWebview } from './helpers/page';

// The view decides the primary modifier from userAgent, but the Desktop Chrome descriptor returns a Windows userAgent
// on every OS. To send the format keys as real key presses, match userAgent to the running OS. Pastes read the real
// clipboard, so reading and writing it are allowed.
const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
test.use({
  userAgent: process.platform === 'darwin' ? MAC_USER_AGENT : devices['Desktop Chrome'].userAgent,
  permissions: ['clipboard-read', 'clipboard-write'],
});

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const POPUP = `#${COMMENT_POPUP_ELEMENT_ID}`;
const FLOATING = `#${FLOATING_MENU_ELEMENT_ID}`;
const DIALOG = `#${ACTION_DIALOG_ELEMENT_ID}`;
const TOOLTIP = `#${TOOLTIP_ELEMENT_ID}`;
const COMMENT = `${EDITOR_ROOT} comment`;
const BODY_FIELD = `${POPUP} [role="textbox"][aria-label="${englishMessages['commentThread.bodyField']}"]`;
const REPLY_FIELD = `${POPUP} [role="textbox"][aria-label="${englishMessages['commentThread.replyField']}"]`;
const EDIT_FIELD = `${POPUP} [role="textbox"][aria-label="${englishMessages['commentThread.editField']}"]`;
const RESOLVED = `${POPUP} button[aria-label="${englishMessages['commentThread.resolved']}"]`;
const BLOCK_TYPE_MENU = `.${BLOCK_TYPE_MENU_CLASS}`;
const TABLE_MENU = `#${TABLE_MENU_ELEMENT_ID}`;
const TABLE_GRID = `#${TOOLBAR_ELEMENT_ID} .${TABLE_PICKER_CLASS} [role="grid"]`;
const LAST_REPLY = `${COMMENT} > comment-reply:last-of-type`;
const COPY_BUTTON = `#${CODE_BLOCK_COPY_ELEMENT_ID}`;
const ZOOM_IN = `#${DIAGRAM_ZOOM_ELEMENT_ID} button[aria-label="${englishMessages['diagramZoom.zoomIn']}"]`;

// A comment with only a human body.
const HUMAN_COMMENT = '<p>x<comment id="c-1">ab<comment-body contenteditable="false" data-author="human" '
  + 'data-updated="2026-01-01T00:00:00.000Z">note</comment-body></comment>y</p>';

// A clipboard whose HTML form carries bold, a list and a colored span, as a copy from another page does.
const FORMATTED_CLIPBOARD = {
  'text/html': '<p><span style="font-weight: 700">bold</span> text</p>\n<ul>\n  <li>one</li>\n'
    + '  <li><span style="color: rgb(255, 0, 0)">two</span></li>\n</ul>\n',
  'text/plain': 'bold text\none\ntwo',
};

// A flowchart Mermaid draws.
const FLOWCHART = 'flowchart TD\n  A --> B';

// A 50×50 image in the fixture directory, and a document URI in a directory below it, so that the path is resolved
// against the document rather than the page.
const IMAGE_PATH = '../sample.png';
const NESTED_DOCUMENT_URI = `${FIXTURE_DIRECTORY_URL}docs/page.html`;

/**
 * Embeds the English message catalog and then mounts the body, so that the fields can be found by the names the user
 * sees.
 *
 * @param page Page to operate.
 * @param body Body to mount.
 * @param documentUri The document URI. Relative paths of images are not resolved if empty.
 */
async function openCommentEditor(page: Page, body: string, documentUri = ''): Promise<void> {
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
    resourceRootUri: documentUri === '' ? '' : FIXTURE_DIRECTORY_URL,
  });
}

/**
 * Opens the popup by clicking the annotated text, and types into the reply field.
 *
 * @param page Page to operate.
 * @param text Text to type. Nothing is typed when empty.
 */
async function typeReply(page: Page, text: string): Promise<void> {
  await page.locator(COMMENT).first().click({ position: { x: 2, y: 5 } });
  await expect(page.locator(POPUP)).toBeVisible();
  await page.locator(REPLY_FIELD).click();
  if (text !== '') {
    await page.keyboard.type(text);
  }
}

/**
 * Reads the number of formatting elements in a field and the texts of its non-empty paragraphs.
 *
 * @param page Page to operate.
 * @param selector The field.
 * @returns The count of strong, ul and span elements, and the paragraph texts.
 */
async function readFieldTexts(page: Page, selector: string): Promise<[number, string[]]> {
  return page.locator(selector).evaluate((field) => [
    field.querySelectorAll('strong, ul, span').length,
    [...field.querySelectorAll('p')].map((paragraph) => paragraph.textContent).filter((text) => text !== ''),
  ]);
}

/**
 * Selects characters before the caret by pressing Shift+← once per character.
 *
 * @param page Page to operate.
 * @param count Number of characters.
 */
async function selectBackward(page: Page, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press('Shift+ArrowLeft');
  }
}

/**
 * Returns the button of a fixed toolbar item.
 *
 * @param slot The slot.
 * @returns The selector.
 */
function toolbarItem(slot: ToolbarSlot): string {
  return `#${TOOLBAR_ELEMENT_ID} [data-slot="${slot}"] > button`;
}

/**
 * Opens the block type menu and presses one of its items.
 *
 * @param page Page to operate.
 * @param key Message key of the item.
 */
async function chooseBlockTypeItem(page: Page, key: MessageKey): Promise<void> {
  await page.locator(toolbarItem(TOOLBAR_SLOT.blockType)).click();
  await page.locator(`${BLOCK_TYPE_MENU} button[aria-label="${englishMessages[key]}"]`).click();
}

/**
 * Reads the HTML of the blocks in the template of an entry.
 *
 * @param page Page to operate.
 * @param selector The entry.
 * @returns The HTML of the template content, or `undefined` when the entry holds no template.
 */
async function readTemplateHtml(page: Page, selector: string): Promise<string | undefined> {
  return page.locator(selector).evaluate((entry) => entry.querySelector('template')?.innerHTML);
}

/**
 * Reads the hrefs of the relative link requests sent to the host, in the order sent.
 *
 * @param page Page to operate.
 * @returns The hrefs.
 */
async function readRelativeLinkRequests(page: Page): Promise<unknown[]> {
  const messages = await getOutboundMessages(page);
  return messages.flatMap((message) => (
    typeof message === 'object'
    && message !== null
    && Reflect.get(message, 'type') === VIEW_TO_HOST_MESSAGE_TYPE.relativeLinkRequested
      ? [Reflect.get(message, 'href')]
      : []
  ));
}

test.describe('Formatting in a comment field', () => {
  test('selecting text in the reply field and pressing bold on the toolbar keeps the popup open and makes the text bold, and Enter writes and shows the reply with it', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await typeReply(page, 'see this');
    await selectBackward(page, 4);

    await page.locator(toolbarItem(TOOLBAR_SLOT.bold)).click();

    await expect(page.locator(POPUP)).toBeVisible();
    await expect(page.locator(REPLY_FIELD)).toBeFocused();
    const formatted = await page.locator(REPLY_FIELD).innerHTML();
    await page.keyboard.press('Enter');
    expect([
      formatted,
      await page.locator(`${COMMENT} > comment-reply`).innerHTML(),
      await page.locator(`${POPUP} .comment-popup-entry`).last().innerHTML(),
    ]).toEqual(['<p>see <strong>this</strong></p>', 'see <strong>this</strong>', '<p>see <strong>this</strong></p>']);
  });

  test('pressing Ctrl+B in the reply field and then typing makes the typed characters bold', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await typeReply(page, 'a');

    await pressPrimaryShortcut(page, 'B');
    await page.keyboard.type('bc');

    expect(await page.locator(REPLY_FIELD).innerHTML()).toBe('<p>a<strong>bc</strong></p>');
  });

  test('committing an IME composition after Ctrl+B in the reply field makes the committed characters bold and leaves no zero width space', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await typeReply(page, '');
    await pressPrimaryShortcut(page, 'B');
    const ime = await page.context().newCDPSession(page);

    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    await ime.send('Input.insertText', { text: '亜' });

    await expect.poll(() => page.locator(REPLY_FIELD).evaluate((field) => [
      field.querySelector('strong')?.textContent,
      field.textContent,
    ])).toEqual(['亜', '亜']);
  });

  test('selecting text in the reply field shows the floating menu above the popup, inline code wraps the text in code, and the comment item cannot be pressed', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await typeReply(page, 'run npm');

    await selectBackward(page, 3);

    const button = page.locator(`${FLOATING} button[data-slot="${TOOLBAR_SLOT.inlineCode}"]`);
    await expect(button).toBeVisible();
    // The center of the button is over the popup, and it is the button that a press there hits.
    const stacking = await button.evaluate((element, popupSelector) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const popup = document.querySelector(popupSelector)?.getBoundingClientRect();
      const overPopup = popup !== undefined && x >= popup.left && x <= popup.right && y >= popup.top && y <= popup.bottom;
      return [overPopup, element.contains(document.elementFromPoint(x, y))];
    }, POPUP);
    await button.click();
    expect([
      stacking,
      await page.locator(REPLY_FIELD).innerHTML(),
      await page.locator(`${FLOATING} button[data-slot="${TOOLBAR_SLOT.comment}"]`).getAttribute('aria-disabled'),
    ]).toEqual([[true, true], '<p>run <code>npm</code></p>', 'true']);
  });

  test('while the reply field has focus, only the sidebar, save, comment, copy and PDF items cannot be pressed, and pressing one neither closes the popup nor changes the tree; leaving the field makes them pressable again', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await typeReply(page, 'abc');
    const before = await readBodyHtml(page);
    await expect(page.locator(toolbarItem(TOOLBAR_SLOT.save))).toHaveAttribute('aria-disabled', 'true');
    const slots = await page.locator(`#${TOOLBAR_ELEMENT_ID} [data-slot] > button`).evaluateAll((buttons) => buttons
      .filter((button) => button.getAttribute('aria-disabled') === 'true')
      .map((button) => button.parentElement?.getAttribute('data-slot')));

    // The item is disabled, so the actionability check that waits for an enabled element is skipped.
    await page.locator(toolbarItem(TOOLBAR_SLOT.comment)).click({ force: true });

    await expect(page.locator(POPUP)).toBeVisible();
    expect([new Set(slots), await readBodyHtml(page)]).toEqual([new Set(FIELD_UNAVAILABLE_SLOTS), before]);
    await page.locator(RESOLVED).focus();
    await expect(page.locator(toolbarItem(TOOLBAR_SLOT.save))).toHaveAttribute('aria-disabled', 'false');
  });

  test('moving the selection in the reply field onto and off bold text changes the pressed state of the bold item to match', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await typeReply(page, '');
    await pressPrimaryShortcut(page, 'B');
    await page.keyboard.type('ab');
    await pressPrimaryShortcut(page, 'B');
    await page.keyboard.type('cd');
    const bold = page.locator(toolbarItem(TOOLBAR_SLOT.bold));

    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await expect(bold).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('End');

    await expect(bold).toHaveAttribute('aria-pressed', 'false');
    expect(await page.locator(REPLY_FIELD).innerHTML()).toBe('<p><strong>ab</strong>cd</p>');
  });

  test('selecting text in the reply field and confirming a URL from Ctrl+K wraps the text in a link, and focus and the selection return to the field', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await typeReply(page, 'see docs');
    await selectBackward(page, 4);

    await pressPrimaryShortcut(page, 'K');
    await page.locator(`${DIALOG} input`).fill('https://example.com/');
    await page.keyboard.press('Enter');

    await expect(page.locator(DIALOG)).toHaveCount(0);
    await expect(page.locator(REPLY_FIELD)).toBeFocused();
    const selected = await page.locator(REPLY_FIELD).evaluate((field) => {
      const selection = window.getSelection();
      return selection !== null && field.contains(selection.anchorNode) ? selection.toString() : undefined;
    });
    expect([await page.locator(REPLY_FIELD).innerHTML(), selected])
      .toEqual(['<p>see <a href="https://example.com/">docs</a></p>', 'docs']);
  });

  test('editing an entry with code and a link opens the field with them, and committing after changing other text keeps code and the link with its attributes', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p>x<comment id="c-1">ab<comment-body data-author="human">see <code>x</code> and '
      + '<a href="docs/a.html" title="t">doc</a></comment-body></comment>y</p>',
    );
    await page.locator(COMMENT).click({ position: { x: 2, y: 5 } });
    await page.locator(`${POPUP} .comment-thread-entry`).first()
      .getByRole('button', { name: englishMessages['commentThread.editEntry'], exact: true })
      .click();
    await expect(page.locator(EDIT_FIELD)).toBeFocused();
    const opened = await page.locator(EDIT_FIELD).innerHTML();

    await page.keyboard.press('Home');
    await page.keyboard.type('Please ');
    await page.keyboard.press('Enter');

    expect([opened, await page.locator(`${COMMENT} > comment-body`).innerHTML()]).toEqual([
      '<p>see <code>x</code> and <a href="docs/a.html" title="t">doc</a></p>',
      'Please see <code>x</code> and <a href="docs/a.html" title="t">doc</a>',
    ]);
  });

  test('pasting HTML with bold, a list and a colored span into the reply field puts them in as a paste into the document does, and Ctrl+Shift+V puts in only the text', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await typeReply(page, '');
    const clipboard = {
      'text/html': '<p><span style="font-weight: 700">bold</span> text</p>\n<ul>\n  <li>one</li>\n'
        + '  <li><span style="color: rgb(255, 0, 0)">two</span></li>\n</ul>\n',
      'text/plain': 'bold text\none\ntwo',
    };

    await paste(page, clipboard);
    const pasted = await page.locator(REPLY_FIELD).evaluate((field) => [
      field.querySelector('strong')?.textContent,
      [...field.querySelectorAll('ul > li')].map((item) => item.textContent),
      field.querySelector('li span')?.getAttribute('style'),
    ]);
    await page.keyboard.press('Escape');
    await writeClipboard(page, clipboard);
    await page.keyboard.press('ControlOrMeta+Shift+V');

    await expect.poll(() => page.locator(REPLY_FIELD).evaluate((field) => [
      field.querySelectorAll('strong, ul, span').length,
      [...field.querySelectorAll('p')].map((paragraph) => paragraph.textContent).filter((text) => text !== ''),
    ])).toEqual([0, ['bold text', 'one', 'two']]);
    expect(pasted).toEqual(['bold', ['one', 'two'], 'color: rgb(255, 0, 0);']);
  });

  test('Ctrl+Shift+V in the empty body field of a comment just made from the toolbar puts in only the text', async ({ page }) => {
    await openCommentEditor(page, '<p>abcd</p>');
    await page.locator(`${EDITOR_ROOT} p`).evaluate((paragraph) => {
      const text = paragraph.firstChild;
      const root = paragraph.parentElement;
      const selection = window.getSelection();
      if (text === null || root === null || selection === null) {
        return;
      }
      root.focus();
      const range = document.createRange();
      range.setStart(text, 1);
      range.setEnd(text, 3);
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.locator(toolbarItem(TOOLBAR_SLOT.comment)).click();
    await expect(page.locator(BODY_FIELD)).toBeFocused();
    await writeClipboard(page, FORMATTED_CLIPBOARD);

    await page.keyboard.press('ControlOrMeta+Shift+V');

    await expect.poll(() => readFieldTexts(page, BODY_FIELD)).toEqual([0, ['bold text', 'one', 'two']]);
  });

  test('Ctrl+Shift+V in the edit field of an entry puts in only the text', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await page.locator(COMMENT).click({ position: { x: 2, y: 5 } });
    await page.locator(`${POPUP} .comment-thread-entry`).first()
      .getByRole('button', { name: englishMessages['commentThread.editEntry'], exact: true })
      .click();
    await expect(page.locator(EDIT_FIELD)).toBeFocused();
    await page.keyboard.press('ControlOrMeta+A');
    await writeClipboard(page, FORMATTED_CLIPBOARD);

    await page.keyboard.press('ControlOrMeta+Shift+V');

    await expect.poll(() => readFieldTexts(page, EDIT_FIELD)).toEqual([0, ['bold text', 'one', 'two']]);
  });

  test('dropping HTML with a colored span and bold into the reply field puts it in at the drop position as a paste does and places the caret after it', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await typeReply(page, 'ab');
    const data = {
      'text/html': '<p><span style="color: rgb(255, 0, 0)">red</span> <span style="font-weight: 700">bold</span></p>',
      'text/plain': 'red bold',
    };

    // The drop position is between the two typed characters while the caret stays after them, so only the drop
    // position can put the content there.
    const stopped = await page.locator(REPLY_FIELD).evaluate((field, argument) => {
      const transfer = new DataTransfer();
      for (const [type, value] of Object.entries(argument)) {
        transfer.setData(type, value);
      }
      const typed = field.querySelector('p')?.firstChild;
      if (typed === null || typed === undefined) {
        return false;
      }
      const event = new InputEvent('beforeinput', {
        inputType: 'insertFromDrop',
        dataTransfer: transfer,
        targetRanges: [new StaticRange({ startContainer: typed, startOffset: 1, endContainer: typed, endOffset: 1 })],
        cancelable: true,
        bubbles: true,
      });
      field.dispatchEvent(event);
      return event.defaultPrevented;
    }, data);
    const dropped = await page.locator(REPLY_FIELD).evaluate((field) => field.querySelector('strong')?.textContent);
    await page.keyboard.type('!');

    expect([stopped, dropped, await page.locator(`${REPLY_FIELD} > p`).allTextContents()])
      .toEqual([true, 'bold', ['a', 'red bold!', 'b']]);
  });

  test('choosing Heading 2 from Block Type in the reply field keeps the popup open and makes a heading, and Enter writes a reply with the heading in a template and shows it as a heading', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await typeReply(page, 'title');

    await chooseBlockTypeItem(page, BLOCK_KIND_MESSAGE_KEY.heading2);
    await expect(page.locator(POPUP)).toBeVisible();
    await expect(page.locator(REPLY_FIELD)).toBeFocused();
    const field = await page.locator(REPLY_FIELD).innerHTML();
    await page.keyboard.press('Enter');

    expect([
      field,
      await readTemplateHtml(page, LAST_REPLY),
      await page.locator(`${POPUP} .comment-popup-entry`).last().innerHTML(),
    ]).toEqual(['<h2>title</h2>', '\n<h2>title</h2>\n', '<h2>title</h2>']);
  });

  test('Shift+Enter in the reply field splits the paragraph, and Enter writes a reply in the line form with a line break between the paragraphs', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await typeReply(page, 'one');

    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('two');
    const paragraphs = await page.locator(`${REPLY_FIELD} > p`).allTextContents();
    await page.keyboard.press('Enter');

    expect([paragraphs, await page.locator(LAST_REPLY).innerHTML()]).toEqual([['one', 'two'], 'one\ntwo']);
  });

  test('Tab in a bulleted list of the reply field nests the item, and Tab outside a list moves focus within the popup', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await typeReply(page, 'x');
    await page.keyboard.press('Tab');
    const leftField = await page.locator(REPLY_FIELD).evaluate((field) => document.activeElement !== field);
    await page.locator(REPLY_FIELD).click();
    await page.keyboard.press('End');

    await page.locator(toolbarItem(TOOLBAR_SLOT.bulletList)).click();
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('y');
    await page.keyboard.press('Tab');

    await expect(page.locator(REPLY_FIELD)).toBeFocused();
    expect([leftField, await page.locator(`${REPLY_FIELD} ul > li > ul > li`).textContent()]).toEqual([true, 'y']);
  });

  test('a table inserted in the reply field moves to the next cell with Tab, takes a row from the table menu, and pressing the menu does not close the popup', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await typeReply(page, '');

    await page.locator(toolbarItem(TOOLBAR_SLOT.table)).click();
    await page.locator(`${TABLE_GRID} [role="row"]:nth-child(1) [role="gridcell"]:nth-child(2)`).click();
    await page.keyboard.type('a');
    await page.keyboard.press('Tab');
    await page.keyboard.type('b');
    await page.locator(`${REPLY_FIELD} td`).first().click({ button: 'right' });
    await page.locator(`${TABLE_MENU} [role="menuitem"]`, { hasText: englishMessages['tableMenu.insertRowBelow'] }).click();

    await expect(page.locator(POPUP)).toBeVisible();
    expect([
      await page.locator(`${REPLY_FIELD} tr`).first().locator('td').allTextContents(),
      await page.locator(`${REPLY_FIELD} tr`).count(),
    ]).toEqual([['a', 'b'], 2]);
  });

  test('a code block, a horizontal rule, a collapsible section and an alert made in the reply field are written in the template of each reply', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await typeReply(page, 'code');
    await page.locator(toolbarItem(TOOLBAR_SLOT.codeBlock)).click();
    await page.keyboard.press('Enter');
    await page.locator(REPLY_FIELD).click();
    await page.locator(toolbarItem(TOOLBAR_SLOT.horizontalRule)).click();
    await page.keyboard.press('Enter');
    await page.locator(REPLY_FIELD).click();
    await page.locator(toolbarItem(TOOLBAR_SLOT.details)).click();
    // An empty section shows nothing, so it would not be written.
    await page.keyboard.type('more');
    await page.keyboard.press('Enter');
    await page.locator(REPLY_FIELD).click();
    await page.keyboard.type('note');
    await chooseBlockTypeItem(page, ALERT_MESSAGE_KEY.note);

    await page.keyboard.press('Enter');

    const blocks = await page.locator(`${COMMENT} > comment-reply`).evaluateAll((replies) => replies.map((reply) => {
      const content = reply.querySelector('template')?.content;
      return content === undefined ? undefined : [...content.children].map((child) => child.localName);
    }));
    expect([
      blocks.map((names) => names?.filter((name) => name !== 'p')),
      await page.locator(`${COMMENT} > comment-reply:last-of-type`).evaluate(
        (reply) => reply.querySelector('template')?.content.querySelector('blockquote')?.getAttribute('data-alert'),
      ),
    ]).toEqual([[['pre'], ['hr'], ['details'], ['blockquote']], 'note']);
  });

  test('a diagram inserted in the reply field is drawn, a click on it opens its dialog, and closing the dialog puts focus back in the reply field', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await typeReply(page, '');

    await page.locator(toolbarItem(TOOLBAR_SLOT.diagram)).click();
    await page.locator(`${DIALOG} textarea`).fill(FLOWCHART);
    await page.locator(`${DIALOG} textarea`).press('Enter');
    await expect(page.locator(DIALOG)).toHaveCount(0);
    await expect(page.locator(REPLY_FIELD)).toBeFocused();
    await expect.poll(() => page.locator(`${REPLY_FIELD} pre`).evaluate(
      (block) => block.hasAttributeNS('urn:ahve:diagram', 'data-ahve-diagram'),
    )).toBe(true);
    await page.locator(`${REPLY_FIELD} pre`).click({ force: true });
    const opened = await page.locator(`${DIALOG} textarea`).inputValue();
    await page.keyboard.press('Escape');

    await expect(page.locator(DIALOG)).toHaveCount(0);
    await expect(page.locator(REPLY_FIELD)).toBeFocused();
    expect(opened).toBe(FLOWCHART);
  });

  test('an image inserted in the reply field is shown, and the reply is written with the source as entered and shown with the image', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT, NESTED_DOCUMENT_URI);
    await typeReply(page, '');

    await page.locator(toolbarItem(TOOLBAR_SLOT.image)).click();
    await page.getByLabel(englishMessages['imageDialog.source'], { exact: true }).fill(IMAGE_PATH);
    await page.keyboard.press('Enter');
    await expect(page.locator(REPLY_FIELD)).toBeFocused();
    await expect.poll(() => page.locator(`${REPLY_FIELD} img`).evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    await page.keyboard.press('Enter');

    await expect.poll(() => page.locator(`${POPUP} .comment-popup-entry img`).last().evaluate(
      (image: HTMLImageElement) => image.naturalWidth,
    )).toBeGreaterThan(0);
    expect(await page.locator(LAST_REPLY).innerHTML()).toBe(`<img src="${IMAGE_PATH}">`);
  });

  test('editing an entry in the block form opens the field with its blocks, and committing after changing its text keeps the blocks', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p>x<comment id="c-1">ab<comment-body data-author="human"><template>\n<h2>title</h2>\n<ul><li>item</li></ul>\n'
      + '</template></comment-body></comment>y</p>',
    );
    await page.locator(COMMENT).click({ position: { x: 2, y: 5 } });
    await page.locator(`${POPUP} .comment-thread-entry`).first()
      .getByRole('button', { name: englishMessages['commentThread.editEntry'], exact: true })
      .click();
    await expect(page.locator(EDIT_FIELD)).toBeFocused();
    const opened = await page.locator(EDIT_FIELD).innerHTML();

    await page.keyboard.type('s');
    await page.keyboard.press('Enter');

    expect([opened, await readTemplateHtml(page, `${COMMENT} > comment-body`)]).toEqual([
      '<h2>title</h2><ul><li>item</li></ul>',
      '\n<h2>title</h2>\n<ul><li>items</li></ul>\n',
    ]);
  });

  test('pressing the copy button of a code block and a zoom button of a diagram in the edit field copies and zooms, keeps the popup open and leaves focus in the field', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p>x<comment id="c-1">ab<comment-body data-author="human"><template>\n<pre><code>code</code></pre>\n'
      + '<pre class="mermaid">flowchart TD\n  A --&gt; B</pre>\n</template></comment-body></comment>y</p>',
    );
    await page.locator(COMMENT).click({ position: { x: 2, y: 5 } });
    await page.locator(`${POPUP} .comment-thread-entry`).first()
      .getByRole('button', { name: englishMessages['commentThread.editEntry'], exact: true })
      .click();
    await expect(page.locator(EDIT_FIELD)).toBeFocused();
    await page.locator(`${EDIT_FIELD} pre`).first().hover();
    await page.locator(COPY_BUTTON).click();
    await expect.poll(async () => (await getOutboundMessages(page)).flatMap((message) => (
      typeof message === 'object'
      && message !== null
      && Reflect.get(message, 'type') === VIEW_TO_HOST_MESSAGE_TYPE.codeBlockCopyRequested
        ? [Reflect.get(message, 'text')]
        : []
    ))).toEqual(['code']);
    const openAfterCopy = await page.locator(POPUP).isVisible();
    await expect.poll(() => page.locator(`${EDIT_FIELD} pre`).last().evaluate(
      (block) => block.hasAttributeNS('urn:ahve:diagram', 'data-ahve-diagram'),
    )).toBe(true);
    await page.locator(`${EDIT_FIELD} pre`).last().hover({ force: true });

    await page.locator(ZOOM_IN).click();

    await expect.poll(() => page.locator(`${EDIT_FIELD} pre`).last().evaluate(
      (block) => block.hasAttributeNS('urn:ahve:diagram', 'data-ahve-diagram-zoomed'),
    )).toBe(true);
    await expect(page.locator(EDIT_FIELD)).toBeFocused();
    expect([openAfterCopy, await page.locator(POPUP).isVisible()]).toEqual([true, true]);
  });

  test('a relative link in an entry sends one relative link request on Ctrl/Cmd+click, hovering tells how to open it, and a plain click opens editing', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p>x<comment id="c-1">ab<comment-body data-author="human">see <a href="docs/a.html">doc</a></comment-body></comment>y</p>',
    );
    await page.locator(COMMENT).click({ position: { x: 2, y: 5 } });
    const link = page.locator(`${POPUP} .comment-popup-entry a`);

    await link.hover();
    await expect(page.locator(TOOLTIP)).toHaveText(
      englishMessages[process.platform === 'darwin' ? 'linkFollow.hint.mac' : 'linkFollow.hint.other'],
    );
    await link.click({ modifiers: ['ControlOrMeta'] });
    const editAfterModified = await page.locator(EDIT_FIELD).count();
    await link.click();

    // The plain click neither follows the link nor sends a second request.
    await expect(page.locator(EDIT_FIELD)).toBeVisible();
    expect([await readRelativeLinkRequests(page), editAfterModified]).toEqual([['docs/a.html'], 0]);
  });
});
