/** The history operation a key asks for. */
export type HistoryKey = 'undo' | 'redo';

// A key value that is one Latin letter. Both cases are listed instead of using the `i` flag, which with the `u` flag
// would also count the long s and the Kelvin sign as letters.
const ASCII_LETTER_PATTERN = /^[A-Za-z]$/u;

/**
 * Returns whether a key asks for undo or redo: Ctrl or Cmd with Z for undo, and with Shift+Z or Y for redo.
 *
 * A Latin letter is read from the character typed, as the shortcut keys read it, so that a layout with another letter
 * on the physical Z key, such as Y on a German layout or W on a French one, keeps that key for its own letter. Only a
 * key that types no Latin letter, as on a Russian layout, is read by its physical position.
 *
 * @param event The key press.
 * @returns The operation. `undefined` for any other key.
 */
export function readHistoryKey(event: KeyboardEvent): HistoryKey | undefined {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) {
    return undefined;
  }
  const latin = ASCII_LETTER_PATTERN.test(event.key);
  const key = event.key.toLowerCase();
  if (latin ? key === 'z' : event.code === 'KeyZ') {
    return event.shiftKey ? 'redo' : 'undo';
  }
  return !event.shiftKey && (latin ? key === 'y' : event.code === 'KeyY') ? 'redo' : undefined;
}
