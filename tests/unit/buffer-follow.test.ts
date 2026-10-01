// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BUFFER_FOLLOW_POLL_MS,
  BUFFER_FOLLOW_TIMEOUT_MS,
  pollTextBuffer,
} from '../../src/save/buffer-follow';

const WRITTEN_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>ab</p>\n</body>\n</html>\n';
const STALE_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>a</p>\n</body>\n</html>\n';

/** Decision function that settles only when the text matches the written full text. */
function decideMatched(text: string): string | undefined {
  return text === WRITTEN_TEXT ? text : undefined;
}

describe('wait for text buffer follow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately when the initial read produces a final decision', async () => {
    let reads = 0;
    const settled = await pollTextBuffer(
      () => {
        reads += 1;
        return Promise.resolve(WRITTEN_TEXT);
      },
      decideMatched,
      BUFFER_FOLLOW_TIMEOUT_MS,
    );

    expect([settled, reads]).toEqual([WRITTEN_TEXT, 1]);
  });

  it('returns a decision when a later read settles', async () => {
    let current = STALE_TEXT;

    const waiting = pollTextBuffer(
      () => Promise.resolve(current),
      decideMatched,
      BUFFER_FOLLOW_TIMEOUT_MS,
    );
    await vi.advanceTimersByTimeAsync(BUFFER_FOLLOW_POLL_MS * 2);
    current = WRITTEN_TEXT;
    await vi.advanceTimersByTimeAsync(BUFFER_FOLLOW_POLL_MS * 2);

    expect(await waiting).toBe(WRITTEN_TEXT);
  });

  it('returns undefined when no decision is reached before the timeout', async () => {
    const waiting = pollTextBuffer(
      () => Promise.resolve(STALE_TEXT),
      decideMatched,
      BUFFER_FOLLOW_TIMEOUT_MS,
    );
    await vi.advanceTimersByTimeAsync(BUFFER_FOLLOW_TIMEOUT_MS + BUFFER_FOLLOW_POLL_MS);

    expect(await waiting).toBeUndefined();
  });

  it('returns undefined instead of rethrowing when a read fails', async () => {
    const settled = await pollTextBuffer(
      () => Promise.reject(new Error('The text buffer could not be read')),
      decideMatched,
      BUFFER_FOLLOW_TIMEOUT_MS,
    );

    expect(settled).toBeUndefined();
  });

  it('normalizes a CRLF buffer to LF before passing it to the decision function', async () => {
    const received: string[] = [];

    await pollTextBuffer(
      () => Promise.resolve(WRITTEN_TEXT.replace(/\n/g, '\r\n')),
      (text) => {
        received.push(text);
        return text;
      },
      BUFFER_FOLLOW_TIMEOUT_MS,
    );

    expect(received).toEqual([WRITTEN_TEXT]);
  });
});
