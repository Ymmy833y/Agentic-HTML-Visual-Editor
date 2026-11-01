import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  COMMENT_POPUP_MIN_WIDTH,
  COMMENT_POPUP_WIDTH_META_NAME,
  HOST_TO_VIEW_MESSAGE_TYPE,
  MESSAGE_CATALOG_ELEMENT_ID,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { COMMENT_POPUP_ELEMENT_ID } from '../../webview/ui/comment-popup';
import { COMMENT_POPUP_RESIZER_CLASS } from '../../webview/ui/comment-popup-resize';
import { EDITOR_ROOT } from './helpers/editing';
import { PROBE_BUNDLE_PATH, getOutboundMessages, openWebviewHost, sendToWebview } from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const POPUP = `#${COMMENT_POPUP_ELEMENT_ID}`;
const RESIZER = `${POPUP} > .${COMMENT_POPUP_RESIZER_CLASS}`;
const REPLY_FIELD = `${POPUP} textarea[aria-label="${englishMessages['commentThread.replyField']}"]`;
const EDIT_FIELD = `${POPUP} textarea[aria-label="${englishMessages['commentThread.editField']}"]`;

// Two comments near the left edge, so that a popup widened to the right is not pulled in from the right edge.
const TWO_COMMENTS = '<p><comment id="a">aa<comment-body data-author="human">one</comment-body></comment>'
  + ' and <comment id="b">bb<comment-body data-author="human">two</comment-body></comment></p>';

// A comment whose replies make the popup taller than the room it is given, so that its thread scrolls inside.
const LONG_THREAD = `<p><comment id="a">aa<comment-body data-author="human">one</comment-body>${
  '<comment-reply data-author="human">reply</comment-reply>'.repeat(40)}</comment></p>`;

/**
 * Embeds the English message catalog and the width the host would hand on, and then mounts the body.
 *
 * @param page The page to operate on.
 * @param body The body to mount.
 * @param width The width to embed, or `undefined` to embed none, as before the user first resizes.
 */
async function openCommentEditor(page: Page, body: string, width?: number): Promise<void> {
  await openWebviewHost(page, PROBE_BUNDLE_PATH);
  await page.evaluate((argument) => {
    const element = document.createElement('script');
    element.type = 'application/json';
    element.id = argument.elementId;
    element.textContent = argument.catalog;
    document.head.append(element);
    if (argument.width !== undefined) {
      const meta = document.createElement('meta');
      meta.name = argument.metaName;
      meta.content = argument.width;
      document.head.append(meta);
    }
  }, {
    elementId: MESSAGE_CATALOG_ELEMENT_ID,
    catalog: JSON.stringify(englishMessages),
    metaName: COMMENT_POPUP_WIDTH_META_NAME,
    width: width === undefined ? undefined : String(width),
  });
  await sendToWebview(page, {
    type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
    text: `${PROLOGUE}${body}${EPILOGUE}`,
    documentUri: '',
    resourceRootUri: '',
  });
}

/**
 * Clicks the annotated text of a comment to open its popup.
 *
 * @param page The page to operate on.
 * @param id The ID of the comment.
 */
async function openComment(page: Page, id: string): Promise<void> {
  await page.locator(`${EDITOR_ROOT} comment#${id}`).click({ position: { x: 2, y: 5 } });
  await expect(page.locator(POPUP)).toBeVisible();
}

/**
 * Drags the popup's resize strip horizontally with the primary button, through each distance in turn.
 *
 * @param page The page to operate on.
 * @param distances How far from the press to move to, in pixels, one after another. Negative is left of the press.
 */
async function dragPopupEdge(page: Page, ...distances: number[]): Promise<void> {
  const box = await page.locator(RESIZER).boundingBox();
  if (box === null) {
    throw new Error('the resize strip is not drawn');
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (const distance of distances) {
    await page.mouse.move(x + distance, y, { steps: 5 });
  }
  await page.mouse.up();
}

/**
 * Reads the drawn width of the popup.
 *
 * @param page The page to operate on.
 */
async function readPopupWidth(page: Page): Promise<number> {
  return page.locator(POPUP).evaluate((element) => element.getBoundingClientRect().width);
}

/**
 * Reads the widths sent to the host, in the order they were sent.
 *
 * @param page The page to operate on.
 */
async function readSentWidths(page: Page): Promise<unknown[]> {
  return (await getOutboundMessages(page))
    .map((message) => Object(message) as Record<string, unknown>)
    .filter((message) => message.type === VIEW_TO_HOST_MESSAGE_TYPE.commentPopupWidthChanged)
    .map((message) => message.width);
}

test.describe('Resizing the comment popup', () => {
  test('dragging the right edge widens the popup by the distance moved and hands the width to the host once on release', async ({ page }) => {
    await openCommentEditor(page, TWO_COMMENTS);
    await openComment(page, 'a');
    const before = await readPopupWidth(page);

    await dragPopupEdge(page, 100);

    expect([await readPopupWidth(page), await readSentWidths(page)]).toEqual([before + 100, [before + 100]]);
  });

  test('another comment opened after resizing opens at the same width', async ({ page }) => {
    await openCommentEditor(page, TWO_COMMENTS);
    await openComment(page, 'a');
    await dragPopupEdge(page, 80);
    const resized = await readPopupWidth(page);

    await openComment(page, 'b');

    expect(await readPopupWidth(page)).toBe(resized);
  });

  test('dragging stops at the narrowest width on the left and at the view less 1em on the right, inside the view', async ({ page }) => {
    await openCommentEditor(page, TWO_COMMENTS);
    await openComment(page, 'a');

    await dragPopupEdge(page, -1000);
    const narrowest = await readPopupWidth(page);
    await dragPopupEdge(page, 3000);

    const widest = await page.locator(POPUP).evaluate((element) => {
      const { width, right } = element.getBoundingClientRect();
      const em = Number.parseFloat(getComputedStyle(element).fontSize);
      return { width, expected: document.documentElement.clientWidth - em, inside: right <= document.documentElement.clientWidth };
    });
    expect([narrowest, Math.round(widest.width), widest.inside]).toEqual([
      COMMENT_POPUP_MIN_WIDTH,
      Math.round(widest.expected),
      true,
    ]);
  });

  test('pressing the edge and releasing without moving sideways keeps the width and hands nothing to the host', async ({ page }) => {
    await openCommentEditor(page, TWO_COMMENTS, 360);
    await openComment(page, 'a');

    await dragPopupEdge(page);

    expect([await readPopupWidth(page), await readSentWidths(page)]).toEqual([360, []]);
  });

  test('a press on the edge keeps the popup open and focus in the reply field, and opens no editing', async ({ page }) => {
    await openCommentEditor(page, TWO_COMMENTS);
    await openComment(page, 'a');
    await page.locator(REPLY_FIELD).focus();

    await page.locator(RESIZER).click();

    await expect(page.locator(POPUP)).toBeVisible();
    await expect(page.locator(REPLY_FIELD)).toBeFocused();
    await expect(page.locator(EDIT_FIELD)).toHaveCount(0);
  });

  test('the popup opens at the width the document carries, and at 30em when it carries none', async ({ page }) => {
    await openCommentEditor(page, TWO_COMMENTS, 420);
    await openComment(page, 'a');
    const embedded = await readPopupWidth(page);
    await openCommentEditor(page, TWO_COMMENTS);
    await openComment(page, 'a');

    const fallback = await page.locator(POPUP).evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      expected: Number.parseFloat(getComputedStyle(element).fontSize) * 30,
    }));
    expect([embedded, fallback.width]).toEqual([420, fallback.expected]);
  });

  test('after a long thread is scrolled to its end inside, the strip still runs along the visible right edge and resizes', async ({ page }) => {
    await openCommentEditor(page, LONG_THREAD);
    await openComment(page, 'a');
    await page.locator(POPUP).evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const before = await readPopupWidth(page);

    const placement = await page.evaluate(([popupSelector, resizerSelector]) => {
      const popup = document.querySelector(popupSelector);
      const resizer = document.querySelector(resizerSelector);
      if (popup === null || resizer === null) {
        throw new Error('the popup or its resize strip is missing');
      }
      const outer = popup.getBoundingClientRect();
      const strip = resizer.getBoundingClientRect();
      return {
        scrolled: popup.scrollTop > 0,
        top: Math.round(strip.top - outer.top - popup.clientTop),
        height: Math.round(strip.height),
        visible: popup.clientHeight,
      };
    }, [POPUP, RESIZER]);
    await dragPopupEdge(page, 50);

    expect([placement.scrolled, placement.top, placement.height, await readPopupWidth(page)]).toEqual([
      true,
      0,
      placement.visible,
      before + 50,
    ]);
  });
});
