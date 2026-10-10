import { diffLines, splitLines } from '../../common/index';
import type { EncodedPosition, EncodedSelection } from './selection-position';

/**
 * Remaps one position using the line diff between the old and new text.
 *
 * Outside differing segments, the position shifts by the cumulative change in line count while its
 * offset within the line stays unchanged. Within a segment, the line content has changed and the
 * character corresponding to the original column no longer exists, so the position is clamped to
 * the segment start. If the entire line was deleted, it is clamped to the end of the preceding line,
 * or to the start of the new first line if there is no preceding line. Providing every clamp target
 * ensures that any deletion position produces valid coordinates without throwing.
 *
 * @param position The position to remap.
 * @param oldLines The lines of the old text.
 * @param newLines The lines of the new text.
 * @returns The new position. A position beyond the line count is clamped to the end of the last line.
 */
export function remapPosition(
  position: EncodedPosition,
  oldLines: readonly string[],
  newLines: readonly string[],
): EncodedPosition {
  let delta = 0;

  for (const segment of diffLines(oldLines, newLines)) {
    if (position.line >= segment.first.start + segment.first.count) {
      delta += segment.second.count - segment.first.count;
      continue;
    }
    if (position.line < segment.first.start) {
      break;
    }

    if (segment.second.count > 0) {
      return { line: segment.second.start, column: 0 };
    }
    if (segment.second.start === 0) {
      return { line: 0, column: 0 };
    }
    const previous = segment.second.start - 1;
    return { line: previous, column: newLines[previous].length };
  }

  const line = position.line + delta;
  if (line >= newLines.length) {
    const last = newLines.length - 1;
    return { line: last, column: newLines[last].length };
  }
  return { line, column: position.column };
}

/**
 * Determines whether a position precedes another in document order.
 *
 * @param position The position to compare.
 * @param other The position to compare against.
 * @returns `true` if the position precedes the other.
 */
function isBefore(position: EncodedPosition, other: EncodedPosition): boolean {
  return position.line < other.line
    || (position.line === other.line && position.column < other.column);
}

/**
 * Remaps an encoded selection to coordinates in the new text.
 *
 * @param selection The encoded selection.
 * @param oldText The current form at capture time.
 * @param newText The current form after document replacement.
 * @returns The new selection, or `undefined` when the new text is empty so the caller can use a safe position.
 */
export function remapSelection(
  selection: EncodedSelection,
  oldText: string,
  newText: string,
): EncodedSelection | undefined {
  if (newText.length === 0) {
    return undefined;
  }

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const start = remapPosition(selection.start, oldLines, newLines);
  const end = remapPosition(selection.end, oldLines, newLines);

  // Independent remapping can reverse the endpoints due to different clamping. Collapse the range instead of reversing it.
  return isBefore(end, start) ? { start, end: start } : { start, end };
}
