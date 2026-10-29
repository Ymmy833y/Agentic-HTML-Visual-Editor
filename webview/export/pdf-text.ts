import { PDF_FONT_ROLE } from '../../common/index';
import type { PdfFontRole, PdfTextRun } from '../../common/index';
import { PDF_FONT_FAMILIES } from './pdf-fonts';
import type { PdfFonts } from './pdf-fonts';

/** A line of text laid out in the copy in a bundled font, measured from the top-left corner of the editor root. */
export interface PdfTextLine {
  readonly role: PdfFontRole;
  /** The font size in CSS pixels. */
  readonly size: number;
  /** The top of the characters as laid out, in CSS pixels. */
  readonly top: number;
  readonly color: readonly [number, number, number];
  readonly bold: boolean;
  readonly italic: boolean;
  /** The characters in order. */
  readonly text: string;
  /** The left edge of each character in CSS pixels, one per code point. */
  readonly xs: readonly number[];
}

/** The text of the copy the PDF draws as text, and how it is styled. */
export interface PdfHiddenText {
  /** The text node, now inside a transparent wrapper. */
  readonly node: Text;
  readonly role: PdfFontRole;
  readonly size: number;
  readonly color: readonly [number, number, number];
  readonly bold: boolean;
  readonly italic: boolean;
}

// The weight from which a browser draws text bold when the font has only the regular weight.
const SYNTHETIC_BOLD_WEIGHT = 600;

// Characters on one line share their top; anything further apart starts another line.
const SAME_LINE_TOLERANCE_PX = 0.5;

// Whitespace that the layout collapses. A text node of only these holds nothing to draw.
const COLLAPSIBLE_WHITESPACE = /^[ \t\n\r\f]*$/u;

// How far the box of a character may reach past the area that clips it and still count as inside, so that rounding
// does not leave a character that touches the edge in the image.
const CLIP_TOLERANCE_PX = 0.5;

/** The area the content of an element shows in, in client coordinates. */
interface ClipArea {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** A part of a text node: characters the PDF draws as text, or characters left in the image. */
interface TextPart {
  text: string;
  /** Whether the PDF draws the characters as text, so that the image leaves them out. */
  readonly drawn: boolean;
}

/** A text node split into parts, with the style the parts the PDF draws are set in. */
interface SplitText {
  readonly node: Text;
  readonly parts: readonly TextPart[];
  readonly style: Omit<PdfHiddenText, 'node'>;
  /** The computed color of the underline and strike-through of the parent. */
  readonly decorationColor: string;
}

/**
 * Takes the text that the bundled fonts set out of what html2canvas-pro draws.
 *
 * Each run of characters the PDF can draw as shown goes into a transparent `span`, so the page image leaves it out and
 * the PDF draws it as text instead. Every other character stays as it is and is drawn in the image: one the fonts
 * lack, one the layout combines with the next into one glyph, one in a color the PDF cannot draw as shown, one a
 * style shows otherwise than plain or draws with an effect, and one an element clips because it overflows. A `span`
 * adds no box, so the layout does not change. html2canvas-pro draws underlines and strike-throughs with the style of
 * the element that holds the text, so the wrapper takes them from its parent and they stay in the image; list markers
 * belong to the item, so they stay as well.
 *
 * @param root The copy of the editor root, styled and with the bundled fonts loaded.
 * @param fonts The bundled fonts.
 * @returns The wrapped text, in document order.
 */
export function hidePdfText(root: HTMLElement, fonts: PdfFonts): PdfHiddenText[] {
  const document = root.ownerDocument;
  const view = document.defaultView;
  if (view === null) {
    return [];
  }
  // Editing leaves adjacent text nodes behind. A grid parent lays them out as one item, which a wrapper for each would
  // split, so they are joined first.
  root.normalize();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (isText(node)) {
      nodes.push(node);
    }
  }

  // Every node is split before any is wrapped. Wrapping changes the tree, and a measurement after each change would
  // lay the document out again.
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const range = document.createRange();
  const clips = new Map<Element, ClipArea | undefined>();
  const effects = new Map<Element, boolean>();
  const splits: SplitText[] = [];
  for (const node of nodes) {
    const parent = node.parentElement;
    if (parent === null || COLLAPSIBLE_WHITESPACE.test(node.data)) {
      continue;
    }
    const style = view.getComputedStyle(parent);
    const role = readRole(style.fontFamily);
    const color = readColor(style.color);
    if (role === undefined || color === undefined || style.visibility !== 'visible') {
      continue;
    }
    // The PDF sets the characters as written, upright on a horizontal line, filled with the color of the text, with
    // nothing around them and no effect over them. A style that shows them otherwise leaves them in the image, which
    // html2canvas-pro draws with that style.
    if (changesTextLook(style) || hasEffect(parent, root, view, effects)) {
      continue;
    }
    const clip = readClipArea(parent, root, view, clips);
    const parts = splitText(node.data, segmenter, (cluster, offset) => (
      // A character the layout combines with the next, such as a base and a combining mark, is drawn as one glyph the
      // font composes. Drawing its characters one by one would not give that glyph.
      [...cluster].length === 1 && fonts.covers(role, cluster.codePointAt(0) ?? 0)
        && (clip === undefined || liesInside(range, node, offset, cluster.length, clip))
    ));
    if (parts.some((part) => part.drawn)) {
      splits.push({
        node,
        parts,
        style: {
          role,
          size: Number.parseFloat(style.fontSize),
          color,
          bold: Number(style.fontWeight) >= SYNTHETIC_BOLD_WEIGHT,
          italic: style.fontStyle !== 'normal',
        },
        decorationColor: style.textDecorationColor,
      });
    }
  }
  return splits.flatMap((split) => wrapParts(split));
}

/**
 * Replaces a text node with its parts, each part the PDF draws in a transparent wrapper.
 *
 * @param split The node and its parts.
 * @returns The wrapped text.
 */
function wrapParts({ node, parts, style, decorationColor }: SplitText): PdfHiddenText[] {
  const document = node.ownerDocument;
  const hidden: PdfHiddenText[] = [];
  // A parent that lays its children out as items, such as the grid of a code block in a cell, makes each part of a
  // split node an item of its own. Parts kept in one plain span stay one item, as the text node was.
  const replacement = parts.length > 1 ? document.createElement('span') : document.createDocumentFragment();
  for (const part of parts) {
    const text = document.createTextNode(part.text);
    if (!part.drawn) {
      replacement.append(text);
      continue;
    }
    const wrapper = document.createElement('span');
    // The fill color wins over the color when set, and html2canvas-pro sets it on the stand-ins of pseudo elements.
    wrapper.style.setProperty('color', 'transparent', 'important');
    wrapper.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
    for (const name of ['text-decoration-line', 'text-decoration-style', 'text-decoration-thickness', 'text-underline-offset']) {
      wrapper.style.setProperty(name, 'inherit');
    }
    // The color of the line follows the text unless the parent set its own, and the text is now transparent.
    wrapper.style.setProperty('text-decoration-color', decorationColor);
    wrapper.append(text);
    replacement.append(wrapper);
    hidden.push({ node: text, ...style });
  }
  node.replaceWith(replacement);
  return hidden;
}

/**
 * Measures where each character of the hidden text lies, line by line.
 *
 * Characters the layout collapses, such as a run of spaces, take no width and are left out.
 *
 * @param root The copy of the editor root, laid out.
 * @param hidden The text {@link hidePdfText} wrapped in it.
 * @returns The lines in document order.
 */
export function measurePdfText(root: HTMLElement, hidden: readonly PdfHiddenText[]): PdfTextLine[] {
  const origin = root.getBoundingClientRect();
  const range = root.ownerDocument.createRange();
  const lines: PdfTextLine[] = [];
  for (const item of hidden) {
    let line: { top: number; text: string; xs: number[] } | undefined;
    const flush = (): void => {
      if (line !== undefined) {
        lines.push({ ...style(item), top: line.top, text: line.text, xs: line.xs });
      }
    };
    let offset = 0;
    for (const character of item.node.data) {
      range.setStart(item.node, offset);
      range.setEnd(item.node, offset + character.length);
      offset += character.length;
      const rect = [...range.getClientRects()].find((candidate) => candidate.width > 0);
      if (rect === undefined) {
        continue;
      }
      const top = rect.top - origin.top;
      const left = rect.left - origin.left;
      if (line === undefined || Math.abs(line.top - top) > SAME_LINE_TOLERANCE_PX) {
        flush();
        line = { top, text: '', xs: [] };
      }
      line.text += character;
      line.xs.push(left);
    }
    flush();
  }
  return lines;
}

/**
 * Puts each line on every page it reaches, and turns its lengths into the pixels of the page images.
 *
 * A line of a block taller than a page can reach past the end of its page. It goes on the next page as well, which
 * shows the part of it that falls there, as the image of that page does.
 *
 * @param lines The lines of the document.
 * @param starts The top edge of each page in the document.
 * @param total The height of the whole document.
 * @param scale Pixels of the page images per CSS pixel.
 * @returns The text of each page, one list per page.
 */
export function assignTextToPages(
  lines: readonly PdfTextLine[],
  starts: readonly number[],
  total: number,
  scale: number,
): PdfTextRun[][] {
  const pages: PdfTextRun[][] = starts.map(() => []);
  starts.forEach((start, index) => {
    const end = starts[index + 1] ?? total;
    for (const line of lines) {
      if (line.top + line.size <= start || line.top >= end) {
        continue;
      }
      pages[index].push({
        ...line,
        size: line.size * scale,
        top: (line.top - start) * scale,
        xs: line.xs.map((x) => x * scale),
      });
    }
  });
  return pages;
}

/**
 * Returns the style of a hidden text for its lines.
 *
 * @param item The hidden text.
 */
function style(item: PdfHiddenText): Omit<PdfTextLine, 'top' | 'text' | 'xs'> {
  return { role: item.role, size: item.size, color: item.color, bold: item.bold, italic: item.italic };
}

/**
 * Tells which bundled font a font family list asks for first.
 *
 * @param fontFamily The computed font family list.
 * @returns The role, or `undefined` when the text is not set in a bundled font.
 */
function readRole(fontFamily: string): PdfFontRole | undefined {
  const first = fontFamily.split(',')[0]?.trim().replace(/^["']|["']$/gu, '');
  return Object.values(PDF_FONT_ROLE).find((role) => PDF_FONT_FAMILIES[role] === first);
}

/**
 * Reads a computed color as red, green and blue.
 *
 * A browser gives an opaque color in sRGB as `rgb()`. A transparent color comes as `rgba()`, and a color such as
 * `oklch()` keeps its own notation, so neither matches.
 *
 * @param color The computed color.
 * @returns The channels, or `undefined` for a color the PDF cannot draw as shown.
 */
function readColor(color: string): [number, number, number] | undefined {
  const match = /^rgb\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*\)$/u.exec(color);
  if (match === null) {
    return undefined;
  }
  return [Math.round(Number(match[1])), Math.round(Number(match[2])), Math.round(Number(match[3]))];
}

/**
 * Returns the area the content of an element shows in, where it or an ancestor up to the root clips what overflows.
 *
 * html2canvas-pro clips such content to the padding box, so the area is the padding boxes intersected.
 *
 * @param element The element.
 * @param root The copy of the editor root, the last ancestor looked at.
 * @param view The window of the copy.
 * @param cache The areas already read, by element.
 * @returns The area, or `undefined` when nothing clips the content.
 */
function readClipArea(
  element: Element,
  root: Element,
  view: Window,
  cache: Map<Element, ClipArea | undefined>,
): ClipArea | undefined {
  if (cache.has(element)) {
    return cache.get(element);
  }
  const parent = element.parentElement;
  const outer = element === root || parent === null ? undefined : readClipArea(parent, root, view, cache);
  const style = view.getComputedStyle(element);
  let area = outer;
  if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
    const box = element.getBoundingClientRect();
    const own: ClipArea = {
      left: box.left + Number.parseFloat(style.borderLeftWidth),
      top: box.top + Number.parseFloat(style.borderTopWidth),
      right: box.right - Number.parseFloat(style.borderRightWidth),
      bottom: box.bottom - Number.parseFloat(style.borderBottomWidth),
    };
    area = outer === undefined ? own : {
      left: Math.max(outer.left, own.left),
      top: Math.max(outer.top, own.top),
      right: Math.min(outer.right, own.right),
      bottom: Math.min(outer.bottom, own.bottom),
    };
  }
  cache.set(element, area);
  return area;
}

/**
 * Returns whether a style shows its text other than as the characters written, plain, upright on a horizontal line and
 * filled with the color of the text: in another case or in small capitals, with a shadow or an outline, filled with
 * another color, with emphasis marks, in vertical lines, where the layout turns some characters on their side, or cut
 * short with an ellipsis, which hides the characters under it.
 *
 * Most of these properties are inherited, so the style of the element that holds the text carries what its ancestors
 * set. The ellipsis and the line clamp are not, and html2canvas-pro draws the ellipsis only for the text of the element
 * that sets them.
 *
 * @param style The computed style of the element that holds the text.
 */
function changesTextLook(style: CSSStyleDeclaration): boolean {
  return style.textTransform !== 'none'
    || style.fontVariantCaps !== 'normal'
    || style.textShadow !== 'none'
    || Number.parseFloat(style.getPropertyValue('-webkit-text-stroke-width')) > 0
    || style.getPropertyValue('-webkit-text-fill-color') !== style.color
    || style.textEmphasisStyle !== 'none'
    || style.writingMode !== 'horizontal-tb'
    || style.textOverflow !== 'clip'
    || style.getPropertyValue('-webkit-line-clamp') !== 'none';
}

/**
 * Returns whether an element or an ancestor up to the root draws its content with an effect: an opacity below 1, a
 * transform, a filter, a clip path, a blend mode, a mask or a reflection. html2canvas-pro draws these in the image,
 * and the text of the PDF has none.
 *
 * A browser gives an empty value for a property it lacks, as Firefox does for the reflection, and draws no such effect.
 * An empty value counts as none, as html2canvas-pro reads it.
 *
 * @param element The element.
 * @param root The copy of the editor root, the last ancestor looked at.
 * @param view The window of the copy.
 * @param cache The answers already found, by element.
 */
function hasEffect(element: Element, root: Element, view: Window, cache: Map<Element, boolean>): boolean {
  const known = cache.get(element);
  if (known !== undefined) {
    return known;
  }
  const style = view.getComputedStyle(element);
  const parent = element.parentElement;
  const answer = Number(style.opacity) < 1
    || style.mixBlendMode !== 'normal'
    || [
      style.transform,
      style.rotate,
      style.scale,
      style.translate,
      style.filter,
      style.clipPath,
      style.maskImage,
      style.getPropertyValue('-webkit-box-reflect'),
    ].some((value) => value !== 'none' && value !== '')
    || (element !== root && parent !== null && hasEffect(parent, root, view, cache));
  cache.set(element, answer);
  return answer;
}

/**
 * Returns whether a node is a text node.
 *
 * Told by the type of the node, because the copy is in another frame, whose nodes need not be instances of the classes
 * of this window.
 *
 * @param node The node.
 */
function isText(node: Node): node is Text {
  return node.nodeType === Node.TEXT_NODE;
}

/**
 * Returns whether characters of a text node lie wholly inside an area. Characters the layout collapses take no room
 * and count as inside.
 *
 * @param range A range to measure with.
 * @param node The text node.
 * @param offset Where the characters start in the node.
 * @param length How many code units they take.
 * @param clip The area.
 */
function liesInside(range: Range, node: Text, offset: number, length: number, clip: ClipArea): boolean {
  range.setStart(node, offset);
  range.setEnd(node, offset + length);
  return [...range.getClientRects()].every((rect) => rect.width === 0 || (
    rect.left >= clip.left - CLIP_TOLERANCE_PX && rect.right <= clip.right + CLIP_TOLERANCE_PX
      && rect.top >= clip.top - CLIP_TOLERANCE_PX && rect.bottom <= clip.bottom + CLIP_TOLERANCE_PX
  ));
}

/**
 * Splits text into parts the PDF draws as text and parts left in the image, one character as the user sees it at a
 * time.
 *
 * @param text The text.
 * @param segmenter Splits the text into characters as the user sees them.
 * @param isDrawn Returns whether the PDF draws a character, given it and where it starts in the text.
 */
function splitText(
  text: string,
  segmenter: Intl.Segmenter,
  isDrawn: (cluster: string, offset: number) => boolean,
): TextPart[] {
  const parts: TextPart[] = [];
  for (const { segment, index } of segmenter.segment(text)) {
    const drawn = isDrawn(segment, index);
    const last = parts.at(-1);
    if (last !== undefined && last.drawn === drawn) {
      last.text += segment;
    } else {
      parts.push({ text: segment, drawn });
    }
  }
  return parts;
}
