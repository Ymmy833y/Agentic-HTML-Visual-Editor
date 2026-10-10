import { diffLines } from '../text/line-diff';
import type { LineRange } from '../text/line-diff';
import { normalizeLineEndings } from '../text/line-ending';
import { splitLines } from '../text/lines';
import { flattenMergeRegions, mergeThreeWay } from '../text/three-way-merge';

/** Whether to move toward undo or redo. */
export const HISTORY_DIRECTION = {
  undo: 'undo',
  redo: 'redo',
} as const;

/** Direction of a history transition. Undo targets the before endpoint; redo targets the after endpoint. */
export type HistoryDirection = (typeof HISTORY_DIRECTION)[keyof typeof HISTORY_DIRECTION];

/** Input for deciding a history transition candidate. Every text is full document text, not just the body. */
export interface HistoryTransitionInput {
  /** Recorded full text before the change. */
  readonly recordedBefore: string;
  /** Recorded full text after the change. */
  readonly recordedAfter: string;
  /** Full text of the current view. */
  readonly currentView: string;
  /** Full text on which the source and the view last agreed. `undefined` before initialization. */
  readonly syncBase: string | undefined;
  /** Current clean source full text. */
  readonly currentSource: string;
  readonly direction: HistoryDirection;
}

/** Reasons a candidate cannot be returned. */
export const HISTORY_TRANSITION_REJECTION = {
  syncBaseMissing: 'syncBaseMissing',
} as const;

/** Reason a history transition was rejected. */
export type HistoryTransitionRejection =
  (typeof HISTORY_TRANSITION_REJECTION)[keyof typeof HISTORY_TRANSITION_REJECTION];

/** A candidate that may be applied. */
export interface HistoryTransitionCandidate {
  readonly kind: 'candidate';
  /** Full text to apply to the view (LF). */
  readonly text: string;
  /** Line range of the recorded edit, relative to the target endpoint's full text. */
  readonly editRange: LineRange;
  /**
   * Whether it contains conflict regions. Only a save asks the user to choose; an undo or redo keeps both sides so that
   * neither is dropped without the user knowing.
   */
  readonly hasConflict: boolean;
}

/** Result of finishing without producing a candidate. */
export interface HistoryTransitionRejected {
  readonly kind: 'rejected';
  readonly reason: HistoryTransitionRejection;
}

/** Result of deciding a history transition. */
export type HistoryTransitionResult = HistoryTransitionCandidate | HistoryTransitionRejected;

/**
 * Returns whether two full texts match except for line endings.
 *
 * @param left Full text to compare.
 * @param right Full text to compare against.
 * @returns `true` when they match with line ending spelling ignored.
 */
export function matchesIgnoringLineEndings(left: string, right: string): boolean {
  return normalizeLineEndings(left) === normalizeLineEndings(right);
}

/**
 * Collapses the recorded before/after diff into a single edit range on the target endpoint side.
 *
 * Even when edit locations are far apart, they become one range that includes everything in between. Only one
 * position can be chosen to return the caret to, and returning several ranges would just add another choice
 * to make.
 *
 * @param recordedBefore Recorded full text before the change.
 * @param recordedAfter Recorded full text after the change.
 * @param direction Direction of the history transition.
 * @returns Line range on the target endpoint's full text, or an empty range at the start when there is no diff.
 */
export function findRecordedEditRange(
  recordedBefore: string,
  recordedAfter: string,
  direction: HistoryDirection,
): LineRange {
  const segments = diffLines(
    splitLines(normalizeLineEndings(recordedBefore)),
    splitLines(normalizeLineEndings(recordedAfter)),
  );
  if (segments.length === 0) {
    return { start: 0, count: 0 };
  }

  // The first side of the diff holds before coordinates and the second holds after coordinates. Take the
  // target endpoint's side.
  const useBefore = direction === HISTORY_DIRECTION.undo;
  const first = useBefore ? segments[0].first : segments[0].second;
  const lastSegment = segments[segments.length - 1];
  const last = useBefore ? lastSegment.first : lastSegment.second;

  return { start: first.start, count: last.start + last.count - first.start };
}

/**
 * Determines the current effective content and decides a history transition candidate by either direct
 * application or merge.
 *
 * Treating only unsaved edits as the current source would drop external changes, while treating only the disk
 * as current would wrongly count edits made before saving as conflicts. So the current source and current view
 * are reconciled first with the sync base as the common ancestor, and the result, as the effective content,
 * is used to decide the transition between history endpoints.
 *
 * @param input Recorded before/after full texts, current view, sync base, current source, and direction.
 * @returns Candidate to apply, or the rejection reason. The input is not modified.
 */
export function decideHistoryTransition(input: HistoryTransitionInput): HistoryTransitionResult {
  const syncBase = input.syncBase;
  if (syncBase === undefined) {
    // Without a common ancestor, source-side changes cannot be isolated. Using the source in place of the
    // ancestor would swallow changes not yet synced as if they were already synced.
    return { kind: 'rejected', reason: HISTORY_TRANSITION_REJECTION.syncBaseMissing };
  }

  const useBefore = input.direction === HISTORY_DIRECTION.undo;
  const departure = normalizeLineEndings(useBefore ? input.recordedAfter : input.recordedBefore);
  const target = normalizeLineEndings(useBefore ? input.recordedBefore : input.recordedAfter);
  const editRange = findRecordedEditRange(
    input.recordedBefore,
    input.recordedAfter,
    input.direction,
  );

  let effective = normalizeLineEndings(input.currentView);
  let hasConflict = false;
  if (!matchesIgnoringLineEndings(input.currentSource, syncBase)) {
    const reconciled = mergeThreeWay(
      splitLines(normalizeLineEndings(syncBase)),
      splitLines(normalizeLineEndings(input.currentSource)),
      splitLines(effective),
    );
    effective = flattenMergeRegions(reconciled.regions);
    hasConflict = reconciled.hasConflict;
  }

  if (departure === effective) {
    // When the departure endpoint and the effective content differ only in line endings, the later merge
    // would just rebuild the same result at a higher cost.
    return { kind: 'candidate', text: target, editRange, hasConflict };
  }

  const merged = mergeThreeWay(
    splitLines(departure),
    splitLines(effective),
    splitLines(target),
  );
  return {
    kind: 'candidate',
    text: flattenMergeRegions(merged.regions),
    editRange,
    hasConflict: hasConflict || merged.hasConflict,
  };
}
