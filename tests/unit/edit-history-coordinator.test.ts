// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EDIT_UNIT_SIGNAL_KIND, HISTORY_DIRECTION } from '../../common/index';
import type {
  EditSnapshot,
  EditUnitSignal,
  HistoryDirection,
  MessageKey,
} from '../../common/index';

// Whether history events are enabled is a constant decided at startup, so the only way to test both settings is
// to replace this module.
const availability = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../src/history/history-availability', () => ({
  get HISTORY_EVENTS_ENABLED(): boolean {
    return availability.enabled;
  },
}));

import {
  EditHistoryCoordinator,
  STANDARD_COMMAND_KIND,
} from '../../src/history/edit-history-coordinator';
import type { HistoryEntryRecord } from '../../src/history/edit-history-coordinator';

const TEXT_A = '<html><body><p>a</p></body></html>';
const TEXT_AB = '<html><body><p>ab</p></body></html>';
const TEXT_ABC = '<html><body><p>abc</p></body></html>';

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

interface Harness {
  readonly coordinator: EditHistoryCoordinator;
  /** Entries carried by fired edit events. Settlement replaces their endpoints, so they are kept by reference. */
  readonly events: HistoryEntryRecord[];
  readonly notifications: MessageKey[];
  readonly logLines: string[];
  readonly appliedDirections: HistoryDirection[];
  /** Call order of unblocking and re-blocking replacement. */
  readonly replacementCalls: string[];
  readonly protections: { staleText: string | undefined; reason: string }[];
  readonly protectedViews: number[];
  readonly editNotices: number[];
  /** How many times a return to the save point was reported. */
  readonly savePointReturns: number[];
  setFlushResult(success: boolean): void;
  setFlushAction(action: () => void): void;
  /** Replaces the last known full text held by the save side. */
  setLastKnownText(text: string | undefined): void;
  failNextApply(reason: string, liveText: string | undefined): void;
  settleProtection(): void;
}

function createHarness(): Harness {
  const events: HistoryEntryRecord[] = [];
  const notifications: MessageKey[] = [];
  const logLines: string[] = [];
  const appliedDirections: HistoryDirection[] = [];
  const replacementCalls: string[] = [];
  const protections: { staleText: string | undefined; reason: string }[] = [];
  const protectedViews: number[] = [];
  const editNotices: number[] = [];
  const savePointReturns: number[] = [];

  let flushResult = true;
  let flushAction = (): void => undefined;
  let lastKnownText: string | undefined;
  let applyFailure: { reason: string; liveText: string | undefined } | undefined;
  let releaseProtection: (() => void) | undefined;

  const coordinator = new EditHistoryCoordinator(
    {
      notifyDocumentChanged: (entry) => events.push(entry),
      recordEditNotice: () => editNotices.push(editNotices.length + 1),
      lastKnownText: () => lastKnownText,
      flushEditTransactions: () => {
        flushAction();
        return Promise.resolve(flushResult);
      },
      applyHistoryTransition: (direction) => {
        appliedDirections.push(direction);
        const failure = applyFailure;
        if (failure !== undefined) {
          return Promise.resolve({
            kind: 'failed' as const,
            reason: failure.reason,
            liveText: failure.liveText,
          });
        }
        return Promise.resolve({ kind: 'applied' as const, text: TEXT_ABC });
      },
      unblockReplacement: () => replacementCalls.push('unblock'),
      blockReplacement: () => replacementCalls.push('block'),
      notifyReturnedToSavePoint: () => savePointReturns.push(savePointReturns.length + 1),
      protectView: () => protectedViews.push(protectedViews.length + 1),
      reportUserError: (key, cause) => {
        notifications.push(key);
        if (cause !== undefined) {
          logLines.push(cause);
        }
        return Promise.resolve();
      },
      reportInternalError: (detail) => logLines.push(detail),
    },
    {
      protect: (report) => {
        protections.push({ staleText: report.staleText, reason: report.reason });
        return new Promise<void>((resolve) => {
          releaseProtection = resolve;
        });
      },
    },
  );

  return {
    coordinator,
    events,
    notifications,
    logLines,
    appliedDirections,
    replacementCalls,
    protections,
    protectedViews,
    editNotices,
    savePointReturns,
    setFlushResult: (success) => {
      flushResult = success;
    },
    setFlushAction: (action) => {
      flushAction = action;
    },
    setLastKnownText: (text) => {
      lastKnownText = text;
    },
    failNextApply: (reason, liveText) => {
      applyFailure = { reason, liveText };
    },
    settleProtection: () => releaseProtection?.(),
  };
}

describe('edit history coordinator', () => {
  beforeEach(() => {
    availability.enabled = false;
  });

  it('fires exactly one edit event per settled unit', () => {
    availability.enabled = true;
    const harness = createHarness();

    harness.coordinator.receiveEditUnitSignal(start('u1', TEXT_A));
    harness.coordinator.receiveEditUnitSignal(settled('u1', TEXT_A, TEXT_AB));

    // Only the entry registered ahead of time remains; settlement replaces its endpoints with the actual state.
    expect(harness.events).toHaveLength(1);
    expect([harness.events[0].before.text, harness.events[0].after.text])
      .toEqual([TEXT_A, TEXT_AB]);
  });

  it('fires no change event from an edit notice alone while history events are enabled', () => {
    availability.enabled = true;
    const harness = createHarness();

    harness.coordinator.receiveEditNotice();

    expect(harness.events).toEqual([]);
    expect(harness.editNotices).toHaveLength(1);
  });

  it('does not allow writing when the full text being saved differs from the last settled full text', () => {
    const harness = createHarness();
    harness.coordinator.receiveEditUnitSignal(settled('u1', TEXT_A, TEXT_AB));

    expect(harness.coordinator.confirmSaveEndpoint(TEXT_ABC)).toBe(false);
  });

  it('allows writing when the full text being saved matches the settled full text', () => {
    const harness = createHarness();
    harness.coordinator.receiveEditUnitSignal(settled('u1', TEXT_A, TEXT_AB));

    expect(harness.coordinator.confirmSaveEndpoint(TEXT_AB)).toBe(true);
  });

  it('does not allow writing while a unit awaiting settlement remains', () => {
    const harness = createHarness();
    harness.coordinator.receiveEditUnitSignal(start('u1', TEXT_A));

    expect(harness.coordinator.confirmSaveEndpoint(TEXT_A)).toBe(false);
  });

  it('flushes the pending transaction at a save entry point and then allows an endpoint with the same full text', async () => {
    const harness = createHarness();
    harness.coordinator.receiveEditUnitSignal(start('u1', TEXT_A));
    harness.setFlushAction(() => {
      harness.coordinator.receiveEditUnitSignal(settled('u1', TEXT_A, TEXT_AB));
    });

    await expect(harness.coordinator.prepareSaveEndpoint(TEXT_AB)).resolves.toBe(true);
  });

  it('resets only the tracking state on a view restart and keeps the history point', async () => {
    const harness = createHarness();
    harness.coordinator.receiveEditUnitSignal(settled('u1', TEXT_A, TEXT_AB));
    harness.coordinator.receiveEditUnitSignal(start('u2', TEXT_AB));

    harness.coordinator.notifyViewRestarted();

    expect(harness.coordinator.confirmSaveEndpoint(TEXT_AB)).toBe(true);
    // Settled entries are not discarded. It can go back to a unit registered before the restart.
    await expect(harness.coordinator.runHistoryTransitionForTest(HISTORY_DIRECTION.undo))
      .resolves.toBe(true);
  });

  it('allows delegation when the flush succeeds and everything is settled', async () => {
    const harness = createHarness();
    harness.coordinator.receiveEditUnitSignal(settled('u1', TEXT_A, TEXT_AB));

    await expect(harness.coordinator.prepareStandardCommand(STANDARD_COMMAND_KIND.save))
      .resolves.toBe(true);
  });

  it('does not report a flush failure on save and delegates to the standard save', async () => {
    availability.enabled = true;
    const harness = createHarness();
    harness.setFlushResult(false);

    await expect(harness.coordinator.prepareStandardCommand(STANDARD_COMMAND_KIND.save))
      .resolves.toBe(true);
    expect(harness.notifications).toEqual([]);
  });

  it('does not delegate to the standard command when the flush fails on undo', async () => {
    availability.enabled = true;
    const harness = createHarness();
    harness.setFlushResult(false);

    await expect(harness.coordinator.prepareStandardCommand(STANDARD_COMMAND_KIND.undo))
      .resolves.toBe(false);
    expect(harness.notifications).toEqual(['historyFlushFailed.message']);
  });

  it('does not delegate to the standard command when the flush fails on redo', async () => {
    availability.enabled = true;
    const harness = createHarness();
    harness.setFlushResult(false);

    await expect(harness.coordinator.prepareStandardCommand(STANDARD_COMMAND_KIND.redo))
      .resolves.toBe(false);
    expect(harness.notifications).toEqual(['historyFlushFailed.message']);
  });

  it('refuses only history delegation while history events are disabled', async () => {
    const harness = createHarness();

    await expect(harness.coordinator.prepareStandardCommand(STANDARD_COMMAND_KIND.undo))
      .resolves.toBe(false);
    await expect(harness.coordinator.prepareStandardCommand(STANDARD_COMMAND_KIND.save))
      .resolves.toBe(true);
  });

  it('refuses even save delegation while protected and points the user to recovery', async () => {
    const harness = createHarness();
    harness.coordinator.reportProtection('forced', undefined);

    await expect(harness.coordinator.prepareStandardCommand(STANDARD_COMMAND_KIND.save))
      .resolves.toBe(false);
    expect(harness.notifications).toContain('historyProtected.message');
  });

  it('requests unblocking replacement only when an application returning to the save boundary succeeds', async () => {
    const harness = createHarness();
    harness.coordinator.receiveEditUnitSignal(settled('u1', TEXT_A, TEXT_AB));
    harness.coordinator.notifySaveSucceeded(TEXT_AB);
    harness.coordinator.receiveEditUnitSignal(settled('u2', TEXT_AB, TEXT_ABC));

    await harness.coordinator.runHistoryTransitionForTest(HISTORY_DIRECTION.undo);

    expect(harness.replacementCalls).toEqual(['unblock']);
  });

  it('blocks replacement again on an application that moves away from the save boundary', async () => {
    const harness = createHarness();
    harness.coordinator.receiveEditUnitSignal(settled('u1', TEXT_A, TEXT_AB));
    harness.coordinator.notifySaveSucceeded(TEXT_AB);

    await harness.coordinator.runHistoryTransitionForTest(HISTORY_DIRECTION.undo);

    expect(harness.replacementCalls).toEqual(['block']);
  });

  it('updates only the save point on a successful save without clearing registered entries', async () => {
    const harness = createHarness();
    harness.coordinator.receiveEditUnitSignal(settled('u1', TEXT_A, TEXT_AB));
    harness.coordinator.receiveEditUnitSignal(settled('u2', TEXT_AB, TEXT_ABC));

    harness.coordinator.notifySaveSucceeded(TEXT_ABC);

    // The history stack survives a save. It can go back across the save boundary.
    await expect(harness.coordinator.runHistoryTransitionForTest(HISTORY_DIRECTION.undo))
      .resolves.toBe(true);
    expect(harness.appliedDirections).toEqual([HISTORY_DIRECTION.undo]);
  });

  it('registers no compensating entry on an application failure and hands the actual old full text and cause to the protection sink', async () => {
    availability.enabled = true;
    const harness = createHarness();
    harness.coordinator.receiveEditUnitSignal(settled('u1', TEXT_A, TEXT_AB));
    harness.failNextApply('the view refused', TEXT_ABC);

    void harness.coordinator.runHistoryTransitionForTest(HISTORY_DIRECTION.undo);

    await vi.waitFor(() => expect(harness.protections).toEqual([
      { staleText: TEXT_ABC, reason: 'the view refused' },
    ]));
    // No compensating entry with the rejected candidate as its before state is created. Events stay at the one
    // from the first settlement.
    expect(harness.events).toHaveLength(1);
    expect(harness.protectedViews).toHaveLength(1);
  });

  it('hands the last known full text to the protection sink when history application is requested with an endpoint missing', async () => {
    const harness = createHarness();
    harness.coordinator.receiveEditUnitSignal(settled('u1', TEXT_A, TEXT_AB));
    harness.setLastKnownText(TEXT_ABC);
    // Leave a unit awaiting settlement that received only its start. Endpoints are incomplete, so candidate
    // application cannot proceed.
    harness.coordinator.receiveEditUnitSignal(start('u2', TEXT_AB));

    void harness.coordinator.runHistoryTransitionForTest(HISTORY_DIRECTION.undo);

    await vi.waitFor(() => expect(harness.protections).toHaveLength(1));
    expect([harness.protections[0].staleText, harness.appliedDirections]).toEqual([TEXT_ABC, []]);
  });

  it('tells the new view to stop input when the view restarts while protected', () => {
    const harness = createHarness();
    harness.coordinator.reportProtection('forced', TEXT_A);

    harness.coordinator.notifyViewRestarted();

    expect(harness.protectedViews).toHaveLength(2);
  });

  it('does not apply a history request that arrives while protected and stays protected', async () => {
    const harness = createHarness();
    harness.coordinator.receiveEditUnitSignal(settled('u1', TEXT_A, TEXT_AB));
    harness.coordinator.reportProtection('forced', undefined);
    const reported = harness.logLines.length;

    void harness.coordinator.runHistoryTransitionForTest(HISTORY_DIRECTION.undo);
    await vi.waitFor(() => expect(harness.logLines.length).toBeGreaterThan(reported));

    expect(harness.appliedDirections).toEqual([]);
    expect(harness.coordinator.isProtected()).toBe(true);
  });

  it('does not lift protection on recovery before preservation of the old content completes', () => {
    const harness = createHarness();
    harness.coordinator.reportProtection('forced', undefined);

    harness.coordinator.completeRecovery(TEXT_A);

    expect(harness.coordinator.isProtected()).toBe(true);
  });

  it('lifts protection only on recovery after preservation of the old content completes', async () => {
    const harness = createHarness();
    harness.coordinator.reportProtection('forced', undefined);
    harness.settleProtection();

    await vi.waitFor(() => {
      harness.coordinator.completeRecovery(TEXT_A);
      expect(harness.coordinator.isProtected()).toBe(false);
    });
  });
});

describe('restore entry', () => {
  it('registers exactly one current source to restored full text entry and leaves it off the save point', () => {
    availability.enabled = true;
    const harness = createHarness();

    const first = harness.coordinator.registerRestoreEntry(TEXT_A, TEXT_AB);
    const second = harness.coordinator.registerRestoreEntry(TEXT_A, TEXT_AB);

    expect([first, second]).toEqual([true, false]);
    expect(harness.events).toHaveLength(1);
    expect([harness.events[0].before.text, harness.events[0].after.text]).toEqual([TEXT_A, TEXT_AB]);
  });

  it('reports the return once when undoing the restore entry returns to the save point', async () => {
    availability.enabled = true;
    const harness = createHarness();
    harness.coordinator.registerRestoreEntry(TEXT_A, TEXT_AB);

    const applied = await harness.coordinator.runHistoryTransition(HISTORY_DIRECTION.undo, harness.events[0]);

    expect([applied, harness.savePointReturns]).toEqual([true, [1]]);
  });

  it('does not report a return for an apply that does not match the save point', async () => {
    availability.enabled = true;
    const harness = createHarness();
    harness.coordinator.registerRestoreEntry(TEXT_A, TEXT_AB);

    const applied = await harness.coordinator.runHistoryTransition(HISTORY_DIRECTION.redo, harness.events[0]);

    expect([applied, harness.savePointReturns]).toEqual([true, []]);
  });
});

describe('conflict choice entry', () => {
  beforeEach(() => {
    availability.enabled = true;
  });

  it('registers one entry from the view side to the chosen full text', () => {
    const harness = createHarness();

    const registered = harness.coordinator.registerConflictChoiceEntry(TEXT_A, TEXT_AB);

    expect([registered, harness.events.length]).toEqual([true, 1]);
    expect([harness.events[0].before, harness.events[0].after]).toEqual([snapshot(TEXT_A), snapshot(TEXT_AB)]);
  });

  it('keeps every registered choice reachable by undo', async () => {
    const harness = createHarness();
    harness.coordinator.registerConflictChoiceEntry(TEXT_A, TEXT_AB);
    harness.coordinator.registerConflictChoiceEntry(TEXT_AB, TEXT_ABC);

    const undone = [
      await harness.coordinator.runHistoryTransitionForTest(HISTORY_DIRECTION.undo),
      await harness.coordinator.runHistoryTransitionForTest(HISTORY_DIRECTION.undo),
    ];

    expect([undone, harness.events[0].unitId === harness.events[1].unitId]).toEqual([[true, true], false]);
  });

  it('checks the next save against the chosen full text', () => {
    const harness = createHarness();
    harness.coordinator.registerConflictChoiceEntry(TEXT_A, TEXT_AB);

    expect([
      harness.coordinator.confirmSaveEndpoint(TEXT_A),
      harness.coordinator.confirmSaveEndpoint(TEXT_AB),
    ]).toEqual([false, true]);
  });

  it('returns to the save point by redo after the save that wrote the choice', async () => {
    const harness = createHarness();
    harness.coordinator.registerConflictChoiceEntry(TEXT_A, TEXT_AB);
    harness.coordinator.notifySaveSucceeded(TEXT_AB);

    await harness.coordinator.runHistoryTransitionForTest(HISTORY_DIRECTION.undo);
    const returnsAfterUndo = harness.savePointReturns.length;
    await harness.coordinator.runHistoryTransitionForTest(HISTORY_DIRECTION.redo);

    expect([returnsAfterUndo, harness.savePointReturns.length, harness.replacementCalls]).toEqual([
      0,
      1,
      ['block', 'unblock'],
    ]);
  });

  it('refuses the entry while protected', () => {
    const harness = createHarness();
    harness.coordinator.reportProtection('forced', undefined);

    const registered = harness.coordinator.registerConflictChoiceEntry(TEXT_A, TEXT_AB);

    expect([registered, harness.events]).toEqual([false, []]);
  });
});
