import type { Localizer } from '../../common/index';
import { runBlockOperation } from '../editing/block-command';
import type { BlockCommandPorts } from '../editing/block-command';
import { BlockTypeMenu } from './block-type-menu';
import { TOOLBAR_SLOT } from './toolbar-slots';
import type { Toolbar } from './toolbar';
import type { ToolbarActivation } from './toolbar-activation';

// Every icon is drawn with a single path that fits a 24×24 view box. No color is given, so the color the toolbar
// supplies is used as is. A fixed color would sink into the background under a high contrast theme.

// Draws only a small downward chevron (⌄) that signals the menu opens. The item label to its left shows the current
// kind, so no heading "H" is drawn.
const BLOCK_TYPE_CHEVRON_PATH = 'M8.5 10.5l3.5 3.5 3.5-3.5';

/** The frame of the code block icon. */
export const CODE_BLOCK_FRAME_PATH = 'M4 5h16v14H4z';

/**
 * The facing angle brackets of the code block icon, a smaller version of the inline code icon. They are centered in
 * the frame, both across and down.
 */
export const CODE_BLOCK_BRACKETS_PATH = 'M10 10l-2 2 2 2 M14 10l2 2-2 2';

// Draws the angle brackets inside the frame. The two parts are kept apart so that where the brackets sit in the frame
// can be measured.
const CODE_BLOCK_ICON_PATH = `${CODE_BLOCK_FRAME_PATH} ${CODE_BLOCK_BRACKETS_PATH}`;

// Draws the rule itself: a single long line across the middle. Shorter lines above and below it would read as lines of
// text rather than a rule.
const HORIZONTAL_RULE_ICON_PATH = 'M3 12h18';

/**
 * Registers items in the block type, code block, and horizontal rule toolbar slots.
 *
 * No pressed state is passed. Showing a pressed state that follows the caret belongs to a later feature unit,
 * and giving the items toggle-button attributes now would leave state that is never updated.
 *
 * @param toolbar The toolbar to register with.
 * @param ports The block command ports.
 * @param localizer The localizer.
 * @param activation The toolbar activation.
 * @returns The contents of the block type menu, which is the port by which later feature units add items.
 */
export function registerBlockButtons(
  toolbar: Toolbar,
  ports: BlockCommandPorts,
  localizer: Localizer,
  activation: ToolbarActivation,
): BlockTypeMenu {
  const menu = new BlockTypeMenu(localizer, activation, ports);

  // A slot whose registration is rejected is not laid out, but the remaining registrations carry on.
  toolbar.register(TOOLBAR_SLOT.blockType, {
    kind: 'popup',
    messageKey: 'toolbar.blockType',
    iconPath: BLOCK_TYPE_CHEVRON_PATH,
    buildPopup: (container) => menu.buildPopup(container),
  });

  toolbar.register(TOOLBAR_SLOT.codeBlock, {
    kind: 'button',
    messageKey: 'toolbar.codeBlock',
    iconPath: CODE_BLOCK_ICON_PATH,
    run: () => {
      runBlockOperation(ports, { kind: 'toggleCodeBlock' }, 'command');
    },
  });

  toolbar.register(TOOLBAR_SLOT.horizontalRule, {
    kind: 'button',
    messageKey: 'toolbar.horizontalRule',
    iconPath: HORIZONTAL_RULE_ICON_PATH,
    run: () => {
      runBlockOperation(ports, { kind: 'horizontalRule' }, 'command');
    },
  });

  return menu;
}
