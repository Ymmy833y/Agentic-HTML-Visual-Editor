import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attachShortcutReceiver,
  isAltGraphCharacter,
  isImeProcessKey,
  matchesShortcutKey,
  readShortcutPlatform,
} from '../../webview/editing/shortcut-receiver';
import type {
  ShortcutKey,
  ShortcutOutcome,
  ShortcutReceiver,
} from '../../webview/editing/shortcut-receiver';
import { mountRoot } from './helpers/format-dom';

const SHIFT_DIGIT1: ShortcutKey = { code: 'Digit1', primary: true, shift: true, alt: false };
const ALT_DIGIT1: ShortcutKey = { code: 'Digit1', primary: true, shift: false, alt: true };
const PRIMARY_B: ShortcutKey = { character: 'b', primary: true, shift: false, alt: false };

/** Ctrl+B on Windows. */
const CTRL_B: KeyboardEventInit = { key: 'b', code: 'KeyB', keyCode: 66, ctrlKey: true };

/**
 * Creates a key press that bubbles and whose default action can be prevented.
 *
 * @param init The contents of the key press.
 * @returns The key press.
 */
function keyDown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
}

/** The editor root with the shortcut receiver attached, and a record of the keys that reached the document. */
interface Harness {
  readonly root: HTMLElement;
  readonly receiver: ShortcutReceiver;
  readonly diagnostics: string[];
  /** The key values of the key presses that reached the document's bubbling phase. */
  readonly reached: string[];
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
 * Attaches the shortcut receiver to the editor root and starts recording key presses in the document's bubbling
 * phase.
 *
 * @returns The receiver and the records.
 */
function createHarness(): Harness {
  const root = mountRoot('<p>ab</p>');
  const diagnostics: string[] = [];
  const receiver = attachShortcutReceiver(root, 'other', (detail) => diagnostics.push(detail));
  const reached: string[] = [];
  document.addEventListener('keydown', (event) => reached.push(event.key), {
    signal: subscriptions.signal,
  });
  return { root, receiver, diagnostics, reached };
}

/**
 * Sends a key press to an element.
 *
 * @param target The target of the key press.
 * @param init The contents of the key press.
 * @returns The key press sent.
 */
function press(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = keyDown(init);
  target.dispatchEvent(event);
  return event;
}

describe('Determining the shortcut platform', () => {
  it('user agents containing Macintosh, iPad or iPhone become mac, and Windows and Linux user agents become other', () => {
    expect([
      readShortcutPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'),
      readShortcutPlatform('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15'),
      readShortcutPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'),
      readShortcutPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'),
      readShortcutPlatform('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'),
    ]).toEqual(['mac', 'mac', 'mac', 'other', 'other']);
  });
});

describe('Matching shortcut keys', () => {
  it('a position key (Digit1 with Shift) matches by code regardless of the key value Shift produces (! or =)', () => {
    expect([
      matchesShortcutKey(SHIFT_DIGIT1, keyDown({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }), 'other'),
      matchesShortcutKey(SHIFT_DIGIT1, keyDown({ key: '=', code: 'Digit1', ctrlKey: true, shiftKey: true }), 'other'),
    ]).toEqual([true, true]);
  });

  it('Ctrl+Shift+Alt+Digit1 matches neither the Shift variant nor the Alt variant', () => {
    const event = keyDown({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true, altKey: true });

    expect([
      matchesShortcutKey(SHIFT_DIGIT1, event, 'other'),
      matchesShortcutKey(ALT_DIGIT1, event, 'other'),
    ]).toEqual([false, false]);
  });

  it('pressing Ctrl and Meta together on other, and Ctrl+B on mac, do not match the primary modifier + B key', () => {
    expect([
      matchesShortcutKey(PRIMARY_B, keyDown({ ...CTRL_B, metaKey: true }), 'other'),
      matchesShortcutKey(PRIMARY_B, keyDown(CTRL_B), 'mac'),
    ]).toEqual([false, false]);
  });

  it('the character key b matches even when CapsLock delivers B', () => {
    expect(matchesShortcutKey(PRIMARY_B, keyDown({ ...CTRL_B, key: 'B' }), 'other')).toBe(true);
  });

  it('when the key value is not a letter (и on the Russian layout), a code of KeyB matches the b key', () => {
    expect(matchesShortcutKey(PRIMARY_B, keyDown({ ...CTRL_B, key: 'и' }), 'other')).toBe(true);
  });

  it('when the key value is a letter the code is not checked, so a key value of x does not match the b key even with a code of KeyB', () => {
    expect(matchesShortcutKey(PRIMARY_B, keyDown({ ...CTRL_B, key: 'x' }), 'other')).toBe(false);
  });
});

describe('Telling apart key presses that become character input', () => {
  it('on other, Ctrl+Alt+Digit2 is true when the key value is ² and false when it is 2', () => {
    expect([
      isAltGraphCharacter(keyDown({ key: '²', code: 'Digit2', ctrlKey: true, altKey: true }), 'other'),
      isAltGraphCharacter(keyDown({ key: '2', code: 'Digit2', ctrlKey: true, altKey: true }), 'other'),
    ]).toEqual([true, false]);
  });

  it('on other, Ctrl+Alt with a key value of Dead is true, and on mac it is false regardless of the key value', () => {
    expect([
      isAltGraphCharacter(keyDown({ key: 'Dead', code: 'Equal', ctrlKey: true, altKey: true }), 'other'),
      isAltGraphCharacter(keyDown({ key: 'Dead', code: 'Equal', ctrlKey: true, altKey: true }), 'mac'),
      isAltGraphCharacter(keyDown({ key: '²', code: 'Digit2', ctrlKey: true, altKey: true }), 'mac'),
    ]).toEqual([true, false, false]);
  });

  it('is true when the key value is Process or the key code is 229, and false for a key value of b with key code 66 even during a composition', () => {
    expect([
      isImeProcessKey(keyDown({ key: 'Process', code: 'KeyB' })),
      isImeProcessKey(keyDown({ key: 'b', code: 'KeyB', keyCode: 229 })),
      isImeProcessKey(keyDown({ ...CTRL_B, isComposing: true })),
    ]).toEqual([true, true, false]);
  });
});

describe('Handling key presses', () => {
  it('when a shortcut that prevents the default takes the key over, it does not reach the document subscription and the default action is stopped', () => {
    const { root, receiver, reached } = createHarness();
    receiver.register({ key: PRIMARY_B, run: () => 'preventDefault' });

    const event = press(root, CTRL_B);

    expect([reached, event.defaultPrevented]).toEqual([[], true]);
  });

  it('when a shortcut that allows the default takes the key over, it does not reach the document and the default action is not stopped', () => {
    const { root, receiver, reached } = createHarness();
    receiver.register({ key: PRIMARY_B, run: () => 'allowDefault' });

    const event = press(root, CTRL_B);

    expect([reached, event.defaultPrevented]).toEqual([[], false]);
  });

  it('with 2 shortcuts for the same key, the second is called only when the first does not take the key over, and not when it does', () => {
    const { root, receiver } = createHarness();
    const calls: string[] = [];
    let firstOutcome: ShortcutOutcome = 'pass';
    receiver.register({
      key: PRIMARY_B,
      run: () => {
        calls.push('first');
        return firstOutcome;
      },
    });
    receiver.register({
      key: PRIMARY_B,
      run: () => {
        calls.push('second');
        return 'preventDefault';
      },
    });

    press(root, CTRL_B);
    firstOutcome = 'preventDefault';
    press(root, CTRL_B);

    expect(calls).toEqual(['first', 'second', 'first']);
  });

  it('a key with no matching shortcut and a key no shortcut takes over stop neither propagation nor the default action', () => {
    const { root, receiver, reached } = createHarness();
    receiver.register({ key: PRIMARY_B, run: () => 'pass' });

    const unmatched = press(root, { key: 's', code: 'KeyS', ctrlKey: true });
    const declined = press(root, CTRL_B);

    expect([reached, unmatched.defaultPrevented, declined.defaultPrevented]).toEqual([['s', 'b'], false, false]);
  });

  it('when a shortcut action throws, it does not rethrow, records 1 diagnostic line, and stops propagation and the default action', () => {
    const { receiver, diagnostics } = createHarness();
    receiver.register({
      key: PRIMARY_B,
      run: () => {
        throw new Error('action failure');
      },
    });
    const event = keyDown(CTRL_B);

    // Call the receiver directly. dispatchEvent does not let exceptions thrown by subscribers escape, so it cannot
    // confirm that nothing was thrown.
    receiver.handleKeyDown(event);

    expect([diagnostics.length, event.cancelBubble, event.defaultPrevented]).toEqual([1, true, true]);
  });

  it('for an AltGr character and an IME process key, the action is not called and nothing is stopped even if a shortcut matches', () => {
    const { root, receiver, reached } = createHarness();
    const run = vi.fn((): ShortcutOutcome => 'preventDefault');
    receiver.register({ key: { code: 'Digit2', primary: true, shift: false, alt: true }, run });
    receiver.register({ key: PRIMARY_B, run });

    const altGraph = press(root, { key: '²', code: 'Digit2', ctrlKey: true, altKey: true });
    const process = press(root, { key: 'Process', code: 'KeyB', keyCode: 229, ctrlKey: true });

    expect([run.mock.calls.length, reached, altGraph.defaultPrevented, process.defaultPrevented])
      .toEqual([0, ['²', 'Process'], false, false]);
  });

  it('a key press that is not an IME process key is matched against shortcuts even when it is flagged as composing', () => {
    const { root, receiver } = createHarness();
    const run = vi.fn((): ShortcutOutcome => 'preventDefault');
    receiver.register({ key: PRIMARY_B, run });

    press(root, { ...CTRL_B, isComposing: true });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('for a key aimed at an element outside the editor root, the matching shortcut action is not called', () => {
    const { receiver } = createHarness();
    const run = vi.fn((): ShortcutOutcome => 'preventDefault');
    receiver.register({ key: PRIMARY_B, run });
    const outside = document.createElement('button');
    document.body.append(outside);

    press(outside, CTRL_B);

    expect(run).not.toHaveBeenCalled();
  });
});

describe('the registered key lookup', () => {
  it('returns true for a press matching a registered shortcut key and false for one that does not, calling no operation in either case', () => {
    const { receiver } = createHarness();
    const run = vi.fn((): ShortcutOutcome => 'preventDefault');
    receiver.register({ key: PRIMARY_B, run });

    const matched = receiver.hasShortcut(keyDown(CTRL_B));
    const unmatched = receiver.hasShortcut(keyDown({ key: 's', code: 'KeyS', ctrlKey: true }));

    expect([matched, unmatched, run.mock.calls.length]).toEqual([true, false, 0]);
  });

  it('returns false for an IME process key and an AltGr character even when a shortcut matches', () => {
    const { receiver } = createHarness();
    receiver.register({ key: { code: 'Digit2', primary: true, shift: false, alt: true }, run: () => 'preventDefault' });
    receiver.register({ key: PRIMARY_B, run: () => 'preventDefault' });

    expect([
      receiver.hasShortcut(keyDown({ key: 'Process', code: 'KeyB', keyCode: 229, ctrlKey: true })),
      receiver.hasShortcut(keyDown({ key: '²', code: 'Digit2', ctrlKey: true, altKey: true })),
    ]).toEqual([false, false]);
  });

  it('leaves the propagation and the default action of the press unstopped after the lookup', () => {
    const { receiver } = createHarness();
    receiver.register({ key: PRIMARY_B, run: () => 'preventDefault' });
    const event = keyDown(CTRL_B);

    receiver.hasShortcut(event);

    expect([event.cancelBubble, event.defaultPrevented]).toEqual([false, false]);
  });
});
