import type { BlockCommandPorts } from './block-command';
import { readSelectionRange } from './caret';
import { findOwningItem } from './list-structure';
import type { ShortcutKey, ShortcutReceiver } from './shortcut-receiver';
import { placeCaretInCell, runTableOperation } from './table-command';
import { findTableCell, listCellsInTableOrder, readCellTable } from './table-grid';

/** The shortcut key for moving to the next cell (Tab). Requires no modifier keys. */
export const TABLE_NEXT_CELL_KEY: ShortcutKey = { code: 'Tab', primary: false, shift: false, alt: false };

/** The shortcut key for moving to the previous cell (Shift+Tab). Does not match if other modifiers are added. */
export const TABLE_PREVIOUS_CELL_KEY: ShortcutKey = { code: 'Tab', primary: false, shift: true, alt: false };

/**
 * Appends Tab and Shift+Tab to the end of the shortcut receiver's list, as shortcuts that stop the default only
 * when moving to the adjacent cell takes over.
 *
 * The conditions for taking over do not overlap with the list Tab shortcuts (the list when there is an owning
 * item, the cell when there is not). So nothing relies on registration order, and there is no position where
 * neither takes over and focus leaves the editor root.
 *
 * @param receiver The shortcut receiver.
 * @param ports The block command ports.
 */
export function registerTableShortcuts(receiver: ShortcutReceiver, ports: BlockCommandPorts): void {
  const register = (key: ShortcutKey, direction: 'next' | 'previous'): void => {
    receiver.register({
      key,
      run: () => (moveToAdjacentCell(ports, direction) ? 'preventDefault' : 'pass'),
    });
  };

  register(TABLE_NEXT_CELL_KEY, 'next');
  register(TABLE_PREVIOUS_CELL_KEY, 'previous');
}

/**
 * Moves the caret to the start of the adjacent cell in table order.
 *
 * Does not take over when no cell contains the selection start, or when an owning item lies between the start and
 * the cell (leaving it to list indentation). Tab in the last cell appends a row, and Shift+Tab in the first cell
 * does nothing. Letting either through to the default would move focus out of the editor root.
 *
 * @param ports The block command ports.
 * @param direction The next cell or the previous cell.
 * @returns `true` when taken over.
 */
export function moveToAdjacentCell(ports: BlockCommandPorts, direction: 'next' | 'previous'): boolean {
  const root = ports.readEditorRoot();
  const range = root === undefined ? undefined : readSelectionRange(root);
  if (root === undefined || range === undefined) {
    return false;
  }
  const cell = findTableCell(range.startContainer, root);
  // The search for the owning item stops at cells and details sections, so an item it finds lies between the
  // caret and the cell.
  if (cell === undefined || findOwningItem(range.startContainer, root) !== undefined) {
    return false;
  }
  if (ports.isComposing()) {
    // Moving the caret would break the composition. Take over and do nothing, so the default focus move does not
    // happen either.
    return true;
  }

  const table = readCellTable(cell);
  const cells = table === undefined ? [] : listCellsInTableOrder(table);
  const index = cells.indexOf(cell);
  const target = cells[direction === 'next' ? index + 1 : index - 1];
  if (target !== undefined) {
    placeCaretInCell(target);
    return true;
  }
  if (direction === 'next') {
    // If no row could be added (for example during an input stop), keep having taken over without moving the
    // caret.
    runTableOperation(ports, { kind: 'appendRow' }, cell);
  }
  return true;
}
