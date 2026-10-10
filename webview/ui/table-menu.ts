import type { EncodedSelection, Localizer } from '../../common/index';
import { readSelectionRange } from '../editing/caret';
import type { ShortcutKey, ShortcutOutcome, ShortcutReceiver } from '../editing/shortcut-receiver';
import type { TableOperation } from '../editing/table-command';
import { findTableCell } from '../editing/table-grid';
import { captureSelection } from '../selection/selection-capture';
import { isMenuPopupMoveKey, readNextMenuItemIndex } from './menu-popup';
import { readTableMenuItems } from './table-menu-items';
import type { TableMenuEntry, TableMenuQueries } from './table-menu-items';
import { TOOLBAR_ELEMENT_ID } from './toolbar';

/** The ID of the menu element. The bundled stylesheet and E2E look it up with the same spelling. */
export const TABLE_MENU_ELEMENT_ID = 'editor-table-menu';

/**
 * The shortcut key that opens the menu (Shift+F10).
 *
 * Matched by position (F10) and requires only Shift. Its modifiers differ from Alt+F10, which moves to the toolbar,
 * so the two do not overlap.
 */
export const TABLE_MENU_KEY: ShortcutKey = { code: 'F10', primary: false, shift: true, alt: false };

/** The shortcut key that opens the menu (the Menu key). Matched by position (ContextMenu) and requires no modifiers. */
export const TABLE_MENU_CONTEXT_KEY: ShortcutKey = { code: 'ContextMenu', primary: false, shift: false, alt: false };

/**
 * The menu's ports. They hold no values and are read on every call (because replacement replaces the editing
 * session).
 */
export interface TableMenuPorts {
  /** The query ports that decide the items. */
  readonly queries: TableMenuQueries;

  /** Resolves messages. */
  readonly localizer: Localizer;

  /** Whether IME composition is in progress at the time of the call. */
  isComposing(): boolean;

  /** Whether any input stop reason remains. */
  isInputStopped(): boolean;

  /** Whether a column resize drag is in progress. */
  isDragging(): boolean;

  /**
   * Returns only whether the pressed key matches a registered shortcut, without running its operation.
   *
   * @param event The key press.
   */
  hasShortcut(event: KeyboardEvent): boolean;

  /**
   * Runs a table operation.
   *
   * @param operation The table operation.
   * @param cell The reference cell.
   * @returns `true` when the tree was changed.
   */
  runTableCommand(operation: TableOperation, cell: Element): boolean;

  /**
   * Returns focus and the selection to the editor root.
   *
   * @param selection The selection to restore. When omitted, the selection is not touched.
   */
  requestReturn(selection?: EncodedSelection): void;

  /**
   * Defers the return to the editor root. The return happens when the stop ends or when the view gains focus.
   *
   * @param selection The selection to restore. When absent, only focus is returned.
   */
  deferReturn(selection: EncodedSelection | undefined): void;

  /**
   * Records one diagnostic line for maintainers. Not used to notify the user.
   *
   * @param detail The line to record.
   */
  reportDiagnostic(detail: string): void;
}

/** A menu item (excluding separators). */
type TableMenuItem = Extract<TableMenuEntry, { readonly kind: 'item' }>;

/** An open menu. */
interface OpenTableMenu {
  readonly element: HTMLElement;
  /** The editor root's selection when the menu was opened. `undefined` when it was outside the editor root. */
  readonly selection: EncodedSelection | undefined;
  /** The items, in the same order as `buttons`. */
  readonly items: readonly TableMenuItem[];
  readonly buttons: readonly HTMLButtonElement[];
}

/**
 * The context menu opened over a table cell.
 *
 * The menu is placed outside the editor root and never enters the document tree. On opening, it captures the
 * selection and moves focus to the menu; on closing, it asks for a return to the editor root. If focus stayed in the
 * editor root, keystrokes would rewrite the document while the menu is open, and the Escape that closes it would
 * reach the clearing of the cell range. One per view, not recreated on replacement.
 */
export class TableMenu {
  private open: OpenTableMenu | undefined;

  // Closes on a press outside the menu. It closes on pointerdown, which comes before mousedown, so a press on a column
  // band is received by the column resize after the menu has finished closing.
  private readonly onPointerDown = (event: PointerEvent): void => {
    const open = this.open;
    const target = event.target;
    if (open === undefined || (target instanceof Node && open.element.contains(target))) {
      return;
    }
    this.closeWithReturn();
  };

  // When the view loses focus, focus inside the frame is dropped and does not go back to the original element when
  // the view regains it. If the menu stayed open, it could not be operated by keyboard on return and there would be
  // no caret either, so it is closed and the return is deferred.
  private readonly onViewBlur = (): void => {
    const open = this.close();
    if (open !== undefined) {
      this.ports.deferReturn(open.selection);
    }
  };

  /**
   * @param view The view's window.
   * @param root The editor root.
   * @param ports The menu's ports.
   */
  constructor(
    private readonly view: Window,
    private readonly root: HTMLElement,
    private readonly ports: TableMenuPorts,
  ) {}

  /**
   * Receives a menu request from the pointer and opens the menu on the innermost cell containing the request's
   * target.
   *
   * Without a cell, the default proceeds. During composition, an input stop or a column resize drag, the default is
   * prevented and the menu does not open. If the default were not prevented, the VS Code webview would show its own
   * menu.
   *
   * @param event The menu request.
   */
  handleContextMenu(event: MouseEvent): void {
    const target = event.target;
    const cell = target instanceof Node ? findTableCell(target, this.root) : undefined;
    if (cell === undefined) {
      return;
    }
    event.preventDefault();
    if (this.isBlocked()) {
      return;
    }
    // For a pointer request, the outside press has already closed the menu. Closing before reopening guards against
    // a request that arrives from the keyboard.
    this.close();
    this.openMenu(cell, { left: event.clientX, top: event.clientY }, 'menu');
  }

  /**
   * The operation of the Shift+F10 and Menu key shortcuts. Opens the menu on the innermost cell containing the caret
   * (the start, for a range).
   *
   * @returns "pass" without a cell, otherwise "preventDefault". The default of Shift+F10 is the browser's menu.
   */
  handleMenuKey(): ShortcutOutcome {
    const range = readSelectionRange(this.root);
    const cell = range === undefined ? undefined : findTableCell(range.startContainer, this.root);
    if (cell === undefined) {
      return 'pass';
    }
    if (!this.isBlocked()) {
      this.close();
      const rect = cell.getBoundingClientRect();
      this.openMenu(cell, { left: rect.left, top: rect.bottom }, 'first');
    }
    return 'preventDefault';
  }

  /**
   * On a remount, closes the menu if it is open.
   *
   * The captured selection is in the coordinates of the old tree and is discarded; the selection is the one the
   * replacement places afterwards. When focus was in the menu, it goes away with the menu, so a return is requested.
   * A remount happens inside the input stop of a full text apply, so while the editor root is not editable the return
   * is handed to the deferral and happens when the stop ends.
   */
  handleMountCompleted(): void {
    const open = this.open;
    if (open === undefined) {
      return;
    }
    const active = this.view.document.activeElement;
    const focused = active !== null && open.element.contains(active);
    this.close();
    if (!focused) {
      return;
    }
    if (this.ports.isInputStopped()) {
      this.ports.deferReturn(undefined);
    } else {
      this.ports.requestReturn();
    }
  }

  /**
   * Whether the menu cannot be opened right now.
   *
   * @returns `true` during composition, an input stop or a column resize drag.
   */
  private isBlocked(): boolean {
    return this.ports.isComposing() || this.ports.isInputStopped() || this.ports.isDragging();
  }

  /**
   * Captures the selection, places the menu with its items and moves focus to it.
   *
   * An exception along the way is not thrown out; one diagnostic line is recorded, the partly placed element is
   * removed and the menu does not open.
   *
   * @param cell The reference cell.
   * @param anchor The anchor point (viewport coordinates).
   * @param focusTarget Focus moves to the menu itself for the pointer, and to the first item for the keyboard.
   */
  private openMenu(
    cell: Element,
    anchor: { readonly left: number; readonly top: number },
    focusTarget: 'menu' | 'first',
  ): void {
    let element: HTMLElement | undefined;
    try {
      const entries = readTableMenuItems(cell, this.ports.queries);
      const selection = captureSelection(this.root)?.selection;
      element = this.createElement();
      const items: TableMenuItem[] = [];
      const buttons: HTMLButtonElement[] = [];
      for (const entry of entries) {
        if (entry.kind === 'separator') {
          const separator = this.view.document.createElement('div');
          separator.setAttribute('role', 'separator');
          element.append(separator);
          continue;
        }
        const button = this.createItemButton(entry);
        element.append(button);
        items.push(entry);
        buttons.push(button);
      }

      const open: OpenTableMenu = { element, selection, items, buttons };
      element.addEventListener('keydown', (event) => this.handleKeyDown(event, open));
      element.addEventListener('click', (event) => this.handleClick(event, open));
      // Placed outside the editor root. Inside it, the menu would appear in the body output.
      this.view.document.body.append(element);
      this.place(element, anchor);

      this.open = open;
      this.view.document.addEventListener('pointerdown', this.onPointerDown, true);
      this.view.addEventListener('blur', this.onViewBlur);
      (focusTarget === 'menu' ? element : buttons.at(0) ?? element).focus({ preventScroll: true });
    } catch (error) {
      this.ports.reportDiagnostic(`Could not open the table context menu: ${String(error)}`);
      if (element !== undefined && this.open?.element === element) {
        this.close();
      } else {
        element?.remove();
      }
    }
  }

  /**
   * Creates the menu element.
   *
   * @returns An element with the menu role and a name taken from the catalog.
   */
  private createElement(): HTMLElement {
    const element = this.view.document.createElement('div');
    element.id = TABLE_MENU_ELEMENT_ID;
    element.setAttribute('role', 'menu');
    element.setAttribute('aria-label', this.ports.localizer.getMessage('tableMenu.name'));
    element.tabIndex = -1;
    // Prevents the default of a press so that a press does not move focus or the selection. Even a press on an item's
    // text does not take the selection away from the editor root.
    element.addEventListener('mousedown', (event) => event.preventDefault());
    // A request over the menu does nothing. Even with the default of its keydown prevented, the Menu key raises a
    // request at the focused element on release, and unless that is prevented the VS Code menu appears on top.
    element.addEventListener('contextmenu', (event) => event.preventDefault());
    return element;
  }

  /**
   * Creates an item's button. Disabled items also receive focus, so that moving to one by keyboard announces that it
   * is disabled.
   *
   * @param entry The item.
   * @returns A button with the menuitem role.
   */
  private createItemButton(entry: TableMenuItem): HTMLButtonElement {
    const button = this.view.document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    button.textContent = this.ports.localizer.getMessage(entry.messageKey);
    if (!entry.enabled) {
      button.setAttribute('aria-disabled', 'true');
    }
    return button;
  }

  /**
   * Places the menu, in document coordinates, where it fits in the visible area.
   *
   * Because it is placed in document coordinates, its position relative to the table does not change when scrolled
   * while open.
   *
   * @param element The menu element.
   * @param anchor The anchor point (viewport coordinates).
   */
  private place(element: HTMLElement, anchor: { readonly left: number; readonly top: number }): void {
    // Overlapping the fixed toolbar's strip would make the strip's items impossible to press, so the area above the
    // bottom of the strip is excluded from where the menu can go.
    const toolbar = this.view.document.getElementById(TOOLBAR_ELEMENT_ID)?.getBoundingClientRect();
    // The rendered size rather than offsetWidth, which rounds to whole pixels and would let the menu overflow the
    // right or bottom edge by a fraction of a pixel.
    const size = element.getBoundingClientRect();
    const position = readTableMenuPlacement(
      anchor,
      { width: size.width, height: size.height },
      { left: 0, top: toolbar?.bottom ?? 0, right: this.view.innerWidth, bottom: this.view.innerHeight },
    );
    element.style.left = `${position.left + this.view.scrollX}px`;
    element.style.top = `${position.top + this.view.scrollY}px`;
  }

  /**
   * Handles keys inside the menu.
   *
   * @param event The key press.
   * @param open The menu that received the press.
   */
  private handleKeyDown(event: KeyboardEvent, open: OpenTableMenu): void {
    if (this.open !== open) {
      return;
    }
    const index = open.buttons.findIndex((button) => button === event.target);

    if (isMenuPopupMoveKey(event.key) && !hasModifier(event)) {
      event.preventDefault();
      event.stopPropagation();
      // When the menu itself has focus (right after opening by pointer), Down and Home move to the first item, and
      // Up and End to the last.
      const next = index === -1
        ? (event.key === 'ArrowDown' || event.key === 'Home' ? 0 : open.buttons.length - 1)
        : readNextMenuItemIndex(index, open.buttons.length, event.key);
      open.buttons.at(next)?.focus();
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      // Prevents the default so the button press is not raised, keeping the keystroke used to run the item out of
      // the editor root that focus returns to.
      event.preventDefault();
      event.stopPropagation();
      const item = index === -1 ? undefined : open.items[index];
      if (item?.enabled === true) {
        this.runItem(item);
      }
      return;
    }

    if (event.key === 'Escape' || (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      this.closeWithReturn();
      return;
    }

    if (this.ports.hasShortcut(event)) {
      // Passing a registered key to VS Code would run a different key binding. It is taken over without running the
      // operation.
      event.preventDefault();
      event.stopPropagation();
    }
  }

  /**
   * Handles a press on an item. A disabled item does nothing and the menu stays open.
   *
   * @param event The click.
   * @param open The menu that received the press.
   */
  private handleClick(event: MouseEvent, open: OpenTableMenu): void {
    event.stopPropagation();
    const target = event.target;
    const index = target instanceof Node ? open.buttons.findIndex((button) => button.contains(target)) : -1;
    const item = index === -1 ? undefined : open.items[index];
    if (this.open === open && item?.enabled === true) {
      this.runItem(item);
    }
  }

  /**
   * Runs an item. Closes the menu and returns to the editor root, then runs the table operation.
   *
   * The table operation is called on the assumption that the editor root has focus, so the return comes first.
   * During an input stop nothing happens and the menu stays open, so the item can be chosen again after the stop
   * ends. The behavior does not change with the result.
   *
   * @param item An enabled item.
   */
  private runItem(item: TableMenuItem): void {
    if (this.ports.isInputStopped()) {
      return;
    }
    const open = this.close();
    this.ports.requestReturn(open?.selection);
    this.ports.runTableCommand(item.operation, item.cell);
  }

  /**
   * Closes the menu; if the editor root is editable, requests a return with the captured selection, otherwise hands
   * it to the deferral.
   *
   * While the editor root is not editable a return request does nothing, so the return happens when the stop ends.
   * Whether it is editable is read at the time of closing.
   */
  private closeWithReturn(): void {
    const open = this.close();
    if (open === undefined) {
      return;
    }
    if (this.ports.isInputStopped()) {
      this.ports.deferReturn(open.selection);
    } else {
      this.ports.requestReturn(open.selection);
    }
  }

  /**
   * If the menu is open, removes the subscriptions and the element.
   *
   * @returns The closed menu, or `undefined` when none was open.
   */
  private close(): OpenTableMenu | undefined {
    const open = this.open;
    if (open === undefined) {
      return undefined;
    }
    this.open = undefined;
    this.view.document.removeEventListener('pointerdown', this.onPointerDown, true);
    this.view.removeEventListener('blur', this.onViewBlur);
    open.element.remove();
    return open;
  }
}

/**
 * Creates the menu, attaches a menu request listener to the editor root, and adds the Shift+F10 and Menu key
 * shortcuts to the end of the shortcut receiver's list.
 *
 * The editor root element stays the same across document replacements, so this is called only once, on the first
 * mount.
 *
 * @param view The view's window.
 * @param root The editor root.
 * @param receiver The shortcut receiver.
 * @param ports The menu's ports.
 * @returns The attached menu.
 */
export function attachTableMenu(
  view: Window,
  root: HTMLElement,
  receiver: ShortcutReceiver,
  ports: TableMenuPorts,
): TableMenu {
  const menu = new TableMenu(view, root, ports);
  root.addEventListener('contextmenu', (event) => menu.handleContextMenu(event));
  receiver.register({ key: TABLE_MENU_KEY, run: () => menu.handleMenuKey() });
  receiver.register({ key: TABLE_MENU_CONTEXT_KEY, run: () => menu.handleMenuKey() });
  return menu;
}

/**
 * Decides, from the anchor point, a menu position that fits in the area where it can go.
 *
 * Horizontally it is pulled into the area; if it overflows downward, it is shifted up to align with the bottom of
 * the area. Even a menu larger than the area never goes above the top, so the first item stays visible.
 *
 * @param anchor The anchor point (viewport coordinates). For the pointer, the position of the request; for the
 *   keyboard, the left end of the bottom edge of the reference cell.
 * @param size The menu's size.
 * @param area The area where the menu can go (viewport coordinates).
 * @returns The top-left of the menu (viewport coordinates).
 */
export function readTableMenuPlacement(
  anchor: { readonly left: number; readonly top: number },
  size: { readonly width: number; readonly height: number },
  area: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
): { readonly left: number; readonly top: number } {
  const left = Math.max(area.left, Math.min(anchor.left, area.right - size.width));
  const top = Math.max(area.top, Math.min(anchor.top, area.bottom - size.height));
  return { left, top };
}

/**
 * Returns whether the press has a modifier key.
 *
 * @param event The key press.
 * @returns `true` when any of Ctrl, Alt, Meta or Shift is held.
 */
function hasModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;
}
