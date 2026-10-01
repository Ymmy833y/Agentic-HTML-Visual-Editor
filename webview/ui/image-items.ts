import type { Toolbar } from './toolbar';
import { TOOLBAR_SLOT } from './toolbar-slots';

// The mouse button a click on an image must use (the primary button).
const PRIMARY_BUTTON = 0;

/**
 * The icon that represents an image.
 *
 * Draws a picture frame rectangle holding the polyline of a mountain ridge and a small circle for the sun,
 * as one path in a 24×24 view box. It has no fill and no color and is drawn in the strip's text color, so
 * it does not sink into the background in high contrast themes.
 */
export const IMAGE_ICON_PATH = 'M4 5h16v14H4Z M4 16l4.5-4.5 3.5 3.5 2.5-2.5 5.5 5.5'
  + ' M16.5 7.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3';

/**
 * Registers an item that opens the image dialog when pressed into the toolbar's image slot.
 *
 * An image has no formatted state, so no pressed state is passed. If the registration is rejected, it
 * returns without throwing and does not stop the other items from being registered.
 *
 * @param toolbar The toolbar to register into.
 * @param run The operation to call when pressed.
 */
export function registerImageButton(toolbar: Toolbar, run: () => void): void {
  toolbar.register(TOOLBAR_SLOT.image, {
    kind: 'button',
    messageKey: 'toolbar.image',
    iconPath: IMAGE_ICON_PATH,
    run,
  });
}

/**
 * Attaches one click listener to the editor root that calls an operation with an image clicked in it.
 *
 * Only a primary-button click without modifiers counts. A click with a modifier means something else, such as
 * following the link that holds the image with the primary modifier, or extending the selection with Shift. Neither
 * the default nor propagation is stopped, so the listeners that handle the same click for comments and links still
 * see it.
 *
 * @param root The editor root. It stays the same element across document replacements, so call this only once, on
 *   the first mount.
 * @param open The operation to call with the clicked image.
 */
export function attachImageClick(root: HTMLElement, open: (image: Element) => void): void {
  root.addEventListener('click', (event) => {
    if (event.button !== PRIMARY_BUTTON || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.localName === 'img') {
      open(target);
    }
  });
}
