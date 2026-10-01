import { devices, expect, test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';

import {
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  MESSAGE_CATALOG_ELEMENT_ID,
} from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { ACTION_DIALOG_ELEMENT_ID } from '../../webview/ui/action-dialog';
import { COMMENT_CARET_MARK_NAME, COMMENT_CARET_MARK_NAMESPACE } from '../../webview/ui/comment-caret';
import { COMMENT_POPUP_ELEMENT_ID } from '../../webview/ui/comment-popup';
import { FLOATING_MENU_ELEMENT_ID } from '../../webview/ui/floating-menu';
import {
  EDITOR_ROOT,
  deleteWordBackward,
  dispatchBeforeInput,
  installReceiver,
  paste,
  pressPrimaryShortcut,
  readBodyHtml,
  readRecord,
} from './helpers/editing';
import { PROBE_BUNDLE_PATH, openWebviewHost, sendToWebview } from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const POPUP = `#${COMMENT_POPUP_ELEMENT_ID}`;
const FLOATING = `#${FLOATING_MENU_ELEMENT_ID}`;
const DIALOG = `#${ACTION_DIALOG_ELEMENT_ID}`;
const COMMENT = `${EDITOR_ROOT} comment`;
const ENTRY_TEXT = `${POPUP} .comment-popup-entry`;
const META = `${POPUP} .comment-thread-meta`;
const EDIT_FIELD = `${POPUP} textarea[aria-label="${englishMessages['commentThread.editField']}"]`;
const REPLY_FIELD = `${POPUP} textarea[aria-label="${englishMessages['commentThread.replyField']}"]`;
const RESOLVED = `${POPUP} button[aria-label="${englishMessages['commentThread.resolved']}"]`;

// A paragraph with one comment that has characters before and after it. The starting point for most cases.
const BODY = '<p>ab<comment id="c">cd<comment-body>note</comment-body></comment>ef</p>';

// A comment at the end of a block.
const END_OF_BLOCK = '<p>ab<comment id="c">cd<comment-body>note</comment-body></comment></p>';

// A comment with empty annotated text.
const EMPTY_COMMENT = '<p>ab<comment id="c"><comment-body>note</comment-body></comment>ef</p>';

// Threads with a human entry and an AI entry. The entry text has two words because it is selected by dragging.
const HUMAN_THREAD = '<p>x<comment id="c">ab<comment-body data-author="human" '
  + 'data-updated="2026-01-01T00:00:00.000Z">hello world</comment-body></comment>y</p><p id="tail">tail</p>';
const AI_THREAD = '<p>x<comment id="c">ab<comment-body data-author="ai" '
  + 'data-updated="2026-01-01T00:00:00.000Z">ai note</comment-body></comment>y</p>';

// Settings to end a composition without committing. An empty composition text ends it without a commit.
const CANCEL_COMPOSITION = { text: '', selectionStart: -1, selectionEnd: -1 };

/**
 * Theme variables for light, dark, and high contrast. They include the comment and chart colors, so the tests also show
 * that the author colors do not follow them.
 */
const THEMES: { readonly variables: Record<string, string> }[] = [
  {
    variables: {
      '--vscode-editor-background': '#ffffff',
      '--vscode-editor-foreground': '#3b3b3b',
      '--vscode-editorCommentsWidget-unresolvedBorder': '#005fb8',
      '--vscode-charts-purple': '#652d90',
      '--vscode-charts-orange': '#d18616',
      '--vscode-charts-blue': '#0063d3',
    },
  },
  {
    variables: {
      '--vscode-editor-background': '#1f1f1f',
      '--vscode-editor-foreground': '#cccccc',
      '--vscode-editorCommentsWidget-unresolvedBorder': '#3794ff',
      '--vscode-charts-purple': '#b180d7',
      '--vscode-charts-orange': '#cd861a',
      '--vscode-charts-blue': '#59a4f9',
    },
  },
  {
    variables: {
      '--vscode-editor-background': '#000000',
      '--vscode-editor-foreground': '#ffffff',
      '--vscode-editorCommentsWidget-unresolvedBorder': '#6fc3df',
      '--vscode-charts-purple': '#b180d7',
      '--vscode-charts-blue': '#59a4f9',
    },
  },
];

// The author colors, the same in every theme: orange for human and blue for AI.
const HUMAN_COLOR = 'rgb(217, 119, 6)';
const AI_COLOR = 'rgb(30, 120, 190)';

// The view decides the primary modifier from the userAgent, but the Desktop Chrome descriptor returns a Windows userAgent on every OS.
// Word deletes and paste are pressed with real keys, so match the userAgent to the running OS and allow clipboard reads and writes.
const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
test.use({
  userAgent: process.platform === 'darwin' ? MAC_USER_AGENT : devices['Desktop Chrome'].userAgent,
  permissions: ['clipboard-read', 'clipboard-write'],
});

declare global {
  interface Window {
    /** The forwarding record: the code of each keydown that reached window's bubbling phase and whether its default was prevented at that point. */
    __forwardedKeyRecords?: [string, boolean][];
    /** A record of whether each copy that reached window had its default prevented. */
    __copyPrevented?: boolean[];
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
 * @param selector The element's selector.
 * @param offset The position's offset.
 * @param childIndex For a text position, the index of that child of the element.
 * @returns The position.
 */
function at(selector: string, offset: number, childIndex?: number): Point {
  return { selector, offset, childIndex };
}

/**
 * Embeds the English message catalog and then mounts the body.
 *
 * With messages left as keys, fields cannot be found by the names users see.
 *
 * @param page The page to operate on.
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
        throw new Error(`node not found: ${point.selector}`);
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
 * Reads the text from the start of the editor root to the caret, excluding entries. Used in place of the visual caret position.
 *
 * @param page The page to operate on.
 * @returns The text. `null` if there is no selection.
 */
async function readVisiblePrefix(page: Page): Promise<string | null> {
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
    const fragment = before.cloneContents();
    for (const entry of fragment.querySelectorAll('comment-body, comment-reply')) {
      entry.remove();
    }
    return fragment.textContent;
  }, EDITOR_ROOT_ELEMENT_ID);
}

/**
 * Reads whether the caret is inside a comment.
 *
 * @param page The page to operate on.
 * @returns `true` if an ancestor of the selection anchor is a comment.
 */
async function isCaretInComment(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const node = window.getSelection()?.anchorNode ?? null;
    const element = node instanceof Element ? node : node?.parentElement ?? null;
    return element?.closest('comment') !== null && element !== null;
  });
}

/**
 * Waits until the selection change has been evaluated. Selection changes arrive as a task, and evaluation happens in the next frame.
 *
 * @param page The page to operate on.
 */
async function waitForCaretEvaluation(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    }, 0);
  }));
}

/**
 * Reads the value of the mark on the editor root.
 *
 * @param page The page to operate on.
 * @returns The mark value. `null` if none.
 */
async function readCaretMark(page: Page): Promise<string | null> {
  return page.evaluate((argument) => document.getElementById(argument.rootId)
    ?.getAttributeNS(argument.namespace, argument.name) ?? null, {
    rootId: EDITOR_ROOT_ELEMENT_ID,
    namespace: COMMENT_CARET_MARK_NAMESPACE,
    name: COMMENT_CARET_MARK_NAME,
  });
}

/**
 * Reads the caret color (computed value) of the editor root.
 *
 * @param page The page to operate on.
 * @returns The computed value of `caret-color`.
 */
async function readCaretColor(page: Page): Promise<string> {
  return page.locator(EDITOR_ROOT).evaluate((root) => getComputedStyle(root).caretColor);
}

/**
 * Applies theme variables. VS Code puts them on the root element, so they are put there here too.
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
 * Mimics VS Code's forwarding and starts recording the code of each keydown that reaches window's bubbling phase and whether its default was prevented.
 *
 * @param page The page to operate on.
 */
async function installForwardRecord(page: Page): Promise<void> {
  await page.evaluate(() => {
    const record: [string, boolean][] = [];
    window.__forwardedKeyRecords = record;
    window.addEventListener('keydown', (event) => record.push([event.code, event.defaultPrevented]));
  });
}

/**
 * Reads the forwarding record.
 *
 * @param page The page to operate on.
 * @returns The code of each keydown that arrived and whether its default was prevented.
 */
async function readForwardedKeys(page: Page): Promise<[string, boolean][]> {
  return page.evaluate(() => window.__forwardedKeyRecords ?? []);
}

/**
 * Reads the body output.
 *
 * @param page The page to operate on.
 * @returns The body output. Empty before mounting.
 */
async function readBodyOutput(page: Page): Promise<string> {
  return page.evaluate(() => window.__serializationProbe?.()?.body ?? '');
}

/**
 * Replaces the body through the replace-document entry point.
 *
 * @param page The page to operate on.
 * @param body The new body.
 * @returns Whether it was replaced.
 */
async function replaceDocument(page: Page, body: string): Promise<boolean> {
  return page.evaluate((text) => window.__documentReplacementProbe?.(text) ?? false, `${PROLOGUE}${body}${EPILOGUE}`);
}

/**
 * Opens a session for driving the browser's IME.
 *
 * @param page The page to operate on.
 * @returns The opened session.
 */
async function openImeSession(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/**
 * Composes one character with the IME and commits it.
 *
 * @param ime The IME session.
 */
async function composeAndCommit(ime: CDPSession): Promise<void> {
  await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
  await ime.send('Input.insertText', { text: '亜' });
}

/**
 * Clicks the annotated text to open the popup. Focus stays in the editor root.
 *
 * @param page The page to operate on.
 * @param selector The comment's selector.
 */
async function openByClick(page: Page, selector: string = COMMENT): Promise<void> {
  await page.locator(selector).first().click({ position: { x: 2, y: 5 } });
  await expect(page.locator(POPUP)).toBeVisible();
}

/**
 * Drags over an element's text from just inside the left edge of the first character to just inside the right edge of the last character.
 *
 * Dragging past the text would select up to the boundary of the following section.
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
 * Reads the annotated text of each comment, excluding entries.
 *
 * @param page The page to operate on.
 * @returns The annotated texts (in document order).
 */
async function readAnnotatedTexts(page: Page): Promise<string[]> {
  return page.locator(COMMENT).evaluateAll((comments) => comments.map((comment) => [...comment.childNodes]
    .filter((child) => !(child instanceof Element && ['comment-body', 'comment-reply'].includes(child.localName)))
    .map((child) => child.textContent)
    .join('')));
}

test.describe('Deleting from the caret keeps entries', () => {
  test('Backspace just after a comment removes only the last annotated character, keeps the entries, and characters typed next go outside the comment', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 2));

    await page.keyboard.press('Backspace');
    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">c<comment-body>note</comment-body></comment>Xef</p>');
  });

  test('Delete just before a comment removes only the first annotated character and keeps the entries', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 1));

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">d<comment-body>note</comment-body></comment>ef</p>');
  });

  test('Backspace just before and Delete just after a comment remove only one character outside the comment, keep the entries, and characters typed next go outside the comment', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p id="before">ab<comment id="c1">cd<comment-body>n1</comment-body></comment>ef</p>'
      + '<p id="after">gh<comment id="c2">ij<comment-body>n2</comment-body></comment>kl</p>',
    );
    await placeCaretAt(page, at(`${EDITOR_ROOT} #before`, 1));
    await page.keyboard.press('Backspace');
    await page.keyboard.type('X');
    await placeCaretAt(page, at(`${EDITOR_ROOT} #after`, 2));
    await page.keyboard.press('Delete');

    await page.keyboard.type('Y');

    expect([
      await page.locator(`${EDITOR_ROOT} #before`).innerHTML(),
      await page.locator(`${EDITOR_ROOT} #after`).innerHTML(),
    ]).toEqual([
      'aX<comment id="c1">cd<comment-body>n1</comment-body></comment>ef',
      'gh<comment id="c2">ij<comment-body>n2</comment-body></comment>Yl',
    ]);
  });

  test('a backward word delete just after a comment removes only the last annotated character', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 2));

    await deleteWordBackward(page);

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">c<comment-body>note</comment-body></comment>ef</p>');
  });

  test('Backspace inside at the start removes the character just before the comment, keeps the entries, and characters typed next go outside the comment', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await placeCaretAt(page, at(COMMENT, 0, 0));

    await page.keyboard.press('Backspace');
    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe('<p>aX<comment id="c">cd<comment-body>note</comment-body></comment>ef</p>');
  });

  test('Delete inside at the end removes the character just after the comment and keeps the entries', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await placeCaretAt(page, at(COMMENT, 2, 0));

    await page.keyboard.press('Delete');

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">cd<comment-body>note</comment-body></comment>f</p>');
  });

  test('a backward word delete inside at the end removes only one word of the annotated text and keeps the word before the comment', async ({ page }) => {
    await openCommentEditor(page, '<p>ab<comment id="c">cd<comment-body>note</comment-body></comment> ef</p>');
    await placeCaretAt(page, at(COMMENT, 2, 0));

    await deleteWordBackward(page);

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c"><comment-body>note</comment-body></comment> ef</p>');
  });

  test('a backward word delete at a non-edge position where a word crosses the comment end removes only the part outside the comment and keeps the entries', async ({ page }) => {
    await openCommentEditor(page, '<p>x <comment id="c">ab<comment-body>note</comment-body></comment>cd ef</p>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 2, 2));

    await deleteWordBackward(page);

    expect(await readBodyHtml(page)).toBe('<p>x <comment id="c">ab<comment-body>note</comment-body></comment> ef</p>');
  });

  test('deleting all of the annotated text with Backspace keeps the comment and its entries', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 2));

    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c"><comment-body>note</comment-body></comment>ef</p>');
  });

  test('a line delete in a block with a comment has its default prevented and leaves the tree unchanged, while one in a block without a comment is not prevented', async ({ page }) => {
    const body = `${BODY}<p id="plain">plain</p>`;
    await openCommentEditor(page, body);
    await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 1, 0));
    const withComment = await dispatchBeforeInput(page, 'deleteSoftLineBackward');
    const tree = await readBodyHtml(page);
    await placeCaretAt(page, at(`${EDITOR_ROOT} #plain`, 3, 0));
    const withoutComment = await dispatchBeforeInput(page, 'deleteSoftLineBackward');

    expect([withComment, tree, withoutComment]).toEqual([true, body, false]);
  });

  test('Backspace inside at the start of a comment at the paragraph start merges with the previous paragraph and keeps the entries', async ({ page }) => {
    await openCommentEditor(page, '<p>ab</p><p><comment id="c">cd<comment-body>note</comment-body></comment>ef</p>');
    await placeCaretAt(page, at(COMMENT, 0, 0));

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">cd<comment-body>note</comment-body></comment>ef</p>');
  });

  test('Backspace just after a comment with empty annotated text removes the character before the comment and keeps the comment and its entries', async ({ page }) => {
    await openCommentEditor(page, EMPTY_COMMENT);
    await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 2));

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('<p>a<comment id="c"><comment-body>note</comment-body></comment>ef</p>');
  });

  test('one Backspace just after a comment sends exactly one view edited message of kind deleteContentBackward', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await installReceiver(page);
    await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 2));

    await page.keyboard.press('Backspace');

    expect((await readRecord(page)).kinds).toEqual(['deleteContentBackward']);
  });

  test('Backspace just after a comment in a collapsible section title or body, a cell, or a list item also keeps the entries', async ({ page }) => {
    await openCommentEditor(
      page,
      '<details open=""><summary>t<comment id="s">ab<comment-body>n1</comment-body></comment>x</summary>'
      + '<p>b<comment id="d">cd<comment-body>n2</comment-body></comment>y</p></details>'
      + '<table><tbody><tr><td>c<comment id="t">ef<comment-body>n3</comment-body></comment>z</td></tr></tbody></table>'
      + '<ul><li>d<comment id="l">gh<comment-body>n4</comment-body></comment>w</li></ul>',
    );

    for (const parent of ['summary', 'details > p', 'td', 'li']) {
      await placeCaretAt(page, at(`${EDITOR_ROOT} ${parent}`, 2));
      await page.keyboard.press('Backspace');
    }

    expect([
      await readAnnotatedTexts(page),
      await page.locator(`${COMMENT} > comment-body`).allTextContents(),
    ]).toEqual([['a', 'c', 'e', 'g'], ['n1', 'n2', 'n3', 'n4']]);
  });

  test('a backward word delete inside at the end of the inner comment of a (hand-written) nesting deletes up to the inner boundary and keeps both sets of entries', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p>x<comment id="o">ab<comment id="i">cd<comment-body>ni</comment-body></comment>'
      + '<comment-body>no</comment-body></comment>y</p>',
    );
    await placeCaretAt(page, at(`${EDITOR_ROOT} #i`, 2, 0));

    await deleteWordBackward(page);

    expect(await readBodyHtml(page)).toBe(
      '<p>x<comment id="o">ab<comment id="i"><comment-body>ni</comment-body></comment>'
      + '<comment-body>no</comment-body></comment>y</p>',
    );
  });
});

test.describe('Range deletion keeps entries', () => {
  test('deleting with Backspace a range from the middle of the annotated text to after the comment keeps the entries and the comment element', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await selectRange(page, at(COMMENT, 1, 0), at(`${EDITOR_ROOT} p`, 1, 2));

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">c<comment-body>note</comment-body></comment>f</p>');
  });

  test('deleting a range that fully contains a comment removes the comment together with its entries', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await selectRange(page, at(`${EDITOR_ROOT} p`, 1, 0), at(`${EDITOR_ROOT} p`, 1, 2));

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('<p>af</p>');
  });

  test('deleting a range covering part of a comment and a table keeps both the entries and the table skeleton', async ({ page }) => {
    await openCommentEditor(page, `${BODY}<table><tbody><tr><td>gh</td></tr></tbody></table>`);
    await selectRange(page, at(COMMENT, 1, 0), at(`${EDITOR_ROOT} td`, 1, 0));

    await page.keyboard.press('Backspace');

    expect([
      await page.locator(`${COMMENT} > comment-body`).allTextContents(),
      await page.locator(`${EDITOR_ROOT} table > tbody > tr > td`).count(),
    ]).toEqual([['note'], 1]);
  });

  test('pasting into and pressing Enter on a range covering part of a comment also keep the entries', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p id="paste">ab<comment id="c1">cd<comment-body>n1</comment-body></comment>ef</p>'
      + '<p id="enter">gh<comment id="c2">ij<comment-body>n2</comment-body></comment>kl</p>',
    );
    await selectRange(page, at(`${EDITOR_ROOT} #c1`, 1, 0), at(`${EDITOR_ROOT} #paste`, 1, 2));
    await paste(page, { 'text/plain': 'Z' });
    await selectRange(page, at(`${EDITOR_ROOT} #c2`, 1, 0), at(`${EDITOR_ROOT} #enter`, 1, 2));

    await page.keyboard.press('Enter');

    expect(await page.locator(`${COMMENT} > comment-body`).allTextContents()).toEqual(['n1', 'n2']);
  });
});

test.describe('Input at comment edges and into comment-crossing ranges', () => {
  test('characters typed after pressing → inside at the end go outside the comment, and characters typed after ← back go inside the comment', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await placeCaretAt(page, at(COMMENT, 2, 0));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('X');
    await placeCaretAt(page, at(COMMENT, 2, 0));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');

    await page.keyboard.type('Y');

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">cdY<comment-body>note</comment-body></comment>Xef</p>');
  });

  test('characters typed after pressing → just before a comment go at the start of the annotated text', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 1));
    await page.keyboard.press('ArrowRight');

    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">Xcd<comment-body>note</comment-body></comment>ef</p>');
  });

  test('Shift+Enter inside at the end of a comment at the block end puts the line break inside the comment, shows the caret on the new line, and characters typed next go inside the comment on that line', async ({ page }) => {
    await openCommentEditor(page, END_OF_BLOCK);
    await placeCaretAt(page, at(COMMENT, 2, 0));

    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('X');

    const placed = await page.locator(COMMENT).evaluate((comment) => {
      const rectOf = (text: string): DOMRect | undefined => {
        const node = [...comment.childNodes].find((child) => child instanceof Text && child.data.includes(text));
        if (node === undefined) {
          return undefined;
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect();
      };
      const first = rectOf('cd');
      const typed = rectOf('X');
      return [typed !== undefined, first !== undefined && typed !== undefined && typed.top > first.bottom - 1];
    });
    expect(placed).toEqual([true, true]);
  });

  test('typing a space just after a comment at the block end advances the caret by one space and inserts the space as U+00A0', async ({ page }) => {
    await openCommentEditor(page, END_OF_BLOCK);
    await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 2));

    await page.keyboard.type(' ');

    // Compare the end of the annotated text with the caret position just after the inserted space. If the space collapsed, they would be at the same position.
    const advanced = await page.locator(`${EDITOR_ROOT} p`).evaluate((paragraph) => {
      const annotated = paragraph.querySelector('comment')?.firstChild ?? null;
      const typed = paragraph.lastChild;
      const caretAt = (node: Node): DOMRect | undefined => {
        const range = document.createRange();
        range.setStart(node, node.textContent?.length ?? 0);
        return range.getClientRects()[0];
      };
      const before = annotated === null ? undefined : caretAt(annotated);
      const after = typed === null ? undefined : caretAt(typed);
      return before !== undefined && after !== undefined && after.left > before.left + 1;
    });
    expect([await readBodyHtml(page), advanced])
      .toEqual(['<p>ab<comment id="c">cd<comment-body>note</comment-body></comment>&nbsp;</p>', true]);
  });

  test('typing words in a row inside at the end of a comment at the block end inserts the spaces between words as normal spaces', async ({ page }) => {
    await openCommentEditor(page, END_OF_BLOCK);
    await placeCaretAt(page, at(COMMENT, 2, 0));

    await page.keyboard.type(' aa bb');

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">cd aa bb<comment-body>note</comment-body></comment></p>');
  });

  test('typing into a comment-crossing range deletes the range, keeps the entries, and inserts the character at the start', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await selectRange(page, at(COMMENT, 1, 0), at(`${EDITOR_ROOT} p`, 1, 2));

    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">cX<comment-body>note</comment-body></comment>f</p>');
  });

  test('replacing a comment-touching range with Shift+Enter also keeps the entries', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await selectRange(page, at(`${EDITOR_ROOT} p`, 2), at(`${EDITOR_ROOT} p`, 1, 2));

    await page.keyboard.press('Shift+Enter');

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">cd<comment-body>note</comment-body></comment><br>f</p>');
  });

  test('in a paragraph with a trailing empty line, the empty line remains whether typing just after a comment or into a comment-crossing range', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p id="caret">ab<comment id="c1">cd<comment-body>n1</comment-body></comment>ef<br><br></p>'
      + '<p id="range">gh<comment id="c2">ij<comment-body>n2</comment-body></comment>kl<br><br></p>',
    );
    await placeCaretAt(page, at(`${EDITOR_ROOT} #caret`, 2));
    await page.keyboard.type('X');
    await selectRange(page, at(`${EDITOR_ROOT} #range`, 1, 0), at(`${EDITOR_ROOT} #c2`, 1, 0));

    await page.keyboard.type('Y');

    expect([
      await page.locator(`${EDITOR_ROOT} #caret`).innerHTML(),
      await page.locator(`${EDITOR_ROOT} #range`).innerHTML(),
    ]).toEqual([
      'ab<comment id="c1">cd<comment-body>n1</comment-body></comment>Xef<br><br>',
      'gY<comment id="c2">j<comment-body>n2</comment-body></comment>kl<br><br>',
    ]);
  });

  test('one keystroke at a comment edge sends exactly one view edited message of kind insertText', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await installReceiver(page);
    await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 2));

    await page.keyboard.type('X');

    expect((await readRecord(page)).kinds).toEqual(['insertText']);
  });

  test('at comment edges in a collapsible section title and a cell, characters also go on the chosen side', async ({ page }) => {
    await openCommentEditor(
      page,
      '<details open=""><summary>t<comment id="s">ab<comment-body>n</comment-body></comment>x</summary><p>body</p></details>'
      + '<table><tbody><tr><td>c<comment id="t">ef<comment-body>m</comment-body></comment>z</td></tr></tbody></table>',
    );
    await placeCaretAt(page, at(`${EDITOR_ROOT} #s`, 2, 0));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('X');
    await placeCaretAt(page, at(`${EDITOR_ROOT} td`, 2));
    await page.keyboard.press('ArrowLeft');

    await page.keyboard.type('Y');

    expect([
      await page.locator(`${EDITOR_ROOT} summary`).innerHTML(),
      await page.locator(`${EDITOR_ROOT} td`).innerHTML(),
    ]).toEqual([
      't<comment id="s">ab<comment-body>n</comment-body></comment>Xx',
      'c<comment id="t">efY<comment-body>m</comment-body></comment>z',
    ]);
  });
});

test.describe('Adjusting IME composition start', () => {
  test('committing an IME composition after pressing → inside at the end puts the character outside the comment and leaves no zero-width space', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await placeCaretAt(page, at(COMMENT, 2, 0));
    await page.keyboard.press('ArrowRight');
    const ime = await openImeSession(page);

    await composeAndCommit(ime);

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">cd<comment-body>note</comment-body></comment>亜ef</p>');
  });

  test('committing an IME composition inside at the start puts the character at the start of the annotated text', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await placeCaretAt(page, at(COMMENT, 0, 0));
    const ime = await openImeSession(page);

    await composeAndCommit(ime);

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">亜cd<comment-body>note</comment-body></comment>ef</p>');
  });

  test('starting and committing a composition on a comment-crossing range does not delete the range, puts the character at the start, and keeps the entries', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await selectRange(page, at(COMMENT, 1, 0), at(`${EDITOR_ROOT} p`, 1, 2));
    const ime = await openImeSession(page);

    await composeAndCommit(ime);

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">c亜d<comment-body>note</comment-body></comment>ef</p>');
  });

  test('ending a composition at a comment edge without committing leaves the tree as before the composition and sends no view edited message', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await installReceiver(page);
    await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 2));
    const ime = await openImeSession(page);
    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });

    await ime.send('Input.imeSetComposition', CANCEL_COMPOSITION);

    expect([await readBodyHtml(page), (await readRecord(page)).kinds]).toEqual([BODY, []]);
  });
});

test.describe('Switching the comment side', () => {
  test('→ inside at the end moves the caret to the outside neighbor without changing its visual position, and the next → advances one character by default', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await placeCaretAt(page, at(COMMENT, 2, 0));
    const before = await readVisiblePrefix(page);

    await page.keyboard.press('ArrowRight');
    const switched = [await readVisiblePrefix(page), await isCaretInComment(page)];
    await page.keyboard.press('ArrowRight');

    expect([before, switched, await readVisiblePrefix(page)]).toEqual(['abcd', ['abcd', false], 'abcde']);
  });

  test('a → that switches the side does not reach VS Code, and a → that does not becomes the default caret movement', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await installForwardRecord(page);
    await placeCaretAt(page, at(COMMENT, 2, 0));

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    expect([await readForwardedKeys(page), await readVisiblePrefix(page)]).toEqual([[['ArrowRight', false]], 'abcde']);
  });

  test('→ during IME composition is not taken over even at a position where a switch applies', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await placeCaretAt(page, at(COMMENT, 2, 0));
    await installForwardRecord(page);
    const ime = await openImeSession(page);
    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });

    await page.keyboard.press('ArrowRight');

    expect((await readForwardedKeys(page)).map(([code]) => code)).toContain('ArrowRight');
  });

  test('characters typed after pressing → once and twice before a comment with empty annotated text go inside and after the comment respectively', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p id="once">ab<comment id="c1"><comment-body>n1</comment-body></comment>ef</p>'
      + '<p id="twice">ab<comment id="c2"><comment-body>n2</comment-body></comment>ef</p>',
    );
    await placeCaretAt(page, at(`${EDITOR_ROOT} #once`, 1));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('X');
    await placeCaretAt(page, at(`${EDITOR_ROOT} #twice`, 1));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    await page.keyboard.type('Y');

    expect([
      await page.locator(`${EDITOR_ROOT} #once`).innerHTML(),
      await page.locator(`${EDITOR_ROOT} #twice`).innerHTML(),
    ]).toEqual([
      'ab<comment id="c1">X<comment-body>n1</comment-body></comment>ef',
      'ab<comment id="c2"><comment-body>n2</comment-body></comment>Yef',
    ]);
  });

  test('committing an IME composition after pressing ← just after a comment with line breaks around its entries puts the character before the body', async ({ page }) => {
    await openCommentEditor(page, '<p>ab<comment id="c">cd\n<comment-body>note</comment-body>\n</comment>ef</p>');
    await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 2));
    await page.keyboard.press('ArrowLeft');
    const ime = await openImeSession(page);

    await composeAndCommit(ime);

    // The unrendered line break after the body is removed by the browser when it inserts the committed character.
    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">cd\n亜<comment-body>note</comment-body></comment>ef</p>');
  });

  test('← and → inside the popup reply field move the field\'s caret, and outside the fields they move to the previous and next comments', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p>x<comment id="c1">ab<comment-body>one</comment-body></comment> '
      + '<comment id="c2">cd<comment-body>two</comment-body></comment>y</p>',
    );
    await openByClick(page, `${EDITOR_ROOT} #c1`);
    await page.locator(REPLY_FIELD).click();
    await page.keyboard.type('rs');
    await page.keyboard.press('ArrowLeft');
    const afterLeft = await page.locator(REPLY_FIELD).evaluate((field) => (field instanceof HTMLTextAreaElement ? field.selectionStart : -1));
    await page.keyboard.press('ArrowRight');
    const afterRight = await page.locator(REPLY_FIELD).evaluate((field) => (field instanceof HTMLTextAreaElement ? field.selectionStart : -1));
    // A reply in progress would be committed by the move, so clear it before leaving the field.
    await page.locator(REPLY_FIELD).fill('');
    await page.locator(RESOLVED).focus();

    await page.keyboard.press('ArrowRight');

    await expect(page.locator(ENTRY_TEXT)).toHaveText(['two']);
    expect([afterLeft, afterRight]).toEqual([1, 2]);
  });

  test('for comments in a collapsible section title or body, → also switches to the outside neighbor', async ({ page }) => {
    await openCommentEditor(
      page,
      '<details open=""><summary>t<comment id="s">ab<comment-body>n</comment-body></comment>x</summary>'
      + '<p>b<comment id="d">cd<comment-body>m</comment-body></comment>y</p></details>',
    );
    const switched: boolean[] = [];
    for (const selector of ['#s', '#d']) {
      await placeCaretAt(page, at(`${EDITOR_ROOT} ${selector}`, 2, 0));
      await page.keyboard.press('ArrowRight');
      switched.push(await page.evaluate((commentSelector) => {
        const comment = document.querySelector(commentSelector);
        const selection = window.getSelection();
        const parent = comment?.parentNode ?? null;
        if (comment === null || selection === null || parent === null) {
          return false;
        }
        return selection.anchorNode === parent && selection.anchorOffset === [...parent.childNodes].indexOf(comment) + 1;
      }, `${EDITOR_ROOT} ${selector}`));
    }

    expect(switched).toEqual([true, true]);
  });

  test('pasting after pressing → inside at the end to move outside puts the pasted characters outside the comment', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await placeCaretAt(page, at(COMMENT, 2, 0));
    await page.keyboard.press('ArrowRight');

    await paste(page, { 'text/plain': 'Z' });

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">cd<comment-body>note</comment-body></comment>Zef</p>');
  });
});

test.describe('Comment caret color', () => {
  test('in light, dark, and high contrast, the caret inside human and AI threads takes each author\'s color, the outside neighbor takes the default color, and both inside colors differ from the default', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p>x<comment id="h">ab<comment-body data-author="human">n</comment-body></comment>y'
      + '<comment id="a">cd<comment-body data-author="ai">m</comment-body></comment>z</p>',
    );

    const drawn: unknown[] = [];
    for (const theme of THEMES) {
      await applyTheme(page, theme.variables);
      await placeCaretAt(page, at(`${EDITOR_ROOT} #h`, 1, 0));
      await waitForCaretEvaluation(page);
      const human = await readCaretColor(page);
      await placeCaretAt(page, at(`${EDITOR_ROOT} #a`, 1, 0));
      await waitForCaretEvaluation(page);
      const ai = await readCaretColor(page);
      await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 2));
      await waitForCaretEvaluation(page);
      const outside = await readCaretColor(page);
      drawn.push([human, ai, human !== outside, ai !== outside]);
    }

    expect(drawn).toEqual(THEMES.map(() => [HUMAN_COLOR, AI_COLOR, true, true]));
  });

  test('→ inside at the end turns the caret to the default color, and ← back turns it to the inside color', async ({ page }) => {
    await openCommentEditor(page, '<p>x<comment id="h">ab<comment-body data-author="human">n</comment-body></comment>y</p>');
    await placeCaretAt(page, at(COMMENT, 2, 0));
    await waitForCaretEvaluation(page);
    const inside = await readCaretMark(page);

    await page.keyboard.press('ArrowRight');
    await waitForCaretEvaluation(page);
    const outside = await readCaretMark(page);
    await page.keyboard.press('ArrowLeft');
    await waitForCaretEvaluation(page);

    expect([inside, outside, await readCaretMark(page)]).toEqual(['human', null, 'human']);
  });

  test('changing to a range selection from inside the annotated text removes the mark from the editor root', async ({ page }) => {
    await openCommentEditor(page, '<p>x<comment id="h">abc<comment-body data-author="human">n</comment-body></comment>y</p>');
    await placeCaretAt(page, at(COMMENT, 1, 0));
    await waitForCaretEvaluation(page);
    const inside = await readCaretMark(page);

    await page.keyboard.press('Shift+ArrowRight');
    await waitForCaretEvaluation(page);

    expect([inside, await readCaretMark(page)]).toEqual(['human', null]);
  });

  test('moving the caret into and out of a comment sends no view edited message and the mark does not appear in the body output', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await installReceiver(page);
    await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 1, 0));
    await waitForCaretEvaluation(page);
    await placeCaretAt(page, at(COMMENT, 1, 0));
    await waitForCaretEvaluation(page);
    const marked = await readCaretMark(page);

    await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 1, 2));
    await waitForCaretEvaluation(page);

    expect([marked, (await readRecord(page)).kinds, (await readBodyOutput(page)).includes(COMMENT_CARET_MARK_NAME)])
      .toEqual(['human', [], false]);
  });

  test('for comments in a collapsible section title or body, the caret inside also takes the inside color', async ({ page }) => {
    await openCommentEditor(
      page,
      '<details open=""><summary>t<comment id="s">ab<comment-body data-author="ai">n</comment-body></comment>x</summary>'
      + '<p>b<comment id="d">cd<comment-body data-author="human">m</comment-body></comment>y</p></details>',
    );
    await placeCaretAt(page, at(`${EDITOR_ROOT} #s`, 1, 0));
    await waitForCaretEvaluation(page);
    const title = await readCaretColor(page);

    await placeCaretAt(page, at(`${EDITOR_ROOT} #d`, 1, 0));
    await waitForCaretEvaluation(page);

    expect([title, await readCaretColor(page)]).toEqual([AI_COLOR, HUMAN_COLOR]);
  });

  test('when restoring the selection after document replacement puts it outside the annotated text, the mark is removed', async ({ page }) => {
    await openCommentEditor(page, BODY);
    await placeCaretAt(page, at(COMMENT, 1, 0));
    await waitForCaretEvaluation(page);
    const inside = await readCaretMark(page);

    await replaceDocument(page, '<p>abcdef</p>');
    await waitForCaretEvaluation(page);

    expect([inside, await readCaretMark(page)]).toEqual(['human', null]);
  });
});

test.describe('Presses inside the popup', () => {
  test('clicking a human entry text opens the edit field with that text', async ({ page }) => {
    await openCommentEditor(page, HUMAN_THREAD);
    await openByClick(page);

    await page.locator(ENTRY_TEXT).click();

    await expect(page.locator(EDIT_FIELD)).toHaveValue('hello world');
  });

  test('dragging to select an entry text keeps the selection without opening the edit field, the Ctrl+C copy arrives without its default prevented, and the selected text is the text chosen', async ({ page }) => {
    await openCommentEditor(page, HUMAN_THREAD);
    await openByClick(page);
    await page.evaluate(() => {
      const record: boolean[] = [];
      window.__copyPrevented = record;
      window.addEventListener('copy', (event) => record.push(event.defaultPrevented));
    });
    await dragAcross(page, ENTRY_TEXT);

    await pressPrimaryShortcut(page, 'C');

    expect([
      await page.locator(EDIT_FIELD).count(),
      await page.evaluate(() => window.__copyPrevented ?? []),
      await page.evaluate(() => window.getSelection()?.toString()),
    ]).toEqual([0, [false], 'hello world']);
  });

  test('dragging to select text inside the popup does not show the floating menu', async ({ page }) => {
    await openCommentEditor(page, HUMAN_THREAD);
    await openByClick(page);

    await dragAcross(page, ENTRY_TEXT);
    await waitForCaretEvaluation(page);

    await expect(page.locator(FLOATING)).toBeHidden();
  });

  test('dragging a range from the popup into the editor root shows no menu and does not open the edit field', async ({ page }) => {
    await openCommentEditor(page, HUMAN_THREAD);
    await openByClick(page);
    const entry = await page.locator(ENTRY_TEXT).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + 1, y: (rect.top + rect.bottom) / 2 };
    });
    const target = await page.locator(`${EDITOR_ROOT} p`).first().evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + 2, y: (rect.top + rect.bottom) / 2 };
    });

    await page.mouse.move(entry.x, entry.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.up();
    await waitForCaretEvaluation(page);

    expect([await page.locator(FLOATING).isVisible(), await page.locator(EDIT_FIELD).count()]).toEqual([false, 0]);
  });

  test('clicking an AI entry text opens the confirmation, and confirming opens the edit field', async ({ page }) => {
    await openCommentEditor(page, AI_THREAD);
    await openByClick(page);

    await page.locator(ENTRY_TEXT).click();
    await expect(page.locator(DIALOG)).toBeVisible();
    await page.locator(DIALOG).getByRole('button', { name: englishMessages['commentThread.editEntry'], exact: true }).click();

    await expect(page.locator(EDIT_FIELD)).toHaveValue('ai note');
  });

  test('with a range selected in an entry, clicking text inside that range without moving opens the edit field', async ({ page }) => {
    await openCommentEditor(page, HUMAN_THREAD);
    await openByClick(page);
    await dragAcross(page, ENTRY_TEXT);
    const selected = await page.evaluate(() => window.getSelection()?.toString());

    await page.locator(ENTRY_TEXT).click({ position: { x: 10, y: 5 } });

    await expect(page.locator(EDIT_FIELD)).toHaveValue('hello world');
    expect(selected).toBe('hello world');
  });

  test('double-clicking a human entry text opens the edit field and selects the word in the field', async ({ page }) => {
    await openCommentEditor(page, HUMAN_THREAD);
    await openByClick(page);

    await page.locator(ENTRY_TEXT).dblclick({ position: { x: 8, y: 5 } });

    await expect(page.locator(EDIT_FIELD)).toBeVisible();
    const field = await page.locator(EDIT_FIELD).evaluate((element) => (element instanceof HTMLTextAreaElement
      ? element.value.slice(element.selectionStart, element.selectionEnd)
      : ''));
    // On Windows the space after the word is selected too. Compare only the selected word.
    expect(field.trim()).toBe('hello');
  });

  test('clicking the author and date line and Shift+clicking an entry text do not open the edit field', async ({ page }) => {
    await openCommentEditor(page, HUMAN_THREAD);
    await openByClick(page);

    await page.locator(META).click();
    await page.locator(ENTRY_TEXT).click({ modifiers: ['Shift'] });

    expect(await page.locator(EDIT_FIELD).count()).toBe(0);
  });

  test('clicks and drags inside the popup send no view edited message and do not change the editor root\'s selection', async ({ page }) => {
    await openCommentEditor(page, HUMAN_THREAD);
    await openByClick(page);
    await installReceiver(page);
    const before = await readVisiblePrefix(page);

    await page.locator(META).click();
    await dragAcross(page, ENTRY_TEXT);
    await page.keyboard.press('Escape');

    await expect(page.locator(POPUP)).toBeHidden();
    expect([(await readRecord(page)).kinds, await readVisiblePrefix(page)]).toEqual([[], before]);
  });

  test('in the popup of a comment in a collapsible section body, clicking an entry text also opens the edit field', async ({ page }) => {
    await openCommentEditor(
      page,
      '<details open=""><summary>t</summary><p>x<comment id="c">ab<comment-body data-author="human">body note</comment-body></comment>y</p></details>',
    );
    await openByClick(page);

    await page.locator(ENTRY_TEXT).click();

    await expect(page.locator(EDIT_FIELD)).toHaveValue('body note');
  });
});

test.describe('Registration after document replacement', () => {
  test('after document replacement, Backspace just after a comment still removes only one annotated character and keeps the entries', async ({ page }) => {
    await openCommentEditor(page, '<p>xy</p>');
    await replaceDocument(page, BODY);
    await placeCaretAt(page, at(`${EDITOR_ROOT} p`, 2));

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">c<comment-body>note</comment-body></comment>ef</p>');
  });

  test('after document replacement, an IME commit after pressing → inside at the end still goes outside the comment', async ({ page }) => {
    await openCommentEditor(page, '<p>xy</p>');
    await replaceDocument(page, BODY);
    await placeCaretAt(page, at(COMMENT, 2, 0));
    await page.keyboard.press('ArrowRight');
    const ime = await openImeSession(page);

    await composeAndCommit(ime);

    expect(await readBodyHtml(page)).toBe('<p>ab<comment id="c">cd<comment-body>note</comment-body></comment>亜ef</p>');
  });

  test('after document replacement, one → still switches exactly once, and clicking an entry text in the popup opens the edit field', async ({ page }) => {
    await openCommentEditor(page, '<p>xy</p>');
    await replaceDocument(page, HUMAN_THREAD);
    await placeCaretAt(page, at(COMMENT, 2, 0));
    await page.keyboard.press('ArrowRight');
    const switched = [await readVisiblePrefix(page), await isCaretInComment(page)];
    await openByClick(page);

    await page.locator(ENTRY_TEXT).click();

    await expect(page.locator(EDIT_FIELD)).toHaveValue('hello world');
    expect(switched).toEqual(['xab', false]);
  });
});
