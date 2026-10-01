import { INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX } from '../document/internal-attribute';
import { placeCaret } from './caret';
import type { EditingSession } from './editing-session';
import type { ShortcutKey, ShortcutOutcome, ShortcutPlatform, ShortcutReceiver } from './shortcut-receiver';
import { readCellTable, resolveTableGrid } from './table-grid';
import { readSplitState, resolveCellRectangle } from './table-merge';

/**
 * Namespace of the mark put on the cells of the range.
 *
 * It sits under the internal namespace that the inverse transform drops from the output. The mark is temporary state
 * for display only and must never appear in the saved content, the unsaved content or the history. Even if the author
 * writes an ordinary attribute with the same spelling, it does not mix with the mark because the namespace differs.
 */
export const CELL_RANGE_MARK_NAMESPACE = `${INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX}cell-range`;

/** Local name of the mark attribute. The bundled stylesheet selects it with the same spelling. The value is empty. */
export const CELL_RANGE_MARK_NAME = 'data-ahve-cell-range';

/** Shortcut key of the Escape that clears the range. It needs no modifier and does not match an Escape with one. */
export const CELL_RANGE_ESCAPE_KEY: ShortcutKey = { code: 'Escape', primary: false, shift: false, alt: false };

/** A cell range. It only shows what to merge and does not change what input, deletion, formatting or copying act on. */
export interface CellRange {
  /** Table of the range. */
  readonly table: Element;
  /** Cell containing the anchor. It becomes the reference cell of the merge. */
  readonly anchorCell: Element;
  /** Cell containing the pressed position. It becomes the other cell of the merge. */
  readonly pressedCell: Element;
  /** Cells carrying the mark: the cells of the rectangle in table order. The query uses them for "in the range". */
  readonly markedCells: readonly Element[];
}

/**
 * Ports the selection reads. They hold no values and are read on every call, because document replacement replaces
 * the editing session.
 */
export interface CellRangePorts {
  /** Whether IME composition is in progress at the time of the call. */
  isComposing(): boolean;

  /** Whether at least one input stop reason remains. */
  isInputStopped(): boolean;

  /**
   * Returns whether the keystroke closed a popup with Escape.
   *
   * @param event The keystroke.
   */
  wasPopupClosedBy(event: KeyboardEvent): boolean;

  /**
   * Records one diagnostic line for maintainers. Not used to notify the user.
   *
   * @param detail The line to record.
   */
  reportDiagnostic(detail: string): void;
}

/**
 * Result of the merge and split query for a cell. The menu reads it to decide its items; it is computed without
 * changing the tree.
 */
export interface CellMergeState {
  /**
   * When the cell is in the range, the reference cell of the merge (the anchor cell), the other cell (the pressed
   * cell) and whether they are mergeable. `undefined` when the cell is not in the range.
   */
  readonly range: {
    readonly referenceCell: Element;
    readonly otherCell: Element;
    readonly mergeable: boolean;
  } | undefined;
  /** Whether the cell covers two or more slots in the logical grid. */
  readonly merged: boolean;
  /** Whether the cell can be split. */
  readonly splittable: boolean;
}

/**
 * Creates a cell range with Shift+click and clears it on a press that creates no range, Escape, an edit or a remount.
 *
 * One is created per view and is not recreated on document replacement. Creating and clearing the range neither opens
 * an edit attempt nor notifies the change tracker, because putting and removing the mark only changes attributes in
 * the internal namespace and does not change the content of the document.
 */
export class CellRangeSelection {
  private range: CellRange | undefined;

  // Whether to stop the click that follows the press which created the range. Otherwise, pressing the marker of a
  // details section inside a cell would toggle it as an edit and clear the range just created.
  private suppressingClick = false;

  private readonly onEdit = (): void => {
    this.clearRange();
  };

  /**
   * @param root The editor root.
   * @param platform The platform. Used to tell Ctrl+click on macOS apart.
   * @param ports Ports for composition, input stop, closed popups and diagnostics.
   */
  constructor(
    private readonly root: HTMLElement,
    private readonly platform: ShortcutPlatform,
    private readonly ports: CellRangePorts,
  ) {}

  /**
   * On a successful mount, subscribes to "an edit occurred" of that mount's editing session and resets the range.
   *
   * The marks went away with the old tree, so this does not remove them. The first mount goes through the same steps.
   *
   * @param session The editing session of that mount. Only its registration port is used.
   */
  handleMountCompleted(session: Pick<EditingSession, 'addEditListener'>): void {
    session.addEditListener(this.onEdit);
    this.range = undefined;
    this.suppressingClick = false;
  }

  /**
   * Handles a press of the main button by creating, recreating or clearing the range.
   *
   * A press with Shift only creates a range when the anchor and the pressed position share a table and the cells
   * containing them differ. It then prevents the default and collapses the selection to a caret at the anchor. A DOM
   * selection cannot represent a rectangle and there are no rules that apply input or formatting to a range at once, so
   * the selection is kept to showing only the origin of the merge. A press that creates no range clears the range and
   * proceeds with the default.
   *
   * @param event The press.
   */
  handlePointerDown(event: MouseEvent): void {
    // Lowered on every press, so that when no click followed the previous press, the click of another press is not
    // stopped.
    this.suppressingClick = false;
    // The secondary and middle buttons and Ctrl+click on macOS open the context menu. The range is left unchanged so
    // that the menu can query it.
    if (event.button !== 0 || (this.platform === 'mac' && event.ctrlKey)) {
      return;
    }

    try {
      this.updateRange(event);
    } catch (error) {
      this.ports.reportDiagnostic(`Could not create the cell range: ${String(error)}`);
      // Marks put partway are not recorded in the range, so search for and remove them whether or not a range exists.
      this.discardRange();
    }
  }

  /**
   * Stops the default and propagation of the click that follows the press which created the range.
   *
   * It stops the click in the capture phase, so the stopped click does not reach the click handler of the details
   * marker.
   *
   * @param event The click.
   */
  handleClick(event: MouseEvent): void {
    if (!this.suppressingClick) {
      return;
    }
    this.suppressingClick = false;
    event.preventDefault();
    event.stopPropagation();
  }

  /**
   * Operation of the Escape shortcut. Takes over only when a range exists, clearing it.
   *
   * When the same keystroke closed a popup, it does not take over and keeps the range. If an Escape meant only to close
   * the popup also cleared the range, the user would have to select the range again. The receiver stops the
   * propagation of an Escape taken over, so it does not reach VS Code.
   *
   * @param event The Escape keystroke.
   * @returns "Allow the default" when the range was cleared, otherwise "pass".
   */
  handleEscape(event: KeyboardEvent): ShortcutOutcome {
    if (this.range === undefined || this.ports.wasPopupClosedBy(event)) {
      return 'pass';
    }
    this.clearRange();
    return 'allowDefault';
  }

  /**
   * Returns, for a cell, whether it is in the range, whether it is a merged cell and whether it can be split. Changes
   * neither the tree nor the selection.
   *
   * Whether the cell is in the range is checked against the recorded cells, not the mark attribute, so that a cell on
   * which the author wrote an ordinary attribute with the same spelling is not counted in the range.
   *
   * @param cell The cell to query.
   * @returns The query result. For a cell outside any table, it is not in the range, not merged and not splittable.
   */
  readMergeState(cell: Element): CellMergeState {
    const table = readCellTable(cell);
    if (table === undefined) {
      return { range: undefined, merged: false, splittable: false };
    }
    const grid = resolveTableGrid(table);
    const { merged, splittable } = readSplitState(grid, cell);

    const range = this.range;
    if (range === undefined || !range.markedCells.includes(cell)) {
      return { range: undefined, merged, splittable };
    }
    const rangeGrid = range.table === table ? grid : resolveTableGrid(range.table);
    const rectangle = resolveCellRectangle(rangeGrid, range.anchorCell, range.pressedCell);
    return {
      range: {
        referenceCell: range.anchorCell,
        otherCell: range.pressedCell,
        mergeable: rectangle?.mergeable === true,
      },
      merged,
      splittable,
    };
  }

  /**
   * Creates the range if the press creates one, otherwise clears it. Exceptions are thrown as is.
   *
   * @param event The press of the main button.
   */
  private updateRange(event: MouseEvent): void {
    // Ctrl / Cmd + click is another operation such as following a link, so no range is created when any modifier other
    // than Shift is held.
    const shiftOnly = event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
    if (!shiftOnly || this.ports.isComposing() || this.ports.isInputStopped()) {
      this.clearRange();
      return;
    }

    // The anchor is read from the selection at the time of the press. Whether the caret was placed by a click or by a
    // key, the origin is decided by the same rule.
    const selection = this.root.ownerDocument.defaultView?.getSelection();
    const anchorNode = selection?.anchorNode ?? null;
    const anchorOffset = selection?.anchorOffset ?? 0;
    const target = event.target;
    if (anchorNode === null || !(target instanceof Node)) {
      this.clearRange();
      return;
    }
    const ends = findCellRangeEnds(this.root, anchorNode, target);
    if (ends === undefined || ends.anchorCell === ends.pressedCell) {
      this.clearRange();
      return;
    }
    const rectangle = resolveCellRectangle(resolveTableGrid(ends.table), ends.anchorCell, ends.pressedCell);
    if (rectangle === undefined) {
      this.clearRange();
      return;
    }

    // Even if an exception occurs after the default is prevented, it stays prevented and the following click is also
    // stopped. There is no way to restore the default of a press partway.
    event.preventDefault();
    this.suppressingClick = true;
    // The mark is put even on a rectangle that is not mergeable; the query answers whether it is.
    const markedCells = rectangle.cells.map((cell) => cell.element);
    if (this.range !== undefined) {
      this.removeMarks();
    }
    for (const cell of markedCells) {
      cell.setAttributeNS(CELL_RANGE_MARK_NAMESPACE, CELL_RANGE_MARK_NAME, '');
    }
    this.range = { ...ends, markedCells };

    // A press whose default was prevented does not move the focus, so move focus that was on the toolbar or elsewhere,
    // so that Escape can clear the range.
    const active = this.root.ownerDocument.activeElement;
    if (active === null || !this.root.contains(active)) {
      this.root.focus({ preventScroll: true });
    }
    // Collapse after moving the focus, so that the selection returns to the anchor even if the focus moved it.
    placeCaret(anchorNode, anchorOffset);
  }

  /** If a range exists, resets it and removes the marks. When there is no range, it does not search for marks. */
  private clearRange(): void {
    if (this.range === undefined) {
      return;
    }
    this.discardRange();
  }

  /** Resets the range and removes every mark in the editor root. Exceptions are not thrown; a diagnostic is recorded. */
  private discardRange(): void {
    this.range = undefined;
    try {
      this.removeMarks();
    } catch (error) {
      this.ports.reportDiagnostic(`Could not remove the cell range marks: ${String(error)}`);
    }
  }

  /**
   * Removes the mark from every element in the editor root that carries it.
   *
   * Not limited to the recorded cells. Toggling a header carries internal attributes over to the cell whose element
   * name it replaces, so removing only from the recorded cells would leave the mark on the replacement cell.
   */
  private removeMarks(): void {
    for (const element of this.root.querySelectorAll('*')) {
      element.removeAttributeNS(CELL_RANGE_MARK_NAMESPACE, CELL_RANGE_MARK_NAME);
    }
  }
}

/**
 * Creates the selection and attaches the press and click listeners of the editor root and the Escape shortcut.
 *
 * Presses and clicks are received in the capture phase, so that the default and propagation can be stopped before the
 * details handler (bubbling phase) sees them. The editor root element stays the same across document replacement, so
 * this is called only once, on the first mount.
 *
 * @param root The editor root.
 * @param receiver The shortcut receiver. The Escape shortcut is added to the end of its list.
 * @param platform The platform. Pass the same value as the one given to the receiver.
 * @param ports Ports the selection reads.
 * @returns The attached selection.
 */
export function attachCellRangeSelection(
  root: HTMLElement,
  receiver: ShortcutReceiver,
  platform: ShortcutPlatform,
  ports: CellRangePorts,
): CellRangeSelection {
  const selection = new CellRangeSelection(root, platform, ports);
  root.addEventListener('mousedown', (event) => selection.handlePointerDown(event), true);
  root.addEventListener('click', (event) => selection.handleClick(event), true);
  receiver.register({ key: CELL_RANGE_ESCAPE_KEY, run: (event) => selection.handleEscape(event) });
  return selection;
}

/**
 * Returns the anchor cell and the pressed cell in the innermost table that contains both the anchor and the pressed
 * position. Changes neither the tree nor the selection.
 *
 * When they are split between the inside and outside of a nested table, the cell holding the nested table itself
 * becomes the anchor cell or the pressed cell.
 *
 * @param root The editor root.
 * @param anchor Node of the anchor.
 * @param target Target of the press.
 * @returns That table with the anchor cell and the pressed cell. `undefined` when either lies outside the editor root
 *   or there is no common table.
 */
export function findCellRangeEnds(
  root: Element,
  anchor: Node,
  target: Node,
): Pick<CellRange, 'table' | 'anchorCell' | 'pressedCell'> | undefined {
  if (!root.contains(anchor) || !root.contains(target)) {
    return undefined;
  }

  let current: Element | null = anchor instanceof Element ? anchor : anchor.parentElement;
  while (current !== null && current !== root) {
    if (current.localName === 'table' && current.contains(target)) {
      const anchorCell = findCellOfTable(anchor, current);
      const pressedCell = findCellOfTable(target, current);
      return anchorCell === undefined || pressedCell === undefined
        ? undefined
        : { table: current, anchorCell, pressedCell };
    }
    current = current.parentElement;
  }
  return undefined;
}

/**
 * Returns the cell of the given table that contains the node. Skips cells of nested tables and walks up to a td or th
 * that is a child of a row of that table.
 *
 * @param node The starting node.
 * @param table The table.
 * @returns The cell of that table. `undefined` outside a cell, such as in a caption.
 */
function findCellOfTable(node: Node, table: Element): Element | undefined {
  let current: Element | null = node instanceof Element ? node : node.parentElement;
  while (current !== null && current !== table) {
    if (readCellTable(current) === table) {
      return current;
    }
    current = current.parentElement;
  }
  return undefined;
}
