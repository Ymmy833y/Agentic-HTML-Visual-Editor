import { expect, test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';

import {
  DOCUMENT_APPLY_KIND,
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import type { EditTransaction } from '../../common/index';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import {
  EDITOR_ROOT,
  focusEditor,
  installReceiver,
  openEditor,
  paste,
  placeCaret,
  readBodyHtml,
  readRecord,
} from './helpers/editing';
import { getOutboundMessages, sendToWebview } from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;
const DETAILS = `${EDITOR_ROOT} details`;
const TITLE = `${DETAILS} > summary`;

/** A body with paragraphs placed before and after a collapsible section. */
const BODY = '\n<p>ab</p>\n<details open="">\n<summary>title</summary>\n<p>body</p>\n</details>\n<p>cd</p>\n';

/** A body with only a closed collapsible section. */
const CLOSED_BODY = '\n<details>\n<summary>title</summary>\n<p>body</p>\n</details>\n';

/** The open form of the above. */
const OPEN_BODY = '\n<details open="">\n<summary>title</summary>\n<p>body</p>\n</details>\n';

/** A toggle rewrites nothing but the `details` line that follows the prologue's two lines. */
const TOGGLE_EDIT_RANGE = { start: 3, count: 1 };

/** A collapsible section whose body holds two paragraphs, for checking whether a selection crosses a block boundary. */
const TWO_PARAGRAPH_BODY =
  '\n<details open="">\n<summary>title</summary>\n<p>alpha beta gamma</p>\n<p>delta</p>\n</details>\n<p>tail</p>\n';

/** The colors given by the light, dark, and high-contrast themes. */
const THEME_COLORS = [
  { background: 'rgb(255, 255, 255)', foreground: 'rgb(31, 35, 40)' },
  { background: 'rgb(31, 31, 31)', foreground: 'rgb(204, 204, 204)' },
  { background: 'rgb(0, 0, 0)', foreground: 'rgb(255, 255, 255)' },
];

declare global {
  interface Window {
    /** The answer, held by the key-press receiver, of whether the default was stopped for the target key. */
    __detailsPrevented?: Promise<boolean>;
  }
}

// Permissions are granted so paste can be verified through the real clipboard.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

/**
 * Presses a toolbar item.
 *
 * @param page The page to operate on.
 * @param slot The slot of the item to press.
 */
async function pressToolbarItem(page: Page, slot: string): Promise<void> {
  await page.locator(`${TOOLBAR} [data-slot="${slot}"] > button`).click();
}

/** Reads the current form built from the tree being edited. */
async function readCurrentForm(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__serializationProbe?.()?.current);
}

/**
 * Places the caret at a position inside an element.
 *
 * @param page The page to operate on.
 * @param selector The selector for finding the element.
 * @param offset The position inside the element.
 */
async function placeCaretInElement(page: Page, selector: string, offset: number): Promise<void> {
  await page.evaluate((argument) => {
    const element = document.querySelector(argument.selector);
    if (element === null) {
      throw new Error(`element not found: ${argument.selector}`);
    }
    const range = document.createRange();
    range.setStart(element, argument.offset);
    range.collapse(true);
    document.getElementById(argument.rootId)?.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { selector, offset, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Selects between the text of two elements, leaving focus on the editor root.
 *
 * @param page The page to operate on.
 * @param start The start's selector and position.
 * @param end The end's selector and position.
 */
async function selectBetween(
  page: Page,
  start: { selector: string; offset: number },
  end: { selector: string; offset: number },
): Promise<void> {
  await page.evaluate((argument) => {
    const from = document.querySelector(argument.start.selector)?.firstChild;
    const to = document.querySelector(argument.end.selector)?.firstChild;
    if (from === null || from === undefined || to === null || to === undefined) {
      throw new Error('text to select was not found');
    }
    const range = document.createRange();
    range.setStart(from, argument.start.offset);
    range.setEnd(to, argument.end.offset);
    document.getElementById(argument.rootId)?.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { start, end, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Selects from a position directly inside the collapsible section to text in the body.
 *
 * @param page The page to operate on.
 * @param offset The position directly beneath the collapsible section.
 * @param end The end's selector and position.
 */
async function selectFromSection(
  page: Page,
  offset: number,
  end: { selector: string; offset: number },
): Promise<void> {
  await page.evaluate((argument) => {
    const section = document.querySelector(argument.selector);
    const to = document.querySelector(argument.end.selector)?.firstChild;
    if (section === null || to === null || to === undefined) {
      throw new Error('position to select was not found');
    }
    const range = document.createRange();
    range.setStart(section, argument.offset);
    range.setEnd(to, argument.end.offset);
    document.getElementById(argument.rootId)?.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { selector: DETAILS, offset, end, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Returns coordinates inside the marker area.
 *
 * @param page The page to operate on.
 * @param selector The selector for finding the title.
 * @returns Coordinates inside the area.
 */
async function readMarkerPoint(page: Page, selector: string): Promise<{ x: number; y: number }> {
  return page.locator(selector).evaluate((element) => {
    const box = element.getBoundingClientRect();
    const width = Number.parseFloat(getComputedStyle(element).paddingInlineStart);
    return { x: box.left + width / 2, y: box.top + box.height / 4 };
  });
}

/**
 * Returns coordinates within the title's leading-edge inline padding, at both its left and right end.
 *
 * To see which end writing direction moves the leading edge to, both left and right are returned with
 * the same width.
 *
 * @param page The page to operate on.
 * @param selector The selector for finding the title.
 * @returns Coordinates at the left and right end.
 */
async function readTitleEdgePoints(
  page: Page,
  selector: string,
): Promise<{ left: { x: number; y: number }; right: { x: number; y: number } }> {
  return page.locator(selector).evaluate((element) => {
    const box = element.getBoundingClientRect();
    const width = Number.parseFloat(getComputedStyle(element).paddingInlineStart);
    const y = box.top + box.height / 4;
    return {
      left: { x: box.left + width / 2, y },
      right: { x: box.right - width / 2, y },
    };
  });
}

/**
 * Returns the center coordinates of one character of text.
 *
 * @param page The page to operate on.
 * @param selector The selector for finding the element that holds the text.
 * @param offset The position inside the text.
 * @returns The center coordinates of that character.
 */
async function readCharPoint(
  page: Page,
  selector: string,
  offset: number,
): Promise<{ x: number; y: number }> {
  return page.evaluate((argument) => {
    const text = document.querySelector(argument.selector)?.firstChild;
    if (text === null || text === undefined) {
      throw new Error(`text not found: ${argument.selector}`);
    }
    const range = document.createRange();
    range.setStart(text, argument.offset);
    range.setEnd(text, argument.offset + 1);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, { selector, offset });
}

/**
 * Returns coordinates outside the editor root, above it.
 *
 * @param page The page to operate on.
 * @returns Coordinates outside the editor root.
 */
async function readPointAboveEditor(page: Page): Promise<{ x: number; y: number }> {
  return page.locator(EDITOR_ROOT).evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top / 2 };
  });
}

/**
 * Sends a key press and reads whether the default was stopped by the time it reached the editor root.
 *
 * The receiver finishes attaching before the key press. Pressing without waiting for `evaluate` would
 * leave a run with no keydown received at all, for a press that finished before the receiver attached.
 *
 * @param page The page to operate on.
 * @param key The key to press. For one held with a modifier, pass it spelled as `Shift+ArrowUp`.
 * @returns `true` if the default was stopped.
 */
async function pressAndReadPrevented(page: Page, key: string): Promise<boolean> {
  // `press('Shift+ArrowUp')` sends the modifier key's keydown first. Only the last key pressed is read.
  const pressedKey = key.split('+').at(-1) ?? key;
  await page.evaluate(({ rootId, target }) => {
    const root = document.getElementById(rootId);
    window.__detailsPrevented = new Promise<boolean>((resolve) => {
      const receive = (event: KeyboardEvent): void => {
        if (event.key !== target) {
          return;
        }
        root?.removeEventListener('keydown', receive);
        resolve(event.defaultPrevented);
      };
      root?.addEventListener('keydown', receive);
    });
  }, { rootId: EDITOR_ROOT_ELEMENT_ID, target: pressedKey });

  await page.keyboard.press(key);

  const prevented = await page.evaluate(() => window.__detailsPrevented);
  if (prevented === undefined) {
    throw new Error('the key press receiver was not attached');
  }
  return prevented;
}

/**
 * Reads a pseudo-element's computed value.
 *
 * @param page The page to operate on.
 * @param selector The selector for finding the element.
 * @param pseudo The pseudo-element.
 * @param property The property to read.
 * @returns The computed value.
 */
async function readPseudoStyle(
  page: Page,
  selector: string,
  pseudo: string,
  property: string,
): Promise<string> {
  return page.locator(selector).evaluate(
    (element, argument) =>
      getComputedStyle(element, argument.pseudo).getPropertyValue(argument.property),
    { pseudo, property },
  );
}

/**
 * Applies theme colors. VS Code sets them on the root element, so this reproduces them in the same place.
 *
 * @param page The page to operate on.
 * @param colors The theme colors to apply.
 */
async function applyTheme(
  page: Page,
  colors: { background: string; foreground: string },
): Promise<void> {
  await page.evaluate((given) => {
    document.documentElement.style.setProperty('--vscode-editor-background', given.background);
    document.documentElement.style.setProperty('--vscode-editor-foreground', given.foreground);
  }, colors);
}

/**
 * Reads both ends of what the selection covers, as string/position pairs.
 *
 * @param page The page to operate on.
 * @returns The start and end string and position.
 */
async function readSelectionBounds(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const range = window.getSelection()?.getRangeAt(0);
    return {
      startText: range?.startContainer.textContent,
      startOffset: range?.startOffset,
      endText: range?.endContainer.textContent,
      endOffset: range?.endOffset,
      collapsed: range?.collapsed,
    };
  });
}

/**
 * Returns whether the caret is inside an element.
 *
 * @param page The page to operate on.
 * @param selector The selector for finding the element.
 * @returns `true` if inside.
 */
async function isCaretInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((target) => {
    const anchor = window.getSelection()?.anchorNode ?? null;
    const element = document.querySelector(target);
    return anchor !== null && element !== null && element.contains(anchor);
  }, selector);
}

/** Reads the edit units sent to the host, in the order they were sent. */
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
      // This is the value after narrowing by type and shape, and a message of this type carries
      // nothing but an edit unit.
      return [message.transaction as EditTransaction];
    }
    return [];
  });
}

/**
 * Applies a recorded edit unit's before state as an undo.
 *
 * @param page The page to operate on.
 * @param transaction The edit unit that reached the host.
 */
async function applyUndo(page: Page, transaction: EditTransaction): Promise<void> {
  await sendToWebview(page, {
    type: HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument,
    requestId: 'details-undo',
    kind: DOCUMENT_APPLY_KIND.editHistory,
    text: transaction.before.text,
    targetText: transaction.after.text,
    targetSelection: transaction.before.selection,
    editRange: TOGGLE_EDIT_RANGE,
  });
}

/** Opens the channel for driving the browser's IME. */
async function openImeSession(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

test.describe('registering the collapsible-section item', () => {
  test('lines up the collapsible-section item next to the horizontal rule in the toolbar', async ({ page }) => {
    await openEditor(page, BODY);

    const slots = await page.locator(`${TOOLBAR} [data-slot]`)
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-slot')));

    expect(slots.slice(slots.indexOf(TOOLBAR_SLOT.horizontalRule), slots.indexOf(TOOLBAR_SLOT.details) + 1))
      .toEqual([TOOLBAR_SLOT.horizontalRule, TOOLBAR_SLOT.details]);
  });

  test('lines up no item and raises no exception for an unopenable document', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await openEditor(page, '\n<script>a</script>\n');

    expect([await page.locator(TOOLBAR).count(), pageErrors]).toEqual([0, []]);
  });

  test('does not change the tree from pressing the item while an overlay is up', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    await page.evaluate((reason) => {
      window.__uiShellProbe?.()?.overlay.present(reason, { heading: '', descriptions: [], actions: [] });
    }, INPUT_STOP_REASON.saveRoundTrip);

    await page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.details}"] > button`)
      .dispatchEvent('click');

    expect(await readBodyHtml(page)).toBe(BODY);
  });
});

test.describe('inserting a collapsible section', () => {
  test('creates an open collapsible section with the caret in the title, from pressing the item with the caret in a paragraph', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await pressToolbarItem(page, TOOLBAR_SLOT.details);

    expect([await readBodyHtml(page), await isCaretInside(page, TITLE)]).toEqual([
      '\n<p>ab</p>\n<details open="">\n<summary><br></summary>\n<p><br></p>\n</details>\n<p><br></p>\n',
      true,
    ]);
  });

  test('shows only the typed character in the saved content, for typing the title right after inserting', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await pressToolbarItem(page, TOOLBAR_SLOT.details);
    await page.keyboard.type('X');

    expect(await readCurrentForm(page)).toBe(
      '\n<p>ab</p>\n<details open="">\n<summary>X</summary>\n<p><br></p>\n</details>\n<p><br></p>\n',
    );
  });

  test('creates an empty collapsible section from pressing the item on an empty document with nothing typed', async ({ page }) => {
    await openEditor(page, '');

    await pressToolbarItem(page, TOOLBAR_SLOT.details);

    // In an empty editor root, the materialized paragraph becomes the empty reference. The reference
    // stays in place, as the line after the collapsible section.
    expect(await readBodyHtml(page))
      .toBe('\n\n<details open="">\n<summary><br></summary>\n<p><br></p>\n</details>\n<p><br></p>');
  });

  test('has exactly one settled edit unit reach the host for one insert', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await pressToolbarItem(page, TOOLBAR_SLOT.details);

    await expect.poll(async () => (await readTransactions(page)).length).toBe(1);
  });
});

test.describe('toggling via the marker', () => {
  test('opens on clicking the marker area of a closed collapsible section, adding open to the saved content', async ({ page }) => {
    await openEditor(page, CLOSED_BODY);
    const point = await readMarkerPoint(page, TITLE);

    await page.mouse.click(point.x, point.y);

    expect(await readCurrentForm(page))
      .toBe('\n<details open="">\n<summary>title</summary>\n<p>body</p>\n</details>\n');
  });

  test('closes on clicking the marker area of an open collapsible section, removing open from the saved content', async ({ page }) => {
    await openEditor(page, '\n<details open="">\n<summary>title</summary>\n<p>body</p>\n</details>\n');
    const point = await readMarkerPoint(page, TITLE);

    await page.mouse.click(point.x, point.y);

    expect(await readCurrentForm(page)).toBe(CLOSED_BODY);
  });

  test('does not toggle from clicking a title character, and places the caret at that position', async ({ page }) => {
    await openEditor(page, CLOSED_BODY);

    await page.locator(TITLE).click();

    expect([await readBodyHtml(page), await isCaretInside(page, TITLE)])
      .toEqual([CLOSED_BODY, true]);
  });

  test('does not toggle from a click at the leading edge of the second line, for a multi-line title', async ({ page }) => {
    await openEditor(page, '\n<details>\n<summary>first<br>second</summary>\n<p>body</p>\n</details>\n');
    const point = await page.locator(TITLE).evaluate((element) => {
      const box = element.getBoundingClientRect();
      const width = Number.parseFloat(getComputedStyle(element).paddingInlineStart);
      // The leading edge of the second line. Takes a position below the first line's bottom edge.
      return { x: box.left + width / 2, y: box.bottom - box.height / 4 };
    });

    await page.mouse.click(point.x, point.y);

    expect(await page.locator(DETAILS).evaluate((element) => element.hasAttribute('open')))
      .toBe(false);
  });

  test('toggles only on a click at the right end, when writing direction is right-to-left', async ({ page }) => {
    await openEditor(page, '\n<details dir="rtl">\n<summary>title</summary>\n<p>body</p>\n</details>\n');
    const edges = await readTitleEdgePoints(page, TITLE);
    const readOpen = async (): Promise<boolean> =>
      page.locator(DETAILS).evaluate((element) => element.hasAttribute('open'));

    // The left end is the trailing edge: no marker and no hit area there.
    await page.mouse.click(edges.left.x, edges.left.y);
    const afterTrailingEdge = await readOpen();

    await page.mouse.click(edges.right.x, edges.right.y);

    expect([afterTrailingEdge, await readOpen()]).toEqual([false, true]);
  });

  test('moves neither the caret nor the focus from a press in the marker area', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 });
    const before = await readSelectionBounds(page);
    const point = await readMarkerPoint(page, TITLE);

    await page.mouse.move(point.x, point.y);
    await page.mouse.down();

    expect(await readSelectionBounds(page)).toEqual(before);
    await page.mouse.up();
  });

  test('toggles from clicking the default summary of a collapsible section with no title', async ({ page }) => {
    await openEditor(page, '\n<details>\n<p>body</p>\n</details>\n');
    const point = await page.locator(DETAILS).evaluate((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const top = box.top + Number.parseFloat(style.borderTopWidth)
        + Number.parseFloat(style.paddingTop);
      return { x: box.left + box.width / 2, y: top + 4 };
    });

    await page.mouse.click(point.x, point.y);

    expect(await readCurrentForm(page)).toBe('\n<details open="">\n<p>body</p>\n</details>\n');
  });

  test('makes one toggle one undo unit, restoring the original open/closed state on undo', async ({ page }) => {
    await openEditor(page, CLOSED_BODY);
    const point = await readMarkerPoint(page, TITLE);

    await page.mouse.click(point.x, point.y);

    await expect.poll(async () => (await readTransactions(page)).length).toBe(1);
    const [transaction] = await readTransactions(page);
    expect([transaction.before.text, transaction.after.text]).toEqual([
      `${PROLOGUE}${CLOSED_BODY}${EPILOGUE}`,
      `${PROLOGUE}${OPEN_BODY}${EPILOGUE}`,
    ]);

    await applyUndo(page, transaction);

    await expect.poll(async () => readBodyHtml(page)).toBe(CLOSED_BODY);
  });
});

test.describe('displaying the marker', () => {
  test('shows exactly one toggle marker on the title, with no browser-default marker', async ({ page }) => {
    await openEditor(page, BODY);

    const display = await page.locator(TITLE).evaluate((element) => getComputedStyle(element).display);
    const marker = await readPseudoStyle(page, TITLE, '::before', 'content');

    expect([display, marker]).toEqual(['block', '""']);
  });

  test('shows no pressable-looking cursor on a summary that is not a title', async ({ page }) => {
    await openEditor(page, '\n<details open="">\n<summary>title</summary>\n<summary>extra</summary>\n</details>\n');

    const cursor = await page.locator(`${DETAILS} > summary:last-of-type`)
      .evaluate((element) => getComputedStyle(element).cursor);

    expect(cursor).not.toBe('pointer');
  });

  test('changes the marker\'s direction with open/closed, and matches the background color in none of the three themes', async ({ page }) => {
    await openEditor(page, '\n<details>\n<summary>title</summary>\n<p>body</p>\n</details>\n');
    const closed = await readPseudoStyle(page, TITLE, '::before', 'mask-image');
    await page.locator(DETAILS).evaluate((element) => element.setAttribute('open', ''));
    const opened = await readPseudoStyle(page, TITLE, '::before', 'mask-image');

    const matched: string[] = [];
    for (const colors of THEME_COLORS) {
      await applyTheme(page, colors);
      const background = await page.locator('body')
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      const drawn = await readPseudoStyle(page, TITLE, '::before', 'background-color');
      if (drawn === background) {
        matched.push(drawn);
      }
    }

    expect([closed === opened, matched]).toEqual([false, []]);
  });

  test('has the marker appear in neither the tree nor the body output', async ({ page }) => {
    await openEditor(page, BODY);

    const text = await page.locator(TITLE).evaluate((element) => element.textContent);

    expect([await readBodyHtml(page), text, await readCurrentForm(page)])
      .toEqual([BODY, 'title', BODY]);
  });
});

test.describe('moving the selection out on close', () => {
  test('moves a selection endpoint that was in the body to the end of the title, on closing an open collapsible section', async ({ page }) => {
    // Give the body 2 paragraphs and put the selection in the second. A range selection gets the
    // floating menu, and selecting the first paragraph would place it over the title line, where it
    // would receive the press meant for the details marker.
    await openEditor(
      page,
      '\n<details open="">\n<summary>title</summary>\n<p>body</p>\n<p>more</p>\n</details>\n',
    );
    await selectBetween(
      page,
      { selector: `${DETAILS} > p:last-of-type`, offset: 1 },
      { selector: `${DETAILS} > p:last-of-type`, offset: 3 },
    );
    const point = await readMarkerPoint(page, TITLE);

    await page.mouse.click(point.x, point.y);

    expect([await isCaretInside(page, TITLE), await readSelectionBounds(page)])
      .toEqual([true, {
        startText: 'title',
        startOffset: 1,
        endText: 'title',
        endOffset: 1,
        collapsed: true,
      }]);
  });

  test('leaves the outside endpoint alone, staying a range selection, for a selection with one end outside the collapsible section', async ({ page }) => {
    await openEditor(page, BODY);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} p`, offset: 1 },
      { selector: `${DETAILS} > p`, offset: 3 },
    );
    const point = await readMarkerPoint(page, TITLE);

    await page.mouse.click(point.x, point.y);

    const bounds = await readSelectionBounds(page);
    expect(bounds).toEqual({
      startText: 'ab',
      startOffset: 1,
      endText: 'title',
      endOffset: 1,
      collapsed: false,
    });
  });

  test('clears a selection over the body, on closing a collapsible section with no title', async ({ page }) => {
    await openEditor(page, '\n<details open="">\n<p>body</p>\n</details>\n');
    await selectBetween(
      page,
      { selector: `${DETAILS} > p`, offset: 1 },
      { selector: `${DETAILS} > p`, offset: 3 },
    );
    const point = await page.locator(DETAILS).evaluate((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const top = box.top + Number.parseFloat(style.borderTopWidth)
        + Number.parseFloat(style.paddingTop);
      return { x: box.left + box.width / 2, y: top + 4 };
    });

    await page.mouse.click(point.x, point.y);

    expect(await page.evaluate(() => window.getSelection()?.rangeCount ?? 0)).toBe(0);
  });
});

test.describe('Enter inside the title', () => {
  test('moves the caret to the start of the body without splitting the title, on Enter in the title', async ({ page }) => {
    await openEditor(page, '\n<details open="">\n<summary>title</summary>\n<p>body</p>\n</details>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: TITLE, childIndex: 0, offset: 5 });

    await page.keyboard.press('Enter');

    expect([await readBodyHtml(page), await isCaretInside(page, `${DETAILS} > p`)]).toEqual([
      '\n<details open="">\n<summary>title</summary>\n<p>body</p>\n</details>\n',
      true,
    ]);
  });

  test('does not move the trailing characters into the body, even when the caret is partway through the title', async ({ page }) => {
    await openEditor(page, '\n<details open="">\n<summary>title</summary>\n<p>body</p>\n</details>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: TITLE, childIndex: 0, offset: 2 });

    await page.keyboard.press('Enter');
    await page.keyboard.type('X');

    expect(await readBodyHtml(page))
      .toBe('\n<details open="">\n<summary>title</summary>\n<p>Xbody</p>\n</details>\n');
  });

  test('opens and moves the caret into the body, on Enter in a closed collapsible section\'s title', async ({ page }) => {
    await openEditor(page, CLOSED_BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: TITLE, childIndex: 0, offset: 5 });

    await page.keyboard.press('Enter');

    expect([await readBodyHtml(page), await isCaretInside(page, `${DETAILS} > p`)]).toEqual([
      '\n<details open="">\n<summary>title</summary>\n<p>body</p>\n</details>\n',
      true,
    ]);
  });

  test('creates an empty paragraph right after the title, with the caret in it, when the body starts with a list', async ({ page }) => {
    await openEditor(page, '\n<details open="">\n<summary>title</summary>\n<ul><li>item</li></ul>\n</details>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: TITLE, childIndex: 0, offset: 5 });

    await page.keyboard.press('Enter');

    expect([await readBodyHtml(page), await isCaretInside(page, `${DETAILS} > p`)]).toEqual([
      '\n<details open="">\n<summary>title</summary>\n<p><br></p>\n<ul><li>item</li></ul>\n</details>\n',
      true,
    ]);
  });

  test('puts the next typed character inside code, when the body is a code block', async ({ page }) => {
    await openEditor(page, '\n<details open="">\n<summary>title</summary>\n<pre><code></code></pre>\n</details>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: TITLE, childIndex: 0, offset: 5 });

    await page.keyboard.press('Enter');
    await page.keyboard.type('X');

    expect(await readBodyHtml(page))
      .toBe('\n<details open="">\n<summary>title</summary>\n<pre><code>X</code></pre>\n</details>\n');
  });

  test('does not raise the dirty mark for an Enter that does not change the tree', async ({ page }) => {
    await openEditor(page, '\n<details open="">\n<summary>title</summary>\n<p>body</p>\n</details>\n');
    await installReceiver(page);
    await focusEditor(page);
    await placeCaret(page, { selector: TITLE, childIndex: 0, offset: 5 });

    await page.keyboard.press('Enter');

    expect((await readRecord(page)).kinds).toEqual([]);
  });

  test('inserts a line break inside the title, for Shift+Enter in the title', async ({ page }) => {
    await openEditor(page, '\n<details open="">\n<summary>title</summary>\n<p>body</p>\n</details>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: TITLE, childIndex: 0, offset: 5 });

    await page.keyboard.press('Shift+Enter');

    // A trailing line break alone shows no new line, so the browser adds one more to produce line height.
    expect([await readBodyHtml(page), await isCaretInside(page, TITLE)]).toEqual([
      '\n<details open="">\n<summary>title<br><br></summary>\n<p>body</p>\n</details>\n',
      true,
    ]);
  });

  test('stays an in-block line break for Enter in a summary that is not a title', async ({ page }) => {
    await openEditor(page, '\n<details open="">\n<summary>title</summary>\n<summary>extra</summary>\n</details>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${DETAILS} > summary:last-of-type`, childIndex: 0, offset: 5 });

    await page.keyboard.press('Enter');

    expect(await readBodyHtml(page)).toBe(
      '\n<details open="">\n<summary>title</summary>\n<summary>extra<br></summary>\n</details>\n',
    );
  });
});

test.describe('protecting the title in an edit with a range selection', () => {
  test('backspacing from before a details section to the middle of its body leaves the title empty, and the title and the body paragraph each on its own line', async ({ page }) => {
    await openEditor(page, BODY);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} p`, offset: 1 },
      { selector: `${DETAILS} > p`, offset: 2 },
    );

    await page.keyboard.press('Backspace');

    expect(await readBodyHtml(page))
      .toBe('\n<p>a</p>\n<details open="">\n<summary><br></summary>\n<p>dy</p>\n</details>\n<p>cd</p>\n');
  });

  test('deleting a range over all the text of the title leaves the title empty with a placeholder, and the next character goes into the title', async ({ page }) => {
    await openEditor(page, BODY);
    await selectBetween(page, { selector: TITLE, offset: 0 }, { selector: TITLE, offset: 5 });

    await page.keyboard.press('Delete');
    const emptied = await page.locator(TITLE).innerHTML();
    await page.keyboard.type('Z');

    expect([emptied, await page.locator(TITLE).innerHTML()]).toEqual(['<br>', 'Z']);
  });

  test('leaves the title empty for Enter over the same range', async ({ page }) => {
    await openEditor(page, BODY);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} p`, offset: 1 },
      { selector: `${DETAILS} > p`, offset: 2 },
    );

    await page.keyboard.press('Enter');

    expect(await page.locator(TITLE).innerHTML()).toBe('<br>');
  });

  test('leaves the title empty for pasting over the same range', async ({ page }) => {
    await openEditor(page, BODY);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} p`, offset: 1 },
      { selector: `${DETAILS} > p`, offset: 2 },
    );

    await paste(page, { 'text/plain': 'Z' });

    expect(await page.locator(TITLE).innerHTML()).toBe('<br>');
  });

  test('typing over the same crossing range puts the characters at the start, leaving the title and the body paragraph each on its own line', async ({ page }) => {
    await openEditor(page, BODY);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} p`, offset: 1 },
      { selector: `${DETAILS} > p`, offset: 2 },
    );

    await page.keyboard.type('Z');

    expect(await readBodyHtml(page))
      .toBe('\n<p>aZ</p>\n<details open="">\n<summary><br></summary>\n<p>dy</p>\n</details>\n<p>cd</p>\n');
  });

  test('inserts the character into the title, for typing into a range whose start is before the title', async ({ page }) => {
    await openEditor(page, BODY);
    await selectFromSection(page, 0, { selector: `${DETAILS} > p`, offset: 2 });

    await page.keyboard.type('Z');

    expect(await page.locator(TITLE).innerHTML()).toBe('Z');
  });

  test('does not delete the range, inserting the composed character at the start, when starting IME composition over a crossing range', async ({ page }) => {
    await openEditor(page, BODY);
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} p`, offset: 1 },
      { selector: `${DETAILS} > p`, offset: 2 },
    );
    const ime = await openImeSession(page);

    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    await ime.send('Input.insertText', { text: '亜' });

    expect(await readBodyHtml(page))
      .toBe('\n<p>a亜b</p>\n<details open="">\n<summary>title</summary>\n<p>body</p>\n</details>\n<p>cd</p>\n');
  });

  test('replaces via the browser default, unchanged, for character input into a non-crossing range', async ({ page }) => {
    await openEditor(page, BODY);
    await selectBetween(
      page,
      { selector: `${DETAILS} > p`, offset: 1 },
      { selector: `${DETAILS} > p`, offset: 3 },
    );

    await page.keyboard.type('Z');

    expect(await readBodyHtml(page))
      .toBe('\n<p>ab</p>\n<details open="">\n<summary>title</summary>\n<p>bZy</p>\n</details>\n<p>cd</p>\n');
  });

  test('settles the same as before the hook was added, for composition outside a collapsible section', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    const ime = await openImeSession(page);

    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    await ime.send('Input.insertText', { text: '亜' });

    expect(await readBodyHtml(page))
      .toBe('\n<p>ab亜</p>\n<details open="">\n<summary>title</summary>\n<p>body</p>\n</details>\n<p>cd</p>\n');
  });
});

test.describe('extending the selection inside the body', () => {
  test('extends the selection across the boundary without changing the tree, for a drag from one body paragraph to the next', async ({ page }) => {
    await openEditor(page, TWO_PARAGRAPH_BODY);
    const from = await readCharPoint(page, `${DETAILS} > p`, 2);
    const to = await readCharPoint(page, `${DETAILS} > p:last-of-type`, 3);

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.up();

    const bounds = await readSelectionBounds(page);
    expect([bounds, await readBodyHtml(page)]).toEqual([
      expect.objectContaining({ startText: 'alpha beta gamma', endText: 'delta' }),
      TWO_PARAGRAPH_BODY,
    ]);
  });

  test('keeps a word-granularity selection for a drag inside the same block', async ({ page }) => {
    await openEditor(page, TWO_PARAGRAPH_BODY);
    const from = await readCharPoint(page, `${DETAILS} > p`, 7);
    const to = await readCharPoint(page, `${DETAILS} > p`, 13);

    await page.mouse.move(from.x, from.y);
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();

    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('beta gamma');
  });

  test('neither re-anchors the selection nor toggles, for a drag that starts in the marker area', async ({ page }) => {
    await openEditor(page, TWO_PARAGRAPH_BODY);
    const marker = await readMarkerPoint(page, TITLE);
    const to = await readCharPoint(page, `${DETAILS} > p`, 3);

    await page.mouse.move(marker.x, marker.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();

    expect([
      await page.evaluate(() => window.getSelection()?.toString() ?? ''),
      await page.locator(DETAILS).evaluate((element) => element.hasAttribute('open')),
    ]).toEqual(['', true]);
  });

  test('does not re-anchor the selection on a move with no button pressed, after releasing the button outside the editor root', async ({ page }) => {
    await openEditor(page, TWO_PARAGRAPH_BODY);
    const from = await readCharPoint(page, `${DETAILS} > p`, 7);
    const above = await readPointAboveEditor(page);
    const to = await readCharPoint(page, `${DETAILS} > p:last-of-type`, 3);

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // Released after moving outside the editor root, so this never reaches the release receiver.
    await page.mouse.move(above.x, above.y, { steps: 5 });
    await page.mouse.up();
    const released = await readSelectionBounds(page);
    await page.mouse.move(to.x, to.y, { steps: 5 });

    expect(await readSelectionBounds(page)).toEqual(released);
  });

  test('advances the focus end across the block without moving the anchor, for repeated Shift+ArrowDown in the body', async ({ page }) => {
    await openEditor(page, TWO_PARAGRAPH_BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${DETAILS} > p`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Shift+ArrowDown');

    expect(await readSelectionBounds(page)).toEqual(expect.objectContaining({
      startText: 'alpha beta gamma',
      startOffset: 2,
      endText: 'delta',
    }));
  });

  test('stops the arrow key\'s default for a key press inside the body', async ({ page }) => {
    await openEditor(page, TWO_PARAGRAPH_BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${DETAILS} > p`, childIndex: 0, offset: 2 });

    expect(await pressAndReadPrevented(page, 'Shift+ArrowDown')).toBe(true);
  });

  test('extends one character at a time into the next block, for repeated Shift+ArrowRight in the body', async ({ page }) => {
    await openEditor(page, TWO_PARAGRAPH_BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${DETAILS} > p`, childIndex: 0, offset: 15 });

    for (let press = 0; press < 3; press += 1) {
      await page.keyboard.press('Shift+ArrowRight');
    }

    expect(await readSelectionBounds(page)).toEqual(expect.objectContaining({
      startText: 'alpha beta gamma',
      startOffset: 15,
      endText: 'delta',
      endOffset: 1,
    }));
  });

  test('does not intervene on the key press, proceeding with the default, for a selection whose anchor is outside the collapsible section', async ({ page }) => {
    await openEditor(page, TWO_PARAGRAPH_BODY);
    await focusEditor(page);
    // A paragraph outside the collapsible section is a direct child of the editor root. A descendant
    // selector would hit the body's paragraph instead.
    await placeCaret(page, { selector: `${EDITOR_ROOT} > p`, childIndex: 0, offset: 2 });

    expect(await pressAndReadPrevented(page, 'Shift+ArrowUp')).toBe(false);
  });

  test('does not intervene on a key press held with Ctrl or one during composition', async ({ page }) => {
    await openEditor(page, TWO_PARAGRAPH_BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${DETAILS} > p`, childIndex: 0, offset: 2 });
    const withModifier = await pressAndReadPrevented(page, 'Control+Shift+ArrowRight');

    const ime = await openImeSession(page);
    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    const whileComposing = await pressAndReadPrevented(page, 'Shift+ArrowDown');

    expect([withModifier, whileComposing]).toEqual([false, false]);
  });

  test('allows the extended result to land outside the collapsible section', async ({ page }) => {
    await openEditor(page, TWO_PARAGRAPH_BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${DETAILS} > p:last-of-type`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Shift+ArrowDown');

    expect([
      await readSelectionBounds(page),
      await readBodyHtml(page),
    ]).toEqual([
      expect.objectContaining({ startText: 'delta', startOffset: 2, endText: 'tail' }),
      TWO_PARAGRAPH_BODY,
    ]);
  });
});

test.describe('editing inside the body', () => {
  test('edits a body paragraph, heading, and blockquote, and inline formatting, the same as outside a collapsible section', async ({ page }) => {
    await openEditor(page, '\n<details open="">\n<summary>title</summary>\n<p>para</p>\n<h2>head</h2>\n<blockquote>quote</blockquote>\n</details>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${DETAILS} > p`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Enter');
    await selectBetween(
      page,
      { selector: `${DETAILS} > h2`, offset: 0 },
      { selector: `${DETAILS} > h2`, offset: 4 },
    );
    await page.keyboard.press('ControlOrMeta+B');

    expect(await readBodyHtml(page)).toBe(
      '\n<details open="">\n<summary>title</summary>\n<p>pa</p>\n<p>ra</p>\n'
      + '<h2><strong>head</strong></h2>\n<blockquote>quote</blockquote>\n</details>\n',
    );
  });

  test('has Enter in the title work the same after a document replacement, with the rule not lost', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await page.evaluate(
      (text) => window.__documentReplacementProbe?.(text),
      `${PROLOGUE}${CLOSED_BODY}${EPILOGUE}`,
    );
    await focusEditor(page);
    await placeCaret(page, { selector: TITLE, childIndex: 0, offset: 5 });

    await page.keyboard.press('Enter');

    expect([await readBodyHtml(page), await isCaretInside(page, `${DETAILS} > p`)]).toEqual([
      '\n<details open="">\n<summary>title</summary>\n<p>body</p>\n</details>\n',
      true,
    ]);
  });

  test('returns the body to the same form on save and reload, after an insert, a toggle, and Enter', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    await pressToolbarItem(page, TOOLBAR_SLOT.details);
    await page.keyboard.type('X');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Y');
    const point = await readMarkerPoint(page, TITLE);
    await page.mouse.click(point.x, point.y);
    const saved = await readCurrentForm(page);

    await page.evaluate(
      (text) => window.__documentReplacementProbe?.(text),
      `${PROLOGUE}${saved ?? ''}${EPILOGUE}`,
    );

    expect(await readBodyHtml(page)).toBe(saved);
  });
});
