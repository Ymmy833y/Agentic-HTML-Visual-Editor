import type { EncodedPosition, EncodedSelection } from '../../common/index';

export type { EncodedPosition, EncodedSelection } from '../../common/index';

/** A DOM boundary. This has the same meaning as a `Range` boundary and represents positions within text and between an element's children. */
export interface NodeBoundary {
  /** The node containing the boundary. */
  readonly container: Node;
  /** A character offset for text, or a child offset for an element. */
  readonly offset: number;
}

/**
 * An encoded position.
 *
 * This does not refer to the DOM tree structure (node references or child-element paths) at all.
 * Replacing the entire tree invalidates both node references and child paths, so this represents
 * a position using only coordinates in the body text.
 */
/** A captured selection and the old text at capture time. Never retained across calls. */
export interface CapturedSelection {
  /** The encoded selection. */
  readonly selection: EncodedSelection;
  /** The current form at capture time, used as the source for remapping. */
  readonly text: string;
}

/**
 * Converts a character offset to a line number and an offset within that line.
 *
 * The entire text is already normalized to LF, so this counts LF line endings only.
 *
 * @param text The string containing the character offset.
 * @param offset The character offset.
 * @returns The line number and offset within the line. An out-of-range offset is clamped to the end.
 */
export function toEncodedPosition(text: string, offset: number): EncodedPosition {
  const clamped = Math.min(Math.max(offset, 0), text.length);
  const head = text.slice(0, clamped);
  const lastBreak = head.lastIndexOf('\n');

  return { line: head.split('\n').length - 1, column: clamped - lastBreak - 1 };
}

/**
 * Converts a line number and offset within the line back to a character offset.
 *
 * This round-trips with `toEncodedPosition` for the same string.
 *
 * @param text The string containing the character offset.
 * @param position The line number and offset within the line.
 * @returns The character offset. Returns `undefined` if the line does not exist. An offset beyond the line length is clamped to the line end.
 */
export function toCharacterOffset(text: string, position: EncodedPosition): number | undefined {
  const lines = text.split('\n');
  if (position.line < 0 || position.line >= lines.length) {
    return undefined;
  }

  let offset = 0;
  for (let index = 0; index < position.line; index += 1) {
    // Add the removed line-ending character to the line length.
    offset += lines[index].length + 1;
  }
  return offset + Math.min(Math.max(position.column, 0), lines[position.line].length);
}
