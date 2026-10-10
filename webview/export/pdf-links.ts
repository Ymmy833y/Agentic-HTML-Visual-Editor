import { trimHref } from '../../common/index';
import type { PdfPageLink } from '../../common/index';

/** Where a link of the document leads, as far as the view can tell. */
export type PdfLinkTarget =
  /**
   * The href with surrounding whitespace removed. Which of these the PDF opens, and where a path leads, depends on the
   * files and on where the PDF is saved, which only the host knows.
   */
  | { readonly kind: 'href'; readonly href: string }
  /** An element of the document, named by its id. */
  | { readonly kind: 'anchor'; readonly id: string };

/** A link laid out in the copy, measured from the top-left corner of the editor root in CSS pixels. */
export interface PdfLinkArea {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  /** An href, or the height in the document of the element a link inside the document leads to. */
  readonly target: { readonly kind: 'href'; readonly href: string } | { readonly kind: 'position'; readonly y: number };
}

/**
 * Decides where a link leads from its `href` as written.
 *
 * @param href The value of the attribute.
 * @returns The target, or `undefined` for a link that leads nowhere: an empty value or a bare `#`.
 */
export function classifyLinkHref(href: string): PdfLinkTarget | undefined {
  const written = trimHref(href);
  if (written.startsWith('#')) {
    const id = decodeFragment(written.slice(1));
    return id === '' ? undefined : { kind: 'anchor', id };
  }
  return written === '' ? undefined : { kind: 'href', href: written };
}

/**
 * Collects the links of the copy laid out at the width of the page.
 *
 * A link that wraps over lines gives one area per line. A link inside the document is kept only when the element it
 * names is in the editor root; links that are not laid out, such as those in the bodies of comments, give no area.
 *
 * @param root The copy of the editor root, laid out.
 * @returns The areas in document order.
 */
export function collectLinkAreas(root: HTMLElement): PdfLinkArea[] {
  const origin = root.getBoundingClientRect();
  const areas: PdfLinkArea[] = [];
  for (const link of root.querySelectorAll('a[href]')) {
    const target = classifyLinkHref(link.getAttribute('href') ?? '');
    if (target === undefined) {
      continue;
    }
    let resolved: PdfLinkArea['target'];
    if (target.kind === 'href') {
      resolved = target;
    } else {
      const element = findAnchor(root, target.id);
      if (element === undefined) {
        continue;
      }
      resolved = { kind: 'position', y: element.getBoundingClientRect().top - origin.top };
    }
    for (const rect of link.getClientRects()) {
      if (rect.width > 0 && rect.height > 0) {
        areas.push({
          top: rect.top - origin.top,
          left: rect.left - origin.left,
          width: rect.width,
          height: rect.height,
          target: resolved,
        });
      }
    }
  }
  return areas;
}

/**
 * Puts each link area on the page that holds its top, and turns positions in the document into a page and a height on
 * it.
 *
 * An area is cut at the bottom of its page. Lengths are multiplied by the scale of the page images.
 *
 * @param areas The link areas of the document.
 * @param starts The top edge of each page in the document.
 * @param total The height of the whole document.
 * @param scale Pixels of the page images per CSS pixel.
 * @returns The links of each page, one list per page.
 */
export function assignLinksToPages(
  areas: readonly PdfLinkArea[],
  starts: readonly number[],
  total: number,
  scale: number,
): PdfPageLink[][] {
  const pages: PdfPageLink[][] = starts.map(() => []);
  const pageOf = (y: number): number => {
    let index = 0;
    while (index + 1 < starts.length && starts[index + 1] <= y) {
      index += 1;
    }
    return index;
  };
  for (const area of areas) {
    const index = pageOf(area.top);
    const end = starts[index + 1] ?? total;
    const height = Math.min(area.height, end - area.top);
    if (height <= 0) {
      continue;
    }
    let target: PdfPageLink['target'];
    if (area.target.kind === 'href') {
      target = area.target;
    } else {
      const pageIndex = pageOf(area.target.y);
      target = { kind: 'page', pageIndex, y: (area.target.y - starts[pageIndex]) * scale };
    }
    pages[index].push({
      x: area.left * scale,
      y: (area.top - starts[index]) * scale,
      width: area.width * scale,
      height: height * scale,
      target,
    });
  }
  return pages;
}

/**
 * Finds the element a link inside the document names: the element with that id, or else a link with that name, as a
 * browser does.
 *
 * @param root The copy of the editor root.
 * @param id The name in the link.
 */
function findAnchor(root: HTMLElement, id: string): Element | undefined {
  for (const element of root.querySelectorAll('[id]')) {
    if (element.id === id) {
      return element;
    }
  }
  for (const element of root.querySelectorAll('a[name]')) {
    if (element.getAttribute('name') === id) {
      return element;
    }
  }
  return undefined;
}

/**
 * Decodes the percent escapes of a fragment, keeping it as written when they are malformed.
 *
 * @param fragment The fragment without its `#`.
 */
function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}
