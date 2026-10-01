import { containsNode, findBlock } from './block';
import { runBlockOperation } from './block-command';
import type { BlockCommandPorts } from './block-command';
import { BLOCK_KIND } from './block-format';
import type { BlockRewriteProgress } from './block-format';
import { findTrailingPreBreak, placeCaret } from './caret';
import type { TrailingPreBreak } from './caret';
import { findEmptyCodeAt } from './code-block-text';
import type { DeleteKind } from './delete-rule';

// Elements counted as content inside `pre` besides text.
const CODE_CONTENT_SELECTOR = 'br, img, comment';

// Comment annotation bodies and replies. They are not part of the document flow, so they do not count as `code` content.
const COMMENT_TEXT_TAG_NAMES: ReadonlySet<string> = new Set(['comment-body', 'comment-reply']);

/** The `code` to keep on delete, paired with the deletion extent. */
export interface CodeClearing {
  /** The `code` whose element is kept. */
  readonly code: Element;
  /** The deletion extent. A copy detached from the selection. */
  readonly extent: Range;
}

/** A point at a border of a range. */
interface BoundaryPoint {
  readonly node: Node;
  readonly offset: number;
}

/**
 * Determines whether a `pre` is a blank code block.
 *
 * Deciding only by the inside of `code` would make a `pre` with content outside `code` (`<pre>$ <code></code></pre>`) count as blank,
 * and a delete would turn it into a paragraph along with that content. So it is decided by the whole content of `pre`. The trailing pre break forms no line,
 * so it is not counted. Counting it would keep a `code` ending with a line break from ever becoming blank after deleting all its characters, so it could not revert to a paragraph.
 *
 * @param pre The `pre` to inspect.
 * @returns `true` if, excluding the trailing pre break, it has no text with length and its elements are only `code` and at most one `br`.
 *   A `pre` without `code` is judged the same way.
 */
export function isBlankCodeBlock(pre: Element): boolean {
  const walker = pre.ownerDocument.createTreeWalker(pre, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let length = 0;
  let breaks = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text) {
      length += node.data.length;
      continue;
    }
    if (!(node instanceof Element)) {
      continue;
    }
    if (node.localName === 'br') {
      breaks += 1;
    } else if (node.localName !== 'code') {
      return false;
    }
  }
  const trailing = findTrailingPreBreak(pre) === undefined ? 0 : 1;
  return breaks <= 1 && length - trailing === 0;
}

/**
 * Checks whether a delete at this position loses `code`, and returns the `code` to keep and the deletion extent.
 *
 * The browser default removes a `code` that becomes empty, and the `code` when deleting a character next to an empty `code`, so
 * subsequent input goes outside `code` (directly under `pre`). This identifies such deletes so that this feature can take them over.
 * Finding the deletion extent temporarily extends the selection and restores it, so no extent is computed where `code` content remains on the side
 * opposite the direction.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @param kind The delete kind. Word deletes use one word; line deletes use the range to the edge of the line.
 * @returns The `code` to keep and the deletion extent, or `undefined` if none applies or the extent cannot be found.
 */
export function readCodeClearing(root: Element, range: Range, kind: DeleteKind): CodeClearing | undefined {
  if (!range.collapsed) {
    return undefined;
  }
  const pre = findBlock(range.startContainer, root);
  if (pre === undefined || pre.localName !== 'pre') {
    return undefined;
  }
  const codes = [...pre.children].filter((child) => child.localName === 'code');
  if (codes.length === 0) {
    return undefined;
  }
  const trailing = findTrailingPreBreak(pre);

  const empty = findEmptyCodeAt(root, range);
  if (empty !== undefined) {
    const edge: BoundaryPoint = kind.backward ? { node: pre, offset: 0 } : { node: pre, offset: pre.childNodes.length };
    if (!hasContentBetween(caretPoint(range), edge, trailing)) {
      return undefined;
    }
    const extent = readDeletionExtent(root, range, kind);
    return extent === undefined ? undefined : { code: empty, extent };
  }

  const own = codes.find((code) => code.contains(range.startContainer));
  if (own !== undefined) {
    const behind: BoundaryPoint = kind.backward
      ? { node: own, offset: own.childNodes.length }
      : { node: own, offset: 0 };
    if (hasContentBetween(caretPoint(range), behind, trailing)) {
      // Content remains on the side opposite the direction, so this delete does not empty `code`.
      return undefined;
    }
  }

  const extent = readDeletionExtent(root, range, kind);
  if (extent === undefined) {
    return undefined;
  }
  const covered = codes.find((code) => coversCodeContents(code, extent));
  return covered === undefined ? undefined : { code: covered, extent };
}

/**
 * Finds the deletion extent with the same selection extension as the browser delete.
 *
 * Graphemes, words and line edges depend on visual wrapping and character composition, so they cannot be reproduced here. The selection is extended
 * in the delete direction by the granularity and read, then the selection and the input dispatcher range are restored to the original caret.
 *
 * @param root The editor root.
 * @param range The selection range. Restored to its original position after reading.
 * @param kind The delete kind.
 * @returns A copy of the deletion extent, or `undefined` when there is a range selection, in environments without selection extension (such as jsdom), 
 *   or when it did not extend.
 */
export function readDeletionExtent(root: Element, range: Range, kind: DeleteKind): Range | undefined {
  const selection = root.ownerDocument.defaultView?.getSelection();
  if (
    !range.collapsed
    || selection === null
    || selection === undefined
    || typeof selection.modify !== 'function'
  ) {
    return undefined;
  }

  const container = range.startContainer;
  const offset = range.startOffset;
  placeCaret(container, offset);
  selection.modify('extend', kind.backward ? 'backward' : 'forward', kind.granularity);
  const extent = selection.rangeCount === 0 ? undefined : selection.getRangeAt(0).cloneRange();
  placeCaret(container, offset);
  range.setStart(container, offset);
  range.collapse(true);
  return extent === undefined || extent.collapsed ? undefined : extent;
}

/**
 * Determines whether the deletion extent contains all of the `code` content.
 *
 * The trailing pre break forms no line, so it is not counted as content.
 *
 * @param code The `code` to inspect.
 * @param extent The deletion extent.
 * @returns `true` if all text with length and all `br`, `img` and `comment` elements are within the extent. `false` if there is
 *   no content.
 */
export function coversCodeContents(code: Element, extent: Range): boolean {
  const pre = code.parentElement;
  const trailing = pre === null ? undefined : findTrailingPreBreak(pre);
  const walker = code.ownerDocument.createTreeWalker(
    code,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => (node instanceof Element && COMMENT_TEXT_TAG_NAMES.has(node.localName)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT),
    },
  );

  let found = false;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text) {
      const end = trailing?.text === node ? trailing.offset : node.data.length;
      if (end === 0) {
        continue;
      }
      found = true;
      if (extent.comparePoint(node, 0) !== 0 || extent.comparePoint(node, end) !== 0) {
        return false;
      }
      continue;
    }
    if (node instanceof Element && node.matches(CODE_CONTENT_SELECTOR)) {
      found = true;
      if (!containsNode(extent, node)) {
        return false;
      }
    }
  }
  return found;
}

/**
 * Deletes only the content within the deletion extent and keeps the `code` element.
 *
 * When the extent reaches outside `code` (line deletes, or deleting content outside `code`), the outside is deleted too, but even if the extent
 * contains the whole `code`, the element is not deleted. The trailing pre break is kept. No placeholder is inserted. Subsequent keystrokes and IME input
 * are put into `code` by the empty code position rule and the composition start handling.
 *
 * @param clearing The `code` to keep and the deletion extent.
 * @param range The range carried by the input dispatcher. Placed at the start inside `code`, like the caret.
 * @param progress The progress recording whether the tree changed.
 */
export function clearCodeContents(clearing: CodeClearing, range: Range, progress: BlockRewriteProgress): void {
  const { code, extent } = clearing;
  const pre = code.parentElement;
  if (pre === null) {
    return;
  }
  const document = code.ownerDocument;
  const index = [...pre.childNodes].indexOf(code);

  let end: BoundaryPoint = { node: extent.endContainer, offset: extent.endOffset };
  const trailing = findTrailingPreBreak(pre);
  if (trailing !== undefined && extent.comparePoint(trailing.text, trailing.offset + 1) === 0
    && extent.comparePoint(trailing.text, trailing.offset) === 0) {
    end = { node: trailing.text, offset: trailing.offset };
  }
  const start: BoundaryPoint = { node: extent.startContainer, offset: extent.startOffset };

  // Delete before, inside and after `code` separately. Deleting all at once would also delete the `code` element the range contains whole.
  const pieces = [
    createPiece(document, start, earlier({ node: pre, offset: index }, end)),
    createPiece(document, later(start, { node: code, offset: 0 }), earlier(end, { node: code, offset: code.childNodes.length })),
    createPiece(document, later(start, { node: pre, offset: index + 1 }), end),
  ];
  // Set the progress before deleting, so that what was deleted can be closed as a change even if an exception occurs partway.
  progress.changed = true;
  for (const piece of pieces) {
    piece?.deleteContents();
  }

  placeCaret(code, 0);
  range.setStart(code, 0);
  range.collapse(true);
}

/**
 * Replaces a blank code block with an empty paragraph.
 *
 * A blank code block cannot be merged with anything, so there is no way to delete it. Block conversion is called with the rule trigger and replaces it
 * regardless of the adjacent block. Attribute carry-over and selection restore follow block conversion, and the edit attempt opened by the input dispatcher is used.
 *
 * @param ports The block command ports.
 * @returns `true` if the tree changed.
 */
export function replaceBlankCodeBlock(ports: BlockCommandPorts): boolean {
  return runBlockOperation(ports, { kind: 'convert', to: BLOCK_KIND.paragraph }, 'rule');
}

/**
 * Returns the start of a range as a point.
 *
 * @param range The range.
 * @returns The start.
 */
function caretPoint(range: Range): BoundaryPoint {
  return { node: range.startContainer, offset: range.startOffset };
}

/**
 * Determines whether there is `pre` content between two points.
 *
 * @param first One point.
 * @param second The other point.
 * @param trailing The trailing pre break. Not counted as content.
 * @returns `true` if there is text with length or a `br`, `img` or `comment` element.
 */
function hasContentBetween(
  first: BoundaryPoint,
  second: BoundaryPoint,
  trailing: TrailingPreBreak | undefined,
): boolean {
  const document = first.node.ownerDocument;
  if (document === null) {
    return false;
  }
  const probe = document.createRange();
  probe.setStart(earlier(first, second).node, earlier(first, second).offset);
  probe.setEnd(later(first, second).node, later(first, second).offset);
  if (trailing !== undefined && probe.comparePoint(trailing.text, trailing.offset) === 0
    && probe.comparePoint(trailing.text, trailing.offset + 1) === 0) {
    probe.setEnd(trailing.text, trailing.offset);
  }
  const fragment = probe.cloneContents();
  return (fragment.textContent ?? '').length > 0 || fragment.querySelector(CODE_CONTENT_SELECTOR) !== null;
}

/**
 * Returns whichever of two points comes first in document order.
 *
 * @param first One point.
 * @param second The other point.
 * @returns The earlier point.
 */
function earlier(first: BoundaryPoint, second: BoundaryPoint): BoundaryPoint {
  return comparePoints(first, second) <= 0 ? first : second;
}

/**
 * Returns whichever of two points comes later in document order.
 *
 * @param first One point.
 * @param second The other point.
 * @returns The later point.
 */
function later(first: BoundaryPoint, second: BoundaryPoint): BoundaryPoint {
  return comparePoints(first, second) >= 0 ? first : second;
}

/**
 * Compares the document order of two points.
 *
 * @param first One point.
 * @param second The other point.
 * @returns Negative if earlier, 0 if the same, positive if later.
 */
function comparePoints(first: BoundaryPoint, second: BoundaryPoint): number {
  const document = first.node.ownerDocument;
  if (document === null) {
    return 0;
  }
  const probe = document.createRange();
  probe.setStart(first.node, first.offset);
  // comparePoint returns 1 if the point is after the range. The range is collapsed to `first`, so the sign is inverted.
  return -probe.comparePoint(second.node, second.offset);
}

/**
 * Creates the range between two points.
 *
 * @param document The document.
 * @param start The start.
 * @param end The end.
 * @returns The range, or `undefined` if the start is not before the end.
 */
function createPiece(document: Document, start: BoundaryPoint, end: BoundaryPoint): Range | undefined {
  if (comparePoints(start, end) >= 0) {
    return undefined;
  }
  const piece = document.createRange();
  piece.setStart(start.node, start.offset);
  piece.setEnd(end.node, end.offset);
  return piece;
}
