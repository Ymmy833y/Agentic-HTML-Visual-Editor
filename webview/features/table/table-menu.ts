// Right-click context menu for tables. Replaces the browser default menu
// when the click target sits inside a <td>/<th>; otherwise yields to the
// browser. Each menu entry maps to a structural command in table-commands.

import {
  convertColumnToBody,
  convertColumnToHeader,
  convertRowToHeader,
  deleteColumn,
  deleteRow,
  deleteTable,
  insertColumn,
  insertRow,
  isColumnHeader,
  removeHeader,
} from './structure-commands';
import { mergeCells, splitCell } from './merge-commands';
import { getTableWidthMode, setTableWidthMode } from './width-commands';
import { boundingRect, buildTableModel, findCell, findCellPosition, tightenRect } from './table-model';
import type { CommandContext } from '../../shared/command-context';

export interface TableMenuOptions {
  /** Called after the menu has applied a DOM mutation so the editor can serialize. */
  onCommand(): void;
  /**
   * Optional accessor for the "other anchor" of a multi-cell merge. When the
   * user is preparing a merge they typically Shift+click a second cell; the
   * caller stashes that cell so the menu can offer "Merge cells".
   */
  getMergeAnchor?: () => HTMLTableCellElement | null;
}

interface MenuItem {
  label: string;
  enabled: boolean;
  onPick: () => void;
}

const VIEWPORT_PADDING = 8;

export interface TableMenuHandle {
  /** Detach the document-level listeners. */
  destroy(): void;
}

export function mountTableMenu(
  root: HTMLElement,
  opts: TableMenuOptions,
): TableMenuHandle {
  const menu = document.createElement('div');
  menu.id = 'ahve-table-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  document.body.appendChild(menu);

  // Selection guard: clicking the menu must not steal focus from the editor.
  menu.addEventListener('mousedown', (e) => e.preventDefault());

  const onContextMenu = (e: MouseEvent): void => {
    const cell = findCell(e.target as Node, root);
    if (!cell) return;
    if (!root.contains(cell)) return;
    e.preventDefault();
    show(cell, e.clientX, e.clientY);
  };
  root.addEventListener('contextmenu', onContextMenu);

  const onDismiss = (e: MouseEvent): void => {
    if (menu.hidden) return;
    if (menu.contains(e.target as Node)) return;
    close();
  };
  document.addEventListener('mousedown', onDismiss);

  const onKey = (e: KeyboardEvent): void => {
    if (menu.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKey);

  function close(): void {
    menu.hidden = true;
    menu.replaceChildren();
  }

  function show(cell: HTMLTableCellElement, clientX: number, clientY: number): void {
    const items = buildItems(cell);
    menu.replaceChildren();
    for (const item of items) {
      if (item.label === '-') {
        menu.appendChild(separator());
        continue;
      }
      menu.appendChild(menuButton(item, () => {
        close();
        item.onPick();
        opts.onCommand();
      }));
    }
    menu.hidden = false;
    positionAt(clientX, clientY);
  }

  function positionAt(clientX: number, clientY: number): void {
    const popRect = menu.getBoundingClientRect();
    const viewportW = document.documentElement.clientWidth;
    const viewportH = document.documentElement.clientHeight;
    let left = clientX;
    let top = clientY;
    if (left + popRect.width > viewportW - VIEWPORT_PADDING) {
      left = Math.max(VIEWPORT_PADDING, viewportW - popRect.width - VIEWPORT_PADDING);
    }
    if (top + popRect.height > viewportH - VIEWPORT_PADDING) {
      top = Math.max(VIEWPORT_PADDING, viewportH - popRect.height - VIEWPORT_PADDING);
    }
    menu.style.top = `${top + window.scrollY}px`;
    menu.style.left = `${left + window.scrollX}px`;
  }

  function buildItems(cell: HTMLTableCellElement): MenuItem[] {
    const ctx: CommandContext = { root };
    const isHeader = cell.tagName === 'TH';
    const inThead = cell.closest('thead') !== null;

    const items: MenuItem[] = [];

    items.push({
      label: 'Insert row above',
      enabled: true,
      onPick: () => insertRow(cell, 'above'),
    });
    items.push({
      label: 'Insert row below',
      enabled: true,
      onPick: () => insertRow(cell, 'below'),
    });
    items.push({ label: '-', enabled: true, onPick: () => {} });
    items.push({
      label: 'Insert column left',
      enabled: true,
      onPick: () => insertColumn(cell, 'left'),
    });
    items.push({
      label: 'Insert column right',
      enabled: true,
      onPick: () => insertColumn(cell, 'right'),
    });
    items.push({ label: '-', enabled: true, onPick: () => {} });
    items.push({
      label: 'Delete row',
      enabled: true,
      onPick: () => deleteRow(cell, ctx),
    });
    items.push({
      label: 'Delete column',
      enabled: true,
      onPick: () => deleteColumn(cell, ctx),
    });
    items.push({ label: '-', enabled: true, onPick: () => {} });

    if (inThead || isHeader) {
      items.push({
        label: 'Convert row to body',
        enabled: true,
        onPick: () => removeHeader(cell),
      });
    } else {
      items.push({
        label: 'Convert row to header',
        enabled: true,
        onPick: () => convertRowToHeader(cell),
      });
    }

    // Column-header is only meaningful for tbody/tfoot cells; thead is
    // managed by the row-header item above.
    if (!inThead) {
      const table = cell.closest('table');
      const model = table ? buildTableModel(table) : null;
      const pos = model ? findCellPosition(model, cell) : null;
      const isHeaderCol = !!(table && pos && isColumnHeader(table, pos.col));
      items.push({
        label: isHeaderCol ? 'Convert column to body' : 'Convert column to header',
        enabled: true,
        onPick: () => {
          if (isHeaderCol) convertColumnToBody(cell);
          else convertColumnToHeader(cell);
        },
      });
    }

    // Width-unit toggle for the whole table.
    {
      const table = cell.closest('table');
      if (table) {
        const mode = getTableWidthMode(table);
        items.push({
          label: mode === 'percent' ? 'Use pixel widths' : 'Use percentage widths',
          enabled: true,
          onPick: () => {
            setTableWidthMode(table, mode === 'percent' ? 'px' : 'percent');
          },
        });
      }
    }

    const mergeTarget = opts.getMergeAnchor?.() ?? null;
    if (mergeTarget && mergeTarget !== cell && cell.closest('table') === mergeTarget.closest('table')) {
      items.push({
        label: 'Merge cells',
        enabled: canMerge(cell, mergeTarget),
        onPick: () => {
          mergeCells(mergeTarget, cell);
        },
      });
    }

    if (cell.rowSpan > 1 || cell.colSpan > 1) {
      items.push({
        label: 'Split cell',
        enabled: true,
        onPick: () => splitCell(cell),
      });
    }

    items.push({ label: '-', enabled: true, onPick: () => {} });
    items.push({
      label: 'Delete table',
      enabled: true,
      onPick: () => {
        const table = cell.closest('table');
        if (table) deleteTable(table, ctx);
      },
    });

    return items;
  }

  return {
    destroy(): void {
      root.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('mousedown', onDismiss);
      document.removeEventListener('keydown', onKey);
      menu.remove();
    },
  };
}

function menuButton(item: MenuItem, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ahve-tm-item';
  b.textContent = item.label;
  b.disabled = !item.enabled;
  if (item.enabled) b.addEventListener('click', onClick);
  return b;
}

function separator(): HTMLElement {
  const s = document.createElement('div');
  s.className = 'ahve-tm-sep';
  s.setAttribute('aria-hidden', 'true');
  return s;
}

function canMerge(a: HTMLTableCellElement, b: HTMLTableCellElement): boolean {
  const table = a.closest('table');
  if (!table) return false;
  const model = buildTableModel(table);
  const rect = boundingRect(model, a, b);
  if (!rect) return false;
  const tight = tightenRect(model, rect);
  return tight.row1 !== tight.row2 || tight.col1 !== tight.col2;
}
