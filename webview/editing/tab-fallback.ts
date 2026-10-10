import type { ShortcutKey, ShortcutReceiver } from './shortcut-receiver';

/** The shortcut key the fallback takes (Tab). Shift+Tab is left to the browser, which moves to the fixed toolbar. */
export const TAB_FALLBACK_KEY: ShortcutKey = { code: 'Tab', primary: false, shift: false, alt: false };

/**
 * Appends a Tab shortcut that takes the key over and does nothing, for the places no earlier shortcut handles (outside
 * lists, tables and code blocks). Register it after every other Tab shortcut.
 *
 * Tab outside those places would otherwise move focus to a collapsible section title in the document or out of the
 * view. While the floating menu is shown, Tab is let through, because it is the keyboard's way to reach that menu.
 *
 * @param receiver The shortcut receiver.
 * @param isFloatingMenuVisible Returns whether the floating menu is shown at the time of the call.
 */
export function registerTabFallback(receiver: ShortcutReceiver, isFloatingMenuVisible: () => boolean): void {
  receiver.register({
    key: TAB_FALLBACK_KEY,
    run: () => (isFloatingMenuVisible() ? 'pass' : 'preventDefault'),
  });
}
