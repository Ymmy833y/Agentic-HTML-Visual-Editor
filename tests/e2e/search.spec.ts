import { expect, test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';

import {
  DOCUMENT_APPLY_KIND,
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  MESSAGE_CATALOG_ELEMENT_ID,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import type { EditTransaction, EncodedSelection } from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { SEARCH_HIGHLIGHT_NAME } from '../../webview/search/search-highlight';
import { BLOCK_TYPE_MENU_CLASS } from '../../webview/ui/block-type-menu';
import { COMMENT_POPUP_ELEMENT_ID } from '../../webview/ui/comment-popup';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import { OVERLAY_ELEMENT_ID } from '../../webview/ui/overlay-presenter';
import { SEARCH_PANEL_ELEMENT_ID } from '../../webview/ui/search-panel';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { EDITOR_ROOT, readBodyHtml } from './helpers/editing';
import { PROBE_BUNDLE_PATH, getOutboundMessages, openWebviewHost, sendToWebview } from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const PANEL = `#${SEARCH_PANEL_ELEMENT_ID}`;
const FIELD = `${PANEL} input[aria-label="${englishMessages['search.field']}"]`;
const COUNT = `${PANEL} [role="status"]`;
const MATCH_CASE = `${PANEL} button[aria-label="${englishMessages['search.matchCase']}"]`;
const WHOLE_WORD = `${PANEL} button[aria-label="${englishMessages['search.wholeWord']}"]`;
const PREVIOUS = `${PANEL} button[aria-label="${englishMessages['search.previous']}"]`;
const NEXT = `${PANEL} button[aria-label="${englishMessages['search.next']}"]`;
const CLOSE = `${PANEL} button[aria-label="${englishMessages['search.close']}"]`;
const TOGGLE_REPLACE = `${PANEL} button[aria-label="${englishMessages['search.toggleReplace']}"]`;
const REPLACE_FIELD = `${PANEL} input[aria-label="${englishMessages['search.replaceField']}"]`;
const REPLACE = `${PANEL} button[aria-label="${englishMessages['search.replace']}"]`;
const REPLACE_ALL = `${PANEL} button[aria-label="${englishMessages['search.replaceAll']}"]`;
/** The replace key of the platform the tests run on. Cmd+H hides the application on macOS. */
const REPLACE_KEY = process.platform === 'darwin' ? 'Meta+Alt+KeyF' : 'Control+KeyH';
const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;
const POPUP = `#${COMMENT_POPUP_ELEMENT_ID}`;
const POPUP_ENTRY = `${POPUP} .comment-popup-entry`;

/** A resolved comment whose annotated text is "this phrase". Its ID contains i27twz. */
const RESOLVED_THREAD = '<p>It shows <comment id="c-i27twz0q" data-resolved="">this phrase'
  + '<comment-body>the note</comment-body></comment> inline.</p>';

/** Paragraphs that make the document tall. They contain none of the search words (cat, okapi). */
const FILLER = '<p>lorem</p>'.repeat(60);

/**
 * Theme variables for light, dark, and high contrast, and the colors expected for the pressed-state border and the
 * focus outline (the variable values converted to rgb).
 */
const THEMES = [
  {
    variables: {
      '--vscode-editor-background': '#ffffff',
      '--vscode-editor-foreground': '#3b3b3b',
      '--vscode-panel-border': '#e5e5e5',
      '--vscode-textLink-foreground': '#005fb8',
      '--vscode-textCodeBlock-background': '#f8f8f8',
      '--vscode-focusBorder': '#0078d4',
    },
    accent: 'rgb(0, 95, 184)',
    focusRing: 'rgb(0, 120, 212)',
  },
  {
    variables: {
      '--vscode-editor-background': '#1f1f1f',
      '--vscode-editor-foreground': '#cccccc',
      '--vscode-panel-border': '#2b2b2b',
      '--vscode-textLink-foreground': '#4daafc',
      '--vscode-textCodeBlock-background': '#2b2b2b',
      '--vscode-focusBorder': '#0078d4',
    },
    accent: 'rgb(77, 170, 252)',
    focusRing: 'rgb(0, 120, 212)',
  },
  {
    variables: {
      '--vscode-editor-background': '#000000',
      '--vscode-editor-foreground': '#ffffff',
      '--vscode-panel-border': '#6fc3df',
      '--vscode-textLink-foreground': '#21a6ff',
      '--vscode-textCodeBlock-background': '#000000',
      '--vscode-focusBorder': '#f38518',
    },
    accent: 'rgb(33, 166, 255)',
    focusRing: 'rgb(243, 133, 24)',
  },
];

declare global {
  interface Window {
    /**
     * The record of forwarding to VS Code. Holds the code of each keydown that reached window in the bubbling phase,
     * in arrival order.
     */
    __forwardedKeys?: string[];
    /** The IDs of collapsible sections in the order they got the open attribute. */
    __openedDetails?: string[];
  }
}

/**
 * Embeds the English message catalog and then mounts the body. If messages stayed as keys, the count and names users
 * see could not be checked.
 *
 * @param page The page to operate on.
 * @param body The body to mount.
 */
async function openSearchEditor(page: Page, body: string): Promise<void> {
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
 * Moves focus to the editor root and selects a range in the text of an element's first child.
 *
 * @param page The page to operate on.
 * @param selector The selector of the start element.
 * @param start The start offset.
 * @param end The end offset.
 * @param endSelector The selector of the end element. If omitted, the same element as the start.
 */
async function selectText(page: Page, selector: string, start: number, end: number, endSelector = selector): Promise<void> {
  await page.evaluate((argument) => {
    const startNode = document.querySelector(argument.selector)?.firstChild;
    const endNode = document.querySelector(argument.endSelector)?.firstChild;
    if (startNode === null || startNode === undefined || endNode === null || endNode === undefined) {
      throw new Error(`Text not found: ${argument.selector}`);
    }
    document.getElementById(argument.rootId)?.focus();
    const range = document.createRange();
    range.setStart(startNode, argument.start);
    range.setEnd(endNode, argument.end);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { selector, start, end, endSelector, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Moves focus to the editor root and places the caret in the text of an element's first child.
 *
 * @param page The page to operate on.
 * @param selector The selector of the element.
 * @param offset The offset in the text.
 */
async function placeCaret(page: Page, selector: string, offset: number): Promise<void> {
  await selectText(page, selector, offset, offset);
}

/**
 * Presses primary modifier+F and waits for the panel to open.
 *
 * @param page The page to operate on.
 */
async function openSearch(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+KeyF');
  await expect(page.locator(PANEL)).toBeVisible();
}

/**
 * Applies theme variables on the root element, where VS Code puts them.
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
 * Reads computed style values of an element.
 *
 * @param page The page to operate on.
 * @param selector The selector of the element.
 * @param properties The property names to read.
 * @returns The values, in the order of the names.
 */
async function readComputed(page: Page, selector: string, properties: readonly string[]): Promise<string[]> {
  return page.locator(selector).evaluate(
    (element, names) => names.map((name) => getComputedStyle(element).getPropertyValue(name)),
    properties,
  );
}

/**
 * Reads the search count text.
 *
 * @param page The page to operate on.
 * @returns The search count text.
 */
async function readCount(page: Page): Promise<string> {
  return (await page.locator(COUNT).textContent()) ?? '';
}

/**
 * Reads the ranges registered in a highlight.
 *
 * @param page The page to operate on.
 * @param name The highlight name.
 * @returns For each range, the container text and offset of its start and end. `null` if nothing is registered.
 */
async function readHighlight(page: Page, name: string): Promise<(string | number | null)[][] | null> {
  return page.evaluate((highlightName) => {
    const highlight = CSS.highlights.get(highlightName);
    if (highlight === undefined) {
      return null;
    }
    return [...highlight].map((range) => [
      range.startContainer.textContent,
      range.startOffset,
      range.endContainer.textContent,
      range.endOffset,
    ]);
  }, name);
}

/**
 * Starts recording, in place of forwarding to VS Code, the code of each keydown that reaches window in the bubbling
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
 * Reads the forwarding record.
 *
 * @param page The page to operate on.
 * @returns The codes of the keydowns that arrived.
 */
async function readForwardedKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__forwardedKeys ?? []);
}

/**
 * Starts recording the order in which collapsible sections get the open attribute.
 *
 * @param page The page to operate on.
 */
async function recordOpenedDetails(page: Page): Promise<void> {
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
}

/**
 * Reads the text from the start of the editor root to the start of the selection.
 *
 * @param page The page to operate on.
 * @returns The text. `null` if there is no selection.
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
 * @param page The page to operate on.
 * @returns The container text and offset of the start and end.
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
 * Reads the vertical scroll position.
 *
 * @param page The page to operate on.
 * @returns The scroll position.
 */
async function readScrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY);
}

/**
 * Returns whether an element lies within the reveal band, from the bottom of the search panel to the bottom of the
 * viewport.
 *
 * @param page The page to operate on.
 * @param selector The selector of the element.
 * @returns Whether the whole element is within the band.
 */
async function isInRevealBand(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((selectors) => {
    const top = document.querySelector(selectors.panel)?.getBoundingClientRect().bottom ?? 0;
    const rect = document.querySelector(selectors.target)?.getBoundingClientRect();
    return rect !== undefined && rect.top >= top && rect.bottom <= window.innerHeight;
  }, { panel: PANEL, target: selector });
}

/**
 * Replaces the body through the replace document entry.
 *
 * @param page The page to operate on.
 * @param body The new body.
 * @returns Whether the document was replaced.
 */
async function replaceDocument(page: Page, body: string): Promise<boolean> {
  return page.evaluate((text) => window.__documentReplacementProbe?.(text) ?? false, `${PROLOGUE}${body}${EPILOGUE}`);
}

/**
 * Shows the overlay without content and stops input. Uses the same reason as the save round trip.
 *
 * @param page The page to operate on.
 */
async function stopInput(page: Page): Promise<void> {
  await page.evaluate((reason) => {
    window.__uiShellProbe?.()?.overlay.present(reason, { heading: '', descriptions: [], actions: [] });
  }, INPUT_STOP_REASON.saveRoundTrip);
}

/**
 * Lowers the overlay and ends the input stop.
 *
 * @param page The page to operate on.
 */
async function resumeInput(page: Page): Promise<void> {
  await page.evaluate((reason) => window.__uiShellProbe?.()?.overlay.dismiss(reason), INPUT_STOP_REASON.saveRoundTrip);
}

/**
 * Reads the edit transactions sent to the host.
 *
 * @param page The page to operate on.
 * @returns The transactions in the order they were sent.
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
      // The value after narrowing by type and shape; messages of this type carry only the edit unit.
      return [message.transaction as EditTransaction];
    }
    return [];
  });
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
 * Opens a session that drives the browser's IME.
 *
 * @param page The page to operate on.
 * @returns The opened session.
 */
async function openImeSession(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/**
 * Creates a collapsed encoded selection that points at an offset in the text of a one-line body.
 *
 * @param column The column.
 * @returns The encoded selection.
 */
function caretAt(column: number): EncodedSelection {
  return { start: { line: 0, column }, end: { line: 0, column } };
}

/**
 * Extracts the body from the full document text.
 *
 * @param text The full document text.
 * @returns The body.
 */
function readBody(text: string): string {
  return text.slice(PROLOGUE.length, text.length - EPILOGUE.length);
}

test.describe('registering the entry point', () => {
  test('Ctrl+F in the editor root opens the panel and focuses the search field, and Ctrl+F does not reach the forwarded key record', async ({ page }) => {
    await openSearchEditor(page, '<p>cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await installForwardRecord(page);

    await page.keyboard.press('ControlOrMeta+KeyF');

    await expect(page.locator(PANEL)).toBeVisible();
    await expect(page.locator(FIELD)).toBeFocused();
    expect((await readForwardedKeys(page)).includes('KeyF')).toBe(false);
  });

  test('after a document replacement, Ctrl+F still leaves exactly one panel and counts matches in the new tree', async ({ page }) => {
    await openSearchEditor(page, '<p>cat</p>');
    await replaceDocument(page, '<p>dog dog</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);

    await openSearch(page);
    await page.keyboard.type('dog');

    expect([await page.locator(PANEL).count(), await readCount(page)]).toEqual([1, '1 of 2']);
  });

  test('in an unopenable document, Ctrl+F reaches the forwarded key record and no panel is created', async ({ page }) => {
    await openWebviewHost(page, PROBE_BUNDLE_PATH);
    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
      text: `${PROLOGUE}<p>a</p><script>b</script>${EPILOGUE}`,
      documentUri: '',
      resourceRootUri: '',
    });
    await expect(page.locator(`#${OVERLAY_ELEMENT_ID}`)).toBeVisible();
    await installForwardRecord(page);

    await page.keyboard.press('ControlOrMeta+KeyF');

    expect([(await readForwardedKeys(page)).includes('KeyF'), await page.locator(PANEL).count()]).toEqual([true, 0]);
  });

  test('when an external change replaces the document while the search field has focus, the field keeps focus and selection, and further typing goes into the field', async ({ page }) => {
    await openSearchEditor(page, '<p>cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('ca');
    await page.locator(FIELD).evaluate((field: HTMLInputElement) => field.setSelectionRange(1, 2));

    await replaceDocument(page, '<p>cattle</p>');
    await page.keyboard.type('t');

    await expect(page.locator(FIELD)).toBeFocused();
    expect([await page.locator(FIELD).inputValue(), await readBodyHtml(page)]).toEqual(['ct', '<p>cattle</p>']);
  });
});

test.describe('presenting the panel and accepting operations', () => {
  test('opening with the caret at the document start and typing cat registers 3 matches in ahve-search-match and the first in ahve-search-current, with the count 1 of 3', async ({ page }) => {
    await openSearchEditor(page, '<p>cat and cat</p><p>cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);

    await page.keyboard.type('cat');

    expect([
      await readHighlight(page, SEARCH_HIGHLIGHT_NAME.match),
      await readHighlight(page, SEARCH_HIGHLIGHT_NAME.current),
      await readCount(page),
    ]).toEqual([
      [['cat and cat', 0, 'cat and cat', 3], ['cat and cat', 8, 'cat and cat', 11], ['cat', 0, 'cat', 3]],
      [['cat and cat', 0, 'cat and cat', 3]],
      '1 of 3',
    ]);
  });

  test('the top of the opened panel aligns with the bottom of the toolbar and does not overlap it', async ({ page }) => {
    await openSearchEditor(page, '<p>cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);

    await openSearch(page);

    const edges = await page.evaluate((selectors) => [
      document.querySelector(selectors.toolbar)?.getBoundingClientRect().bottom ?? Number.NaN,
      document.querySelector(selectors.panel)?.getBoundingClientRect().top ?? Number.NaN,
    ], { toolbar: TOOLBAR, panel: PANEL });
    expect(edges[1] - edges[0]).toBeCloseTo(0, 2);
  });

  test('during IME composition in the search field the highlight and count do not change, and committing recomputes with the committed text', async ({ page }) => {
    await openSearchEditor(page, '<p>cat and cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    const ime = await openImeSession(page);

    await ime.send('Input.imeSetComposition', { text: 'ca', selectionStart: 2, selectionEnd: 2 });
    const during = [await readCount(page), await readHighlight(page, SEARCH_HIGHLIGHT_NAME.match)];
    await ime.send('Input.insertText', { text: 'cat' });

    expect([during, await readCount(page)]).toEqual([['', null], '1 of 2']);
  });

  test('Ctrl+Z in the search field reaches the forwarded key record, while Ctrl+B does not and leaves the tree unchanged', async ({ page }) => {
    await openSearchEditor(page, '<p>cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await installForwardRecord(page);

    await page.keyboard.press('ControlOrMeta+KeyZ');
    await page.keyboard.press('ControlOrMeta+KeyB');

    const forwarded = await readForwardedKeys(page);
    expect([forwarded.includes('KeyZ'), forwarded.includes('KeyB'), await readBodyHtml(page)])
      .toEqual([true, false, '<p>cat</p>']);
  });

  test('in light, dark, and high contrast alike, a pressed toggle is told apart from an unpressed one by its border, and a keyboard-focused control has an outline', async ({ page }) => {
    await openSearchEditor(page, '<p>cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.locator(MATCH_CASE).click();
    await page.keyboard.press('Tab');
    await expect(page.locator(MATCH_CASE)).toBeFocused();

    const drawn: string[][] = [];
    for (const theme of THEMES) {
      await page.evaluate((variables) => {
        for (const [name, value] of Object.entries(variables)) {
          document.documentElement.style.setProperty(name, value);
        }
      }, theme.variables);
      drawn.push([
        await page.locator(MATCH_CASE).evaluate((element) => getComputedStyle(element).borderTopColor),
        await page.locator(WHOLE_WORD).evaluate((element) => getComputedStyle(element).borderTopColor),
        await page.locator(MATCH_CASE).evaluate((element) => getComputedStyle(element).outlineStyle),
        await page.locator(MATCH_CASE).evaluate((element) => getComputedStyle(element).outlineColor),
      ]);
    }

    expect(drawn).toEqual(THEMES.map((theme) => [theme.accent, 'rgba(0, 0, 0, 0)', 'solid', theme.focusRing]));
  });

  test('the panel has its two lower corners rounded with a 6px radius, its two upper corners square, and a shadow', async ({ page }) => {
    await openSearchEditor(page, '<p>cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);

    await openSearch(page);

    const [topLeft, topRight, bottomLeft, bottomRight, shadow] = await readComputed(page, PANEL, [
      'border-top-left-radius',
      'border-top-right-radius',
      'border-bottom-left-radius',
      'border-bottom-right-radius',
      'box-shadow',
    ]);
    expect([topLeft, topRight, bottomLeft, bottomRight, shadow !== 'none']).toEqual(['0px', '0px', '6px', '6px', true]);
  });

  test('the search field takes VS Code\'s input field colors from the variables', async ({ page }) => {
    await openSearchEditor(page, '<p>cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await applyThemeVariables(page, {
      '--vscode-input-background': 'rgb(49, 49, 51)',
      '--vscode-input-foreground': 'rgb(204, 204, 206)',
      '--vscode-input-border': 'rgb(60, 60, 61)',
    });

    await openSearch(page);

    expect(await readComputed(page, FIELD, ['background-color', 'color', 'border-top-color']))
      .toEqual(['rgb(49, 49, 51)', 'rgb(204, 204, 206)', 'rgb(60, 60, 61)']);
  });

  test('a pressed toggle takes VS Code\'s toggle background, border and text colors from the variables', async ({ page }) => {
    await openSearchEditor(page, '<p>cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await applyThemeVariables(page, {
      '--vscode-inputOption-activeBackground': 'rgb(190, 214, 237)',
      '--vscode-inputOption-activeBorder': 'rgb(0, 95, 185)',
      '--vscode-inputOption-activeForeground': 'rgb(1, 1, 1)',
    });
    await openSearch(page);

    await page.locator(MATCH_CASE).click();

    expect(await readComputed(page, MATCH_CASE, ['background-color', 'border-top-color', 'color']))
      .toEqual(['rgb(190, 214, 237)', 'rgb(0, 95, 185)', 'rgb(1, 1, 1)']);
  });

  test('a button under the pointer gets the code background', async ({ page }) => {
    await openSearchEditor(page, '<p>cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await applyThemeVariables(page, { '--vscode-textCodeBlock-background': 'rgb(240, 241, 242)' });
    await openSearch(page);

    await page.locator(NEXT).hover();

    expect(await readComputed(page, NEXT, ['background-color'])).toEqual(['rgb(240, 241, 242)']);
  });

  test('Tab from the search field moves through the toggles, previous, next, and close in order, and Shift+Tab in the field moves to the replace toggle and then to the editor root, back to the caret position before Ctrl+F', async ({ page }) => {
    await openSearchEditor(page, '<p>abc</p><p>def</p>');
    await placeCaret(page, `${EDITOR_ROOT} p:nth-of-type(2)`, 1);
    await openSearch(page);

    const visited: (string | null)[] = [];
    for (let count = 0; count < 5; count += 1) {
      await page.keyboard.press('Tab');
      visited.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null));
    }
    await page.locator(FIELD).focus();
    await page.keyboard.press('Shift+Tab');
    const before = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);
    await page.keyboard.press('Shift+Tab');

    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
    expect([visited, before, await readCaretPrefix(page)]).toEqual([
      ['Match Case', 'Match Whole Word', 'Previous Match', 'Next Match', 'Close'],
      'Toggle Replace',
      'abcd',
    ]);
  });

  test('input in the search field updates the count even during the save round trip (overlay without content)', async ({ page }) => {
    await openSearchEditor(page, '<p>cat cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await stopInput(page);

    await page.keyboard.type('cat');

    expect(await readCount(page)).toBe('1 of 2');
  });
});

test.describe('opening and moving to the search field', () => {
  test('selecting dog in the second paragraph and pressing Ctrl+F makes the query dog and the selected occurrence the current match (2 of 3)', async ({ page }) => {
    await openSearchEditor(page, '<p>dog</p><p>a dog</p><p>dog b</p>');
    await selectText(page, `${EDITOR_ROOT} p:nth-of-type(2)`, 2, 5);

    await openSearch(page);

    expect([await page.locator(FIELD).inputValue(), await readCount(page)]).toEqual(['dog', '2 of 3']);
  });

  test('Ctrl+F with a range spanning two paragraphs leaves the query at its previous value', async ({ page }) => {
    await openSearchEditor(page, '<p>abc</p><p>def</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('zzz');
    await page.keyboard.press('Escape');
    await selectText(page, `${EDITOR_ROOT} p`, 1, 1, `${EDITOR_ROOT} p:nth-of-type(2)`);

    await openSearch(page);

    expect(await page.locator(FIELD).inputValue()).toBe('zzz');
  });

  test('Ctrl+F with a word and its trailing space selected makes the query the word without the space', async ({ page }) => {
    await openSearchEditor(page, '<p>cat dog</p>');
    await selectText(page, `${EDITOR_ROOT} p`, 0, 4);

    await openSearch(page);

    expect(await page.locator(FIELD).inputValue()).toBe('cat');
  });

  test('moving the caret to a later paragraph while open and pressing Ctrl+F keeps the query and makes the first match after the caret current', async ({ page }) => {
    await openSearchEditor(page, '<p>cat</p><p>x</p><p>cat</p><p>cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('cat');
    await placeCaret(page, `${EDITOR_ROOT} p:nth-of-type(2)`, 1);

    await page.keyboard.press('ControlOrMeta+KeyF');

    expect([await page.locator(FIELD).inputValue(), await readCount(page)]).toEqual(['cat', '2 of 3']);
  });

  test('Ctrl+F on a panel button moves to the search field and selects all its text, leaving the count unchanged', async ({ page }) => {
    await openSearchEditor(page, '<p>cat cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('cat');
    await page.keyboard.press('Tab');
    await expect(page.locator(MATCH_CASE)).toBeFocused();

    await page.keyboard.press('ControlOrMeta+KeyF');

    await expect(page.locator(FIELD)).toBeFocused();
    const selected = await page.locator(FIELD).evaluate((field: HTMLInputElement) => [field.selectionStart, field.selectionEnd]);
    expect([selected, await readCount(page)]).toEqual([[0, 3], '1 of 2']);
  });

  test('Ctrl+F during IME composition in the editor root neither opens the panel nor reaches the forwarded key record', async ({ page }) => {
    await openSearchEditor(page, '<p>ab</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 2);
    await installForwardRecord(page);
    const ime = await openImeSession(page);
    await ime.send('Input.imeSetComposition', { text: 'a', selectionStart: 1, selectionEnd: 1 });

    await page.keyboard.press('ControlOrMeta+KeyF');

    expect([await page.locator(PANEL).isVisible(), (await readForwardedKeys(page)).includes('KeyF')])
      .toEqual([false, false]);
  });

  test('clicking the editor root while open, then clicking the search field and pressing Esc with a query that has no matches, returns to the clicked position rather than the Ctrl+F position', async ({ page }) => {
    await openSearchEditor(page, '<p>first line</p><p>second line</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('zzz');
    await page.locator(`${EDITOR_ROOT} p:nth-of-type(2)`).click({ position: { x: 30, y: 5 } });
    const clicked = await readCaretPrefix(page);
    await page.locator(FIELD).click();

    await page.keyboard.press('Escape');

    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
    expect([await readCaretPrefix(page), clicked === '']).toEqual([clicked, false]);
  });

  test('after selecting a range and pressing Ctrl+F, pressing the toolbar bold item with a pointer while the search field has focus makes the range bold and keeps the panel open', async ({ page }) => {
    await openSearchEditor(page, '<p>abcdef</p>');
    await selectText(page, `${EDITOR_ROOT} p`, 1, 4);
    await openSearch(page);

    await page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.bold}"] > button`).click();

    expect([await readBodyHtml(page), await page.locator(PANEL).isVisible()])
      .toEqual(['<p>a<strong>bcd</strong>ef</p>', true]);
  });

  test('opening the table picker while the search field has focus and inserting a table from its input puts the table at the caret position before Ctrl+F', async ({ page }) => {
    await openSearchEditor(page, '<p>ab</p><p>cd</p>');
    await placeCaret(page, `${EDITOR_ROOT} p:nth-of-type(2)`, 2);
    await openSearch(page);
    await page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.table}"] > button`).click();
    const inputs = page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.table}"] input`);
    await inputs.nth(0).fill('2');
    await inputs.nth(1).fill('2');

    await inputs.nth(1).press('Enter');

    await expect(page.locator(`${EDITOR_ROOT} > p:nth-of-type(2) + table`)).toHaveCount(1);
  });
});

test.describe('finding matches', () => {
  test('a word spanning bold, link, and annotated text boundaries is one match, while entry text, link targets, and image alt text do not match', async ({ page }) => {
    await openSearchEditor(
      page,
      '<p>c<strong>at</strong>tle <a href="https://cattle.test/">ca</a>ttle '
      + '<comment id="c-1">catt<comment-body>cattle note</comment-body></comment>le <img src="sample.png" alt="cattle"></p>',
    );
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);

    await page.keyboard.type('cattle');

    expect(await readCount(page)).toBe('1 of 3');
  });

  test('text spanning paragraphs, table cells, br, or line feeds in pre does not match, and words in adjacent cells of a table written on one line each match even with whole word', async ({ page }) => {
    await openSearchEditor(
      page,
      '<p>ab</p><p>cd</p><table><tbody><tr><td>cat</td><td>dog</td></tr></tbody></table>'
      + '<p>ef<br>gh</p><pre>ij\nkl</pre>',
    );
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);

    const counts: string[] = [];
    for (const query of ['bc', 'catdog', 'fg', 'jk']) {
      await page.locator(FIELD).fill(query);
      counts.push(await readCount(page));
    }
    await page.locator(WHOLE_WORD).click();
    for (const query of ['cat', 'dog']) {
      await page.locator(FIELD).fill(query);
      counts.push(await readCount(page));
    }

    expect(counts).toEqual(['No results', 'No results', 'No results', 'No results', '1 of 1', '1 of 1']);
  });

  test('source line feeds inside a paragraph and runs of spaces or U+00A0 match a single space in the query', async ({ page }) => {
    await openSearchEditor(page, '<p>red\nfox</p><p>big&nbsp;&nbsp; dog</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);

    const counts: string[] = [];
    for (const query of ['red fox', 'big dog']) {
      await page.locator(FIELD).fill(query);
      counts.push(await readCount(page));
    }

    expect(counts).toEqual(['1 of 1', '1 of 1']);
  });

  test('text inside elements with the hidden attribute and alert labels do not match, while text in the body of a closed collapsible section does', async ({ page }) => {
    await openSearchEditor(
      page,
      '<p>x</p><div hidden>secret</div><blockquote data-alert="note"><p>y</p></blockquote>'
      + '<details><summary>t</summary><p>inside</p></details>',
    );
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);

    const counts: string[] = [];
    for (const query of ['secret', englishMessages['alert.note'], 'inside']) {
      await page.locator(FIELD).fill(query);
      counts.push(await readCount(page));
    }

    expect(counts).toEqual(['No results', 'No results', '1 of 1']);
  });
});

test.describe('showing and moving between matches', () => {
  test('Enter moves next and wraps from last to first, Shift+Enter moves previous and wraps from first to last, and the count follows', async ({ page }) => {
    await openSearchEditor(page, '<p>cat cat cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('cat');

    const counts: string[] = [];
    for (const key of ['Enter', 'Enter', 'Enter', 'Shift+Enter']) {
      await page.keyboard.press(key);
      counts.push(await readCount(page));
    }

    expect(counts).toEqual(['2 of 3', '3 of 3', '1 of 3', '3 of 3']);
  });

  test('pressing the next and previous buttons with a pointer moves and returns focus to the search field', async ({ page }) => {
    await openSearchEditor(page, '<p>cat cat cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('cat');

    await page.locator(NEXT).click();
    const afterNext = [await readCount(page), await page.locator(FIELD).evaluate((field) => document.activeElement === field)];
    await page.locator(PREVIOUS).click();
    const afterPrevious = [await readCount(page), await page.locator(FIELD).evaluate((field) => document.activeElement === field)];

    expect([afterNext, afterPrevious]).toEqual([['2 of 3', true], ['1 of 3', true]]);
  });

  test('Enter with no matches changes neither the count nor the selection', async ({ page }) => {
    await openSearchEditor(page, '<p>cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('zzz');
    const readState = async (): Promise<unknown[]> => [
      await readCount(page),
      await page.locator(FIELD).evaluate((field: HTMLInputElement) => [field.selectionStart, field.selectionEnd]),
      await readSelectionEnds(page),
    ];
    const before = await readState();

    await page.keyboard.press('Enter');

    expect(await readState()).toEqual(before);
  });

  test('typing a word found only in the body of a closed collapsible section opens it as one edit, and moving to the next match does not close it again', async ({ page }) => {
    await openSearchEditor(page, '<details><summary>t</summary><p>okapi</p></details><p>okapi</p>');
    await placeCaret(page, `${EDITOR_ROOT} summary`, 0);
    await openSearch(page);

    await page.keyboard.type('okapi');
    const opened = await page.locator(`${EDITOR_ROOT} details`).getAttribute('open');
    await page.keyboard.press('Enter');

    expect([
      opened,
      await readCount(page),
      await page.locator(`${EDITOR_ROOT} details`).getAttribute('open'),
      (await readTransactions(page)).length,
    ]).toEqual(['', '2 of 2', '', 1]);
  });

  test('a match in the body of a closed inner section inside a closed outer body opens outer then inner as two edits, while a match in the inner title opens only the outer', async ({ page }) => {
    await openSearchEditor(
      page,
      '<details id="a"><summary>a</summary><details id="b"><summary>b</summary><p>okapi</p></details></details>'
      + '<details id="c"><summary>c</summary><details id="d"><summary>zebra</summary><p>x</p></details></details>',
    );
    await placeCaret(page, `${EDITOR_ROOT} summary`, 0);
    await recordOpenedDetails(page);
    await openSearch(page);

    await page.locator(FIELD).fill('okapi');
    const inBody = (await readTransactions(page)).length;
    await page.locator(FIELD).fill('zebra');

    expect([
      await page.evaluate(() => window.__openedDetails ?? []),
      inBody,
      await page.locator(`${EDITOR_ROOT} #d`).getAttribute('open'),
    ]).toEqual([['a', 'b', 'c'], 2, null]);
  });

  test('in the opening edit transactions, the before selection points at the end of the opened section title, and the after selection at the end of the next inner title or the current match', async ({ page }) => {
    await openSearchEditor(
      page,
      '<details id="outer"><summary>o</summary><details id="inner"><summary>i</summary><p>okapi</p></details></details>',
    );
    await placeCaret(page, `${EDITOR_ROOT} summary`, 0);
    await openSearch(page);

    await page.locator(FIELD).fill('okapi');

    const [outer, inner] = await readTransactions(page);
    // The body is one line, so a column is an offset in the body text.
    const titleEnd = (text: string, title: string): EncodedSelection => {
      const marker = `<summary>${title}`;
      return caretAt(readBody(text).indexOf(marker) + marker.length);
    };
    const match = readBody(inner.after.text).indexOf('okapi');
    expect([outer.before.selection, outer.after.selection, inner.before.selection, inner.after.selection]).toEqual([
      titleEnd(outer.before.text, 'o'),
      titleEnd(outer.after.text, 'i'),
      titleEnd(inner.before.text, 'i'),
      { start: { line: 0, column: match }, end: { line: 0, column: match + 'okapi'.length } },
    ]);
  });

  test('moving to a match below the viewport scrolls it into the reveal band, and moving to a match already in the band does not scroll', async ({ page }) => {
    await openSearchEditor(page, `<p>cat</p>${FILLER}<p id="far">cat</p><p>cat</p>`);
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('cat');
    const atFirst = await readScrollY(page);

    await page.keyboard.press('Enter');
    const atFar = await readScrollY(page);
    const band = await page.evaluate((selectors) => {
      const top = document.querySelector(selectors.panel)?.getBoundingClientRect().bottom ?? 0;
      const rect = document.querySelector(selectors.far)?.getBoundingClientRect();
      return rect !== undefined && rect.top >= top && rect.bottom <= window.innerHeight;
    }, { panel: PANEL, far: `${EDITOR_ROOT} #far` });
    await page.keyboard.press('Enter');

    expect([atFirst, atFar > 0, band, await readScrollY(page)]).toEqual([0, true, true, atFar]);
  });

  test('moving to a match hidden under the panel scrolls until it is no longer hidden', async ({ page }) => {
    await openSearchEditor(page, `${FILLER}<p id="target">cat</p>${FILLER}`);
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    // Scroll beforehand until the match paragraph sits between the bottom of the toolbar and the bottom of the panel.
    await page.evaluate((selectors) => {
      const toolbar = document.querySelector(selectors.toolbar)?.getBoundingClientRect().bottom ?? 0;
      const target = document.querySelector(selectors.target)?.getBoundingClientRect().top ?? 0;
      window.scrollBy(0, target - toolbar - 2);
    }, { toolbar: TOOLBAR, target: `${EDITOR_ROOT} #target` });
    const hiddenBefore = await page.evaluate((selectors) => {
      const top = document.querySelector(selectors.target)?.getBoundingClientRect().top ?? 0;
      return top < (document.querySelector(selectors.panel)?.getBoundingClientRect().bottom ?? 0);
    }, { panel: PANEL, target: `${EDITOR_ROOT} #target` });

    await page.locator(FIELD).fill('cat');

    const hiddenAfter = await page.evaluate((selectors) => {
      const top = document.querySelector(selectors.target)?.getBoundingClientRect().top ?? 0;
      return top < (document.querySelector(selectors.panel)?.getBoundingClientRect().bottom ?? 0);
    }, { panel: PANEL, target: `${EDITOR_ROOT} #target` });
    expect([hiddenBefore, hiddenAfter]).toEqual([true, false]);
  });

  test('moving to a match beyond the visible width of a long line in a horizontally scrolling pre scrolls the pre horizontally so the match is within its visible width', async ({ page }) => {
    // Long words around the match put it where it can be centered without reaching the end of the line.
    await openSearchEditor(page, `<p>okapi</p><pre>${'x'.repeat(400)} okapi ${'x'.repeat(400)}</pre>`);
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('okapi');
    const pre = page.locator(`${EDITOR_ROOT} pre`);
    const before = await pre.evaluate((element) => element.scrollLeft);

    await page.keyboard.press('Enter');

    const shown = await pre.evaluate((element) => {
      const text = element.firstChild;
      if (text === null) {
        return false;
      }
      const match = document.createRange();
      match.setStart(text, 401);
      match.setEnd(text, 406);
      const rect = match.getBoundingClientRect();
      const left = element.getBoundingClientRect().left + element.clientLeft;
      return rect.left >= left && rect.right <= left + element.clientWidth;
    });
    expect([before, await pre.evaluate((element) => element.scrollLeft > 0), shown]).toEqual([0, true, true]);
  });

  test('moving to a match beyond the viewport width inside a fixed-width table wider than the viewport scrolls the document horizontally so the match is within the viewport width', async ({ page }) => {
    // Long words in the editor root wrap, and a table without a width fits the editor root, so a fixed-width table
    // makes the whole document overflow horizontally. The match is in the middle column, where it can be centered
    // without reaching the edge of the document.
    await openSearchEditor(
      page,
      '<p>okapi</p><table style="width: 6200px"><colgroup><col style="width: 3000px"><col style="width: 200px">'
      + '<col style="width: 3000px"></colgroup><tbody><tr><td>a</td><td id="far">okapi</td><td>b</td></tr></tbody></table>',
    );
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('okapi');
    const before = await page.evaluate(() => window.scrollX);

    await page.keyboard.press('Enter');

    const shown = await page.locator(`${EDITOR_ROOT} #far`).evaluate((element) => {
      const text = element.firstChild;
      if (text === null) {
        return false;
      }
      const match = document.createRange();
      match.setStart(text, 0);
      match.setEnd(text, 5);
      const rect = match.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth;
    });
    expect([before, (await page.evaluate(() => window.scrollX)) > 0, shown]).toEqual([0, true, true]);
  });

  test('searching and moving in a document without closed collapsible sections leaves the body output unchanged and sends neither unsaved content nor edit transactions', async ({ page }) => {
    await openSearchEditor(page, '<p>cat cat</p>');
    const output = await readBodyOutput(page);
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);

    await page.keyboard.type('cat');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Enter');

    const sentTypes = (await getOutboundMessages(page)).map((message) => Reflect.get(Object(message), 'type'));
    expect([
      await readBodyOutput(page),
      sentTypes.filter((type) => [
        VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent,
        VIEW_TO_HOST_MESSAGE_TYPE.editTransaction,
        VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart,
        VIEW_TO_HOST_MESSAGE_TYPE.viewEdited,
      ].some((edited) => edited === type)),
    ]).toEqual([output, []]);
  });

  test('during the save round trip, moving to a match in a closed collapsible section neither opens nor scrolls, and Enter after the round trip opens it', async ({ page }) => {
    await openSearchEditor(page, '<p>okapi</p><details><summary>t</summary><p>okapi</p><p>okapi</p></details>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('okapi');
    await stopInput(page);

    await page.keyboard.press('Enter');
    const whileStopped = [
      await readCount(page),
      await page.locator(`${EDITOR_ROOT} details`).getAttribute('open'),
      await readScrollY(page),
    ];
    await resumeInput(page);
    await page.keyboard.press('Enter');

    expect([whileStopped, await readCount(page), await page.locator(`${EDITOR_ROOT} details`).getAttribute('open')])
      .toEqual([['2 of 3', null, 0], '3 of 3', '']);
  });
});

test.describe('closing', () => {
  test('Esc in the search field removes the panel and highlight, focuses the editor root with the current match selected, and further typing replaces it', async ({ page }) => {
    await openSearchEditor(page, '<p>a cat b</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('cat');

    await page.keyboard.press('Escape');

    await expect(page.locator(PANEL)).toBeHidden();
    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
    const closed = [
      await readHighlight(page, SEARCH_HIGHLIGHT_NAME.match),
      await readHighlight(page, SEARCH_HIGHLIGHT_NAME.current),
      await page.evaluate(() => window.getSelection()?.toString()),
    ];
    await page.keyboard.type('dog');
    expect([closed, await readBodyHtml(page)]).toEqual([[null, null, 'cat'], '<p>a dog b</p>']);
  });

  test('Esc with a query that has no matches returns to the caret position before Ctrl+F', async ({ page }) => {
    await openSearchEditor(page, '<p>abc</p><p>def</p>');
    await placeCaret(page, `${EDITOR_ROOT} p:nth-of-type(2)`, 1);
    await openSearch(page);
    await page.keyboard.type('zzz');

    await page.keyboard.press('Escape');

    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
    expect(await readCaretPrefix(page)).toBe('abcd');
  });

  test('pressing the close button with a pointer while the editor root has focus removes the panel and highlight, leaves the caret and scroll position unchanged, and opens no collapsible section', async ({ page }) => {
    await openSearchEditor(page, `<p>abc</p>${FILLER}<details><summary>t</summary><p>okapi</p></details>`);
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    // Typing during an input stop leaves the current match in the body of the closed collapsible section.
    await stopInput(page);
    await page.keyboard.type('okapi');
    await resumeInput(page);
    await placeCaret(page, `${EDITOR_ROOT} p`, 2);
    const before = [await readCaretPrefix(page), await readScrollY(page)];

    await page.locator(CLOSE).click();

    await expect(page.locator(PANEL)).toBeHidden();
    expect([
      await readHighlight(page, SEARCH_HIGHLIGHT_NAME.match),
      [await readCaretPrefix(page), await readScrollY(page)],
      await page.locator(`${EDITOR_ROOT} details`).getAttribute('open'),
    ]).toEqual([null, before, null]);
  });

  test('Esc in the search field while the block type menu is open from a pointer closes only the popup, keeps the panel and focus, and does not reach the forwarded key record', async ({ page }) => {
    await openSearchEditor(page, '<p>cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.blockType}"] > button`).click();
    await expect(page.locator(`.${BLOCK_TYPE_MENU_CLASS}`)).toBeVisible();
    await installForwardRecord(page);

    await page.keyboard.press('Escape');

    await expect(page.locator(`.${BLOCK_TYPE_MENU_CLASS}`)).toHaveCount(0);
    await expect(page.locator(PANEL)).toBeVisible();
    await expect(page.locator(FIELD)).toBeFocused();
    expect((await readForwardedKeys(page)).includes('Escape')).toBe(false);
  });

  test('Esc during the save round trip closes the panel, and after the round trip focus returns to the editor root with the current match selected', async ({ page }) => {
    await openSearchEditor(page, '<p>a cat b</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('cat');
    await stopInput(page);

    await page.keyboard.press('Escape');
    const whileStopped = await page.locator(PANEL).isVisible();
    await resumeInput(page);

    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
    expect([whileStopped, await page.evaluate(() => window.getSelection()?.toString())]).toEqual([false, 'cat']);
  });

  test('Esc during the save round trip while the current match is in a closed collapsible section returns to the position before Ctrl+F after the round trip', async ({ page }) => {
    await openSearchEditor(page, '<p>abc</p><details><summary>t</summary><p>okapi</p></details>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 2);
    await openSearch(page);
    await stopInput(page);
    await page.keyboard.type('okapi');

    await page.keyboard.press('Escape');
    await resumeInput(page);

    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
    expect([await readCaretPrefix(page), await page.locator(`${EDITOR_ROOT} details`).getAttribute('open')])
      .toEqual(['ab', null]);
  });

  test('reopening with Ctrl+F after closing keeps the previous query and toggle states and highlights the same matches', async ({ page }) => {
    await openSearchEditor(page, '<p>Cat cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.locator(MATCH_CASE).click();
    await page.keyboard.type('cat');
    await page.keyboard.press('Escape');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);

    await openSearch(page);

    expect([
      await page.locator(FIELD).inputValue(),
      await page.locator(MATCH_CASE).getAttribute('aria-pressed'),
      await readHighlight(page, SEARCH_HIGHLIGHT_NAME.match),
    ]).toEqual(['cat', 'true', [['Cat cat', 4, 'Cat cat', 7]]]);
  });
});

test.describe('following tree changes', () => {
  test('typing another cat in the editor root while open increases the total and keeps the current number', async ({ page }) => {
    await openSearchEditor(page, '<p>cat cat</p><p>end</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('cat');
    await page.keyboard.press('Enter');
    await placeCaret(page, `${EDITOR_ROOT} p:nth-of-type(2)`, 3);

    await page.keyboard.type(' cat');

    expect(await readCount(page)).toBe('2 of 3');
  });

  test('deleting matches while open so the total falls below the current number makes the last one current, and deleting all shows No results', async ({ page }) => {
    await openSearchEditor(page, '<p>cat</p><p>cat</p><p>cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('cat');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    await selectText(page, `${EDITOR_ROOT} p:nth-of-type(3)`, 0, 3);
    await page.keyboard.press('Backspace');
    const afterOne = await readCount(page);
    await selectText(page, `${EDITOR_ROOT} p`, 0, 3, `${EDITOR_ROOT} p:nth-of-type(2)`);
    await page.keyboard.press('Backspace');

    expect([afterOne, await readCount(page)]).toEqual(['2 of 2', 'No results']);
  });

  test('an external change replacing the document while open recomputes in the new tree keeping the current number, opens no collapsible section, and keeps the scroll position', async ({ page }) => {
    await openSearchEditor(page, '<p>cat</p><p>cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('cat');
    await page.keyboard.press('Enter');
    const scrolled = await readScrollY(page);

    await replaceDocument(page, `<p>cat</p><p>cat</p>${FILLER}<details><summary>t</summary><p>cat</p></details>`);

    expect([
      await readCount(page),
      await page.locator(`${EDITOR_ROOT} details`).getAttribute('open'),
      await readScrollY(page),
    ]).toEqual(['2 of 3', null, scrolled]);
  });

  test('after undo in the search field delivers a history replacement, Esc with a query that has no matches returns to the remapped position before Ctrl+F', async ({ page }) => {
    await openSearchEditor(page, '\n<p>abc</p>\n<p>def</p>\n');
    await placeCaret(page, `${EDITOR_ROOT} p:nth-of-type(2)`, 1);
    await openSearch(page);
    await page.keyboard.type('zzz');
    await page.keyboard.press('ControlOrMeta+KeyZ');
    const text = `${PROLOGUE}\n<p>new</p>\n<p>abc</p>\n<p>def</p>\n${EPILOGUE}`;
    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument,
      requestId: 'history-1',
      kind: DOCUMENT_APPLY_KIND.editHistory,
      text,
      targetText: text,
      targetSelection: null,
      editRange: { start: 1, count: 1 },
    });
    await expect.poll(async () => (await getOutboundMessages(page)).some(
      (message) => Reflect.get(Object(message), 'type') === VIEW_TO_HOST_MESSAGE_TYPE.documentReplaced,
    )).toBe(true);
    // The input stop raised during the apply is lowered by the release the host sends after finishing the apply.
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.saveReleased, resendUnsavedContent: false });
    await expect(page.locator(FIELD)).toBeFocused();

    await page.keyboard.press('Escape');

    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
    expect(await readSelectionEnds(page)).toEqual(['def', 1, 'def', 1]);
  });

  test('edits while closed register no highlight', async ({ page }) => {
    await openSearchEditor(page, '<p>ab</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('ab');
    await page.keyboard.press('Escape');
    await placeCaret(page, `${EDITOR_ROOT} p`, 2);

    await page.keyboard.type('ab');

    expect([
      await readHighlight(page, SEARCH_HIGHLIGHT_NAME.match),
      await readHighlight(page, SEARCH_HIGHLIGHT_NAME.current),
      await readBodyHtml(page),
    ]).toEqual([null, null, '<p>abab</p>']);
  });
});

test.describe('comment id matches', () => {
  test('typing part of the id of a resolved comment highlights its annotated text as the only match and opens its popup, with focus kept in the search field', async ({ page }) => {
    await openSearchEditor(page, RESOLVED_THREAD);
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);

    await page.keyboard.type('i27twz');

    await expect(page.locator(FIELD)).toBeFocused();
    expect([
      await readCount(page),
      await readHighlight(page, SEARCH_HIGHLIGHT_NAME.current),
      await page.locator(POPUP).isVisible(),
      await page.locator(POPUP_ENTRY).allTextContents(),
    ]).toEqual(['1 of 1', [['this phrase', 0, 'this phrase', 11]], true, ['the note']]);
  });

  test('with a text match, an id match, and a text match in that order, Enter to the id match opens the popup and Enter to the next text match closes it', async ({ page }) => {
    await openSearchEditor(
      page,
      '<p>zz alpha</p><p><comment id="c-zz000000">middle<comment-body>note</comment-body></comment></p><p>omega zz</p>',
    );
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('zz');

    const states = [[await readCount(page), await page.locator(POPUP).isVisible()]];
    for (const key of ['Enter', 'Enter']) {
      await page.keyboard.press(key);
      states.push([await readCount(page), await page.locator(POPUP).isVisible()]);
    }

    expect(states).toEqual([['1 of 3', false], ['2 of 3', true], ['3 of 3', false]]);
  });

  test('a popup opened by clicking annotated text stays open while moving between text matches', async ({ page }) => {
    await openSearchEditor(page, '<p><comment id="c-note1234">note<comment-body>b</comment-body></comment> cat cat</p>');
    await page.locator(`${EDITOR_ROOT} comment`).click();
    await expect(page.locator(POPUP)).toBeVisible();
    await openSearch(page);

    await page.keyboard.type('cat');
    await page.keyboard.press('Enter');

    expect([await readCount(page), await page.locator(POPUP).isVisible()]).toEqual(['2 of 2', true]);
  });

  test('a popup opened by search stays open when the search field is pressed with a pointer', async ({ page }) => {
    await openSearchEditor(page, RESOLVED_THREAD);
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('i27twz');
    await expect(page.locator(POPUP)).toBeVisible();

    await page.locator(FIELD).click();

    expect(await page.locator(POPUP).isVisible()).toBe(true);
  });

  test('Esc with an id match current closes the panel and selects the annotated text while the popup stays, and another Esc closes the popup', async ({ page }) => {
    await openSearchEditor(page, RESOLVED_THREAD);
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('i27twz');
    await expect(page.locator(POPUP)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator(PANEL)).toBeHidden();
    await expect(page.locator(EDITOR_ROOT)).toBeFocused();
    const afterFirst = [await page.locator(POPUP).isVisible(), await page.evaluate(() => window.getSelection()?.toString())];
    await page.keyboard.press('Escape');

    expect([afterFirst, await page.locator(POPUP).isVisible()]).toEqual([[true, 'this phrase'], false]);
  });

  test('when the annotated text equals the query and the id contains it too, there is one match and the popup opens', async ({ page }) => {
    await openSearchEditor(page, '<p>x <comment id="c-target12">target<comment-body>b</comment-body></comment></p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);

    await page.keyboard.type('target');

    expect([await readCount(page), await page.locator(POPUP).isVisible()]).toEqual(['1 of 1', true]);
  });

  test('typing the id of a comment in the body of a closed collapsible section opens the section and then the popup', async ({ page }) => {
    await openSearchEditor(
      page,
      '<p>x</p><details><summary>t</summary><p><comment id="c-inside12">inside<comment-body>b</comment-body></comment></p></details>',
    );
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);

    await page.keyboard.type('c-inside');

    expect([
      await page.locator(`${EDITOR_ROOT} details`).getAttribute('open'),
      await page.locator(POPUP).isVisible(),
      await page.locator(POPUP_ENTRY).allTextContents(),
    ]).toEqual(['', true, ['b']]);
  });

  test('typing the id of a comment below the viewport scrolls it into the reveal band and opens its popup, and Enter to the next id match does the same for a comment whose annotated text is only an image', async ({ page }) => {
    await openSearchEditor(
      page,
      `<p>x</p>${FILLER}<p><comment id="c-far00001">far<comment-body>text note</comment-body></comment></p>${FILLER}`
      + '<p><comment id="c-far00002"><img src="sample.png" alt="s" width="16" height="16">'
      + '<comment-body>image note</comment-body></comment></p>',
    );
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);

    await page.keyboard.type('c-far');
    const atText = [
      await readCount(page),
      await isInRevealBand(page, `${EDITOR_ROOT} #c-far00001`),
      await page.locator(POPUP).isVisible(),
      await page.locator(POPUP_ENTRY).allTextContents(),
    ];
    await page.keyboard.press('Enter');
    const atImage = [
      await readCount(page),
      await isInRevealBand(page, `${EDITOR_ROOT} #c-far00002`),
      await page.locator(POPUP).isVisible(),
      await page.locator(POPUP_ENTRY).allTextContents(),
    ];

    expect([atText, atImage]).toEqual([['1 of 2', true, true, ['text note']], ['2 of 2', true, true, ['image note']]]);
  });

  test('after a document replacement, moving from an id match to a text match closes the popup that search opened', async ({ page }) => {
    const body = '<p>a <comment id="c-zz000000">middle<comment-body>note</comment-body></comment> zz</p>';
    await openSearchEditor(page, body);
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('zz');
    await expect(page.locator(POPUP)).toBeVisible();

    await replaceDocument(page, body);
    const afterReplacement = await page.locator(POPUP).isVisible();
    await page.keyboard.press('Enter');

    expect([afterReplacement, await readCount(page), await page.locator(POPUP).isVisible()]).toEqual([true, '2 of 2', false]);
  });

  test('the id of a comment inside an element with the hidden attribute does not match', async ({ page }) => {
    await openSearchEditor(
      page,
      '<p>x</p><div hidden><p><comment id="c-hidden12">y<comment-body>b</comment-body></comment></p></div>',
    );
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);

    await page.keyboard.type('c-hidden');

    expect([await readCount(page), await page.locator(POPUP).isVisible()]).toEqual(['No results', false]);
  });

  test('typing the id of a comment whose annotated text is only an image counts one match and opens its popup', async ({ page }) => {
    await openSearchEditor(
      page,
      '<p>a <comment id="c-image123"><img src="sample.png" alt="s" width="16" height="16">'
      + '<comment-body>b</comment-body></comment> b</p>',
    );
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);

    await page.keyboard.type('c-image');

    expect([await readCount(page), await page.locator(POPUP).isVisible()]).toEqual(['1 of 1', true]);
  });
});

test.describe('replacing', () => {
  test('the replace key with a word selected opens the panel with the replace row shown, the word as the query, and focus in the replace field, and does not reach the forwarded key record', async ({ page }) => {
    await openSearchEditor(page, '<p>cat dog cat</p>');
    await selectText(page, `${EDITOR_ROOT} p`, 0, 3);
    await installForwardRecord(page);

    await page.keyboard.press(REPLACE_KEY);

    await expect(page.locator(REPLACE_FIELD)).toBeFocused();
    expect([
      await page.locator(FIELD).inputValue(),
      await readCount(page),
      await page.locator(TOGGLE_REPLACE).getAttribute('aria-expanded'),
      (await readForwardedKeys(page)).some((code) => code === 'KeyH' || code === 'KeyF'),
    ]).toEqual(['cat', '1 of 2', 'true', false]);
  });

  test('Enter in the replace field replaces the current match as one edit, makes the next match current, and keeps focus in the replace field', async ({ page }) => {
    await openSearchEditor(page, '<p>cat and cat</p><p>cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await page.keyboard.press(REPLACE_KEY);
    await page.keyboard.type('cat');
    await page.locator(REPLACE_FIELD).focus();
    await page.keyboard.type('dog');

    await page.keyboard.press('Enter');

    await expect(page.locator(REPLACE_FIELD)).toBeFocused();
    const transactions = await readTransactions(page);
    const column = readBody(transactions[0].before.text).indexOf('cat');
    const replaced = { start: { line: 0, column }, end: { line: 0, column: column + 3 } };
    expect([
      await readBodyHtml(page),
      await readCount(page),
      await readHighlight(page, SEARCH_HIGHLIGHT_NAME.current),
      transactions.length,
      [transactions[0].before.selection, transactions[0].after.selection],
    ]).toEqual([
      '<p>dog and cat</p><p>cat</p>',
      '1 of 2',
      [['dog and cat', 8, 'dog and cat', 11]],
      1,
      [replaced, replaced],
    ]);
  });

  test('Replace All replaces every match, including one spanning bold and one in the body of a closed collapsible section, as one edit without opening the section', async ({ page }) => {
    await openSearchEditor(page, '<p>ca<b>t</b> cat</p><details><summary>t</summary><p>cat</p></details>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await openSearch(page);
    await page.keyboard.type('cat');
    await page.locator(TOGGLE_REPLACE).click();
    await page.locator(REPLACE_FIELD).fill('dog');

    await page.locator(REPLACE_ALL).click();

    await expect(page.locator(REPLACE_FIELD)).toBeFocused();
    expect([
      await readBodyHtml(page),
      await readCount(page),
      (await readTransactions(page)).length,
    ]).toEqual(['<p>dog dog</p><details><summary>t</summary><p>dog</p></details>', 'No results', 1]);
  });

  test('a match crossing the edge of annotated text and a comment id match are left by Replace All and still counted, and Replace on such a match moves to the next one', async ({ page }) => {
    await openSearchEditor(
      page,
      '<p>a<comment id="c-ab000001">b<comment-body>n</comment-body></comment> ab</p><p>c-ab</p>',
    );
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await page.keyboard.press(REPLACE_KEY);
    await page.keyboard.type('ab');
    await page.locator(REPLACE_FIELD).fill('z');

    await page.locator(REPLACE_FIELD).press('Enter');
    const afterReplace = [await readCount(page), (await readTransactions(page)).length];
    await page.locator(REPLACE_ALL).click();

    expect([
      afterReplace,
      await page.locator(`${EDITOR_ROOT} p`).allTextContents(),
      await readCount(page),
    ]).toEqual([['2 of 4', 0], ['abn z', 'c-z'], '2 of 2']);
  });

  test('annotated text equal to the query is replaced even when the comment id also contains the query, and the comment stays', async ({ page }) => {
    await openSearchEditor(
      page,
      '<p><comment id="c-ab000002">ab<comment-body>n</comment-body></comment> ab</p>',
    );
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await page.keyboard.press(REPLACE_KEY);
    await page.keyboard.type('ab');
    await page.locator(REPLACE_FIELD).fill('z');

    await page.locator(REPLACE_FIELD).press('Enter');
    const afterReplace = [await page.locator(`${EDITOR_ROOT} p`).textContent(), await readCount(page)];
    await page.locator(REPLACE_ALL).click();

    expect([
      afterReplace,
      await page.locator(`${EDITOR_ROOT} p`).textContent(),
      await page.locator(`${EDITOR_ROOT} comment#c-ab000002`).count(),
    ]).toEqual([['zn ab', '2 of 2'], 'zn z', 1]);
  });

  test('a replacement that contains the query is passed over, so pressing Enter replaces each match once', async ({ page }) => {
    await openSearchEditor(page, '<p>a a</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await page.keyboard.press(REPLACE_KEY);
    await page.keyboard.type('a');
    await page.locator(REPLACE_FIELD).fill('aa');

    await page.locator(REPLACE_FIELD).press('Enter');
    await page.locator(REPLACE_FIELD).press('Enter');

    expect([await readBodyHtml(page), await readCount(page)]).toEqual(['<p>aa aa</p>', '1 of 4']);
  });

  test('an empty replacement removes the text, leaving an emptied paragraph as an empty line', async ({ page }) => {
    await openSearchEditor(page, '<p>cat</p><p>a cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await page.keyboard.press(REPLACE_KEY);
    await page.keyboard.type('cat');

    await page.locator(REPLACE_ALL).click();

    expect(await readBodyHtml(page)).toBe('<p><br></p><p>a </p>');
  });

  test('during the save round trip, Replace and Replace All change nothing and send no edit', async ({ page }) => {
    await openSearchEditor(page, '<p>cat cat</p>');
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await page.keyboard.press(REPLACE_KEY);
    await page.keyboard.type('cat');
    await page.locator(REPLACE_FIELD).fill('dog');
    await stopInput(page);

    await page.locator(REPLACE_FIELD).press('Enter');
    await page.locator(REPLACE_ALL).focus();
    await page.keyboard.press('Enter');

    expect([await readBodyHtml(page), (await readTransactions(page)).length]).toEqual(['<p>cat cat</p>', 0]);
  });
});
