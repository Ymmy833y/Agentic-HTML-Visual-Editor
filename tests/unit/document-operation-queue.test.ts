// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { DocumentOperationQueue } from '../../src/save/document-operation-queue';

/** An operation that can be settled from outside, so another operation can be queued between its start and its end. */
function createGate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('serializing operations', () => {
  it('does not start the second of two queued operations until the first finishes', async () => {
    const queue = new DocumentOperationQueue();
    const gate = createGate();
    const started: string[] = [];

    const first = queue.run(async () => {
      started.push('first');
      await gate.wait;
    });
    const second = queue.run(() => {
      started.push('second');
      return Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const startedBeforeOpening = [...started];
    gate.open();
    await Promise.all([first, second]);

    expect([startedBeforeOpening, started]).toEqual([['first'], ['first', 'second']]);
  });

  it('starts the next operation even when the previous one ends with an exception', async () => {
    const queue = new DocumentOperationQueue();
    const started: string[] = [];

    const first = queue.run(() => {
      started.push('first');
      return Promise.reject(new Error('The operation failed'));
    });
    const second = queue.run(() => {
      started.push('second');
      return Promise.resolve();
    });

    await expect(first).rejects.toThrow('The operation failed');
    await second;

    expect(started).toEqual(['first', 'second']);
  });

  it('abandons an operation still waiting to run when the queue is closed', async () => {
    const queue = new DocumentOperationQueue();
    const gate = createGate();
    const started: string[] = [];

    const first = queue.run(async () => {
      started.push('first');
      await gate.wait;
    });
    const second = queue.run(() => {
      started.push('second');
      return Promise.resolve();
    });
    // Close after the first operation has started. Closing before it starts would abandon both.
    await new Promise((resolve) => setTimeout(resolve, 0));

    queue.close();
    gate.open();
    await first;
    const result = await second;

    expect([started, result]).toEqual([['first'], { ran: false }]);
  });

  it('does not run an operation queued after the close and reports that the queue is closed', async () => {
    const queue = new DocumentOperationQueue();
    let started = false;

    queue.close();
    const result = await queue.run(() => {
      started = true;
      return Promise.resolve('written');
    });

    expect([queue.isClosed, started, result]).toEqual([true, false, { ran: false }]);
  });
});
