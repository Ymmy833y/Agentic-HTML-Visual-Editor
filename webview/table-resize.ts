// Column resize controller. mousedown on the right edge of any cell starts
// a drag that commits the new width into <colgroup>/<col> (pixel units) so
// the change survives serialization. The on-screen handle is a purely
// visual hint with no pointer events of its own; the editor root catches
// the mousedown directly so contenteditable + z-order quirks cannot eat it.

import { buildTableModel, findCell, findTable } from './table-dom';
import { setColumnWidth } from './table-commands';

const EDGE_PX = 6;

export interface TableResizeOptions {
  onCommand(): void;
}

export interface TableResizeHandle {
  destroy(): void;
}

interface ResizeTarget {
  table: HTMLTableElement;
  colIndex: number;
  cellRight: number;
  cellTop: number;
  cellHeight: number;
}

export function mountTableResize(
  root: HTMLElement,
  opts: TableResizeOptions,
): TableResizeHandle {
  const handle = document.createElement('div');
  handle.className = 'hw-tr-handle';
  handle.hidden = true;
  document.body.appendChild(handle);

  let dragging: {
    table: HTMLTableElement;
    colIndex: number;
    startX: number;
    startWidth: number;
  } | null = null;

  function findResizeTarget(e: MouseEvent): ResizeTarget | null {
    const cell = findCell(e.target as Node, root);
    if (!cell || !root.contains(cell)) return null;
    const table = findTable(cell, root);
    if (!table) return null;

    const rect = cell.getBoundingClientRect();
    const distToRight = rect.right - e.clientX;
    if (distToRight < 0 || distToRight > EDGE_PX) return null;

    const model = buildTableModel(table);
    let colRight = -1;
    outer: for (let r = 0; r < model.rows; r++) {
      const row = model.grid[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const entry = row[c];
        if (entry && entry.el === cell) {
          colRight = entry.anchorCol + entry.colSpan - 1;
          break outer;
        }
      }
    }
    if (colRight < 0) return null;

    return {
      table,
      colIndex: colRight,
      cellRight: rect.right,
      cellTop: rect.top,
      cellHeight: rect.height,
    };
  }

  function showHandle(target: ResizeTarget): void {
    handle.hidden = false;
    handle.style.left = `${target.cellRight + window.scrollX - 2}px`;
    handle.style.top = `${target.cellTop + window.scrollY}px`;
    handle.style.height = `${target.cellHeight}px`;
  }

  function hideHandle(): void {
    if (dragging) return;
    handle.hidden = true;
    root.style.removeProperty('cursor');
  }

  const onMouseMove = (e: MouseEvent): void => {
    if (dragging) return;
    const target = findResizeTarget(e);
    if (!target) {
      hideHandle();
      return;
    }
    showHandle(target);
    // The handle itself has pointer-events: none, so the cell underneath
    // keeps receiving mousemove. We force col-resize on the editor root
    // while hovering the edge band so the cursor matches the affordance.
    root.style.cursor = 'col-resize';
  };

  const onMouseDown = (e: MouseEvent): void => {
    if (dragging) return;
    if (e.button !== 0) return;
    const target = findResizeTarget(e);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    const ref = columnReferenceCell(target.table, target.colIndex);
    if (!ref) return;
    dragging = {
      table: target.table,
      colIndex: target.colIndex,
      startX: e.clientX,
      startWidth: ref.getBoundingClientRect().width,
    };
    handle.classList.add('hw-tr-handle-dragging');
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onDragMove, true);
    document.addEventListener('mouseup', onDragEnd, true);
  };

  const onDragMove = (e: MouseEvent): void => {
    if (!dragging) return;
    e.preventDefault();
    const dx = e.clientX - dragging.startX;
    const newWidth = Math.max(20, dragging.startWidth + dx);
    setColumnWidth(dragging.table, dragging.colIndex, newWidth);
    const ref = columnReferenceCell(dragging.table, dragging.colIndex);
    if (ref) {
      const rect = ref.getBoundingClientRect();
      showHandle({
        table: dragging.table,
        colIndex: dragging.colIndex,
        cellRight: rect.right,
        cellTop: rect.top,
        cellHeight: rect.height,
      });
    }
  };

  const onDragEnd = (): void => {
    if (!dragging) return;
    dragging = null;
    handle.classList.remove('hw-tr-handle-dragging');
    document.body.style.removeProperty('cursor');
    root.style.removeProperty('cursor');
    document.removeEventListener('mousemove', onDragMove, true);
    document.removeEventListener('mouseup', onDragEnd, true);
    opts.onCommand();
  };

  root.addEventListener('mousemove', onMouseMove);
  root.addEventListener('mousedown', onMouseDown);
  const onLeave = (): void => hideHandle();
  root.addEventListener('mouseleave', onLeave);

  return {
    destroy(): void {
      root.removeEventListener('mousemove', onMouseMove);
      root.removeEventListener('mousedown', onMouseDown);
      root.removeEventListener('mouseleave', onLeave);
      document.removeEventListener('mousemove', onDragMove, true);
      document.removeEventListener('mouseup', onDragEnd, true);
      handle.remove();
    },
  };
}

/** Pick any anchor cell that ends exactly at `colIndex` (rightmost column it covers). */
function columnReferenceCell(
  table: HTMLTableElement,
  colIndex: number,
): HTMLTableCellElement | null {
  const model = buildTableModel(table);
  for (let r = 0; r < model.rows; r++) {
    const row = model.grid[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const entry = row[c];
      if (!entry) continue;
      if (entry.anchorRow !== r || entry.anchorCol !== c) continue;
      if (entry.anchorCol + entry.colSpan - 1 === colIndex) return entry.el;
    }
  }
  return null;
}
