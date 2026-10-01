import {
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import type {
  EditSnapshot,
  EditTransactionFlushResultMessage,
  EditTransactionMessage,
  EditUnitId,
  EditUnitStartMessage,
  EditUnitUnchangedMessage,
  EncodedPosition,
  EncodedSelection,
} from '../../common/index';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPosition(value: unknown): value is EncodedPosition {
  return isRecord(value)
    && typeof value.line === 'number'
    && Number.isFinite(value.line)
    && Number.isInteger(value.line)
    && (value.line as number) >= 0
    && typeof value.column === 'number'
    && Number.isFinite(value.column)
    && Number.isInteger(value.column)
    && (value.column as number) >= 0;
}

function comparePosition(left: EncodedPosition, right: EncodedPosition): number {
  return left.line === right.line ? left.column - right.column : left.line - right.line;
}

function isSelection(value: unknown): value is EncodedSelection {
  if (!isRecord(value) || !isPosition(value.start) || !isPosition(value.end)) {
    return false;
  }
  return comparePosition(value.start, value.end) <= 0;
}

function isSnapshot(value: unknown): value is EditSnapshot {
  return isRecord(value)
    && typeof value.text === 'string'
    && (value.selection === null || isSelection(value.selection));
}

/**
 * Determines whether a value can be used as an edit unit id.
 *
 * Accepting the empty string would let a pair that belongs to no unit be treated as settled.
 *
 * @param value Runtime value.
 * @returns `true` for a non-empty string.
 */
function isEditUnitId(value: unknown): value is EditUnitId {
  return typeof value === 'string' && value.length > 0;
}

/** Validates a runtime value as an edit transaction that contains a change. */
export function parseEditTransactionMessage(value: unknown): EditTransactionMessage | undefined {
  if (
    !isRecord(value)
    || value.type !== VIEW_TO_HOST_MESSAGE_TYPE.editTransaction
    || !isRecord(value.transaction)
    || !isEditUnitId(value.transaction.unitId)
    || !isSnapshot(value.transaction.before)
    || !isSnapshot(value.transaction.after)
    || value.transaction.before.text === value.transaction.after.text
  ) {
    return undefined;
  }
  return value as unknown as EditTransactionMessage;
}

/** Validates a runtime value as an edit unit start message. */
export function parseEditUnitStartMessage(value: unknown): EditUnitStartMessage | undefined {
  if (
    !isRecord(value)
    || value.type !== VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart
    || !isEditUnitId(value.unitId)
    || !isSnapshot(value.start)
  ) {
    return undefined;
  }
  return value as unknown as EditUnitStartMessage;
}

/** Validates a runtime value as an edit unit unchanged terminator message. */
export function parseEditUnitUnchangedMessage(
  value: unknown,
): EditUnitUnchangedMessage | undefined {
  if (
    !isRecord(value)
    || value.type !== VIEW_TO_HOST_MESSAGE_TYPE.editUnitUnchanged
    || !isEditUnitId(value.unitId)
  ) {
    return undefined;
  }
  return value as unknown as EditUnitUnchangedMessage;
}

/** Validates a runtime value as an edit transaction flush result. */
export function parseEditTransactionFlushResultMessage(
  value: unknown,
): EditTransactionFlushResultMessage | undefined {
  if (
    !isRecord(value)
    || value.type !== VIEW_TO_HOST_MESSAGE_TYPE.editTransactionFlushResult
    || typeof value.requestId !== 'string'
    || value.requestId.length === 0
    || typeof value.success !== 'boolean'
  ) {
    return undefined;
  }
  return value as unknown as EditTransactionFlushResultMessage;
}
