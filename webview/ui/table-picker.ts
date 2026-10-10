import type { Localizer } from '../../common/index';
import type { ToolbarActivation, ToolbarPopupClosure } from './toolbar-activation';

/** The class name of the popup element. The bundled stylesheet and the E2E tests look it up by the same spelling. */
export const TABLE_PICKER_CLASS = 'table-picker';

/**
 * The sizes of the table picker.
 *
 * The grid is 10 × 10, small enough to choose at a glance; larger sizes are given in the input fields. The input
 * limit is 100, and the input fields start at 3 × 3.
 */
export const TABLE_PICKER_SIZE = {
  /** The number of rows and columns of the grid. */
  grid: 10,
  /** The upper limit for the number of rows and columns in the input fields. */
  max: 100,
  /** The initial value of the input fields. */
  initial: 3,
} as const;

/** The ports the table picker receives from outside. Holds no values; reads on every call. */
export interface TablePickerPorts {
  /**
   * Runs insert table.
   *
   * @param rows The number of rows (1–100).
   * @param columns The number of columns (1–100).
   */
  insertTable(rows: number, columns: number): void;

  /** Returns the opened item (the table button), or `undefined` if it is not registered. */
  readOpenedItem(): HTMLButtonElement | undefined;

  /** Asks for the captured selection and focus to be returned to the editor root. */
  requestReturn(): void;

  /**
   * Returns only whether the pressed key matches a registered shortcut. Does not call its action.
   *
   * @param event The pressed key.
   */
  hasShortcut(event: KeyboardEvent): boolean;
}

/** The open popup and the chosen size. */
interface OpenTablePicker {
  readonly element: HTMLElement;
  readonly grid: HTMLElement;
  /** The grid cells, looked up as `cells[row][column]`. */
  readonly cells: readonly (readonly HTMLElement[])[];
  /** For each grid cell, the number of rows and columns counted from the top left. */
  readonly positions: ReadonlyMap<Element, { readonly rows: number; readonly columns: number }>;
  /** The size display. */
  readonly size: HTMLElement;
  readonly rowsInput: HTMLInputElement;
  readonly columnsInput: HTMLInputElement;
  /** The number of rows chosen on the grid, or 0 if nothing is chosen. */
  rows: number;
  /** The number of columns chosen on the grid, or 0 if nothing is chosen. */
  columns: number;
}

// Keys that grow or shrink the chosen size on the grid.
const GRID_MOVE_KEYS: Readonly<Record<string, { readonly rows: number; readonly columns: number }>> = {
  ArrowLeft: { rows: 0, columns: -1 },
  ArrowRight: { rows: 0, columns: 1 },
  ArrowUp: { rows: -1, columns: 0 },
  ArrowDown: { rows: 1, columns: 0 },
};

// Full-width digits. Used to read digits typed into an input field through the IME as the same numbers as
// half-width digits.
const FULL_WIDTH_DIGIT_PATTERN = /[０-９]/gu;

// The difference from a full-width digit's character code to the character code of the same half-width digit.
const FULL_WIDTH_OFFSET = 0xfee0;

/**
 * The popup of the table button. Lets the user choose a size with the grid, the input fields and the insert
 * button, and turns insert table into an activation request.
 *
 * One is created per view and not recreated on document replacement. The popup is rebuilt every time it opens,
 * and does not carry over the previous choice or input. Opening, closing and running are judged by the toolbar
 * activation, and the actions inside are also called through it. Calling them directly would skip the input stop
 * and composition checks.
 */
export class TablePicker {
  private open: OpenTablePicker | undefined;

  /**
   * @param localizer The localizer.
   * @param activation The toolbar activation.
   * @param ports The ports for insert table, the opened item, returning, and querying registered shortcuts.
   */
  constructor(
    private readonly localizer: Localizer,
    private readonly activation: ToolbarActivation,
    private readonly ports: TablePickerPorts,
  ) {}

  /**
   * Builds the popup and places it in the container.
   *
   * Only when opened by keyboard (when the opened item has focus), chooses 1 row × 1 column and moves focus to
   * the grid. When opened by pointer, chooses nothing and does not move focus. Moving it would lose the selection
   * after the press.
   *
   * @param container The container of the item.
   * @returns The placed popup.
   */
  buildPopup(container: HTMLElement): HTMLElement {
    const document = container.ownerDocument;
    const element = document.createElement('div');
    element.className = TABLE_PICKER_CLASS;
    element.setAttribute('role', 'dialog');

    const grid = document.createElement('div');
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-label', this.localizer.getMessage('tablePicker.grid'));
    grid.tabIndex = 0;
    const cells: HTMLElement[][] = [];
    const positions = new Map<Element, { rows: number; columns: number }>();
    for (let row = 1; row <= TABLE_PICKER_SIZE.grid; row += 1) {
      const rowElement = document.createElement('div');
      rowElement.setAttribute('role', 'row');
      const rowCells: HTMLElement[] = [];
      for (let column = 1; column <= TABLE_PICKER_SIZE.grid; column += 1) {
        const cell = document.createElement('div');
        cell.setAttribute('role', 'gridcell');
        // The id the grid's aria-activedescendant points at. Only one popup is open at a time.
        cell.id = `${TABLE_PICKER_CLASS}-cell-${row}-${column}`;
        cell.setAttribute('aria-label', this.readSizeMessage(row, column));
        cell.setAttribute('aria-selected', 'false');
        rowElement.append(cell);
        rowCells.push(cell);
        positions.set(cell, { rows: row, columns: column });
      }
      grid.append(rowElement);
      cells.push(rowCells);
    }

    const size = document.createElement('div');
    const rowsInput = createSizeInput(document);
    const columnsInput = createSizeInput(document);
    const insert = document.createElement('button');
    insert.type = 'button';
    insert.textContent = this.localizer.getMessage('tablePicker.insert');
    const fields = document.createElement('div');
    fields.append(
      createSizeField(document, this.localizer.getMessage('tablePicker.rows'), rowsInput),
      createSizeField(document, this.localizer.getMessage('tablePicker.columns'), columnsInput),
      insert,
    );
    element.append(grid, size, fields);
    container.append(element);

    const opened: OpenTablePicker = {
      element,
      grid,
      cells,
      positions,
      size,
      rowsInput,
      columnsInput,
      rows: 0,
      columns: 0,
    };
    this.open = opened;

    // Closing detaches the whole element, so the subscriptions need no disposal.
    grid.addEventListener('pointerover', (event) => this.handleCellPointer(event, opened, false));
    grid.addEventListener('click', (event) => this.handleCellPointer(event, opened, true));
    grid.addEventListener('focus', () => {
      if (opened.rows === 0) {
        // Entering by Tab after opening by pointer also starts from the same state as opening by keyboard.
        this.select(opened, 1, 1);
      }
    });
    grid.addEventListener('keydown', (event) => this.handleGridKeyDown(event, opened));
    for (const input of [rowsInput, columnsInput]) {
      input.addEventListener('keydown', (event) => this.handleInputKeyDown(event, opened));
    }
    insert.addEventListener('click', () => this.runFromInputs(opened));
    element.addEventListener('keydown', (event) => this.handleKeyDown(event));
    element.addEventListener('focusout', (event) => this.handleFocusOut(event, opened));

    const openedItem = this.ports.readOpenedItem();
    if (openedItem !== undefined && document.activeElement === openedItem) {
      this.select(opened, 1, 1);
      // Right after opening, the contents have not been placed inside the view yet. Scrolling now would move the
      // view sideways to the position before placement, and the placement would measure the wrong amount.
      grid.focus({ preventScroll: true });
    }
    return element;
  }

  /**
   * Receives the closed notification and drops the reference to the popup.
   *
   * Asks to return to the editor root only when closed by something other than running or Esc while focus was
   * inside. Without asking, focus would be lost along with the detached element. Running already returns right
   * before the action, and Esc returns to the opened item, so neither asks.
   *
   * @param closure The popup closure.
   */
  handleClosed(closure: ToolbarPopupClosure): void {
    this.open = undefined;
    if (closure.trigger === 'other' && closure.focusedInside) {
      this.ports.requestReturn();
    }
  }

  /**
   * Changes the size chosen on the grid and conveys it to assistive technology and the display.
   *
   * @param opened The open popup.
   * @param rows The number of rows.
   * @param columns The number of columns.
   */
  private select(opened: OpenTablePicker, rows: number, columns: number): void {
    opened.rows = rows;
    opened.columns = columns;
    opened.cells.forEach((rowCells, row) => {
      rowCells.forEach((cell, column) => {
        cell.setAttribute('aria-selected', String(row < rows && column < columns));
      });
    });
    const active = opened.cells[rows - 1]?.[columns - 1];
    if (active !== undefined) {
      opened.grid.setAttribute('aria-activedescendant', active.id);
    }
    opened.size.textContent = this.readSizeMessage(rows, columns);
  }

  /**
   * Handles pointer movement over and presses on the grid cells.
   *
   * @param event The pointer event.
   * @param opened The open popup.
   * @param run `true` for a press; turns insert table with the chosen size into an activation request.
   */
  private handleCellPointer(event: Event, opened: OpenTablePicker, run: boolean): void {
    const target = event.target;
    const cell = target instanceof Element ? target.closest('[role="gridcell"]') : null;
    const position = cell === null ? undefined : opened.positions.get(cell);
    if (position === undefined) {
      return;
    }
    this.select(opened, position.rows, position.columns);
    if (run) {
      this.runInsert(position.rows, position.columns);
    }
  }

  /**
   * Handles keys on the grid.
   *
   * @param event The pressed key.
   * @param opened The open popup.
   */
  private handleGridKeyDown(event: KeyboardEvent, opened: OpenTablePicker): void {
    if (event.isComposing || hasModifier(event)) {
      return;
    }
    const move = GRID_MOVE_KEYS[event.key];
    if (move !== undefined) {
      event.stopPropagation();
      event.preventDefault();
      this.select(
        opened,
        clamp(opened.rows + move.rows, 1, TABLE_PICKER_SIZE.grid),
        clamp(opened.columns + move.columns, 1, TABLE_PICKER_SIZE.grid),
      );
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      // Stop the default so this keystroke does not land as a paragraph or a space in the editor root, where
      // focus returns right before running.
      event.stopPropagation();
      event.preventDefault();
      this.runInsert(Math.max(opened.rows, 1), Math.max(opened.columns, 1));
    }
  }

  /**
   * Handles keys in the input fields. Enter during composition commits the composition and is not turned into an
   * activation request.
   *
   * @param event The pressed key.
   * @param opened The open popup.
   */
  private handleInputKeyDown(event: KeyboardEvent, opened: OpenTablePicker): void {
    if (event.isComposing || event.key !== 'Enter' || hasModifier(event)) {
      return;
    }
    // Stop the default so this keystroke does not land as a paragraph in the editor root, where focus returns
    // right before running.
    event.stopPropagation();
    event.preventDefault();
    this.runFromInputs(opened);
  }

  /**
   * Handles keys inside the popup that the grid and input fields did not handle.
   *
   * @param event The pressed key.
   */
  private handleKeyDown(event: KeyboardEvent): void {
    // Leave Enter and Esc during composition to committing and cancelling the composition. Leave Tab to the
    // default for moving inside and out.
    if (event.isComposing || event.key === 'Tab') {
      return;
    }
    if (event.key === 'Escape') {
      // The toolbar activation's capture-phase listener has already closed the popup. Return to the opened item
      // rather than the editor root, so work in the item bar can continue.
      event.stopPropagation();
      event.preventDefault();
      this.ports.readOpenedItem()?.focus();
      return;
    }
    if (this.ports.hasShortcut(event)) {
      // Passing a registered key on to VS Code would trigger a different key binding. Take it over without
      // calling the action, and do not stop editing of the input field value.
      event.stopPropagation();
      if (!(event.target instanceof HTMLInputElement)) {
        event.preventDefault();
      }
    }
  }

  /**
   * Has the popup closed when focus moves outside it. Leaves the destination to the default.
   *
   * @param event The popup's focusout.
   * @param opened The popup that lost focus.
   */
  private handleFocusOut(event: FocusEvent, opened: OpenTablePicker): void {
    const next = event.relatedTarget;
    if (next instanceof Node && opened.element.contains(next)) {
      return;
    }
    if (this.open !== opened) {
      // Already closed. Ignore notifications that arrive after closing.
      return;
    }
    this.activation.closePopup();
  }

  /**
   * Turns insert table with the size in the input fields into an activation request.
   *
   * @param opened The open popup.
   */
  private runFromInputs(opened: OpenTablePicker): void {
    this.runInsert(readTableSize(opened.rowsInput.value), readTableSize(opened.columnsInput.value));
  }

  /**
   * Turns insert table into an activation request through the toolbar activation. During an input stop or
   * composition, the toolbar activation does not call it and leaves the popup open.
   *
   * @param rows The number of rows.
   * @param columns The number of columns.
   */
  private runInsert(rows: number, columns: number): void {
    this.activation.activatePopupAction(() => this.ports.insertTable(rows, columns));
  }

  /**
   * Looks up the message for a number of rows and columns. The grid cell names and the size display use the same
   * message.
   *
   * @param rows The number of rows.
   * @param columns The number of columns.
   * @returns The size message.
   */
  private readSizeMessage(rows: number, columns: number): string {
    return this.localizer.getMessage('tablePicker.size', { rows, columns });
  }
}

/**
 * Reads an input field string as a number of rows or columns, clamped to an integer from 1 to 100.
 *
 * Full-width digits are read as the same numbers as half-width digits, so that digits typed with Japanese input
 * still on are not treated as non-numeric and clamped to 1. Empty and non-numeric values and values below 1
 * become 1, values above 100 become 100, and fractions are truncated.
 *
 * @param value The input field string.
 * @returns An integer from 1 to 100.
 */
export function readTableSize(value: string): number {
  const normalized = value
    .replace(FULL_WIDTH_DIGIT_PATTERN, (digit) => String.fromCharCode(digit.charCodeAt(0) - FULL_WIDTH_OFFSET))
    .trim();
  // Number reads the empty string as 0, which is below 1 and clamps to 1 here, so it needs no separate case.
  const parsed = Number(normalized);
  if (Number.isNaN(parsed)) {
    return 1;
  }
  return clamp(Math.trunc(parsed), 1, TABLE_PICKER_SIZE.max);
}

/**
 * Creates an input field for the number of rows or columns. The initial value is 3.
 *
 * A number-type input field does not accept full-width digits, so a text input field is used and the reading
 * side clamps the value.
 *
 * @param document The document to create the input field in.
 * @returns The input field.
 */
function createSizeInput(document: Document): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = String(TABLE_PICKER_SIZE.initial);
  return input;
}

/**
 * Attaches a label with text to an input field.
 *
 * Wraps it in a label so that pressing the text also moves focus to the input field. The accessible name is set
 * directly on the input field, so that it is not read with the input field's value inside the label mixed into
 * the name.
 *
 * @param document The document to create the label in.
 * @param label The text.
 * @param input The input field.
 * @returns The label.
 */
function createSizeField(document: Document, label: string, input: HTMLInputElement): HTMLLabelElement {
  input.setAttribute('aria-label', label);
  const field = document.createElement('label');
  field.append(label, input);
  return field;
}

/**
 * Keeps a value within a range.
 *
 * @param value The value.
 * @param min The lower bound.
 * @param max The upper bound.
 * @returns The value kept within the range.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Returns whether the pressed key has a modifier. Arrows with modifiers can mean something else, such as
 * extending a range selection.
 *
 * @param event The pressed key.
 * @returns `true` if a modifier is held.
 */
function hasModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;
}
