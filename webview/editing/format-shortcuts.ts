import type { BlockOperation } from './block-command';
import { BLOCK_KIND } from './block-format';
import type { BlockKind } from './block-format';
import type { FormatOperation } from './format-command';
import type { ShortcutReceiver } from './shortcut-receiver';

/**
 * The format shortcut ports.
 *
 * None of them hold a value; each reads afresh on every call, because replacing the document replaces the editing
 * session.
 */
export interface FormatShortcutPorts {
  /**
   * Calls a format operation with the command trigger. The callee owns checking the preconditions (composition,
   * input stop, selection) and the edit attempt.
   *
   * @param operation The format operation.
   * @returns Whether the tree was changed.
   */
  runFormatCommand(operation: FormatOperation): boolean;

  /**
   * Calls a block operation with the command trigger. The callee owns checking the preconditions and the edit
   * attempt.
   *
   * @param operation The block operation.
   * @returns Whether the tree was changed.
   */
  runBlockCommand(operation: BlockOperation): boolean;

  /** Returns whether an IME composition is in progress at the time of the call. */
  isComposing(): boolean;
}

/**
 * The mapping from digit key positions to the block kind to convert to.
 *
 * Digits are matched by position, because the character they type changes with Shift or Alt, and on some layouts it
 * is not even a digit. 7 to 9 and the numeric keypad are not included.
 */
export const BLOCK_KIND_BY_DIGIT_CODE: Readonly<Record<string, BlockKind>> = {
  Digit0: BLOCK_KIND.paragraph,
  Digit1: BLOCK_KIND.heading1,
  Digit2: BLOCK_KIND.heading2,
  Digit3: BLOCK_KIND.heading3,
  Digit4: BLOCK_KIND.heading4,
  Digit5: BLOCK_KIND.heading5,
  Digit6: BLOCK_KIND.heading6,
};

// The two modifier combinations a digit shortcut takes. A key press with Shift and Alt together matches neither.
const DIGIT_MODIFIERS = [
  { shift: true, alt: false },
  { shift: false, alt: true },
] as const;

/**
 * Appends the inline format and block kind shortcuts to the end of the receiver's list.
 *
 * Every shortcut takes its key over whether or not the operation changed the tree. Delivering a key that did not
 * change the tree to VS Code would make a key the view is supposed to handle trigger a command on the VS Code side.
 * The callee checks the preconditions (composition, input stop, selection).
 *
 * @param receiver The shortcut receiver.
 * @param ports The format shortcut ports.
 */
export function registerFormatShortcuts(receiver: ShortcutReceiver, ports: FormatShortcutPorts): void {
  for (const character of ['b', 'i']) {
    receiver.register({
      key: { character, primary: true, shift: false, alt: false },
      // Bold and italic are toggled by an input dispatcher rule from the format input type that the default action
      // attaches, so no operation is called here. During a composition the input dispatcher does not pass input to
      // the rules, so letting the default through would insert the browser's own formatting (b, span style) as is.
      run: () => (ports.isComposing() ? 'preventDefault' : 'allowDefault'),
    });
  }

  receiver.register({
    // This does not match on layouts that type \ with AltGr, but clearing formatting is also available from the
    // toolbar and the floating menu.
    key: { character: '\\', primary: true, shift: false, alt: false },
    run: () => {
      ports.runFormatCommand({ kind: 'clear' });
      return 'preventDefault';
    },
  });

  for (const [code, kind] of Object.entries(BLOCK_KIND_BY_DIGIT_CODE)) {
    for (const modifiers of DIGIT_MODIFIERS) {
      receiver.register({
        key: { code, primary: true, ...modifiers },
        run: () => {
          ports.runBlockCommand({ kind: 'convert', to: kind });
          return 'preventDefault';
        },
      });
    }
  }
}
