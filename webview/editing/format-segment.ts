import { isHtmlWhitespaceOnly } from './block';
import { readSelectionRange } from './caret';
import { INLINE_TAG_NAMES, isBlockLevelElement, isFormattingExcluded } from './inline-format';

/** A format segment: the unit that a format element wraps. */
export interface FormatSegment {
  /** The parent node the run belongs to. */
  readonly parent: Node;
  /**
   * The covered range.
   *
   * A live `Range` is held rather than a clone, so that splitting a text node at either end partway
   * through a rewrite leaves the range following along and still pointing at the same characters.
   */
  readonly range: Range;
  /**
   * The innermost block-level element containing the format segment. A bare run directly inside the
   * editor root has none.
   */
  readonly block: Element | undefined;
}

/** A format target: a list of format segments, a caret position, or no target. */
export type FormatTarget =
  | { readonly kind: 'segments'; readonly segments: readonly FormatSegment[] }
  | { readonly kind: 'caret'; readonly caret: Range }
  | { readonly kind: 'none' };

// How much of a node the range covers.
type Coverage = 'outside' | 'partial' | 'inside';

// A run being collected. A run that ends without holding target text does not become a format segment.
// With images counted, an image counts toward hasTargetText just like target text, so a run of only images becomes a
// format segment too.
interface PendingRun {
  readonly range: Range;
  hasTargetText: boolean;
}

/**
 * Cuts the format segments out of a selection range, in document order. Does not change the tree.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @param countImages Whether to count images just like target text. Only the link operations and checks count
 *   them. Wrapping a run of only images in any other format does not change how it looks, so the default is not to
 *   count them.
 * @returns The format segments. Empty when there is no range or no target text.
 *   With images counted, a run of only images becomes a format segment too.
 */
export function collectFormatSegments(root: Element, range: Range, countImages = false): FormatSegment[] {
  const segments: FormatSegment[] = [];
  if (range.collapsed) {
    return segments;
  }

  const container = range.commonAncestorContainer;
  const start = container instanceof Text ? container.parentNode : container;
  if (start !== null) {
    collectInParent(start, root, range, segments, countImages);
  }
  return segments;
}

/**
 * Reads the format target from the current selection. Changes neither the tree nor the selection.
 *
 * @param root The editor root.
 * @param countImages Whether to count images just like target text. Passed as is to the segment collection.
 * @returns A list of format segments, a caret position, or no target.
 */
export function collectFormatTarget(root: Element, countImages = false): FormatTarget {
  const range = readSelectionRange(root);
  if (range === undefined) {
    return { kind: 'none' };
  }
  if (range.collapsed) {
    return { kind: 'caret', caret: range };
  }
  return { kind: 'segments', segments: collectFormatSegments(root, range, countImages) };
}

/**
 * Cuts the runs out under one parent, descending into the children that cannot join a run.
 *
 * @param parent The parent node to walk.
 * @param root The editor root.
 * @param range The selection range.
 * @param segments Where the format segments that were cut out are written.
 * @param countImages Whether to count images just like target text.
 */
function collectInParent(
  parent: Node,
  root: Element,
  range: Range,
  segments: FormatSegment[],
  countImages: boolean,
): void {
  if (isFormattingExcluded(parent, root)) {
    // None of the text inside can be target text, so no run is built either.
    return;
  }

  const document = parent.ownerDocument;
  if (document === null) {
    return;
  }

  const block = findSegmentBlock(parent, root);
  let run: PendingRun | undefined;
  const flush = (): void => {
    if (run !== undefined && run.hasTargetText) {
      segments.push({ parent, range: run.range, block });
    }
    run = undefined;
  };

  for (const child of [...parent.childNodes]) {
    const coverage = readCoverage(range, child);
    // In a closed details section whose body is not wrapped in paragraphs, the parent `details` may be a target, but the text and elements directly
    // under it are inside the closed body. Judging only the parent would put them in a segment, so each child is judged too.
    if (coverage === 'outside' || isFormattingExcluded(child, root)) {
      flush();
      continue;
    }

    if (child instanceof Text) {
      const start = range.startContainer === child ? range.startOffset : 0;
      const end = range.endContainer === child ? range.endOffset : child.data.length;
      if (start >= end) {
        flush();
        continue;
      }
      if (run === undefined) {
        const created = document.createRange();
        created.setStart(child, start);
        run = { range: created, hasTargetText: false };
      }
      run.range.setEnd(child, end);
      run.hasTargetText ||= !isHtmlWhitespaceOnly(child.data.slice(start, end));
      continue;
    }

    if (child instanceof Element && coverage === 'inside' && isInlineRunMember(child)) {
      if (run === undefined) {
        const created = document.createRange();
        created.setStartBefore(child);
        run = { range: created, hasTargetText: false };
      }
      run.range.setEndAfter(child);
      run.hasTargetText ||= !isHtmlWhitespaceOnly(child.textContent ?? '')
        || (countImages && containsImage(child));
      continue;
    }

    flush();
    if (child instanceof Element) {
      collectInParent(child, root, range, segments, countImages);
    }
  }
  flush();
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
 * Returns how much of a node the range covers.
 *
 * @param range The selection range.
 * @param node The node to inspect.
 * @returns `outside` when they do not overlap, `inside` when the whole node is covered, and `partial`
 * when only part of it is.
 */
function readCoverage(range: Range, node: Node): Coverage {
  const document = node.ownerDocument;
  if (document === null) {
    return 'outside';
  }

  const probe = document.createRange();
  probe.selectNode(node);
  if (
    range.compareBoundaryPoints(Range.END_TO_START, probe) >= 0
    || range.compareBoundaryPoints(Range.START_TO_END, probe) <= 0
  ) {
    return 'outside';
  }
  const startsBefore = range.compareBoundaryPoints(Range.START_TO_START, probe) <= 0;
  const endsAfter = range.compareBoundaryPoints(Range.END_TO_END, probe) >= 0;
  return startsBefore && endsAfter ? 'inside' : 'partial';
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
