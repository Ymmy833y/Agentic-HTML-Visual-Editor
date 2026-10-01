import { describe, expect, it } from 'vitest';

import type { Shortcut } from '../../webview/editing/shortcut-receiver';
import { registerSearchShortcut } from '../../webview/search/search-key';

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
