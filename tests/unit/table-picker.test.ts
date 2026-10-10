import { describe, expect, it, vi } from 'vitest';

import { createLocalizer } from '../../common/index';
import { TABLE_PICKER_CLASS, TablePicker, readTableSize } from '../../webview/ui/table-picker';
import type { TablePickerPorts } from '../../webview/ui/table-picker';
import { ToolbarActivation } from '../../webview/ui/toolbar-activation';
import { readElement } from './helpers/format-dom';

const localizer = createLocalizer({
  'tablePicker.grid': 'Table Size',
  'tablePicker.size': '{rows} × {columns}',
  'tablePicker.rows': 'Rows',
  'tablePicker.columns': 'Columns',
  'tablePicker.insert': 'Insert',
});

/** A table picker and the record of its ports. */
interface PickerHarness {
  readonly picker: TablePicker;
  readonly activation: ToolbarActivation;
  readonly container: HTMLElement;
  readonly insertTable: ReturnType<typeof vi.fn<TablePickerPorts['insertTable']>>;
  readonly requestReturn: ReturnType<typeof vi.fn<TablePickerPorts['requestReturn']>>;
}

/**
 * Creates a table picker with no focus on the opened item, as when opened by pointer.
 *
 * @returns The table picker and the record of its ports.
 */
function createPicker(): PickerHarness {
  document.body.replaceChildren();
  const container = document.createElement('div');
  document.body.append(container);
  const activation = new ToolbarActivation(window, {
    isInputStopped: () => false,
    isComposing: () => false,
    notifyPopupOpened: () => undefined,
    notifyPopupClosed: () => undefined,
    notifyBeforeRun: () => undefined,
  });
  const insertTable = vi.fn<TablePickerPorts['insertTable']>();
  const requestReturn = vi.fn<TablePickerPorts['requestReturn']>();
  const picker = new TablePicker(localizer, activation, {
    insertTable,
    readOpenedItem: () => undefined,
    requestReturn,
    hasShortcut: () => false,
  });
  return { picker, activation, container, insertTable, requestReturn };
}

/**
 * Moves the pointer over a grid cell.
 *
 * @param popup The popup element.
 * @param rows The number of rows counted from the top left.
 * @param columns The number of columns counted from the top left.
 */
function hoverCell(popup: Element, rows: number, columns: number): void {
  readElement(popup, `[role="row"]:nth-child(${rows}) [role="gridcell"]:nth-child(${columns})`)
    .dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
}

describe('table picker popup', () => {
  it('on open, places in the container a dialog popup with 10 × 10 grid cells, input fields holding 3 and 3, and an insert button', () => {
    const { picker, container } = createPicker();

    const popup = picker.buildPopup(container);

    expect([
      popup.parentElement === container,
      popup.className,
      popup.getAttribute('role'),
      popup.querySelectorAll('[role="row"]').length,
      popup.querySelectorAll('[role="gridcell"]').length,
      [...popup.querySelectorAll('input')].map((input) => input.value),
      popup.querySelectorAll('button').length,
    ]).toEqual([true, TABLE_PICKER_CLASS, 'dialog', 10, 100, ['3', '3'], 1]);
  });

  it('takes the names of the grid, input fields and insert button and the size display from the catalog messages', () => {
    const { picker, container } = createPicker();
    const popup = picker.buildPopup(container);

    hoverCell(popup, 2, 3);

    expect([
      readElement(popup, '[role="grid"]').getAttribute('aria-label'),
      [...popup.querySelectorAll('input')].map((input) => input.getAttribute('aria-label')),
      readElement(popup, 'button').textContent,
      readElement(popup, '[role="grid"] + div').textContent,
      readElement(popup, `#${readElement(popup, '[role="grid"]').getAttribute('aria-activedescendant') ?? ''}`)
        .getAttribute('aria-label'),
    ]).toEqual(['Table Size', ['Rows', 'Columns'], 'Insert', '2 × 3', '2 × 3']);
  });

  it('on reopening, the previous grid choice and input field values return to their initial state', () => {
    const { picker, container } = createPicker();
    const first = picker.buildPopup(container);
    hoverCell(first, 4, 5);
    first.querySelectorAll('input').forEach((input) => {
      input.value = '12';
    });
    first.remove();

    const second = picker.buildPopup(container);

    expect([
      second.querySelectorAll('[aria-selected="true"]').length,
      [...second.querySelectorAll('input')].map((input) => input.value),
    ]).toEqual([0, ['3', '3']]);
  });

  it('pressing the insert button calls insert table with the rows and columns in the input fields through activatePopupAction', () => {
    const { picker, activation, container, insertTable } = createPicker();
    const action = vi.spyOn(activation, 'activatePopupAction');
    const popup = picker.buildPopup(container);
    const [rows, columns] = [...popup.querySelectorAll('input')];
    rows.value = '12';
    columns.value = '15';

    readElement(popup, 'button').dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect([action.mock.calls.length, insertTable.mock.calls]).toEqual([1, [[12, 15]]]);
  });
});

describe('returning on close', () => {
  it('asks to return only when closed by any other trigger while focus was inside', () => {
    const { picker, container, requestReturn } = createPicker();

    picker.buildPopup(container);
    picker.handleClosed({ trigger: 'other', focusedInside: false });
    picker.buildPopup(container);
    picker.handleClosed({ trigger: 'other', focusedInside: true });

    expect(requestReturn).toHaveBeenCalledTimes(1);
  });

  it('does not ask to return when closed by running or Esc, even with focus inside', () => {
    const { picker, container, requestReturn } = createPicker();

    picker.buildPopup(container);
    picker.handleClosed({ trigger: 'run', focusedInside: true });
    picker.buildPopup(container);
    picker.handleClosed({ trigger: 'escape', focusedInside: true });

    expect(requestReturn).not.toHaveBeenCalled();
  });
});

describe('reading the size from the input fields', () => {
  it('empty and non-numeric values and values below 1 become 1, and values above 100 become 100', () => {
    expect(['', 'abc', '0', '-3', '150'].map((value) => readTableSize(value))).toEqual([1, 1, 1, 1, 100]);
  });

  it('truncates fractions and reads full-width digits as the same numbers as half-width digits', () => {
    expect(['3.9', '１２'].map((value) => readTableSize(value))).toEqual([3, 12]);
  });
});
