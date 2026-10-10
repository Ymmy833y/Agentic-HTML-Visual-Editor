import { RESPONSE_TIMEOUT_MS } from '../../common/index';
import type { RequestId, RequestOutcome, ResponseMessage } from '../../common/index';
import type { InternalErrorSink } from '../diagnostics/error-reporter';

// The identifier for a timeout timer.
type TimerHandle = object | number;

// setTimeout and clearTimeout are global in both extension hosts, but this layer has neither DOM nor
// Node.js types. Declare only the signatures used here because node:timers cannot be resolved in the
// web extension host.
declare const setTimeout: (handler: () => void, timeoutMs: number) => TimerHandle;
declare const clearTimeout: (handle: TimerHandle) => void;

interface PendingRequest {
  /** The expected response type. A response with a different type is not accepted. */
  readonly expectedType: string;
  readonly resolveOutcome: (outcome: RequestOutcome<ResponseMessage>) => void;
  readonly timer: TimerHandle;
}

/**
 * A registry that waits with a timeout for responses to requests issued by the host, correlating them
 * by request ID and type.
 *
 * Use one registry per panel and dispose it when that panel is disposed. Request IDs need to be unique
 * only within this registry, so each instance can use its own sequence. Recreating the view also
 * replaces its message channel, so a stale response cannot arrive with the same ID.
 */
export class PendingRequests {
  private readonly pending = new Map<RequestId, PendingRequest>();

  private nextRequestId = 1;

  private disposed = false;

  /**
   * Creates an empty pending-request registry.
   *
   * @param errorSink The sink that records timeouts in the diagnostic log.
   * @param timeoutMs The timeout for a response, in milliseconds.
   */
  constructor(
    private readonly errorSink: InternalErrorSink,
    private readonly timeoutMs: number = RESPONSE_TIMEOUT_MS,
  ) {}

  /**
   * Issues a new request id and delegates to the sending path.
   *
   * The promise always resolves by the timeout and never rejects because of a missing response. A
   * failure to send is different: it is an extension-host defect rather than a missing view response,
   * so the pending request is released and the same exception is rethrown to the caller.
   *
   * @param expectedType The expected response type. A response of any other type is rejected and
   * treated as a missing response.
   * @param post A function that receives the request ID and performs the actual send.
   * @param timeoutMs The timeout for this request alone, in milliseconds. Defaults to the value given
   * at construction. A request ID only has to be unique within one registry, so there is no need for a
   * separate registry per timeout.
   * @returns An outcome containing either a response of the expected type or a request failure.
   */
  send<TResponse extends ResponseMessage>(
    expectedType: TResponse['type'],
    post: (requestId: RequestId) => void,
    timeoutMs: number = this.timeoutMs,
  ): Promise<RequestOutcome<TResponse>> {
    return this.sendWithId<TResponse>(this.issueRequestId(), expectedType, post, timeoutMs);
  }

  /**
   * Issues a request id that is unique within this registry.
   *
   * Only issues the id; it does not create a pending request. This is separate so a path that retries the same
   * request after a response is lost can keep using the original request id.
   *
   * @returns The issued request id.
   */
  issueRequestId(): RequestId {
    const requestId = String(this.nextRequestId);
    this.nextRequestId += 1;
    return requestId;
  }

  /**
   * Sends with the supplied request id and waits, with a timeout, for a response of the same id and type.
   *
   * May be called repeatedly with the same request id. The next call must be made only after the previous pending
   * request has timed out and settled. Registering the same id while it is still pending prevents the earlier
   * request from receiving its response.
   *
   * @param requestId Request id to use.
   * @param expectedType The expected response type. A response of any other type is rejected and
   * treated as a missing response.
   * @param post A function that receives the request ID and performs the actual send.
   * @param timeoutMs The timeout for this request alone, in milliseconds.
   * @returns An outcome containing either a response of the expected type or a request failure.
   */
  sendWithId<TResponse extends ResponseMessage>(
    requestId: RequestId,
    expectedType: TResponse['type'],
    post: (requestId: RequestId) => void,
    timeoutMs: number = this.timeoutMs,
  ): Promise<RequestOutcome<TResponse>> {
    if (this.disposed) {
      return Promise.resolve({ ok: false, failure: 'viewDisposed' });
    }

    return new Promise<RequestOutcome<TResponse>>((resolve) => {
      const timer = setTimeout(() => {
        // The timer has already fired and no longer needs to be cleared, so release only the pending request.
        this.pending.delete(requestId);
        // The user cannot act on a missing response, but without the failed request in the diagnostic
        // log, a view defect cannot be diagnosed. Do not log disposal because it is normal termination.
        this.errorSink.reportInternalError(
          `No response of type ${expectedType} arrived for request ${requestId} within ${timeoutMs} ms`,
        );
        resolve({ ok: false, failure: 'timeout' });
      }, timeoutMs);

      // Register before sending because registering after the response arrives would be too late.
      this.pending.set(requestId, {
        expectedType,
        resolveOutcome: (outcome) => {
          // settle invokes this callback only after both the request ID and type match. The response
          // is therefore of the type requested by the caller and may resolve as that type. Type
          // parameters do not exist at runtime, so only the match in settle supports this assertion.
          resolve(outcome as RequestOutcome<TResponse>);
        },
        timer,
      });

      try {
        post(requestId);
      } catch (error) {
        // A response to a request that could not be sent will never arrive, so release it without waiting for the timeout.
        clearTimeout(timer);
        this.pending.delete(requestId);
        throw error;
      }
    });
  }

  /**
   * Settles the pending request whose request ID and type both match the received response.
   *
   * Responses for request IDs already released by a timeout or disposal, and IDs that were never
   * issued, are rejected because stale content could interrupt processing that has already continued
   * with a fallback. The type is also checked because a request ID identifies only which request it is.
   *
   * A rejected response leaves the request pending until it times out with the same failure as a
   * missing response.
   *
   * @param response A response containing its type and request ID.
   * @returns `true` if a pending request matched both the request ID and type and was settled.
   */
  settle(response: ResponseMessage): boolean {
    const pending = this.pending.get(response.requestId);
    if (pending === undefined || pending.expectedType !== response.type) {
      return false;
    }

    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    pending.resolveOutcome({ ok: true, response });
    return true;
  }

  /**
   * Immediately settles every pending request with a view-disposed failure.
   *
   * Subsequent sends return the same failure. Calling this more than once does not change the result.
   */
  dispose(): void {
    this.disposed = true;
    this.releaseAll();
  }

  /**
   * Settles every wait addressed to the old view as a view disposal when the view is recreated.
   *
   * The old view never responds, so waiting until the timeout would keep a save from reaching the unresponsive
   * decision. The receiver keeps serving the same panel, so it is not marked disposed, and the request id
   * sequence is not rewound either. Rewinding would let a late response from the old view settle a new request
   * that reuses the same id.
   */
  abandonForViewRestart(): void {
    this.releaseAll();
  }

  private releaseAll(): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.resolveOutcome({ ok: false, failure: 'viewDisposed' });
    }
  }
}
