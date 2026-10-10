import { CONTENT_HEIGHT_PT, CONTENT_WIDTH_PT } from '../../common/index';
import type { PdfPageImage } from '../../common/index';
import type { DiagramImage, DiagramResult } from '../diagram/diagram-render';
import { isDiagramSource, readDiagramSource } from '../diagram/diagram-source';
import { PDF_CONTENT_WIDTH_PX, preparePdfClone, stylePdfClone } from './pdf-clone';
import type { PdfCloneOptions } from './pdf-clone';
import { assignLinksToPages, collectLinkAreas } from './pdf-links';
import type { PdfLinkArea } from './pdf-links';
import { choosePageBreaks, collectBlockBottoms } from './pdf-page-breaks';

/** Height of one page in CSS pixels at the width the document is laid out at. */
export const PDF_PAGE_HEIGHT_PX = PDF_CONTENT_WIDTH_PX * (CONTENT_HEIGHT_PT / CONTENT_WIDTH_PT);

// Pixels per CSS pixel. Twice the screen density keeps small text legible when printed, at about 190 dots per inch.
const PDF_SCALE = 2;

// Tallest canvas drawn at once, in CSS pixels. Browsers refuse canvases above about 16,000 pixels on a side, so a long
// document is drawn a few pages at a time.
const MAX_CHUNK_HEIGHT_PX = Math.floor(16000 / PDF_SCALE);

// JPEG quality of the page images: high enough that text keeps clean edges.
const JPEG_QUALITY = 0.92;

/** The options of html2canvas-pro the export uses. */
export interface PdfCanvasOptions {
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  readonly windowWidth: number;
  readonly windowHeight: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly backgroundColor: string;
  readonly useCORS: boolean;
  readonly logging: boolean;
  readonly signal?: AbortSignal;
  readonly onclone: (document: Document, element: HTMLElement) => void;
}

/** Draws an element of the view onto a canvas, as html2canvas-pro does. */
export type PdfCanvasRenderer = (element: HTMLElement, options: PdfCanvasOptions) => Promise<HTMLCanvasElement>;

/** Ports for drawing the pages. */
export interface PdfPagePorts {
  /** Loads the renderer. */
  loadRenderer(): Promise<PdfCanvasRenderer>;

  /**
   * Draws a diagram source with the light theme.
   *
   * @param source The Mermaid source.
   * @returns The drawing, or a failure.
   */
  drawLightDiagram(source: string): Promise<DiagramResult>;
}

/** How the document falls into pages once laid out at the width of the page. */
export interface PdfLayout {
  /** The top edge of each page, starting with 0, in CSS pixels. */
  readonly starts: readonly number[];
  /** The height of the whole document in CSS pixels. */
  readonly total: number;
  /** The bottom edges of the block boxes the pages may end at. */
  readonly bottoms: readonly number[];
  /** The links of the document, measured from its top-left corner. */
  readonly links: readonly PdfLinkArea[];
}

/**
 * Loads html2canvas-pro.
 *
 * It is bundled into the view but imported dynamically, so that the library is evaluated only when a document is first
 * exported.
 *
 * @returns The renderer.
 */
export async function loadPdfCanvasRenderer(): Promise<PdfCanvasRenderer> {
  const loaded = await import('html2canvas-pro');
  return (element, options) => loaded.default(element, options);
}

/**
 * Lays the document out at the width of the page and decides where each page starts.
 *
 * The copy is measured and then dropped without being drawn, which costs one copy of the document.
 *
 * @param root The editor root.
 * @param ports Ports for drawing.
 * @returns The layout.
 */
export async function measurePdfLayout(root: HTMLElement, ports: PdfPagePorts): Promise<PdfLayout> {
  const renderer = await ports.loadRenderer();
  return measure(root, renderer, await readCloneOptions(root, ports));
}

/**
 * Draws the document as page images, each with the links on it.
 *
 * The layout is measured once and every copy after it is cut at the same page starts. The editing is stopped meanwhile,
 * but the host can still replace the document, so the caller checks that no replacement happened before using the
 * pages.
 *
 * @param root The editor root.
 * @param ports Ports for drawing.
 * @returns The pages in order.
 */
export async function renderPdfPages(root: HTMLElement, ports: PdfPagePorts): Promise<PdfPageImage[]> {
  const renderer = await ports.loadRenderer();
  const options = await readCloneOptions(root, ports);
  const layout = await measure(root, renderer, options);
  const links = assignLinksToPages(layout.links, layout.starts, layout.total, PDF_SCALE);

  const pages: PdfPageImage[] = [];
  let index = 0;
  while (index < layout.starts.length) {
    const top = layout.starts[index];
    const height = Math.max(1, Math.ceil(Math.min(MAX_CHUNK_HEIGHT_PX, layout.total - top)));
    const canvas = await renderer(root, {
      ...baseOptions(),
      y: top,
      height,
      onclone: (document, element) => prepareCopy(document, element, options),
    });
    // Every page fits in a chunk, because a page is never taller than the chunk.
    do {
      const start = layout.starts[index];
      const end = layout.starts[index + 1] ?? layout.total;
      if (end - top > height + 0.5) {
        break;
      }
      pages.push({ ...cutPage(root.ownerDocument, canvas, start - top, end - start), links: links[index] });
      index += 1;
    } while (index < layout.starts.length);
    // Hand the thread back between chunks, so the view still answers the host while a long document is drawn.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  return pages;
}

/**
 * Reads from the view what the copies need: the light drawings of the diagrams.
 *
 * @param root The editor root.
 * @param ports Ports for drawing.
 */
async function readCloneOptions(root: HTMLElement, ports: PdfPagePorts): Promise<PdfCloneOptions> {
  return { diagramImages: await drawLightDiagrams(root, ports) };
}

/**
 * Draws every diagram of the editor root with the light theme.
 *
 * @param root The editor root.
 * @param ports Ports for drawing.
 * @returns The drawings keyed by the position of their source block among the `pre` elements.
 */
async function drawLightDiagrams(root: HTMLElement, ports: PdfPagePorts): Promise<Map<number, DiagramImage>> {
  const images = new Map<number, DiagramImage>();
  const blocks = [...root.querySelectorAll('pre')];
  for (const [index, block] of blocks.entries()) {
    if (!isDiagramSource(block)) {
      continue;
    }
    const source = readDiagramSource(block);
    if (source.trim() === '') {
      continue;
    }
    const result = await ports.drawLightDiagram(source);
    if (result.kind === 'image') {
      images.set(index, result);
    }
  }
  return images;
}

/**
 * Lays out a copy at the width of the page and measures it, dropping the copy before it is drawn.
 *
 * @param root The editor root.
 * @param renderer The renderer.
 * @param options What the copies need from the view.
 */
async function measure(root: HTMLElement, renderer: PdfCanvasRenderer, options: PdfCloneOptions): Promise<PdfLayout> {
  const controller = new AbortController();
  let layout: PdfLayout | undefined;
  try {
    await renderer(root, {
      ...baseOptions(),
      y: 0,
      height: 1,
      signal: controller.signal,
      onclone: (document, element) => {
        prepareCopy(document, element, options);
        const total = element.getBoundingClientRect().height;
        const bottoms = collectBlockBottoms(element);
        const starts = choosePageBreaks(bottoms, total, PDF_PAGE_HEIGHT_PX);
        layout = { starts, total, bottoms, links: collectLinkAreas(element) };
        // Aborting stops the renderer right after the copy, before it parses and draws the tree.
        controller.abort();
      },
    });
  } catch (error) {
    if (layout === undefined) {
      throw error;
    }
  }
  if (layout === undefined) {
    throw new Error('The copy of the document was not measured');
  }
  return layout;
}

/**
 * Turns a copy into the document as it is printed.
 *
 * @param document The copied document.
 * @param root The copy of the editor root.
 * @param options What the copies need from the view.
 */
function prepareCopy(document: Document, root: HTMLElement, options: PdfCloneOptions): void {
  preparePdfClone(document, root, options);
  stylePdfClone(document, root);
}

/**
 * Returns the options every drawing shares: the width of the page, a fixed scale and no scroll offset.
 *
 * Left to their defaults, the scale would follow the density of the screen and the offset the scroll position of the
 * view, and the PDF would change with them.
 */
function baseOptions(): Omit<PdfCanvasOptions, 'y' | 'height' | 'onclone' | 'signal'> {
  return {
    scale: PDF_SCALE,
    width: PDF_CONTENT_WIDTH_PX,
    x: 0,
    windowWidth: PDF_CONTENT_WIDTH_PX,
    windowHeight: Math.ceil(PDF_PAGE_HEIGHT_PX),
    scrollX: 0,
    scrollY: 0,
    backgroundColor: '#ffffff',
    // Images from other origins are fetched again with CORS, so that drawing them does not lock the canvas.
    useCORS: true,
    logging: false,
  };
}

/**
 * Cuts one page out of a drawn chunk and encodes it as JPEG.
 *
 * @param document The document of the view, which makes the canvas.
 * @param chunk The drawn chunk.
 * @param offset The top of the page within the chunk, in CSS pixels.
 * @param height The height of the page in CSS pixels.
 * @returns The page, without its links.
 */
function cutPage(
  document: Document,
  chunk: HTMLCanvasElement,
  offset: number,
  height: number,
): Omit<PdfPageImage, 'links'> {
  const canvas = document.createElement('canvas');
  canvas.width = chunk.width;
  canvas.height = Math.max(1, Math.round(height * PDF_SCALE));
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('Could not draw a page');
  }
  // JPEG has no transparency, so the page is filled first.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    chunk,
    0,
    Math.round(offset * PDF_SCALE),
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  // The data URL already holds the JPEG as base64, the form the response carries it in.
  const url = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  return { jpeg: url.slice(url.indexOf(',') + 1), width: canvas.width, height: canvas.height };
}
