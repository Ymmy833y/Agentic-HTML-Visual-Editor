import type { ShortcutKey, ShortcutReceiver } from '../editing/shortcut-receiver';

/**
 * The reach key. Moves focus from the editor root to the stop of the fixed toolbar.
 *
 * Inside a list or a table, Tab and Shift+Tab are taken over by other operations and the default
 * movement cannot get to the toolbar, so Alt+F10, which is widely used for moving to a toolbar, is
 * added. It is matched by position and limited to the combination that requires Alt only.
 */
export const REACH_KEY: ShortcutKey = { code: 'F10', primary: false, shift: false, alt: true };

// The keys that move focus and the stop between items. The toolbar is laid out horizontally, so the
// up and down arrows are not included.
const ITEM_BAR_MOVE_KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End'] as const;

/** A key that moves focus and the stop between items. */
export type ItemBarMoveKey = (typeof ITEM_BAR_MOVE_KEYS)[number];

/** The ports an item bar receives from outside. Nothing is cached; they are read on every call. */
export interface ItemBarPorts {
  /**
   * Returns the item buttons in document order. Popup contents, separators and indicators are not
   * included.
   *
   * Items can be registered or rebuilt later, so this is read on every call.
   */
  readButtons(): readonly HTMLButtonElement[];

  /**
   * Returns whether the pressed key matches a registered shortcut, without calling its operation.
   *
   * @param event The key press.
   */
  hasShortcut(event: KeyboardEvent): boolean;

  /**
   * Returns focus and the captured selection to the editor root. How the time while it is not
   * editable is handled is up to the receiver.
   */
  returnToEditor(): void;
}

/**
 * Adds the reach key as a shortcut at the end of the shortcut receiver's list.
 *
 * It comes after the format and block type shortcuts and before those of later feature units. The
 * receiver stops propagation, so the reach key does not reach VS Code.
 *
 * @param receiver The shortcut receiver.
 * @param focusStop The function that moves focus to the stop of the fixed toolbar.
 */
export function registerReachKey(receiver: ShortcutReceiver, focusStop: () => void): void {
  receiver.register({
    key: REACH_KEY,
    run: () => {
      focusStop();
      return 'preventDefault';
    },
  });
}

/**
 * Treats the fixed toolbar and the floating menu as item bars in which Tab stops on exactly one
 * item.
 *
 * The stop is held on the elements as the items' tabindex (0 for the stop only, -1 for the others)
 * and is not cached here. Items are replaced by registration and rebuilding, so a cached reference
 * would keep pointing at a stale element. One is created each for the fixed toolbar and the floating
 * menu, and they are not recreated on a document replacement.
 */
export class ItemBar {
  /**
   * @param element The item bar element.
   * @param ports The ports for the item list, the registered key lookup and the return to the
   *   editor root.
   */
  constructor(
    private readonly element: HTMLElement,
    private readonly ports: ItemBarPorts,
  ) {}

  /** Makes only the first item the stop and the others non-stops. Does nothing without items. */
  resetStop(): void {
    this.ports.readButtons().forEach((button, index) => {
      button.tabIndex = index === 0 ? 0 : -1;
    });
  }

  /**
   * Moves focus to the item that is the stop. Without a stop, makes the first item the stop before
   * moving.
   */
  focusStop(): void {
    const buttons = this.ports.readButtons();
    const stop = buttons.find(isStop) ?? buttons[0];
    if (stop === undefined) {
      return;
    }
    stop.tabIndex = 0;
    stop.focus();
  }

  /**
   * Returns whether the node is the item bar element or inside it.
   *
   * The popup contents of the fixed toolbar are placed inside the item's container, so this is also
   * true for nodes inside the contents.
   *
   * @param node The node to check.
   */
  contains(node: Node | null): boolean {
    return node !== null && this.element.contains(node);
  }

  /**
   * Handles a key press inside the item bar.
   *
   * @param event The key press.
   */
  handleKeyDown(event: KeyboardEvent): void {
    const buttons = this.ports.readButtons();
    const current = buttons.findIndex((button) => button === event.target);
    if (current === -1) {
      // Keys on elements that are not items, such as popup contents, are left to the owner of the
      // contents.
      return;
    }

    if (event.key === 'Tab') {
      // Left to the default movement out of the item bar. The registered keys are not looked up
      // even if a registered shortcut takes over Tab.
      return;
    }

    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      this.ports.returnToEditor();
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      // Running the item is left to the click raised by the button's default press. That click
      // returns focus to the editor root, so the keystroke used to run the item does not go into
      // the editor root. Only the propagation is stopped, so that the key does not reach VS Code.
      event.stopPropagation();
      return;
    }

    const button = buttons[current];
    if (event.key === 'ArrowDown' && !hasModifier(event) && hasPopup(button)) {
      // A press that opens a popup goes through the same path as the pointer, so that the input
      // stop and disabled checks are the same.
      event.stopPropagation();
      event.preventDefault();
      button.click();
      return;
    }

    if (isItemBarMoveKey(event.key) && !hasModifier(event)) {
      event.stopPropagation();
      event.preventDefault();
      const next = buttons[readNextStopIndex(current, buttons.length, event.key)];
      button.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
      return;
    }

    if (this.ports.hasShortcut(event)) {
      // Registered keys only mean something in the editor root, but passing them to VS Code would
      // trigger a different key binding, so they are taken over without calling their operations.
      event.stopPropagation();
      event.preventDefault();
    }
  }
}

/**
 * Creates an item bar and subscribes to keydown on its element in the bubbling phase.
 *
 * VS Code receives keydown in the bubbling phase of the inner window and forwards it, so stopping
 * propagation at the element keeps the key from reaching VS Code.
 *
 * @param element The item bar element.
 * @param ports The item bar's ports.
 * @returns The attached item bar.
 */
export function attachItemBar(element: HTMLElement, ports: ItemBarPorts): ItemBar {
  const bar = new ItemBar(element, ports);
  element.addEventListener('keydown', (event) => bar.handleKeyDown(event));
  return bar;
}

/**
 * Decides the next stop index from the current position, the number of items and the key.
 *
 * Left and Right wrap to the opposite end at either end, and Home and End return the first and the
 * last. With a single item, the current position is returned.
 *
 * @param current The current position.
 * @param count The number of items.
 * @param key The pressed key.
 * @returns The next stop index.
 */
export function readNextStopIndex(current: number, count: number, key: ItemBarMoveKey): number {
  if (count <= 1) {
    return current;
  }
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % count;
    case 'ArrowLeft':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
  }
}

/**
 * Returns whether the key moves between items.
 *
 * @param key The key value.
 */
function isItemBarMoveKey(key: string): key is ItemBarMoveKey {
  return ITEM_BAR_MOVE_KEYS.some((candidate) => candidate === key);
}

/**
 * Returns whether the button is the stop. The attribute is read because `tabIndex` also returns 0
 * for a button without the attribute.
 *
 * @param button The button to check.
 */
function isStop(button: HTMLButtonElement): boolean {
  return button.getAttribute('tabindex') === '0';
}

/**
 * Returns whether the item has a popup.
 *
 * @param button The button to check.
 */
function hasPopup(button: HTMLButtonElement): boolean {
  const value = button.getAttribute('aria-haspopup');
  return value !== null && value !== 'false';
}

/**
 * Returns whether the press has a modifier key. Arrows with a modifier can mean something else,
 * such as a selection extension, so they are not treated as moves.
 *
 * @param event The key press.
 */
function hasModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;
}
