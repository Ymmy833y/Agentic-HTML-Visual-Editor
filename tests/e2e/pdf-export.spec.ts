import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  DOCUMENT_APPLY_KIND,
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  PDF_EXPORT_REFUSAL,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import type { PdfPageImage } from '../../common/index';
import { openEditor, readBodyHtml } from './helpers/editing';
import { getOutboundMessages, openProductionWebviewHost, sendToWebview } from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

// Forty paragraphs fill more than one A4 page at the width of the page.
const LONG_BODY = Array.from(
  { length: 40 },
  (_, index) => `<p>Paragraph ${String(index)} with enough ordinary text in it to take up a line or two of the page.</p>`,
).join('\n');

// Text long enough to fill several pages if it were drawn.
const HIDDEN_TEXT = 'Hidden text that must not reach the PDF. '.repeat(400);

// A document of a few thousand paragraphs, one per line as an agent writes them.
const LARGE_BODY = Array.from(
  { length: 3000 },
  (_, index) => `<p>Paragraph ${String(index)} with some ordinary text in it.</p>`,
).join('\n');

// A diagram, an alert, a collapsible section and an embedded image: the parts drawn with pseudo elements, constructed
// stylesheets and images. The caution alert has a red border only when the document's stylesheet is applied.
const RICH_BODY = [
  '<pre class="mermaid">graph TD; A--&gt;B</pre>',
  '<blockquote data-alert="caution"><p>Caution</p></blockquote>',
  '<details open><summary>Title</summary><p>Body</p></details>',
  '<p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" alt=""></p>',
].join('\n');

// How long a whole export may take before the host gives up.
const EXPORT_TIMEOUT_MS = 120000;

// How long a test waits for the response to a request that draws a small document.
const RESPONSE_TIMEOUT_MS = 30000;

/**
 * Injects a request PDF export message as though it arrived from the host.
 *
 * @param page The page to operate on.
 * @param requestId The request id.
 */
async function requestPdfExport(page: Page, requestId: string): Promise<void> {
  await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestPdfExport, requestId });
}

/**
 * Returns the PDF export responses sent to the host, in the order sent.
 *
 * @param page The page to operate on.
 */
async function readResponses(page: Page): Promise<object[]> {
  return (await getOutboundMessages(page)).filter((message): message is object => (
    typeof message === 'object' && message !== null
      && Reflect.get(message, 'type') === VIEW_TO_HOST_MESSAGE_TYPE.pdfExportResponse
  ));
}

/**
 * Requests an export and returns the page images of the response.
 *
 * @param page The page to operate on.
 * @param timeout How long to wait for the response.
 * @returns The page images, or `null` when the view responded that it cannot create them.
 */
async function exportPages(page: Page, timeout = RESPONSE_TIMEOUT_MS): Promise<PdfPageImage[] | null> {
  await requestPdfExport(page, '1');
  await expect.poll(() => readResponses(page), { timeout }).toHaveLength(1);
  const pages: unknown = Reflect.get((await readResponses(page))[0], 'pages');
  return Array.isArray(pages) ? pages : null;
}

/**
 * Returns a page image as a data URL, for the page to decode.
 *
 * @param image The page image.
 */
function toDataUrl(image: PdfPageImage | undefined): string {
  return `data:image/jpeg;base64,${image?.jpeg ?? ''}`;
}

/**
 * Counts the clearly red pixels of an image.
 *
 * @param page The page to decode the image in.
 * @param url The data URL of the image.
 */
async function countRedPixels(page: Page, url: string): Promise<number> {
  return page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context?.drawImage(image, 0, 0);
    const data = context?.getImageData(0, 0, image.width, image.height).data ?? new Uint8ClampedArray();
    let red = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] > 200 && data[index + 1] < 120 && data[index + 2] < 120) {
        red += 1;
      }
    }
    return red;
  }, url);
}

/**
 * Counts the pixels of an image that are not white, inside and outside a rectangle.
 *
 * @param page The page to decode the image in.
 * @param url The data URL of the image.
 * @param rect The rectangle in the pixels of the image: left, top, right and bottom.
 */
async function countInk(
  page: Page,
  url: string,
  rect: readonly [number, number, number, number],
): Promise<{ inside: number; outside: number }> {
  return page.evaluate(async ([source, [left, top, right, bottom]]) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context?.drawImage(image, 0, 0);
    const data = context?.getImageData(0, 0, image.width, image.height).data ?? new Uint8ClampedArray();
    let inside = 0;
    let outside = 0;
    for (let index = 0; index < data.length; index += 4) {
      // JPEG leaves faint noise around text, so only clearly coloured pixels count.
      if (Math.min(data[index], data[index + 1], data[index + 2]) < 200) {
        const x = (index / 4) % image.width;
        const y = Math.floor(index / 4 / image.width);
        if (x >= left && x < right && y >= top && y < bottom) {
          inside += 1;
        } else {
          outside += 1;
        }
      }
    }
    return { inside, outside };
  }, [url, rect] as const);
}

/**
 * Exports the pages and returns, for each page, the brightness of its darkest pixel and how many of its pixels are dark.
 *
 * @param page The page to operate on.
 */
async function readPageInk(page: Page): Promise<{ darkest: number; dark: number }[]> {
  const urls = (await exportPages(page) ?? []).map(toDataUrl);
  return page.evaluate(async (pages) => {
    return Promise.all(pages.map(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      context?.drawImage(image, 0, 0);
      const data = context?.getImageData(0, 0, image.width, image.height).data ?? new Uint8ClampedArray();
      let darkest = 255;
      let dark = 0;
      for (let index = 0; index < data.length; index += 4) {
        const brightness = (data[index] + data[index + 1] + data[index + 2]) / 3;
        darkest = Math.min(darkest, brightness);
        if (brightness < 128) {
          dark += 1;
        }
      }
      return { darkest, dark };
    }));
  }, urls);
}

/**
 * Mounts a body in a new page and returns the ink of each page it is drawn on.
 *
 * @param page Any page of the browser context; a new page is opened next to it.
 * @param body The body to mount.
 */
async function readExportedInk(page: Page, body: string): Promise<{ darkest: number; dark: number }[]> {
  const other = await page.context().newPage();
  await openEditor(other, body);
  const ink = await readPageInk(other);
  await other.close();
  return ink;
}

/**
 * Mounts a body in a new page and returns the number of pages its PDF has.
 *
 * @param page Any page of the browser context; a new page is opened next to it.
 * @param body The body to mount.
 */
async function countExportedPages(page: Page, body: string): Promise<number> {
  const other = await page.context().newPage();
  await openEditor(other, body);
  const count = (await exportPages(other))?.length ?? 0;
  await other.close();
  return count;
}

test.describe('the PDF export', () => {
  test('answers the request with JPEG page images twice as wide as the page is laid out', async ({ page }) => {
    await openEditor(page, '<p>a</p>');

    const pages = await exportPages(page);

    // A JPEG file starts with the bytes FF D8 FF, which base64 writes as /9j/.
    expect([pages?.length, pages?.[0].width, pages?.[0].jpeg.startsWith('/9j/')]).toEqual([1, 1360, true]);
  });

  test('puts a document taller than one page on two pages or more', async ({ page }) => {
    await openEditor(page, LONG_BODY);

    const pages = await exportPages(page);

    expect(pages?.length).toBeGreaterThanOrEqual(2);
  });

  test('starts every page after the first at the bottom of a block, once laid out at the width of the page', async ({ page }) => {
    await openEditor(page, LONG_BODY);

    const layout = await page.evaluate(() => window.__pdfLayoutProbe?.());

    expect([
      (layout?.starts.length ?? 0) >= 2,
      layout?.starts.slice(1).every((start) => layout.bottoms.includes(start)),
    ]).toEqual([true, true]);
  });

  test('gives a document with a comment whose body would fill pages as many pages as the same document without it', async ({ page }) => {
    const withComment = await countExportedPages(
      page,
      `<p>a<comment id="c">b<comment-body>${HIDDEN_TEXT}</comment-body></comment>c</p>`,
    );
    const without = await countExportedPages(page, '<p>a<comment id="c">b</comment>c</p>');

    expect(withComment).toBe(without);
  });

  test('draws a closed section with a body the same as the section without the body', async ({ page }) => {
    const withBody = await readExportedInk(
      page,
      '<details><summary>Title</summary><p>Hidden body</p></details><details open><summary>Next</summary></details>',
    );
    const without = await readExportedInk(
      page,
      '<details><summary>Title</summary></details><details open><summary>Next</summary></details>',
    );

    expect(withBody).toEqual(without);
  });

  test('draws the annotated text of human, agent and resolved comments the same as plain text', async ({ page }) => {
    const entry = (author: string): string => `<comment-body data-author="${author}" `
      + 'data-updated="2026-01-01T00:00:00.000Z">Note</comment-body>';
    const withComments = await readExportedInk(
      page,
      `<p>a<comment id="h">bc${entry('human')}</comment>d<comment id="a">ef${entry('ai')}</comment>`
        + `g<comment id="r" data-resolved="">hi${entry('ai')}</comment>j</p>`,
    );
    // Spans split the text at the same places, so only the look of the comments can tell the two apart.
    const plain = await readExportedInk(page, '<p>a<span>bc</span>d<span>ef</span>g<span>hi</span>j</p>');

    expect(withComments).toEqual(plain);
  });

  for (const [kind, body] of [
    ['an insertion mark', '<p>a<ins data-author="ai">b</ins></p>'],
    ['a deletion mark', '<p>a<del data-author="ai">b</del></p>'],
    ['an element mark', '<p data-change="ins" data-author="ai">a</p>'],
  ] as const) {
    test(`declines for change marks without a PDF, and without stopping the editing, when ${kind} is left`, async ({ page }) => {
      await openEditor(page, body);
      await page.evaluate((rootId) => {
        const root = document.getElementById(rootId);
        const values: string[] = [];
        Reflect.set(window, '__editableValues', values);
        if (root !== null) {
          new MutationObserver(() => values.push(root.contentEditable))
            .observe(root, { attributes: true, attributeFilter: ['contenteditable'] });
        }
      }, EDITOR_ROOT_ELEMENT_ID);

      await requestPdfExport(page, '1');
      await expect.poll(() => readResponses(page)).toHaveLength(1);
      const [response] = await readResponses(page);

      expect([
        Reflect.get(response, 'pages'),
        Reflect.get(response, 'refusal'),
        await page.evaluate(() => Reflect.get(window, '__editableValues')),
      ]).toEqual([null, PDF_EXPORT_REFUSAL.changeMarks, []]);
    });
  }

  test('carries web, relative and root-relative links as written and leads a link inside the document to the page of its target', async ({ page }) => {
    await openEditor(
      page,
      '<p><a href="https://example.com/a">Web</a> <a href="notes/plan.html">Notes</a>'
        + ' <a href=" /index.html ">Index</a> <a href="#goal">Goal</a></p>'
        + `\n${LONG_BODY}\n<h2 id="goal">Goal</h2>`,
    );

    const pages = await exportPages(page);

    const last = (pages?.length ?? 0) - 1;
    expect([last >= 1, pages?.[0].links.map((link) => link.target)]).toEqual([
      true,
      [
        { kind: 'href', href: 'https://example.com/a' },
        { kind: 'href', href: 'notes/plan.html' },
        { kind: 'href', href: '/index.html' },
        { kind: 'page', pageIndex: last, y: expect.any(Number) },
      ],
    ]);
  });

  test('puts a link below the first page only on the page the link is on', async ({ page }) => {
    await openEditor(page, `${LONG_BODY}\n<p><a href="https://example.com/late">Late</a></p>`);

    const pages = await exportPages(page) ?? [];

    expect([
      pages.length >= 2,
      pages.slice(0, -1).flatMap((image) => image.links),
      pages.at(-1)?.links.map((link) => link.target),
    ]).toEqual([true, [], [{ kind: 'href', href: 'https://example.com/late' }]]);
  });

  test('covers the drawn text of a link with its area', async ({ page }) => {
    await openEditor(page, '<p><a href="https://example.com/">Link text</a></p>');

    const [first] = await exportPages(page) ?? [];

    const link = first?.links[0];
    const left = link?.x ?? 0;
    const top = link?.y ?? 0;
    // In the pixels of the image, with a pixel to spare.
    const ink = await countInk(page, toDataUrl(first), [
      left - 1,
      top - 1,
      left + (link?.width ?? 0) + 1,
      top + (link?.height ?? 0) + 1,
    ]);

    expect([ink.inside > 0, ink.outside]).toEqual([true, 0]);
  });

  test('draws dark text on a white page even when the view has the values and classes of a dark theme', async ({ page }) => {
    await openEditor(page, '<h1>Heading</h1><p>Text</p>');
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--vscode-editor-background', '#1e1e1e');
      document.documentElement.style.setProperty('--vscode-editor-foreground', '#d4d4d4');
      document.body.classList.add('vscode-dark');
    });

    const [ink] = await readPageInk(page);

    // The light text of the dark theme is never darker than its color, about 212.
    expect([ink.darkest < 100, ink.dark > 0]).toEqual([true, true]);
  });

  test('draws the marker of a collapsible section dark even when the view has the values and classes of a dark theme', async ({ page }) => {
    // The summary is empty, so the marker, drawn as a pseudo element, is the only ink on the page.
    await openEditor(page, '<details><summary></summary></details>');
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--vscode-editor-foreground', '#d4d4d4');
      document.body.classList.add('vscode-dark');
    });

    const [ink] = await readPageInk(page);

    expect(ink.darkest).toBeLessThan(100);
  });

  test('makes room for a diagram when it decides where the pages start', async ({ page }) => {
    await openEditor(page, '<pre class="mermaid">graph TD; A--&gt;B; B--&gt;C; C--&gt;D</pre>\n<p>After</p>');
    const withDiagram = await page.evaluate(() => window.__pdfLayoutProbe?.());
    await page.evaluate(() => {
      document.querySelector('pre')?.remove();
    });

    const withoutDiagram = await page.evaluate(() => window.__pdfLayoutProbe?.());

    // The drawing of four boxes in a column is far taller than the margins of a block.
    expect((withDiagram?.total ?? 0) - (withoutDiagram?.total ?? 0)).toBeGreaterThan(100);
  });

  test('stops the editing while it draws and lets it go on once the response is sent', async ({ page }) => {
    await openEditor(page, '<p>a</p>');
    await page.evaluate((rootId) => {
      const root = document.getElementById(rootId);
      const values: string[] = [];
      Reflect.set(window, '__editableValues', values);
      if (root !== null) {
        new MutationObserver(() => values.push(root.contentEditable))
          .observe(root, { attributes: true, attributeFilter: ['contenteditable'] });
      }
    }, EDITOR_ROOT_ELEMENT_ID);

    await exportPages(page);
    const values: unknown = await page.evaluate(() => Reflect.get(window, '__editableValues'));

    expect(values).toEqual(['false', 'true']);
  });

  test('responds that it cannot create the PDF when the document is replaced while it draws', async ({ page }) => {
    await openEditor(page, LONG_BODY);

    await requestPdfExport(page, '1');
    // A change on disk is taken in while the pages are drawn, because stopping the editing does not stop the host.
    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument,
      requestId: 'external',
      kind: DOCUMENT_APPLY_KIND.externalChange,
      text: `${PROLOGUE}<p>Replaced</p>${EPILOGUE}`,
    });
    await expect.poll(() => readResponses(page), { timeout: RESPONSE_TIMEOUT_MS }).toHaveLength(1);
    const [response] = await readResponses(page);

    expect([await readBodyHtml(page), Reflect.get(response, 'pages')]).toEqual(['<p>Replaced</p>', null]);
  });

  test('exports a styled document with a diagram, an alert, a section and an image under the content security policy of the panel, even when the copy cannot load the stylesheet', async ({ page }) => {
    await openProductionWebviewHost(page);
    // In VS Code the frame html2canvas-pro copies the document into is not served by the webview's service worker, so
    // the stylesheet link loads nothing there. Only the page itself gets the stylesheet here, as in VS Code.
    await page.route('**/dist/webview.css', (route) => (route.request().frame() === page.mainFrame()
      ? route.fallback()
      : route.fulfill({ status: 404, body: '' })));
    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
      text: `${PROLOGUE}${RICH_BODY}${EPILOGUE}`,
      documentUri: '',
      resourceRootUri: '',
    });

    const pages = await exportPages(page);

    expect([pages === null, await countRedPixels(page, toDataUrl(pages?.[0])) > 0]).toEqual([false, true]);
  });

  test('exports a document of 3,000 paragraphs before the host gives up', async ({ page }) => {
    test.setTimeout(EXPORT_TIMEOUT_MS + 30000);
    await openEditor(page, LARGE_BODY);

    const pages = await exportPages(page, EXPORT_TIMEOUT_MS);

    expect(pages?.length).toBeGreaterThanOrEqual(2);
  });

  test('responds that it cannot create the PDF when no body is shown', async ({ page }) => {
    await openEditor(page, '\n<script>a</script>\n');

    const pages = await exportPages(page);

    expect(pages).toBeNull();
  });
});
