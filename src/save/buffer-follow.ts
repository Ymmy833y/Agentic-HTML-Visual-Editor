import { normalizeLineEndings } from '../../common/index';

// The identifier for a timeout timer.
type TimerHandle = object | number;

// setTimeout is global in both extension hosts, but this layer has neither DOM nor Node.js types.
// Declare only the signature used here because node:timers cannot be resolved in the web extension host.
declare const setTimeout: (handler: () => void, timeoutMs: number) => TimerHandle;

/** The maximum time to wait for the buffer to follow, in milliseconds. */
export const BUFFER_FOLLOW_TIMEOUT_MS = 3000;

/** The interval between re-checks while waiting for the buffer to follow, in milliseconds. */
export const BUFFER_FOLLOW_POLL_MS = 50;

/**
 * Waits for the given duration.
 *
 * @param durationMs The time to wait, in milliseconds.
 */
function delay(durationMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

/**
 * Reads the text buffer repeatedly until a decision is reached or the timeout expires.
 *
 * A clean text buffer follows a direct disk write asynchronously, and the extension is not notified when that
 * completes. Reading without waiting can return the previous content, so this function polls to confirm it.
 *
 * What must be awaited differs by path. One path waits for the buffer to follow the written full text, while another
 * waits for a buffer still at the sync base to move. The caller's decision function therefore owns the matching
 * logic; this function owns only repeated reads and the timeout.
 *
 * @param readBuffer Function that reads the full text buffer. Line endings are normalized inside this function, so
 * the caller must not normalize them.
 * @param decide Function that receives LF-normalized text and returns either a final decision or `undefined` when
 * undecided.
 * @param timeoutMs Maximum wait in milliseconds. A value of zero or less performs only the initial read.
 * @returns The first final decision, or `undefined` if no decision is reached before the timeout.
 */
export async function pollTextBuffer<TResult>(
  readBuffer: () => Promise<string>,
  decide: (text: string) => TResult | undefined,
  timeoutMs: number,
): Promise<TResult | undefined> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let text: string;
    try {
      text = await readBuffer();
    } catch {
      // An unreadable buffer will not become available by waiting. Treat it like a timeout instead of rethrowing.
      return undefined;
    }

    const decided = decide(normalizeLineEndings(text));
    if (decided !== undefined) {
      return decided;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }

    await delay(BUFFER_FOLLOW_POLL_MS);
  }
}
