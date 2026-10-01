// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import {
  parseEditTransactionFlushResultMessage,
  parseEditTransactionMessage,
  parseEditUnitStartMessage,
  parseEditUnitUnchangedMessage,
} from '../../src/history/edit-transaction-validation';

const position = (line: number, column: number) => ({ line, column });

function message(selection: unknown) {
  return {
    type: VIEW_TO_HOST_MESSAGE_TYPE.editTransaction,
    transaction: {
      unitId: 'u1',
      before: { text: '<p>a</p>', selection },
      after: { text: '<p>b</p>', selection },
    },
  };
}

describe('edit transaction validation', () => {
  it.each([
    null,
    { start: position(0, 3), end: position(0, 3) },
    { start: position(0, 3), end: position(1, 2) },
  ])('accepts no captured selection, a caret, and a range selection', (selection) => {
    const value = message(selection);

    expect(parseEditTransactionMessage(value)).toBe(value);
  });

  it.each([
    ['wrong type', { start: position(0, 0), end: { line: '0', column: 1 } }],
    ['negative value', { start: position(-1, 0), end: position(0, 0) }],
    ['non-integer value', { start: position(0, 0.5), end: position(0, 1) }],
    ['reverse order', { start: position(2, 0), end: position(1, 0) }],
  ])('rejects a selection with a %s', (_label, selection) => {
    expect(parseEditTransactionMessage(message(selection))).toBeUndefined();
  });

  it('rejects a transaction with identical full document text', () => {
    const value = message(null);
    value.transaction.after.text = value.transaction.before.text;

    expect(parseEditTransactionMessage(value)).toBeUndefined();
  });

  it('rejects a pair without an edit unit id even when it meets the existing conditions', () => {
    const value = message(null);

    expect(parseEditTransactionMessage({
      ...value,
      transaction: { ...value.transaction, unitId: '' },
    })).toBeUndefined();
  });

  it('accepts a start with both a unit id and an endpoint, and rejects an empty id or invalid endpoint', () => {
    const valid = {
      type: VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart,
      unitId: 'u1',
      start: { text: '<p>a</p>', selection: null },
    };

    expect(parseEditUnitStartMessage(valid)).toBe(valid);
    expect(parseEditUnitStartMessage({ ...valid, unitId: '' })).toBeUndefined();
    expect(parseEditUnitStartMessage({ ...valid, start: { text: 1, selection: null } }))
      .toBeUndefined();
  });

  it('accepts a terminator carrying only a unit id, and rejects a value without an id', () => {
    const valid = { type: VIEW_TO_HOST_MESSAGE_TYPE.editUnitUnchanged, unitId: 'u1' };

    expect(parseEditUnitUnchangedMessage(valid)).toBe(valid);
    expect(parseEditUnitUnchangedMessage({ type: VIEW_TO_HOST_MESSAGE_TYPE.editUnitUnchanged }))
      .toBeUndefined();
  });

  it('accepts only flush results with a non-empty request ID and a boolean', () => {
    const valid = {
      type: VIEW_TO_HOST_MESSAGE_TYPE.editTransactionFlushResult,
      requestId: '1',
      success: true,
    };

    expect(parseEditTransactionFlushResultMessage(valid)).toBe(valid);
    expect(parseEditTransactionFlushResultMessage({ ...valid, requestId: '' })).toBeUndefined();
    expect(parseEditTransactionFlushResultMessage({ ...valid, success: 1 })).toBeUndefined();
  });
});
