// Multi-cell range selection for tables. A plain click on a cell remembers it
// as the range anchor; a Shift+click on another cell of the same table
// highlights every cell in the rectangle between them (the same rectangle a
// merge would consume). The native text selection is suppressed for that
// cross-cell Shift+click so the highlight is the only visual; a Shift+click
// inside a single cell keeps the browser's text-selection extension.

import { CELL_SELECTED_CLASS } from '../../shared/constants';
import {
  anchorsInRect,
  boundingRect,
  buildTableModel,
  findCell,
  findTable,
  tightenRect,
} from './table-model';

export interface CellRangeSelection {
  /** The plain-clicked "from" cell — first argument to mergeCells. */
  anchor: HTMLTableCellElement;
  /** The Shift+clicked "to" cell — second argument to mergeCells. */
  focus: HTMLTableCellElement;
  /** Every anchor cell inside the tightened rectangle, all highlighted. */
  cells: HTMLTableCellElement[];
}

export interface CellSelectionHandle {
  getRange(): CellRangeSelection | null;
  /** Remove the highlight and forget the range; keeps the plain-click anchor. */
  clearRange(): void;
  /** Full reset (range + plain-click anchor). Call after a DOM remount. */
  reset(): void;
  destroy(): void;
}

export function mountCellSelection(root: HTMLElement): CellSelectionHandle {
  let lastClickedCell: HTMLTableCellElement | null = null;
  let range: CellRangeSelection | null = null;

  // A Shift+click extends the range only when it lands on a different cell of
  // the table that holds the anchor. Everything else (same cell, no anchor,
  // another table, a detached anchor after a remount) keeps native behavior.
  function rangeTarget(e: MouseEvent): HTMLTableCellElement | null {
    if (!e.shiftKey) return null;
    const cell = findCell(e.target as Node, root);
    if (!cell || !root.contains(cell)) return null;
    if (!lastClickedCell || cell === lastClickedCell) return null;
    const table = findTable(cell, root);
    if (!table || !table.contains(lastClickedCell)) return null;
    return cell;
  }

  function clearRange(): void {
    if (range) {
      for (const cell of range.cells) cell.classList.remove(CELL_SELECTED_CLASS);
      range = null;
    }
    // Defensive sweep: a remount swaps the DOM under us, so classes can
    // outlive the tracked references (e.g. a save echo that still carried
    // them). Never leave a stray highlight behind.
    for (const el of Array.from(root.querySelectorAll(`.${CELL_SELECTED_CLASS}`))) {
      el.classList.remove(CELL_SELECTED_CLASS);
    }
  }

  function reset(): void {
    clearRange();
    lastClickedCell = null;
  }

  function applyRange(anchor: HTMLTableCellElement, focus: HTMLTableCellElement): void {
    const table = findTable(focus, root);
    if (!table) return;
    const model = buildTableModel(table);
    const rect = boundingRect(model, anchor, focus);
    if (!rect) return;
    const entries = anchorsInRect(model, tightenRect(model, rect));
    clearRange();
    for (const entry of entries) entry.el.classList.add(CELL_SELECTED_CLASS);
    range = { anchor, focus, cells: entries.map((entry) => entry.el) };
    // The suppressed mousedown left any prior selection alive; collapse it so
    // the highlight is the only visual and the floating menu hides itself.
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) sel.collapseToStart();
    // A prevented mousedown also skips focusing the editor; pull focus back so
    // keyboard interaction (e.g. Escape) keeps working.
    if (!root.contains(document.activeElement)) root.focus({ preventScroll: true });
  }

  const onMouseDown = (e: MouseEvent): void => {
    // Column resize (registered earlier on the same element) claims edge-band
    // presses via preventDefault; its stopPropagation cannot stop listeners on
    // the same element, so yield explicitly.
    if (e.defaultPrevented) return;
    if (e.button !== 0) return;
    if (!rangeTarget(e)) return;
    // Cross-cell Shift+click: suppress the native selection extension. The
    // click event still fires afterwards and applies the highlight.
    e.preventDefault();
  };

  const onClick = (e: MouseEvent): void => {
    const cell = findCell(e.target as Node, root);
    if (!cell || !root.contains(cell)) {
      if (!e.shiftKey) reset();
      return;
    }
    if (e.shiftKey) {
      const target = rangeTarget(e);
      if (target && lastClickedCell) applyRange(lastClickedCell, target);
      return;
    }
    // Plain click on a cell: it becomes the range anchor for a later
    // Shift+click and any previous highlight is dropped.
    lastClickedCell = cell;
    clearRange();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.defaultPrevented || !range) return;
    // The table menu's own Escape handler (registered earlier) consumes the
    // key while the menu is open, so the first Escape closes the menu and the
    // next one clears the highlight.
    clearRange();
  };

  root.addEventListener('mousedown', onMouseDown);
  root.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeyDown);

  return {
    getRange: () => range,
    clearRange,
    reset,
    destroy(): void {
      root.removeEventListener('mousedown', onMouseDown);
      root.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKeyDown);
      reset();
    },
  };
}
