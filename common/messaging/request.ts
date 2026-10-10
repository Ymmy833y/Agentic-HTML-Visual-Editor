/** An identifier used to correlate requests and responses. */
export type RequestId = string;

/** The shape required of a request that expects a response. Each request message includes it in its own type. */
export interface RequestMessage {
  readonly requestId: RequestId;
}

/** The shape required of a response. It returns the corresponding request's request ID unchanged. */
export interface ResponseMessage {
  readonly type: string;
  readonly requestId: RequestId;
}

/**
 * Reasons why waiting ended without a response.
 *
 * A missing response is represented as a timeout, so it has no separate failure reason.
 */
export type RequestFailure = 'timeout' | 'viewDisposed';

/**
 * The result of waiting for a response.
 *
 * Failures are returned as values rather than exceptions because a view that does not respond is an
 * expected possibility, not an error. Each caller must decide whether to use the returned content or
 * fall back to the last known content. Treating an empty response as success would make that choice
 * impossible.
 *
 * The response type is a type parameter so that the caller can use the received response directly.
 * The outcome may use that type only after the waiting side has matched both the request ID and the
 * type. There is no default type parameter, forcing the waiting side to state the response type and
 * preventing it from claiming a concrete type without performing that match.
 */
export type RequestOutcome<TResponse extends ResponseMessage> =
  | { readonly ok: true; readonly response: TResponse }
  | { readonly ok: false; readonly failure: RequestFailure };

/** The default timeout for a response, in milliseconds. */
export const RESPONSE_TIMEOUT_MS = 2000;

/** The timeout for waiting for a document replaced ack, in milliseconds. */
export const DOCUMENT_REPLACE_TIMEOUT_MS = 5000;
