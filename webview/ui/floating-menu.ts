import type { Localizer, MessageKey } from '../../common/index';
import { readSelectionRange } from '../editing/caret';
import type { CaretState } from '../editing/caret-state';
import { PRESSED_FORMAT_SLOTS } from './toolbar-state';
import { TOOLBAR_SLOT } from './toolbar-slots';
import type { ToolbarSlot } from './toolbar-slots';
import { TOOLBAR_ELEMENT_ID, applyPressedAttributes, createItemIcon } from './toolbar';
import type { RegisteredToolbarItem, ToolbarItemState } from './toolbar';
import type { TooltipController } from './tooltip';

/** ID of the component's element. Kept in line with the stylesheet's spelling. */
export const FLOATING_MENU_ELEMENT_ID = 'editor-floating-menu';

/** Slots of the frequently used operations, in the order they appear in the fixed toolbar. */
export const FLOATING_MENU_SLOTS: readonly ToolbarSlot[] = [
  TOOLBAR_SLOT.bold,
  TOOLBAR_SLOT.italic,
  TOOLBAR_SLOT.inlineCode,
  TOOLBAR_SLOT.clearFormatting,
  TOOLBAR_SLOT.link,
  TOOLBAR_SLOT.comment,
];

// Distance kept from the selection. Overlapping the selection would hide the selected text under the menu.
const SELECTION_GAP_PX = 6;

/** A rectangle relative to the viewport. */
export interface FloatingMenuRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The component's size. */
export interface FloatingMenuSize {
  readonly width: number;
  readonly height: number;
}

/** Coordinates of the floating menu placement, relative to the viewport. */
export interface FloatingMenuPosition {
  readonly left: number;
  readonly top: number;
}

/** One item to lay out. Holds no operation. */
export interface FloatingMenuItem {
  /** The slot in the fixed toolbar. */
  readonly slot: ToolbarSlot;
  /** Message key used for the accessible name and the tooltip. */
  readonly messageKey: MessageKey;
  /** Icon path drawn in a 24×24 view box. */
  readonly iconPath: string;
}

/** Ports of the floating menu. */
export interface FloatingMenuPorts {
  /** Returns the editor root. Read on every call rather than held as a value, because it spans document replacements. */
  readEditorRoot(): HTMLElement | undefined;

  /**
   * Returns the registered item of the fixed toolbar.
   *
   * Does not receive the operation. Taking the operation would create a second definition of an
   * entry point for the same operation.
   *
   * @param slot The slot.
   */
  readItem(slot: ToolbarSlot): RegisteredToolbarItem | undefined;

  /** Reads the current display state of the fixed toolbar item, without taking its operation. */
  readItemState(slot: ToolbarSlot): ToolbarItemState | undefined;

  /**
   * Requests activation of the given slot. The receiver checks input stop, disabled, and composition.
   *
   * @param slot The pressed slot.
   */
  activateSlot(slot: ToolbarSlot): void;

  /** Message resolution. */
  readonly localizer: Localizer;

  /** The tooltip controller. */
  readonly tooltip: TooltipController;

  /**
   * Notifies synchronously, after hiding, that the menu was hidden while holding focus.
   *
   * Key input does not reach hidden items, so the receiver decides where focus goes.
   */
  notifyHiddenWithFocus(): void;
}

/**
 * A menu of frequently used operations shown near a range selection.
 */
export class FloatingMenu {
  // Whether it is shown. The position update and the close port use this to decide whether there
  // is anything to correct.
  private shown = false;

  // The order of registered slots built last time. Items are rebuilt only when it changes.
  private slots: readonly ToolbarSlot[] = [];

  private buttons: ReadonlyMap<ToolbarSlot, HTMLButtonElement> = new Map();

  // Whether the element that last received focus in the view is inside the component. When focus
  // moves outside the frame, Chromium also removes focus from the element inside the frame, so after
  // leaving the view the focus at the moment of hiding alone cannot tell whether the component had
  // it.
  private lastFocusInside = false;

  /**
   * @param element The component's element.
   * @param ports Ports of the floating menu.
   */
  constructor(
    private readonly element: HTMLElement,
    private readonly ports: FloatingMenuPorts,
  ) {}

  /** Whether it is shown. Read by the receiver of position triggers to decide whether there is a position to correct. */
  get visible(): boolean {
    return this.shown;
  }

  /**
   * Decides the pressed state, visibility, and position from the caret state.
   *
   * @param state The caret state.
   */
  applyState(state: CaretState): void {
    this.buildItems();

    for (const [slot, button] of this.buttons) {
      const disabled = this.ports.readItemState(slot)?.disabled === true;
      button.setAttribute('aria-disabled', String(disabled));
      button.toggleAttribute('data-disabled', disabled);
    }

    // The pressed state is copied whether shown or hidden, so that the next time it becomes visible
    // it reflects the current selection.
    for (const [slot, format] of PRESSED_FORMAT_SLOTS) {
      const button = this.buttons.get(slot);
      if (button !== undefined) {
        applyPressedAttributes(button, state.formats[format]);
      }
    }

    const rect = this.readSelectionRect();
    if (rect === undefined) {
      this.hide();
      return;
    }

    this.shown = true;
    this.element.hidden = false;
    this.place(rect);
  }

  /** Corrects the position only while shown. Does not re-check the display condition. */
  updatePosition(): void {
    if (!this.shown) {
      return;
    }
    const rect = this.readSelectionRect();
    if (rect === undefined) {
      return;
    }
    this.place(rect);
  }

  /**
   * Hides the menu. Does nothing if already hidden.
   *
   * Called from outside when an action dialog opens, to keep a single interactive surface.
   */
  hide(): void {
    if (!this.shown) {
      return;
    }
    const document = this.element.ownerDocument;
    const active = document.activeElement;
    const hadFocus = (active !== null && this.element.contains(active))
      || (this.lastFocusInside && !document.hasFocus());
    this.shown = false;
    this.element.hidden = true;
    if (hadFocus) {
      // The recorded value is used up, so that the same departure is not reported twice.
      this.lastFocusInside = false;
      this.ports.notifyHiddenWithFocus();
    }
  }

  /**
   * Records whether the element that received focus in the view is inside the component.
   *
   * @param event The focusin on the document.
   */
  recordFocus(event: FocusEvent): void {
    this.lastFocusInside = event.target instanceof Node && this.element.contains(event.target);
  }

  /**
   * Returns the buttons of the laid-out items in layout order (the same as the fixed toolbar).
   *
   * @returns The item buttons.
   */
  readButtons(): HTMLButtonElement[] {
    return [...this.buttons.values()];
  }

  /** Rebuilds the items only when the order of registered slots differs from last time. */
  private buildItems(): void {
    const items = readFloatingMenuItems((slot) => this.ports.readItem(slot));
    const slots = items.map((item) => item.slot);
    if (slots.length === this.slots.length && slots.every((slot, index) => slot === this.slots[index])) {
      return;
    }

    const document = this.element.ownerDocument;
    const buttons = new Map<ToolbarSlot, HTMLButtonElement>();
    for (const item of items) {
      const label = this.ports.localizer.getMessage(item.messageKey);
      const button = document.createElement('button');
      button.type = 'button';
      // An icon alone is not read aloud, so the resolved message becomes the accessible name.
      button.setAttribute('aria-label', label);
      button.dataset.slot = item.slot;
      // Of the rebuilt items, only the first is made the item Tab stops on.
      button.tabIndex = buttons.size === 0 ? 0 : -1;
      button.append(createItemIcon(document, item.iconPath));
      this.ports.tooltip.registerTarget(button, label);
      buttons.set(item.slot, button);
    }

    this.element.replaceChildren(...buttons.values());
    this.slots = slots;
    this.buttons = buttons;
  }

  /**
   * Returns the rectangle of the current selection.
   *
   * @returns The rectangle of a selection that meets the display condition, or `undefined` when it does not.
   */
  private readSelectionRect(): FloatingMenuRect | undefined {
    const root = this.ports.readEditorRoot();
    if (root === undefined) {
      return undefined;
    }
    // If even one endpoint is outside the editor root, no range is returned, so the menu does not
    // follow selections outside the body.
    const range = readSelectionRange(root);
    if (range === undefined || range.collapsed) {
      return undefined;
    }
    const rect = range.getBoundingClientRect();
    return rect.width === 0 && rect.height === 0 ? undefined : rect;
  }

  /**
   * Places the component to match the selection rectangle.
   *
   * @param rect The selection rectangle.
   */
  private place(rect: FloatingMenuRect): void {
    const document = this.element.ownerDocument;
    const view = document.defaultView;
    if (view === null) {
      return;
    }
    // Exclude the fixed toolbar's strip from the placeable area. Overlapping it would make the
    // strip's items unpressable, blocking whichever of the two surfaces with the same operations is
    // always visible.
    const toolbar = document.getElementById(TOOLBAR_ELEMENT_ID)?.getBoundingClientRect();
    // The rendered size rather than offsetWidth, which rounds to whole pixels and would let the menu
    // overflow the right edge by a fraction of a pixel.
    const size = this.element.getBoundingClientRect();
    const position = readFloatingMenuPlacement(
      rect,
      { width: size.width, height: size.height },
      // The visible width, which excludes the vertical scrollbar. innerWidth includes it, so a menu pulled in to that
      // edge would end up under the scrollbar.
      { left: 0, top: toolbar?.bottom ?? 0, right: document.documentElement.clientWidth, bottom: view.innerHeight },
    );
    this.element.style.left = `${position.left}px`;
    this.element.style.top = `${position.top}px`;
  }
}

/**
 * Places the component, hidden, outside the editor root and attaches the press listeners.
 *
 * Called only once, on the first mount. Because it lives outside the editor root, it is not
 * recreated on document replacement.
 *
 * @param view The view's window.
 * @param ports Ports of the floating menu.
 * @returns The placed floating menu.
 */
export function attachFloatingMenu(view: Window, ports: FloatingMenuPorts): FloatingMenu {
  const element = view.document.createElement('div');
  element.id = FLOATING_MENU_ELEMENT_ID;
  element.hidden = true;
  // It has the same role as the fixed toolbar, so the two are told apart by a different name.
  element.setAttribute('role', 'toolbar');
  element.setAttribute('aria-label', ports.localizer.getMessage('floatingMenu.name'));

  // Pressing must not take focus away from the editor root. If it did, the selection the operation
  // applies to would already be lost. Attached in the capture phase so that it works even when an
  // inner element stops propagation.
  element.addEventListener('mousedown', (event) => event.preventDefault(), true);

  // Enter and Space from the keyboard also come through here, as the click raised by the button's
  // default press.
  element.addEventListener('click', (event) => {
    const target = event.target;
    const button = target instanceof Element ? target.closest('button[data-slot]') : null;
    if (button === null) {
      return;
    }
    // Look the attribute string up in the list so that it can be treated as a slot. Pressing does
    // not close the menu.
    const slot = FLOATING_MENU_SLOTS.find((candidate) => candidate === button.getAttribute('data-slot'));
    if (slot !== undefined) {
      ports.activateSlot(slot);
    }
  });

  // Placed inside the editor root, it would appear in the body output.
  view.document.body.append(element);
  const menu = new FloatingMenu(element, ports);
  view.document.addEventListener('focusin', (event) => menu.recordFocus(event));
  return menu;
}

/**
 * Returns the registered slots among those of the frequently used operations, in the same order as
 * the fixed toolbar.
 *
 * @param readItem Reads a registered item.
 * @returns The items to lay out. Unregistered slots are dropped.
 */
export function readFloatingMenuItems(
  readItem: (slot: ToolbarSlot) => RegisteredToolbarItem | undefined,
): readonly FloatingMenuItem[] {
  return FLOATING_MENU_SLOTS.flatMap((slot) => {
    const item = readItem(slot);
    return item === undefined
      ? []
      : [{ slot, messageKey: item.messageKey, iconPath: item.iconPath }];
  });
}

/**
 * Decides the placement coordinates from the selection rectangle.
 *
 * Horizontally it is pulled into the placeable area, but not vertically. Pulling it in vertically as
 * well would leave the menu alone stuck to the edge after the selection has scrolled off screen.
 *
 * @param selection The selection rectangle.
 * @param size The component's size.
 * @param area The placeable area.
 * @returns The placement coordinates.
 */
export function readFloatingMenuPlacement(
  selection: FloatingMenuRect,
  size: FloatingMenuSize,
  area: FloatingMenuRect,
): FloatingMenuPosition {
  const above = selection.top - size.height - SELECTION_GAP_PX;
  const top = above >= area.top ? above : selection.bottom + SELECTION_GAP_PX;

  const centered = (selection.left + selection.right) / 2 - size.width / 2;
  const left = Math.max(area.left, Math.min(centered, area.right - size.width));
  return { left, top };
}
