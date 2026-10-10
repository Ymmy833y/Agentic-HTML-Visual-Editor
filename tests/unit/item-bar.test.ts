import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { matchesShortcutKey } from '../../webview/editing/shortcut-receiver';
import { REACH_KEY, attachItemBar, readNextStopIndex } from '../../webview/ui/item-bar';

/** The item bar's elements and the record of port calls. */
interface Harness {
  readonly items: HTMLButtonElement[];
  /** A button of popup contents placed inside an item's container. */
  readonly contentsButton: HTMLButtonElement;
  readonly hasShortcut: Mock<(event: KeyboardEvent) => boolean>;
  readonly returnToEditor: Mock<() => void>;
  /**
   * The keys of presses that reached the bubbling phase of the document. Whether propagation was
   * stopped cannot be read from a press after it has been dispatched.
   */
  readonly reached: string[];
}

// Subscriptions on the document would outlive a test, so they are removed after each one.
let subscriptions = new AbortController();

beforeEach(() => {
  subscriptions = new AbortController();
});

afterEach(() => {
  subscriptions.abort();
});

/**
 * Attaches an item bar with three items. The container of the second item holds the contents of an
 * open popup.
 *
 * @returns The item bar's elements and the record of port calls.
 */
function createHarness(): Harness {
  document.body.replaceChildren();
  const bar = document.createElement('div');
  const items = [0, 1, 2].map(() => {
    const container = document.createElement('div');
    const button = document.createElement('button');
    button.type = 'button';
    container.append(button);
    bar.append(container);
    return button;
  });
  const contents = document.createElement('div');
  const contentsButton = document.createElement('button');
  contents.append(contentsButton);
  items[1].parentElement?.append(contents);
  document.body.append(bar);

  const hasShortcut = vi.fn<(event: KeyboardEvent) => boolean>(() => true);
  const returnToEditor = vi.fn<() => void>();
  attachItemBar(bar, { readButtons: () => items, hasShortcut, returnToEditor });
  const reached: string[] = [];
  document.addEventListener('keydown', (event) => reached.push(event.key), { signal: subscriptions.signal });
  return { items, contentsButton, hasShortcut, returnToEditor, reached };
}

/**
 * Dispatches a key press that bubbles and whose default action can be prevented.
 *
 * @param target The target of the press.
 * @param init The contents of the press.
 * @returns The dispatched press.
 */
function press(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('the next stop index', () => {
  it('returns the next and previous for Right and Left, wrapping to the opposite end, and the first and last for Home and End', () => {
    expect([
      readNextStopIndex(0, 3, 'ArrowRight'),
      readNextStopIndex(2, 3, 'ArrowRight'),
      readNextStopIndex(2, 3, 'ArrowLeft'),
      readNextStopIndex(0, 3, 'ArrowLeft'),
      readNextStopIndex(1, 3, 'Home'),
      readNextStopIndex(1, 3, 'End'),
    ]).toEqual([1, 0, 1, 2, 0, 2]);
  });

  it('returns the current position for any key when there is a single item', () => {
    expect([
      readNextStopIndex(0, 1, 'ArrowRight'),
      readNextStopIndex(0, 1, 'ArrowLeft'),
      readNextStopIndex(0, 1, 'Home'),
      readNextStopIndex(0, 1, 'End'),
    ]).toEqual([0, 0, 0, 0]);
  });
});

describe('key presses in the item bar', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('calls no port and stops neither propagation nor the default action for a press whose target is not an item (Esc or Right on a button inside the contents)', () => {
    const harness = createHarness();

    const escape = press(harness.contentsButton, { key: 'Escape', code: 'Escape' });
    const right = press(harness.contentsButton, { key: 'ArrowRight', code: 'ArrowRight' });

    expect([
      harness.returnToEditor.mock.calls.length,
      harness.hasShortcut.mock.calls.length,
      harness.reached,
      escape.defaultPrevented,
      right.defaultPrevented,
    ]).toEqual([0, 0, ['Escape', 'ArrowRight'], false, false]);
  });

  it('stops only propagation, not the default action, for Enter and Space on an item', () => {
    const harness = createHarness();

    const enter = press(harness.items[0], { key: 'Enter', code: 'Enter' });
    const space = press(harness.items[0], { key: ' ', code: 'Space' });

    expect([harness.reached, enter.defaultPrevented, space.defaultPrevented]).toEqual([[], false, false]);
  });
});

describe('the reach key', () => {
  it('does not match F10, Alt+Shift+F10 or Ctrl+Alt+F10 against the reach key', () => {
    const f10 = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', { key: 'F10', code: 'F10', ...init });

    expect([
      matchesShortcutKey(REACH_KEY, f10({}), 'other'),
      matchesShortcutKey(REACH_KEY, f10({ altKey: true, shiftKey: true }), 'other'),
      matchesShortcutKey(REACH_KEY, f10({ altKey: true, ctrlKey: true }), 'other'),
    ]).toEqual([false, false, false]);
  });
});
