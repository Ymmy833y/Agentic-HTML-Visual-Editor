/** Whether an operation placed on the queue ran, and the result it produced when it did. */
export type QueuedOperationResult<TValue> =
  | { readonly ran: true; readonly value: TValue }
  | { readonly ran: false };

/**
 * A queue that runs the operations for one document one at a time, in the order they were accepted.
 *
 * Save, save as, and revert all rewrite the same three baselines and the same last known content, so
 * overlapping them would let a later operation read a state an earlier one had left half-written. The
 * queue holds only the operations and a closed flag, neither a body nor a cancellation token: holding
 * the body as of the moment an operation was accepted would mean writing content that had gone stale
 * by the time its turn came.
 */
export class DocumentOperationQueue {
  // The end of the unit queued most recently. The next operation starts only once this settles.
  private tail: Promise<void> = Promise.resolve();

  private closed = false;

  /** Whether the queue is closed. A save entry point checks this and fails instead of queueing onto a closed queue. */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Runs an operation once the preceding unit has finished.
   *
   * The operation does not run if the queue is closed by the time its turn comes. Checking for closure
   * when the operation is queued instead would still run it on a queue that was closed while it waited.
   *
   * @param operation The operation to run.
   * @returns Its result when it ran, or a marker that it did not run because the queue was closed.
   */
  async run<TValue>(operation: () => Promise<TValue>): Promise<QueuedOperationResult<TValue>> {
    const previous = this.tail;
    let release = (): void => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      if (this.closed) {
        return { ran: false };
      }
      return { ran: true, value: await operation() };
    } finally {
      // Move on to the next operation even when this one ended with an exception. Completion is used
      // only as the trigger to start the next one and is not kept as history.
      release();
    }
  }

  /**
   * Closes the queue.
   *
   * Operations still waiting to run, and anything accepted afterwards, are abandoned without running.
   * An operation already running is not stopped. Calls after the first do nothing, and a closed queue
   * is never reopened.
   */
  close(): void {
    this.closed = true;
  }
}
