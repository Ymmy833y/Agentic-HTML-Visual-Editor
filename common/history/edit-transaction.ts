/** A zero-based position in the body text. */
export interface EncodedPosition {
  readonly line: number;
  readonly column: number;
}

/** An encoded selection with a start and an end. They are equal for a caret. */
export interface EncodedSelection {
  readonly start: EncodedPosition;
  readonly end: EncodedPosition;
}

/** One endpoint of an edit transaction. */
export interface EditSnapshot {
  /** The full document text with LF line endings. */
  readonly text: string;
  /** The selection within the body, or `null` if it is outside the body or cannot be encoded. */
  readonly selection: EncodedSelection | null;
}

/**
 * Identifier that refers to one edit unit on both the view and the host.
 *
 * The start, the pair, and the unchanged terminator arrive as separate messages, and arrival order alone
 * cannot tell whether signals belong to the same unit. The empty string is not a valid value.
 */
export type EditUnitId = string;

/** One edit transaction that carries its before and after states together. */
export interface EditTransaction {
  /** Edit unit this pair belongs to. */
  readonly unitId: EditUnitId;
  readonly before: EditSnapshot;
  readonly after: EditSnapshot;
}

/** Kinds of edit unit signal. Used as the discriminant. */
export const EDIT_UNIT_SIGNAL_KIND = {
  start: 'start',
  settled: 'settled',
  unchanged: 'unchanged',
} as const;

/** Signal sent when a pending transaction opens, so the history entry is registered ahead of time. */
export interface EditUnitStartSignal {
  readonly kind: typeof EDIT_UNIT_SIGNAL_KIND.start;
  readonly unitId: EditUnitId;
  readonly start: EditSnapshot;
}

/** Signal that carries the completed before-and-after pair of a unit. */
export interface EditUnitSettledSignal {
  readonly kind: typeof EDIT_UNIT_SIGNAL_KIND.settled;
  readonly transaction: EditTransaction;
}

/**
 * Signal that carries the terminator of a unit that closed without changing the full text.
 *
 * It only closes the previously registered history entry with the same full text, so it carries no full text.
 */
export interface EditUnitUnchangedSignal {
  readonly kind: typeof EDIT_UNIT_SIGNAL_KIND.unchanged;
  readonly unitId: EditUnitId;
}

/** The three signals that arrive for one edit unit. Receivers handle all three branches exhaustively. */
export type EditUnitSignal =
  | EditUnitStartSignal
  | EditUnitSettledSignal
  | EditUnitUnchangedSignal;
