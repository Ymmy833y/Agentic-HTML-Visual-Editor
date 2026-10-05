import { isHtmlWhitespaceOnly } from './block';
import { readSelectionRange } from './caret';
import { INLINE_TAG_NAMES, isBlockLevelElement, isFormattingExcluded } from './inline-format';

/**
 * A format segment: the unit that a format element wraps.
 *
 * @typeParam R The kind of range that holds the covered part. Commands hold a live `Range`; reads hold a
 *   `StaticRange`.
 */
export interface FormatSegment<R extends AbstractRange = Range> {
  /** The parent node the run belongs to. */
  readonly parent: Node;
  /**
   * The covered range.
   *
   * Commands hold a live `Range` rather than a clone, so that splitting a text node at either end partway
   * through a rewrite leaves the range following along and still pointing at the same characters.
   */
  readonly range: R;
  /**
   * The innermost block-level element containing the format segment. A bare run directly inside the
   * editor root has none.
   */
  readonly block: Element | undefined;
}

/**
 * A format target: a list of format segments, a caret position, or no target.
 *
 * @typeParam R The kind of range the format segments hold.
 */
export type FormatTarget<R extends AbstractRange = Range> =
  | { readonly kind: 'segments'; readonly segments: readonly FormatSegment<R>[] }
  | { readonly kind: 'caret'; readonly caret: Range }
  | { readonly kind: 'none' };

// How much of a node the range covers.
type Coverage = 'outside' | 'partial' | 'inside';

// The ends of a run or a format segment, held as plain values until the run becomes a format segment.
interface SegmentBounds {
  readonly startContainer: Node;
  readonly startOffset: number;
  readonly endContainer: Node;
  readonly endOffset: number;
}

// Makes the range a format segment holds from its ends.
type RangeFactory<R extends AbstractRange> = (bounds: SegmentBounds) => R;

// A run being collected. A run that ends without holding target text does not become a format segment.
// With images counted, an image counts toward hasTargetText just like target text, so a run of only images becomes a
// format segment too.
interface PendingRun {
  readonly startContainer: Node;
  readonly startOffset: number;
  endContainer: Node;
  endOffset: number;
  hasTargetText: boolean;
}

// Where an end of the selection lies among the children of the parent being walked, on a doubled scale: the gap
// before child i is 2i, and anywhere inside child i is 2i + 1. A point inside a child, even at its very start or
// end, lies strictly between the gaps around it, as DOM boundary points compare.
// Positions are numbers so that judging a child needs neither a `Range` nor a DOM position comparison. A live
// `Range` stays registered with the document until garbage collection and is updated on every node removal, and
// comparing DOM positions walks siblings; over thousands of paragraphs the first stalled a later delete for seconds
// and the second made the read itself quadratic.
type EndPosition = number;

// The end lies before every child of the parent.
const BEFORE_CHILDREN: EndPosition = -1;

// The end lies after every child of the parent.
const AFTER_CHILDREN: EndPosition = Number.POSITIVE_INFINITY;

// The walk under one parent: the selection range and where its ends lie among the parent's children.
interface ParentWalk {
  readonly range: Range;
  readonly start: EndPosition;
  readonly end: EndPosition;
}

/**
 * Cuts the format segments out of a selection range, in document order. Does not change the tree.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @param countImages Whether to count images just like target text. Only the link operations and checks count
 *   them. Wrapping a run of only images in any other format does not change how it looks, so the default is not to
 *   count them.
 * @returns The format segments, each holding a live `Range`. Empty when there is no range or no target text.
 *   With images counted, a run of only images becomes a format segment too.
 */
export function collectFormatSegments(root: Element, range: Range, countImages = false): FormatSegment[] {
  return cutFormatSegments(root, range, countImages, createLiveRange);
}

/**
 * Reads the format target from the current selection for a command that rewrites the tree. Changes neither the
 * tree nor the selection.
 *
 * @param root The editor root.
 * @param countImages Whether to count images just like target text. Passed as is to the segment collection.
 * @returns A list of format segments holding live ranges, a caret position, or no target.
 */
export function collectFormatTarget(root: Element, countImages = false): FormatTarget {
  return readTarget(root, countImages, createLiveRange);
}

/**
 * Reads the format target from the current selection for a read that only inspects it. Changes neither the tree
 * nor the selection.
 *
 * The format segments are cut out exactly as for a command, but hold ranges the document does not track. This read
 * runs on every selection change, and a live range per segment would linger until garbage collection and slow
 * every node removal that follows.
 *
 * @param root The editor root.
 * @param countImages Whether to count images just like target text. Passed as is to the segment collection.
 * @returns A list of format segments holding static ranges, a caret position, or no target.
 */
export function readFormatTarget(root: Element, countImages = false): FormatTarget<StaticRange> {
  return readTarget(root, countImages, createStaticRange);
}

/**
 * Reads the format target from the current selection, making the segment ranges with the given factory.
 *
 * @param root The editor root.
 * @param countImages Whether to count images just like target text.
 * @param toRange Makes the range a format segment holds.
 * @returns A list of format segments, a caret position, or no target.
 */
function readTarget<R extends AbstractRange>(
  root: Element,
  countImages: boolean,
  toRange: RangeFactory<R>,
): FormatTarget<R> {
  const range = readSelectionRange(root);
  if (range === undefined) {
    return { kind: 'none' };
  }
  if (range.collapsed) {
    return { kind: 'caret', caret: range };
  }
  return { kind: 'segments', segments: cutFormatSegments(root, range, countImages, toRange) };
}

/**
 * Cuts the format segments out of a selection range, making the segment ranges with the given factory.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @param countImages Whether to count images just like target text.
 * @param toRange Makes the range a format segment holds.
 * @returns The format segments in document order.
 */
function cutFormatSegments<R extends AbstractRange>(
  root: Element,
  range: Range,
  countImages: boolean,
  toRange: RangeFactory<R>,
): FormatSegment<R>[] {
  const segments: FormatSegment<R>[] = [];
  if (range.collapsed) {
    return segments;
  }

  const container = range.commonAncestorContainer;
  const start = container instanceof Text ? container.parentNode : container;
  if (start !== null) {
    // Both ends lie inside the common ancestor, so each is found among its children.
    const children = [...start.childNodes];
    const walk: ParentWalk = {
      range,
      start: locateEnd(start, children, range.startContainer, range.startOffset),
      end: locateEnd(start, children, range.endContainer, range.endOffset),
    };
    collectInParent(start, children, walk, root, segments, countImages, toRange);
  }
  return segments;
}

/**
 * Makes a live range from the ends of a format segment.
 *
 * @param bounds The ends.
 * @returns A live `Range` over the ends.
 */
function createLiveRange(bounds: SegmentBounds): Range {
  const range = (bounds.startContainer.ownerDocument ?? document).createRange();
  range.setStart(bounds.startContainer, bounds.startOffset);
  range.setEnd(bounds.endContainer, bounds.endOffset);
  return range;
}

/**
 * Makes a range the document does not track from the ends of a format segment.
 *
 * @param bounds The ends.
 * @returns A `StaticRange` over the ends.
 */
function createStaticRange(bounds: SegmentBounds): StaticRange {
  return new StaticRange({ ...bounds });
}

/**
 * Cuts the runs out under one parent, descending into the children that cannot join a run.
 *
 * @param parent The parent node to walk.
 * @param children The children of the parent, taken before the walk.
 * @param walk The selection range and where its ends lie among the children.
 * @param root The editor root.
 * @param segments Where the format segments that were cut out are written.
 * @param countImages Whether to count images just like target text.
 * @param toRange Makes the range a format segment holds.
 */
function collectInParent<R extends AbstractRange>(
  parent: Node,
  children: readonly ChildNode[],
  walk: ParentWalk,
  root: Element,
  segments: FormatSegment<R>[],
  countImages: boolean,
  toRange: RangeFactory<R>,
): void {
  if (isFormattingExcluded(parent, root)) {
    // None of the text inside can be target text, so no run is built either.
    return;
  }

  const { range } = walk;
  const block = findSegmentBlock(parent, root);
  let run: PendingRun | undefined;
  const flush = (): void => {
    if (run !== undefined && run.hasTargetText) {
      segments.push({ parent, range: toRange(run), block });
    }
    run = undefined;
  };

  children.forEach((child, index) => {
    const coverage = readCoverage(walk, index);
    // In a closed details section whose body is not wrapped in paragraphs, the parent `details` may be a target, but the text and elements directly
    // under it are inside the closed body. Judging only the parent would put them in a segment, so each child is judged too.
    if (coverage === 'outside' || isFormattingExcluded(child, root)) {
      flush();
      return;
    }

    if (child instanceof Text) {
      const start = range.startContainer === child ? range.startOffset : 0;
      const end = range.endContainer === child ? range.endOffset : child.data.length;
      if (start >= end) {
        flush();
        return;
      }
      run ??= { startContainer: child, startOffset: start, endContainer: child, endOffset: end, hasTargetText: false };
      run.endContainer = child;
      run.endOffset = end;
      run.hasTargetText ||= !isHtmlWhitespaceOnly(child.data.slice(start, end));
      return;
    }

    if (child instanceof Element && coverage === 'inside' && isInlineRunMember(child)) {
      // The positions right before and right after the child, as setting a range before or after it would give.
      run ??= { startContainer: parent, startOffset: index, endContainer: parent, endOffset: index, hasTargetText: false };
      run.endContainer = parent;
      run.endOffset = index + 1;
      run.hasTargetText ||= !isHtmlWhitespaceOnly(child.textContent ?? '')
        || (countImages && containsImage(child));
      return;
    }

    flush();
    if (child instanceof Element) {
      const grandchildren = [...child.childNodes];
      collectInParent(child, grandchildren, enterChild(walk, child, grandchildren, index), root, segments, countImages, toRange);
    }
  });
  flush();
}

/**
 * Finds where an end of the selection lies among the children of a parent that contains it.
 *
 * @param parent The parent.
 * @param children The children of the parent.
 * @param container The container of the end.
 * @param offset The offset of the end.
 * @returns The position on the doubled scale.
 */
function locateEnd(parent: Node, children: readonly ChildNode[], container: Node, offset: number): EndPosition {
  if (container === parent) {
    return 2 * offset;
  }
  let child: Node = container;
  while (child.parentNode !== null && child.parentNode !== parent) {
    child = child.parentNode;
  }
  // The walk stops at the node whose parent is the parent, so it is one of the children.
  return 2 * children.indexOf(child as ChildNode) + 1;
}

/**
 * Carries where the ends of the selection lie into the children of a child being descended into.
 *
 * An end that is not inside the child lies before it (the start) or after it (the end): the child overlaps the
 * selection, or it would not be descended into.
 *
 * @param walk The walk under the parent.
 * @param child The child to descend into.
 * @param children The children of the child.
 * @param index The index of the child.
 * @returns The walk under the child.
 */
function enterChild(walk: ParentWalk, child: Element, children: readonly ChildNode[], index: number): ParentWalk {
  const inside = 2 * index + 1;
  return {
    range: walk.range,
    start: walk.start === inside
      ? locateEnd(child, children, walk.range.startContainer, walk.range.startOffset)
      : BEFORE_CHILDREN,
    end: walk.end === inside
      ? locateEnd(child, children, walk.range.endContainer, walk.range.endOffset)
      : AFTER_CHILDREN,
  };
}

/**
 * Determines whether an element is an image or contains one.
 *
 * @param element The element to inspect. It is a member of a run, so everything inside it is inline.
 * @returns `true` if it is an `img` itself or has an `img` among its descendants.
 */
function containsImage(element: Element): boolean {
  return element.localName === 'img' || element.querySelector('img') !== null;
}

/**
 * Determines whether an element may join a run.
 *
 * @param element The element to inspect. It must be fully contained in the selection.
 * @returns `true` when it is an inline element and contains neither a block-level element nor a comment
 * annotation.
 */
function isInlineRunMember(element: Element): boolean {
  if (!INLINE_TAG_NAMES.has(element.localName)) {
    return false;
  }
  for (const descendant of element.querySelectorAll('*')) {
    if (!INLINE_TAG_NAMES.has(descendant.localName)) {
      return false;
    }
  }
  return true;
}

/**
 * Returns how much of a child the range covers.
 *
 * @param walk The walk under the parent, holding where the ends of the range lie among its children.
 * @param index The index of the child.
 * @returns `outside` when they do not overlap, `inside` when the whole child is covered, and `partial`
 * when only part of it is.
 */
function readCoverage(walk: ParentWalk, index: number): Coverage {
  const before = 2 * index;
  const after = 2 * index + 2;
  if (walk.start >= after || walk.end <= before) {
    return 'outside';
  }
  return walk.start <= before && walk.end >= after ? 'inside' : 'partial';
}

/**
 * Finds the innermost block-level element containing the format segment.
 *
 * @param parent The format segment's parent node.
 * @param root The editor root.
 * @returns The block that was found, or `undefined` for a bare run directly inside the editor root.
 */
function findSegmentBlock(parent: Node, root: Element): Element | undefined {
  let current: Element | null = parent instanceof Element ? parent : parent.parentElement;
  while (current !== null && current !== root) {
    if (isBlockLevelElement(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return undefined;
}
