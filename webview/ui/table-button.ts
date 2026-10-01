import type { TablePicker } from './table-picker';
import type { Toolbar } from './toolbar';
import { TOOLBAR_SLOT } from './toolbar-slots';

/**
 * The icon representing a table.
 *
 * Draws the outer frame and the rules as a single path in a 24×24 view box. It has no color of its own and uses
 * the toolbar's color as is, so it does not sink into the background even in high-contrast themes.
 */
export const TABLE_ICON_PATH = 'M4 5h16v14H4Z M4 9.5h16 M4 14.25h16 M9.5 5v14 M14.5 5v14';

/**
 * Registers a popup item whose popup is the table picker in the toolbar's table slot.
 *
 * The popup is not a menu, so its kind is registered as dialog. No pressed state is passed, because it is an
 * insert operation and does not represent a current state. If the registration is rejected, returns without
 * doing anything and does not stop other items from being registered.
 *
 * @param toolbar The toolbar to register in.
 * @param picker The table picker.
 */
export function registerTableButton(toolbar: Toolbar, picker: TablePicker): void {
  toolbar.register(TOOLBAR_SLOT.table, {
    kind: 'popup',
    messageKey: 'toolbar.table',
    iconPath: TABLE_ICON_PATH,
    popupKind: 'dialog',
    buildPopup: (container) => picker.buildPopup(container),
    handleClosed: (closure) => picker.handleClosed(closure),
  });
}
