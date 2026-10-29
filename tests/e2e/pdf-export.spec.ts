import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  DOCUMENT_APPLY_KIND,
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  PDF_EXPORT_REFUSAL,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import type { PdfPageImage, PdfTextRun } from '../../common/index';
import { PDF_FONT_FAMILIES } from '../../webview/export/pdf-fonts';
import { openEditor, readBodyHtml } from './helpers/editing';
import { getOutboundMessages, openProductionWebviewHost, sendToWebview } from './helpers/page';
import { readPdfExportFonts } from './helpers/pdf-fonts';

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
 * Injects a request PDF export message as though it arrived from the host, with the bundled fonts.
 *
 * @param page The page to operate on.
 * @param requestId The request id.
 */
async function requestPdfExport(page: Page, requestId: string): Promise<void> {
  await sendToWebview(page, {
    type: HOST_TO_VIEW_MESSAGE_TYPE.requestPdfExport,
    requestId,
    fonts: readPdfExportFonts(),
  });
}

/**
 * Measures the layout of the PDF through the probe, with the bundled fonts.
 *
 * @param page The page to operate on.
 */
async function measureLayout(page: Page): ReturnType<NonNullable<Window['__pdfLayoutProbe']>> {
  return page.evaluate((fonts) => window.__pdfLayoutProbe?.(fonts), readPdfExportFonts());
}

/**
 * Returns the characters of the runs of text of one role, joined in order.
 *
 * @param runs The runs of a page.
 * @param role The role.
 */
function joinText(runs: readonly PdfTextRun[], role: PdfTextRun['role']): string {
  return runs.filter((run) => run.role === role).map((run) => run.text).join(' ');
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
 * Returns, for each page image, the brightness of its darkest pixel and how many of its pixels are dark.
 *
 * @param page The page to decode the images in.
 * @param images The page images.
 */
async function readInk(page: Page, images: readonly PdfPageImage[]): Promise<{ darkest: number; dark: number }[]> {
  const urls = images.map(toDataUrl);
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
 * Mounts a body in a new page and returns the ink of each page image it is drawn on and the text of each page.
 *
 * @param page Any page of the browser context; a new page is opened next to it.
 * @param body The body to mount.
 */
async function readExported(
  page: Page,
  body: string,
): Promise<{ ink: { darkest: number; dark: number }[]; text: (readonly PdfTextRun[])[] }> {
  const other = await page.context().newPage();
  await openEditor(other, body);
  const images = await exportPages(other) ?? [];
  const ink = await readInk(other, images);
  await other.close();
  return { ink, text: images.map((image) => image.text) };
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

    const layout = await measureLayout(page);

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

  test('draws a closed section with a body the same as the section without the body, in the image and in the text', async ({ page }) => {
    const withBody = await readExported(
      page,
      '<details><summary>Title</summary><p>Hidden body</p></details><details open><summary>Next</summary></details>',
    );
    const without = await readExported(
      page,
      '<details><summary>Title</summary></details><details open><summary>Next</summary></details>',
    );

    expect(withBody).toEqual(without);
  });

  test('draws the annotated text of human, agent and resolved comments the same as plain text, in the image and in the text', async ({ page }) => {
    const entry = (author: string): string => `<comment-body data-author="${author}" `
      + 'data-updated="2026-01-01T00:00:00.000Z">Note</comment-body>';
    const withComments = await readExported(
      page,
      `<p>a<comment id="h">bc${entry('human')}</comment>d<comment id="a">ef${entry('ai')}</comment>`
        + `g<comment id="r" data-resolved="">hi${entry('ai')}</comment>j</p>`,
    );
    // Spans split the text at the same places, so only the look of the comments can tell the two apart.
    const plain = await readExported(page, '<p>a<span>bc</span>d<span>ef</span>g<span>hi</span>j</p>');

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

  test('covers the text of a link with its area', async ({ page }) => {
    await openEditor(page, '<p><a href="https://example.com/">Link text</a></p>');

    const [first] = await exportPages(page) ?? [];

    const link = first?.links[0];
    const run = first?.text[0];
    // In the pixels of the image, with a pixel to spare.
    const left = (link?.x ?? 0) - 1;
    const right = (link?.x ?? 0) + (link?.width ?? 0) + 1;
    const top = (link?.y ?? 0) - 1;
    const bottom = (link?.y ?? 0) + (link?.height ?? 0) + 1;
    expect([
      run?.text,
      run?.xs.every((x) => x >= left && x < right),
      (run?.top ?? top - 1) >= top && (run?.top ?? 0) + (run?.size ?? 0) <= bottom,
    ]).toEqual(['Link text', true, true]);
  });

  test('sets dark text even when the view has the values and classes of a dark theme', async ({ page }) => {
    await openEditor(page, '<h1>Heading</h1><p>Text</p>');
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--vscode-editor-background', '#1e1e1e');
      document.documentElement.style.setProperty('--vscode-editor-foreground', '#d4d4d4');
      document.body.classList.add('vscode-dark');
    });

    const [first] = await exportPages(page) ?? [];

    // The light text of the dark theme is never darker than its color, about 212.
    expect([
      first?.text.length,
      first?.text.every((run) => Math.max(...run.color) < 100),
    ]).toEqual([2, true]);
  });

  test('draws the marker of a collapsible section dark even when the view has the values and classes of a dark theme', async ({ page }) => {
    // The summary is empty, so the marker, drawn as a pseudo element, is the only ink on the page.
    await openEditor(page, '<details><summary></summary></details>');
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--vscode-editor-foreground', '#d4d4d4');
      document.body.classList.add('vscode-dark');
    });

    const [ink] = await readInk(page, await exportPages(page) ?? []);

    expect(ink.darkest).toBeLessThan(100);
  });

  test('makes room for a diagram when it decides where the pages start', async ({ page }) => {
    await openEditor(page, '<pre class="mermaid">graph TD; A--&gt;B; B--&gt;C; C--&gt;D</pre>\n<p>After</p>');
    const withDiagram = await measureLayout(page);
    await page.evaluate(() => {
      document.querySelector('pre')?.remove();
    });

    const withoutDiagram = await measureLayout(page);

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

  test('exports a styled document with a diagram, an alert, a section and an image under the content security policy of the panel, with its text in the bundled fonts, even when the copy cannot load the stylesheet', async ({ page }) => {
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

    expect([
      pages === null,
      await countRedPixels(page, toDataUrl(pages?.[0])) > 0,
      (pages?.[0].text.length ?? 0) > 0,
    ]).toEqual([false, true, true]);
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

  test('sets a heading, a paragraph and a table cell in the body font and a code block in the code font, leaving no dark ink of them in the image', async ({ page }) => {
    await openEditor(
      page,
      '<h1>Heading</h1><p>Paragraph 段落</p><table><tr><td>Cell</td></tr></table><pre>code()</pre>',
    );

    const [first] = await exportPages(page) ?? [];
    const [ink] = await readInk(page, first === undefined ? [] : [first]);

    expect([joinText(first?.text ?? [], 'sans'), joinText(first?.text ?? [], 'mono'), ink.dark]).toEqual([
      'Heading Paragraph 段落 Cell',
      'code()',
      0,
    ]);
  });

  test('keeps א, which the bundled fonts lack, in the image and out of the text', async ({ page }) => {
    await openEditor(page, '<p>א</p>');

    const [first] = await exportPages(page) ?? [];
    const [ink] = await readInk(page, first === undefined ? [] : [first]);

    expect([first?.text, ink.dark > 0]).toEqual([[], true]);
  });

  test('marks bold and italic text and keeps the color of colored text', async ({ page }) => {
    await openEditor(page, '<p><strong>Bold</strong> <em>Italic</em> <span style="color: #ff0000">Red</span></p>');

    const [first] = await exportPages(page) ?? [];

    const run = (text: string): PdfTextRun | undefined => first?.text.find((candidate) => candidate.text === text);
    expect([
      [run('Bold')?.bold, run('Bold')?.italic],
      [run('Italic')?.bold, run('Italic')?.italic],
      run('Red')?.color,
    ]).toEqual([[true, false], [false, true], [255, 0, 0]]);
  });

  test('sets only the part of a code line its block shows, so a line that overflows a table cell stays out of the next cell', async ({ page }) => {
    // A line far wider than the page, in a cell next to a narrow one.
    const line = `const total = ${Array.from({ length: 30 }, (_, index) => `part${String(index)}`).join(' + ')};`;
    await openEditor(page, `<table><tr><td><pre>${line}</pre></td><td>Next</td></tr></table>`);

    const [first] = await exportPages(page) ?? [];

    const runs = first?.text ?? [];
    const next = Math.min(...runs.filter((run) => run.role === 'sans').map((run) => run.xs[0] ?? 0));
    const code = runs.filter((run) => run.role === 'mono');
    expect([
      joinText(runs, 'mono').startsWith('const total'),
      code.every((run) => run.xs.every((x) => x < next)),
    ]).toEqual([true, true]);
  });

  test('keeps a code line in a table cell on one line when editing has left its text in two nodes', async ({ page }) => {
    await openEditor(page, '<table><tr><td><pre>first second</pre></td></tr></table>');
    await page.evaluate((rootId) => {
      const text = document.getElementById(rootId)?.querySelector('pre')?.firstChild;
      if (text instanceof Text) {
        text.splitText('first '.length);
      }
    }, EDITOR_ROOT_ELEMENT_ID);

    const [first] = await exportPages(page) ?? [];

    expect(first?.text.filter((run) => run.role === 'mono').map((run) => run.text)).toEqual(['first second']);
  });

  test('keeps a character that combines with the next into one glyph in the image and out of the text', async ({ page }) => {
    // The hiragana ka followed by a combining voiced sound mark, which the layout draws as one glyph.
    await openEditor(page, '<p>がき</p>');

    const [first] = await exportPages(page) ?? [];
    const [ink] = await readInk(page, first === undefined ? [] : [first]);

    expect([joinText(first?.text ?? [], 'sans'), ink.dark > 0]).toEqual(['き', true]);
  });

  test('keeps text in a color the PDF cannot draw as shown in the image and out of the text', async ({ page }) => {
    // The first color is red written in another color space, and the second is a transparent red.
    await openEditor(
      page,
      '<p><span style="color: oklch(0.628 0.2577 29.23)">Wide</span> <span style="color: rgb(255 0 0 / 50%)">Faint</span>'
        + ' Plain</p>',
    );

    const [first] = await exportPages(page) ?? [];

    expect([
      joinText(first?.text ?? [], 'sans').trim(),
      await countRedPixels(page, toDataUrl(first)) > 0,
    ]).toEqual(['Plain', true]);
  });

  test('keeps text that a style shows fainter, transformed or in another case in the image and out of the text', async ({ page }) => {
    // The last paragraph is faint through its block, an ancestor above the element that holds the text.
    await openEditor(
      page,
      '<p><span style="opacity: 0.5">Faint</span> <span style="display: inline-block; transform: rotate(-10deg)">Turned</span>'
        + ' <span style="text-transform: uppercase">loud</span> Plain</p>'
        + '<blockquote style="opacity: 0.5"><p>Nested</p></blockquote>',
    );

    const [first] = await exportPages(page) ?? [];
    const [ink] = await readInk(page, first === undefined ? [] : [first]);

    expect([joinText(first?.text ?? [], 'sans').trim(), ink.dark > 0]).toEqual(['Plain', true]);
  });

  test('keeps text with a shadow, an outline, another fill color or small capitals, or under a filter or a clip path, in the image and out of the text', async ({ page }) => {
    await openEditor(
      page,
      '<p><span style="text-shadow: 2px 2px 0 red">Shadow</span> <span style="-webkit-text-stroke: 1px red">Outline</span>'
        + ' <span style="-webkit-text-fill-color: red">Fill</span> <span style="font-variant-caps: small-caps">caps</span>'
        + ' Plain</p><div style="filter: grayscale(1)"><p>Gray</p></div><p style="clip-path: inset(0 30% 0 0)">Clipped</p>',
    );

    const [first] = await exportPages(page) ?? [];
    const [ink] = await readInk(page, first === undefined ? [] : [first]);

    expect([
      joinText(first?.text ?? [], 'sans').trim(),
      ink.dark > 0,
      await countRedPixels(page, toDataUrl(first)) > 0,
    ]).toEqual(['Plain', true, true]);
  });

  test('keeps text under a blend mode, a mask or a reflection, or in vertical lines, in the image and out of the text', async ({ page }) => {
    await openEditor(
      page,
      '<div style="mix-blend-mode: multiply"><p>Blend</p></div>'
        + '<div style="mask-image: linear-gradient(black, black)"><p>Masked</p></div>'
        + '<div style="-webkit-box-reflect: below"><p>Mirror</p></div>'
        + '<p style="writing-mode: vertical-rl">Tall</p><p>Plain</p>',
    );

    const [first] = await exportPages(page) ?? [];
    const [ink] = await readInk(page, first === undefined ? [] : [first]);

    expect([joinText(first?.text ?? [], 'sans').trim(), ink.dark > 0]).toEqual(['Plain', true]);
  });

  test('keeps text with emphasis marks in the image and out of the text', async ({ page }) => {
    await openEditor(page, '<p><span style="text-emphasis: filled dot">Dots</span> Plain</p>');

    const [first] = await exportPages(page) ?? [];
    const [ink] = await readInk(page, first === undefined ? [] : [first]);

    expect([joinText(first?.text ?? [], 'sans').trim(), ink.dark > 0]).toEqual(['Plain', true]);
  });

  test('keeps text an ellipsis or a line clamp cuts short in the image and out of the text', async ({ page }) => {
    await openEditor(
      page,
      '<p style="width: 200px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis">'
        + 'abcdefghijklmnopqrstuvwxyz0123456789</p>'
        + '<p style="width: 200px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden">'
        + 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn</p>'
        + '<p>Plain</p>',
    );

    const [first] = await exportPages(page) ?? [];
    const [ink] = await readInk(page, first === undefined ? [] : [first]);

    expect([joinText(first?.text ?? [], 'sans').trim(), ink.dark > 0]).toEqual(['Plain', true]);
  });

  test('sets text as text in a browser that lacks one of the styles it checks, as Firefox lacks the reflection', async ({ page }) => {
    await openEditor(page, '<p>Plain</p>');
    // A browser gives an empty value for a property it lacks. The copies are laid out in frames of their own, so each
    // frame reads the reflection as empty from the moment it is added.
    await page.evaluate(() => {
      new MutationObserver((records) => {
        for (const node of records.flatMap((record) => [...record.addedNodes])) {
          const view = node instanceof HTMLIFrameElement ? node.contentWindow : null;
          if (view === null) {
            continue;
          }
          const compute = view.getComputedStyle.bind(view);
          view.getComputedStyle = (element: Element, pseudo?: string | null): CSSStyleDeclaration => {
            const style = compute(element, pseudo);
            const read = style.getPropertyValue.bind(style);
            style.getPropertyValue = (name: string): string => (name === '-webkit-box-reflect' ? '' : read(name));
            return style;
          };
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    });

    const [first] = await exportPages(page) ?? [];

    expect(joinText(first?.text ?? [], 'sans')).toBe('Plain');
  });

  test('adds the bundled fonts to the view while it draws the pages and takes them out before it responds', async ({ page }) => {
    await openEditor(page, '<p>a</p>');
    await page.evaluate(() => {
      const added: string[] = [];
      Reflect.set(window, '__addedFontFamilies', added);
      const add = document.fonts.add.bind(document.fonts);
      document.fonts.add = (face) => {
        added.push(face.family);
        return add(face);
      };
    });

    await exportPages(page);
    const added: unknown = await page.evaluate(() => Reflect.get(window, '__addedFontFamilies'));
    const left = await page.evaluate(() => Array.from(document.fonts, (face) => face.family));

    const families = [PDF_FONT_FAMILIES.sans, PDF_FONT_FAMILIES.mono];
    expect([added, left.filter((family) => families.includes(family))]).toEqual([families, []]);
  });

  test('responds that it cannot create the PDF when the request carries no fonts, and lets the editing go on', async ({ page }) => {
    await openEditor(page, '<p>a</p>');

    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestPdfExport, requestId: '1', fonts: [] });
    await expect.poll(() => readResponses(page), { timeout: RESPONSE_TIMEOUT_MS }).toHaveLength(1);
    const [response] = await readResponses(page);
    const editable = await page.evaluate((rootId) => document.getElementById(rootId)?.contentEditable, EDITOR_ROOT_ELEMENT_ID);

    expect([Reflect.get(response, 'pages'), editable]).toEqual([null, 'true']);
  });
});
