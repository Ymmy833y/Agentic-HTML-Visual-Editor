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
import { DIAGRAM_ZOOM_ELEMENT_ID } from '../../webview/ui/diagram-zoom';
import { TOOLTIP_ELEMENT_ID } from '../../webview/ui/tooltip';
import { EDITOR_ROOT, installReceiver, readRecord } from './helpers/editing';
import { PROBE_BUNDLE_PATH, getOutboundMessages, openWebviewHost, sendToWebview } from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const MARK_NAMESPACE = 'urn:ahve:diagram';
const DRAWN_MARK = 'data-ahve-diagram';
const ERROR_MARK = 'data-ahve-diagram-error';

const DIAGRAM = `${EDITOR_ROOT} pre`;
const PARAGRAPH = `${EDITOR_ROOT} p`;
const BAR = `#${DIAGRAM_ZOOM_ELEMENT_ID}`;
const DIALOG = `#${ACTION_DIALOG_ELEMENT_ID}`;
const ZOOM_IN = `${BAR} button[aria-label="Zoom In"]`;
const ZOOM_OUT = `${BAR} button[aria-label="Zoom Out"]`;
const RESET = `${BAR} button[aria-label="Reset Zoom"]`;

// A small diagram, drawn narrower than the column.
const SMALL_BODY = '\n<p>before</p>\n<pre class="mermaid">flowchart TD\n  A --&gt; B</pre>\n<p>after</p>\n';
// A wide diagram, drawn wider than the column and shown shrunk to it.
const WIDE_BODY = '\n<p>before</p>\n<pre class="mermaid">flowchart LR\n  A[Alpha alpha] --&gt; B[Beta beta] --&gt; C[Gamma gamma] --&gt; D[Delta delta] --&gt; E[Epsilon epsilon] --&gt; F[Zeta zeta]</pre>\n<p>after</p>\n';
// A small diagram followed by enough paragraphs for the document to scroll.
const TALL_BODY = `\n<p>before</p>\n<pre class="mermaid">flowchart TD\n  A --&gt; B</pre>\n${'<p>after</p>\n'.repeat(80)}`;

// The view decides the primary modifier from the userAgent, but the Desktop Chrome descriptor returns a Windows
// userAgent whatever the OS. The wheel is turned with the modifier held as a real key, so the userAgent is aligned with
// the running OS.
const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
test.use({ userAgent: process.platform === 'darwin' ? MAC_USER_AGENT : devices['Desktop Chrome'].userAgent });

/**
 * Opens the view with the English messages and mounts a body.
 *
 * @param page The page.
 * @param body The body.
 */
async function openDiagramEditor(page: Page, body: string): Promise<void> {
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
 * Waits until the diagram carries a mark.
 *
 * @param page The page.
 * @param mark The mark.
 */
async function waitForMark(page: Page, mark: string = DRAWN_MARK): Promise<void> {
  await page.waitForFunction(
    (argument) => document.querySelector(argument.selector)?.hasAttributeNS(argument.namespace, argument.mark) === true,
    { selector: DIAGRAM, namespace: MARK_NAMESPACE, mark },
  );
}

/**
 * Moves the pointer onto the middle of the diagram. The block itself is invisible, so the pointer goes to where its
 * drawn picture is.
 *
 * @param page The page.
 */
async function hoverDiagram(page: Page): Promise<void> {
  await page.locator(DIAGRAM).hover({ force: true });
}

/**
 * Reads the rendered width of the drawn picture.
 *
 * @param page The page.
 * @returns The width in px.
 */
async function readImageWidth(page: Page): Promise<number> {
  return page.locator(DIAGRAM).evaluate((block) => Number.parseFloat(getComputedStyle(block, '::after').width));
}

/**
 * Reads a rectangle relative to the viewport.
 *
 * @param page The page.
 * @param selector The element.
 * @returns The top and right edges.
 */
async function readTopRight(page: Page, selector: string): Promise<{ top: number; right: number }> {
  return page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, right: rect.right };
  });
}

/**
 * Counts the messages of one type the view sent to the host.
 *
 * @param page The page.
 * @param type The message type.
 * @returns The count.
 */
async function countSent(page: Page, type: string): Promise<number> {
  return (await getOutboundMessages(page)).filter((message) => (
    typeof message === 'object' && message !== null && Reflect.get(message, 'type') === type
  )).length;
}

// Headless Chromium hides scroll bars unless told otherwise, and one case presses the scroll bar of a diagram.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

test.describe('Zoom buttons of diagrams', () => {
  test('appear at the top right of a drawn diagram under the pointer, and hide when the pointer moves to a paragraph', async ({ page }) => {
    await openDiagramEditor(page, SMALL_BODY);
    await waitForMark(page);

    await hoverDiagram(page);
    const shown = await page.locator(BAR).isVisible();
    const diagram = await readTopRight(page, DIAGRAM);
    const bar = await readTopRight(page, BAR);
    await page.locator(PARAGRAPH).first().hover();

    expect([shown, bar.top - diagram.top, diagram.right - bar.right, await page.locator(BAR).isVisible()])
      .toEqual([true, 4, 4, false]);
  });

  test('zoom in scales the diagram by 1.25, zoom out brings it back, and reset returns to 100%', async ({ page }) => {
    await openDiagramEditor(page, SMALL_BODY);
    await waitForMark(page);
    const usual = await readImageWidth(page);

    await hoverDiagram(page);
    await page.locator(ZOOM_IN).click();
    const zoomedIn = await readImageWidth(page);
    await page.locator(ZOOM_OUT).click();
    const zoomedOut = await readImageWidth(page);
    await page.locator(ZOOM_IN).click();
    await page.locator(ZOOM_IN).click();
    await page.locator(RESET).click();

    expect([zoomedIn / usual, zoomedOut, await readImageWidth(page)]).toEqual([1.25, usual, usual]);
  });

  test('a diagram zoomed past the column scrolls sideways inside its block, and the page does not grow sideways', async ({ page }) => {
    await openDiagramEditor(page, WIDE_BODY);
    await waitForMark(page);

    await hoverDiagram(page);
    for (let step = 0; step < 3; step += 1) {
      await page.locator(ZOOM_IN).click();
    }
    await hoverDiagram(page);
    await page.mouse.wheel(200, 0);

    await expect.poll(() => page.locator(DIAGRAM).evaluate((block) => block.scrollLeft)).toBeGreaterThan(0);
    expect(await page.locator(DIAGRAM).evaluate((block) => [
      block.scrollWidth > block.clientWidth,
      document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ])).toEqual([true, true]);
  });

  test('pressing the buttons opens no dialog and changes neither the output, the selection, the focus nor the history', async ({ page }) => {
    await openDiagramEditor(page, SMALL_BODY);
    await waitForMark(page);
    await installReceiver(page);
    await page.evaluate((rootId) => {
      document.getElementById(rootId)?.focus();
      const text = document.querySelector('p')?.firstChild;
      if (text !== null && text !== undefined) {
        window.getSelection()?.collapse(text, 2);
      }
    }, EDITOR_ROOT_ELEMENT_ID);
    const body = await page.evaluate(() => window.__serializationProbe?.()?.body ?? '');

    await hoverDiagram(page);
    await page.locator(ZOOM_IN).click();
    await page.locator(RESET).click();
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestEditTransactionFlush, requestId: 'zoom' });

    expect([
      await page.locator(DIALOG).count(),
      await page.evaluate(() => window.__serializationProbe?.()?.body ?? ''),
      await page.evaluate(() => [window.getSelection()?.anchorNode?.textContent, window.getSelection()?.anchorOffset]),
      await page.evaluate((rootId) => document.activeElement?.id === rootId, EDITOR_ROOT_ELEMENT_ID),
      (await readRecord(page)).kinds,
      await countSent(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction),
    ]).toEqual([0, body, ['before', 2], true, [], 0]);
  });

  test('keeps the zoom level when the tree is replaced with the same source, as after saving', async ({ page }) => {
    await openDiagramEditor(page, SMALL_BODY);
    await waitForMark(page);
    const usual = await readImageWidth(page);
    await hoverDiagram(page);
    await page.locator(ZOOM_IN).click();

    await page.evaluate((text) => window.__documentReplacementProbe?.(text), `${PROLOGUE}${SMALL_BODY}${EPILOGUE}`);
    await waitForMark(page);

    expect(await readImageWidth(page) / usual).toBe(1.25);
  });

  test('a click on a zoomed diagram still opens its dialog, and the caret is not in its source after the dialog closes', async ({ page }) => {
    await openDiagramEditor(page, SMALL_BODY);
    await waitForMark(page);
    await hoverDiagram(page);
    await page.locator(ZOOM_IN).click();

    await page.locator(DIAGRAM).click({ force: true });
    await expect(page.locator(DIALOG)).toHaveCount(1);
    await page.keyboard.press('Escape');

    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect(await page.evaluate((selector) => {
      const anchor = window.getSelection()?.anchorNode ?? null;
      return anchor !== null && document.querySelector(selector)?.contains(anchor) === true;
    }, DIAGRAM)).toBe(false);
  });

  test('ArrowDown moves the caret past a zoomed diagram, never into its source', async ({ page }) => {
    await openDiagramEditor(page, SMALL_BODY);
    await waitForMark(page);
    await hoverDiagram(page);
    await page.locator(ZOOM_IN).click();
    await page.evaluate((rootId) => {
      document.getElementById(rootId)?.focus();
      const text = document.querySelector('p')?.firstChild;
      if (text !== null && text !== undefined) {
        window.getSelection()?.collapse(text, 3);
      }
    }, EDITOR_ROOT_ELEMENT_ID);

    await page.keyboard.press('ArrowDown');

    expect(await page.evaluate(() => window.getSelection()?.anchorNode?.textContent)).toBe('after');
  });

  test('do not appear over the error card of a diagram that could not be drawn', async ({ page }) => {
    await openDiagramEditor(page, '\n<p>before</p>\n<pre class="mermaid">flowchart TD\n  A --&gt;</pre>\n<p>after</p>\n');
    await waitForMark(page, ERROR_MARK);

    await hoverDiagram(page);

    await expect(page.locator(BAR)).toBeHidden();
  });

  test('are named Zoom In, Zoom Out and Reset Zoom, and show the name as a tooltip while the pointer rests on one', async ({ page }) => {
    await openDiagramEditor(page, SMALL_BODY);
    await waitForMark(page);
    await hoverDiagram(page);

    await page.locator(ZOOM_IN).hover();

    await expect(page.locator(`#${TOOLTIP_ELEMENT_ID}`)).toHaveText('Zoom In');
    expect(await page.locator(`${BAR} button`).evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))))
      .toEqual(['Zoom In', 'Zoom Out', 'Reset Zoom']);
  });
});

test.describe('Wheel zoom of diagrams', () => {
  test('turning the wheel away with the primary modifier over a drawn diagram scales it by 1.25, and turning it back restores it', async ({ page }) => {
    await openDiagramEditor(page, SMALL_BODY);
    await waitForMark(page);
    const usual = await readImageWidth(page);
    await hoverDiagram(page);

    await page.keyboard.down('ControlOrMeta');
    await page.mouse.wheel(0, -100);
    await expect.poll(() => readImageWidth(page)).toBe(usual * 1.25);
    await page.mouse.wheel(0, 100);
    await expect.poll(() => readImageWidth(page)).toBe(usual);
    await page.keyboard.up('ControlOrMeta');
  });

  test('turning the wheel over a diagram without the primary modifier scrolls the document and keeps the zoom level', async ({ page }) => {
    await openDiagramEditor(page, TALL_BODY);
    await waitForMark(page);
    const usual = await readImageWidth(page);
    await hoverDiagram(page);

    await page.mouse.wheel(0, 200);

    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(await readImageWidth(page)).toBe(usual);
  });

  test('zooming with the primary modifier and the wheel opens no dialog and changes neither the output, the selection, the focus nor the history', async ({ page }) => {
    await openDiagramEditor(page, SMALL_BODY);
    await waitForMark(page);
    await installReceiver(page);
    await page.evaluate((rootId) => {
      document.getElementById(rootId)?.focus();
      const text = document.querySelector('p')?.firstChild;
      if (text !== null && text !== undefined) {
        window.getSelection()?.collapse(text, 2);
      }
    }, EDITOR_ROOT_ELEMENT_ID);
    const body = await page.evaluate(() => window.__serializationProbe?.()?.body ?? '');
    const usual = await readImageWidth(page);

    await hoverDiagram(page);
    await page.keyboard.down('ControlOrMeta');
    await page.mouse.wheel(0, -100);
    await expect.poll(() => readImageWidth(page)).toBe(usual * 1.25);
    await page.keyboard.up('ControlOrMeta');
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestEditTransactionFlush, requestId: 'wheel' });

    expect([
      await page.locator(DIALOG).count(),
      await page.evaluate(() => window.__serializationProbe?.()?.body ?? ''),
      await page.evaluate(() => [window.getSelection()?.anchorNode?.textContent, window.getSelection()?.anchorOffset]),
      await page.evaluate((rootId) => document.activeElement?.id === rootId, EDITOR_ROOT_ELEMENT_ID),
      (await readRecord(page)).kinds,
      await countSent(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction),
    ]).toEqual([0, body, ['before', 2], true, [], 0]);
  });

  test('turning the wheel with the primary modifier over the zoom buttons zooms the diagram they are shown for', async ({ page }) => {
    await openDiagramEditor(page, SMALL_BODY);
    await waitForMark(page);
    const usual = await readImageWidth(page);

    // A key press hides the buttons, so the modifier is held before the pointer brings them up. The pointer rests on
    // Reset Zoom, so that a click by mistake would not pass for the zoom.
    await page.keyboard.down('ControlOrMeta');
    await hoverDiagram(page);
    await page.locator(RESET).hover();
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('ControlOrMeta');

    await expect.poll(() => readImageWidth(page)).toBe(usual * 1.25);
  });
});

test.describe('Scroll bar of a zoomed diagram', () => {
  test('pressing the scroll bar of a zoomed diagram opens no dialog', async ({ page }) => {
    await openDiagramEditor(page, WIDE_BODY);
    await waitForMark(page);
    await hoverDiagram(page);
    await page.locator(ZOOM_IN).click();
    const bar = await page.locator(DIAGRAM).evaluate((block) => {
      const rect = block.getBoundingClientRect();
      return {
        x: rect.left + 40,
        y: rect.top + block.clientHeight + (rect.height - block.clientHeight) / 2,
        height: rect.height - block.clientHeight,
      };
    });

    await page.mouse.click(bar.x, bar.y);

    expect([bar.height > 0, await page.locator(DIALOG).count()]).toEqual([true, 0]);
  });
});
