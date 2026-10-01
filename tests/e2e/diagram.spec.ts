import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { HOST_TO_VIEW_MESSAGE_TYPE, VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import { SEARCH_HIGHLIGHT_NAME } from '../../webview/search/search-highlight';
import { ACTION_DIALOG_ELEMENT_ID } from '../../webview/ui/action-dialog';
import { CODE_BLOCK_COPY_ELEMENT_ID } from '../../webview/ui/code-block-copy';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { EDITOR_ROOT, openEditor, paste } from './helpers/editing';
import { getOutboundMessages, openProductionWebviewHost, sendToWebview } from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const MARK_NAMESPACE = 'urn:ahve:diagram';
const DRAWN_MARK = 'data-ahve-diagram';
const ERROR_MARK = 'data-ahve-diagram-error';
const EMPTY_MARK = 'data-ahve-diagram-empty';
const SELECTED_MARK = 'data-ahve-diagram-selected';

const FLOWCHART = 'flowchart TD\n  A[Start] --> B[End]';
// The same source as written in HTML, where the arrow's angle bracket is escaped.
const FLOWCHART_MARKUP = FLOWCHART.replace('>', '&gt;');
const DIAGRAM = `${EDITOR_ROOT} pre`;
const BODY = `\n<p>before</p>\n<pre class="mermaid">${FLOWCHART_MARKUP}</pre>\n<p>after</p>\n`;
const DIAGRAM_ITEM = `#${TOOLBAR_ELEMENT_ID} [data-slot="${TOOLBAR_SLOT.diagram}"] > button`;
const DIALOG = `#${ACTION_DIALOG_ELEMENT_ID}`;
const SOURCE_FIELD = `${DIALOG} textarea`;
// The harness has an empty catalog, so each button reads its message key.
const SAVE_BUTTON = 'diagramDialog.save';
const CANCEL_BUTTON = 'diagramDialog.cancel';
const DELETE_BUTTON = 'diagramDialog.delete';
const REQUIRED_BADGE = 'actionDialog.required';

declare global {
  interface Window {
    /** The copy events that reached the window, with the HTML form they carried. */
    __diagramCopies?: string[];
    /** The content security policy violations reported by the page. */
    __cspViolations?: { directive: string; blocked: string }[];
  }
}

// Permissions are granted so paste can be verified through the real clipboard.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

/**
 * Waits until a block carries the drawn mark, and returns the background image of its pseudo-element.
 *
 * @param page The page.
 * @param selector The block.
 * @returns The computed background image.
 */
async function waitForDrawing(page: Page, selector: string = DIAGRAM): Promise<string> {
  await page.waitForFunction(
    (argument) => document.querySelector(argument.selector)?.hasAttributeNS(argument.namespace, argument.mark) === true,
    { selector, namespace: MARK_NAMESPACE, mark: DRAWN_MARK },
  );
  return readBackground(page, selector);
}

/**
 * Reads the background image of the pseudo-element that draws a diagram.
 *
 * @param page The page.
 * @param selector The block.
 * @returns The computed background image.
 */
async function readBackground(page: Page, selector: string = DIAGRAM): Promise<string> {
  return page.locator(selector).evaluate((block) => getComputedStyle(block, '::after').backgroundImage);
}

/**
 * Reads whether a block carries a mark.
 *
 * @param page The page.
 * @param mark The mark.
 * @param selector The block.
 * @returns `true` when the mark is there.
 */
async function hasMark(page: Page, mark: string, selector: string = DIAGRAM): Promise<boolean> {
  return page.locator(selector).evaluate(
    (block, argument) => block.hasAttributeNS(argument.namespace, argument.mark),
    { namespace: MARK_NAMESPACE, mark },
  );
}

/**
 * Reads whether the source of a block is visible. A diagram never shows its source.
 *
 * @param page The page.
 * @param selector The block.
 * @returns `true` when the source text is visible.
 */
async function isSourceVisible(page: Page, selector: string = DIAGRAM): Promise<boolean> {
  return page.locator(selector).evaluate((block) => {
    const style = getComputedStyle(block);
    return style.visibility === 'visible' && style.fontSize !== '0px';
  });
}

/**
 * Reads the text the pseudo-element of a block shows. A card shows its notice there.
 *
 * @param page The page.
 * @param selector The block.
 * @returns The computed content.
 */
async function readCardContent(page: Page, selector: string = DIAGRAM): Promise<string> {
  return page.locator(selector).evaluate((block) => getComputedStyle(block, '::after').content);
}

/**
 * Counts the messages of one type the view sent to the host.
 *
 * @param page The page.
 * @param type The message type.
 * @returns The count.
 */
async function countSent(page: Page, type: string): Promise<number> {
  return (await readSentTypes(page)).filter((sent) => sent === type).length;
}

/**
 * Clicks the middle of a diagram.
 *
 * The block itself is invisible, so Playwright would wait for it to become visible. The middle of the block is the
 * visible diagram drawn by its pseudo-element, which is what a user clicks.
 *
 * @param page The page.
 * @param selector The block.
 */
async function clickDiagram(page: Page, selector: string = DIAGRAM): Promise<void> {
  await page.locator(selector).click({ force: true });
}

/**
 * Reads the body output.
 *
 * @param page The page.
 * @returns The body of the body output.
 */
async function readBodyOutput(page: Page): Promise<string> {
  return page.evaluate(() => window.__serializationProbe?.()?.body ?? '');
}

/**
 * Selects from an offset in the first text of one element to an offset in the first text of another.
 *
 * @param page The page.
 * @param from The start element and offset.
 * @param to The end element and offset.
 */
async function selectText(
  page: Page,
  from: { selector: string; offset: number },
  to: { selector: string; offset: number },
): Promise<void> {
  await page.evaluate((argument) => {
    const start = document.querySelector(argument.from.selector)?.firstChild;
    const end = document.querySelector(argument.to.selector)?.firstChild;
    if (start === null || start === undefined || end === null || end === undefined) {
      throw new Error('Text not found');
    }
    document.querySelector<HTMLElement>(argument.root)?.focus();
    const range = document.createRange();
    range.setStart(start, argument.from.offset);
    range.setEnd(end, argument.to.offset);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  }, { from, to, root: EDITOR_ROOT });
}

/**
 * Reads the node and offset of the collapsed selection.
 *
 * @param page The page.
 * @returns The local name (or `#text`) of the anchor node, its parent's local name, and the offset.
 */
async function readCaret(page: Page): Promise<(string | number | undefined)[]> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    return [selection?.anchorNode?.nodeName.toLowerCase(), selection?.anchorNode?.parentElement?.localName,
      selection?.anchorOffset, selection?.isCollapsed ? 'collapsed' : 'range'];
  });
}

/**
 * Returns the types of the messages the view sent to the host.
 *
 * @param page The page.
 * @returns The types, in the order sent.
 */
async function readSentTypes(page: Page): Promise<unknown[]> {
  return (await getOutboundMessages(page)).map((message) => (
    typeof message === 'object' && message !== null ? Reflect.get(message, 'type') : undefined
  ));
}

test.describe('Drawing diagram source blocks', () => {
  test('draws a mermaid pre as an image and never shows its source', async ({ page }) => {
    await openEditor(page, BODY);

    const background = await waitForDrawing(page);

    expect([background.startsWith('url("data:image/svg+xml'), await isSourceVisible(page)]).toEqual([true, false]);
  });

  test('draws a faint frame over the whole diagram block', async ({ page }) => {
    await openEditor(page, BODY);
    await waitForDrawing(page);

    const frame = await page.locator(DIAGRAM).evaluate((block) => {
      const style = getComputedStyle(block, '::before');
      return [style.borderTopStyle, style.borderTopWidth, style.visibility, style.position, style.top, style.bottom];
    });

    expect(frame).toEqual(['solid', '1px', 'visible', 'absolute', '0px', '0px']);
  });

  test('draws a pre whose only child is a language-mermaid code as well', async ({ page }) => {
    await openEditor(page, `<p>a</p><pre><code class="language-mermaid">${FLOWCHART_MARKUP}</code></pre>`);

    expect((await waitForDrawing(page)).startsWith('url("data:image/svg+xml')).toBe(true);
  });

  test('leaves the body output identical to the opened body after drawing, with no mark and no image', async ({ page }) => {
    await openEditor(page, BODY);
    await waitForDrawing(page);

    expect(await readBodyOutput(page)).toBe(BODY);
  });

  test('sends no edit notification, unsaved content or edit transaction for drawing', async ({ page }) => {
    await openEditor(page, BODY);
    await waitForDrawing(page);
    // Longer than the debounce of the body output, so an edit caused by the marks would have been sent.
    await page.waitForTimeout(1000);

    const sent = await readSentTypes(page);

    expect([
      VIEW_TO_HOST_MESSAGE_TYPE.viewEdited,
      VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent,
      VIEW_TO_HOST_MESSAGE_TYPE.editTransaction,
      VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart,
    ].filter((type) => sent.includes(type))).toEqual([]);
  });

  test('shows an invalid source as the error card instead of its source, and opens the dialog when the card is clicked', async ({ page }) => {
    await openEditor(page, '<p>a</p><pre class="mermaid">flowchart TD\n  A --></pre>');
    await expect.poll(() => hasMark(page, ERROR_MARK), { timeout: 10000 }).toBe(true);
    const shown = [await hasMark(page, DRAWN_MARK), await isSourceVisible(page), await readCardContent(page)];

    await clickDiagram(page);

    await expect(page.locator(SOURCE_FIELD)).toHaveValue('flowchart TD\n  A -->');
    expect(shown).toEqual([false, false, '"diagram.renderError"']);
  });

  test('shows an empty diagram source block as the empty card instead of its source', async ({ page }) => {
    await openEditor(page, '<p>a</p><pre class="mermaid"></pre><p>b</p>');
    await expect.poll(() => hasMark(page, EMPTY_MARK)).toBe(true);

    expect([
      await hasMark(page, DRAWN_MARK),
      await isSourceVisible(page),
      await readCardContent(page),
      await page.locator(DIAGRAM).evaluate((block) => block.getBoundingClientRect().height > 0),
    ]).toEqual([false, false, '"diagram.empty"', true]);
  });

  test('moves the caret past a diagram with ArrowDown, never into its source', async ({ page }) => {
    await openEditor(page, BODY);
    await waitForDrawing(page);
    await selectText(page, { selector: `${EDITOR_ROOT} p`, offset: 3 }, { selector: `${EDITOR_ROOT} p`, offset: 3 });

    await page.keyboard.press('ArrowDown');

    expect((await readCaret(page)).slice(0, 2)).toEqual(['#text', 'p']);
    expect(await page.evaluate(() => window.getSelection()?.anchorNode?.textContent)).toBe('after');
  });
});

test.describe('Editing diagrams in the dialog', () => {
  test('opens the dialog with the current source and the save, cancel and delete buttons when a diagram is clicked', async ({ page }) => {
    await openEditor(page, BODY);
    await waitForDrawing(page);

    await clickDiagram(page);

    await expect(page.locator(SOURCE_FIELD)).toHaveValue(FLOWCHART);
    expect(await page.locator(`${DIALOG} button`).allTextContents()).toEqual([DELETE_BUTTON, CANCEL_BUTTON, SAVE_BUTTON]);
  });

  test('marks the source field as required, with the badge text of the requirement label', async ({ page }) => {
    await openEditor(page, BODY);
    await waitForDrawing(page);

    await clickDiagram(page);

    expect(await page.locator(`${DIALOG} label`).evaluateAll((labels) => labels.map((label) => [
      label.getAttribute('data-requirement'),
      label.getAttribute('data-requirement-label'),
      label.querySelector('textarea')?.getAttribute('aria-required') ?? null,
    ]))).toEqual([['required', REQUIRED_BADGE, 'true']]);
  });

  test('gives the source field the input field colors and the full inner width of a dialog wider than the single-line ones', async ({ page }) => {
    await openEditor(page, BODY);
    await waitForDrawing(page);

    await clickDiagram(page);

    const look = await page.locator(SOURCE_FIELD).evaluate((field) => {
      const dialog = field.closest('[role="dialog"]') ?? field.parentElement!;
      // An element that takes the input field variables directly gives the colors they resolve to.
      const probe = document.createElement('div');
      probe.style.background = 'var(--ahve-input-bg)';
      probe.style.border = '1px solid var(--ahve-input-border)';
      // The field has focus on opening, and focus changes its border color to the ring color.
      const ring = document.createElement('div');
      ring.style.border = '1px solid var(--ahve-focus-ring)';
      probe.style.fontFamily = 'var(--ahve-font-family-mono)';
      dialog.append(probe, ring);
      const expected = getComputedStyle(probe);
      const style = getComputedStyle(field);
      const dialogStyle = getComputedStyle(dialog);
      const inner = dialog.clientWidth - parseFloat(dialogStyle.paddingLeft) - parseFloat(dialogStyle.paddingRight);
      const result = {
        background: style.backgroundColor === expected.backgroundColor,
        border: [expected.borderTopColor, getComputedStyle(ring).borderTopColor].includes(style.borderTopColor),
        radius: style.borderTopLeftRadius,
        mono: style.fontFamily === expected.fontFamily,
        fillsWidth: Math.abs(field.getBoundingClientRect().width - inner) < 1,
        dialogWidth: dialog.getBoundingClientRect().width,
        fontSize: parseFloat(dialogStyle.fontSize),
      };
      probe.remove();
      ring.remove();
      return result;
    });
    expect(look).toMatchObject({ background: true, border: true, radius: '10px', mono: true, fillsWidth: true });
    // The single-line dialogs are 27em wide; this one reaches 44em unless the view is too narrow.
    expect(look.dialogWidth).toBeGreaterThanOrEqual(Math.min(44 * look.fontSize, page.viewportSize()!.width - 2 * look.fontSize) - 1);
  });

  test('saving a changed source rewrites the block as one edit and draws the diagram again', async ({ page }) => {
    await openEditor(page, BODY);
    const before = await waitForDrawing(page);
    await clickDiagram(page);

    await page.locator(SOURCE_FIELD).fill('flowchart LR\n  A --> B --> C');
    await page.getByRole('button', { name: SAVE_BUTTON }).click();

    await expect(page.locator(DIALOG)).toHaveCount(0);
    await expect.poll(() => readBackground(page), { timeout: 10000 }).not.toBe(before);
    await expect.poll(() => readBodyOutput(page))
      .toBe('\n<p>before</p>\n<pre class="mermaid">flowchart LR\n  A --&gt; B --&gt; C</pre>\n<p>after</p>\n');
    await expect.poll(() => countSent(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).toBe(1);
  });

  test('saving an untouched source that ends with a line break leaves the body as it was and makes no edit', async ({ page }) => {
    const body = `\n<p>before</p>\n<pre class="mermaid">${FLOWCHART_MARKUP}\n</pre>\n<p>after</p>\n`;
    await openEditor(page, body);
    await waitForDrawing(page);
    await clickDiagram(page);
    await expect(page.locator(SOURCE_FIELD)).toHaveValue(FLOWCHART);

    await page.getByRole('button', { name: SAVE_BUTTON }).click();

    await expect(page.locator(DIALOG)).toHaveCount(0);
    // Longer than the debounce of the body output, so an edit would have been sent.
    await page.waitForTimeout(1000);
    expect([await readBodyOutput(page), await countSent(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)]).toEqual([body, 0]);
  });

  test('cancel leaves the body as it was', async ({ page }) => {
    await openEditor(page, BODY);
    await waitForDrawing(page);
    await clickDiagram(page);

    await page.locator(SOURCE_FIELD).fill('pie');
    await page.getByRole('button', { name: CANCEL_BUTTON }).click();

    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect(await readBodyOutput(page)).toBe(BODY);
  });

  test('delete removes the diagram source block', async ({ page }) => {
    await openEditor(page, BODY);
    await waitForDrawing(page);
    await clickDiagram(page);

    await page.getByRole('button', { name: DELETE_BUTTON }).click();

    await expect(page.locator(DIAGRAM)).toHaveCount(0);
    await expect.poll(() => readBodyOutput(page)).toBe('\n<p>before</p>\n<p>after</p>\n');
  });

  test('saving an empty source shows the reason and keeps the dialog open', async ({ page }) => {
    await openEditor(page, BODY);
    await waitForDrawing(page);
    await clickDiagram(page);

    await page.locator(SOURCE_FIELD).fill('  \n');
    await page.getByRole('button', { name: SAVE_BUTTON }).click();

    await expect(page.locator(`${DIALOG} [role="alert"]`)).toHaveText('diagramDialog.sourceRequired');
    expect(await readBodyOutput(page)).toBe(BODY);
  });

  test('Enter inside the field breaks the line, and the primary modifier+Enter saves', async ({ page }) => {
    await openEditor(page, BODY);
    await waitForDrawing(page);
    await clickDiagram(page);
    await page.locator(SOURCE_FIELD).press('ControlOrMeta+End');

    await page.keyboard.press('Enter');
    await page.keyboard.type('  B --> C');
    const typed = await page.locator(SOURCE_FIELD).inputValue();
    await page.keyboard.press('ControlOrMeta+Enter');

    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect(typed).toBe(`${FLOWCHART}\n  B --> C`);
    await expect.poll(() => readBodyOutput(page)).toContain(`${FLOWCHART_MARKUP}\n  B --&gt; C</pre>`);
  });
});

test.describe('Removing diagrams', () => {
  test('frames a diagram a range selection wholly contains, and Delete removes it', async ({ page }) => {
    await openEditor(page, BODY);
    await waitForDrawing(page);

    await selectText(page, { selector: `${EDITOR_ROOT} p`, offset: 6 }, { selector: `${EDITOR_ROOT} p:last-of-type`, offset: 0 });
    await expect.poll(() => hasMark(page, SELECTED_MARK)).toBe(true);
    await page.keyboard.press('Delete');

    await expect(page.locator(DIAGRAM)).toHaveCount(0);
  });

  test('Backspace at the start of the paragraph after a diagram removes the diagram and keeps the paragraph', async ({ page }) => {
    await openEditor(page, BODY);
    await waitForDrawing(page);
    await selectText(page, { selector: `${EDITOR_ROOT} p:last-of-type`, offset: 0 }, { selector: `${EDITOR_ROOT} p:last-of-type`, offset: 0 });

    await page.keyboard.press('Backspace');

    await expect(page.locator(DIAGRAM)).toHaveCount(0);
    await expect.poll(() => readBodyOutput(page)).toBe('\n<p>before</p>\n<p>after</p>\n');
  });
});

test.describe('Adding a line before a leading diagram', () => {
  test('ArrowUp at the start of the paragraph after a diagram that opens the document adds an empty paragraph before it', async ({ page }) => {
    await openEditor(page, `<pre class="mermaid">${FLOWCHART_MARKUP}</pre>\n<p>after</p>`);
    await waitForDrawing(page);
    await selectText(page, { selector: `${EDITOR_ROOT} p`, offset: 0 }, { selector: `${EDITOR_ROOT} p`, offset: 0 });

    await page.keyboard.press('ArrowUp');
    await page.keyboard.type('top');

    await expect.poll(() => readBodyOutput(page))
      .toBe(`\n<p>top</p>\n<pre class="mermaid">${FLOWCHART_MARKUP}</pre>\n<p>after</p>`);
  });

  test('ArrowUp at the start of the first item of a list after a leading diagram adds an empty paragraph before the diagram', async ({ page }) => {
    await openEditor(page, `<pre class="mermaid">${FLOWCHART_MARKUP}</pre>\n<ul><li>item</li></ul>`);
    await waitForDrawing(page);
    await selectText(page, { selector: `${EDITOR_ROOT} li`, offset: 0 }, { selector: `${EDITOR_ROOT} li`, offset: 0 });

    await page.keyboard.press('ArrowUp');
    await page.keyboard.type('top');

    await expect.poll(() => readBodyOutput(page))
      .toBe(`\n<p>top</p>\n<pre class="mermaid">${FLOWCHART_MARKUP}</pre>\n<ul><li>item</li></ul>`);
  });

  test('ArrowUp at the start of the first cell of a table after a leading diagram adds an empty paragraph before the diagram', async ({ page }) => {
    const table = '<table><tbody><tr><td>cell</td></tr></tbody></table>';
    await openEditor(page, `<pre class="mermaid">${FLOWCHART_MARKUP}</pre>\n${table}`);
    await waitForDrawing(page);
    await selectText(page, { selector: `${EDITOR_ROOT} td`, offset: 0 }, { selector: `${EDITOR_ROOT} td`, offset: 0 });

    await page.keyboard.press('ArrowUp');
    await page.keyboard.type('top');

    await expect.poll(() => readBodyOutput(page))
      .toBe(`\n<p>top</p>\n<pre class="mermaid">${FLOWCHART_MARKUP}</pre>\n${table}`);
  });

  test('ArrowUp at the start of the first cell of a table with a column group after a leading diagram adds an empty paragraph before the diagram', async ({ page }) => {
    const table = '<table><colgroup><col></colgroup><tbody><tr><td>cell</td></tr></tbody></table>';
    await openEditor(page, `<pre class="mermaid">${FLOWCHART_MARKUP}</pre>\n${table}`);
    await waitForDrawing(page);
    await selectText(page, { selector: `${EDITOR_ROOT} td`, offset: 0 }, { selector: `${EDITOR_ROOT} td`, offset: 0 });

    await page.keyboard.press('ArrowUp');
    await page.keyboard.type('top');

    await expect.poll(() => readBodyOutput(page))
      .toBe(`\n<p>top</p>\n<pre class="mermaid">${FLOWCHART_MARKUP}</pre>\n${table}`);
  });
});

test.describe('Inserting diagrams', () => {
  test('the diagram item inserts a drawn sample diagram after the paragraph and opens its dialog', async ({ page }) => {
    await openEditor(page, '<p>ab</p>');
    await selectText(page, { selector: `${EDITOR_ROOT} p`, offset: 2 }, { selector: `${EDITOR_ROOT} p`, offset: 2 });

    await page.locator(DIAGRAM_ITEM).click();

    await expect(page.locator(SOURCE_FIELD)).toHaveValue('graph TD\n  A --> B');
    expect([
      await readBodyOutput(page),
      (await waitForDrawing(page)).startsWith('url("data:image/svg+xml'),
    ]).toEqual(['<p>ab</p>\n<pre class="mermaid">graph TD\n  A --&gt; B</pre>\n<p><br></p>', true]);
  });
});

test.describe('Copying, pasting and searching diagrams', () => {
  test('resting the pointer on a diagram shows no code block copy button, while a code block beside it does', async ({ page }) => {
    await openEditor(page, `${BODY}<pre><code>plain code</code></pre>\n`);
    await waitForDrawing(page, `${EDITOR_ROOT} pre.mermaid`);
    const button = page.locator(`#${CODE_BLOCK_COPY_ELEMENT_ID}`);

    // The source itself is hidden, so the pointer is moved onto the drawn diagram rather than hovered over the block.
    const box = (await page.locator(`${EDITOR_ROOT} pre.mermaid`).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 2);
    await expect(button).toBeHidden();

    await page.locator(`${EDITOR_ROOT} pre:not(.mermaid)`).hover();
    await expect(button).toBeVisible();
  });

  test('copying a range across a diagram writes only the source block, with no image and no mark', async ({ page }) => {
    await openEditor(page, BODY);
    await waitForDrawing(page);
    await page.evaluate(() => {
      window.__diagramCopies = [];
      window.addEventListener('copy', (event) => window.__diagramCopies?.push(event.clipboardData?.getData('text/html') ?? ''));
    });

    await selectText(page, { selector: `${EDITOR_ROOT} p`, offset: 0 }, { selector: `${EDITOR_ROOT} p:last-of-type`, offset: 5 });
    await page.keyboard.press('ControlOrMeta+C');

    await expect.poll(() => page.evaluate(() => window.__diagramCopies ?? [])).toEqual([
      `<p>before</p>\n<pre class="mermaid">${FLOWCHART_MARKUP}</pre>\n<p>after</p>`,
    ]);
  });

  test('the copy HTML response carries only the source block', async ({ page }) => {
    await openEditor(page, BODY);
    await waitForDrawing(page);

    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestCopyHtml, requestId: '1' });

    await expect.poll(async () => (await getOutboundMessages(page)).flatMap((message) => (
      typeof message === 'object' && message !== null
      && Reflect.get(message, 'type') === VIEW_TO_HOST_MESSAGE_TYPE.copyHtmlResponse
        ? [Reflect.get(message, 'html')]
        : []
    ))).toEqual([BODY.trim()]);
  });

  test('pasting HTML with a mermaid pre keeps its class and draws it', async ({ page }) => {
    await openEditor(page, '<p>ab</p>');
    await selectText(page, { selector: `${EDITOR_ROOT} p`, offset: 2 }, { selector: `${EDITOR_ROOT} p`, offset: 2 });

    await paste(page, { 'text/html': `<pre class="mermaid extra">${FLOWCHART_MARKUP}</pre>`, 'text/plain': FLOWCHART });

    expect([
      await page.locator(DIAGRAM).getAttribute('class'),
      (await waitForDrawing(page)).startsWith('url("data:image/svg+xml'),
    ]).toEqual(['mermaid', true]);
  });

  test('a word found only in a diagram source has no match, while the same word in a paragraph does', async ({ page }) => {
    await openEditor(page, `<p>Start here</p><pre class="mermaid">${FLOWCHART_MARKUP}</pre>`);
    await waitForDrawing(page);
    await selectText(page, { selector: `${EDITOR_ROOT} p`, offset: 0 }, { selector: `${EDITOR_ROOT} p`, offset: 0 });

    await page.keyboard.press('ControlOrMeta+KeyF');
    await page.keyboard.type('Start');

    await expect.poll(() => page.evaluate((name) => CSS.highlights.get(name)?.size ?? 0, SEARCH_HIGHLIGHT_NAME.match))
      .toBe(1);
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+KeyF');
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('End');
    await expect.poll(() => page.evaluate((name) => CSS.highlights.get(name)?.size ?? 0, SEARCH_HIGHLIGHT_NAME.match))
      .toBe(0);
  });
});

test.describe('Following the theme and the tree', () => {
  test('draws the diagram again when the body switches to a dark theme', async ({ page }) => {
    await openEditor(page, BODY);
    const light = await waitForDrawing(page);

    await page.evaluate(() => document.body.classList.add('vscode-dark'));

    await expect.poll(() => readBackground(page), { timeout: 10000 }).not.toBe(light);
  });

  test('draws the diagrams of a document that replaces the tree', async ({ page }) => {
    await openEditor(page, '<p>a</p>');

    await page.evaluate((text) => window.__documentReplacementProbe?.(text), `${PROLOGUE}${BODY}${EPILOGUE}`);

    expect((await waitForDrawing(page)).startsWith('url("data:image/svg+xml')).toBe(true);
  });

  test('draws under the content security policy of the panel without a script or image violation', async ({ page }) => {
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__cspViolations?.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
      });
    });
    await openProductionWebviewHost(page);
    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
      text: `${PROLOGUE}${BODY}${EPILOGUE}`,
      documentUri: '',
      resourceRootUri: '',
    });

    const background = await waitForDrawing(page);
    const violations = await page.evaluate(() => window.__cspViolations ?? []);

    expect([
      background.startsWith('url("data:image/svg+xml'),
      await page.locator(DIAGRAM).evaluate((block) => getComputedStyle(block, '::after').height !== '0px'),
      violations.filter((violation) => /^(script|img)-src/u.test(violation.directive)),
    ]).toEqual([true, true, []]);
  });
});
