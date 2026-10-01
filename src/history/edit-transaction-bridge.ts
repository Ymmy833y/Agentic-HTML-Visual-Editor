import {
  EDIT_UNIT_SIGNAL_KIND,
  HOST_TO_VIEW_MESSAGE_TYPE,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import type {
  EditTransactionFlushResultMessage,
  EditUnitSignal,
  HostToViewMessage,
} from '../../common/index';
import type { InternalErrorSink } from '../diagnostics/error-reporter';
import { PendingRequests } from '../messaging/pending-requests';
import {
  parseEditTransactionFlushResultMessage,
  parseEditTransactionMessage,
  parseEditUnitStartMessage,
  parseEditUnitUnchangedMessage,
} from './edit-transaction-validation';

/** Time to wait for an edit transaction flush response. */
export const EDIT_TRANSACTION_FLUSH_TIMEOUT_MS = 2000;

/**
 * Entry point for the downstream feature that consumes validated transactions.
 *
 * All three signals are received by one function. Separate entry points would force the downstream feature
 * to reconstruct the send order.
 */
export type EditTransactionConsumer = (signal: EditUnitSignal) => void;

/** Owns communication with the view, flush requests, and downstream delivery for one tab. */
export class EditTransactionBridge {
  private pending: PendingRequests;

  private consumer: EditTransactionConsumer | undefined;

  private flushInFlight: Promise<boolean> | undefined;

  private disposed = false;

  constructor(
    private readonly postToView: (message: HostToViewMessage) => void,
    private readonly errorSink: InternalErrorSink,
  ) {
    this.pending = new PendingRequests(errorSink);
  }

  /** Passes only a valid transaction synchronously to the current consumer. */
  receiveTransaction(value: unknown): void {
    const message = parseEditTransactionMessage(value);
    if (message === undefined) {
      this.errorSink.reportInternalError('Discarded an invalid edit transaction.');
      return;
    }
    this.consumer?.({
      kind: EDIT_UNIT_SIGNAL_KIND.settled,
      transaction: message.transaction,
    });
  }

  /** Converts only a valid start into a start signal and passes it synchronously to the consumer. */
  receiveEditUnitStart(value: unknown): void {
    const message = parseEditUnitStartMessage(value);
    if (message === undefined) {
      this.errorSink.reportInternalError('Discarded an invalid edit unit start.');
      return;
    }
    this.consumer?.({
      kind: EDIT_UNIT_SIGNAL_KIND.start,
      unitId: message.unitId,
      start: message.start,
    });
  }

  /**
   * Converts only a valid unchanged terminator into a terminator signal and passes it synchronously to the
   * consumer. It does not fill in the full text.
   */
  receiveEditUnitUnchanged(value: unknown): void {
    const message = parseEditUnitUnchangedMessage(value);
    if (message === undefined) {
      this.errorSink.reportInternalError('Discarded an invalid edit unit terminator.');
      return;
    }
    this.consumer?.({ kind: EDIT_UNIT_SIGNAL_KIND.unchanged, unitId: message.unitId });
  }

  /** Sets the sole consumer for the downstream feature. */
  setConsumer(consumer: EditTransactionConsumer | undefined): void {
    if (!this.disposed) {
      this.consumer = consumer;
    }
  }

  /** Passes only a valid flush result for a pending request to its waiter. */
  receiveFlushResult(value: unknown): void {
    const message = parseEditTransactionFlushResultMessage(value);
    if (message === undefined) {
      this.errorSink.reportInternalError('Discarded an invalid edit transaction flush result.');
      return;
    }
    if (!this.pending.settle(message)) {
      this.errorSink.reportInternalError(
        `Discarded an edit transaction flush result with no matching request: ${message.requestId}`,
      );
    }
  }

  /** Requests a flush and retries once with the same request ID after the first timeout. */
  flush(): Promise<boolean> {
    if (this.disposed || this.flushInFlight !== undefined) {
      return Promise.resolve(false);
    }

    const operation = this.performFlush();
    this.flushInFlight = operation;
    void operation.finally(() => {
      if (this.flushInFlight === operation) {
        this.flushInFlight = undefined;
      }
    });
    return operation;
  }

  /** Fails requests pending on the old view and switches to a fresh request ID space. */
  notifyViewRestarted(): void {
    if (this.disposed) {
      return;
    }
    this.pending.dispose();
    this.pending = new PendingRequests(this.errorSink);
  }

  /** Disposes the pending requests, consumer, and request state once. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.pending.dispose();
    this.consumer = undefined;
  }

  private async performFlush(): Promise<boolean> {
    const requestId = this.pending.issueRequestId();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const outcome = await this.pending.sendWithId<EditTransactionFlushResultMessage>(
          requestId,
          VIEW_TO_HOST_MESSAGE_TYPE.editTransactionFlushResult,
          (id) => this.postToView({
            type: HOST_TO_VIEW_MESSAGE_TYPE.requestEditTransactionFlush,
            requestId: id,
          }),
          EDIT_TRANSACTION_FLUSH_TIMEOUT_MS,
        );
        if (outcome.ok) {
          return outcome.response.success;
        }
        if (outcome.failure !== 'timeout') {
          return false;
        }
      } catch (error) {
        this.errorSink.reportInternalError(
          `Could not send the edit transaction flush request: ${String(error)}`,
        );
        return false;
      }
    }

    this.errorSink.reportInternalError(
      `Did not receive the edit transaction flush result after two attempts: ${requestId}`,
    );
    return false;
  }
}
