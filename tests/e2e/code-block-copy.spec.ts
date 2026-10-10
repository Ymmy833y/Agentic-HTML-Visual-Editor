import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  MESSAGE_CATALOG_ELEMENT_ID,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { CODE_BLOCK_COPY_ELEMENT_ID } from '../../webview/ui/code-block-copy';
import { COPIED_ICON_PATH, COPIED_ICON_TIMEOUT_MS, COPY_ICON_PATH } from '../../webview/ui/copy-button';
import { SEARCH_PANEL_ELEMENT_ID } from '../../webview/ui/search-panel';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLTIP_ELEMENT_ID } from '../../webview/ui/tooltip';
import { EDITOR_ROOT } from './helpers/editing';
import { PROBE_BUNDLE_PATH, getOutboundMessages, openWebviewHost, sendToWebview } from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const BUTTON = `#${CODE_BLOCK_COPY_ELEMENT_ID}`;
const BUTTON_ICON = `${BUTTON} svg path`;
const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;
const SEARCH_PANEL = `#${SEARCH_PANEL_ELEMENT_ID}`;
const PRE = `${EDITOR_ROOT} pre`;
const PARAGRAPH = `${EDITOR_ROOT} p`;

// A code block of two lines between two paragraphs. The second line is indented, and the line break at the end of the
// code is not displayed.
const CODE_BODY = '<p>before</p>\n<pre><code>line 1\n  line 2\n</code></pre>\n<p>after</p>';
// Two code blocks with a paragraph between them.
const TWO_BLOCKS_BODY = '<pre><code>first</code></pre>\n<p>between</p>\n<pre><code>second</code></pre>';
// A code block tall enough to scroll under the toolbar.
const TALL_BODY = `<p>before</p>\n<pre><code>${Array.from({ length: 80 }, (_, index) => `line ${index}`).join('\n')}</code></pre>`;

/**
 * Theme variables for light, dark, and high contrast, and the colors expected for the foreground and the border (the
 * variable values converted to rgb).
 */
const THEMES = [
  {
    variables: {
      '--vscode-editor-background': '#ffffff',
      '--vscode-editor-foreground': '#3b3b3b',
      '--vscode-panel-border': '#e5e5e5',
    },
    foreground: 'rgb(59, 59, 59)',
    border: 'rgb(229, 229, 229)',
  },
  {
    variables: {
      '--vscode-editor-background': '#1f1f1f',
      '--vscode-editor-foreground': '#cccccc',
      '--vscode-panel-border': '#2b2b2b',
    },
    foreground: 'rgb(204, 204, 204)',
    border: 'rgb(43, 43, 43)',
  },
  {
    variables: {
      '--vscode-editor-background': '#000000',
      '--vscode-editor-foreground': '#ffffff',
      '--vscode-panel-border': '#6fc3df',
    },
    foreground: 'rgb(255, 255, 255)',
    border: 'rgb(111, 195, 223)',
  },
];

/** A rectangle relative to the viewport. */
interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Embeds the English message catalog and then mounts the body.
 *
 * @param page The page to operate on.
 * @param body The body to mount.
 */
async function openCodeEditor(page: Page, body: string): Promise<void> {
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
 * Reads the rectangle of the first element that matches the selector.
 *
 * @param page The page to operate on.
 * @param selector The element's selector.
 */
async function readRect(page: Page, selector: string): Promise<Rect> {
  return page.locator(selector).first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  });
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
 * Selects inside the text of the first paragraph. Moves focus to the editor root first.
 *
 * @param page The page to operate on.
 * @param start The start offset.
 * @param end The end offset.
 */
async function selectInParagraph(page: Page, start: number, end: number): Promise<void> {
  await page.evaluate((argument) => {
    const text = document.querySelector(argument.selector)?.firstChild;
    if (text === null || text === undefined) {
      throw new Error(`no text: ${argument.selector}`);
    }
    document.getElementById(argument.rootId)?.focus();
    const range = document.createRange();
    range.setStart(text, argument.start);
    range.setEnd(text, argument.end);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { selector: PARAGRAPH, rootId: EDITOR_ROOT_ELEMENT_ID, start, end });
}

/**
 * Reads the contents of the editor root, the anchor and focus of the selection, and the ID of the focused element.
 *
 * @param page The page to operate on.
 */
async function readTreeSelectionAndFocus(page: Page): Promise<unknown[]> {
  return page.evaluate((rootId) => {
    const selection = window.getSelection();
    return [
      document.getElementById(rootId)?.innerHTML,
      selection?.anchorNode?.textContent,
      selection?.anchorOffset,
      selection?.focusNode?.textContent,
      selection?.focusOffset,
      document.activeElement?.id,
    ];
  }, EDITOR_ROOT_ELEMENT_ID);
}

/**
 * Scrolls the view by the given distance.
 *
 * @param page The page to operate on.
 * @param distance The distance to scroll down (px).
 */
async function scrollBy(page: Page, distance: number): Promise<void> {
  await page.evaluate((top) => window.scrollBy(0, top), distance);
}

test.describe('showing the copy button', () => {
  test('keeps the button hidden until the pointer comes, then shows it 4px inside the top and right edges of the code block under the pointer', async ({ page }) => {
    await openCodeEditor(page, CODE_BODY);
    const hiddenBefore = await page.locator(BUTTON).isHidden();

    await page.locator(PRE).hover();

    const block = await readRect(page, PRE);
    const button = await readRect(page, BUTTON);
    expect([hiddenBefore, Math.round(block.right - button.right), Math.round(button.top - block.top)])
      .toEqual([true, 4, 4]);
  });

  test('hides the button when the pointer moves from the code block to a paragraph', async ({ page }) => {
    await openCodeEditor(page, CODE_BODY);
    await page.locator(PRE).hover();
    await expect(page.locator(BUTTON)).toBeVisible();

    await page.locator(PARAGRAPH).last().hover();

    await expect(page.locator(BUTTON)).toBeHidden();
  });

  test('keeps the button shown when the pointer moves from the code block onto it', async ({ page }) => {
    await openCodeEditor(page, CODE_BODY);
    await page.locator(PRE).hover();

    await page.locator(BUTTON).hover();

    await expect(page.locator(BUTTON)).toBeVisible();
  });

  test('keeps the button shown, without hiding it even for a moment, when the pointer moves from it back into its code block', async ({ page }) => {
    await openCodeEditor(page, CODE_BODY);
    await page.locator(PRE).hover();
    await page.locator(BUTTON).hover();
    // The next pointer move over the code block shows a hidden button again at once, so only the record of each change
    // to hidden tells whether it was hidden on the way.
    await page.locator(BUTTON).evaluate((element) => {
      const changes: boolean[] = [];
      new MutationObserver(() => changes.push(element.hasAttribute('hidden')))
        .observe(element, { attributeFilter: ['hidden'] });
      Reflect.set(window, '__codeBlockCopyHiddenChanges', changes);
    });

    await page.locator(PRE).hover();

    expect([
      await page.evaluate(() => Reflect.get(window, '__codeBlockCopyHiddenChanges')),
      await page.locator(BUTTON).isVisible(),
    ]).toEqual([[], true]);
  });

  test('hides the shown button on a press outside it, even inside its code block with the pointer left in place', async ({ page }) => {
    await openCodeEditor(page, CODE_BODY);
    await page.locator(PRE).hover();
    await expect(page.locator(BUTTON)).toBeVisible();

    // Pressing without moving: a move onto another element would hide the button by itself.
    await page.mouse.down();
    const hidden = await page.locator(BUTTON).isHidden();
    await page.mouse.up();

    expect(hidden).toBe(true);
  });

  test('names the button Copy Code and shows the Copy Code tooltip while the pointer rests on it', async ({ page }) => {
    await openCodeEditor(page, CODE_BODY);
    await page.locator(PRE).hover();

    await page.locator(BUTTON).hover();

    await expect(page.locator(`#${TOOLTIP_ELEMENT_ID}`)).toHaveText('Copy Code');
    expect(await page.locator(BUTTON).getAttribute('aria-label')).toBe('Copy Code');
  });

  test('shows the button over a pre that holds no code', async ({ page }) => {
    await openCodeEditor(page, '<pre>plain\ntext</pre>');

    await page.locator(PRE).hover();

    await expect(page.locator(BUTTON)).toBeVisible();
  });

  test('does not show the button when the pointer comes onto a code block with the primary button held down from a paragraph', async ({ page }) => {
    await openCodeEditor(page, CODE_BODY);
    const paragraph = await readRect(page, PARAGRAPH);
    const block = await readRect(page, PRE);
    await page.mouse.move(paragraph.left + 2, (paragraph.top + paragraph.bottom) / 2);
    await page.mouse.down();

    await page.mouse.move((block.left + block.right) / 2, (block.top + block.bottom) / 2, { steps: 5 });

    const hidden = await page.locator(BUTTON).isHidden();
    await page.mouse.up();
    expect(hidden).toBe(true);
  });

  test('hides the shown button on a key press', async ({ page }) => {
    await openCodeEditor(page, CODE_BODY);
    await selectInParagraph(page, 1, 1);
    await page.locator(PRE).hover();
    await expect(page.locator(BUTTON)).toBeVisible();

    await page.keyboard.press('ArrowRight');

    await expect(page.locator(BUTTON)).toBeHidden();
  });

  test('hides the shown button when the document is replaced', async ({ page }) => {
    await openCodeEditor(page, CODE_BODY);
    await page.locator(PRE).hover();
    await expect(page.locator(BUTTON)).toBeVisible();

    const replaced = await page.evaluate(
      (text) => window.__documentReplacementProbe?.(text) ?? false,
      `${PROLOGUE}<p>replaced</p>${EPILOGUE}`,
    );

    expect([replaced, await page.locator(BUTTON).isHidden()]).toEqual([true, true]);
  });
});

test.describe('placing the copy button in the visible part', () => {
  test('shows the button just below the toolbar for a tall code block whose top edge is hidden under the toolbar', async ({ page }) => {
    await openCodeEditor(page, TALL_BODY);
    const toolbar = await readRect(page, TOOLBAR);
    await scrollBy(page, (await readRect(page, PRE)).top - toolbar.bottom + 200);
    const scrolled = await readRect(page, PRE);

    await page.mouse.move((scrolled.left + scrolled.right) / 2, toolbar.bottom + 100);

    const button = await readRect(page, BUTTON);
    expect([scrolled.top < toolbar.bottom, Math.round(button.top - toolbar.bottom), Math.round(scrolled.right - button.right)])
      .toEqual([true, 4, 4]);
  });

  test('shows the button just below the open search panel, with nothing over it, for a code block whose top edge is hidden under the panel', async ({ page }) => {
    await openCodeEditor(page, TALL_BODY);
    await selectInParagraph(page, 1, 1);
    await page.keyboard.press('ControlOrMeta+KeyF');
    await expect(page.locator(SEARCH_PANEL)).toBeVisible();
    const panel = await readRect(page, SEARCH_PANEL);
    await scrollBy(page, (await readRect(page, PRE)).top - panel.bottom + 200);
    const scrolled = await readRect(page, PRE);

    await page.mouse.move((scrolled.left + scrolled.right) / 2, panel.bottom + 100);

    const button = await readRect(page, BUTTON);
    const onTop = await page.evaluate((center) => (
      document.getElementById(center.id)?.contains(document.elementFromPoint(center.x, center.y)) === true
    ), { id: CODE_BLOCK_COPY_ELEMENT_ID, x: (button.left + button.right) / 2, y: (button.top + button.bottom) / 2 });
    expect([scrolled.top < panel.bottom, Math.round(button.top - panel.bottom), Math.round(scrolled.right - button.right), onTop])
      .toEqual([true, 4, 4, true]);
  });

  test('places the shown button again at the top right of the visible part when the view scrolls', async ({ page }) => {
    await openCodeEditor(page, TALL_BODY);
    const toolbar = await readRect(page, TOOLBAR);
    const block = await readRect(page, PRE);
    // The pointer rests on the upper part of the code block, whose top edge is still below the toolbar.
    await page.mouse.move((block.left + block.right) / 2, block.top + 40);
    await expect(page.locator(BUTTON)).toBeVisible();

    await scrollBy(page, block.top - toolbar.bottom + 200);

    await expect.poll(async () => Math.round((await readRect(page, BUTTON)).top - toolbar.bottom)).toBe(4);
  });
});

test.describe('pressing the copy button', () => {
  test('sends exactly one code block copy request carrying the code with its line breaks and indentation, without the trailing line break that is not displayed', async ({ page }) => {
    await openCodeEditor(page, CODE_BODY);
    await page.locator(PRE).hover();
    const sentBefore = (await getOutboundMessages(page)).length;

    await page.locator(BUTTON).click();

    expect((await getOutboundMessages(page)).slice(sentBefore)).toEqual([
      { type: VIEW_TO_HOST_MESSAGE_TYPE.codeBlockCopyRequested, text: 'line 1\n  line 2' },
    ]);
  });

  test('leaves the text of comment entries out of the code it sends', async ({ page }) => {
    await openCodeEditor(page, '<pre><code>a<comment id="c">b<comment-body>note</comment-body></comment>c</code></pre>');
    await page.locator(PRE).hover();

    await page.locator(BUTTON).click();

    expect((await readMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.codeBlockCopyRequested))
      .map((message) => Reflect.get(message, 'text'))).toEqual(['abc']);
  });

  test('leaves the tree, the selection and the focus unchanged, and sends neither a view edited message nor an edit transaction', async ({ page }) => {
    await openCodeEditor(page, CODE_BODY);
    await selectInParagraph(page, 1, 3);
    const before = await readTreeSelectionAndFocus(page);
    await page.locator(PRE).hover();

    await page.locator(BUTTON).click();

    await expect.poll(() => readMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.codeBlockCopyRequested)).toHaveLength(1);
    expect([
      await readTreeSelectionAndFocus(page),
      (await readMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.viewEdited)).length,
      (await readMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).length,
    ]).toEqual([before, 0, 0]);
  });

  test('still sends the code block copy request when pressed during IME composition', async ({ page }) => {
    await openCodeEditor(page, CODE_BODY);
    await selectInParagraph(page, 6, 6);
    const ime = await page.context().newCDPSession(page);
    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    await page.locator(PRE).hover();

    await page.locator(BUTTON).click();

    await expect.poll(() => readMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.codeBlockCopyRequested)).toHaveLength(1);
  });

  test('neither sends a request nor stays shown when pressed after its code block left the tree', async ({ page }) => {
    await openCodeEditor(page, CODE_BODY);
    await page.locator(PRE).hover();
    await expect(page.locator(BUTTON)).toBeVisible();
    // Taken out of the tree without a key or a document replacement.
    await page.locator(PRE).evaluate((element) => element.remove());

    await page.locator(BUTTON).dispatchEvent('click');

    expect([
      await readMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.codeBlockCopyRequested),
      await page.locator(BUTTON).isHidden(),
    ]).toEqual([[], true]);
  });
});

test.describe('showing the copy result on the copy button', () => {
  test('turns the icon into the check mark when the success message arrives, keeping the name Copy Code', async ({ page }) => {
    await openCodeEditor(page, CODE_BODY);
    await page.locator(PRE).hover();

    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.codeBlockCopySucceeded });

    expect([
      await page.locator(BUTTON_ICON).getAttribute('d'),
      await page.locator(BUTTON).getAttribute('aria-label'),
    ]).toEqual([COPIED_ICON_PATH, 'Copy Code']);
  });

  test('returns the icon to the clipboard 2 seconds after the success message', async ({ page }) => {
    await page.clock.install();
    await openCodeEditor(page, CODE_BODY);
    await page.locator(PRE).hover();
    // From here on only runFor moves the page clock. With the clock running, how long each step takes would decide
    // whether the icon is read before or after the time runs out.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.codeBlockCopySucceeded });

    await page.clock.runFor(COPIED_ICON_TIMEOUT_MS - 1);
    const justBefore = await page.locator(BUTTON_ICON).getAttribute('d');
    await page.clock.runFor(1);

    expect([justBefore, await page.locator(BUTTON_ICON).getAttribute('d')]).toEqual([COPIED_ICON_PATH, COPY_ICON_PATH]);
  });

  test('returns the icon to the clipboard when the button moves to another code block during the check mark', async ({ page }) => {
    await openCodeEditor(page, TWO_BLOCKS_BODY);
    await page.locator(PRE).first().hover();
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.codeBlockCopySucceeded });
    const copied = await page.locator(BUTTON_ICON).getAttribute('d');

    await page.locator(PRE).nth(1).hover();

    expect([copied, await page.locator(BUTTON_ICON).getAttribute('d')]).toEqual([COPIED_ICON_PATH, COPY_ICON_PATH]);
  });
});

test.describe('the look of the copy button', () => {
  test('draws the border in the border color and the icon in the foreground color in light, dark and high contrast alike', async ({ page }) => {
    await openCodeEditor(page, CODE_BODY);
    await page.locator(PRE).hover();

    const drawn: string[][] = [];
    for (const theme of THEMES) {
      await page.evaluate((variables) => {
        for (const [name, value] of Object.entries(variables)) {
          document.documentElement.style.setProperty(name, value);
        }
      }, theme.variables);
      drawn.push([
        await page.locator(BUTTON).evaluate((element) => getComputedStyle(element).borderTopColor),
        await page.locator(`${BUTTON} svg`).evaluate((element) => getComputedStyle(element).stroke),
      ]);
    }

    expect(drawn).toEqual(THEMES.map((theme) => [theme.border, theme.foreground]));
  });
});
