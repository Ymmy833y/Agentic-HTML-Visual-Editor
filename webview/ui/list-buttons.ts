import type { MessageKey } from '../../common/index';
import { runBlockOperation } from '../editing/block-command';
import type { BlockCommandPorts } from '../editing/block-command';
import { LIST_KIND } from '../editing/list-structure';
import type { ListKind } from '../editing/list-structure';
import type { Toolbar } from './toolbar';
import { TOOLBAR_SLOT } from './toolbar-slots';
import type { ToolbarSlot } from './toolbar-slots';

// Both icons are drawn as a single path that fits a 24×24 view box and carry no colour of their own. A fixed
// colour would sink into the background under high-contrast themes.

/** Icon for a bulleted list. Draws three horizontal lines with a dot to the left of each. */
export const BULLET_LIST_ICON_PATH = 'M9 6h12 M9 12h12 M9 18h12'
  + ' M4 5.25a.75.75 0 1 0 0 1.5a.75.75 0 1 0 0-1.5'
  + ' M4 11.25a.75.75 0 1 0 0 1.5a.75.75 0 1 0 0-1.5'
  + ' M4 17.25a.75.75 0 1 0 0 1.5a.75.75 0 1 0 0-1.5';

/**
 * The digits 1, 2 and 3 of the numbered list icon, from the top.
 *
 * The lines are 6 apart, so each digit has a row 6 tall around its line. A digit is 3.5 tall, 5 with the stroke width,
 * and sits at the top of its row. The gap of 1 left below it then falls on a whole pixel row at 100% scale; a gap
 * split across two pixel rows would still show the digits as joined.
 */
export const ORDERED_LIST_DIGIT_PATHS = [
  'M3.5 4.75l1.5-1v3.5',
  'M3.5 10.75a1.5 1 0 0 1 3 0c0 .75-3 1.5-3 2.5h3',
  'M3.5 15.75h3l-1.5 1.25a1.5 1.125 0 1 1-1.2 1.8',
] as const;

/**
 * Icon for a numbered list. Draws three horizontal lines with the digits 1, 2 and 3 to their left, so it can be told
 * apart from the bulleted list by shape.
 */
export const ORDERED_LIST_ICON_PATH = ['M10 6h11 M10 12h11 M10 18h11', ...ORDERED_LIST_DIGIT_PATHS].join(' ');

/**
 * Registers buttons in the bulleted list and numbered list slots.
 *
 * Pressing a button does not call the rewrite directly; it hands a list toggle to the block operation with the
 * command trigger. Calling it directly would skip the input stop and composition checks. The pressed state is
 * not passed at registration; it is left to reflection by the caret follow. A slot whose registration is
 * refused is not shown, and the remaining registrations continue.
 *
 * @param toolbar The toolbar to register with.
 * @param ports The block command ports.
 */
export function registerListButtons(toolbar: Toolbar, ports: BlockCommandPorts): void {
  const register = (slot: ToolbarSlot, messageKey: MessageKey, iconPath: string, kind: ListKind): void => {
    toolbar.register(slot, {
      kind: 'button',
      messageKey,
      iconPath,
      run: () => {
        runBlockOperation(ports, { kind: 'toggleList', to: kind }, 'command');
      },
    });
  };

  register(TOOLBAR_SLOT.bulletList, 'toolbar.bulletList', BULLET_LIST_ICON_PATH, LIST_KIND.bullet);
  register(TOOLBAR_SLOT.orderedList, 'toolbar.orderedList', ORDERED_LIST_ICON_PATH, LIST_KIND.ordered);
}
