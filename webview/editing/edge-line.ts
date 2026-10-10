import type { VisibleEdge } from './boundary-placement';
import type { NodeBoundary } from '../selection/selection-position';

// Elements laid out as one box. The caret moves around them, never into them.
const ATOMIC_ELEMENT_NAMES: ReadonlySet<string> = new Set([
  'br',
  'hr',
  'img',
  'video',
  'audio',
  'canvas',
  'input',
  'textarea',
  'select',
  'button',
  'svg',
]);

// Content hidden by visibility is skipped too: the source text of a diagram stays in the tree but is hidden that way,
// and the browser passes it by.
const VISIBILITY_OPTIONS: CheckVisibilityOptions = { visibilityProperty: true };

// White space values that keep line breaks, so that an empty line of a code block makes a line of its own.
const PRESERVED_WHITE_SPACE_PATTERN = /^(?:pre|pre-wrap|pre-line|break-spaces)$/u;

/** A leaf of the layout with the boxes the caret can stand beside. */
interface LayoutLeaf {
  /** The text or element. */
  readonly node: Node;
  /** The boxes in viewport coordinates. */
  readonly rects: readonly DOMRect[];
  /** Whether the leaf is an empty block. It ends a line even when it has no height. */
  readonly emptyBlock: boolean;
}

/** A visual line as a vertical band. */
interface LineBand {
  readonly top: number;
  readonly bottom: number;
}

/** The boxes a caret at a point can be drawn at. */
interface CaretBoxes {
  /** Where a caret placed at the point by a script is drawn: at a wrap, the start of the line after it. */
  readonly downstream: DOMRect;
  /** Where the caret is drawn when it ends the line before a wrap. Away from a wrap, the same box. */
  readonly upstream: DOMRect;
}

/** What the walk over the leaves needs besides the node. */
interface LeafWalk {
  readonly view: Window;
  readonly point: NodeBoundary;
  /** Whether the element being read is editable. Content that differs is an island the caret skips. */
  readonly editable: boolean;
  readonly leaves: LayoutLeaf[];
}

/**
 * Returns whether a point is on the first or last visual line of an element. Does not change the tree.
 *
 * Reads the layout, because moving the selection to try a line move would make the browser forget the column that a
 * run of ↑ and ↓ keeps returning to. The boxes of the element's leaves are grouped into lines by vertical overlap,
 * and the line holding the caret is compared with the first or the last one. Content the browser's own line move
 * skips (hidden content and non-editable islands) is left out.
 *
 * At a wrap, the end of the line before and the start of the line after are one point right after the last character
 * before the wrap, and only the browser knows which of the two the caret is drawn at. Only when the answer differs
 * between them is the selection moved to find out, and it is put back on the same side.
 *
 * @param element The element whose lines are read, such as a table cell.
 * @param point The caret point inside the element.
 * @param edge `first` for the first line, `last` for the last line.
 * @returns `true` on that line, and also when the element shows no line. `false` where the layout cannot be read.
 */
export function isOnEdgeLine(element: Element, point: NodeBoundary, edge: VisibleEdge): boolean {
  const document = element.ownerDocument;
  const view = document.defaultView;
  // Without a layout (or the APIs that read it) the line is unknown, so the key keeps its default.
  if (
    view === null
    || typeof element.checkVisibility !== 'function'
    || typeof document.createRange().getClientRects !== 'function'
  ) {
    return false;
  }

  const walk: LeafWalk = {
    view,
    point,
    editable: element instanceof HTMLElement && element.isContentEditable,
    leaves: [],
  };
  collectLeaves(element, walk);
  const lines = groupLines(walk.leaves.flatMap((leaf) => leaf.rects));
  const caret = readCaretBoxes(view, point, walk.leaves);
  if (caret === undefined || lines.length === 0) {
    return true;
  }

  const downstream = isOnEdgeBand(lines, caret.downstream, edge);
  const upstream = isOnEdgeBand(lines, caret.upstream, edge);
  return upstream === downstream || !isDrawnUpstream(view, point) ? downstream : upstream;
}

/**
 * Returns whether a caret box is on the first or last line.
 *
 * @param lines The lines from top to bottom, at least one.
 * @param box The caret box.
 * @param edge `first` for the first line, `last` for the last line.
 * @returns `true` when the line the box overlaps most is that line.
 */
function isOnEdgeBand(lines: readonly LineBand[], box: DOMRect, edge: VisibleEdge): boolean {
  let index = 0;
  lines.forEach((line, candidate) => {
    if (measureOverlap(line, box) > measureOverlap(lines[index], box)) {
      index = candidate;
    }
  });
  return edge === 'last' ? index === lines.length - 1 : index === 0;
}

/**
 * Returns whether the collapsed caret at a point is drawn at the end of a line rather than at the start of one. At a
 * wrap, that tells the end of the line before from the start of the line after. Puts the caret back on the side it was
 * drawn on, but the browser forgets the column that a run of ↑ and ↓ returns to.
 *
 * The selection reads the same for both sides. Moving to the start of the line tells them apart: a caret at the end of
 * a line moves to that line's start, and one at the start of a line stays. Moving to the end of the line then brings
 * the caret back. When it lands elsewhere, the caret was inside the line, and it is put back on the point.
 *
 * @param view The window.
 * @param point The caret point.
 * @returns `true` when drawn at the end of a line. `false` for a range, whose end cannot be moved without losing the
 *   range, so it is read as a script would place it.
 */
function isDrawnUpstream(view: Window, point: NodeBoundary): boolean {
  const selection = view.getSelection();
  if (
    selection === null
    || !selection.isCollapsed
    || selection.focusNode !== point.container
    || selection.focusOffset !== point.offset
    || typeof selection.modify !== 'function'
  ) {
    return false;
  }
  selection.modify('move', 'backward', 'lineboundary');
  if (selection.focusNode === point.container && selection.focusOffset === point.offset) {
    return false;
  }
  selection.modify('move', 'forward', 'lineboundary');
  if (selection.focusNode === point.container && selection.focusOffset === point.offset) {
    return true;
  }
  selection.collapse(point.container, point.offset);
  return false;
}

/**
 * Collects the leaves under a node in document order: text fragments, line breaks, replaced elements and empty
 * blocks.
 *
 * A floating replaced element sits beside the lines rather than on one, and would join every line it spans, so it is
 * left out.
 * An inline block is one box on the line around it unless the caret is inside it.
 *
 * @param node The node.
 * @param walk The walk, whose leaves receive the result.
 */
function collectLeaves(node: Node, walk: LeafWalk): void {
  if (node instanceof Text) {
    const parent = node.parentElement;
    if (parent === null || !parent.checkVisibility(VISIBILITY_OPTIONS)) {
      return;
    }
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((rect) => rect.height > 0);
    // Collapsed white space reports boxes without width and never makes a line of its own. A kept line break also has
    // no width but does make a line. The style is read only when needed, since this runs for every text in the cell.
    const kept = rects.some((rect) => rect.width === 0)
      && PRESERVED_WHITE_SPACE_PATTERN.test(walk.view.getComputedStyle(parent).whiteSpace);
    walk.leaves.push({ node, rects: rects.filter((rect) => rect.width > 0 || kept), emptyBlock: false });
    return;
  }
  if (!(node instanceof Element)) {
    return;
  }
  const editable = node instanceof HTMLElement ? node.isContentEditable : walk.editable;
  const style = walk.view.getComputedStyle(node);
  if (editable !== walk.editable || style.display === 'none') {
    return;
  }

  const atomic = ATOMIC_ELEMENT_NAMES.has(node.localName);
  if (node.firstChild === null && !atomic && style.display !== 'inline') {
    if (node.checkVisibility(VISIBILITY_OPTIONS)) {
      walk.leaves.push({
        node,
        rects: [...node.getClientRects()].filter((rect) => rect.height > 0),
        emptyBlock: !style.display.startsWith('inline'),
      });
    }
    return;
  }
  if (!atomic && !(style.display.startsWith('inline-') && !node.contains(walk.point.container))) {
    for (const child of node.childNodes) {
      collectLeaves(child, walk);
    }
    return;
  }
  if (style.float === 'none' && node.checkVisibility(VISIBILITY_OPTIONS)) {
    // A line break has no width and a rule may have no height; each still makes a line.
    walk.leaves.push({
      node,
      rects: [...node.getClientRects()].filter((rect) => rect.width > 0 || rect.height > 0),
      emptyBlock: false,
    });
  }
}

/**
 * Groups boxes into visual lines. Boxes on one line overlap by more than half of the smaller height, which keeps a
 * large inline run on the line around it while lines of a tight line height stay apart.
 *
 * @param rects The boxes.
 * @returns The lines from top to bottom.
 */
function groupLines(rects: readonly DOMRect[]): LineBand[] {
  const lines: LineBand[] = [];
  for (const rect of [...rects].sort((a, b) => a.top - b.top)) {
    const line = lines.at(-1);
    if (line !== undefined && measureOverlap(line, rect) > Math.min(line.bottom - line.top, rect.height) / 2) {
      lines[lines.length - 1] = { top: line.top, bottom: Math.max(line.bottom, rect.bottom) };
    } else {
      lines.push({ top: rect.top, bottom: rect.bottom });
    }
  }
  return lines;
}

/**
 * Returns how much two bands overlap vertically.
 *
 * @param first One band.
 * @param second The other band.
 * @returns The overlap, negative when they are apart.
 */
function measureOverlap(first: LineBand, second: LineBand): number {
  return Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
}

/**
 * Returns the boxes a caret at a point can be drawn at.
 *
 * @param view The window.
 * @param point The caret point.
 * @param leaves The leaves of the element in document order.
 * @returns The boxes, or `undefined` when no leaf has one.
 */
function readCaretBoxes(view: Window, point: NodeBoundary, leaves: readonly LayoutLeaf[]): CaretBoxes | undefined {
  const downstream = readCaretBox(view, point, leaves);
  if (downstream === undefined) {
    return undefined;
  }
  return { downstream, upstream: readUpstreamBox(view, point) ?? downstream };
}

/**
 * Returns the box the caret is drawn at when a script places it at a point.
 *
 * A point at the end of a text or between elements has no box of its own, so it follows the browser's placement:
 * downstream at the start of the next leaf, as at a wrap, but at the end of the previous leaf when only that leaf is
 * in the point's block, or when an empty block lies between.
 *
 * @param view The window.
 * @param point The caret point.
 * @param leaves The leaves of the element in document order.
 * @returns The box, or `undefined` when no leaf has one.
 */
function readCaretBox(view: Window, point: NodeBoundary, leaves: readonly LayoutLeaf[]): DOMRect | undefined {
  const { container, offset } = point;
  if (container instanceof Text && offset < container.length) {
    // At a wrap the collapsed range reports both ends; a caret a script places there is drawn downstream, at the
    // start of the next line.
    const box = readRangeBoxes(container, offset, offset).at(-1);
    if (box !== undefined) {
      return box;
    }
    // The start of an empty line of a code block has no box, but the line break after it has one.
    if (container.data[offset] === '\n') {
      const next = readRangeBoxes(container, offset, offset + 1)[0];
      if (next !== undefined) {
        return next;
      }
    }
  }
  // Inside an empty block the caret is drawn in the block's own box.
  const own = container instanceof Text
    ? undefined
    : leaves.find((leaf) => leaf.node === container && leaf.rects.length > 0);
  if (own !== undefined) {
    return own.rects[0];
  }

  const caret = view.document.createRange();
  caret.setStart(container, offset);
  caret.collapse(true);
  const visible = leaves.filter((leaf) => leaf.rects.length > 0);
  const after = visible.find((leaf) => caret.comparePoint(leaf.node, 0) > 0);
  const before = visible.filter((leaf) => caret.comparePoint(leaf.node, 0) < 0).at(-1);
  const endOfBefore = before === undefined ? undefined : readEndBox(before);
  if (after === undefined) {
    return endOfBefore;
  }

  const block = findLineBlock(view, container instanceof Element ? container : container.parentElement);
  const isInBlock = (leaf: LayoutLeaf): boolean => findLineBlock(view, leaf.node.parentElement) === block;
  const emptyBlockBetween = leaves.some((leaf) => leaf.emptyBlock
    && caret.comparePoint(leaf.node, 0) > 0
    && (leaf.node.compareDocumentPosition(after.node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  const downstream = !(emptyBlockBetween && endOfBefore !== undefined)
    && (before === undefined || isInBlock(after) || !isInBlock(before));
  if (!downstream) {
    return endOfBefore;
  }
  // A text that starts with the space hanging at the end of the line before reports no box at its start.
  const start = after.node instanceof Text ? readRangeBoxes(after.node, 0, 0)[0] : after.rects[0];
  return start ?? endOfBefore ?? after.rects[0];
}

/**
 * Returns the box at the end of the line before a wrap, for a point that may also be drawn there.
 *
 * The browser draws a caret at the end of a line only from a point in the text before the wrap, right after its last
 * character (after the space a wrap at a space leaves there). The box of that character is on the line the caret is
 * then drawn on. A kept line break ends its line for good, so a point after one has no other side.
 *
 * @param view The window.
 * @param point The caret point.
 * @returns The box, or `undefined` when the point has no other side.
 */
function readUpstreamBox(view: Window, point: NodeBoundary): DOMRect | undefined {
  const { container, offset } = point;
  if (!(container instanceof Text) || offset === 0) {
    return undefined;
  }
  const parent = container.parentElement;
  if (
    container.data[offset - 1] === '\n'
    && parent !== null
    && PRESERVED_WHITE_SPACE_PATTERN.test(view.getComputedStyle(parent).whiteSpace)
  ) {
    return undefined;
  }
  // A space left at a wrap reports a box without width at both ends of the wrap, the first being where it stands. A
  // character with width is only on its own line, though a box without width may come with it at the wrap before.
  const boxes = readRangeBoxes(container, offset - 1, offset);
  return boxes.find((box) => box.width > 0) ?? boxes[0];
}

/**
 * Returns the box of the end of a leaf: the caret after the last character of a text, or the last box of an element.
 *
 * @param leaf The leaf, which has a box.
 * @returns The box.
 */
function readEndBox(leaf: LayoutLeaf): DOMRect | undefined {
  const end = leaf.node instanceof Text ? readRangeBoxes(leaf.node, leaf.node.length, leaf.node.length)[0] : undefined;
  return end ?? leaf.rects.at(-1);
}

/**
 * Returns the boxes of a range within a text that have height.
 *
 * @param text The text.
 * @param start The start offset.
 * @param end The end offset.
 * @returns The boxes.
 */
function readRangeBoxes(text: Text, start: number, end: number): DOMRect[] {
  const range = text.ownerDocument.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  return [...range.getClientRects()].filter((rect) => rect.height > 0);
}

/**
 * Returns the nearest element that lays out its own lines: a block, a cell or an inline block.
 *
 * @param view The window.
 * @param element The element to start from.
 * @returns The element, or `undefined` without one.
 */
function findLineBlock(view: Window, element: Element | null): Element | undefined {
  let current = element;
  while (current !== null && view.getComputedStyle(current).display === 'inline') {
    current = current.parentElement;
  }
  return current ?? undefined;
}
