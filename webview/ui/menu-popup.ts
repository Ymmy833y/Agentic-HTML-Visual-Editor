import type { ToolbarSlot } from './toolbar-slots';

// The roles treated as menu items. Some items convey their menu mark as a checked state, so all three
// kinds are counted.
const MENU_ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

// The keys that move focus between menu items. The items are stacked vertically, so the left and
// right arrows are not included.
const MENU_POPUP_MOVE_KEYS = ['ArrowUp', 'ArrowDown', 'Home', 'End'] as const;

/** A key that moves focus between menu items. Exported because the table context menu moves with the same keys. */
export type MenuPopupMoveKey = (typeof MENU_POPUP_MOVE_KEYS)[number];

/**
 * The ports the menu popup navigation receives from outside. Nothing is cached; they are read on
 * every call.
 */
export interface MenuPopupPorts {
  /**
   * Returns the button of the item that opened the popup.
   *
   * @param slot The slot of the opened item.
   * @returns The item's button, or `undefined` when it is not registered.
   */
  readOpenedItem(slot: ToolbarSlot): HTMLButtonElement | undefined;

  /** Closes the open popup. The closing steps are left to the toolbar activation. */
  requestClose(): void;

  /**
   * Returns whether the pressed key matches a registered shortcut, without calling its operation.
   *
   * @param event The key press.
   */
  hasShortcut(event: KeyboardEvent): boolean;
}

/** The open menu popup. */
interface OpenMenuPopup {
  readonly slot: ToolbarSlot;
  readonly element: HTMLElement;
  readonly items: readonly HTMLElement[];
}

/**
 * Makes the contents opened by a popup item operable from the keyboard when their role is menu.
 *
 * Moving within contents that are not a list (such as a grid) is left to the owner of the contents
 * and is not handled here. Exactly one is created per view, and it is not recreated on a document
 * replacement.
 */
export class MenuPopupNavigation {
  private open: OpenMenuPopup | undefined;

  /**
   * @param ports The ports for the opened item, the close request and the registered key lookup.
   */
  constructor(private readonly ports: MenuPopupPorts) {}

  /**
   * When the opened contents are a menu, takes the menu items out of the Tab order and subscribes
   * to key presses and focus moves.
   *
   * @param slot The slot of the opened item.
   * @param contents The element of the placed contents.
   */
  handleOpened(slot: ToolbarSlot, contents: HTMLElement): void {
    const items = readMenuPopupItems(contents);
    if (items === undefined) {
      return;
    }

    // Tab is used for the default movement out of the contents, so it does not stop on the menu
    // items.
    for (const item of items) {
      item.tabIndex = -1;
    }

    const popup: OpenMenuPopup = { slot, element: contents, items };
    this.open = popup;
    // Closing removes the element itself, so the subscriptions need no removal.
    contents.addEventListener('keydown', (event) => this.handleKeyDown(event, popup));
    contents.addEventListener('focusout', (event) => this.handleFocusOut(event, popup));

    // When opened with the pointer, focus is in the editor root, and moving it would lose the
    // selection after the press. Focus moves inside only when the opened item has focus, that is,
    // when it was opened from the keyboard.
    const opened = this.ports.readOpenedItem(slot);
    if (opened !== undefined && contents.ownerDocument.activeElement === opened) {
      readInitialMenuItem(items)?.focus();
    }
  }

  /**
   * On the closed notification, discards the reference to the open popup.
   *
   * @param slot The slot of the closed item.
   */
  handleClosed(slot: ToolbarSlot): void {
    if (this.open?.slot === slot) {
      this.open = undefined;
    }
  }

  /**
   * Handles a key press inside the contents.
   *
   * @param event The key press.
   * @param popup The popup that received the press. For Esc the press arrives after the popup has
   *   closed, so it is passed in to let the opened item be looked up even after the reference has
   *   been discarded.
   */
  private handleKeyDown(event: KeyboardEvent, popup: OpenMenuPopup): void {
    if (event.key === 'Tab') {
      // Left to the default movement out of the contents. The popup closes once focus leaves.
      return;
    }

    if (event.key === 'Escape') {
      // The toolbar activation's capture-phase subscription has already closed the popup. Focus
      // goes back to the opened item rather than to the editor root, so that work within the item
      // bar can continue.
      event.stopPropagation();
      event.preventDefault();
      this.ports.readOpenedItem(popup.slot)?.focus();
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      // Running the item is left to the click raised by the button's default press. Only the
      // propagation is stopped, so that the key does not reach VS Code.
      event.stopPropagation();
      return;
    }

    const current = popup.items.findIndex((item) => item === event.target);
    if (current !== -1 && isMenuPopupMoveKey(event.key) && !hasModifier(event)) {
      event.stopPropagation();
      event.preventDefault();
      popup.items[readNextMenuItemIndex(current, popup.items.length, event.key)].focus();
      return;
    }

    if (this.ports.hasShortcut(event)) {
      // Passing a registered key to VS Code would trigger a different key binding, so it is taken
      // over without calling its operation.
      event.stopPropagation();
      event.preventDefault();
    }
  }

  /**
   * Closes the popup when focus moves out of the contents.
   *
   * The destination is left to the default movement: the opened item for Shift+Tab, the editor
   * root for Tab.
   *
   * @param event The focusout on the contents.
   * @param popup The popup that lost focus.
   */
  private handleFocusOut(event: FocusEvent, popup: OpenMenuPopup): void {
    const next = event.relatedTarget;
    if (next instanceof Node && popup.element.contains(next)) {
      return;
    }
    if (this.open !== popup) {
      // Already closed.
      return;
    }
    this.ports.requestClose();
  }
}

/**
 * Tells whether the contents are a menu, and returns the menu items in document order.
 *
 * @param contents The element of the contents.
 * @returns The menu items, or `undefined` when the role is not menu.
 */
export function readMenuPopupItems(contents: HTMLElement): readonly HTMLElement[] | undefined {
  if (contents.getAttribute('role') !== 'menu') {
    return undefined;
  }
  return [...contents.querySelectorAll(MENU_ITEM_SELECTOR)].filter(
    (item): item is HTMLElement => item instanceof HTMLElement,
  );
}

/**
 * Decides the item that receives focus when the popup opens.
 *
 * Focus goes to the first checked item, so that the choice can be made again starting from the item
 * that carries the mark for the current value. A mark can be on one kind item and one alert item
 * each, so inside a blockquote it lands on the kind item, which comes first.
 *
 * @param items The menu items.
 * @returns The first item whose `aria-checked` is true, otherwise the first item. `undefined` when
 *   there are no items.
 */
export function readInitialMenuItem(items: readonly HTMLElement[]): HTMLElement | undefined {
  return items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0];
}

/**
 * Decides the next stop index from the current position, the number of items and the key. Wraps to
 * the opposite end at either end.
 *
 * Exported so that the table context menu wraps around the same way as the toolbar's menu popups.
 *
 * @param current The current position.
 * @param count The number of items.
 * @param key The pressed key.
 */
export function readNextMenuItemIndex(current: number, count: number, key: MenuPopupMoveKey): number {
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
  }
}

/**
 * Returns whether the key moves between menu items.
 *
 * @param key The key value.
 */
export function isMenuPopupMoveKey(key: string): key is MenuPopupMoveKey {
  return MENU_POPUP_MOVE_KEYS.some((candidate) => candidate === key);
}

/**
 * Returns whether the press has a modifier key.
 *
 * @param event The key press.
 */
function hasModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;
}
