import type { BlockCommandPorts } from './block-command';
import { findChildrenEdge, findVisibleEdge } from './boundary-placement';
import type { VisibleEdge } from './boundary-placement';
import { placeCaret, readSelectionRange } from './caret';
import { isOnEdgeLine } from './edge-line';
import { findOwningItem } from './list-structure';
import type { ShortcutKey, ShortcutReceiver } from './shortcut-receiver';
import { placeCaretInCell, runTableOperation } from './table-command';
import { findGridCell, findTableCell, listCellsInTableOrder, readCellTable, resolveTableGrid } from './table-grid';
import type { NodeBoundary } from '../selection/selection-position';

/** The shortcut key for moving to the next cell (Tab). Requires no modifier keys. */
export const TABLE_NEXT_CELL_KEY: ShortcutKey = { code: 'Tab', primary: false, shift: false, alt: false };

/** The shortcut key for moving to the previous cell (Shift+Tab). Does not match if other modifiers are added. */
export const TABLE_PREVIOUS_CELL_KEY: ShortcutKey = { code: 'Tab', primary: false, shift: true, alt: false };

/** The direction of a vertical move. */
export type VerticalDirection = 'down' | 'up';

// The keys of a vertical move, by key value.
const VERTICAL_MOVE_KEYS: ReadonlyMap<string, VerticalDirection> = new Map([
  ['ArrowDown', 'down'],
  ['ArrowUp', 'up'],
]);

// Finds the first non-whitespace character. NBSP has a width, so it counts as content.
const CONTENT_CHARACTER_PATTERN = /[^\t\n\f\r ]/u;

// Finds the whitespace at the end of a text, which rendering collapses at the end of a line.
const TRAILING_SPACES_PATTERN = /[\t\n\f\r ]+$/u;

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
 * Attaches ↓ and ↑ without modifier keys to the editor root, stopping the default only when a vertical move takes
 * over.
 *
 * These keys are not registered with the shortcut receiver. The popups, the sidebar and the toolbar stop every
 * registered key so that it does not reach VS Code, which would freeze the arrow keys inside their fields and lists.
 * With modifier keys the arrows extend the selection or move by larger steps, so they are left alone.
 *
 * @param root The editor root. It stays the same element across document replacements, so call this only once, on
 *   the first mount.
 * @param ports The block command ports.
 */
export function attachTableVerticalKeys(root: HTMLElement, ports: BlockCommandPorts): void {
  root.addEventListener('keydown', (event) => {
    const direction = VERTICAL_MOVE_KEYS.get(event.key);
    if (
      direction === undefined
      || event.isComposing
      || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
      || event.defaultPrevented
    ) {
      return;
    }
    if (moveVertically(ports, direction)) {
      event.preventDefault();
    }
  });
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

/**
 * Moves the caret from the last line of a cell down, or from the first line of a cell up.
 *
 * The browser moves ↓ on the last line of a cell to the cell on the right, because it follows document order once it
 * leaves the cell. So this takes over only there: the caret goes to the start of the cell below or the end of the
 * cell above, and from the last or first row to right after or right before the table. Anywhere else, during a
 * composition, and where there is no position to move to, the key keeps its default. A range selection is judged by
 * its end for ↓ and its start for ↑, the same ends the browser moves from, and is collapsed when taken over.
 *
 * @param ports The block command ports.
 * @param direction Down or up.
 * @returns `true` when taken over.
 */
export function moveVertically(ports: BlockCommandPorts, direction: VerticalDirection): boolean {
  const root = ports.readEditorRoot();
  const range = root === undefined ? undefined : readSelectionRange(root);
  if (root === undefined || range === undefined || ports.isComposing()) {
    return false;
  }
  const point: NodeBoundary = direction === 'down'
    ? { container: range.endContainer, offset: range.endOffset }
    : { container: range.startContainer, offset: range.startOffset };
  const cell = findTableCell(point.container, root);
  if (cell === undefined) {
    return false;
  }

  try {
    if (!isOnEdgeLine(cell, point, direction === 'down' ? 'last' : 'first')) {
      return false;
    }
    const target = readVerticalTarget(cell, direction, root);
    if (target === undefined) {
      return false;
    }
    placeCaret(target.container, target.offset);
    return true;
  } catch (error) {
    ports.reportDiagnostic(`Could not move the caret to the cell ${direction === 'down' ? 'below' : 'above'}: ${String(error)}`);
    return false;
  }
}

/**
 * Returns where a vertical move from the last or first line of a cell lands. Changes neither the tree nor the
 * selection.
 *
 * Down goes to the first visible position of the cell below and up to the last visible position of the cell above.
 * The cell below or above is the one covering the column of the cell's origin; where that slot is a gap, the nearest
 * cell to its left in the same row, and rows without cells are skipped. From the last or first row, the move goes to
 * the visible position right after or right before the table, searched outside lists, quotes and details bodies but
 * never outside the cell holding the table. When the table ends that cell, the move continues as one from that cell,
 * so a nested table hands over to the cell below or above in the outer table.
 *
 * @param cell The innermost cell holding the caret.
 * @param direction Down or up.
 * @param root The editor root.
 * @returns The position to move to, or `undefined` when there is none (such as a table that ends the document).
 */
export function readVerticalTarget(
  cell: Element,
  direction: VerticalDirection,
  root: Element,
): NodeBoundary | undefined {
  const edge: VisibleEdge = direction === 'down' ? 'first' : 'last';
  let current: Element | undefined = cell;
  while (current !== undefined) {
    const table = readCellTable(current);
    if (table === undefined) {
      return undefined;
    }
    const neighbor = findVerticalNeighbor(table, current, direction);
    if (neighbor !== undefined) {
      const position = findVisibleEdge(neighbor, edge);
      return position === undefined ? undefined : skipCollapsedSpaces(position, edge);
    }
    const outside = findOutsideTable(table, direction, root);
    if (outside.position !== undefined) {
      return skipCollapsedSpaces(outside.position, edge);
    }
    current = outside.cell;
  }
  return undefined;
}

/**
 * Returns the cell below or above a cell in the same table.
 *
 * @param table The table of the cell.
 * @param cell The cell.
 * @param direction Down or up.
 * @returns The cell covering the column of the origin in the next row below the cell (or the row above its origin),
 *   or the nearest cell to its left when that slot is a gap. `undefined` when the cell is in the last (first) row.
 */
function findVerticalNeighbor(table: Element, cell: Element, direction: VerticalDirection): Element | undefined {
  const grid = resolveTableGrid(table);
  const origin = findGridCell(grid, cell);
  if (origin === undefined) {
    return undefined;
  }
  const step = direction === 'down' ? 1 : -1;
  const first = direction === 'down' ? origin.row + origin.rowSpan : origin.row - 1;
  for (let row = first; row >= 0 && row < grid.rows.length; row += step) {
    const slots = grid.slots[row];
    for (let column = Math.min(origin.column, slots.length - 1); column >= 0; column -= 1) {
      const found = slots[column];
      if (found !== undefined && found.element !== cell) {
        return found.element;
      }
    }
  }
  return undefined;
}

/**
 * Returns the visible position right after (down) or right before (up) a table.
 *
 * Looks at the siblings on that side, then climbs to the parent and does the same, so that a table at the end of a
 * list item moves on to the next item. Stops at the editor root and at a cell, since leaving a cell sideways would
 * land in the next cell of the outer table rather than below it.
 *
 * @param table The table.
 * @param direction Down or up.
 * @param root The editor root.
 * @returns The position, or the cell where the search stopped without one (`undefined` at the editor root).
 */
function findOutsideTable(
  table: Element,
  direction: VerticalDirection,
  root: Element,
): { readonly position?: NodeBoundary; readonly cell?: Element } {
  const edge: VisibleEdge = direction === 'down' ? 'first' : 'last';
  let node: Element = table;
  for (;;) {
    const parent = node.parentElement;
    if (parent === null || (parent !== root && !root.contains(parent))) {
      return {};
    }
    const siblings = [...parent.childNodes];
    const index = siblings.indexOf(node);
    const side = direction === 'down' ? siblings.slice(index + 1) : siblings.slice(0, index);
    const position = findChildrenEdge(parent, side, edge);
    if (position !== undefined) {
      return { position };
    }
    if (parent === root) {
      return {};
    }
    if (readCellTable(parent) !== undefined) {
      return { cell: parent };
    }
    node = parent;
  }
}

/**
 * Moves a position at the edge of a text past the whitespace that rendering collapses there.
 *
 * Placing the caret before a leading line break or indentation, or after a trailing one, would separate the next
 * typed character from the text by a space. Whitespace inside a code block is shown as is, so it is kept.
 *
 * @param position A visible position at the start (first) or end (last) of its container.
 * @param edge Which edge the position is on.
 * @returns The adjusted position.
 */
function skipCollapsedSpaces(position: NodeBoundary, edge: VisibleEdge): NodeBoundary {
  const text = position.container;
  if (!(text instanceof Text) || text.parentElement?.closest('pre') !== null) {
    return position;
  }
  if (edge === 'first') {
    return { container: text, offset: Math.max(0, text.data.search(CONTENT_CHARACTER_PATTERN)) };
  }
  return { container: text, offset: text.data.replace(TRAILING_SPACES_PATTERN, '').length };
}
