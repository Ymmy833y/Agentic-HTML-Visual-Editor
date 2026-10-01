// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { EncodedSelection } from '../../common/index';
import { remapHistorySelection } from '../../webview/history/history-selection-remap';

// The prologue spans 3 lines so the body starts on line 4 of the full document. The edit range is given in
// full document coordinates, so it has to be converted to body coordinates.
const PROLOGUE = '<!DOCTYPE html>\n<html>\n<body>';
const EPILOGUE = '</body>\n</html>\n';

/**
 * Builds full document text from a body.
 *
 * @param body Body.
 * @returns Full document text.
 */
function wrapBody(body: string): string {
  return `${PROLOGUE}${body}${EPILOGUE}`;
}

const TARGET = wrapBody('\n<p>one</p>\n<p>two</p>\n');
// Candidate where a later source change added one line near the top of the body. The recorded line shifts by one.
const SHIFTED = wrapBody('\n<p>added</p>\n<p>one</p>\n<p>two</p>\n');

const SELECTION_ON_TWO: EncodedSelection = {
  start: { line: 2, column: 3 },
  end: { line: 2, column: 6 },
};

describe('remapping a history selection onto the candidate', () => {
  it('keeps the column within the recorded line even when lines are added earlier in the candidate', () => {
    const remapped = remapHistorySelection({
      targetText: TARGET,
      targetSelection: SELECTION_ON_TWO,
      candidateText: SHIFTED,
      editRange: { start: 4, count: 1 },
    });

    expect(remapped).toEqual({
      start: { line: 3, column: 3 },
      end: { line: 3, column: 6 },
    });
  });

  it('collapses to a single safe point when the region containing the selection is gone from the candidate', () => {
    const removed = wrapBody('\n<p>one</p>\n');

    const remapped = remapHistorySelection({
      targetText: TARGET,
      targetSelection: SELECTION_ON_TWO,
      candidateText: removed,
      editRange: { start: 4, count: 1 },
    });

    expect(remapped?.start).toEqual(remapped?.end);
  });

  it('returns the remapped start of the edit range when there is no recorded selection', () => {
    const remapped = remapHistorySelection({
      targetText: TARGET,
      targetSelection: null,
      candidateText: SHIFTED,
      // The prologue occupies two line breaks, so line 4 of the full document is body line 2 (`<p>two</p>`).
      editRange: { start: 4, count: 1 },
    });

    expect(remapped).toEqual({
      start: { line: 3, column: 0 },
      end: { line: 3, column: 0 },
    });
  });

  it('returns no selection for full text whose boundary cannot be split, leaving the default position to the caller', () => {
    const remapped = remapHistorySelection({
      targetText: '<p>no body tags</p>',
      targetSelection: SELECTION_ON_TWO,
      candidateText: SHIFTED,
      editRange: { start: 0, count: 1 },
    });

    expect(remapped).toBeUndefined();
  });
});
