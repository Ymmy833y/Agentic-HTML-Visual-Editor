// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestId, ResponseMessage } from '../../common/index';
import type { InternalErrorSink } from '../../src/diagnostics/error-reporter';
import { PendingRequests } from '../../src/messaging/pending-requests';

// Response content differs between requests. Include a distinguishable field to confirm that values
// other than the request ID are carried with the response.
interface ProbeResponse extends ResponseMessage {
  readonly type: typeof PROBE_TYPE;
  readonly value: string;
}

// The response type. Tests also use a different type to confirm that a matching request ID alone is
// not accepted.
const PROBE_TYPE = 'probeResponse';

const TIMEOUT_MS = 100;

interface RecordingSink extends InternalErrorSink {
  readonly lines: string[];
}

/** Creates an internal error sink that only records received lines. */
function createSink(): RecordingSink {
  const lines: string[] = [];
  return { lines, reportInternalError: (detail) => lines.push(detail) };
}

describe('pending requests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a matching response as a success', async () => {
    const requests = new PendingRequests(createSink(), TIMEOUT_MS);
    const issued: RequestId[] = [];

    const outcome = requests.send<ProbeResponse>(PROBE_TYPE, (requestId) => issued.push(requestId));
    const response: ProbeResponse = { type: PROBE_TYPE, requestId: issued[0], value: 'snapshot' };
    requests.settle(response);

    expect(await outcome).toEqual({ ok: true, response });
  });

  it('issues different request IDs for two requests', () => {
    const requests = new PendingRequests(createSink(), TIMEOUT_MS);
    const issued: RequestId[] = [];

    requests.send<ProbeResponse>(PROBE_TYPE, (requestId) => issued.push(requestId));
    requests.send<ProbeResponse>(PROBE_TYPE, (requestId) => issued.push(requestId));

    expect(issued[0]).not.toBe(issued[1]);
  });

  it('correlates two responses even when they arrive in reverse order', async () => {
    const requests = new PendingRequests(createSink(), TIMEOUT_MS);
    const issued: RequestId[] = [];

    const first = requests.send<ProbeResponse>(PROBE_TYPE, (requestId) => issued.push(requestId));
    const second = requests.send<ProbeResponse>(PROBE_TYPE, (requestId) => issued.push(requestId));
    const firstResponse: ProbeResponse = { type: PROBE_TYPE, requestId: issued[0], value: 'first' };
    const secondResponse: ProbeResponse = { type: PROBE_TYPE, requestId: issued[1], value: 'second' };
    requests.settle(secondResponse);
    requests.settle(firstResponse);

    expect([await first, await second]).toEqual([
      { ok: true, response: firstResponse },
      { ok: true, response: secondResponse },
    ]);
  });

  it('rejects a response with a request ID that was never issued', () => {
    const requests = new PendingRequests(createSink(), TIMEOUT_MS);

    expect(requests.settle({ type: PROBE_TYPE, requestId: 'never-issued' })).toBe(false);
  });

  it('rejects a different response type for a matching request ID and lets the request time out', async () => {
    const requests = new PendingRequests(createSink(), TIMEOUT_MS);
    const issued: RequestId[] = [];

    const outcome = requests.send<ProbeResponse>(PROBE_TYPE, (requestId) => issued.push(requestId));
    const accepted = requests.settle({ type: 'anotherResponse', requestId: issued[0] });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect([accepted, await outcome]).toEqual([false, { ok: false, failure: 'timeout' }]);
  });

  it('clears the timeout for a request after accepting a response', () => {
    const requests = new PendingRequests(createSink(), TIMEOUT_MS);
    const issued: RequestId[] = [];

    requests.send<ProbeResponse>(PROBE_TYPE, (requestId) => issued.push(requestId));
    requests.settle({ type: PROBE_TYPE, requestId: issued[0] });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns a timeout failure when no response arrives by the deadline', async () => {
    const requests = new PendingRequests(createSink(), TIMEOUT_MS);

    const outcome = requests.send<ProbeResponse>(PROBE_TYPE, () => undefined);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(await outcome).toEqual({ ok: false, failure: 'timeout' });
  });

  it('uses the default two-second timeout when no timeout is specified', async () => {
    const requests = new PendingRequests(createSink());
    let settled = false;

    const outcome = requests.send<ProbeResponse>(PROBE_TYPE, () => undefined).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toEqual({ ok: false, failure: 'timeout' });
  });

  it('rejects a response with the same request ID after the request times out', async () => {
    const requests = new PendingRequests(createSink(), TIMEOUT_MS);
    const issued: RequestId[] = [];

    requests.send<ProbeResponse>(PROBE_TYPE, (requestId) => issued.push(requestId));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(requests.settle({ type: PROBE_TYPE, requestId: issued[0] })).toBe(false);
  });

  it('immediately resolves all pending requests with view-disposed failures when disposed', async () => {
    const requests = new PendingRequests(createSink(), TIMEOUT_MS);

    const first = requests.send<ProbeResponse>(PROBE_TYPE, () => undefined);
    const second = requests.send<ProbeResponse>(PROBE_TYPE, () => undefined);
    requests.dispose();

    expect([await first, await second]).toEqual([
      { ok: false, failure: 'viewDisposed' },
      { ok: false, failure: 'viewDisposed' },
    ]);
  });

  it('does not send after disposal and returns a view-disposed failure', async () => {
    const requests = new PendingRequests(createSink(), TIMEOUT_MS);
    const post = vi.fn();

    requests.dispose();
    const outcome = await requests.send<ProbeResponse>(PROBE_TYPE, post);

    expect([outcome, post.mock.calls.length]).toEqual([{ ok: false, failure: 'viewDisposed' }, 0]);
  });

  it('records a timeout as an internal error when no response arrives by the deadline', async () => {
    const sink = createSink();
    const requests = new PendingRequests(sink, TIMEOUT_MS);

    requests.send<ProbeResponse>(PROBE_TYPE, () => undefined);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(sink.lines).toHaveLength(1);
  });

  it('does not record an internal error when a response arrives by the deadline', async () => {
    const sink = createSink();
    const requests = new PendingRequests(sink, TIMEOUT_MS);
    const issued: RequestId[] = [];

    requests.send<ProbeResponse>(PROBE_TYPE, (requestId) => issued.push(requestId));
    requests.settle({ type: PROBE_TYPE, requestId: issued[0] });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(sink.lines).toEqual([]);
  });

  it('does not record an internal error when view disposal settles the request', async () => {
    const sink = createSink();
    const requests = new PendingRequests(sink, TIMEOUT_MS);

    requests.send<ProbeResponse>(PROBE_TYPE, () => undefined);
    requests.dispose();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(sink.lines).toEqual([]);
  });

  it('leaves no pending request or timeout after sending throws', async () => {
    const requests = new PendingRequests(createSink(), TIMEOUT_MS);
    const issued: RequestId[] = [];

    const outcome = requests.send<ProbeResponse>(PROBE_TYPE, (requestId) => {
      issued.push(requestId);
      throw new Error('Failed to send');
    });

    await expect(outcome).rejects.toThrow('Failed to send');
    expect([
      requests.settle({ type: PROBE_TYPE, requestId: issued[0] }),
      vi.getTimerCount(),
    ]).toEqual([false, 0]);
  });
});

describe('sending with a specified request id', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('settles on a response with the same id when retried with the same request id', async () => {
    const requests = new PendingRequests(createSink(), TIMEOUT_MS);
    const requestId = requests.issueRequestId();
    const sentTo: RequestId[] = [];

    const timedOut = requests.sendWithId<ProbeResponse>(requestId, PROBE_TYPE, (id) => sentTo.push(id));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await timedOut;
    const retried = requests.sendWithId<ProbeResponse>(requestId, PROBE_TYPE, (id) => sentTo.push(id));
    const response: ProbeResponse = { type: PROBE_TYPE, requestId, value: 'held' };
    requests.settle(response);

    expect([sentTo, await retried]).toEqual([[requestId, requestId], { ok: true, response }]);
  });

  it('returns a distinct request id on each call without colliding with existing sends', () => {
    const requests = new PendingRequests(createSink(), TIMEOUT_MS);
    const issued: RequestId[] = [];

    issued.push(requests.issueRequestId());
    requests.send<ProbeResponse>(PROBE_TYPE, (requestId) => issued.push(requestId));
    issued.push(requests.issueRequestId());

    expect(new Set(issued).size).toBe(issued.length);
  });
});

describe('per-request timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not time out at the default timeout when a per-request timeout is given', async () => {
    const requests = new PendingRequests(createSink(), TIMEOUT_MS);

    const outcome = requests.send<ProbeResponse>(PROBE_TYPE, () => undefined, TIMEOUT_MS * 5);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2);
    const settledEarly = vi.getTimerCount() === 0;
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 5);

    expect([settledEarly, await outcome]).toEqual([false, { ok: false, failure: 'timeout' }]);
  });

  it('lets two requests with different timeouts wait in one registry', async () => {
    const requests = new PendingRequests(createSink(), TIMEOUT_MS);
    const issued: RequestId[] = [];

    const shortLived = requests.send<ProbeResponse>(PROBE_TYPE, (requestId) => issued.push(requestId));
    const longLived = requests.send<ProbeResponse>(
      PROBE_TYPE,
      (requestId) => issued.push(requestId),
      TIMEOUT_MS * 5,
    );
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const response: ProbeResponse = { type: PROBE_TYPE, requestId: issued[1], value: 'late' };
    requests.settle(response);

    expect([await shortLived, await longLived]).toEqual([
      { ok: false, failure: 'timeout' },
      { ok: true, response },
    ]);
  });
});

describe('view recreation', () => {
  it('settles old requests on restart and changes the next id so a late old response does not settle a new request', async () => {
    const requests = new PendingRequests(createSink(), TIMEOUT_MS);
    const issued: RequestId[] = [];

    const stale = requests.send<ProbeResponse>(PROBE_TYPE, (requestId) => issued.push(requestId));
    requests.abandonForViewRestart();
    const fresh = requests.send<ProbeResponse>(PROBE_TYPE, (requestId) => issued.push(requestId));
    const lateStaleResponse: ProbeResponse = { type: PROBE_TYPE, requestId: issued[0], value: 'stale' };
    const acceptedLate = requests.settle(lateStaleResponse);
    const freshResponse: ProbeResponse = { type: PROBE_TYPE, requestId: issued[1], value: 'fresh' };
    requests.settle(freshResponse);

    expect(await stale).toEqual({ ok: false, failure: 'viewDisposed' });
    expect([issued[0] !== issued[1], acceptedLate, await fresh])
      .toEqual([true, false, { ok: true, response: freshResponse }]);
  });
});
