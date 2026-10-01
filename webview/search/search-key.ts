import type { ShortcutKey, ShortcutReceiver } from '../editing/shortcut-receiver';

/**
 * The key combination that opens the search panel. Requires only the letter f and the primary modifier.
 *
 * Exact matching of modifiers is left to the receiver's lookup. Combinations with Shift or Alt (such as primary
 * modifier+Shift+F) are left to VS Code's own keybindings.
 */
export const SEARCH_KEY: ShortcutKey = { character: 'f', primary: true, shift: false, alt: false };

/**
 * Appends an item to the end of the receiver's list that opens the search panel on primary modifier+F.
 *
 * The key is taken over and its default action prevented even during IME composition. If it reached VS Code, VS
 * Code's own search would open. The receiver stays the same across document replacements, so this is called only
 * once, on the first mount.
 *
 * @param receiver The receiver.
 * @param open The operation that opens the search panel.
 * @param isComposing Returns whether IME composition was in progress at the time of the key press.
 */
export function registerSearchShortcut(
  receiver: Pick<ShortcutReceiver, 'register'>,
  open: () => void,
  isComposing: () => boolean,
): void {
  receiver.register({
    key: SEARCH_KEY,
    run: () => {
      // Moving focus to the search field during composition would commit the text being converted regardless of the
      // user's intent. Pressing the key again after committing opens the panel.
      if (!isComposing()) {
        open();
      }
      return 'preventDefault';
    },
  });
}
