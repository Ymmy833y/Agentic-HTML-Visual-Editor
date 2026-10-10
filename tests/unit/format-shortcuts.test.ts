import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BlockOperation } from '../../webview/editing/block-command';
import { BLOCK_KIND } from '../../webview/editing/block-format';
import type { FormatOperation } from '../../webview/editing/format-command';
import { registerFormatShortcuts } from '../../webview/editing/format-shortcuts';
import { attachShortcutReceiver } from '../../webview/editing/shortcut-receiver';
import { mountRoot } from './helpers/format-dom';

/** Key presses to the receiver with the shortcuts registered, and a record of calls to the ports. */
interface Harness {
  /** Operations passed to the format port. */
  readonly formatCalls: FormatOperation[];
  /** Operations passed to the block port. */
  readonly blockCalls: BlockOperation[];
  /** The codes of the key presses that reached the document's bubbling phase. */
  readonly reached: string[];
  /** Sends a key press to the editor root. */
  readonly press: (init: KeyboardEventInit) => KeyboardEvent;
}

// Subscriptions on the document persist across tests, so they are removed after each test.
let subscriptions = new AbortController();

beforeEach(() => {
  subscriptions = new AbortController();
});

afterEach(() => {
  subscriptions.abort();
});

/**
 * Attaches the shortcut receiver on the Windows platform and registers the inline format and block kind shortcuts.
 *
 * @param composing The value the composition read returns.
 * @param changed The value the format and block ports return (whether the tree was changed).
 * @returns The key press port and the records.
 */
function createHarness(composing: boolean, changed: boolean): Harness {
  const root = mountRoot('<p>ab</p>');
  const receiver = attachShortcutReceiver(root, 'other', () => undefined);
  const formatCalls: FormatOperation[] = [];
  const blockCalls: BlockOperation[] = [];
  registerFormatShortcuts(receiver, {
    runFormatCommand: (operation) => {
      formatCalls.push(operation);
      return changed;
    },
    runBlockCommand: (operation) => {
      blockCalls.push(operation);
      return changed;
    },
    isComposing: () => composing,
  });

  const reached: string[] = [];
  document.addEventListener('keydown', (event) => reached.push(event.code), {
    signal: subscriptions.signal,
  });
  const press = (init: KeyboardEventInit): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    root.dispatchEvent(event);
    return event;
  };
  return { formatCalls, blockCalls, reached, press };
}

// The block kinds to convert to, in the order Digit0 to Digit6.
const DIGIT_KINDS = [
  BLOCK_KIND.paragraph,
  BLOCK_KIND.heading1,
  BLOCK_KIND.heading2,
  BLOCK_KIND.heading3,
  BLOCK_KIND.heading4,
  BLOCK_KIND.heading5,
  BLOCK_KIND.heading6,
];

describe('Inline format and block kind shortcuts', () => {
  it('primary modifier+\\ passes clear formatting to the port once and stops propagation and the default action', () => {
    const harness = createHarness(false, true);

    const event = harness.press({ key: '\\', code: 'Backslash', ctrlKey: true });

    expect([harness.formatCalls, harness.reached, event.defaultPrevented])
      .toEqual([[{ kind: 'clear' }], [], true]);
  });

  it('with both primary modifier+Shift and +Alt, Digit1 to 6 pass conversions to heading 1 to 6 and Digit0 a conversion to paragraph to the port', () => {
    const harness = createHarness(false, true);
    const shiftedKeys = [')', '!', '@', '#', '$', '%', '^'];

    for (const [digit, key] of shiftedKeys.entries()) {
      harness.press({ key, code: `Digit${digit}`, ctrlKey: true, shiftKey: true });
    }
    for (const digit of DIGIT_KINDS.keys()) {
      harness.press({ key: String(digit), code: `Digit${digit}`, ctrlKey: true, altKey: true });
    }

    expect(harness.blockCalls)
      .toEqual([...DIGIT_KINDS, ...DIGIT_KINDS].map((to) => ({ kind: 'convert', to })));
  });

  it('primary modifier+B and +I outside a composition call no port, stop only propagation, and do not stop the default action', () => {
    const harness = createHarness(false, true);

    const bold = harness.press({ key: 'b', code: 'KeyB', ctrlKey: true });
    const italic = harness.press({ key: 'i', code: 'KeyI', ctrlKey: true });

    expect([
      harness.formatCalls,
      harness.blockCalls,
      harness.reached,
      bold.defaultPrevented,
      italic.defaultPrevented,
    ]).toEqual([[], [], [], false, false]);
  });

  it('primary modifier+B and +I during a composition call no port and also stop the default action', () => {
    const harness = createHarness(true, true);

    const bold = harness.press({ key: 'b', code: 'KeyB', ctrlKey: true });
    const italic = harness.press({ key: 'i', code: 'KeyI', ctrlKey: true });

    expect([harness.formatCalls, harness.blockCalls, bold.defaultPrevented, italic.defaultPrevented])
      .toEqual([[], [], true, true]);
  });

  it('primary modifier+Shift+Digit1 during a composition still passes the conversion to the port and stops propagation', () => {
    const harness = createHarness(true, true);

    harness.press({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true });

    expect([harness.blockCalls, harness.reached])
      .toEqual([[{ kind: 'convert', to: BLOCK_KIND.heading1 }], []]);
  });

  it('even when the port returns false (the tree was not changed), the key is taken over and propagation and the default action are stopped', () => {
    const harness = createHarness(false, false);

    const clear = harness.press({ key: '\\', code: 'Backslash', ctrlKey: true });
    const heading = harness.press({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true });

    expect([harness.reached, clear.defaultPrevented, heading.defaultPrevented]).toEqual([[], true, true]);
  });

  it('primary modifier+Shift+B and primary modifier+Alt+\\ do not match, call no port, and propagate', () => {
    const harness = createHarness(false, true);

    harness.press({ key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true });
    harness.press({ key: '\\', code: 'Backslash', ctrlKey: true, altKey: true });

    expect([harness.formatCalls, harness.blockCalls, harness.reached])
      .toEqual([[], [], ['KeyB', 'Backslash']]);
  });

  it('Digit7 to 9 and numeric keypad digits call no port', () => {
    const harness = createHarness(false, true);

    harness.press({ key: '&', code: 'Digit7', ctrlKey: true, shiftKey: true });
    harness.press({ key: '*', code: 'Digit8', ctrlKey: true, shiftKey: true });
    harness.press({ key: '9', code: 'Digit9', ctrlKey: true, altKey: true });
    harness.press({ key: '1', code: 'Numpad1', ctrlKey: true, altKey: true });
    harness.press({ key: 'End', code: 'Numpad1', ctrlKey: true, shiftKey: true });

    expect(harness.blockCalls).toEqual([]);
  });
});
