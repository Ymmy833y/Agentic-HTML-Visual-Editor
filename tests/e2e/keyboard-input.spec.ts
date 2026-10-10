import { devices, expect, test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';

import { EDITOR_ROOT_ELEMENT_ID, VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import {
  EDITOR_ROOT,
  focusEditor,
  installReceiver,
  openEditor,
  placeCaret,
  pressPrimaryShortcut,
  readBodyHtml,
  readRecord,
} from './helpers/editing';
import { getOutboundMessages } from './helpers/page';

const BODY = '\n<p>abcd</p>\n';
const EMPTY_PARAGRAPH = '\n<p><br></p>\n';
const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

// The view decides the primary modifier from the user agent, but the Desktop Chrome descriptor gives a Windows user
// agent regardless of the OS. The browser's default formatting keys (Cmd+B on macOS) follow the OS it runs on, so
// the user agent is aligned with that OS too.
const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
test.use({ userAgent: process.platform === 'darwin' ? MAC_USER_AGENT : devices['Desktop Chrome'].userAgent });

declare global {
  interface Window {
    /**
     * The forwarded key record. Holds the codes of keydown events that reached the window's bubbling phase, in
     * arrival order.
     */
    __forwardedKeys?: string[];
    /** A record of calls to the actions of shortcuts added through the registration port. */
    __shortcutRuns?: string[];
    /** A record of calls to the operations of entries added to the table. */
    __autoformatRuns?: string[];
  }
}

/** A position in text: which character of which child of which element. */
interface TextPoint {
  readonly selector: string;
  readonly childIndex: number;
  readonly offset: number;
}

/**
 * Starts recording the codes of keydown events that reach the window's bubbling phase, simulating VS Code's
 * forwarding.
 *
 * VS Code receives keydown in the bubbling phase of the webview's inner window and forwards it to the workbench, so
 * a key that does not get here never reaches VS Code.
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
 * Reads the forwarded key record.
 *
 * @param page The page to operate on.
 * @returns The codes of the keydown events that arrived, in arrival order.
 */
async function readForwardedKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__forwardedKeys ?? []);
}

/**
 * Selects between two positions while keeping focus on the editor root.
 *
 * @param page The page to operate on.
 * @param start The start point.
 * @param end The end point.
 */
async function selectRange(page: Page, start: TextPoint, end: TextPoint): Promise<void> {
  await page.evaluate((argument) => {
    const readText = (point: { selector: string; childIndex: number }): Node => {
      const node = document.querySelector(point.selector)?.childNodes[point.childIndex];
      if (node === undefined) {
        throw new Error(`text not found: ${point.selector}`);
      }
      return node;
    };

    const range = document.createRange();
    range.setStart(readText(argument.start), argument.start.offset);
    range.setEnd(readText(argument.end), argument.end.offset);
    document.getElementById(argument.rootId)?.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { start, end, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Moves focus to the editor root and places the caret inside the first child of the first paragraph.
 *
 * @param page The page to operate on.
 * @param offset The position inside the first child.
 */
async function placeCaretInParagraph(page: Page, offset: number): Promise<void> {
  await focusEditor(page);
  await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset });
}

/**
 * Calls the replace document entry point and swaps the body.
 *
 * @param page The page to operate on.
 * @param body The new body.
 */
async function replaceBody(page: Page, body: string): Promise<void> {
  await page.evaluate(
    (text) => window.__documentReplacementProbe?.(text),
    `${PROLOGUE}${body}${EPILOGUE}`,
  );
}

/**
 * Returns how many of the sent messages have the given type.
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
 * Returns whether the caret is inside an element.
 *
 * @param page The page to operate on.
 * @param selector The selector used to find the element.
 * @returns `true` if it is inside.
 */
async function isCaretInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((target) => {
    const anchor = window.getSelection()?.anchorNode ?? null;
    const element = document.querySelector(target);
    return anchor !== null && element !== null && element.contains(anchor);
  }, selector);
}

/** Opens a channel for driving the browser's IME. */
async function openImeSession(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

test.describe('handling key input', () => {
  test('pressing Ctrl+B, Ctrl+I, Ctrl+\\, Ctrl+Shift+1, Ctrl+Alt+1 and Ctrl+Shift+0 in the editor root does not reach the forwarded key record', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretInParagraph(page, 2);
    await installForwardRecord(page);

    for (const key of ['KeyB', 'KeyI', 'Backslash', 'Shift+Digit1', 'Alt+Digit1', 'Shift+Digit0']) {
      await pressPrimaryShortcut(page, key);
    }

    // The keydown of a modifier key itself matches no shortcut and gets through. Only non-modifier keys are checked.
    const forwarded = await readForwardedKeys(page);
    expect(['KeyB', 'KeyI', 'Backslash', 'Digit1', 'Digit0'].filter((code) => forwarded.includes(code)))
      .toEqual([]);
  });

  test('pressing Ctrl+S and Ctrl+Shift+P in the editor root reaches the forwarded key record', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretInParagraph(page, 2);
    await installForwardRecord(page);

    await pressPrimaryShortcut(page, 'KeyS');
    await pressPrimaryShortcut(page, 'Shift+KeyP');

    expect(await readForwardedKeys(page)).toEqual(expect.arrayContaining(['KeyS', 'KeyP']));
  });

  test('pressing Ctrl+Shift+Alt+1 and Ctrl+Shift+B leaves the tree unchanged and the keys reach the forwarded key record', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretInParagraph(page, 2);
    await installForwardRecord(page);

    await pressPrimaryShortcut(page, 'Shift+Alt+Digit1');
    await pressPrimaryShortcut(page, 'Shift+KeyB');

    expect([await readBodyHtml(page), await readForwardedKeys(page)])
      .toEqual([BODY, expect.arrayContaining(['Digit1', 'KeyB'])]);
  });

  test('a Shift+Tab shortcut added through the registration port is called, and the Shift+Tab it takes over does not reach the forwarded key record', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretInParagraph(page, 2);
    await installForwardRecord(page);
    await page.evaluate(() => {
      window.__shortcutRuns = [];
      window.__shortcutReceiverProbe?.()?.register({
        key: { code: 'Tab', primary: false, shift: true, alt: false },
        run: () => {
          window.__shortcutRuns?.push('Shift+Tab');
          return 'preventDefault';
        },
      });
    });

    await page.keyboard.press('Shift+Tab');

    expect([
      await page.evaluate(() => window.__shortcutRuns ?? []),
      (await readForwardedKeys(page)).includes('Tab'),
    ]).toEqual([['Shift+Tab'], false]);
  });

  test('Tab with the caret in a paragraph before a collapsible section keeps focus, the caret and the tree, and does not reach the forwarded key record', async ({ page }) => {
    const body = '\n<p>abcd</p>\n<details open="">\n<summary>t</summary>\n<p>x</p>\n</details>\n';
    await openEditor(page, body);
    await placeCaretInParagraph(page, 2);
    await installForwardRecord(page);

    await page.keyboard.press('Tab');

    expect([
      await page.evaluate((id) => document.activeElement?.id === id, EDITOR_ROOT_ELEMENT_ID),
      await page.evaluate(() => [window.getSelection()?.anchorNode?.textContent, window.getSelection()?.anchorOffset]),
      await readBodyHtml(page),
      (await readForwardedKeys(page)).includes('Tab'),
    ]).toEqual([true, ['abcd', 2], body, false]);
  });

  test('Tab with the caret in a collapsible section title keeps focus and the caret', async ({ page }) => {
    await openEditor(page, '\n<details open="">\n<summary>title</summary>\n<p>x</p>\n</details>\n<p>y</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} summary`, childIndex: 0, offset: 2 });

    await page.keyboard.press('Tab');

    expect([
      await page.evaluate((id) => document.activeElement?.id === id, EDITOR_ROOT_ELEMENT_ID),
      await page.evaluate(() => [window.getSelection()?.anchorNode?.textContent, window.getSelection()?.anchorOffset]),
    ]).toEqual([true, ['title', 2]]);
  });

  test('pressing Ctrl+Shift+1 while an overlay is up leaves the tree unchanged and the key reaches the forwarded key record', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretInParagraph(page, 2);
    await installForwardRecord(page);
    await page.evaluate((reason) => {
      window.__uiShellProbe?.()?.overlay.present(reason, { heading: '', descriptions: [], actions: [] });
    }, INPUT_STOP_REASON.saveRoundTrip);

    await pressPrimaryShortcut(page, 'Shift+Digit1');

    expect([await readBodyHtml(page), (await readForwardedKeys(page)).includes('Digit1')])
      .toEqual([BODY, true]);
  });
});

test.describe('inline format and block kind shortcuts', () => {
  test('selecting a range containing bold and pressing Ctrl+\\ removes the format element', async ({ page }) => {
    await openEditor(page, '\n<p>a<strong>bc</strong>d</p>\n');
    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 0 },
      { selector: `${EDITOR_ROOT} p`, childIndex: 2, offset: 1 },
    );

    await pressPrimaryShortcut(page, 'Backslash');

    expect(await readBodyHtml(page)).toBe('\n<p>abcd</p>\n');
  });

  test('pressing Ctrl+Shift+1 to 6 in a paragraph turns it into h1 to h6 respectively', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretInParagraph(page, 2);

    const tagNames: (string | undefined)[] = [];
    for (const digit of [1, 2, 3, 4, 5, 6]) {
      await pressPrimaryShortcut(page, `Shift+Digit${digit}`);
      tagNames.push(await page.locator(EDITOR_ROOT).evaluate((root) => root.firstElementChild?.localName));
    }

    expect(tagNames).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  });

  test('pressing Ctrl+Alt+2 in a paragraph turns it into h2', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretInParagraph(page, 2);

    await pressPrimaryShortcut(page, 'Alt+Digit2');

    expect(await readBodyHtml(page)).toBe('\n<h2>abcd</h2>\n');
  });

  test('pressing Ctrl+Shift+0 in a heading turns it back into a paragraph', async ({ page }) => {
    await openEditor(page, '\n<h3>abcd</h3>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} h3`, childIndex: 0, offset: 2 });

    await pressPrimaryShortcut(page, 'Shift+Digit0');

    expect(await readBodyHtml(page)).toBe(BODY);
  });

  test('a single Ctrl+Shift+2 conversion sends exactly one edit unit pair to the host', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretInParagraph(page, 2);

    await pressPrimaryShortcut(page, 'Shift+Digit2');

    await expect
      .poll(() => countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction))
      .toBe(1);
  });

  test('selecting a range and pressing Ctrl+B and Ctrl+I makes it bold and italic through the default action', async ({ page }) => {
    await openEditor(page, BODY);
    await selectRange(
      page,
      { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 3 },
    );

    await pressPrimaryShortcut(page, 'KeyB');
    await pressPrimaryShortcut(page, 'KeyI');

    expect(await readBodyHtml(page)).toBe('\n<p>a<strong><em>bc</em></strong>d</p>\n');
  });

  test('pressing Ctrl+B during an IME composition leaves the tree unchanged and the key does not reach the forwarded key record', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await placeCaretInParagraph(page, 2);
    await installForwardRecord(page);
    const ime = await openImeSession(page);

    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    const duringComposition = await readBodyHtml(page);
    await pressPrimaryShortcut(page, 'KeyB');

    expect([await readBodyHtml(page), (await readForwardedKeys(page)).includes('KeyB')])
      .toEqual([duringComposition, false]);
  });
});

test.describe('registering the entry points', () => {
  test('even after the document is replaced, Ctrl+Shift+1 makes h1 and the key does not reach the forwarded key record', async ({ page }) => {
    await openEditor(page, BODY);
    await replaceBody(page, '\n<p>efgh</p>\n');
    await placeCaretInParagraph(page, 2);
    await installForwardRecord(page);

    await pressPrimaryShortcut(page, 'Shift+Digit1');

    expect([await readBodyHtml(page), (await readForwardedKeys(page)).includes('Digit1')])
      .toEqual(['\n<h1>efgh</h1>\n', false]);
  });

  test('even after the document is replaced, typing "# " at the start of a paragraph makes h1', async ({ page }) => {
    await openEditor(page, BODY);
    await replaceBody(page, '\n<p>efgh</p>\n');
    await placeCaretInParagraph(page, 0);

    await page.keyboard.type('# ');

    expect(await readBodyHtml(page)).toBe('\n<h1>efgh</h1>\n');
  });

  test('the edit kind of the immediate notification for the "# " conversion is text input, not the block command kind', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretInParagraph(page, 0);
    await installReceiver(page);

    await page.keyboard.type('# ');

    // Two: the text input of "#" and the space that triggered the conversion.
    expect((await readRecord(page)).kinds).toEqual(['insertText', 'insertText']);
  });

  test('Shift+Enter after "---" does not convert and inserts a line break', async ({ page }) => {
    await openEditor(page, EMPTY_PARAGRAPH);
    await placeCaretInParagraph(page, 0);

    await page.keyboard.type('---');
    await page.keyboard.press('Shift+Enter');

    expect(await readBodyHtml(page)).toBe('\n<p>---<br><br></p>\n');
  });
});

test.describe('applying markdown-style autoformat', () => {
  test('typing "# " at the start of a paragraph with content makes h1, keeps the content, and inserts no space', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretInParagraph(page, 0);

    await page.keyboard.type('# ');

    expect(await readBodyHtml(page)).toBe('\n<h1>abcd</h1>\n');
  });

  test('typing "###### " in an empty paragraph makes an empty h6, and characters typed next go into the h6', async ({ page }) => {
    await openEditor(page, EMPTY_PARAGRAPH);
    await placeCaretInParagraph(page, 0);

    await page.keyboard.type('###### ');
    const converted = await readBodyHtml(page);
    await page.keyboard.type('x');

    expect([converted, await readBodyHtml(page)]).toEqual(['\n<h6><br></h6>\n', '\n<h6>x</h6>\n']);
  });

  test('typing "> " in an empty paragraph makes a bare blockquote', async ({ page }) => {
    await openEditor(page, EMPTY_PARAGRAPH);
    await placeCaretInParagraph(page, 0);

    await page.keyboard.type('> ');

    expect(await readBodyHtml(page)).toBe('\n<blockquote><br></blockquote>\n');
  });

  test('typing ">warning " in an empty paragraph makes a blockquote whose data-alert is warning', async ({ page }) => {
    await openEditor(page, EMPTY_PARAGRAPH);
    await placeCaretInParagraph(page, 0);

    await page.keyboard.type('>warning ');

    expect(await readBodyHtml(page)).toBe('\n<blockquote data-alert="warning"><br></blockquote>\n');
  });

  test('typing "```" and pressing Enter makes an empty code block, and characters typed next go inside the code', async ({ page }) => {
    await openEditor(page, EMPTY_PARAGRAPH);
    await placeCaretInParagraph(page, 0);

    await page.keyboard.type('```');
    await page.keyboard.press('Enter');
    const converted = await readBodyHtml(page);
    await page.keyboard.type('ab');

    expect([converted, await readBodyHtml(page)])
      .toEqual(['\n<pre><code></code></pre>\n', '\n<pre><code>ab</code></pre>\n']);
  });

  test('typing "```" on the second line of a bare blockquote and pressing Enter makes that line an empty code block inside the blockquote, and characters typed next go inside the code', async ({ page }) => {
    await openEditor(page, '\n<blockquote>ab</blockquote>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} blockquote`, childIndex: 0, offset: 2 });
    // The first Enter makes the second line of the blockquote.
    await page.keyboard.press('Enter');

    await page.keyboard.type('```');
    await page.keyboard.press('Enter');
    const converted = await readBodyHtml(page);
    await page.keyboard.type('cd');

    expect([converted, await readBodyHtml(page)]).toEqual([
      '\n<blockquote><p>ab</p>\n<pre><code></code></pre></blockquote>\n',
      '\n<blockquote><p>ab</p>\n<pre><code>cd</code></pre></blockquote>\n',
    ]);
  });

  test('typing "---" and pressing Enter inserts one hr, keeps the caret in the empty paragraph right after it, and adds no extra paragraph', async ({ page }) => {
    await openEditor(page, EMPTY_PARAGRAPH);
    await placeCaretInParagraph(page, 0);

    await page.keyboard.type('---');
    await page.keyboard.press('Enter');

    expect([await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} p`)])
      .toEqual(['\n\n<hr>\n<p><br></p>\n', true]);
  });
});

test.describe('matching markdown-style autoformat', () => {
  test('typing "# " inside a heading, a list item and a code block leaves the marker and space as plain text in each', async ({ page }) => {
    await openEditor(page, '\n<h2>a</h2>\n<ul><li>b</li></ul>\n<pre><code>c</code></pre>\n');
    await focusEditor(page);

    for (const selector of ['h2', 'li', 'code']) {
      await placeCaret(page, { selector: `${EDITOR_ROOT} ${selector}`, childIndex: 0, offset: 0 });
      await page.keyboard.type('# ');
    }

    expect(await readBodyHtml(page))
      .toBe('\n<h2># a</h2>\n<ul><li># b</li></ul>\n<pre><code># c</code></pre>\n');
  });

  test('typing "---" on a line of a bare blockquote and pressing Enter inserts an hr inside the blockquote at that line, keeping the caret on the emptied line after it', async ({ page }) => {
    await openEditor(page, '\n<blockquote>ab</blockquote>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} blockquote`, childIndex: 0, offset: 2 });
    await page.keyboard.press('Enter');

    await page.keyboard.type('---');
    await page.keyboard.press('Enter');

    expect([await readBodyHtml(page), await isCaretInside(page, `${EDITOR_ROOT} blockquote > hr + p`)])
      .toEqual(['\n<blockquote><p>ab</p>\n\n<hr>\n<p><br></p></blockquote>\n', true]);
  });

  test('typing ">tip " at the start of a paragraph of an alert blockquote holding paragraphs leaves it as text and keeps the alert', async ({ page }) => {
    await openEditor(page, '\n<blockquote data-alert="note"><p>ab</p>\n<p>cd</p></blockquote>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} blockquote p + p`, childIndex: 0, offset: 0 });

    await page.keyboard.type('>tip ');

    expect(await readBodyHtml(page))
      .toBe('\n<blockquote data-alert="note"><p>ab</p>\n<p>&gt;tip cd</p></blockquote>\n');
  });

  test('typing a space after a bolded "#" does not convert and inserts the space', async ({ page }) => {
    await openEditor(page, '\n<p><strong>#</strong></p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} strong`, childIndex: 0, offset: 1 });

    await page.keyboard.type(' ');

    expect(await readBodyHtml(page)).toBe('\n<p><strong>#&nbsp;</strong></p>\n');
  });

  test('typing a space and then "# " in an empty paragraph makes h1 without counting the leading whitespace', async ({ page }) => {
    await openEditor(page, EMPTY_PARAGRAPH);
    await placeCaretInParagraph(page, 0);

    await page.keyboard.type(' # ');

    expect(await readBodyHtml(page)).toBe('\n<h1><br></h1>\n');
  });

  test('typing "+ " and "2. ", which have no entries in the autoformat table, leaves them as plain text', async ({ page }) => {
    await openEditor(page, '\n<p><br></p>\n<p><br></p>\n');
    await focusEditor(page);

    await placeCaret(page, { selector: `${EDITOR_ROOT} p:first-of-type`, childIndex: 0, offset: 0 });
    await page.keyboard.type('+ ');
    await placeCaret(page, { selector: `${EDITOR_ROOT} p:last-of-type`, childIndex: 0, offset: 0 });
    await page.keyboard.type('2. ');

    expect(await readBodyHtml(page)).toBe('\n<p>+&nbsp;</p>\n<p>2.&nbsp;</p>\n');
  });

  test('an entry added to the table (+ and a space) is called on typing "+ ", and neither the + nor the space remains', async ({ page }) => {
    await openEditor(page, EMPTY_PARAGRAPH);
    // When the marker overlaps an entry already in the table at startup, the entry added first is used. The
    // entry is added with a marker that overlaps none of them.
    await page.evaluate(() => {
      window.__autoformatRuns = [];
      window.__autoformatTableProbe?.().addEntry({
        commit: 'space',
        marker: '+',
        run: () => {
          window.__autoformatRuns?.push('+');
          return true;
        },
      });
    });
    await placeCaretInParagraph(page, 0);

    await page.keyboard.type('+ ');

    expect([await page.evaluate(() => window.__autoformatRuns ?? []), await readBodyHtml(page)])
      .toEqual([['+'], EMPTY_PARAGRAPH]);
  });
});
