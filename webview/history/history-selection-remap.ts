import { splitDocument, splitLines } from '../../common/index';
import type { EncodedSelection, LineRange } from '../../common/index';
import { remapPosition, remapSelection } from '../selection/position-remap';

/** Input for remapping a recorded selection onto the body of the candidate actually applied. */
export interface HistorySelectionInput {
  /** Full document text of the target endpoint (LF). */
  readonly targetText: string;
  /** Selection on the target endpoint's body, or `null` if it could not be captured. */
  readonly targetSelection: EncodedSelection | null;
  /** Full document text of the candidate applied to the view (LF). */
  readonly candidateText: string;
  /** Line range of the recorded edit, relative to the target endpoint's full document text. */
  readonly editRange: LineRange;
}

/**
 * Counts the lines from the start of the full document text to the first line of the body.
 *
 * @param prologue Prologue.
 * @returns Number of line breaks the prologue occupies.
 */
function countPrologueLineBreaks(prologue: string): number {
  return splitLines(prologue).length - 1;
}

/**
 * Remaps a recorded selection onto the candidate, working on bodies split at the document boundary.
 *
 * The selection is in body coordinates, so if a later source change adds lines to the prologue or before the
 * body, restoring it as-is would point at a different line. Splitting both full texts into bodies before
 * remapping avoids that.
 *
 * @param input Target endpoint full text and selection, candidate full text, and edit range.
 * @returns Selection on the candidate body, or `undefined` if a boundary cannot be split.
 */
export function remapHistorySelection(input: HistorySelectionInput): EncodedSelection | undefined {
  const target = splitDocument(input.targetText);
  const candidate = splitDocument(input.candidateText);
  if (target === undefined || candidate === undefined) {
    // Coordinates are meaningless in full text whose body range cannot be determined. Selecting the default
    // position is left to the restoring side.
    return undefined;
  }

  const selection = input.targetSelection;
  if (selection !== null) {
    const remapped = remapSelection(selection, target.body, candidate.body);
    if (remapped !== undefined) {
      return remapped;
    }
  }

  // With no recorded selection, or one that cannot be remapped, collapse to the start of the recorded edit.
  // As long as the edited place is visible, the user can carry on even without both selection ends restored.
  const bodyLine = Math.max(0, input.editRange.start - countPrologueLineBreaks(target.prologue));
  const position = remapPosition(
    { line: bodyLine, column: 0 },
    splitLines(target.body),
    splitLines(candidate.body),
  );
  return { start: position, end: position };
}
