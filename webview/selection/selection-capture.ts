import { serializeBody } from '../document/body-serializer';
import { removeEditingArtifacts } from '../document/editing-artifact';
import { createMappedCopy } from '../document/inverse-transform';
import { readSelectionRange } from '../editing/caret';
import {
  hoistMarkersFromEmptyInline,
  insertSelectionMarker,
  readMarkerOffsets,
} from './selection-marker';
import type { MarkerOffsets } from './selection-marker';
import { toEncodedPosition } from './selection-position';
import type { CapturedSelection, NodeBoundary } from './selection-position';

/**
 * Inserts markers into a copy and runs it through the same process used to create output, producing
 * the string without markers and their character offsets.
 *
 * This uses the existing serialization process instead of reimplementing escaping or void-element
 * rules. Changing the order of insertion, hoisting, editing-artifact removal, and serialization
 * would make the string without markers differ from the actual current form.
 *
 * @param root The editor root.
 * @param boundaries Boundaries in the live tree, in document order.
 * @returns The string without markers and their character offsets, or `undefined` if a boundary is absent from the mapped copy or the count differs.
 */
export function serializeWithSelectionMarkers(
  root: Element,
  boundaries: readonly NodeBoundary[],
): MarkerOffsets | undefined {
  const { copy, liveToCopy } = createMappedCopy(root);

  const copied: NodeBoundary[] = [];
  for (const boundary of boundaries) {
    const container = liveToCopy.get(boundary.container);
    if (container === undefined) {
      return undefined;
    }
    copied.push({ container, offset: boundary.offset });
  }

  // Insert from the end so splitting text does not change an earlier boundary's offset in the same node.
  for (let index = copied.length - 1; index >= 0; index -= 1) {
    insertSelectionMarker(copied[index]);
  }

  hoistMarkersFromEmptyInline(copy);
  removeEditingArtifacts(copy);
  return readMarkerOffsets(serializeBody(copy), boundaries.length);
}

/**
 * Converts the live selection in the editor root to encoded positions and the old text.
 *
 * Captures only when both endpoints are within the editor root. Focus is ignored because a selection
 * that remains in the editor root can safely be captured even when focus has temporarily moved away.
 *
 * @param root The editor root.
 * @returns The encoded selection and old text, or `undefined` if the selection cannot be captured.
 */
export function captureSelection(root: Element): CapturedSelection | undefined {
  const range = readSelectionRange(root);
  if (range === undefined) {
    return undefined;
  }
  return captureRange(root, range);
}

/**
 * Converts a range into encoded positions and the old text, by the same rules as the live selection.
 *
 * Split out so that callers that capture a stored range later follow the same rules as capturing the live selection.
 *
 * @param root The editor root.
 * @param range The range to capture.
 * @returns The encoded selection and the old text. `undefined` when an end of the range is outside the editor root.
 */
export function captureRange(root: Element, range: Range): CapturedSelection | undefined {
  const boundaries: NodeBoundary[] = [
    { container: range.startContainer, offset: range.startOffset },
  ];
  if (!range.collapsed) {
    boundaries.push({ container: range.endContainer, offset: range.endOffset });
  }

  const markers = serializeWithSelectionMarkers(root, boundaries);
  if (markers === undefined) {
    return undefined;
  }

  const start = toEncodedPosition(markers.text, markers.offsets[0]);
  const end = markers.offsets.length > 1
    ? toEncodedPosition(markers.text, markers.offsets[1])
    : start;
  return { selection: { start, end }, text: markers.text };
}
