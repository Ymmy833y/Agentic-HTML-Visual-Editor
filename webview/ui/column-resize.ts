import type { ShortcutPlatform } from '../editing/shortcut-receiver';
import type { TableOperation } from '../editing/table-command';
import { findGridCell, findTableCell, readCellTable, resolveTableGrid } from '../editing/table-grid';
import { measureTableColumns, readColumnWidthLimits, readTableWidthUnit } from '../editing/table-width';

/**
 * The width of a column band (px). A press within this width inward from a cell's right edge starts a drag.
 *
 * The width depends only on pointer precision, so it does not follow the font size.
 */
export const COLUMN_RESIZE_BAND_WIDTH = 6;

/** The ID of the marker element. The bundled stylesheet and E2E look it up with the same spelling. */
export const COLUMN_RESIZE_MARKER_ID = 'editor-column-resize-marker';

/**
 * The name of the attribute on the view's root element that gives the cursor the column resize shape.
 *
 * It is put outside the document tree (on the view's html element), so it does not appear in the output.
 */
export const COLUMN_RESIZE_CURSOR_ATTRIBUTE = 'data-column-resize';

/**
 * The column resize ports. They hold no values and are read on every call (because replacement replaces the editing
 * session).
 */
export interface ColumnResizePorts {
  /** Whether IME composition is in progress at the time of the call. */
  isComposing(): boolean;

  /** Whether any input stop reason remains. */
  isInputStopped(): boolean;

  /**
   * Runs a table operation.
   *
   * @param operation The table operation.
   * @param cell The reference cell.
   * @returns `true` when the tree was changed.
   */
  runTableCommand(operation: TableOperation, cell: Element): boolean;

  /**
   * Records one diagnostic line for maintainers. Not used to notify the user.
   *
   * @param detail The line to record.
   */
  reportDiagnostic(detail: string): void;
}

/** The state during a drag. Holds the values measured at the press for the duration of the drag. */
interface ColumnDrag {
  /** The reference cell. */
  readonly cell: Element;
  /** The table of the reference cell. */
  readonly table: Element;
  /** The x of the press. */
  readonly startX: number;
  /** The rendered width of the target column at the press. */
  readonly startWidth: number;
  /** The x of the target column's right boundary at the press. */
  readonly startBoundary: number;
  /** The minimum of the limits for the rendered width. */
  readonly min: number;
  /** The maximum of the limits for the rendered width. */
  readonly max: number;
}

/**
 * Shows the marker at a column boundary and changes the column width by dragging the boundary.
 *
 * During the drag the document tree is not rewritten; only the marker moves, and on release setting the column width
 * is handed over as a single edit. Writing intermediate widths to the tree would send changes made outside an edit
 * attempt to the host through the output or a save, and they would disagree with the history. One per view, not
 * recreated on replacement.
 */
export class ColumnResize {
  private drag: ColumnDrag | undefined;

  private readonly onDragMove = (event: MouseEvent): void => {
    this.handleDragMove(event);
  };

  private readonly onDragUp = (event: MouseEvent): void => {
    this.handleDragUp(event);
  };

  private readonly onDragCancel = (): void => {
    this.finishDrag();
  };

  // Stops the click that follows the press that started a drag. Otherwise, depending on where the button is released,
  // the click reaches the details toggle listener. The listener is attached to the editor root, and clicks outside are
  // not stopped. A cancelled drag is not followed by a click and the suppression remains, so stopping on the window
  // would also swallow the first click on, say, the toolbar afterwards.
  private readonly onClick = (event: MouseEvent): void => {
    this.stopSuppressingClick();
    event.preventDefault();
    event.stopPropagation();
  };

  /**
   * @param view The view's window.
   * @param root The editor root.
   * @param platform The platform. Used to recognize a press with Ctrl on macOS.
   * @param ports The column resize ports.
   * @param marker The marker element.
   */
  constructor(
    private readonly view: Window,
    private readonly root: HTMLElement,
    private readonly platform: ShortcutPlatform,
    private readonly ports: ColumnResizePorts,
    private readonly marker: HTMLElement,
  ) {}

  /**
   * Returns whether a column resize drag is in progress. Read at the time of a menu request; the menu does not open
   * during a drag.
   *
   * @returns `true` during a drag.
   */
  isDragging(): boolean {
    return this.drag !== undefined;
  }

  /**
   * On a pointer move before a drag, shows the marker and the cursor when over a movable column band, and hides them
   * when off it.
   *
   * Does nothing during a drag (the window listener handles moves then).
   *
   * @param event The pointer move.
   */
  handlePointerMove(event: MouseEvent): void {
    if (this.drag !== undefined) {
      return;
    }
    try {
      const band = this.ports.isComposing() || this.ports.isInputStopped()
        ? undefined
        : findColumnBand(this.root, event.target, event.clientX);
      if (band === undefined) {
        this.hideMarker();
        return;
      }
      this.showMarker(band.boundary, band.table);
    } catch (error) {
      this.ports.reportDiagnostic(`Could not show the column boundary marker: ${String(error)}`);
      this.hideMarker();
    }
  }

  /**
   * When the press is on a column band, prevents the default and propagation to later listeners and starts a drag.
   *
   * The band is found again at the press position rather than relying on the marker shown by moves. If the press
   * reached the later listeners (the cell range selection and the details toggle), the caret would move or a range
   * would be created.
   *
   * @param event The press.
   */
  handlePointerDown(event: MouseEvent): void {
    if (this.drag !== undefined) {
      // A press of another button during a drag does not lift the suppression of the click that follows the drag.
      return;
    }
    // Lifted on every press, so that when the previous drag was not followed by a click, the click of the next press
    // is not stopped.
    this.stopSuppressingClick();
    // Secondary and middle button presses and presses with Ctrl on macOS are treated as menu requests.
    if (event.button !== 0 || (this.platform === 'mac' && event.ctrlKey)) {
      return;
    }

    try {
      if (this.ports.isComposing() || this.ports.isInputStopped()) {
        return;
      }
      const band = findColumnBand(this.root, event.target, event.clientX);
      if (band === undefined) {
        return;
      }
      const measure = measureTableColumns(resolveTableGrid(band.table));
      const limits = readColumnWidthLimits(readTableWidthUnit(band.table), measure, band.column);
      if (limits === undefined) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      this.startDrag({
        cell: band.cell,
        table: band.table,
        startX: event.clientX,
        startWidth: measure.widths[band.column],
        startBoundary: measure.boundaries[band.column + 1],
        min: limits.min,
        max: limits.max,
      });
    } catch (error) {
      this.ports.reportDiagnostic(`Could not start the column resize: ${String(error)}`);
      this.finishDrag();
    }
  }

  /**
   * On a remount, cancels a drag in progress without handing anything over, and removes the marker and the cursor
   * attribute.
   *
   * The reference cell went away with the old tree, so nothing is written after the replacement.
   */
  handleMountCompleted(): void {
    this.finishDrag();
  }

  /**
   * Starts a drag. Only for the duration of the drag, subscribes to the window's move, release and cancel and to the
   * view losing focus.
   *
   * While the button is held, the frame keeps receiving moves and releases outside it as well, so this serves as the
   * means of capturing the pointer.
   *
   * @param drag The state during the drag.
   */
  private startDrag(drag: ColumnDrag): void {
    this.drag = drag;
    this.view.addEventListener('mousemove', this.onDragMove, true);
    this.view.addEventListener('mouseup', this.onDragUp, true);
    this.view.addEventListener('pointercancel', this.onDragCancel, true);
    this.view.addEventListener('blur', this.onDragCancel);
    this.root.addEventListener('click', this.onClick, true);
    this.showMarker(drag.startBoundary, drag.table);
  }

  /**
   * On a move during a drag, moves the marker to a position within the limits.
   *
   * A move without the primary button held is treated as the press having ended without a release, and cancels.
   *
   * @param event The pointer move.
   */
  private handleDragMove(event: MouseEvent): void {
    const drag = this.drag;
    if (drag === undefined) {
      return;
    }
    // Keeps drag moves from reaching listeners such as the one that extends the selection.
    event.stopPropagation();
    try {
      if ((event.buttons & 1) === 0) {
        this.finishDrag();
        return;
      }
      this.moveMarker(drag.startBoundary + readDragWidth(drag, event.clientX) - drag.startWidth);
    } catch (error) {
      this.ports.reportDiagnostic(`Could not move the column boundary marker: ${String(error)}`);
      this.finishDrag();
    }
  }

  /**
   * On release of the primary button, hides the marker and, if the position differs from the press, hands over
   * setting the column width.
   *
   * Only the clamped new rendered width and the reference cell are handed over; writing is left to the table
   * operation.
   *
   * @param event The release.
   */
  private handleDragUp(event: MouseEvent): void {
    const drag = this.drag;
    if (drag === undefined) {
      return;
    }
    event.stopPropagation();
    if (event.button !== 0) {
      return;
    }
    this.finishDrag();
    if (event.clientX === drag.startX) {
      return;
    }
    try {
      this.ports.runTableCommand({ kind: 'setColumnWidth', width: readDragWidth(drag, event.clientX) }, drag.cell);
    } catch (error) {
      this.ports.reportDiagnostic(`Could not set the column width: ${String(error)}`);
    }
  }

  /**
   * Ends a drag in progress and removes the subscriptions. Removes the marker and the cursor attribute even when no
   * drag is in progress.
   */
  private finishDrag(): void {
    if (this.drag !== undefined) {
      this.drag = undefined;
      this.view.removeEventListener('mousemove', this.onDragMove, true);
      this.view.removeEventListener('mouseup', this.onDragUp, true);
      this.view.removeEventListener('pointercancel', this.onDragCancel, true);
      this.view.removeEventListener('blur', this.onDragCancel);
    }
    this.hideMarker();
  }

  /** Lifts the suppression of the following click. */
  private stopSuppressingClick(): void {
    this.root.removeEventListener('click', this.onClick, true);
  }

  /**
   * Shows the marker at the boundary's x with the table's height, and sets the cursor attribute.
   *
   * @param boundary The boundary's x (viewport coordinates).
   * @param table The table.
   */
  private showMarker(boundary: number, table: Element): void {
    const rect = table.getBoundingClientRect();
    this.marker.hidden = false;
    this.marker.style.top = `${rect.top + this.view.scrollY}px`;
    this.marker.style.height = `${rect.height}px`;
    this.moveMarker(boundary);
    this.view.document.documentElement.setAttribute(COLUMN_RESIZE_CURSOR_ATTRIBUTE, '');
  }

  /**
   * Moves the center of the marker to the boundary's x. Placed in document coordinates, so it keeps its position
   * relative to the table when scrolled.
   *
   * @param boundary The boundary's x (viewport coordinates).
   */
  private moveMarker(boundary: number): void {
    this.marker.style.left = `${boundary + this.view.scrollX - this.marker.offsetWidth / 2}px`;
  }

  /** Removes the marker and the cursor attribute. */
  private hideMarker(): void {
    this.marker.hidden = true;
    this.view.document.documentElement.removeAttribute(COLUMN_RESIZE_CURSOR_ATTRIBUTE);
  }
}

/**
 * Places a hidden marker at the end of the body and attaches pointer move and leave listeners and a capture-phase
 * press listener to the editor root.
 *
 * The press must be received before the cell range selection, so this is called only once, on the first mount,
 * before the listeners of the same phase. The editor root element stays the same across document replacements, so
 * the listeners are not reattached.
 *
 * @param view The view's window.
 * @param root The editor root.
 * @param platform The platform. Pass the same value as the shortcut receiver.
 * @param ports The column resize ports.
 * @returns The attached column resize.
 */
export function attachColumnResize(
  view: Window,
  root: HTMLElement,
  platform: ShortcutPlatform,
  ports: ColumnResizePorts,
): ColumnResize {
  const marker = view.document.createElement('div');
  marker.id = COLUMN_RESIZE_MARKER_ID;
  marker.hidden = true;
  // Inside the editor root, it would appear in the body output.
  view.document.body.append(marker);

  const resize = new ColumnResize(view, root, platform, ports, marker);
  root.addEventListener('mousemove', (event) => resize.handlePointerMove(event));
  // The target of a leave is the editor root itself, which has no band, so the same steps as a move hide the marker.
  root.addEventListener('mouseleave', (event) => resize.handlePointerMove(event));
  root.addEventListener('mousedown', (event) => resize.handlePointerDown(event), true);
  return resize;
}

/**
 * Checks whether the pointer is over the band of a movable column boundary. Changes neither the tree nor the
 * selection.
 *
 * The band is the band-width range inward from the right edge of the innermost cell containing the pointer's target.
 * The target column is the rightmost column that cell covers. The right edge of the rightmost column of a percent
 * table is not a band: a percent table changes widths by redistributing them with the neighboring column, so a
 * boundary without a right neighbor cannot be moved.
 *
 * @param root The editor root.
 * @param target The pointer's target.
 * @param x The pointer's x (viewport coordinates).
 * @returns The reference cell, the table, the target column and the boundary's x. `undefined` outside the band,
 *   outside the editor root, or for a td or th that is not a table cell.
 */
export function findColumnBand(
  root: Element,
  target: EventTarget | null,
  x: number,
): { readonly cell: Element; readonly table: Element; readonly column: number; readonly boundary: number } | undefined {
  const cell = target instanceof Node ? findTableCell(target, root) : undefined;
  const table = cell === undefined ? undefined : readCellTable(cell);
  if (cell === undefined || table === undefined) {
    return undefined;
  }
  const rect = cell.getBoundingClientRect();
  if (x > rect.right || x < rect.right - COLUMN_RESIZE_BAND_WIDTH) {
    return undefined;
  }
  const grid = resolveTableGrid(table);
  const origin = findGridCell(grid, cell);
  if (origin === undefined) {
    return undefined;
  }
  const column = origin.column + origin.columnSpan - 1;
  if (readTableWidthUnit(table) === 'percent' && column === grid.columnCount - 1) {
    return undefined;
  }
  return { cell, table, column, boundary: rect.right };
}

/**
 * Computes, from the drag's x, the new rendered width within the limits.
 *
 * @param drag The state during the drag.
 * @param x The pointer's x.
 * @returns The new rendered width (px).
 */
function readDragWidth(drag: ColumnDrag, x: number): number {
  return Math.min(Math.max(drag.startWidth + x - drag.startX, drag.min), drag.max);
}
