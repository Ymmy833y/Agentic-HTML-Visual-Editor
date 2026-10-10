import { runFormatOperation } from '../editing/format-command';
import type { FormatCommandPorts } from '../editing/format-command';
import { TOOLBAR_SLOT } from './toolbar-slots';
import type { Toolbar } from './toolbar';

// Every icon is drawn with a single path that fits a 24×24 view box. No color is given, so the color the
// toolbar supplies is used as is. A fixed color would sink into the background in a high-contrast theme.

// Draws a "B" from two half circles, one above the other.
const BOLD_ICON_PATH = 'M9 5h4.5a3.5 3.5 0 0 1 0 7H9z M9 12h5a3.5 3.5 0 0 1 0 7H9z';

// Draws an "I" from a top and bottom serif and a slanted stem.
const ITALIC_ICON_PATH = 'M10 5h7 M7 19h7 M14.5 5l-5 14';

// Lays a horizontal line over an "S".
const STRIKETHROUGH_ICON_PATH = 'M4 12h16 M16.5 8A3.5 3.5 0 0 0 9 9.5c0 1.4 1.4 2 3 2.5'
  + ' M7.5 16A3.5 3.5 0 0 0 15 14.5';

// Draws an enclosure from a left and a right angle bracket.
const INLINE_CODE_ICON_PATH = 'M9 8l-4 4 4 4 M15 8l4 4-4 4';

// Lays a cancelling slash over a "T" that stands for formatting.
const CLEAR_FORMATTING_ICON_PATH = 'M7 6h10 M12 6v10 M5 19L19 5';

// The five toolbar items to register. The slots decide the order they appear in, so the order of this
// table is only the order of registration.
const FORMAT_BUTTONS = [
  {
    slot: TOOLBAR_SLOT.bold,
    messageKey: 'toolbar.bold',
    iconPath: BOLD_ICON_PATH,
    operation: { kind: 'toggle', format: 'bold' },
  },
  {
    slot: TOOLBAR_SLOT.italic,
    messageKey: 'toolbar.italic',
    iconPath: ITALIC_ICON_PATH,
    operation: { kind: 'toggle', format: 'italic' },
  },
  {
    slot: TOOLBAR_SLOT.strikethrough,
    messageKey: 'toolbar.strikethrough',
    iconPath: STRIKETHROUGH_ICON_PATH,
    operation: { kind: 'toggle', format: 'strikethrough' },
  },
  {
    slot: TOOLBAR_SLOT.inlineCode,
    messageKey: 'toolbar.inlineCode',
    iconPath: INLINE_CODE_ICON_PATH,
    operation: { kind: 'toggle', format: 'inlineCode' },
  },
  {
    slot: TOOLBAR_SLOT.clearFormatting,
    messageKey: 'toolbar.clearFormatting',
    iconPath: CLEAR_FORMATTING_ICON_PATH,
    operation: { kind: 'clear' },
  },
] as const;

/**
 * Registers the toolbar items for the bold, italic, strikethrough, inline code, and clear formatting slots.
 *
 * No pressed state is passed. It is added once the feature that follows the caret to update the pressed
 * state is in place.
 *
 * @param toolbar The toolbar to register with.
 * @param ports The format command ports.
 */
export function registerFormatButtons(toolbar: Toolbar, ports: FormatCommandPorts): void {
  for (const button of FORMAT_BUTTONS) {
    // A slot whose registration is refused does not appear, but the remaining registrations continue.
    toolbar.register(button.slot, {
      kind: 'button',
      messageKey: button.messageKey,
      iconPath: button.iconPath,
      run: () => {
        runFormatOperation(ports, button.operation, 'command');
      },
    });
  }
}
