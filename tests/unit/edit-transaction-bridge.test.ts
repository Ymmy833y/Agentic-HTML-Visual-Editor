// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOST_TO_VIEW_MESSAGE_TYPE,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import type { EditTransaction, EditUnitSignal, HostToViewMessage } from '../../common/index';
import {
  EDIT_TRANSACTION_FLUSH_TIMEOUT_MS,
  EditTransactionBridge,
} from '../../src/history/edit-transaction-bridge';

const TRANSACTION: EditTransaction = {
  unitId: 'u1',
  before: { text: '<p>a</p>', selection: null },
  after: { text: '<p>b</p>', selection: null },
};

function createHarness() {
  const sent: HostToViewMessage[] = [];
  const diagnostics: string[] = [];
  const bridge = new EditTransactionBridge(
    (message) => sent.push(message),
    { reportInternalError: (detail) => diagnostics.push(detail) },
  );
  return { bridge, sent, diagnostics };
}

describe('edit transaction bridge', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('passes one valid transaction unchanged to the registered consumer', () => {
    const { bridge } = createHarness();
    const received: EditUnitSignal[] = [];
    bridge.setConsumer((signal) => received.push(signal));

    bridge.receiveTransaction({
      type: VIEW_TO_HOST_MESSAGE_TYPE.editTransaction,
      transaction: TRANSACTION,
    });

    expect(received).toEqual([{ kind: 'settled', transaction: TRANSACTION }]);
  });

  it('delivers the start, pair, and unchanged terminator to the same consumer in send order', () => {
    const { bridge, diagnostics } = createHarness();
    const received: EditUnitSignal[] = [];
    bridge.setConsumer((signal) => received.push(signal));

    bridge.receiveEditUnitStart({
      type: VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart,
      unitId: 'u1',
      start: TRANSACTION.before,
    });
    bridge.receiveTransaction({
      type: VIEW_TO_HOST_MESSAGE_TYPE.editTransaction,
      transaction: TRANSACTION,
    });
    bridge.receiveEditUnitUnchanged({
      type: VIEW_TO_HOST_MESSAGE_TYPE.editUnitUnchanged,
      unitId: 'u2',
    });

    expect(received).toEqual([
      { kind: 'start', unitId: 'u1', start: TRANSACTION.before },
      { kind: 'settled', transaction: TRANSACTION },
      { kind: 'unchanged', unitId: 'u2' },
    ]);
    expect(diagnostics).toEqual([]);
  });

  it('cancels the timeout and completes on the matching successful result', async () => {
    const { bridge, sent } = createHarness();
    const result = bridge.flush();
    const request = sent[0];
    if (request.type !== HOST_TO_VIEW_MESSAGE_TYPE.requestEditTransactionFlush) {
      throw new Error('The message is not a flush request');
    }

    bridge.receiveFlushResult({
      type: VIEW_TO_HOST_MESSAGE_TYPE.editTransactionFlushResult,
      requestId: request.requestId,
      success: true,
    });

    await expect(result).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries once with the same request ID after the first timeout and fails after the second', async () => {
    const { bridge, sent } = createHarness();
    const result = bridge.flush();

    await vi.advanceTimersByTimeAsync(EDIT_TRANSACTION_FLUSH_TIMEOUT_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    await vi.advanceTimersByTimeAsync(EDIT_TRANSACTION_FLUSH_TIMEOUT_MS);

    await expect(result).resolves.toBe(false);
  });

  it('fails another flush while awaiting a response without sending a new request', async () => {
    const { bridge, sent } = createHarness();
    const first = bridge.flush();

    await expect(bridge.flush()).resolves.toBe(false);
    expect(sent).toHaveLength(1);
    bridge.dispose();
    await expect(first).resolves.toBe(false);
  });

  it('fails the old waiter on view restart and can send a new request afterward', async () => {
    const { bridge, sent } = createHarness();
    const old = bridge.flush();

    bridge.notifyViewRestarted();
    await expect(old).resolves.toBe(false);
    const next = bridge.flush();

    expect(sent).toHaveLength(2);
    bridge.dispose();
    await expect(next).resolves.toBe(false);
  });
});
