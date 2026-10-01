import { expect, test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';

import {
  DOCUMENT_APPLY_KIND,
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  MESSAGE_CATALOG_ELEMENT_ID,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { COMMENT_THREAD_EDIT_KIND } from '../../webview/editing/comment-thread-write';
import { DETAILS_TOGGLE_EDIT_KIND } from '../../webview/editing/details-toggle';
import { ACTION_DIALOG_ELEMENT_ID } from '../../webview/ui/action-dialog';
import { COMMENT_POPUP_ELEMENT_ID } from '../../webview/ui/comment-popup';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { TOOLTIP_ELEMENT_ID } from '../../webview/ui/tooltip';
import { EDITOR_ROOT, installReceiver, readBodyHtml, readRecord } from './helpers/editing';
import { PROBE_BUNDLE_PATH, getOutboundMessages, openWebviewHost, sendToWebview } from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const POPUP = `#${COMMENT_POPUP_ELEMENT_ID}`;
const COMMENT = `${EDITOR_ROOT} comment`;
const COMMENT_ITEM = `#${TOOLBAR_ELEMENT_ID} [data-slot="${TOOLBAR_SLOT.comment}"] > button`;
const DIALOG = `#${ACTION_DIALOG_ELEMENT_ID}`;
const TOOLTIP = `#${TOOLTIP_ELEMENT_ID}`;
const ENTRY_ROW = `${POPUP} .comment-thread-entry`;
const BODY_FIELD = `${POPUP} textarea[aria-label="${englishMessages['commentThread.bodyField']}"]`;
const REPLY_FIELD = `${POPUP} textarea[aria-label="${englishMessages['commentThread.replyField']}"]`;
const EDIT_FIELD = `${POPUP} textarea[aria-label="${englishMessages['commentThread.editField']}"]`;
const PREVIOUS = `${POPUP} button[aria-label="${englishMessages['commentThread.previous']}"]`;
const NEXT = `${POPUP} button[aria-label="${englishMessages['commentThread.next']}"]`;
const RESOLVED = `${POPUP} button[aria-label="${englishMessages['commentThread.resolved']}"]`;
const DELETE_COMMENT = `${POPUP} button[aria-label="${englishMessages['commentThread.deleteComment']}"]`;

// Three comments with unique text. Used to check moving to the previous and next comments.
const THREE_COMMENTS = '<p>x<comment id="a">aa<comment-body>one</comment-body></comment>'
  + ' <comment id="b">bb<comment-body>two</comment-body></comment>'
  + ' <comment id="c">cc<comment-body>three</comment-body></comment>y</p><p id="tail">tail</p>';

// A comment with only a human body.
const HUMAN_COMMENT = '<p>x<comment id="c-1">ab<comment-body contenteditable="false" data-author="human" '
  + 'data-updated="2026-01-01T00:00:00.000Z">note</comment-body></comment>y</p><p id="tail">tail</p>';

// A comment with only an AI body.
const AI_COMMENT = '<p>x<comment id="c-1">ab<comment-body contenteditable="false" data-author="ai" '
  + 'data-updated="2026-01-01T00:00:00.000Z">ai note</comment-body></comment>y</p><p id="tail">tail</p>';

// A resolved comment with only a human body.
const RESOLVED_COMMENT = '<p>x<comment id="c-1" data-resolved="">ab<comment-body data-author="human">note</comment-body>'
  + '</comment>y</p>';

// Shape of the update time value. UTC, with milliseconds, ending in Z.
const UPDATED_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/**
 * Variables of the light, dark and high contrast themes. They include the comment and chart colors, so the tests also
 * show that the author colors do not follow them.
 */
const THEMES: { readonly variables: Record<string, string> }[] = [
  {
    variables: {
      '--vscode-editor-background': '#ffffff',
      '--vscode-editor-foreground': '#3b3b3b',
      '--vscode-panel-border': '#e5e5e5',
      '--vscode-textLink-foreground': '#005fb8',
      '--vscode-textCodeBlock-background': '#f8f8f8',
      '--vscode-editorCommentsWidget-rangeBackground': 'rgba(0, 95, 184, 0.1)',
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
      '--vscode-panel-border': '#2b2b2b',
      '--vscode-textLink-foreground': '#4daafc',
      '--vscode-textCodeBlock-background': '#2b2b2b',
      '--vscode-editorCommentsWidget-rangeBackground': 'rgba(55, 148, 255, 0.1)',
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
      '--vscode-panel-border': '#6fc3df',
      '--vscode-textLink-foreground': '#21a6ff',
      '--vscode-textCodeBlock-background': '#000000',
      '--vscode-editorCommentsWidget-rangeBackground': 'rgba(111, 195, 223, 0.2)',
      '--vscode-editorCommentsWidget-unresolvedBorder': '#6fc3df',
      '--vscode-charts-purple': '#b180d7',
      '--vscode-charts-blue': '#59a4f9',
    },
  },
];

// The author colors, the same in every theme: orange for human and blue for AI, with translucent backgrounds.
const HUMAN_COLOR = 'rgb(217, 119, 6)';
const HUMAN_BACKGROUND = 'rgba(245, 158, 11, 0.25)';
const AI_COLOR = 'rgb(30, 120, 190)';
const AI_BACKGROUND = 'rgba(45, 156, 219, 0.22)';

// Border colors of resolved comments: an orange-tinged gray for human and a blue-tinged gray for AI.
const HUMAN_RESOLVED_COLOR = 'rgb(155, 125, 91)';
const AI_RESOLVED_COLOR = 'rgb(99, 126, 147)';

declare global {
  interface Window {
    /** Record of forwarding to VS Code. Holds the code of keydowns that reached the window's bubbling phase, in arrival order. */
    __forwardedKeys?: string[];
    /** IDs of details sections in the order their open attribute was set. */
    __openedDetails?: string[];
  }
}

/**
 * Embeds the English message catalog and then mounts the body. With messages left as keys, the names the user sees
 * could not be checked.
 *
 * @param page Page to operate.
 * @param body Body to mount.
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
 * Clicks the annotated text to open the popup. Focus stays in the editor root.
 *
 * @param page Page to operate.
 * @param selector Comment selector.
 */
async function openByClick(page: Page, selector: string = COMMENT): Promise<void> {
  await page.locator(selector).first().click({ position: { x: 2, y: 5 } });
  await expect(page.locator(POPUP)).toBeVisible();
}

/**
 * Places the caret in the annotated text and opens the popup with the comment button. Focus moves to the popup.
 *
 * @param page Page to operate.
 * @param selector Comment selector.
 * @param offset Position in the first text of the annotated text where the caret is placed.
 */
async function openByItem(page: Page, selector: string = COMMENT, offset = 1): Promise<void> {
  await placeCaretIn(page, selector, offset);
  await page.locator(COMMENT_ITEM).click();
  await expect(page.locator(POPUP)).toBeVisible();
}

/**
 * Places the caret in the text of the element's first child and moves focus to the editor root.
 *
 * @param page Page to operate.
 * @param selector Element selector.
 * @param offset Position in the text.
 */
async function placeCaretIn(page: Page, selector: string, offset: number): Promise<void> {
  await page.evaluate((argument) => {
    const node = document.querySelector(argument.selector)?.firstChild;
    if (node === null || node === undefined) {
      throw new Error(`node not found: ${argument.selector}`);
    }
    document.getElementById(argument.rootId)?.focus();
    const range = document.createRange();
    range.setStart(node, argument.offset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { selector, offset, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Reads computed styles.
 *
 * @param page Page to operate.
 * @param selector Element selector.
 * @param properties Property names to read.
 * @returns Values in order.
 */
async function readComputed(page: Page, selector: string, properties: readonly string[]): Promise<string[]> {
  return page.locator(selector).first().evaluate(
    (element, names) => names.map((name) => getComputedStyle(element).getPropertyValue(name)),
    properties,
  );
}

/**
 * Applies theme variables. VS Code puts them on the root element, so they are put there here too.
 *
 * @param page Page to operate.
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
 * Starts recording the code of keydowns that reach the window's bubbling phase, in place of forwarding to VS Code.
 *
 * @param page Page to operate.
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
 * @param page Page to operate.
 * @returns Codes of the keydowns that arrived.
 */
async function readForwardedKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__forwardedKeys ?? []);
}

/**
 * Reads the body output.
 *
 * @param page Page to operate.
 * @returns Body output. Empty before mounting.
 */
async function readBodyOutput(page: Page): Promise<string> {
  return page.evaluate(() => window.__serializationProbe?.()?.body ?? '');
}

/**
 * Replaces the body through the replace document entry point.
 *
 * @param page Page to operate.
 * @param body New body.
 * @returns Whether it was replaced.
 */
async function replaceDocument(page: Page, body: string): Promise<boolean> {
  return page.evaluate((text) => window.__documentReplacementProbe?.(text) ?? false, `${PROLOGUE}${body}${EPILOGUE}`);
}

/**
 * Raises a blank overlay to stop input. Uses the same reason as the save round trip.
 *
 * @param page Page to operate.
 */
async function stopInput(page: Page): Promise<void> {
  await page.evaluate((reason) => {
    window.__uiShellProbe?.()?.overlay.present(reason, { heading: '', descriptions: [], actions: [] });
  }, INPUT_STOP_REASON.saveRoundTrip);
}

/**
 * Lowers the overlay to end the input stop.
 *
 * @param page Page to operate.
 */
async function resumeInput(page: Page): Promise<void> {
  await page.evaluate((reason) => window.__uiShellProbe?.()?.overlay.dismiss(reason), INPUT_STOP_REASON.saveRoundTrip);
}

/**
 * Changes the tree as one edit, with the same kind as user keystrokes.
 *
 * @param page Page to operate.
 * @param selector Selector of the element to change.
 * @param action Change to make. `append` adds text, and `remove` removes the element.
 */
async function editTree(page: Page, selector: string, action: 'append' | 'remove'): Promise<void> {
  await page.evaluate((argument) => window.__editingSessionProbe?.()?.runCommandEdit('insertText', () => {
    const element = document.querySelector(argument.selector);
    if (argument.action === 'append') {
      element?.append('z');
    } else {
      element?.remove();
    }
    return element !== null;
  }), { selector, action });
}

/**
 * Reads the text of the entries listed in the popup.
 *
 * @param page Page to operate.
 * @returns Texts in order.
 */
async function readPopupEntries(page: Page): Promise<string[]> {
  return page.locator(`${POPUP} .comment-popup-entry`).allTextContents();
}

/**
 * Reads the text from the start of the editor root to the selection start.
 *
 * @param page Page to operate.
 * @returns Text. `null` without a selection.
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
 * Reads both ends of the selection (container text and offset).
 *
 * @param page Page to operate.
 * @returns Container text and offset of the start and the end.
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
 * Reads the ID of the focused element.
 *
 * @param page Page to operate.
 * @returns ID. Empty when there is none.
 */
async function readFocusedId(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.id ?? '');
}

/**
 * Opens a session that drives the browser's IME.
 *
 * @param page Page to operate.
 * @returns Opened session.
 */
async function openImeSession(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/**
 * Returns an operation in an entry row.
 *
 * @param page Page to operate.
 * @param index Row position.
 * @param key Message key of the operation name.
 * @returns Locator of the operation.
 */
function entryButton(page: Page, index: number, key: 'commentThread.editEntry' | 'commentThread.deleteEntry') {
  return page.locator(ENTRY_ROW).nth(index).getByRole('button', { name: englishMessages[key], exact: true });
}

/**
 * Returns an operation of the confirmation dialog.
 *
 * @param page Page to operate.
 * @param key Message key of the operation.
 * @returns Locator of the operation.
 */
function dialogButton(page: Page, key: 'commentThread.editEntry' | 'commentThread.deleteEntry' | 'commentThread.cancel') {
  return page.locator(DIALOG).getByRole('button', { name: englishMessages[key], exact: true });
}

test.describe('Annotation appearance', () => {
  test('in light, dark and high contrast alike, a human thread gets an orange background, solid border and underline, and an AI thread blue ones', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p><comment id="h">ab<comment-body data-author="human">n</comment-body></comment> '
      + '<comment id="a">cd<comment-body data-author="ai">n</comment-body></comment></p>',
    );
    const properties = ['background-color', 'outline-style', 'outline-color', 'text-decoration-color'];

    const drawn: string[][][] = [];
    for (const theme of THEMES) {
      await applyTheme(page, theme.variables);
      drawn.push([
        await readComputed(page, `${EDITOR_ROOT} #h`, properties),
        await readComputed(page, `${EDITOR_ROOT} #a`, properties),
      ]);
    }

    expect(drawn).toEqual(THEMES.map(() => [
      [HUMAN_BACKGROUND, 'solid', HUMAN_COLOR, HUMAN_COLOR],
      [AI_BACKGROUND, 'solid', AI_COLOR, AI_COLOR],
    ]));
  });

  test('a thread with a human body and an AI reply gets the human color, and a thread without a body whose first reply is AI gets the AI color', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p><comment id="h">ab<comment-body data-author="human">n</comment-body><comment-reply data-author="ai">r</comment-reply>'
      + '</comment> <comment id="a">cd<comment-reply data-author="ai">r</comment-reply></comment></p>',
    );
    await applyTheme(page, THEMES[0].variables);

    const colors = [
      await readComputed(page, `${EDITOR_ROOT} #h`, ['outline-color']),
      await readComputed(page, `${EDITOR_ROOT} #a`, ['outline-color']),
    ];

    expect(colors).toEqual([[HUMAN_COLOR], [AI_COLOR]]);
  });

  test('a thread starting with an entry whose author is AI (uppercase) gets the human color', async ({ page }) => {
    await openCommentEditor(page, '<p><comment id="u">ab<comment-body data-author="AI">n</comment-body></comment></p>');
    await applyTheme(page, THEMES[0].variables);

    expect(await readComputed(page, COMMENT, ['outline-color'])).toEqual([HUMAN_COLOR]);
  });

  test('resolved human and AI threads have no background or underline, and their dashed border is an orange-tinged gray and a blue-tinged gray', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p><comment id="h" data-resolved="">ab<comment-body>n</comment-body></comment> '
      + '<comment id="a" data-resolved="">cd<comment-body data-author="ai">n</comment-body></comment></p>',
    );
    const properties = ['background-color', 'text-decoration-line', 'outline-style', 'outline-color'];

    const drawn = [
      await readComputed(page, `${EDITOR_ROOT} #h`, properties),
      await readComputed(page, `${EDITOR_ROOT} #a`, properties),
    ];

    expect(drawn).toEqual([
      ['rgba(0, 0, 0, 0)', 'none', 'dashed', HUMAN_RESOLVED_COLOR],
      ['rgba(0, 0, 0, 0)', 'none', 'dashed', AI_RESOLVED_COLOR],
    ]);
  });

  test('unresolved and resolved human and AI threads all have corners rounded with a 3px radius, and the border stays 1px wide', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p><comment id="h">ab<comment-body data-author="human">n</comment-body></comment> '
      + '<comment id="a">cd<comment-body data-author="ai">n</comment-body></comment> '
      + '<comment id="rh" data-resolved="">ef<comment-body data-author="human">n</comment-body></comment> '
      + '<comment id="ra" data-resolved="">gh<comment-body data-author="ai">n</comment-body></comment></p>',
    );

    const drawn = await page.locator(COMMENT).evaluateAll((comments) => comments.map((comment) => {
      const style = getComputedStyle(comment);
      return [style.borderTopLeftRadius, style.borderBottomRightRadius, style.outlineWidth];
    }));

    expect(drawn).toEqual(Array<string[]>(4).fill(['3px', '3px', '1px']));
  });

  test('clicking resolved annotated text still opens the popup', async ({ page }) => {
    await openCommentEditor(page, '<p><comment id="r" data-resolved="">abcd<comment-body>n</comment-body></comment></p>');

    await page.locator(COMMENT).click();

    await expect(page.locator(POPUP)).toBeVisible();
  });

  test('for a resolved comment with a background in an inline style, the inline background wins', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p><comment id="r" data-resolved="" style="background-color: rgb(255, 0, 0)">ab</comment></p>',
    );

    expect(await readComputed(page, COMMENT, ['background-color'])).toEqual(['rgb(255, 0, 0)']);
  });

  test('for nested comments (hand-written), the inner and outer each get the color of the author of their own first entry', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p><comment id="o">a<comment id="i">b<comment-body data-author="ai">in</comment-body></comment>c'
      + '<comment-body data-author="human">out</comment-body></comment></p>',
    );
    await applyTheme(page, THEMES[0].variables);

    const colors = [
      await readComputed(page, `${EDITOR_ROOT} #o`, ['outline-color']),
      await readComputed(page, `${EDITOR_ROOT} #i`, ['outline-color']),
    ];

    expect(colors).toEqual([[HUMAN_COLOR], [AI_COLOR]]);
  });

  test('comments in a details title and an open details body are also shown with the author color border and the resolved look', async ({ page }) => {
    await openCommentEditor(
      page,
      '<details open=""><summary>t<comment id="t" data-resolved="">ab<comment-body data-author="ai">n</comment-body>'
      + '</comment></summary><p><comment id="b">cd<comment-body data-author="ai">n</comment-body></comment></p></details>',
    );
    await applyTheme(page, THEMES[0].variables);

    const drawn = [
      await readComputed(page, `${EDITOR_ROOT} #t`, ['outline-color', 'outline-style', 'background-color']),
      await readComputed(page, `${EDITOR_ROOT} #b`, ['outline-color', 'outline-style']),
    ];

    expect(drawn).toEqual([[AI_RESOLVED_COLOR, 'dashed', 'rgba(0, 0, 0, 0)'], [AI_COLOR, 'solid']]);
  });
});

test.describe('Drawing a thread', () => {
  test('the popup lists the entries in document order, showing the author display name, local time and text in each row', async ({ page }) => {
    const updated = ['2026-09-26T08:22:46.607Z', '2026-09-26T09:00:00.000Z'];
    await openCommentEditor(
      page,
      `<p><comment id="c-1">ab<comment-body data-author="ai" data-updated="${updated[0]}">note</comment-body>`
      + `<comment-reply data-author="human" data-updated="${updated[1]}">reply</comment-reply></comment></p>`,
    );
    // The display format is fixed as date medium and time short in the default locale.
    const local = await page.evaluate((values) => values.map(
      (value) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)),
    ), updated);

    await openByClick(page);

    const rows = await page.locator(ENTRY_ROW).evaluateAll((elements) => elements.map((row) => [
      [...row.querySelectorAll('.comment-thread-meta span')].map((span) => span.textContent),
      row.querySelector('.comment-popup-entry')?.textContent,
    ]));
    expect(rows).toEqual([
      [[englishMessages['commentThread.authorAi'], local[0]], 'note'],
      [[englishMessages['commentThread.authorHuman'], local[1]], 'reply'],
    ]);
  });

  test('in the three themes, the human and AI avatars get their author colors, and the pressed resolved toggle and the field border can be told apart from the background', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p><comment id="c-1" data-resolved="">ab<comment-body data-author="human">n</comment-body>'
      + '<comment-reply data-author="ai">r</comment-reply></comment></p>',
    );
    await openByClick(page);
    // The avatar is a gradient that ends in the author color, so the color is read from the drawn background.
    const readAvatar = (selector: string): Promise<string> => page.locator(selector).first().evaluate(
      (row) => getComputedStyle(row, '::before').backgroundImage,
    );

    const drawn: (string | boolean)[][] = [];
    for (const theme of THEMES) {
      await applyTheme(page, theme.variables);
      // The popup paints its surface with a gradient, so the page background is the color to tell apart from.
      const [background] = await readComputed(page, 'body', ['background-color']);
      const human = await readAvatar(`${ENTRY_ROW}:not(.comment-thread-entry-ai)`);
      const ai = await readAvatar(`${POPUP} .comment-thread-entry-ai`);
      const [pressed] = await readComputed(page, RESOLVED, ['border-top-color']);
      const [field] = await readComputed(page, REPLY_FIELD, ['border-top-color']);
      drawn.push([human.includes(HUMAN_COLOR), ai.includes(AI_COLOR), pressed !== background, field !== background]);
    }

    expect(drawn).toEqual(THEMES.map(() => [true, true, true, true]));
  });

  test('the popup has corners rounded with a 14px radius and a shadow', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);

    await openByClick(page);

    const [topLeft, bottomRight, shadow] = await readComputed(
      page,
      POPUP,
      ['border-top-left-radius', 'border-bottom-right-radius', 'box-shadow'],
    );
    expect([topLeft, bottomRight, shadow !== 'none']).toEqual(['14px', '14px', true]);
  });

  test('in a light theme the operations have transparent borders, and an operation under the pointer gets a background', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await applyTheme(page, THEMES[0].variables);
    await openByClick(page);
    const [border, transparent] = await readComputed(page, DELETE_COMMENT, ['border-top-color', 'background-color']);

    await page.locator(DELETE_COMMENT).hover();

    // Deleting the comment turns red under the pointer; the light theme has no error color, so the fallback red applies.
    // The colors fade in, so wait until the text color arrives before reading the background.
    await expect.poll(async () => (await readComputed(page, DELETE_COMMENT, ['color']))[0]).toBe('rgb(248, 81, 73)');
    const [background] = await readComputed(page, DELETE_COMMENT, ['background-color']);
    expect([border, transparent, background !== transparent]).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', true]);
  });

  test('in a light theme a move without a target fades only its contents, without a dashed border', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await applyTheme(page, THEMES[0].variables);

    await openByClick(page);

    // A single comment has no move targets, so previous is disabled.
    expect([
      ...await readComputed(page, PREVIOUS, ['border-top-style', 'opacity']),
      ...await readComputed(page, `${PREVIOUS} > svg`, ['opacity']),
    ]).toEqual(['solid', '1', '0.35']);
  });

  test('in a high contrast theme the operations get a border in the border color, a move without a target a dashed one, and the pressed resolved toggle the accent border', async ({ page }) => {
    await openCommentEditor(page, RESOLVED_COMMENT);
    await applyTheme(page, THEMES[2].variables);
    // VS Code puts this class on the body in a high contrast theme.
    await page.evaluate(() => document.body.classList.add('vscode-high-contrast'));

    await openByClick(page);

    // The panel border and the link foreground of the high contrast theme.
    expect([
      ...await readComputed(page, DELETE_COMMENT, ['border-top-color']),
      ...await readComputed(page, PREVIOUS, ['border-top-style']),
      ...await readComputed(page, RESOLVED, ['border-top-color']),
    ]).toEqual(['rgb(111, 195, 223)', 'dashed', 'rgb(33, 166, 255)']);
  });

  test('in a light theme the pressed resolved toggle is drawn in the theme\'s green, with a tinted background and border', async ({ page }) => {
    await openCommentEditor(page, RESOLVED_COMMENT);
    await applyTheme(page, { ...THEMES[0].variables, '--vscode-charts-green': 'rgb(20, 130, 60)' });

    await openByClick(page);

    const [background, border, color] = await readComputed(
      page,
      RESOLVED,
      ['background-color', 'border-top-color', 'color'],
    );
    // The tint is the green mixed with transparency, so it is not transparent and differs from the solid text color.
    expect([color, background !== 'rgba(0, 0, 0, 0)', border !== 'rgba(0, 0, 0, 0)', background !== border])
      .toEqual(['rgb(20, 130, 60)', true, true, true]);
  });

  test('the reply field takes VS Code\'s input field colors from the variables', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await applyTheme(page, {
      '--vscode-input-background': 'rgb(254, 254, 254)',
      '--vscode-input-foreground': 'rgb(58, 58, 58)',
      '--vscode-input-border': 'rgb(206, 206, 206)',
    });

    await openByClick(page);

    expect(await readComputed(page, REPLY_FIELD, ['background-color', 'color', 'border-top-color']))
      .toEqual(['rgb(254, 254, 254)', 'rgb(58, 58, 58)', 'rgb(206, 206, 206)']);
  });

  test('once a reply is being written, save takes the primary button colors and cancel is quiet: transparent with the muted text color', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await applyTheme(page, {
      '--vscode-button-background': 'rgb(0, 120, 212)',
      '--vscode-button-foreground': 'rgb(255, 255, 254)',
      '--vscode-descriptionForeground': 'rgb(110, 110, 111)',
    });
    await openByClick(page);

    await page.locator(REPLY_FIELD).click();
    await page.keyboard.type('r');

    const popup = page.locator(POPUP);
    const readColors = (key: 'commentThread.save' | 'commentThread.cancel'): Promise<string[]> => popup
      .getByRole('button', { name: englishMessages[key], exact: true })
      .evaluate((button) => [getComputedStyle(button).backgroundColor, getComputedStyle(button).color]);
    expect([await readColors('commentThread.save'), await readColors('commentThread.cancel')]).toEqual([
      ['rgb(0, 120, 212)', 'rgb(255, 255, 254)'],
      ['rgba(0, 0, 0, 0)', 'rgb(110, 110, 111)'],
    ]);
  });

  test('controls have names from the message catalog and no title, and hovering shows a tooltip with that name', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await openByClick(page);

    const parts = await page.locator(`${POPUP} .comment-thread-header button`).evaluateAll(
      (buttons) => buttons.map((button) => [button.getAttribute('aria-label'), button.hasAttribute('title')]),
    );
    await page.locator(RESOLVED).hover();

    expect(parts).toEqual([
      [englishMessages['commentThread.previous'], false],
      [englishMessages['commentThread.next'], false],
      [englishMessages['commentThread.resolved'], false],
      [englishMessages['commentThread.deleteComment'], false],
    ]);
    await expect(page.locator(TOOLTIP)).toHaveText(englishMessages['commentThread.resolved']);
  });

  test('with a larger font size, the six operation icons in the popup are 1.1 times as tall as the entry text', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await applyTheme(page, { '--vscode-font-size': '20px' });
    await openByClick(page);

    const [fontSize] = await readComputed(page, `${POPUP} .comment-popup-entry`, ['font-size']);
    const heights = await page.locator(`${POPUP} button > svg`).evaluateAll(
      (icons) => icons.map((icon) => `${icon.getBoundingClientRect().height}px`),
    );

    expect([fontSize, heights]).toEqual(['20px', Array<string>(6).fill('22px')]);
  });

  test('when the tree changes while typing in the reply field, the field text, focus and caret position in the field are kept', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await openByClick(page);
    await page.locator(REPLY_FIELD).click();
    await page.keyboard.type('abc');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');

    await editTree(page, `${EDITOR_ROOT} #tail`, 'append');

    await expect(page.locator(REPLY_FIELD)).toBeFocused();
    expect(await page.locator(REPLY_FIELD).evaluate((field: HTMLTextAreaElement) => [field.value, field.selectionStart]))
      .toEqual(['abc', 1]);
  });

  test('starting and committing an IME composition in an empty reply field leaves the committed text in the field', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await openByClick(page);
    await page.locator(REPLY_FIELD).click();
    const ime = await openImeSession(page);

    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    await ime.send('Input.insertText', { text: '亜' });

    await expect(page.locator(REPLY_FIELD)).toHaveValue('亜');
  });

  test('after opening with the comment button, Tab and Enter alone can toggle resolved, edit and delete an entry, and delete the comment', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await openByItem(page);
    // With no move targets, previous and next are disabled and skipped, so the first Tab goes to the resolved toggle.
    await page.keyboard.press('Tab');
    await expect(page.locator(RESOLVED)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator(COMMENT)).toHaveAttribute('data-resolved', '');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(entryButton(page, 0, 'commentThread.editEntry')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator(EDIT_FIELD)).toBeFocused();
    // Canceling returns focus to that entry's edit operation.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    await expect(entryButton(page, 0, 'commentThread.deleteEntry')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator(`${COMMENT} > comment-body`)).toHaveCount(0);
    // The operations of the deleted entry are gone, so focus moves to the popup.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.locator(DELETE_COMMENT)).toBeFocused();

    await page.keyboard.press('Enter');

    await expect(page.locator(POPUP)).toBeHidden();
    expect([await page.locator(COMMENT).count(), await page.locator(`${EDITOR_ROOT} p`).first().innerHTML()]).toEqual([0, 'xaby']);
  });
});

test.describe('Managing inputs', () => {
  test('opening a comment with only replies with the comment button moves focus to the body field', async ({ page }) => {
    await openCommentEditor(page, '<p>x<comment id="c-1">ab<comment-reply>r</comment-reply></comment>y</p>');

    await openByItem(page);

    await expect(page.locator(BODY_FIELD)).toBeFocused();
  });

  test('typing in the body field and pressing Enter inserts the body with one comment:entry edit, and the popup shows it', async ({ page }) => {
    await openCommentEditor(page, '<p>x<comment id="c-1">ab</comment>y</p>');
    await installReceiver(page);
    await openByItem(page);
    await page.keyboard.type('note');

    await page.keyboard.press('Enter');

    expect([
      (await readRecord(page)).kinds,
      await page.locator(`${COMMENT} > comment-body`).allTextContents(),
      await readPopupEntries(page),
    ]).toEqual([[COMMENT_THREAD_EDIT_KIND.entry], ['note'], ['note']]);
  });

  test('Shift+Enter in a field breaks the line in the field, and the following Enter puts the text with the line break into the entry', async ({ page }) => {
    await openCommentEditor(page, '<p>x<comment id="c-1">ab</comment>y</p>');
    await openByItem(page);
    await page.keyboard.type('a');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('b');

    await page.keyboard.press('Enter');

    expect(await page.locator(`${COMMENT} > comment-body`).allTextContents()).toEqual(['a\nb']);
  });

  test('Esc in an active field leaves the tree unchanged, empties the field, and keeps the popup open', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    const before = await readBodyHtml(page);
    await openByClick(page);
    await page.locator(REPLY_FIELD).click();
    await page.keyboard.type('abc');

    await page.keyboard.press('Escape');

    await expect(page.locator(POPUP)).toBeVisible();
    expect([await readBodyHtml(page), await page.locator(REPLY_FIELD).inputValue()]).toEqual([before, '']);
  });

  test('Esc in an empty reply field closes the popup', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await openByClick(page);
    await page.locator(REPLY_FIELD).click();

    await page.keyboard.press('Escape');

    await expect(page.locator(POPUP)).toBeHidden();
  });

  test('Enter and Esc during composition in the reply field neither change the tree nor close the popup', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await openByClick(page);
    await page.locator(REPLY_FIELD).click();
    const ime = await openImeSession(page);
    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    const before = await readBodyHtml(page);

    // Physical keys during composition arrive after the composition is committed, so keys marked as composing are sent directly.
    for (const key of ['Enter', 'Escape']) {
      await page.locator(REPLY_FIELD).dispatchEvent('keydown', { key, code: key, isComposing: true, bubbles: true, cancelable: true });
    }

    await expect(page.locator(POPUP)).toBeVisible();
    expect(await readBodyHtml(page)).toBe(before);
  });

  test('Enter while input is stopped does not write and the text stays, and Enter after the stop ends writes it', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await openByClick(page);
    await page.locator(REPLY_FIELD).click();
    await page.keyboard.type('abc');
    await stopInput(page);
    await page.keyboard.press('Enter');
    const whileStopped = [await page.locator(`${COMMENT} > comment-reply`).count(), await page.locator(REPLY_FIELD).inputValue()];
    await resumeInput(page);

    await page.keyboard.press('Enter');

    expect([whileStopped, await page.locator(`${COMMENT} > comment-reply`).allTextContents()]).toEqual([[0, 'abc'], ['abc']]);
  });

  test('pressing the body outside the popup with a reply typed writes the reply and closes the popup', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await openByClick(page);
    await page.locator(REPLY_FIELD).fill('R');

    await page.locator(`${EDITOR_ROOT} #tail`).click();

    await expect(page.locator(POPUP)).toBeHidden();
    expect(await page.locator(`${COMMENT} > comment-reply`).allTextContents()).toEqual(['R']);
  });

  test('pressing outside with a changed edit field and a typed reply writes both, and exactly one immediate edit notification arrives with comment:entry', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await installReceiver(page);
    await openByClick(page);
    await entryButton(page, 0, 'commentThread.editEntry').click();
    await page.locator(EDIT_FIELD).fill('changed');
    await page.locator(REPLY_FIELD).fill('R');

    await page.locator(`${EDITOR_ROOT} #tail`).click();

    expect([
      (await readRecord(page)).kinds,
      await page.locator(`${COMMENT} > comment-body`).allTextContents(),
      await page.locator(`${COMMENT} > comment-reply`).allTextContents(),
    ]).toEqual([[COMMENT_THREAD_EDIT_KIND.entry], ['changed'], ['R']]);
  });

  test('clicking another comment\'s annotated text with a reply typed writes the reply to the earlier comment and switches the popup to the later one', async ({ page }) => {
    await openCommentEditor(page, THREE_COMMENTS);
    await openByClick(page, `${EDITOR_ROOT} #a`);
    await page.locator(REPLY_FIELD).fill('R');

    await page.locator(`${EDITOR_ROOT} #b`).click({ position: { x: 2, y: 5 } });

    await expect(page.locator(POPUP)).toBeVisible();
    expect([
      await page.locator(`${EDITOR_ROOT} #a > comment-reply`).allTextContents(),
      await readPopupEntries(page),
    ]).toEqual([['R'], ['two']]);
  });

  test('when an edit removes the open comment from the tree with a reply typed, the reply is not written and the popup closes', async ({ page }) => {
    await openCommentEditor(page, THREE_COMMENTS);
    await openByClick(page, `${EDITOR_ROOT} #a`);
    await page.locator(REPLY_FIELD).fill('R');

    await editTree(page, `${EDITOR_ROOT} #a`, 'remove');

    await expect(page.locator(POPUP)).toBeHidden();
    // A discarded input is not carried over to the next opened comment.
    await openByClick(page, `${EDITOR_ROOT} #b`);
    expect([
      await page.locator(`${EDITOR_ROOT} comment-reply`).count(),
      await page.locator(REPLY_FIELD).inputValue(),
    ]).toEqual([0, '']);
  });

  test('when a comment with the same ID remains after document replacement with a reply typed, the text and focus are kept and further typing goes into the field', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await openByClick(page);
    await page.locator(REPLY_FIELD).click();
    await page.keyboard.type('ab');

    await replaceDocument(page, '<p>z<comment id="c-1">ab<comment-body>changed</comment-body></comment>y</p>');
    await page.keyboard.type('c');

    await expect(page.locator(REPLY_FIELD)).toBeFocused();
    expect([await page.locator(REPLY_FIELD).inputValue(), await readPopupEntries(page)]).toEqual(['abc', ['changed']]);
  });

  test('editing a human entry and pressing Enter replaces its content, keeps the author, and renews only the update time', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await openByClick(page);
    await entryButton(page, 0, 'commentThread.editEntry').click();
    await page.locator(EDIT_FIELD).fill('new');

    await page.keyboard.press('Enter');

    const entry = await page.locator(`${COMMENT} > comment-body`).evaluate((body) => [
      body.textContent,
      body.getAttribute('data-author'),
      body.getAttribute('data-updated'),
    ]);
    expect([entry[0], entry[1], entry[2] !== '2026-01-01T00:00:00.000Z' && UPDATED_PATTERN.test(entry[2] ?? '')])
      .toEqual(['new', 'human', true]);
  });

  test('pressing Enter without changes when editing an entry containing code sends no immediate edit notification and keeps the entry as it is', async ({ page }) => {
    await openCommentEditor(page, '<p>x<comment id="c-1">ab<comment-body>see <code>x</code></comment-body></comment>y</p>');
    await installReceiver(page);
    await openByClick(page);
    await entryButton(page, 0, 'commentThread.editEntry').click();
    await expect(page.locator(EDIT_FIELD)).toBeFocused();

    await page.keyboard.press('Enter');

    await expect(page.locator(EDIT_FIELD)).toHaveCount(0);
    expect([(await readRecord(page)).kinds, await page.locator(`${COMMENT} > comment-body`).innerHTML()])
      .toEqual([[], 'see <code>x</code>']);
  });

  test('committing an entry with text after making it whitespace only deletes the entry', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await openByClick(page);
    await entryButton(page, 0, 'commentThread.editEntry').click();
    await page.locator(EDIT_FIELD).fill('   ');

    await page.keyboard.press('Enter');

    await expect(page.locator(`${COMMENT} > comment-body`)).toHaveCount(0);
  });

  test('Enter in a field and Esc in an active field do not reach VS Code', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await openByClick(page);
    await page.locator(REPLY_FIELD).click();
    await installForwardRecord(page);

    await page.keyboard.press('Enter');
    await page.keyboard.type('x');
    await page.keyboard.press('Escape');

    expect((await readForwardedKeys(page)).filter((code) => code === 'Enter' || code === 'Escape')).toEqual([]);
  });

  test('pressing at the popup during the save round trip overlay does not close it, and the typed text stays', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await openByClick(page);
    await page.locator(REPLY_FIELD).fill('R');
    const box = await page.locator(REPLY_FIELD).boundingBox();
    await stopInput(page);

    await page.mouse.click((box?.x ?? 0) + 5, (box?.y ?? 0) + 5);

    await expect(page.locator(POPUP)).toBeVisible();
    expect(await page.locator(REPLY_FIELD).inputValue()).toBe('R');
  });
});

test.describe('Rewriting entries', () => {
  test('the added body and reply enter the body output with contenteditable="false", author human, and a UTC update time with milliseconds', async ({ page }) => {
    await openCommentEditor(page, '<p>x<comment id="c-1">ab</comment>y</p>');
    await openByItem(page);
    await page.keyboard.type('note');
    await page.keyboard.press('Enter');
    await expect(page.locator(REPLY_FIELD)).toBeFocused();
    await page.keyboard.type('reply');

    await page.keyboard.press('Enter');

    const attributes = 'contenteditable="false" data-author="human" data-updated="\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z"';
    expect(await readBodyOutput(page)).toMatch(new RegExp(
      `^<p>x<comment id="c-1">ab<comment-body ${attributes}>note</comment-body>`
      + `<comment-reply ${attributes}>reply</comment-reply></comment>y</p>$`,
      'u',
    ));
  });

  test('adding and editing replies also works for comments in a details title and body', async ({ page }) => {
    await openCommentEditor(
      page,
      '<details open=""><summary>t<comment id="t">ab<comment-body>one</comment-body></comment></summary>'
      + '<p><comment id="b">cd<comment-body>two</comment-body></comment></p></details>',
    );
    await openByClick(page, `${EDITOR_ROOT} #t`);
    await page.locator(REPLY_FIELD).click();
    await page.keyboard.type('R');
    await page.keyboard.press('Enter');
    await openByClick(page, `${EDITOR_ROOT} #b`);
    await entryButton(page, 0, 'commentThread.editEntry').click();
    await page.locator(EDIT_FIELD).fill('two2');

    await page.keyboard.press('Enter');

    expect([
      await page.locator(`${EDITOR_ROOT} #t > comment-reply`).allTextContents(),
      await page.locator(`${EDITOR_ROOT} #b > comment-body`).allTextContents(),
    ]).toEqual([['R'], ['two2']]);
  });

  test('pressing delete on a human entry deletes it without confirmation, and the typed reply stays', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p>x<comment id="c-1">ab<comment-body data-author="human">n</comment-body>'
      + '<comment-reply data-author="human">r</comment-reply></comment>y</p>',
    );
    await openByClick(page);
    await page.locator(REPLY_FIELD).fill('R');

    await entryButton(page, 1, 'commentThread.deleteEntry').click();

    await expect(page.locator(`${COMMENT} > comment-reply`)).toHaveCount(0);
    expect([await page.locator(DIALOG).count(), await page.locator(REPLY_FIELD).inputValue()]).toEqual([0, 'R']);
  });
});

test.describe('Toggling the resolved state', () => {
  test('pressing the resolved toggle sets data-resolved and shows it pressed, and pressing again removes it', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await openByClick(page);

    await page.locator(RESOLVED).click();
    const resolved = [await page.locator(COMMENT).getAttribute('data-resolved'), await page.locator(RESOLVED).getAttribute('aria-pressed')];
    await page.locator(RESOLVED).click();

    expect([resolved, [await page.locator(COMMENT).getAttribute('data-resolved'), await page.locator(RESOLVED).getAttribute('aria-pressed')]])
      .toEqual([['', 'true'], [null, 'false']]);
  });

  test('one resolved toggle sends one immediate edit notification with comment:resolve', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await installReceiver(page);
    await openByClick(page);

    await page.locator(RESOLVED).click();

    expect((await readRecord(page)).kinds).toEqual([COMMENT_THREAD_EDIT_KIND.resolve]);
  });

  test('no confirmation appears even for an AI thread, and the author and update time of the entries do not change', async ({ page }) => {
    await openCommentEditor(page, AI_COMMENT);
    const before = await page.locator(`${COMMENT} > comment-body`).evaluate((body) => body.outerHTML);
    await openByClick(page);

    await page.locator(RESOLVED).click();

    await expect(page.locator(COMMENT)).toHaveAttribute('data-resolved', '');
    expect([await page.locator(DIALOG).count(), await page.locator(`${COMMENT} > comment-body`).evaluate((body) => body.outerHTML)])
      .toEqual([0, before]);
  });

  test('closing with Esc after the resolved toggle returns to the editor root selection from when it was opened', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await placeCaretIn(page, COMMENT, 1);
    const before = await readSelectionEnds(page);
    await page.locator(COMMENT_ITEM).click();
    await page.locator(RESOLVED).click();
    await expect(page.locator(COMMENT)).toHaveAttribute('data-resolved', '');

    await page.keyboard.press('Escape');

    await expect(page.locator(POPUP)).toBeHidden();
    expect([await readFocusedId(page), await readSelectionEnds(page)]).toEqual([EDITOR_ROOT_ELEMENT_ID, before]);
  });
});

test.describe('Deleting a comment', () => {
  test('deleting a human-only comment keeps the annotated text without confirmation, removes the comment and entries, and closes the popup', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await openByClick(page);

    await page.locator(DELETE_COMMENT).click();

    await expect(page.locator(POPUP)).toBeHidden();
    expect([await page.locator(DIALOG).count(), await page.locator(`${EDITOR_ROOT} p`).first().innerHTML()]).toEqual([0, 'xaby']);
  });

  test('after deletion, focus returns to the editor root and the caret is at the end of the kept annotated text', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await openByClick(page);

    await page.locator(DELETE_COMMENT).click();

    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
    expect(await readCaretPrefix(page)).toBe('xab');
  });

  test('deleting after typing and writing in the body field still places the caret at the end of the kept annotated text', async ({ page }) => {
    await openCommentEditor(page, '<p>x<comment id="c-1">ab</comment>y</p><p id="tail">tail</p>');
    await openByItem(page);
    await page.keyboard.type('note');
    await page.keyboard.press('Enter');

    await page.locator(DELETE_COMMENT).click();

    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
    expect(await readCaretPrefix(page)).toBe('xab');
  });
});

test.describe('Confirming the other party\'s entries', () => {
  test('confirming when editing an AI entry opens the edit field filled with its text', async ({ page }) => {
    await openCommentEditor(page, AI_COMMENT);
    await openByClick(page);
    await entryButton(page, 0, 'commentThread.editEntry').click();

    await dialogButton(page, 'commentThread.editEntry').click();

    await expect(page.locator(EDIT_FIELD)).toHaveValue('ai note');
  });

  test('canceling the confirmation when editing an AI entry opens no field and leaves the tree unchanged', async ({ page }) => {
    await openCommentEditor(page, AI_COMMENT);
    const before = await readBodyHtml(page);
    await openByClick(page);
    await entryButton(page, 0, 'commentThread.editEntry').click();

    await dialogButton(page, 'commentThread.cancel').click();

    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect([await page.locator(EDIT_FIELD).count(), await readBodyHtml(page)]).toEqual([0, before]);
  });

  test('confirming when deleting an AI entry deletes it', async ({ page }) => {
    await openCommentEditor(page, AI_COMMENT);
    await openByClick(page);
    await entryButton(page, 0, 'commentThread.deleteEntry').click();

    await dialogButton(page, 'commentThread.deleteEntry').click();

    await expect(page.locator(`${COMMENT} > comment-body`)).toHaveCount(0);
  });

  test('confirming when deleting a comment containing an AI entry removes the comment and keeps the annotated text', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p>x<comment id="c-1">ab<comment-body data-author="human">n</comment-body>'
      + '<comment-reply data-author="ai">r</comment-reply></comment>y</p>',
    );
    await openByClick(page);
    await page.locator(DELETE_COMMENT).click();

    await dialogButton(page, 'commentThread.deleteEntry').click();

    await expect(page.locator(COMMENT)).toHaveCount(0);
    expect(await page.locator(`${EDITOR_ROOT} p`).innerHTML()).toBe('xaby');
  });

  test('an AI entry edited by a human keeps the author ai, and the next edit asks for confirmation again', async ({ page }) => {
    await openCommentEditor(page, AI_COMMENT);
    await openByClick(page);
    await entryButton(page, 0, 'commentThread.editEntry').click();
    await dialogButton(page, 'commentThread.editEntry').click();
    await page.locator(EDIT_FIELD).fill('fixed');
    await page.keyboard.press('Enter');

    await entryButton(page, 0, 'commentThread.editEntry').click();

    await expect(page.locator(DIALOG)).toBeVisible();
    expect(await page.locator(`${COMMENT} > comment-body`).getAttribute('data-author')).toBe('ai');
  });

  test('making it whitespace only and committing after the confirmation deletes the entry without asking again', async ({ page }) => {
    await openCommentEditor(page, AI_COMMENT);
    await openByClick(page);
    await entryButton(page, 0, 'commentThread.editEntry').click();
    await dialogButton(page, 'commentThread.editEntry').click();
    await page.locator(EDIT_FIELD).fill('  ');

    await page.keyboard.press('Enter');

    await expect(page.locator(`${COMMENT} > comment-body`)).toHaveCount(0);
    expect(await page.locator(DIALOG).count()).toBe(0);
  });

  test('pressing the backdrop while the confirmation to delete an AI entry is open cancels it, keeping the comment popup open and the entry in place', async ({ page }) => {
    await openCommentEditor(page, AI_COMMENT);
    await openByClick(page);
    await entryButton(page, 0, 'commentThread.deleteEntry').click();
    await expect(page.locator(DIALOG)).toBeVisible();
    // The paragraph after the comment lies outside the popup and the dialog, under the backdrop.
    const tail = await page.locator(`${EDITOR_ROOT} #tail`).boundingBox();
    if (tail === null) {
      throw new Error('The paragraph after the comment is not laid out');
    }

    await page.mouse.click(tail.x + 2, tail.y + tail.height / 2);

    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect([await page.locator(POPUP).isVisible(), await page.locator(`${COMMENT} > comment-body`).count()])
      .toEqual([true, 1]);
  });

  test('pressing a confirmation button does not close the comment popup', async ({ page }) => {
    await openCommentEditor(page, AI_COMMENT);
    await openByClick(page);
    await entryButton(page, 0, 'commentThread.editEntry').click();

    await dialogButton(page, 'commentThread.editEntry').click();

    await expect(page.locator(POPUP)).toBeVisible();
    await expect(page.locator(EDIT_FIELD)).toBeVisible();
  });

  test('document replacement while the confirmation is shown cancels it, and the edit field does not open', async ({ page }) => {
    await openCommentEditor(page, AI_COMMENT);
    await openByClick(page);
    await entryButton(page, 0, 'commentThread.editEntry').click();
    await expect(page.locator(DIALOG)).toBeVisible();

    await replaceDocument(page, AI_COMMENT);

    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect(await page.locator(EDIT_FIELD).count()).toBe(0);
  });
});

test.describe('Registering the entry points', () => {
  test('when history is applied with a reply typed, no selection is placed in the editor root and further typing goes into the field', async ({ page }) => {
    await openCommentEditor(page, HUMAN_COMMENT);
    await openByClick(page);
    await page.locator(REPLY_FIELD).click();
    await page.keyboard.type('ab');
    const text = `${PROLOGUE}${HUMAN_COMMENT}${EPILOGUE}`;

    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument,
      requestId: 'history-1',
      kind: DOCUMENT_APPLY_KIND.editHistory,
      text,
      targetText: text,
      targetSelection: { start: { line: 1, column: 15 }, end: { line: 1, column: 15 } },
      editRange: { start: 1, count: 1 },
    });
    await expect.poll(async () => (await getOutboundMessages(page)).some(
      (message) => Reflect.get(Object(message), 'type') === VIEW_TO_HOST_MESSAGE_TYPE.documentReplaced,
    )).toBe(true);
    const inRoot = await page.evaluate(
      (rootId) => document.getElementById(rootId)?.contains(window.getSelection()?.anchorNode ?? null) === true,
      EDITOR_ROOT_ELEMENT_ID,
    );
    await page.keyboard.type('c');

    expect([inRoot, await page.locator(REPLY_FIELD).inputValue()]).toEqual([false, 'abc']);
  });

  test('adding a reply also works in a popup opened after document replacement', async ({ page }) => {
    await openCommentEditor(page, '<p>before</p>');
    await replaceDocument(page, HUMAN_COMMENT);
    await openByClick(page);
    await page.locator(REPLY_FIELD).click();
    await page.keyboard.type('R');

    await page.keyboard.press('Enter');

    expect(await page.locator(`${COMMENT} > comment-reply`).allTextContents()).toEqual(['R']);
  });
});

test.describe('Moving between comments', () => {
  test('pressing the next button switches the popup to the next comment in document order and moves focus to the first focusable control', async ({ page }) => {
    await openCommentEditor(page, THREE_COMMENTS);
    await openByClick(page, `${EDITOR_ROOT} #b`);

    await page.locator(NEXT).click();

    await expect(page.locator(PREVIOUS)).toBeFocused();
    expect(await readPopupEntries(page)).toEqual(['three']);
  });

  test('outside the fields, ↓ and → move to the next and ↑ and ← to the previous', async ({ page }) => {
    await openCommentEditor(page, THREE_COMMENTS);
    await openByItem(page, `${EDITOR_ROOT} #b`);

    const visited: string[][] = [];
    for (const key of ['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp']) {
      await page.keyboard.press(key);
      visited.push(await readPopupEntries(page));
    }

    expect(visited).toEqual([['three'], ['two'], ['three'], ['two']]);
  });

  test('moving changes neither the editor root selection nor the tree', async ({ page }) => {
    await openCommentEditor(page, THREE_COMMENTS);
    await openByItem(page, `${EDITOR_ROOT} #b`);
    const before = [await readSelectionEnds(page), await readBodyHtml(page)];

    await page.keyboard.press('ArrowDown');

    expect(await readPopupEntries(page)).toEqual(['three']);
    expect([await readSelectionEnds(page), await readBodyHtml(page)]).toEqual(before);
  });

  test('closing with Esc after moving returns to the editor root selection from the first opening', async ({ page }) => {
    await openCommentEditor(page, THREE_COMMENTS);
    await placeCaretIn(page, `${EDITOR_ROOT} #b`, 1);
    const before = await readCaretPrefix(page);
    await page.locator(COMMENT_ITEM).click();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => readPopupEntries(page)).toEqual(['three']);

    await page.keyboard.press('Escape');

    await expect(page.locator(POPUP)).toBeHidden();
    expect([await readFocusedId(page), await readCaretPrefix(page)]).toEqual([EDITOR_ROOT_ELEMENT_ID, before]);
  });

  test('closing with Esc after moving to the previous comment and writing a reply returns to the editor root selection from the first opening', async ({ page }) => {
    await openCommentEditor(page, THREE_COMMENTS);
    await placeCaretIn(page, `${EDITOR_ROOT} #b`, 1);
    const before = await readSelectionEnds(page);
    await page.locator(COMMENT_ITEM).click();
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => readPopupEntries(page)).toEqual(['one']);
    await page.locator(REPLY_FIELD).fill('R');
    await page.keyboard.press('Enter');
    await expect(page.locator(`${EDITOR_ROOT} #a > comment-reply`)).toHaveCount(1);

    await page.keyboard.press('Escape');

    await expect(page.locator(POPUP)).toBeHidden();
    expect([await readFocusedId(page), await readSelectionEnds(page)]).toEqual([EDITOR_ROOT_ELEMENT_ID, before]);
  });

  test('↑ and ↓ inside a field move the caret in the field and do not move between comments', async ({ page }) => {
    await openCommentEditor(page, THREE_COMMENTS);
    await openByClick(page, `${EDITOR_ROOT} #b`);
    await page.locator(REPLY_FIELD).click();
    await page.keyboard.type('a');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('b');

    await page.keyboard.press('ArrowUp');

    expect([
      await readPopupEntries(page),
      await page.locator(REPLY_FIELD).evaluate((field: HTMLTextAreaElement) => field.selectionStart),
    ]).toEqual([['two'], 1]);
  });

  test('arrows with Shift or Alt do not move', async ({ page }) => {
    await openCommentEditor(page, THREE_COMMENTS);
    await openByItem(page, `${EDITOR_ROOT} #b`);

    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Alt+ArrowDown');

    expect(await readPopupEntries(page)).toEqual(['two']);
  });

  test('↓ on the last comment changes nothing, and the next button is disabled', async ({ page }) => {
    await openCommentEditor(page, THREE_COMMENTS);
    await openByItem(page, `${EDITOR_ROOT} #c`);

    await page.keyboard.press('ArrowDown');

    await expect(page.locator(NEXT)).toBeDisabled();
    expect(await readPopupEntries(page)).toEqual(['three']);
  });

  test('moving to an off-screen comment scrolls its annotated text into view and places the popup near it', async ({ page }) => {
    // Leave space after the target too. At the end of the document it cannot scroll to the middle, and the popup would be flipped above.
    await openCommentEditor(
      page,
      '<p>x<comment id="a">aa<comment-body>one</comment-body></comment></p><p style="height: 3000px">spacer</p>'
      + '<p><comment id="b">bb<comment-body>two</comment-body></comment></p><p style="height: 3000px">spacer</p>',
    );
    await openByClick(page, `${EDITOR_ROOT} #a`);

    await page.locator(NEXT).click();

    await expect.poll(() => readPopupEntries(page)).toEqual(['two']);
    const placed = await page.evaluate((selectors) => {
      const comment = document.querySelector(selectors.comment)?.getBoundingClientRect();
      const popup = document.querySelector(selectors.popup)?.getBoundingClientRect();
      if (comment === undefined || popup === undefined) {
        return null;
      }
      return [comment.top >= 0 && comment.bottom <= window.innerHeight, Math.round(popup.top - comment.bottom)];
    }, { comment: `${EDITOR_ROOT} #b`, popup: POPUP });
    expect(placed).toEqual([true, 6]);
  });

  test('moving to a comment in the body of a closed details section opens it with one details:toggle edit before switching', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p><comment id="a">aa<comment-body>one</comment-body></comment></p>'
      + '<details><summary>t</summary><p><comment id="b">bb<comment-body>two</comment-body></comment></p></details>',
    );
    await installReceiver(page);
    await openByClick(page, `${EDITOR_ROOT} #a`);

    await page.locator(NEXT).click();

    await expect.poll(() => readPopupEntries(page)).toEqual(['two']);
    expect([await page.locator(`${EDITOR_ROOT} details`).getAttribute('open'), (await readRecord(page)).kinds])
      .toEqual(['', [DETAILS_TOGGLE_EDIT_KIND]]);
  });

  test('nested closed details sections both open, outermost first', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p><comment id="a">aa<comment-body>one</comment-body></comment></p>'
      + '<details id="outer"><summary>t</summary><details id="inner"><summary>u</summary>'
      + '<p><comment id="b">bb<comment-body>two</comment-body></comment></p></details></details>',
    );
    await page.evaluate(() => {
      const opened: string[] = [];
      window.__openedDetails = opened;
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.target instanceof Element && record.target.hasAttribute('open')) {
            opened.push(record.target.id);
          }
        }
      });
      for (const section of document.querySelectorAll('details')) {
        observer.observe(section, { attributes: true, attributeFilter: ['open'] });
      }
    });
    await openByClick(page, `${EDITOR_ROOT} #a`);

    await page.locator(NEXT).click();

    await expect.poll(() => readPopupEntries(page)).toEqual(['two']);
    expect(await page.evaluate(() => window.__openedDetails ?? [])).toEqual(['outer', 'inner']);
  });

  test('moving to a comment in the title of a closed details section does not open it', async ({ page }) => {
    await openCommentEditor(
      page,
      '<p><comment id="a">aa<comment-body>one</comment-body></comment></p>'
      + '<details><summary>t<comment id="b">bb<comment-body>two</comment-body></comment></summary><p>x</p></details>',
    );
    await openByClick(page, `${EDITOR_ROOT} #a`);

    await page.locator(NEXT).click();

    await expect.poll(() => readPopupEntries(page)).toEqual(['two']);
    expect(await page.locator(`${EDITOR_ROOT} details`).getAttribute('open')).toBeNull();
  });

  test('↓ while input is stopped does not move', async ({ page }) => {
    await openCommentEditor(page, THREE_COMMENTS);
    await openByItem(page, `${EDITOR_ROOT} #b`);
    await stopInput(page);

    await page.keyboard.press('ArrowDown');

    expect(await readPopupEntries(page)).toEqual(['two']);
  });

  test('moving to the next with a reply typed writes the reply to the earlier comment before switching', async ({ page }) => {
    await openCommentEditor(page, THREE_COMMENTS);
    await openByClick(page, `${EDITOR_ROOT} #a`);
    await page.locator(REPLY_FIELD).fill('R');

    await page.locator(NEXT).click();

    await expect.poll(() => readPopupEntries(page)).toEqual(['two']);
    expect(await page.locator(`${EDITOR_ROOT} #a > comment-reply`).allTextContents()).toEqual(['R']);
  });

  test('arrow keys taken over for moving do not reach VS Code', async ({ page }) => {
    await openCommentEditor(page, THREE_COMMENTS);
    await openByItem(page, `${EDITOR_ROOT} #b`);
    await installForwardRecord(page);

    await page.keyboard.press('ArrowDown');

    await expect.poll(() => readPopupEntries(page)).toEqual(['three']);
    expect(await readForwardedKeys(page)).not.toContain('ArrowDown');
  });
});
