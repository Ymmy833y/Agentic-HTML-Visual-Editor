import type { ShortcutKey, ShortcutReceiver } from '../editing/shortcut-receiver';
import type { Toolbar } from './toolbar';
import { TOOLBAR_SLOT } from './toolbar-slots';

/**
 * The icon for links.
 *
 * Draws, in a single path in a 24×24 view box, the outline of two chain links (long rings with half-circle ends)
 * overlapping at a slant. It has no fill and no color and is drawn in the toolbar's text color, so it does not sink
 * into the background in a high-contrast theme.
 */
export const LINK_ICON_PATH = 'M9.12 19.12L13.12 15.12A3 3 0 0 0 8.88 10.88L4.88 14.88A3 3 0 0 0 9.12 19.12Z'
  + ' M15.12 13.12L19.12 9.12A3 3 0 0 0 14.88 4.88L10.88 8.88A3 3 0 0 0 15.12 13.12Z';

/**
 * The shortcut key that runs the link operation. It requires only the character k and the primary modifier.
 *
 * The exact match of the modifiers is left to the shortcut receiver's matching. Combinations with Shift or Alt
 * (such as primary modifier+Shift+K) are left to VS Code's key bindings.
 */
export const LINK_SHORTCUT_KEY: ShortcutKey = { character: 'k', primary: true, shift: false, alt: false };

/**
 * Registers, in the toolbar's link slot, an item that opens the link dialog when pressed.
 *
 * No pressed state is passed. The side that follows the caret and reflects the pressed state copies whether the link
 * is formatted. If the registration is refused, this returns without throwing and does not stop the registration of
 * the other items.
 *
 * @param toolbar The toolbar to register in.
 * @param run The operation to call when pressed.
 */
export function registerLinkButton(toolbar: Toolbar, run: () => void): void {
  toolbar.register(TOOLBAR_SLOT.link, {
    kind: 'button',
    messageKey: 'toolbar.link',
    iconPath: LINK_ICON_PATH,
    run,
  });
}

/**
 * Registers, at the end of the shortcut receiver's list, a shortcut that opens the link dialog with primary
 * modifier+K.
 *
 * The key is taken over and its default action prevented even when the dialog does not open (during a composition,
 * inside a `pre`, and so on). In VS Code, Ctrl+K (Cmd+K on macOS) is the first stroke of two-stroke key bindings,
 * and if it reaches VS Code, VS Code takes the next stroke.
 *
 * @param receiver The shortcut receiver.
 * @param run The operation to call when the key is pressed.
 */
export function registerLinkShortcut(receiver: ShortcutReceiver, run: () => void): void {
  receiver.register({
    key: LINK_SHORTCUT_KEY,
    run: () => {
      run();
      return 'preventDefault';
    },
  });
}
