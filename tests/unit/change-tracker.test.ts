import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChangeTracker, OUTPUT_DEBOUNCE_MS } from '../../webview/editing/change-tracker';
import type { OutputReceiver } from '../../webview/editing/change-tracker';
import type { BodyOutput } from '../../webview/document/serialization-state';

const OUTPUT: BodyOutput = { body: '\n<p>a</p>\n', current: '\n<p>a</p>' };

/**
 * Creates an output receiver that records its calls.
 *
 * @returns The output receiver and recorded values.
 */
function createReceiver(): {
  receiver: OutputReceiver;
  kinds: string[];
  outputs: BodyOutput[];
} {
  const kinds: string[] = [];
  const outputs: BodyOutput[] = [];
  return {
    receiver: {
      onEditDetected: (kind) => kinds.push(kind),
      onBodyOutput: (output) => outputs.push(output),
    },
    kinds,
    outputs,
  };
}

describe('change tracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('immediately reports each detection with its input type', () => {
    const { receiver, kinds } = createReceiver();
    const tracker = new ChangeTracker(() => OUTPUT);
    tracker.setReceiver(receiver);

    tracker.notify('insertText');
    tracker.notify('insertParagraph');

    expect(kinds).toEqual(['insertText', 'insertParagraph']);
  });

  it('produces output once after the interval from the last consecutive detection', () => {
    const { receiver, outputs } = createReceiver();
    const createBodyOutput = vi.fn(() => OUTPUT);
    const tracker = new ChangeTracker(createBodyOutput);
    tracker.setReceiver(receiver);

    tracker.notify('insertText');
    vi.advanceTimersByTime(100);
    tracker.notify('insertText');
    vi.advanceTimersByTime(100);
    tracker.notify('insertText');
    vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS);

    expect(createBodyOutput).toHaveBeenCalledTimes(1);
    expect(outputs).toEqual([OUTPUT]);
  });

  it('extends the deadline when another edit is detected within the interval', () => {
    const { receiver, outputs } = createReceiver();
    const tracker = new ChangeTracker(() => OUTPUT);
    tracker.setReceiver(receiver);

    tracker.notify('insertText');
    vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS - 1);
    tracker.notify('insertText');
    vi.advanceTimersByTime(1);

    expect(outputs).toEqual([]);
  });

  it('flushes output before the deadline without emitting it again when the deadline arrives', () => {
    const { receiver, outputs } = createReceiver();
    const tracker = new ChangeTracker(() => OUTPUT);
    tracker.setReceiver(receiver);
    tracker.notify('insertText');

    tracker.flush();
    vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS);

    expect(outputs).toEqual([OUTPUT]);
  });

  it('does not produce output when flushing without a pending change', () => {
    const createBodyOutput = vi.fn(() => OUTPUT);
    const tracker = new ChangeTracker(createBodyOutput);
    tracker.setReceiver(createReceiver().receiver);

    tracker.flush();

    expect(createBodyOutput).not.toHaveBeenCalled();
  });

  it('does not throw on detection or deadline arrival without a registered receiver', () => {
    const createBodyOutput = vi.fn(() => OUTPUT);
    const tracker = new ChangeTracker(createBodyOutput);

    tracker.notify('insertText');

    expect(() => vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS)).not.toThrow();
    expect(createBodyOutput).toHaveBeenCalledTimes(1);
  });

  it('does not call the receiver when output generation returns nothing', () => {
    const { receiver, outputs } = createReceiver();
    const tracker = new ChangeTracker(() => undefined);
    tracker.setReceiver(receiver);
    tracker.notify('insertText');

    tracker.flush();

    expect(outputs).toEqual([]);
  });

  it('emits no output after disposal and ignores subsequent detections', () => {
    const { receiver, kinds, outputs } = createReceiver();
    const tracker = new ChangeTracker(() => OUTPUT);
    tracker.setReceiver(receiver);
    tracker.notify('insertText');

    tracker.dispose();
    vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS);
    tracker.notify('insertText');

    expect(outputs).toEqual([]);
    expect(kinds).toEqual(['insertText']);
  });
});

describe('discarding a pending change', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('produces no body output once the deadline passes after the pending wait is discarded', () => {
    const { receiver, outputs } = createReceiver();
    const createBodyOutput = vi.fn(() => OUTPUT);
    const tracker = new ChangeTracker(createBodyOutput);
    tracker.setReceiver(receiver);
    tracker.notify('insertText');

    tracker.discardPending();
    vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS);

    expect([outputs, createBodyOutput.mock.calls.length]).toEqual([[], 0]);
  });

  it('still turns a later detection into output after discarding with nothing pending', () => {
    const { receiver, outputs } = createReceiver();
    const tracker = new ChangeTracker(() => OUTPUT);
    tracker.setReceiver(receiver);

    tracker.discardPending();
    tracker.notify('insertText');
    vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS);

    expect(outputs).toEqual([OUTPUT]);
  });
});

describe('Listeners that receive the edit trigger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('on detecting an edit, both the output receiver and the registered listener receive the trigger', () => {
    const { receiver, kinds } = createReceiver();
    const detected: string[] = [];
    const tracker = new ChangeTracker(() => OUTPUT);
    tracker.setReceiver(receiver);
    tracker.addEditListener((kind) => detected.push(kind));

    tracker.notify('insertText');

    expect([kinds, detected]).toEqual([['insertText'], ['insertText']]);
  });

  it('body output generation and debouncing work as before even with no listener registered', () => {
    const { receiver, outputs } = createReceiver();
    const createBodyOutput = vi.fn(() => OUTPUT);
    const tracker = new ChangeTracker(createBodyOutput);
    tracker.setReceiver(receiver);

    tracker.notify('insertText');
    vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS);

    expect([outputs, createBodyOutput.mock.calls.length]).toEqual([[OUTPUT], 1]);
  });

  it('does not call the registered listener when an edit is detected after disposal', () => {
    const detected: string[] = [];
    const tracker = new ChangeTracker(() => OUTPUT);
    tracker.addEditListener((kind) => detected.push(kind));

    tracker.dispose();
    tracker.notify('insertText');

    expect(detected).toEqual([]);
  });
});
