import { INLINE_FORMAT_TAG_NAMES } from '../document/editing-artifact';
import type { NodeBoundary } from './selection-position';

/**
 * The payload string of comment nodes inserted as markers.
 *
 * Markers are comment nodes because the decision to remove a trailing `br` checks the visibility
 * of adjacent nodes and ignores comment nodes from the outset. A regular element would count as a
 * "visible sibling," preventing a trailing `br` from being removed when it should be and shifting
 * the coordinate system.
 *
 * Every marker uses the same spelling, so their order in the serialized string is enough to
 * calculate their positions after removal using subtraction alone.
 */
export const SELECTION_MARKER_DATA = 'ahve-selection-boundary';

/** The serialized string for one marker. */
const SERIALIZED_MARKER = `<!--${SELECTION_MARKER_DATA}-->`;

/** The string without markers and each marker's character offset in document order. */
export interface MarkerOffsets {
  /** The string with the markers removed. */
  readonly text: string;
  /** Character offsets in `text`, in document order. */
  readonly offsets: readonly number[];
}

/**
 * Inserts a marker at a boundary in the copy.
 *
 * Never call this on the live tree. When inserting multiple markers into the same text node,
 * insert the later boundary first so splitting does not change the earlier boundary's offset.
 *
 * @param boundary The boundary in the copy.
 */
export function insertSelectionMarker(boundary: NodeBoundary): void {
  const ownerDocument = boundary.container.ownerDocument;
  if (ownerDocument === null) {
    return;
  }

  const marker = ownerDocument.createComment(SELECTION_MARKER_DATA);
  const container = boundary.container;
  if (container instanceof Text) {
    // The position immediately before the second node created by the split is the original character offset.
    const following = container.splitText(boundary.offset);
    following.parentNode?.insertBefore(marker, following);
    return;
  }
  container.insertBefore(marker, container.childNodes[boundary.offset] ?? null);
}

/**
 * Determines whether a node is a marker.
 *
 * @param node The node to inspect.
 * @returns `true` if the node is a marker.
 */
function isSelectionMarker(node: Node): boolean {
  return node instanceof Comment && node.data === SELECTION_MARKER_DATA;
}

/**
 * Determines whether a node is an empty inline element that editing-artifact removal will remove as-is.
 *
 * @param node The node to inspect.
 * @returns `true` if the node is a removable empty inline element.
 */
function isRemovableEmptyInline(node: Node): boolean {
  return node instanceof Element
    && INLINE_FORMAT_TAG_NAMES.has(node.localName)
    && node.attributes.length === 0
    && node.childNodes.length === 0;
}

/**
 * Determines whether an element contains only markers and empty inline elements that will themselves be removed.
 *
 * @param element The element to inspect.
 * @returns `true` if hoisting its contents would leave nothing behind.
 */
function holdsOnlyMarkers(element: Element): boolean {
  return [...element.childNodes].every(
    (child) => isSelectionMarker(child) || isRemovableEmptyInline(child),
  );
}

/**
 * Collects markers from the copy in document order.
 *
 * @param parent The traversal root.
 * @param collected The collected markers.
 */
function collectMarkers(parent: Node, collected: Comment[]): void {
  for (const child of parent.childNodes) {
    if (child instanceof Comment) {
      if (child.data === SELECTION_MARKER_DATA) {
        collected.push(child);
      }
      continue;
    }
    collectMarkers(child, collected);
  }
}

/**
 * Hoists markers from empty inline elements containing only markers to immediately before each element.
 *
 * Removal of an empty inline element depends on its own child count, not adjacent nodes. Simply
 * adding a marker as a child would prevent removal and make the string without markers differ from
 * the actual current form. Hoisting the marker before the removal check allows the element to be
 * removed for the same reason with or without markers. The removed element has zero visual width,
 * so the hoisted location matches the character offset after removal.
 *
 * If hoisting leaves an outer element in the same state, repeat outward.
 *
 * @param root The copy before editing-artifact removal.
 */
export function hoistMarkersFromEmptyInline(root: ParentNode): void {
  const markers: Comment[] = [];
  collectMarkers(root, markers);

  for (const marker of markers) {
    let parent = marker.parentNode;
    while (
      parent instanceof Element
      && INLINE_FORMAT_TAG_NAMES.has(parent.localName)
      && parent.attributes.length === 0
      && holdsOnlyMarkers(parent)
    ) {
      const grandParent = parent.parentNode;
      if (grandParent === null) {
        break;
      }
      grandParent.insertBefore(marker, parent);
      parent = grandParent;
    }
  }
}

/**
 * Removes markers from a serialized string and returns their character offsets in the resulting coordinate system.
 *
 * A count mismatch means the body originally contained a comment with the same spelling as the
 * marker. Because inserted markers cannot then be distinguished and the coordinates would be
 * incorrect, let the caller fall back instead of restoring the selection.
 *
 * @param text The serialized result containing markers.
 * @param expectedCount The number of inserted markers.
 * @returns The string and character offsets after marker removal, or `undefined` if the count differs.
 */
export function readMarkerOffsets(text: string, expectedCount: number): MarkerOffsets | undefined {
  const parts: string[] = [];
  const offsets: number[] = [];
  let length = 0;
  let searchFrom = 0;

  for (;;) {
    const found = text.indexOf(SERIALIZED_MARKER, searchFrom);
    if (found === -1) {
      break;
    }
    const part = text.slice(searchFrom, found);
    parts.push(part);
    length += part.length;
    offsets.push(length);
    searchFrom = found + SERIALIZED_MARKER.length;
  }
  parts.push(text.slice(searchFrom));

  if (offsets.length !== expectedCount) {
    return undefined;
  }
  return { text: parts.join(''), offsets };
}
