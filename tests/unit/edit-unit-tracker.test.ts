// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { EDIT_UNIT_SIGNAL_KIND } from '../../common/index';
import type { EditSnapshot, EditUnitSignal } from '../../common/index';
import {
  EDIT_NOTICE_OUTCOME,
  EDIT_UNIT_OUTCOME,
  EditUnitTracker,
} from '../../src/history/edit-unit-tracker';

function snapshot(text: string): EditSnapshot {
  return { text, selection: null };
}

function start(unitId: string, text: string): EditUnitSignal {
  return { kind: EDIT_UNIT_SIGNAL_KIND.start, unitId, start: snapshot(text) };
}

function settled(unitId: string, before: string, after: string): EditUnitSignal {
  return {
    kind: EDIT_UNIT_SIGNAL_KIND.settled,
    transaction: { unitId, before: snapshot(before), after: snapshot(after) },
  };
}

function unchanged(unitId: string): EditUnitSignal {
  return { kind: EDIT_UNIT_SIGNAL_KIND.unchanged, unitId };
}

describe('edit unit tracking', () => {
  it('becomes settled when a pair with the same edit unit id arrives after the start', () => {
    const tracker = new EditUnitTracker();

    expect(tracker.receiveSignal(start('u1', '<p>a</p>'))).toBe(EDIT_UNIT_OUTCOME.registered);
    expect(tracker.receiveSignal(settled('u1', '<p>a</p>', '<p>ab</p>')))
      .toBe(EDIT_UNIT_OUTCOME.settled);
    expect(tracker.hasUnsettledUnit()).toBe(false);
  });

  it('closes the earlier unit with the same full text on an unchanged terminator without adding a new settlement', () => {
    const tracker = new EditUnitTracker();
    tracker.receiveSignal(start('u1', '<p>a</p>'));

    expect(tracker.receiveSignal(unchanged('u1'))).toBe(EDIT_UNIT_OUTCOME.settledUnchanged);
    // The start endpoint becomes the settled content as is. Nothing changed, so no other full text appears.
    expect(tracker.settledText()).toBe('<p>a</p>');
  });

  it('settles a pair without a start exactly once as a standalone edit', () => {
    const tracker = new EditUnitTracker();

    expect(tracker.receiveSignal(settled('u9', '<p>a</p>', '<p>ab</p>')))
      .toBe(EDIT_UNIT_OUTCOME.settled);
    expect(tracker.settledText()).toBe('<p>ab</p>');
  });

  it('discards a pair with a non-matching edit unit id without changing the state', () => {
    const tracker = new EditUnitTracker();
    tracker.receiveSignal(start('u1', '<p>a</p>'));

    expect(tracker.receiveSignal(settled('other', '<p>a</p>', '<p>ab</p>')))
      .toBe(EDIT_UNIT_OUTCOME.discarded);
    expect(tracker.hasUnsettledUnit()).toBe(true);
  });

  it('marks the endpoint missing when an edit notice arrives before the start', () => {
    const tracker = new EditUnitTracker();

    expect(tracker.receiveEditNotice()).toBe(EDIT_NOTICE_OUTCOME.endpointMissing);
    expect(tracker.hasUnsettledUnit()).toBe(true);
  });

  it('recovers to awaiting settlement when the start endpoint arrives after a missing endpoint', () => {
    const tracker = new EditUnitTracker();
    tracker.receiveEditNotice();

    expect(tracker.receiveSignal(start('u1', '<p>a</p>'))).toBe(EDIT_UNIT_OUTCOME.registered);
    expect(tracker.receiveEditNotice()).toBe(EDIT_NOTICE_OUTCOME.tracked);
  });

  it('does not allow saving or history while a unit awaiting a terminator remains', () => {
    const tracker = new EditUnitTracker();
    tracker.receiveSignal(settled('u1', '<p>a</p>', '<p>ab</p>'));
    tracker.receiveSignal(start('u2', '<p>ab</p>'));

    expect(tracker.hasUnsettledUnit()).toBe(true);
  });

  it('does not return a pending endpoint or edit notice full text as the last settled content', () => {
    const tracker = new EditUnitTracker();
    tracker.receiveSignal(settled('u1', '<p>a</p>', '<p>ab</p>'));
    tracker.receiveSignal(start('u2', '<p>abc</p>'));
    tracker.receiveEditNotice();

    expect(tracker.settledText()).toBe('<p>ab</p>');
  });

  it('does not settle when receiving an old unit pair after a view restart', () => {
    const tracker = new EditUnitTracker();
    tracker.receiveSignal(start('u1', '<p>a</p>'));

    tracker.reset();

    expect(tracker.receiveSignal(settled('u1', '<p>a</p>', '<p>ab</p>')))
      .toBe(EDIT_UNIT_OUTCOME.discarded);
  });

  it('discards only the unit awaiting settlement on a view restart and allows saving and history again', () => {
    const tracker = new EditUnitTracker();
    tracker.receiveSignal(start('u1', '<p>a</p>'));

    tracker.reset();

    expect(tracker.hasUnsettledUnit()).toBe(false);
  });
});
