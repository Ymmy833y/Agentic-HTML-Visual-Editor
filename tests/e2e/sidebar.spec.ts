import { devices, expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import {
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  MESSAGE_CATALOG_ELEMENT_ID,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { COMMENT_POPUP_ELEMENT_ID } from '../../webview/ui/comment-popup';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import { OVERLAY_ELEMENT_ID } from '../../webview/ui/overlay-presenter';
import { RESOLVED_ICON_PATH, SIDEBAR_ELEMENT_ID } from '../../webview/ui/sidebar';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { EDITOR_ROOT, readBodyHtml } from './helpers/editing';
import { PROBE_BUNDLE_PATH, getOutboundMessages, openWebviewHost, sendToWebview } from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;
const SIDEBAR = `#${SIDEBAR_ELEMENT_ID}`;
const SIDEBAR_BUTTON = `${TOOLBAR} [data-slot="${TOOLBAR_SLOT.sidebar}"] > button`;
const BOLD_BUTTON = `${TOOLBAR} [data-slot="${TOOLBAR_SLOT.bold}"] > button`;
const TABS = `${SIDEBAR} [role="tab"]`;
const ITEMS = `${SIDEBAR} [role="tabpanel"] button`;
const POPUP = `#${COMMENT_POPUP_ELEMENT_ID}`;
const RESOLVED_TOGGLE = `${POPUP} button[aria-label="${englishMessages['commentThread.resolved']}"]`;

/** Paragraphs that make the document taller than the view. They contain no heading and no comment. */
const FILLER = '<p>lorem</p>'.repeat(60);

// The view decides the primary modifier from the user agent, but the Desktop Chrome descriptor gives a Windows user
// agent regardless of the OS. The browser's default formatting keys follow the OS it runs on, so the user agent is
// aligned with that OS too.
const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
test.use({ userAgent: process.platform === 'darwin' ? MAC_USER_AGENT : devices['Desktop Chrome'].userAgent });

/**
 * Theme variables for light, dark, and high contrast, and the colors expected for the foreground and the accent (the
 * variable values converted to rgb).
 */
const THEMES = [
  {
    variables: {
      '--vscode-editor-background': '#ffffff',
      '--vscode-editor-foreground': '#3b3b3b',
      '--vscode-descriptionForeground': '#717171',
      '--vscode-panel-border': '#e5e5e5',
      '--vscode-textLink-foreground': '#005fb8',
    },
    foreground: 'rgb(59, 59, 59)',
    accent: 'rgb(0, 95, 184)',
  },
  {
    variables: {
      '--vscode-editor-background': '#1f1f1f',
      '--vscode-editor-foreground': '#cccccc',
      '--vscode-descriptionForeground': '#9d9d9d',
      '--vscode-panel-border': '#2b2b2b',
      '--vscode-textLink-foreground': '#4daafc',
    },
    foreground: 'rgb(204, 204, 204)',
    accent: 'rgb(77, 170, 252)',
  },
  {
    variables: {
      '--vscode-editor-background': '#000000',
      '--vscode-editor-foreground': '#ffffff',
      '--vscode-descriptionForeground': '#ffffff',
      '--vscode-panel-border': '#6fc3df',
      '--vscode-textLink-foreground': '#21a6ff',
    },
    foreground: 'rgb(255, 255, 255)',
    accent: 'rgb(33, 166, 255)',
  },
];

declare global {
  interface Window {
    /**
     * The record of forwarding to VS Code. Holds the code of each keydown that reached window in the bubbling phase,
     * in arrival order.
     */
    __forwardedKeys?: string[];
  }
}

/**
 * Embeds the English message catalog and then mounts the body. If messages stayed as keys, the names users see could
 * not be checked.
 *
 * @param page The page to operate on.
 * @param body The body to mount.
 */
async function openSidebarEditor(page: Page, body: string): Promise<void> {
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
 * Presses the sidebar button with a pointer and waits for the sidebar to open.
 *
 * @param page The page to operate on.
 */
async function openSidebar(page: Page): Promise<void> {
  await page.locator(SIDEBAR_BUTTON).click();
  await expect(page.locator(SIDEBAR)).toBeVisible();
}

/**
 * Returns the tab with the given name.
 *
 * @param page The page to operate on.
 * @param name The name of the tab.
 */
function sidebarTab(page: Page, name: string): Locator {
  return page.locator(TABS, { hasText: name });
}

/**
 * Moves focus to the editor root and selects a range in the text of an element's first child.
 *
 * @param page The page to operate on.
 * @param selector The selector of the element.
 * @param start The start offset.
 * @param end The end offset.
 */
async function selectText(page: Page, selector: string, start: number, end: number): Promise<void> {
  await page.evaluate((argument) => {
    const node = document.querySelector(argument.selector)?.firstChild;
    if (node === null || node === undefined) {
      throw new Error(`Text not found: ${argument.selector}`);
    }
    document.getElementById(argument.rootId)?.focus();
    const range = document.createRange();
    range.setStart(node, argument.start);
    range.setEnd(node, argument.end);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { selector, start, end, rootId: EDITOR_ROOT_ELEMENT_ID });
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
 * Describes where focus is: `editor` for the editor root, `toolbar:slot` for a toolbar item, `sidebar:text` for a tab
 * or an item of the sidebar, and the tag name otherwise.
 *
 * @param page The page to operate on.
 * @returns The description.
 */
async function readFocus(page: Page): Promise<string> {
  return page.evaluate((ids) => {
    const active = document.activeElement;
    if (active === null) {
      return 'none';
    }
    if (active.id === ids.root) {
      return 'editor';
    }
    if (active.closest(`#${ids.toolbar}`) !== null) {
      return `toolbar:${active.closest('[data-slot]')?.getAttribute('data-slot') ?? ''}`;
    }
    if (active.closest(`#${ids.sidebar}`) !== null) {
      return `sidebar:${active.textContent ?? ''}`;
    }
    return active.localName;
  }, { root: EDITOR_ROOT_ELEMENT_ID, toolbar: TOOLBAR_ELEMENT_ID, sidebar: SIDEBAR_ELEMENT_ID });
}

/**
 * Describes the shown list as the texts of its items, indented by two spaces for each list the item is nested in.
 *
 * @param page The page to operate on.
 * @returns One line per item.
 */
async function readNesting(page: Page): Promise<string[]> {
  return page.locator(ITEMS).evaluateAll((buttons, sidebarId) => buttons.map((button) => {
    let depth = -1;
    for (let current = button.parentElement; current !== null && current.id !== sidebarId; current = current.parentElement) {
      if (current.localName === 'ul') {
        depth += 1;
      }
    }
    return `${'  '.repeat(depth)}${button.textContent ?? ''}`;
  }), SIDEBAR_ELEMENT_ID);
}

/**
 * Reads whether each item of the shown list carries the check mark of a resolved thread.
 *
 * @param page The page to operate on.
 * @returns One value per item, in order.
 */
async function readResolvedMarks(page: Page): Promise<boolean[]> {
  return page.locator(ITEMS).evaluateAll((buttons, path) => buttons.map(
    (button) => button.querySelector('svg path')?.getAttribute('d') === path,
  ), RESOLVED_ICON_PATH);
}

/**
 * Reads how far the top of an element is below the bottom of the toolbar.
 *
 * @param page The page to operate on.
 * @param selector The selector of the element.
 * @returns The distance in pixels. Negative when the element starts above the bottom of the toolbar.
 */
async function readOffsetBelowToolbar(page: Page, selector: string): Promise<number> {
  return page.evaluate((selectors) => {
    const bottom = document.querySelector(selectors.toolbar)?.getBoundingClientRect().bottom ?? Number.NaN;
    const top = document.querySelector(selectors.target)?.getBoundingClientRect().top ?? Number.NaN;
    return top - bottom;
  }, { toolbar: TOOLBAR, target: selector });
}

/**
 * Reads the left edges of the toolbar and the editor root.
 *
 * @param page The page to operate on.
 * @returns The left edge of the toolbar and that of the editor root.
 */
async function readLeftEdges(page: Page): Promise<number[]> {
  return page.evaluate((selectors) => [
    document.querySelector(selectors.toolbar)?.getBoundingClientRect().left ?? Number.NaN,
    document.querySelector(selectors.root)?.getBoundingClientRect().left ?? Number.NaN,
  ], { toolbar: TOOLBAR, root: EDITOR_ROOT });
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
 * Gives the page the theme variables of a theme, as VS Code would set them on the root element.
 *
 * @param page The page to operate on.
 * @param variables The theme variables.
 */
async function applyTheme(page: Page, variables: Record<string, string>): Promise<void> {
  await page.evaluate((entries) => {
    for (const [name, value] of Object.entries(entries)) {
      document.documentElement.style.setProperty(name, value);
    }
  }, variables);
}

/**
 * Reads how the tabs are drawn: the color of each tab, how far the lifted piece under the tabs is moved from the first
 * tab, how far the second tab is from the first, and the border of the piece.
 *
 * @param page The page to operate on.
 * @returns The colors, the two distances in pixels, and the style, width and color of the border.
 */
async function readTabLook(page: Page): Promise<{ colors: string[]; moved: number; distance: number; border: string[] }> {
  return page.evaluate((selectors) => {
    const tablist = document.querySelector(selectors.tablist);
    const tabs = [...document.querySelectorAll(selectors.tabs)];
    if (tablist === null || tabs.length !== 2) {
      throw new Error('the tabs are missing');
    }
    const piece = getComputedStyle(tablist, '::before');
    return {
      colors: tabs.map((tab) => getComputedStyle(tab).color),
      moved: new DOMMatrixReadOnly(piece.transform === 'none' ? undefined : piece.transform).m41,
      distance: tabs[1].getBoundingClientRect().left - tabs[0].getBoundingClientRect().left,
      border: [piece.borderTopStyle, piece.borderTopWidth, piece.borderTopColor],
    };
  }, { tablist: `${SIDEBAR} [role="tablist"]`, tabs: TABS });
}

/**
 * Waits for two frames, so that work folded into the next frame has run.
 *
 * @param page The page to operate on.
 */
async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
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
 * Reads the types of the messages that report an edit to the host.
 *
 * @param page The page to operate on.
 * @returns The types in the order they were sent.
 */
async function readEditMessageTypes(page: Page): Promise<unknown[]> {
  const sentTypes = (await getOutboundMessages(page)).map((message) => Reflect.get(Object(message), 'type'));
  return sentTypes.filter((type) => [
    VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent,
    VIEW_TO_HOST_MESSAGE_TYPE.editTransaction,
    VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart,
    VIEW_TO_HOST_MESSAGE_TYPE.viewEdited,
  ].some((edited) => edited === type));
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

test.describe('opening and closing the sidebar', () => {
  test('after mounting, a Sidebar button that is not pressed sits at the start of the fixed toolbar, left of save, and the sidebar is not shown', async ({ page }) => {
    await openSidebarEditor(page, '<h1>A</h1>');

    const slots = await page.evaluate((toolbar) => [...document.querySelectorAll(`${toolbar} [data-slot]`)]
      .map((container) => container.getAttribute('data-slot')), TOOLBAR);
    expect([
      slots.slice(0, 2),
      await page.locator(SIDEBAR_BUTTON).getAttribute('aria-label'),
      await page.locator(SIDEBAR_BUTTON).getAttribute('aria-pressed'),
      await page.locator(SIDEBAR).isVisible(),
    ]).toEqual([[TOOLBAR_SLOT.sidebar, TOOLBAR_SLOT.save], 'Sidebar', 'false', false]);
  });

  test('pressing the button shows the sidebar at the left edge over the full height, presses the button, and moves the toolbar and the editor root to the right of the sidebar', async ({ page }) => {
    await openSidebarEditor(page, '<h1>A</h1>');

    await openSidebar(page);

    const sidebar = await page.evaluate((selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return { left: rect?.left, top: rect?.top, height: rect?.height, right: rect?.right ?? Number.NaN, view: window.innerHeight };
    }, SIDEBAR);
    const [toolbarLeft, rootLeft] = await readLeftEdges(page);
    expect([
      [sidebar.left, sidebar.top, sidebar.height],
      await page.locator(SIDEBAR_BUTTON).getAttribute('aria-pressed'),
      toolbarLeft >= sidebar.right,
      rootLeft >= sidebar.right,
    ]).toEqual([[0, 0, sidebar.view], 'true', true, true]);
  });

  test('pressing it again hides the sidebar, releases the button, and puts the toolbar and the editor root back where they were', async ({ page }) => {
    await openSidebarEditor(page, '<h1>A</h1>');
    const before = await readLeftEdges(page);
    await openSidebar(page);

    await page.locator(SIDEBAR_BUTTON).click();

    expect([
      await page.locator(SIDEBAR).isVisible(),
      await page.locator(SIDEBAR_BUTTON).getAttribute('aria-pressed'),
      await readLeftEdges(page),
    ]).toEqual([false, 'false', before]);
  });

  test('opening and closing leave the body output unchanged and send no edit transaction', async ({ page }) => {
    await openSidebarEditor(page, '<h1>A</h1><p>b<comment id="c-a">c<comment-body>n</comment-body></comment></p>');
    const output = await readBodyOutput(page);

    await openSidebar(page);
    await sidebarTab(page, 'Comments').click();
    await page.locator(SIDEBAR_BUTTON).click();

    expect([await readBodyOutput(page), await readEditMessageTypes(page)]).toEqual([output, []]);
  });

  test('pressing a tab with a pointer keeps focus and the selected range in the editor root', async ({ page }) => {
    await openSidebarEditor(page, '<p>abcd</p><h1>A</h1>');
    await openSidebar(page);
    await selectText(page, `${EDITOR_ROOT} p`, 1, 3);

    await sidebarTab(page, 'Comments').click();

    expect([
      await sidebarTab(page, 'Comments').getAttribute('aria-selected'),
      await readFocus(page),
      await page.evaluate(() => window.getSelection()?.toString() ?? ''),
    ]).toEqual(['true', 'editor', 'bc']);
  });

  test('in an unopenable document there is neither the button nor the sidebar', async ({ page }) => {
    await openWebviewHost(page, PROBE_BUNDLE_PATH);
    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
      text: `${PROLOGUE}<h1>a</h1><script>b</script>${EPILOGUE}`,
      documentUri: '',
      resourceRootUri: '',
    });
    await expect(page.locator(`#${OVERLAY_ELEMENT_ID}`)).toBeVisible();

    expect([await page.locator(SIDEBAR_BUTTON).count(), await page.locator(SIDEBAR).count()]).toEqual([0, 0]);
  });
});

test.describe('the heading outline', () => {
  test('opening chooses the headings tab and lists h1, h2 and h3 in document order, nested', async ({ page }) => {
    await openSidebarEditor(page, '<h1>A</h1><p>x</p><h2>B</h2><h3>C</h3><h2>D</h2>');

    await openSidebar(page);

    expect([
      await sidebarTab(page, 'Headings').getAttribute('aria-selected'),
      await readNesting(page),
    ]).toEqual(['true', ['A', '  B', '    C', '  D']]);
  });

  test('pressing a heading item places the caret at the start of that heading with focus in the editor root, and aligns the top of the heading with the bottom of the toolbar', async ({ page }) => {
    await openSidebarEditor(page, `<h1>Top</h1>${FILLER}<h2 id="far">Far</h2>${FILLER}`);
    await openSidebar(page);

    await page.locator(ITEMS, { hasText: 'Far' }).click();
    await settleFrames(page);

    expect([
      await readFocus(page),
      await readCaretPrefix(page),
      (await readScrollY(page)) > 0,
      Math.abs(await readOffsetBelowToolbar(page, `${EDITOR_ROOT} #far`)) < 1,
    ]).toEqual(['editor', `Top${'lorem'.repeat(60)}`, true, true]);
  });

  test('pressing a heading in the body of a closed collapsible section opens the section with one edit and moves to the heading', async ({ page }) => {
    await openSidebarEditor(page, '<p>x</p><details><summary>t</summary><h2>Folded</h2></details>');
    await openSidebar(page);

    await page.locator(ITEMS, { hasText: 'Folded' }).click();

    const types = await readEditMessageTypes(page);
    expect([
      await page.locator(`${EDITOR_ROOT} details`).getAttribute('open'),
      types.filter((type) => type === VIEW_TO_HOST_MESSAGE_TYPE.editTransaction).length,
      await readFocus(page),
      await readCaretPrefix(page),
    ]).toEqual(['', 1, 'editor', 'xt']);
  });

  test('turning a paragraph into a heading while open adds that heading to the list', async ({ page }) => {
    await openSidebarEditor(page, '<h1>A</h1><p>b</p>');
    await openSidebar(page);
    await placeCaret(page, `${EDITOR_ROOT} p`, 1);

    await page.keyboard.press('ControlOrMeta+Shift+Digit2');

    await expect(page.locator(ITEMS)).toHaveText(['A', 'b']);
    expect(await readNesting(page)).toEqual(['A', '  b']);
  });

  test('when a replacement changes the headings while open, the sidebar stays open and lists the new headings', async ({ page }) => {
    await openSidebarEditor(page, '<h1>A</h1>');
    await openSidebar(page);

    await replaceDocument(page, '<h1>New</h1><h2>Child</h2>');

    await expect(page.locator(SIDEBAR)).toBeVisible();
    expect(await readNesting(page)).toEqual(['New', '  Child']);
  });
});

test.describe('the comment outline', () => {
  test('pressing the comments tab lists every thread in document order by its annotated text, and marks the resolved one', async ({ page }) => {
    await openSidebarEditor(
      page,
      '<p>x<comment id="c-a">aa<comment-body>one</comment-body></comment> '
      + '<comment id="c-b" data-resolved="">bb<comment-body>two</comment-body></comment></p>'
      + '<h2><comment id="c-c">outer <comment id="c-d">inner</comment></comment></h2>',
    );
    await openSidebar(page);

    await sidebarTab(page, 'Comments').click();

    expect([
      await sidebarTab(page, 'Comments').getAttribute('aria-selected'),
      await page.locator(ITEMS).allTextContents(),
      await readResolvedMarks(page),
    ]).toEqual(['true', ['aa', 'bb', 'outer inner', 'inner'], [false, true, false, false]]);
  });

  test('pressing a comment item with a pointer opens the popup of that thread, keeps focus in the editor root with the caret at the start of the annotated text, and aligns the top of the annotated text with the bottom of the toolbar', async ({ page }) => {
    await openSidebarEditor(
      page,
      `<p>top</p>${FILLER}<p>x<comment id="c-a">far<comment-body>note</comment-body></comment>y</p>${FILLER}`,
    );
    await openSidebar(page);
    await sidebarTab(page, 'Comments').click();

    await page.locator(ITEMS, { hasText: 'far' }).click();
    await expect(page.locator(POPUP)).toBeVisible();
    await settleFrames(page);

    // Focus left in the editor root is what keeps the popup and its fields from showing a focus ring.
    expect([
      await readFocus(page),
      await readCaretPrefix(page),
      Math.abs(await readOffsetBelowToolbar(page, `${EDITOR_ROOT} #c-a`)) < 1,
    ]).toEqual(['editor', `top${'lorem'.repeat(60)}x`, true]);
  });

  test('Enter on a comment item opens the popup of that thread with focus inside, and Esc returns to the editor root with the caret at the start of the annotated text', async ({ page }) => {
    await openSidebarEditor(page, '<p>x<comment id="c-a">aa<comment-body>one</comment-body></comment>y</p>');
    await openSidebar(page);
    await sidebarTab(page, 'Comments').click();
    await page.locator(ITEMS).first().focus();

    await page.keyboard.press('Enter');
    await expect(page.locator(POPUP)).toBeVisible();
    const focusInPopup = await page.evaluate(
      (popupId) => document.getElementById(popupId)?.contains(document.activeElement),
      COMMENT_POPUP_ELEMENT_ID,
    );
    await page.keyboard.press('Escape');

    await expect(page.locator(POPUP)).toBeHidden();
    expect([focusInPopup, await readFocus(page), await readCaretPrefix(page)]).toEqual([true, 'editor', 'x']);
  });

  test('resolving the thread in the popup marks its item in the open list', async ({ page }) => {
    await openSidebarEditor(page, '<p>x<comment id="c-a">aa<comment-body>one</comment-body></comment>y</p>');
    await openSidebar(page);
    await sidebarTab(page, 'Comments').click();
    await page.locator(ITEMS).first().click();
    await expect(page.locator(POPUP)).toBeVisible();

    await page.locator(RESOLVED_TOGGLE).click();

    await expect(page.locator(`${ITEMS} svg path`)).toHaveAttribute('d', RESOLVED_ICON_PATH);
  });

  test('pressing a comment in the body of a closed collapsible section opens the section and the popup of that thread', async ({ page }) => {
    await openSidebarEditor(
      page,
      '<p>x</p><details><summary>t</summary><p>y<comment id="c-a">aa<comment-body>one</comment-body></comment></p></details>',
    );
    await openSidebar(page);
    await sidebarTab(page, 'Comments').click();

    await page.locator(ITEMS).first().click();

    await expect(page.locator(POPUP)).toBeVisible();
    expect(await page.locator(`${EDITOR_ROOT} details`).getAttribute('open')).toBe('');
  });
});

test.describe('operating the sidebar with the keyboard', () => {
  test('after the reach key, Shift+Tab moves to the list item and again to the chosen tab, and Tab twice goes back to the fixed toolbar', async ({ page }) => {
    await openSidebarEditor(page, '<h1>A</h1><p>abcd</p>');
    await openSidebar(page);
    await placeCaret(page, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');

    const visited = [await readFocus(page)];
    for (const key of ['Shift+Tab', 'Shift+Tab', 'Tab', 'Tab']) {
      await page.keyboard.press(key);
      visited.push(await readFocus(page));
    }

    // The reach key lands on the first item of the fixed toolbar, which is the sidebar button.
    expect(visited).toEqual([
      `toolbar:${TOOLBAR_SLOT.sidebar}`,
      'sidebar:A',
      'sidebar:Headings',
      'sidebar:A',
      `toolbar:${TOOLBAR_SLOT.sidebar}`,
    ]);
  });

  test('Right on a tab moves focus and the choice to the comments tab and switches the list', async ({ page }) => {
    await openSidebarEditor(page, '<h1>A</h1><p>x<comment id="c-a">aa<comment-body>one</comment-body></comment></p>');
    await openSidebar(page);
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');

    await page.keyboard.press('ArrowRight');

    expect([
      await readFocus(page),
      await sidebarTab(page, 'Comments').getAttribute('aria-selected'),
      await page.locator(ITEMS).allTextContents(),
    ]).toEqual(['sidebar:Comments', 'true', ['aa']]);
  });

  test('Down, Up, Home and End in the list move focus between the items, wrapping to the opposite end', async ({ page }) => {
    await openSidebarEditor(page, '<h1>A</h1><h2>B</h2><h2>C</h2><p>x</p>');
    await openSidebar(page);
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('Shift+Tab');

    const visited: string[] = [];
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowUp', 'ArrowDown', 'End', 'Home']) {
      await page.keyboard.press(key);
      visited.push(await readFocus(page));
    }

    expect(visited).toEqual(['sidebar:B', 'sidebar:A', 'sidebar:C', 'sidebar:A', 'sidebar:C', 'sidebar:A']);
  });

  test('Enter on an item moves to the start of that heading with focus in the editor root', async ({ page }) => {
    await openSidebarEditor(page, '<h1>A</h1><p>b</p><h2>C</h2>');
    await openSidebar(page);
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('ArrowDown');

    await page.keyboard.press('Enter');

    expect([await readFocus(page), await readCaretPrefix(page), await readBodyHtml(page)])
      .toEqual(['editor', 'Ab', '<h1>A</h1><p>b</p><h2>C</h2>']);
  });

  test('Esc in the sidebar gives focus back to the editor root at the captured selection and leaves the sidebar open', async ({ page }) => {
    await openSidebarEditor(page, '<p>abcd</p><h1>A</h1>');
    await openSidebar(page);
    await placeCaret(page, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('Shift+Tab');

    await page.keyboard.press('Escape');

    expect([await readFocus(page), await readCaretPrefix(page), await page.locator(SIDEBAR).isVisible()])
      .toEqual(['editor', 'ab', true]);
  });

  test('the primary modifier+B while the sidebar has focus neither makes bold nor reaches the forwarded key record', async ({ page }) => {
    await openSidebarEditor(page, '<p>abcd</p><h1>A</h1>');
    await openSidebar(page);
    await selectText(page, `${EDITOR_ROOT} p`, 1, 3);
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('Shift+Tab');
    await installForwardRecord(page);

    await page.keyboard.press('ControlOrMeta+KeyB');

    expect([(await readForwardedKeys(page)).includes('KeyB'), await readBodyHtml(page), await readFocus(page)])
      .toEqual([false, '<p>abcd</p><h1>A</h1>', 'sidebar:A']);
  });

  test('pressing the toolbar bold item with a pointer while the sidebar has focus returns to the editor root first and makes the captured selection bold', async ({ page }) => {
    await openSidebarEditor(page, '<p>abcd</p><h1>A</h1>');
    await openSidebar(page);
    await selectText(page, `${EDITOR_ROOT} p`, 1, 3);
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('Shift+Tab');
    // Whether the selection survives while focus is outside the editor root depends on the browser. Dropping it here
    // shows that what becomes bold is the selection captured when focus left the editor root.
    await page.evaluate(() => window.getSelection()?.removeAllRanges());

    await page.locator(BOLD_BUTTON).click();

    expect([await readBodyHtml(page), await readFocus(page)]).toEqual(['<p>a<strong>bc</strong>d</p><h1>A</h1>', 'editor']);
  });

  test('when a replacement arrives while the sidebar has focus, focus stays in the sidebar', async ({ page }) => {
    await openSidebarEditor(page, '<h1>A</h1><h2>B</h2><p>x</p>');
    await openSidebar(page);
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('ArrowDown');

    await replaceDocument(page, '<h1>X</h1><h2>Y</h2><p>z</p>');

    expect(await readFocus(page)).toBe('sidebar:Y');
  });

  test('Enter on an item while the overlay without content is up changes neither the caret nor the scroll position', async ({ page }) => {
    await openSidebarEditor(page, `<p>top</p>${FILLER}<h2>Far</h2>${FILLER}`);
    await openSidebar(page);
    await placeCaret(page, `${EDITOR_ROOT} p`, 1);
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('Shift+Tab');
    await stopInput(page);

    await page.keyboard.press('Enter');
    await settleFrames(page);

    expect([await readCaretPrefix(page), await readScrollY(page), await readFocus(page)]).toEqual(['t', 0, 'sidebar:Far']);
  });
});

test.describe('the look of the sidebar', () => {
  test('in light, dark, and high contrast alike, the chosen tab is drawn in the accent color and the outlined piece under the tabs moves to it', async ({ page }) => {
    await openSidebarEditor(page, '<h1>A</h1><p>x<comment id="c-a">aa<comment-body>one</comment-body></comment></p>');
    await openSidebar(page);

    const drawn: unknown[][] = [];
    for (const theme of THEMES) {
      await applyTheme(page, theme.variables);
      const readSettled = async (chosen: 0 | 1): Promise<unknown[]> => {
        // The colors and the piece move over a transition, so they are read once they stop.
        await expect.poll(async () => {
          const look = await readTabLook(page);
          return [look.colors[0] === theme.accent, look.colors[1] === theme.accent, Math.abs(look.moved - (chosen === 1 ? look.distance : 0)) < 0.5];
        }).toEqual(chosen === 0 ? [true, false, true] : [false, true, true]);
        return (await readTabLook(page)).border;
      };
      await sidebarTab(page, 'Headings').click();
      const onHeadings = await readSettled(0);
      await sidebarTab(page, 'Comments').click();
      const onComments = await readSettled(1);
      drawn.push([onHeadings[0], onHeadings[1], onHeadings[2] !== 'rgba(0, 0, 0, 0)', onComments[2] !== 'rgba(0, 0, 0, 0)']);
    }

    expect(drawn).toEqual(THEMES.map(() => ['solid', '1px', true, true]));
  });

  test('in a high contrast theme, the piece under the chosen tab is outlined in the accent color, and the check mark of a resolved thread is drawn in the foreground color inside a ring', async ({ page }) => {
    await openSidebarEditor(page, '<p><comment id="c-a" data-resolved="">aa<comment-body>one</comment-body></comment></p>');
    const theme = THEMES[2];
    await applyTheme(page, theme.variables);
    // VS Code puts this class on the body in a high contrast theme.
    await page.evaluate(() => document.body.classList.add('vscode-high-contrast'));
    await openSidebar(page);
    await sidebarTab(page, 'Comments').click();

    await expect.poll(async () => (await readTabLook(page)).colors[1]).toBe(theme.foreground);
    const look = await readTabLook(page);
    const mark = await page.locator(`${ITEMS} svg`).evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.stroke, style.boxShadow.includes('inset'), style.backgroundColor];
    });

    expect([look.border[2], mark]).toEqual([theme.accent, [theme.foreground, true, 'rgba(0, 0, 0, 0)']]);
  });

  test('in light and dark alike, the check mark of a resolved thread is drawn in the theme\'s green on a disc tinted with it, and an open thread gets a dot in the color of its author', async ({ page }) => {
    await openSidebarEditor(
      page,
      '<p><comment id="c-a">aa<comment-body data-author="human">one</comment-body></comment> '
      + '<comment id="c-b">bb<comment-body data-author="ai">two</comment-body></comment> '
      + '<comment id="c-c" data-resolved="">cc<comment-body data-author="ai">three</comment-body></comment></p>',
    );

    const drawn: unknown[][] = [];
    for (const theme of THEMES.slice(0, 2)) {
      await applyTheme(page, { ...theme.variables, '--vscode-charts-green': '#2ea043' });
      await openSidebar(page);
      await sidebarTab(page, 'Comments').click();
      const dots = await page.locator(ITEMS).evaluateAll((buttons) => buttons.map((button) => {
        const dot = getComputedStyle(button, '::before');
        return dot.content === '""' ? dot.backgroundColor : 'none';
      }));
      const mark = await page.locator(`${ITEMS} svg`).evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.stroke, style.backgroundColor !== 'rgba(0, 0, 0, 0)', style.borderRadius];
      });
      drawn.push([dots, mark]);
      await page.locator(SIDEBAR_BUTTON).click();
    }

    // The author colors are fixed values rather than theme variables, so they are the same in both themes.
    expect(drawn).toEqual(THEMES.slice(0, 2).map(() => [
      ['rgb(217, 119, 6)', 'rgb(30, 120, 190)', 'none'],
      ['rgb(46, 160, 67)', true, '50%'],
    ]));
  });

  test('the headings step down in weight and then in color as they nest', async ({ page }) => {
    await openSidebarEditor(page, '<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4>');
    await applyTheme(page, THEMES[0].variables);

    await openSidebar(page);

    // The foreground and the muted text color of the light theme.
    expect(await page.locator(ITEMS).evaluateAll((buttons) => buttons.map((button) => {
      const style = getComputedStyle(button);
      return [style.fontWeight, style.color];
    }))).toEqual([
      ['600', 'rgb(59, 59, 59)'],
      ['500', 'rgb(59, 59, 59)'],
      ['400', 'rgb(113, 113, 113)'],
      ['400', 'rgb(113, 113, 113)'],
    ]);
  });

  test('a tab and an item that receive focus from the keyboard show the focus ring', async ({ page }) => {
    await openSidebarEditor(page, '<h1>A</h1><p>x</p>');
    await openSidebar(page);
    await placeCaret(page, `${EDITOR_ROOT} p`, 0);
    await page.keyboard.press('Alt+F10');

    const outlines: string[][] = [];
    for (const key of ['Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      outlines.push(await page.evaluate(() => {
        const active = document.activeElement;
        const style = active === null ? undefined : getComputedStyle(active);
        return [active?.textContent ?? '', style?.outlineStyle ?? '', style?.outlineColor ?? ''];
      }));
    }

    expect(outlines).toEqual([['A', 'solid', 'rgb(0, 144, 241)'], ['Headings', 'solid', 'rgb(0, 144, 241)']]);
  });
});
