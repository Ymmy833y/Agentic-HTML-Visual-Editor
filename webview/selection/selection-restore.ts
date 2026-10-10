import { createSerializationTemplate } from '../document/body-serializer';
import { removeEditingArtifacts } from '../document/editing-artifact';
import { createMappedCopy } from '../document/inverse-transform';
import { placeCaretAtStart } from '../editing/caret';
import {
  SELECTION_MARKER_DATA,
  insertSelectionMarker,
  readMarkerOffsets,
} from './selection-marker';
import { toCharacterOffset } from './selection-position';
import type { EncodedSelection, NodeBoundary } from './selection-position';

/**
 * Elements that cannot have content.
 *
 * Serialization does not output children of these elements, so a marker inserted inside one would
 * disappear from the string and cause a count mismatch. These positions are not candidates, so the
 * traversal does not descend into them.
 */
const VOID_TAG_NAMES: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/** Candidate boundaries in the copy and an index of their character offsets. */
export interface BoundaryIndex {
  /** The string without markers. This matches the current form of the same tree. */
  readonly text: string;
  /** Candidate boundaries in document order, containing only positions between element children. */
  readonly candidates: readonly NodeBoundary[];
  /** Each candidate's character offset in `text`, in the same order as `candidates`. */
  readonly offsets: readonly number[];
  /** A map from nodes in the copy to nodes in the live tree. */
  readonly copyToLive: ReadonlyMap<Node, Node>;
}

/**
 * Collects positions between element children in document order.
 *
 * Both ends of text are represented as positions between the parent's children that surround the
 * text. Positions within text are not candidates and are resolved later through local serialization.
 *
 * @param parent The container to traverse.
 * @param collected The collected candidates.
 */
function collectCandidates(parent: Node, collected: NodeBoundary[]): void {
  const children = parent.childNodes;
  for (let index = 0; index < children.length; index += 1) {
    collected.push({ container: parent, offset: index });
    const child = children[index];
    if (child instanceof Element && !VOID_TAG_NAMES.has(child.localName)) {
      collectCandidates(child, collected);
    }
  }
  collected.push({ container: parent, offset: children.length });
}

/**
 * Inserts markers at every candidate boundary and builds a character-offset index in one serialization.
 *
 * Markers are inserted after editing-artifact removal, so they do not need to be hoisted from empty
 * inline elements.
 *
 * @param root The editor root.
 * @returns The index, or `undefined` if the marker count does not match.
 */
export function createBoundaryIndex(root: Element): BoundaryIndex | undefined {
  const { copy, copyToLive } = createMappedCopy(root);
  removeEditingArtifacts(copy);

  const template = createSerializationTemplate(copy);
  const content = template.content;
  const liveMap = new Map(copyToLive);
  // Moving the children to the serialization container makes its content the root of the copy.
  liveMap.set(content, root);

  const candidates: NodeBoundary[] = [];
  collectCandidates(content, candidates);

  // Insert from the end because earlier insertions would shift later child offsets in the same container.
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    insertSelectionMarker(candidates[index]);
  }

  const markers = readMarkerOffsets(template.innerHTML, candidates.length);
  if (markers === undefined) {
    return undefined;
  }

  // Candidates use child offsets from before insertion, so restore the tree before using them.
  // Since the count matches, every marker found is one that was inserted here.
  removeMarkers(content);

  return { text: markers.text, candidates, offsets: markers.offsets, copyToLive: liveMap };
}

/**
 * Removes all markers from the copy.
 *
 * @param parent The container to traverse.
 */
function removeMarkers(parent: Node): void {
  for (const child of [...parent.childNodes]) {
    if (child instanceof Comment) {
      if (child.data === SELECTION_MARKER_DATA) {
        child.remove();
      }
      continue;
    }
    removeMarkers(child);
  }
}

/**
 * Resolves a position within a text node from its serialized length to a raw character offset.
 *
 * Instead of reimplementing escape rules, this serializes prefixes of the text and compares their
 * lengths. Escaping makes the length increase monotonically, so binary search can find the smallest
 * raw offset that reaches the target length.
 *
 * @param text The target text node.
 * @param serializedLength The serialized length measured from the start of the text.
 * @returns The raw character offset. Returns the end if the length exceeds the complete text.
 */
export function resolveTextOffset(text: Text, serializedLength: number): number {
  const ownerDocument = text.ownerDocument;
  if (ownerDocument === null) {
    return 0;
  }

  const probe = ownerDocument.createElement('template');
  const lengthOf = (value: string): number => {
    probe.content.replaceChildren(ownerDocument.createTextNode(value));
    return probe.innerHTML.length;
  };

  let low = 0;
  let high = text.data.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lengthOf(text.data.slice(0, middle)) < serializedLength) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * Finds a boundary in the copy from a character offset.
 *
 * A position that does not match a candidate is treated as being inside a tag. It is clamped inside
 * an element that can have content, or immediately before an element that cannot. Clamping a changed
 * line segment to its start commonly places the position within a start tag. Treating that as not
 * found would move the caret to the start of the document after every such replacement.
 *
 * @param index The boundary index.
 * @param offset A character offset in the index's string.
 * @returns A boundary in the copy. An offset beyond the end returns the last candidate.
 */
export function findBoundaryAtOffset(index: BoundaryIndex, offset: number): NodeBoundary {
  let found = 0;
  for (let position = index.offsets.length - 1; position >= 0; position -= 1) {
    if (index.offsets[position] <= offset) {
      found = position;
      break;
    }
  }

  const candidate = index.candidates[found];
  const distance = offset - index.offsets[found];
  if (distance === 0) {
    return candidate;
  }

  const following = candidate.container.childNodes[candidate.offset] ?? null;
  if (following instanceof Text) {
    return { container: following, offset: resolveTextOffset(following, distance) };
  }
  if (following instanceof Element && !VOID_TAG_NAMES.has(following.localName)) {
    // Inside a start tag. Place the boundary before the element's first child.
    return { container: following, offset: 0 };
  }
  // This is inside an end tag or a tag for an element that cannot have content. In both cases the
  // preceding candidate is a valid boundary; the latter cannot contain a selection, so place it before.
  return candidate;
}

/**
 * Maps a boundary in the copy to a boundary in the live tree using the mapped copy.
 *
 * A child offset from the copy cannot be used directly for an element boundary because elements
 * removed as editing artifacts shift that offset. Find the corresponding live child and use its
 * position instead.
 *
 * @param index The boundary index.
 * @param boundary The boundary in the copy.
 * @returns A boundary in the live tree, or `undefined` if it is absent from the mapped copy.
 */
export function toLiveBoundary(
  index: BoundaryIndex,
  boundary: NodeBoundary,
): NodeBoundary | undefined {
  const live = index.copyToLive.get(boundary.container);
  if (live === undefined) {
    return undefined;
  }
  if (boundary.container instanceof Text) {
    return { container: live, offset: boundary.offset };
  }

  const child = boundary.container.childNodes[boundary.offset];
  if (child === undefined) {
    // The end of the container is immediately after its last remaining child.
    return { container: live, offset: live.childNodes.length };
  }

  const liveChild = index.copyToLive.get(child);
  if (liveChild === undefined) {
    return undefined;
  }
  const position = [...live.childNodes].findIndex((node) => node === liveChild);
  return position === -1 ? undefined : { container: live, offset: position };
}

/**
 * Creates a `Range` from two live-tree boundaries and replaces the selection with it.
 *
 * Returns whether the selection was replaced. Silently swallowing a failure would leave the selection
 * pointing at the old tree discarded by document replacement. Reporting success lets the caller fall
 * back to a safe position.
 *
 * @param start The start boundary.
 * @param end The end boundary.
 * @returns `true` if the selection was replaced; `false` without changing it if a boundary is invalid.
 */
export function applySelection(start: NodeBoundary, end: NodeBoundary): boolean {
  const ownerDocument = start.container.ownerDocument;
  if (ownerDocument === null) {
    return false;
  }
  const selection = ownerDocument.defaultView?.getSelection();
  if (selection === null || selection === undefined) {
    return false;
  }

  const range = ownerDocument.createRange();
  try {
    range.setStart(start.container, start.offset);
    range.setEnd(end.container, end.offset);
  } catch {
    // Leave the selection unchanged if a boundary is invalid for this tree.
    return false;
  }

  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * Applies an encoded selection to the tree after document replacement.
 *
 * If the index cannot be built, an offset cannot be found, only one endpoint can be mapped, or the
 * selection cannot be applied, this falls back to the start of the editor root without throwing.
 *
 * @param root The editor root.
 * @param selection The encoded selection, or `undefined` if none was captured.
 */
export function restoreSelection(root: Element, selection: EncodedSelection | undefined): void {
  if (selection === undefined) {
    placeCaretAtStart(root);
    return;
  }

  const boundaries = resolveLiveBoundaries(root, selection);
  if (boundaries === undefined || !applySelection(boundaries.start, boundaries.end)) {
    placeCaretAtStart(root);
  }
}

/**
 * Turns an encoded selection into a range in the current tree without changing the selection.
 *
 * Positions are resolved the same way as in `restoreSelection`. Resolving them separately would make the position
 * restored as the selection differ from the position kept as a range.
 *
 * @param root The editor root.
 * @param selection The encoded selection.
 * @returns The range in the current tree. `undefined` if either end cannot be determined.
 */
export function resolveSelectionRange(root: Element, selection: EncodedSelection): Range | undefined {
  const boundaries = resolveLiveBoundaries(root, selection);
  if (boundaries === undefined) {
    return undefined;
  }
  const range = root.ownerDocument.createRange();
  try {
    range.setStart(boundaries.start.container, boundaries.start.offset);
    range.setEnd(boundaries.end.container, boundaries.end.offset);
  } catch {
    return undefined;
  }
  return range;
}

/**
 * Resolves both ends of an encoded selection through the boundary index, then character offsets, then node
 * boundaries in the live tree.
 *
 * @param root The editor root.
 * @param selection The encoded selection.
 * @returns Both ends in the live tree. `undefined` if the index cannot be built or either end cannot be determined.
 */
function resolveLiveBoundaries(
  root: Element,
  selection: EncodedSelection,
): { readonly start: NodeBoundary; readonly end: NodeBoundary } | undefined {
  const index = createBoundaryIndex(root);
  if (index === undefined) {
    return undefined;
  }

  const startOffset = toCharacterOffset(index.text, selection.start);
  const endOffset = toCharacterOffset(index.text, selection.end);
  if (startOffset === undefined || endOffset === undefined) {
    return undefined;
  }

  const start = toLiveBoundary(index, findBoundaryAtOffset(index, startOffset));
  const end = toLiveBoundary(index, findBoundaryAtOffset(index, endOffset));
  // Even if only one end is determined, no partial range is made. It is treated as undetermined so that callers can
  // fall back to the safe position.
  if (start === undefined || end === undefined) {
    return undefined;
  }
  return { start, end };
}
