import type { Toolbar } from './toolbar';
import { TOOLBAR_SLOT } from './toolbar-slots';

/**
 * The icon that represents a comment.
 *
 * Draws the outline of a speech bubble with a tail at the lower left as one path in a 24×24 view box. It has no color of its own
 * and uses the toolbar's color as is, so it does not sink into the background in high contrast themes either.
 */
export const COMMENT_ICON_PATH = 'M4 5h16v11H10l-4 4v-4H4Z';

/**
 * Registers the comment button in the toolbar's comment slot.
 *
 * Passes no pressed state, because the item does not represent a current state; it is an operation that creates a comment
 * or opens an existing thread. The operation is called through the toolbar activation and is not called during an input stop
 * or a composition. A rejected registration returns without throwing, so it does not stop the registration of other items.
 *
 * @param toolbar The toolbar to register in.
 * @param run The operation called on press.
 */
export function registerCommentButton(toolbar: Toolbar, run: () => void): void {
  toolbar.register(TOOLBAR_SLOT.comment, {
    kind: 'button',
    messageKey: 'toolbar.comment',
    iconPath: COMMENT_ICON_PATH,
    run,
  });
}
