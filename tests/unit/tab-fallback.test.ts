import { describe, expect, it } from 'vitest';

import { ShortcutReceiver } from '../../webview/editing/shortcut-receiver';
import { registerTabFallback } from '../../webview/editing/tab-fallback';

/**
 * Presses Tab on a receiver with only the fallback registered.
 *
 * @param menuVisible Whether the floating menu is shown.
 * @returns Whether the default was stopped.
 */
function pressTab(menuVisible: boolean): boolean {
  const receiver = new ShortcutReceiver('other', () => undefined);
  registerTabFallback(receiver, () => menuVisible);
  const event = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true });
  receiver.handleKeyDown(event);
  return event.defaultPrevented;
}

describe('the Tab fallback', () => {
  it('takes Tab over and stops the default while the floating menu is hidden', () => {
    expect(pressTab(false)).toBe(true);
  });

  it('lets Tab through while the floating menu is shown', () => {
    expect(pressTab(true)).toBe(false);
  });
});
