import { describe, expect, it } from 'vitest';

import type { Shortcut } from '../../webview/editing/shortcut-receiver';
import { registerReplaceShortcut, registerSearchShortcut } from '../../webview/search/search-key';

/**
 * Creates a receiver double that records registered items.
 *
 * @returns The receiver and the record of registered items.
 */
function createReceiver(): { receiver: { register(shortcut: Shortcut): void }; shortcuts: Shortcut[] } {
  const shortcuts: Shortcut[] = [];
  return { receiver: { register: (shortcut) => shortcuts.push(shortcut) }, shortcuts };
}

/**
 * Creates a key press to pass to the item's operation. The operation does not read the press's contents.
 *
 * @returns A primary modifier+F press.
 */
function createKeyDown(): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true });
}

describe('registering the Ctrl+F item', () => {
  it('registers one item with the receiver that requires the letter f and the primary modifier, without Shift or Alt', () => {
    const { receiver, shortcuts } = createReceiver();

    registerSearchShortcut(receiver, () => undefined, () => false);

    expect(shortcuts.map((shortcut) => shortcut.key)).toEqual([
      { character: 'f', primary: true, shift: false, alt: false },
    ]);
  });

  it('calls the open operation once and returns preventDefault when not composing', () => {
    const { receiver, shortcuts } = createReceiver();
    let opened = 0;
    registerSearchShortcut(receiver, () => {
      opened += 1;
    }, () => false);

    const outcome = shortcuts[0].run(createKeyDown());

    expect([opened, outcome]).toEqual([1, 'preventDefault']);
  });

  it('returns preventDefault without calling the open operation while composing', () => {
    const { receiver, shortcuts } = createReceiver();
    let opened = 0;
    registerSearchShortcut(receiver, () => {
      opened += 1;
    }, () => true);

    const outcome = shortcuts[0].run(createKeyDown());

    expect([opened, outcome]).toEqual([0, 'preventDefault']);
  });
});

describe('registering the replace item', () => {
  it('requires primary modifier+H outside macOS, and Cmd+Option+F on macOS, where Cmd+H hides the application', () => {
    const other = createReceiver();
    const mac = createReceiver();

    registerReplaceShortcut(other.receiver, 'other', () => undefined, () => false);
    registerReplaceShortcut(mac.receiver, 'mac', () => undefined, () => false);

    expect([other.shortcuts.map((shortcut) => shortcut.key), mac.shortcuts.map((shortcut) => shortcut.key)]).toEqual([
      [{ character: 'h', primary: true, shift: false, alt: false }],
      [{ character: 'f', primary: true, shift: false, alt: true }],
    ]);
  });

  it('calls the open operation only when not composing, and returns preventDefault either way', () => {
    const { receiver, shortcuts } = createReceiver();
    let opened = 0;
    let composing = false;
    registerReplaceShortcut(receiver, 'other', () => {
      opened += 1;
    }, () => composing);

    const outcomes = [shortcuts[0].run(createKeyDown())];
    composing = true;
    outcomes.push(shortcuts[0].run(createKeyDown()));

    expect([opened, outcomes]).toEqual([1, ['preventDefault', 'preventDefault']]);
  });
});
