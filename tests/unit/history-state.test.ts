// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { HISTORY_DIRECTION } from '../../common/index';
import { DocumentHistoryState } from '../../src/history/history-state';
import type { HistoryPoint } from '../../src/history/history-state';

/**
 * Registers one entry. Assumes the state is not protected.
 *
 * @param state Target state.
 * @returns Registered history point.
 */
function register(state: DocumentHistoryState): HistoryPoint {
  const point = state.registerEntry();
  if (point === undefined) {
    throw new Error('The entry was not registered');
  }
  return point;
}

describe('save boundary and history point', () => {
  it('makes the current point the save point on a successful save', () => {
    const state = new DocumentHistoryState();
    register(state);
    register(state);
    expect(state.isAtSavePoint()).toBe(false);

    state.markSaved();

    expect(state.isAtSavePoint()).toBe(true);
  });

  it('matches the save boundary only for a history application that returns to the save point', () => {
    const state = new DocumentHistoryState();
    register(state);
    state.markSaved();
    const second = register(state);
    expect(state.isAtSavePoint()).toBe(false);

    state.markTransitionApplied(HISTORY_DIRECTION.undo, second);

    expect(state.isAtSavePoint()).toBe(true);
  });

  it('does not match after a history application that moves away from the save boundary', () => {
    const state = new DocumentHistoryState();
    const first = register(state);
    state.markSaved();
    expect(state.isAtSavePoint()).toBe(true);

    state.markTransitionApplied(HISTORY_DIRECTION.undo, first);

    expect(state.isAtSavePoint()).toBe(false);
  });

  it('does not match the save boundary after a new edit discards the redo branch containing the save point', () => {
    const state = new DocumentHistoryState();
    const first = register(state);
    const second = register(state);
    state.markSaved();
    state.markTransitionApplied(HISTORY_DIRECTION.undo, second);
    state.markTransitionApplied(HISTORY_DIRECTION.undo, first);

    // The deeper save point is inside the branch this edit discards.
    register(state);

    expect(state.isAtSavePoint()).toBe(false);
  });

  it('returns to a match on a successful Revert from both a mismatch and an invalid save branch', () => {
    const mismatched = new DocumentHistoryState();
    register(mismatched);
    mismatched.markReverted();
    expect(mismatched.isAtSavePoint()).toBe(true);

    const discarded = new DocumentHistoryState();
    const first = register(discarded);
    register(discarded);
    discarded.markSaved();
    discarded.markTransitionApplied(HISTORY_DIRECTION.undo, first);
    register(discarded);
    expect(discarded.isAtSavePoint()).toBe(false);

    discarded.markReverted();

    expect(discarded.isAtSavePoint()).toBe(true);
  });

  it('updates neither the save point nor the history point while protected', () => {
    const state = new DocumentHistoryState();
    const first = register(state);
    state.enterProtection();

    expect(state.registerEntry()).toBeUndefined();
    state.markTransitionApplied(HISTORY_DIRECTION.undo, first);
    state.markSaved();

    expect(state.isProtected()).toBe(true);
    // Save point comparison is stopped, so an arriving undo is not allowed to make it match the boundary.
    expect(state.isAtSavePoint()).toBe(false);
  });

  it('lifts protection only on recovery completion and resets the history point and save point', () => {
    const state = new DocumentHistoryState();
    register(state);
    state.enterProtection();

    state.completeRecovery();

    expect(state.isProtected()).toBe(false);
    expect(state.isAtSavePoint()).toBe(true);
    // The old history stack is not reused. Entries can be registered again from the new baseline.
    expect(state.registerEntry()).toBeDefined();
  });

  it('does nothing on recovery completion when not protected', () => {
    const state = new DocumentHistoryState();
    const first = register(state);

    state.completeRecovery();

    expect(state.currentPoint()).toBe(first.pointId);
  });
});
