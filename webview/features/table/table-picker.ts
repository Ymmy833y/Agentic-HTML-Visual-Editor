// Table insertion popover with a 10x10 hover grid and a fallback numeric
// input form for tables larger than the grid. Mirrors the popup conventions
// used by comment-popup (positioning, dismissal, mousedown selection guard).

import { hideTooltipFor, setupTooltip } from '../../ui/tooltip';

export interface TablePickerOptions {
  onPick(rows: number, cols: number, withHeader: boolean): void;
}

const GRID_MAX = 10;
const MARGIN = 6;
const VIEWPORT_PADDING = 8;

export interface TablePickerHandle {
  open(anchor: HTMLElement): void;
  close(): void;
  element(): HTMLElement;
}

export function mountTablePicker(opts: TablePickerOptions): TablePickerHandle {
  const root = document.createElement('div');
  root.id = 'ahve-table-picker';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Insert table');

  // Selection guard so the editor keeps its selection while the popup is
  // being clicked.
  root.addEventListener('mousedown', (e) => {
    if (e.target instanceof HTMLElement) {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'BUTTON') return;
    }
    e.preventDefault();
  });

  const grid = document.createElement('div');
  grid.className = 'ahve-tp-grid';
  const cellEls: HTMLDivElement[][] = [];
  for (let r = 0; r < GRID_MAX; r++) {
    cellEls.push([]);
    for (let c = 0; c < GRID_MAX; c++) {
      const cellEl = document.createElement('div');
      cellEl.className = 'ahve-tp-cell';
      cellEl.dataset.row = String(r + 1);
      cellEl.dataset.col = String(c + 1);
      cellEls[r].push(cellEl);
      grid.appendChild(cellEl);
    }
  }

  let hoverRows = 0;
  let hoverCols = 0;
  const updateHighlight = (rows: number, cols: number): void => {
    hoverRows = rows;
    hoverCols = cols;
    for (let r = 0; r < GRID_MAX; r++) {
      for (let c = 0; c < GRID_MAX; c++) {
        const active = r < rows && c < cols;
        cellEls[r][c].classList.toggle('ahve-tp-cell-active', active);
      }
    }
    label.textContent = rows > 0 && cols > 0 ? `${cols} × ${rows}` : 'Pick a size';
  };

  grid.addEventListener('mousemove', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target || !target.classList.contains('ahve-tp-cell')) return;
    const r = Number(target.dataset.row ?? '0');
    const c = Number(target.dataset.col ?? '0');
    updateHighlight(r, c);
  });

  grid.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target || !target.classList.contains('ahve-tp-cell')) return;
    const rows = Number(target.dataset.row ?? '0');
    const cols = Number(target.dataset.col ?? '0');
    if (rows === 0 || cols === 0) return;
    commit(rows, cols);
  });

  const label = document.createElement('div');
  label.className = 'ahve-tp-label';
  label.textContent = 'Pick a size';

  const form = document.createElement('div');
  form.className = 'ahve-tp-form';

  const sizeRow = document.createElement('div');
  sizeRow.className = 'ahve-tp-form-row';
  const rowsInput = numInput('Rows', 3);
  const colsInput = numInput('Cols', 3);
  sizeRow.append(rowsInput.wrap, colsInput.wrap);

  const actionRow = document.createElement('div');
  actionRow.className = 'ahve-tp-form-row';
  const headerLabel = document.createElement('label');
  headerLabel.className = 'ahve-tp-header-toggle';
  const headerInput = document.createElement('input');
  headerInput.type = 'checkbox';
  headerInput.checked = true;
  headerLabel.append(headerInput, document.createTextNode(' Header row'));

  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'ahve-tp-ok';
  okBtn.textContent = 'Insert';
  setupTooltip(okBtn, 'Insert table with the chosen size');
  okBtn.addEventListener('click', () => {
    const rows = Math.max(1, Math.floor(Number(rowsInput.input.value) || 0));
    const cols = Math.max(1, Math.floor(Number(colsInput.input.value) || 0));
    commit(rows, cols);
  });

  actionRow.append(headerLabel, okBtn);

  form.append(sizeRow, actionRow);

  root.append(grid, label, form);
  document.body.appendChild(root);

  function commit(rows: number, cols: number): void {
    close();
    opts.onPick(rows, cols, headerInput.checked);
  }

  let openedFor: HTMLElement | null = null;

  function open(anchor: HTMLElement): void {
    openedFor = anchor;
    root.hidden = false;
    updateHighlight(0, 0);
    reposition(anchor);
  }

  function close(): void {
    openedFor = null;
    hideTooltipFor(root);
    root.hidden = true;
  }

  function reposition(anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const popRect = root.getBoundingClientRect();
    const viewportW = document.documentElement.clientWidth;
    const viewportH = document.documentElement.clientHeight;
    let top = rect.bottom + MARGIN;
    if (top + popRect.height > viewportH - VIEWPORT_PADDING) {
      top = Math.max(VIEWPORT_PADDING, rect.top - popRect.height - MARGIN);
    }
    let left = rect.left;
    if (left + popRect.width > viewportW - VIEWPORT_PADDING) {
      left = Math.max(VIEWPORT_PADDING, viewportW - popRect.width - VIEWPORT_PADDING);
    }
    root.style.top = `${top + window.scrollY}px`;
    root.style.left = `${left + window.scrollX}px`;
  }

  document.addEventListener('mousedown', (e) => {
    if (root.hidden) return;
    const target = e.target as Node | null;
    if (!target) return;
    if (root.contains(target)) return;
    if (openedFor && openedFor.contains(target)) return;
    close();
  });

  document.addEventListener('keydown', (e) => {
    if (root.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Enter') {
      const target = e.target as Element | null;
      if (target && root.contains(target)) {
        e.preventDefault();
        if (hoverRows > 0 && hoverCols > 0) {
          commit(hoverRows, hoverCols);
        } else {
          okBtn.click();
        }
      }
    }
  });

  window.addEventListener('scroll', () => {
    if (!root.hidden && openedFor) reposition(openedFor);
  }, { passive: true });
  window.addEventListener('resize', () => {
    if (!root.hidden && openedFor) reposition(openedFor);
  });

  return { open, close, element: () => root };
}

function numInput(label: string, defaultValue: number): {
  wrap: HTMLLabelElement;
  input: HTMLInputElement;
} {
  const wrap = document.createElement('label');
  wrap.className = 'ahve-tp-num';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.max = '100';
  input.value = String(defaultValue);
  wrap.append(span, input);
  return { wrap, input };
}
