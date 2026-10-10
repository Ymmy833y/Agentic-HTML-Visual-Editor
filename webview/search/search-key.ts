import type { ShortcutKey, ShortcutPlatform, ShortcutReceiver } from '../editing/shortcut-receiver';

/**
 * The key combination that opens the search panel. Requires only the letter f and the primary modifier.
 *
 * Exact matching of modifiers is left to the receiver's lookup. Combinations with Shift or Alt (such as primary
 * modifier+Shift+F) are left to VS Code's own keybindings.
 */
export const SEARCH_KEY: ShortcutKey = { character: 'f', primary: true, shift: false, alt: false };

/**
 * The key combinations that open the search panel with the replace row shown, by platform. They are the keys VS Code
 * uses for replace: primary modifier+H, and Cmd+Option+F on macOS, where Cmd+H hides the application.
 */
export const REPLACE_KEYS: Readonly<Record<ShortcutPlatform, ShortcutKey>> = {
  mac: { character: 'f', primary: true, shift: false, alt: true },
  other: { character: 'h', primary: true, shift: false, alt: false },
};

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
  registerOpeningShortcut(receiver, SEARCH_KEY, open, isComposing);
}

/**
 * Appends an item to the end of the receiver's list that opens the search panel with the replace row shown, on the
 * replace key of the platform.
 *
 * The key is taken over in the same way as the search key. If it reached VS Code, VS Code's own replace would open.
 * Called only once, on the first mount, for the same reason.
 *
 * @param receiver The receiver.
 * @param platform The platform that decides the key. Pass the same value as the receiver.
 * @param open The operation that opens the search panel with the replace row shown.
 * @param isComposing Returns whether IME composition was in progress at the time of the key press.
 */
export function registerReplaceShortcut(
  receiver: Pick<ShortcutReceiver, 'register'>,
  platform: ShortcutPlatform,
  open: () => void,
  isComposing: () => boolean,
): void {
  registerOpeningShortcut(receiver, REPLACE_KEYS[platform], open, isComposing);
}

/**
 * Appends an item that opens the search panel and takes the key over, even during composition.
 *
 * @param receiver The receiver.
 * @param key The key combination.
 * @param open The operation that opens the search panel.
 * @param isComposing Returns whether IME composition was in progress at the time of the key press.
 */
function registerOpeningShortcut(
  receiver: Pick<ShortcutReceiver, 'register'>,
  key: ShortcutKey,
  open: () => void,
  isComposing: () => boolean,
): void {
  receiver.register({
    key,
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
