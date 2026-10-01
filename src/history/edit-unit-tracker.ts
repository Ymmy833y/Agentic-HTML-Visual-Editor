import { EDIT_UNIT_SIGNAL_KIND } from '../../common/index';
import type { EditSnapshot, EditUnitId, EditUnitSignal } from '../../common/index';

/** Tracking outcome for one signal. */
export const EDIT_UNIT_OUTCOME = {
  /** Registered ahead of time. One entry is registered from the start endpoint alone. */
  registered: 'registered',
  /** Settled. Closes the entry registered ahead of time, or registers one standalone entry. */
  settled: 'settled',
  /** Settled unchanged. Closes the entry registered ahead of time with the same full text. */
  settledUnchanged: 'settledUnchanged',
  /** Endpoint missing. An edit notice arrived without an endpoint. */
  endpointMissing: 'endpointMissing',
  /** Discarded. There is no matching edit unit. */
  discarded: 'discarded',
} as const;

/** Edit unit outcome. */
export type EditUnitOutcome = (typeof EDIT_UNIT_OUTCOME)[keyof typeof EDIT_UNIT_OUTCOME];

/** Distinction made when an edit notice arrives. */
export const EDIT_NOTICE_OUTCOME = {
  /** A matching edit unit exists. */
  tracked: 'tracked',
  /** An edit notice arrived with no endpoint. */
  endpointMissing: 'endpointMissing',
} as const;

/** Distinction for an edit notice. */
export type EditNoticeOutcome = (typeof EDIT_NOTICE_OUTCOME)[keyof typeof EDIT_NOTICE_OUTCOME];

/** Tracking phase. */
type UnitPhase = 'idle' | 'endpointMissing' | 'awaitingSettlement' | 'settled';

/** Edit unit awaiting settlement. */
interface AwaitedUnit {
  readonly unitId: EditUnitId;
  readonly start: EditSnapshot;
}

/**
 * Holds the edit unit tracking state for one document.
 *
 * The start, the pair, and the unchanged terminator arrive as separate messages, and arrival order alone cannot
 * tell whether they belong to the same unit. Edit unit ids are matched here so each unit is registered and
 * settled exactly once.
 */
export class EditUnitTracker {
  private phase: UnitPhase = 'idle';

  private awaited: AwaitedUnit | undefined;

  // Unit id awaiting settlement that was dropped on a view restart. Prevents the old view's pair from settling as
  // a standalone edit in the new tracking state.
  private staleUnitId: EditUnitId | undefined;

  private settled: string | undefined;

  /**
   * Advances tracking with one signal.
   *
   * @param signal A start, a pair, or an unchanged terminator.
   * @returns The single outcome for this signal.
   */
  receiveSignal(signal: EditUnitSignal): EditUnitOutcome {
    if (signal.kind === EDIT_UNIT_SIGNAL_KIND.start) {
      // The view always closes an open unit with a pair or an unchanged terminator before opening the next, so
      // the only unit awaiting settlement that can be overwritten here is one whose closing signal never arrived.
      this.awaited = { unitId: signal.unitId, start: signal.start };
      this.phase = 'awaitingSettlement';
      return EDIT_UNIT_OUTCOME.registered;
    }

    if (signal.kind === EDIT_UNIT_SIGNAL_KIND.unchanged) {
      const awaited = this.awaited;
      if (awaited === undefined || awaited.unitId !== signal.unitId) {
        return EDIT_UNIT_OUTCOME.discarded;
      }
      // The full text has not changed, so the start endpoint itself becomes the settled content.
      this.settle(awaited.start.text);
      return EDIT_UNIT_OUTCOME.settledUnchanged;
    }

    const unitId = signal.transaction.unitId;
    if (this.awaited !== undefined) {
      if (this.awaited.unitId !== unitId) {
        return EDIT_UNIT_OUTCOME.discarded;
      }
    } else if (unitId === this.staleUnitId) {
      return EDIT_UNIT_OUTCOME.discarded;
    }

    this.settle(signal.transaction.after.text);
    return EDIT_UNIT_OUTCOME.settled;
  }

  /**
   * Receives an edit notice that carries no endpoint.
   *
   * The notice's full text is not substituted for an endpoint. It carries neither an edit unit id nor a final
   * marker, and its body can be older than the last edit.
   *
   * @returns Whether the endpoint is missing.
   */
  receiveEditNotice(): EditNoticeOutcome {
    if (this.phase === 'awaitingSettlement' || this.phase === 'settled') {
      return EDIT_NOTICE_OUTCOME.tracked;
    }
    this.phase = 'endpointMissing';
    return EDIT_NOTICE_OUTCOME.endpointMissing;
  }

  /**
   * Returns whether a unit awaiting settlement or a missing endpoint remains.
   *
   * @returns While `true`, save writes and history application are not allowed.
   */
  hasUnsettledUnit(): boolean {
    return this.phase === 'awaitingSettlement' || this.phase === 'endpointMissing';
  }

  /**
   * Returns the after full text of the last settled unit.
   *
   * @returns Settled full text, or `undefined` if nothing has ever settled.
   */
  settledText(): string | undefined {
    return this.settled;
  }

  /**
   * Discards the edit unit being tracked.
   *
   * Called only on a view restart. Settled history entries are not affected.
   */
  reset(): void {
    if (this.awaited !== undefined) {
      this.staleUnitId = this.awaited.unitId;
    }
    this.awaited = undefined;
    this.phase = 'idle';
  }

  /**
   * Moves to settled.
   *
   * @param text Settled after full text.
   */
  private settle(text: string): void {
    this.settled = text;
    this.awaited = undefined;
    this.phase = 'settled';
  }
}
