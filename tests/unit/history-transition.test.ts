// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  HISTORY_DIRECTION,
  HISTORY_TRANSITION_REJECTION,
  decideHistoryTransition,
  findRecordedEditRange,
  matchesIgnoringLineEndings,
} from '../../common/index';
import type { HistoryTransitionInput } from '../../common/index';

// Put a line between the two paragraphs. Adjacent lines often form one structure and cannot be mechanically
// merged as separate changes, so the source-side and view-side changes are kept apart.
const BASE = '<!DOCTYPE html>\n<html>\n<body>\n<p>one</p>\n<hr>\n<p>two</p>\n</body>\n</html>\n';
const VIEW_EDITED = BASE.replace('<p>one</p>', '<p>ONE</p>');
const SOURCE_EDITED = BASE.replace('<p>two</p>', '<p>TWO</p>');
const BOTH_EDITED = SOURCE_EDITED.replace('<p>one</p>', '<p>ONE</p>');
const SOURCE_SAME_LINE = BASE.replace('<p>one</p>', '<p>SOURCE</p>');

function input(overrides: Partial<HistoryTransitionInput> = {}): HistoryTransitionInput {
  return {
    recordedBefore: BASE,
    recordedAfter: VIEW_EDITED,
    currentView: VIEW_EDITED,
    syncBase: BASE,
    currentSource: BASE,
    direction: HISTORY_DIRECTION.undo,
    ...overrides,
  };
}

describe('history transition candidate decision', () => {
  it('uses the recorded before state as the undo candidate when the source matches the sync base', () => {
    const result = decideHistoryTransition(input());

    expect(result).toEqual({
      kind: 'candidate',
      text: BASE,
      editRange: { start: 3, count: 1 },
      hasConflict: false,
    });
  });

  it('treats full texts differing only in line endings as a match and applies directly without merging', () => {
    const crlfView = VIEW_EDITED.replace(/\n/g, '\r\n');
    const result = decideHistoryTransition(input({ currentView: crlfView }));

    expect(matchesIgnoringLineEndings(crlfView, VIEW_EDITED)).toBe(true);
    // With only a line ending difference, skip the merge and use the recorded opposite endpoint as the candidate.
    expect(result).toMatchObject({ kind: 'candidate', text: BASE, hasConflict: false });
  });

  it('keeps in the candidate a source change to a different line made after the sync base', () => {
    const result = decideHistoryTransition(input({ currentSource: SOURCE_EDITED }));

    expect(result).toMatchObject({
      kind: 'candidate',
      text: SOURCE_EDITED,
      hasConflict: false,
    });
  });

  it('keeps both the source side and the view side when both changed the same line', () => {
    const result = decideHistoryTransition(input({ currentSource: SOURCE_SAME_LINE }));

    expect(result).toMatchObject({ kind: 'candidate', hasConflict: true });
    const text = result.kind === 'candidate' ? result.text : '';
    // Source-side lines come first and view-side lines after. Neither is silently discarded.
    expect(text).toContain('<p>SOURCE</p>');
    expect(text).toContain('<p>one</p>');
    expect(text.indexOf('<p>SOURCE</p>')).toBeLessThan(text.indexOf('<p>one</p>'));
  });

  it('rejects without a candidate when the input has no sync base', () => {
    const result = decideHistoryTransition(input({ syncBase: undefined }));

    expect(result).toEqual({
      kind: 'rejected',
      reason: HISTORY_TRANSITION_REJECTION.syncBaseMissing,
    });
  });

  it('returns the edit range relative to the after state for redo and the before state for undo', () => {
    const before = 'a\nb\nc\n';
    const after = 'a\nB1\nB2\nc\n';

    expect(findRecordedEditRange(before, after, HISTORY_DIRECTION.undo))
      .toEqual({ start: 1, count: 1 });
    expect(findRecordedEditRange(before, after, HISTORY_DIRECTION.redo))
      .toEqual({ start: 1, count: 2 });
  });

  it('moves forward to the recorded after state on redo while keeping the source change', () => {
    const result = decideHistoryTransition(input({
      currentView: BASE,
      currentSource: SOURCE_EDITED,
      direction: HISTORY_DIRECTION.redo,
    }));

    expect(result).toMatchObject({ kind: 'candidate', text: BOTH_EDITED, hasConflict: false });
  });
});
