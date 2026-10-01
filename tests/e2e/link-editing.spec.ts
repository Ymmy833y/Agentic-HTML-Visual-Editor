import { devices, expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  MESSAGE_CATALOG_ELEMENT_ID,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { ACTION_DIALOG_ELEMENT_ID } from '../../webview/ui/action-dialog';
import { COMMENT_POPUP_ELEMENT_ID } from '../../webview/ui/comment-popup';
import { FLOATING_MENU_ELEMENT_ID } from '../../webview/ui/floating-menu';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { TOOLTIP_ELEMENT_ID } from '../../webview/ui/tooltip';
import { EDITOR_ROOT, focusEditor, pressPrimaryShortcut, readBodyHtml } from './helpers/editing';
import {
  IDLE_ICON_COLOR,
  PROBE_BUNDLE_PATH,
  getOutboundMessages,
  nameIconStroke,
  openWebviewHost,
  sendToWebview,
} from './helpers/page';

// The view decides the primary modifier from the userAgent, but the Desktop Chrome descriptor returns a Windows
// userAgent whatever the OS. Registered shortcut keys and clicks with modifiers are sent as real key presses, so the
// userAgent is aligned with the running OS.
const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
test.use({ userAgent: process.platform === 'darwin' ? MAC_USER_AGENT : devices['Desktop Chrome'].userAgent });

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';
const BODY = '\n<p>abcd</p>\n';
const LINK_URL = 'https://example.test/';
// An image given a size, so the layout does not change even if it fails to load.
const IMAGE = '<img src="sample.png" alt="s" width="16" height="16">';
// A comment with the annotated text cd and a body.
const COMMENT_BODY = '<p>ab<comment id="c">cd<comment-body>note</comment-body></comment>ef</p>';

const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;
const FLOATING = `#${FLOATING_MENU_ELEMENT_ID}`;
const DIALOG = `#${ACTION_DIALOG_ELEMENT_ID}`;
const DIALOG_INPUT = `${DIALOG} input`;
const DIALOG_ALERT = `${DIALOG} [role="alert"]`;
const TOOLTIP = `#${TOOLTIP_ELEMENT_ID}`;
const POPUP = `#${COMMENT_POPUP_ELEMENT_ID}`;
const LINK_ITEM = `${TOOLBAR} [data-slot="${TOOLBAR_SLOT.link}"] > button`;
const FLOATING_LINK_ITEM = `${FLOATING} button[data-slot="${TOOLBAR_SLOT.link}"]`;
const PARAGRAPH = `${EDITOR_ROOT} p`;
const LINK = `${EDITOR_ROOT} a`;

// The follow hint naming the view platform's primary modifier. The userAgent is aligned with the OS, so the OS
// decides it.
const FOLLOW_HINT = process.platform === 'darwin'
  ? englishMessages['linkFollow.hint.mac']
  : englishMessages['linkFollow.hint.other'];

/** The colors of the light, dark and high contrast themes. */
const THEME_COLORS = [
  { background: 'rgb(255, 255, 255)', foreground: 'rgb(31, 35, 40)' },
  { background: 'rgb(31, 31, 31)', foreground: 'rgb(204, 204, 204)' },
  { background: 'rgb(0, 0, 0)', foreground: 'rgb(255, 255, 255)' },
];

declare global {
  interface Window {
    /** The forward record. Holds the code of each keydown that reached the window's bubbling phase, in order. */
    __forwardedKeys?: string[];
    /** The click record. Holds the type of each click that reached the window's bubbling phase, in order. */
    __windowClicks?: string[];
  }
}

/** The dialog's title, input field value and button labels. */
interface DialogContents {
  readonly title: string | null;
  readonly value: string;
  readonly buttons: (string | null)[];
}

/**
 * Embeds the English message catalog and then mounts the body. With the messages left as keys, the title
 * and buttons the user sees could not be checked.
 *
 * @param page The target page.
 * @param body The body to mount.
 */
async function openLinkEditor(page: Page, body: string): Promise<void> {
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
 * Places the caret in a child text of an element and moves focus to the editor root.
 *
 * @param page The target page.
 * @param selector The selector of the element.
 * @param offset The position inside the text.
 * @param childIndex Which child of the element the text is.
 */
async function placeCaretIn(page: Page, selector: string, offset: number, childIndex = 0): Promise<void> {
  await page.evaluate((argument) => {
    const node = document.querySelector(argument.selector)?.childNodes[argument.childIndex];
    if (node === undefined) {
      throw new Error(`No text found: ${argument.selector}`);
    }
    document.getElementById(argument.rootId)?.focus();
    const range = document.createRange();
    range.setStart(node, argument.offset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { selector, offset, childIndex, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Selects between two positions in child texts of elements and moves focus to the editor root.
 *
 * @param page The target page.
 * @param start The start: the element's selector, the child index and the position.
 * @param end The end: the element's selector, the child index and the position.
 */
async function selectRange(
  page: Page,
  start: readonly [string, number, number],
  end: readonly [string, number, number],
): Promise<void> {
  await page.evaluate((argument) => {
    const readNode = ([selector, childIndex]: readonly [string, number, number]): Node => {
      const node = document.querySelector(selector)?.childNodes[childIndex];
      if (node === undefined) {
        throw new Error(`No node found: ${selector}`);
      }
      return node;
    };
    const range = document.createRange();
    range.setStart(readNode(argument.start), argument.start[2]);
    range.setEnd(readNode(argument.end), argument.end[2]);
    document.getElementById(argument.rootId)?.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { start, end, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Selects part of the text that is the first child of an element.
 *
 * @param page The target page.
 * @param selector The selector of the element.
 * @param start The start position.
 * @param end The end position.
 */
async function selectIn(page: Page, selector: string, start: number, end: number): Promise<void> {
  await selectRange(page, [selector, 0, start], [selector, 0, end]);
}

/**
 * Selects the element itself. Used to select an image alone.
 *
 * @param page The target page.
 * @param selector The selector of the element.
 */
async function selectElement(page: Page, selector: string): Promise<void> {
  await page.evaluate((argument) => {
    const element = document.querySelector(argument.selector);
    if (element === null) {
      throw new Error(`No element found: ${argument.selector}`);
    }
    document.getElementById(argument.rootId)?.focus();
    const range = document.createRange();
    range.selectNode(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { selector, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Reads the title, input field value and button labels of the open dialog.
 *
 * @param page The target page.
 * @returns The contents of the dialog.
 */
async function readDialog(page: Page): Promise<DialogContents> {
  return page.locator(DIALOG).evaluate((dialog) => ({
    title: dialog.querySelector('p')?.textContent ?? null,
    value: dialog.querySelector('input')?.value ?? '',
    buttons: [...dialog.querySelectorAll('button')].map((button) => button.textContent),
  }));
}

/**
 * Types a URL into the open dialog, confirms it and waits for the dialog to close.
 *
 * @param page The target page.
 * @param url The URL to type.
 */
async function confirmUrl(page: Page, url: string): Promise<void> {
  await page.locator(DIALOG_INPUT).fill(url);
  await page.keyboard.press('Enter');
  await expect(page.locator(DIALOG)).toHaveCount(0);
}

/**
 * Imitates VS Code's key forwarding and starts recording the code of each keydown that reaches the window's
 * bubbling phase.
 *
 * @param page The target page.
 */
async function installForwardRecord(page: Page): Promise<void> {
  await page.evaluate(() => {
    const record: string[] = [];
    window.__forwardedKeys = record;
    window.addEventListener('keydown', (event) => record.push(event.code));
  });
}

/**
 * Reads the forward record.
 *
 * @param page The target page.
 * @returns The codes of the keydowns that arrived.
 */
async function readForwardedKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__forwardedKeys ?? []);
}

/**
 * Imitates the click handling VS Code injects into the view and starts recording the clicks that reach the
 * window's bubbling phase.
 *
 * Like the real handling, it prevents the default action. Otherwise a click with the primary modifier could make
 * the page open the link.
 *
 * @param page The target page.
 */
async function installClickRecord(page: Page): Promise<void> {
  await page.evaluate(() => {
    const record: string[] = [];
    window.__windowClicks = record;
    window.addEventListener('click', (event) => {
      record.push(event.type);
      event.preventDefault();
    });
  });
}

/**
 * Reads the number of clicks that reached the click record.
 *
 * @param page The target page.
 * @returns The number of clicks that arrived.
 */
async function countWindowClicks(page: Page): Promise<number> {
  return page.evaluate(() => window.__windowClicks?.length ?? 0);
}

/**
 * Reads the href of each relative link requested message sent to the host, in the order sent.
 *
 * @param page The target page.
 * @returns The hrefs of the requests.
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

/**
 * Returns how many of the messages sent to the host are of the given type.
 *
 * @param page The target page.
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
 * Calls the replace document entry and replaces the body.
 *
 * @param page The target page.
 * @param body The new body.
 */
async function replaceDocument(page: Page, body: string): Promise<void> {
  await page.evaluate((text) => window.__documentReplacementProbe?.(text), `${PROLOGUE}${body}${EPILOGUE}`);
}

/**
 * Waits until the wait that batches the follow triggers is over. The triggers are batched into one frame.
 *
 * @param page The target page.
 */
async function settleFollow(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

/**
 * Applies theme colors and reads the color the link item's icon is drawn in and the strip's background color.
 *
 * VS Code puts the theme colors on the root element, so they are put in the same place.
 *
 * @param page The target page.
 * @param colors The theme colors to apply.
 * @returns The icon's stroke color and the strip's background color.
 */
async function readLinkIconColors(
  page: Page,
  colors: { background: string; foreground: string },
): Promise<{ stroke: string; background: string }> {
  await page.evaluate((given) => {
    document.documentElement.style.setProperty('--vscode-editor-background', given.background);
    document.documentElement.style.setProperty('--vscode-editor-foreground', given.foreground);
  }, colors);

  const stroke = await nameIconStroke(
    page,
    await page.locator(`${LINK_ITEM} svg`).evaluate((element) => getComputedStyle(element).stroke),
  );
  // The page background rather than the strip's, which is translucent glass.
  const background = await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor);
  return { stroke, background };
}

test.describe('registering the entry points', () => {
  test('draws the link item icon in the theme foreground color, different from the strip background, in the light, dark and high contrast themes', async ({ page }) => {
    await openLinkEditor(page, BODY);

    const drawn: { stroke: string; background: string }[] = [];
    for (const colors of THEME_COLORS) {
      drawn.push(await readLinkIconColors(page, colors));
    }

    // Drawn in the foreground color, which differs from the background color in every theme, so it does not sink
    // into the background.
    expect(drawn).toEqual(THEME_COLORS.map(
      (colors) => ({ stroke: IDLE_ICON_COLOR, background: colors.background }),
    ));
  });

  test('opens the link dialog when primary modifier+K is pressed with a range in a paragraph, and the key does not reach the forward record', async ({ page }) => {
    await openLinkEditor(page, BODY);
    await selectIn(page, PARAGRAPH, 1, 3);
    await installForwardRecord(page);

    await pressPrimaryShortcut(page, 'KeyK');

    expect([await page.locator(DIALOG).count(), (await readForwardedKeys(page)).includes('KeyK')])
      .toEqual([1, false]);
  });

  test('does not open the dialog when primary modifier+K is pressed inside pre, and the key does not reach the forward record', async ({ page }) => {
    await openLinkEditor(page, '\n<pre><code>abcd</code></pre>\n');
    await placeCaretIn(page, `${EDITOR_ROOT} code`, 2);
    await installForwardRecord(page);

    await pressPrimaryShortcut(page, 'KeyK');

    expect([await page.locator(DIALOG).count(), (await readForwardedKeys(page)).includes('KeyK')])
      .toEqual([0, false]);
  });

  test('opens the link dialog when the floating menu link item is pressed with a range selected', async ({ page }) => {
    await openLinkEditor(page, BODY);
    await selectIn(page, PARAGRAPH, 1, 3);
    await settleFollow(page);

    await page.locator(FLOATING_LINK_ITEM).click();

    expect((await readDialog(page)).title).toBe(englishMessages['linkDialog.insertTitle']);
  });

  test('sends exactly one relative link request for a click with the primary modifier on a relative file href link, even after a document replacement', async ({ page }) => {
    await openLinkEditor(page, BODY);
    await replaceDocument(page, '\n<p>x<a href="docs/a.html">link</a>y</p>\n');

    await page.locator(LINK).click({ modifiers: ['ControlOrMeta'] });

    expect(await readRelativeLinkRequests(page)).toEqual(['docs/a.html']);
  });
});

test.describe('opening the link dialog', () => {
  test('opens a dialog titled Insert Link with Insert to confirm, an empty initial value and no remove action when the link item is pressed with a range outside links', async ({ page }) => {
    await openLinkEditor(page, BODY);
    await selectIn(page, PARAGRAPH, 1, 3);

    await page.locator(LINK_ITEM).click();

    expect(await readDialog(page)).toEqual({
      title: englishMessages['linkDialog.insertTitle'],
      value: '',
      buttons: [englishMessages['linkDialog.cancel'], englishMessages['linkDialog.insert']],
    });
  });

  test('marks the URL field as required, with the badge text from the catalog', async ({ page }) => {
    await openLinkEditor(page, BODY);
    await selectIn(page, PARAGRAPH, 1, 3);

    await page.locator(LINK_ITEM).click();

    expect(await page.locator(`${DIALOG} label`).evaluateAll((labels) => labels.map((label) => [
      label.textContent,
      label.getAttribute('data-requirement'),
      label.getAttribute('data-requirement-label'),
      label.querySelector('input')?.getAttribute('aria-required') ?? null,
    ]))).toEqual([[englishMessages['linkDialog.url'], 'required', englishMessages['actionDialog.required'], 'true']]);
  });

  test('opens a dialog titled Edit Link with Update to confirm and a remove action, whose initial value is exactly the link\'s href attribute value, at a caret inside an existing link', async ({ page }) => {
    // A relative path that is spelled differently once resolved, to show the value is the attribute value as is.
    await openLinkEditor(page, '\n<p>x<a href="docs/a%20b.html">link</a>y</p>\n');
    await placeCaretIn(page, LINK, 2);

    await page.locator(LINK_ITEM).click();

    expect(await readDialog(page)).toEqual({
      title: englishMessages['linkDialog.editTitle'],
      value: 'docs/a%20b.html',
      buttons: [
        englishMessages['linkDialog.remove'],
        englishMessages['linkDialog.cancel'],
        englishMessages['linkDialog.update'],
      ],
    });
  });

  test('opens in the edit state with an empty initial value for a range entirely inside links that spans two links', async ({ page }) => {
    await openLinkEditor(page, '\n<p><a href="a.html">ab</a><a href="b.html">cd</a></p>\n');
    await selectRange(page, [`${EDITOR_ROOT} a[href="a.html"]`, 0, 0], [`${EDITOR_ROOT} a[href="b.html"]`, 0, 2]);

    await page.locator(LINK_ITEM).click();

    const dialog = await readDialog(page);
    expect([dialog.title, dialog.value]).toEqual([englishMessages['linkDialog.editTitle'], '']);
  });

  test('opens in the insert state for a range only partly inside a link', async ({ page }) => {
    await openLinkEditor(page, '\n<p><a href="a.html">ab</a>cd</p>\n');
    await selectRange(page, [LINK, 0, 0], [PARAGRAPH, 1, 1]);

    await page.locator(LINK_ITEM).click();

    expect((await readDialog(page)).title).toBe(englishMessages['linkDialog.insertTitle']);
  });

  test('opens in the edit state when only an image inside a link is selected', async ({ page }) => {
    await openLinkEditor(page, `\n<p>x<a href="a.html">${IMAGE}</a>y</p>\n`);
    await selectElement(page, `${EDITOR_ROOT} img`);

    await page.locator(LINK_ITEM).click();

    expect((await readDialog(page)).title).toBe(englishMessages['linkDialog.editTitle']);
  });

  test('shows the link item as pressed when only an image inside a link is selected', async ({ page }) => {
    await openLinkEditor(page, `\n<p>x<a href="a.html">${IMAGE}</a>y</p>\n`);

    await selectElement(page, `${EDITOR_ROOT} img`);
    await settleFollow(page);

    await expect(page.locator(LINK_ITEM)).toHaveAttribute('aria-pressed', 'true');
  });

  test('does not open the dialog when the link item is pressed with a range of only whitespace', async ({ page }) => {
    await openLinkEditor(page, '\n<p>ab cd</p>\n');
    await selectIn(page, PARAGRAPH, 2, 3);

    await page.locator(LINK_ITEM).click();

    expect(await page.locator(DIALOG).count()).toBe(0);
  });

  test('does not open the dialog when the link item is pressed with the caret in a link inside pre', async ({ page }) => {
    await openLinkEditor(page, '\n<pre><code>x<a href="a.html">link</a>y</code></pre>\n');
    await placeCaretIn(page, LINK, 2);

    await page.locator(LINK_ITEM).click();

    expect(await page.locator(DIALOG).count()).toBe(0);
  });

  test('neither opens the dialog nor changes the tree when primary modifier+K is pressed during an IME composition', async ({ page }) => {
    await openLinkEditor(page, BODY);
    await placeCaretIn(page, PARAGRAPH, 2);
    const ime = await page.context().newCDPSession(page);
    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    const composed = await readBodyHtml(page);

    await pressPrimaryShortcut(page, 'KeyK');

    expect([await page.locator(DIALOG).count(), await readBodyHtml(page)]).toEqual([0, composed]);
  });

  test('keeps primary modifier+B and primary modifier+K pressed in the dialog\'s input field from reaching the forward record, and changes neither the field value nor the tree', async ({ page }) => {
    await openLinkEditor(page, BODY);
    await selectIn(page, PARAGRAPH, 1, 3);
    await page.locator(LINK_ITEM).click();
    await page.keyboard.type('abc');
    await installForwardRecord(page);

    await pressPrimaryShortcut(page, 'KeyB');
    await pressPrimaryShortcut(page, 'KeyK');

    const forwarded = await readForwardedKeys(page);
    expect([
      ['KeyB', 'KeyK'].filter((code) => forwarded.includes(code)),
      await page.locator(DIALOG_INPUT).inputValue(),
      await readBodyHtml(page),
    ]).toEqual([[], 'abc', BODY]);
  });

  test('moves the caret when ← is pressed in the dialog\'s input field, and the characters typed next go in at that position', async ({ page }) => {
    await openLinkEditor(page, BODY);
    await selectIn(page, PARAGRAPH, 1, 3);
    await page.locator(LINK_ITEM).click();
    await page.keyboard.type('ac');

    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('b');

    expect(await page.locator(DIALOG_INPUT).inputValue()).toBe('abc');
  });

  test('lets primary modifier+S pressed in the dialog\'s input field reach the forward record', async ({ page }) => {
    await openLinkEditor(page, BODY);
    await selectIn(page, PARAGRAPH, 1, 3);
    await page.locator(LINK_ITEM).click();
    await installForwardRecord(page);

    await pressPrimaryShortcut(page, 'KeyS');

    expect(await readForwardedKeys(page)).toContain('KeyS');
  });

  test('removes the link instead of confirming when Enter is pressed with focus on the remove button', async ({ page }) => {
    await openLinkEditor(page, '\n<p>x<a href="a.html">link</a>y</p>\n');
    await placeCaretIn(page, LINK, 2);
    await page.locator(LINK_ITEM).click();
    await page.locator(`${DIALOG} button`, { hasText: englishMessages['linkDialog.remove'] }).focus();

    await page.keyboard.press('Enter');

    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect(await readBodyHtml(page)).toBe('\n<p>xlinky</p>\n');
  });
});

test.describe('validating the URL', () => {
  test('keeps the dialog open, shows the reason asking for a URL and leaves the tree unchanged when Enter is pressed with the field empty', async ({ page }) => {
    await openLinkEditor(page, BODY);
    await selectIn(page, PARAGRAPH, 1, 3);
    await page.locator(LINK_ITEM).click();

    await page.keyboard.press('Enter');

    expect([
      await page.locator(DIALOG).count(),
      await page.locator(DIALOG_ALERT).textContent(),
      await readBodyHtml(page),
    ]).toEqual([1, englishMessages['linkDialog.urlRequired'], BODY]);
  });

  test('keeps the dialog open, shows the reason that the URL cannot be used and leaves the tree unchanged when confirming with a javascript: URL', async ({ page }) => {
    await openLinkEditor(page, BODY);
    await selectIn(page, PARAGRAPH, 1, 3);
    await page.locator(LINK_ITEM).click();

    await page.keyboard.type('javascript:alert(1)');
    await page.keyboard.press('Enter');

    expect([
      await page.locator(DIALOG).count(),
      await page.locator(DIALOG_ALERT).textContent(),
      await readBodyHtml(page),
    ]).toEqual([1, englishMessages['linkDialog.urlUnsafe'], BODY]);
  });
});

test.describe('applying the dialog result', () => {
  test('turns the selected range into a link to the trimmed URL when confirming with a URL surrounded by spaces', async ({ page }) => {
    await openLinkEditor(page, BODY);
    await selectIn(page, PARAGRAPH, 1, 3);
    await page.locator(LINK_ITEM).click();

    await confirmUrl(page, `  ${LINK_URL}  `);

    expect(await readBodyHtml(page)).toBe(`\n<p>a<a href="${LINK_URL}">bc</a>d</p>\n`);
  });

  test('changes only the href of the whole link when confirming another URL at a caret inside an existing link', async ({ page }) => {
    await openLinkEditor(page, '\n<p>x<a href="a.html">link</a>y</p>\n');
    await placeCaretIn(page, LINK, 2);
    await page.locator(LINK_ITEM).click();

    await confirmUrl(page, 'b.html');

    expect(await readBodyHtml(page)).toBe('\n<p>x<a href="b.html">link</a>y</p>\n');
  });

  test('removes the link and keeps the text when the remove button is pressed in the edit state', async ({ page }) => {
    await openLinkEditor(page, '\n<p>x<a href="a.html">link</a>y</p>\n');
    await placeCaretIn(page, LINK, 2);
    await page.locator(LINK_ITEM).click();

    await page.locator(`${DIALOG} button`, { hasText: englishMessages['linkDialog.remove'] }).click();

    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect(await readBodyHtml(page)).toBe('\n<p>xlinky</p>\n');
  });

  test('leaves the tree unchanged and sends no edit transaction when closed with Esc', async ({ page }) => {
    await openLinkEditor(page, BODY);
    await selectIn(page, PARAGRAPH, 1, 3);
    await page.locator(LINK_ITEM).click();
    await page.keyboard.type(LINK_URL);

    await page.keyboard.press('Escape');

    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect([await readBodyHtml(page), await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)])
      .toEqual([BODY, 0]);
  });

  test('wraps the image in a link when a URL is confirmed with only an image outside links selected', async ({ page }) => {
    await openLinkEditor(page, `\n<p>x${IMAGE}y</p>\n`);
    await selectElement(page, `${EDITOR_ROOT} img`);
    await page.locator(LINK_ITEM).click();

    await confirmUrl(page, LINK_URL);

    expect(await readBodyHtml(page)).toBe(`\n<p>x<a href="${LINK_URL}">${IMAGE}</a>y</p>\n`);
  });

  test('removes the link and keeps the image when removing with only an image inside a link selected', async ({ page }) => {
    await openLinkEditor(page, `\n<p>x<a href="a.html">${IMAGE}</a>y</p>\n`);
    await selectElement(page, `${EDITOR_ROOT} img`);
    await page.locator(LINK_ITEM).click();

    await page.locator(`${DIALOG} button`, { hasText: englishMessages['linkDialog.remove'] }).click();

    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect(await readBodyHtml(page)).toBe(`\n<p>x${IMAGE}y</p>\n`);
  });
});

test.describe('inserting at a position without text', () => {
  test('inserts one a whose href and text are the URL at the caret when a URL is confirmed at a caret outside links', async ({ page }) => {
    await openLinkEditor(page, BODY);
    await placeCaretIn(page, PARAGRAPH, 2);
    await page.locator(LINK_ITEM).click();

    await confirmUrl(page, LINK_URL);

    expect(await readBodyHtml(page)).toBe(`\n<p>ab<a href="${LINK_URL}">${LINK_URL}</a>cd</p>\n`);
  });

  test('leaves the selection covering exactly the inserted text after the insertion', async ({ page }) => {
    await openLinkEditor(page, BODY);
    await placeCaretIn(page, PARAGRAPH, 2);
    await page.locator(LINK_ITEM).click();

    await confirmUrl(page, LINK_URL);

    expect(await page.evaluate((selector) => {
      const selection = window.getSelection();
      const link = document.querySelector(selector);
      return [
        selection?.toString(),
        link !== null && link.contains(selection?.anchorNode ?? null) && link.contains(selection?.focusNode ?? null),
      ];
    }, LINK)).toEqual([LINK_URL, true]);
  });

  test('sends exactly one edit transaction for the insertion', async ({ page }) => {
    await openLinkEditor(page, BODY);
    await placeCaretIn(page, PARAGRAPH, 2);
    await page.locator(LINK_ITEM).click();

    await confirmUrl(page, LINK_URL);

    await expect.poll(() => countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).toBe(1);
  });

  test('creates a paragraph and puts the link in it when inserting in an empty document', async ({ page }) => {
    await openLinkEditor(page, '');
    await focusEditor(page);
    await pressPrimaryShortcut(page, 'KeyK');

    await confirmUrl(page, LINK_URL);

    expect(await page.locator(`${EDITOR_ROOT} > p > a`).evaluateAll(
      (links) => links.map((link) => [link.getAttribute('href'), link.textContent]),
    )).toEqual([[LINK_URL, LINK_URL]]);
  });

  test('wraps the run in a paragraph and puts the link at the caret when inserting inside a bare run directly under the editor root', async ({ page }) => {
    await openLinkEditor(page, 'ab');
    await placeCaretIn(page, EDITOR_ROOT, 1);
    await pressPrimaryShortcut(page, 'KeyK');

    await confirmUrl(page, LINK_URL);

    expect(await readBodyHtml(page)).toBe(`\n<p>a<a href="${LINK_URL}">${LINK_URL}</a>b</p>`);
  });

  test('puts the link outside the comment when inserting after switching to the outside at the comment end', async ({ page }) => {
    await openLinkEditor(page, COMMENT_BODY);
    await placeCaretIn(page, `${EDITOR_ROOT} comment`, 2);
    await page.keyboard.press('ArrowRight');
    await pressPrimaryShortcut(page, 'KeyK');

    await confirmUrl(page, LINK_URL);

    expect(await readBodyHtml(page)).toBe(
      `<p>ab<comment id="c">cd<comment-body>note</comment-body></comment><a href="${LINK_URL}">${LINK_URL}</a>ef</p>`,
    );
  });
});

test.describe('dispatching link clicks', () => {
  test('places the caret at the clicked position when the link text is clicked plainly, and the characters typed next go inside the link', async ({ page }) => {
    await openLinkEditor(page, '\n<p>x<a href="docs/a.html">link</a>y</p>\n');

    await page.locator(LINK).click();
    await page.keyboard.type('Z');

    // The middle of the text was clicked, so the typed character goes between the link's characters, neither
    // outside the link nor at either end.
    expect(await page.locator(LINK).textContent()).toMatch(/^l.*Z.*k$/u);
  });

  test('keeps a plain click from reaching the click record on the window\'s bubbling phase, and sends no message', async ({ page }) => {
    await openLinkEditor(page, '\n<p>x<a href="docs/a.html">link</a>y</p>\n');
    await installClickRecord(page);
    const sent = (await getOutboundMessages(page)).length;

    await page.locator(LINK).click();

    expect([await countWindowClicks(page), (await getOutboundMessages(page)).length]).toEqual([0, sent]);
  });

  test('sends one relative link request whose href is the attribute value as is, surrounding spaces included, when a relative file href link is clicked with the primary modifier', async ({ page }) => {
    await openLinkEditor(page, '\n<p>x<a href=" docs/a%20b.html ">link</a>y</p>\n');

    await page.locator(LINK).click({ modifiers: ['ControlOrMeta'] });

    expect(await readRelativeLinkRequests(page)).toEqual([' docs/a%20b.html ']);
  });

  test('keeps a click with the primary modifier on a relative file href from reaching the click record', async ({ page }) => {
    await openLinkEditor(page, '\n<p>x<a href="docs/a.html">link</a>y</p>\n');
    await installClickRecord(page);

    await page.locator(LINK).click({ modifiers: ['ControlOrMeta'] });

    expect(await countWindowClicks(page)).toBe(0);
  });

  test('sends no request and lets the click reach the click record when an https: link is clicked with the primary modifier', async ({ page }) => {
    await openLinkEditor(page, `\n<p>x<a href="${LINK_URL}">link</a>y</p>\n`);
    await installClickRecord(page);

    await page.locator(LINK).click({ modifiers: ['ControlOrMeta'] });

    expect([await readRelativeLinkRequests(page), await countWindowClicks(page)]).toEqual([[], 1]);
  });

  test('sends no request and lets the click reach the click record when a link starting with # is clicked with the primary modifier', async ({ page }) => {
    await openLinkEditor(page, '\n<p>x<a href="#top">link</a>y</p>\n');
    await installClickRecord(page);

    await page.locator(LINK).click({ modifiers: ['ControlOrMeta'] });

    expect([await readRelativeLinkRequests(page), await countWindowClicks(page)]).toEqual([[], 1]);
  });

  test('sends a request with the link\'s href when a strong inside the link is clicked with the primary modifier', async ({ page }) => {
    await openLinkEditor(page, '\n<p>x<a href="docs/a.html">li<strong>nk</strong></a>y</p>\n');

    await page.locator(`${LINK} strong`).click({ modifiers: ['ControlOrMeta'] });

    expect(await readRelativeLinkRequests(page)).toEqual(['docs/a.html']);
  });

  test('sends a request without toggling the collapsible section when a relative file href link inside summary is clicked with the primary modifier', async ({ page }) => {
    await openLinkEditor(
      page,
      '\n<details><summary>title <a href="docs/a.html">link</a></summary>\n<p>body</p>\n</details>\n',
    );

    await page.locator(LINK).click({ modifiers: ['ControlOrMeta'] });

    expect([
      await page.locator(`${EDITOR_ROOT} details`).getAttribute('open'),
      await readRelativeLinkRequests(page),
    ]).toEqual([null, ['docs/a.html']]);
  });

  test('opens the comment popup when a link inside a comment is clicked plainly, and the click does not reach the click record', async ({ page }) => {
    await openLinkEditor(
      page,
      '\n<p>x<comment id="c">a<a href="docs/a.html">link</a>b<comment-body>note</comment-body></comment>y</p>\n',
    );
    await installClickRecord(page);

    await page.locator(LINK).click();

    await expect(page.locator(POPUP)).toBeVisible();
    expect(await countWindowClicks(page)).toBe(0);
  });

  test('sends no request and keeps the click from the click record when a link is clicked with only Shift', async ({ page }) => {
    await openLinkEditor(page, '\n<p>x<a href="docs/a.html">link</a>y</p>\n');
    await installClickRecord(page);

    await page.locator(LINK).click({ modifiers: ['Shift'] });

    expect([await readRelativeLinkRequests(page), await countWindowClicks(page)]).toEqual([[], 0]);
  });

  test('sends a request when a relative file href link is clicked with the primary modifier and Shift', async ({ page }) => {
    await openLinkEditor(page, '\n<p>x<a href="docs/a.html">link</a>y</p>\n');

    await page.locator(LINK).click({ modifiers: ['ControlOrMeta', 'Shift'] });

    expect(await readRelativeLinkRequests(page)).toEqual(['docs/a.html']);
  });

  test('sends two requests when a relative file href link is double-clicked with the primary modifier held', async ({ page }) => {
    await openLinkEditor(page, '\n<p>x<a href="docs/a.html">link</a>y</p>\n');

    await page.locator(LINK).dblclick({ modifiers: ['ControlOrMeta'] });

    expect(await readRelativeLinkRequests(page)).toEqual(['docs/a.html', 'docs/a.html']);
  });
});

test.describe('the hover tooltip', () => {
  test('shows one follow hint naming the platform\'s primary modifier after the delay when the pointer rests on a link', async ({ page }) => {
    await openLinkEditor(page, '\n<p>x<a href="docs/a.html">link</a>y</p>\n');

    await page.locator(LINK).hover();

    await expect(page.locator(TOOLTIP)).toHaveCount(1);
    expect(await page.locator(TOOLTIP).allTextContents()).toEqual([FOLLOW_HINT]);
  });

  test('aligns the tooltip\'s left edge with the link\'s left edge when shown over a strong near the end of the link', async ({ page }) => {
    await openLinkEditor(page, '\n<p>x<a href="docs/a.html">a long link text <strong>bold</strong></a>y</p>\n');

    await page.locator(`${LINK} strong`).hover();
    await expect(page.locator(TOOLTIP)).toHaveCount(1);

    const [tooltip, link] = await Promise.all([
      page.locator(TOOLTIP).boundingBox(),
      page.locator(LINK).boundingBox(),
    ]);
    expect(Math.abs((tooltip?.x ?? Number.NaN) - (link?.x ?? Number.NaN))).toBeLessThan(1);
  });

  test('keeps the tooltip shown without restarting the delay when the pointer moves from the text to a strong in the same link', async ({ page }) => {
    await openLinkEditor(page, '\n<p>x<a href="docs/a.html">a long link text <strong>bold</strong></a>y</p>\n');
    await page.locator(LINK).hover({ position: { x: 2, y: 5 } });
    await expect(page.locator(TOOLTIP)).toHaveCount(1);

    await page.locator(`${LINK} strong`).hover();

    // Count without waiting, to confirm the delay did not restart.
    expect(await page.locator(TOOLTIP).count()).toBe(1);
  });

  test('hides the tooltip when the pointer moves onto an abbr with a title inside the link', async ({ page }) => {
    await openLinkEditor(page, '\n<p>x<a href="docs/a.html">a long link <abbr title="HyperText">HT</abbr></a>y</p>\n');
    await page.locator(LINK).hover({ position: { x: 2, y: 5 } });
    await expect(page.locator(TOOLTIP)).toHaveCount(1);

    await page.locator(`${LINK} abbr`).hover();

    await expect(page.locator(TOOLTIP)).toHaveCount(0);
  });

  test('leaves the editor root\'s innerHTML as it was right after opening after a hover and a plain click on a link', async ({ page }) => {
    await openLinkEditor(page, '\n<p>x<a href="docs/a.html">link</a>y</p>\n');
    const opened = await readBodyHtml(page);

    await page.locator(LINK).hover();
    await expect(page.locator(TOOLTIP)).toHaveCount(1);
    await page.locator(LINK).click();

    expect(await readBodyHtml(page)).toBe(opened);
  });
});
