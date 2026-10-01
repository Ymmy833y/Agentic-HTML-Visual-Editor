import { runBlockOperation } from '../editing/block-command';
import type { BlockCommandPorts } from '../editing/block-command';
import type { Toolbar } from './toolbar';
import { TOOLBAR_SLOT } from './toolbar-slots';

/**
 * The icon representing a collapsible section.
 *
 * Drawn as one path in a 24x24 viewBox. It carries no color of its own, so the toolbar's own color is
 * used as-is and it does not sink into the background even in high-contrast themes. Lays out an
 * open-direction mark above the body lines that follow it.
 */
export const DETAILS_ICON_PATH = 'M4 7l2.5 2.5L9 7 M12 9h8 M4 14h16 M4 18h11';

/**
 * Registers an item into the toolbar's collapsible-section slot.
 *
 * A press does not call the operation directly; it is passed through as a block operation with the
 * command trigger. Calling it directly would skip the input-stop and composing checks. No pressed
 * state is passed, since this is an insert operation and does not represent a current state.
 *
 * @param toolbar The toolbar to register into.
 * @param ports The block command ports.
 */
export function registerDetailsButton(toolbar: Toolbar, ports: BlockCommandPorts): void {
  toolbar.register(TOOLBAR_SLOT.details, {
    kind: 'button',
    messageKey: 'toolbar.details',
    iconPath: DETAILS_ICON_PATH,
    run: () => {
      runBlockOperation(ports, { kind: 'insertDetails' }, 'command');
    },
  });
}
