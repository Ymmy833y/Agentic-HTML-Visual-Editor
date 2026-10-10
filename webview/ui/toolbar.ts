import { EDITOR_ROOT_ELEMENT_ID } from '../../common/index';
import type { Localizer, MessageKey } from '../../common/index';
import { TOOLBAR_SLOT_GROUPS } from './toolbar-slots';
import type { ToolbarSlot } from './toolbar-slots';
import type { ToolbarActivation, ToolbarActivationTarget, ToolbarPopupClosure } from './toolbar-activation';
import type { TooltipController } from './tooltip';

/** The ID of the toolbar element. Kept identical to the spelling in the stylesheet. */
export const TOOLBAR_ELEMENT_ID = 'editor-toolbar';

// Icons are built with `createElementNS`, so the namespace is spelled out here exactly once.
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** The class put on the indicator mark. Kept identical to the spelling in the stylesheet. */
const INDICATOR_CLASS = 'toolbar-indicator';

// Class of the element that holds the item label. Kept in line with the stylesheet's spelling.
const LABEL_CLASS = 'toolbar-label';

/** An item that runs the registrant's operation when pressed. */
export interface ToolbarButtonItem {
  readonly kind: 'button';
  /** The message key used for the accessible name and the tooltip. */
  readonly messageKey: MessageKey;
  /** The icon path, drawn in a 24×24 view box. */
  readonly iconPath: string;
  /**
   * The message key read as the item's description while the indicator is shown. The indicator of
   * an item that leaves this out has no description.
   */
  readonly indicatorDescriptionKey?: MessageKey;
  /** The operation called on press. */
  run(): void;
}

/**
 * The popup kind of a popup item.
 *
 * The values use the same spelling as the values of aria-haspopup. Different spellings would require a
 * translation table.
 */
export type ToolbarPopupKind = 'menu' | 'dialog';

/** An item that opens its contents when pressed. */
export interface ToolbarPopupItem {
  readonly kind: 'popup';
  /** The message key used for the accessible name and the tooltip. */
  readonly messageKey: MessageKey;
  /** The icon path, drawn in a 24×24 view box. */
  readonly iconPath: string;
  /**
   * The message key read as the item's description while the indicator is shown. The indicator of
   * an item that leaves this out has no description.
   */
  readonly indicatorDescriptionKey?: MessageKey;
  /**
   * The popup kind. Defaults to menu when left out.
   *
   * Assistive technology is told that the item has a popup of this kind. Announcing popup contents that
   * are not a menu as a menu would mislead the user about which keys work inside.
   */
  readonly popupKind?: ToolbarPopupKind;
  /**
   * Builds and places the popup contents, then returns that element.
   *
   * The operations inside the popup are also called through the toolbar activation. If the owner of
   * the contents called them directly, the input stop and composition checks would not apply to
   * them.
   *
   * @param container The item's container. A press outside the element placed here closes the popup.
   */
  buildPopup(container: HTMLElement): HTMLElement;
  /**
   * The receiver of the closed notification (optional). It only receives the popup closure and has no
   * say in whether the popup closes.
   *
   * Must not throw. It is called partway through the closing path, so throwing would stop the cleanup
   * after closing.
   *
   * @param closure The popup closure.
   */
  handleClosed?(closure: ToolbarPopupClosure): void;
}

/** The value carried by a single registration. */
export type ToolbarItem = ToolbarButtonItem | ToolbarPopupItem;

/** The state of an item. A field left out keeps its previous value. */
export interface ToolbarItemState {
  /** Whether the item is pressed. */
  readonly pressed?: boolean;
  /** Whether the item is disabled. */
  readonly disabled?: boolean;
  /** Whether to show the indicator. */
  readonly indicator?: boolean;
  /**
   * The item label. `null` restores the label given at registration.
   *
   * The accessible name and the tooltip are left unchanged. Mixing the current value into the
   * accessible name would deliver the operation's name and the current value to assistive
   * technology as a single, indistinguishable string.
   */
  readonly label?: string | null;
  /**
   * The icon path, drawn in a 24×24 view box. `null` restores the icon given at registration.
   *
   * The accessible name and the tooltip are left unchanged. The icon is hidden from assistive
   * technology, so replacing it changes only what the item looks like.
   */
  readonly iconPath?: string | null;
}

/**
 * A registered toolbar item exposed to the outside.
 *
 * Excludes the operation and the popup contents. Including them would create a second definition
 * of an entry point for the same operation.
 */
export interface RegisteredToolbarItem {
  /** The item's kind. */
  readonly kind: ToolbarItem['kind'];
  /** Message key used for the accessible name and the tooltip. */
  readonly messageKey: MessageKey;
  /** Icon path drawn in a 24×24 view box. */
  readonly iconPath: string;
}

/** The ports the toolbar takes from outside. */
interface ToolbarPorts {
  readonly localizer: Localizer;
  readonly activation: ToolbarActivation;
  readonly tooltip: TooltipController;
}

/** One registered item. */
interface RegisteredItem {
  readonly slot: ToolbarSlot;
  readonly item: ToolbarItem;
  readonly container: HTMLElement;
  readonly button: HTMLButtonElement;
  /** The message resolved at registration. A replaced item label is restored to this. */
  readonly label: string;
  /**
   * The indicator description resolved at registration. `undefined` for an item without the key.
   */
  readonly indicatorDescription: string | undefined;
  state: ToolbarItemState;
}

/**
 * The fixed toolbar placed outside the editor root.
 *
 * Exactly one is created per view, and it is the only thing that decides the order. Items are put
 * into the slot order rather than the order in which they were registered.
 */
export class Toolbar {
  private readonly entries = new Map<ToolbarSlot, RegisteredItem>();

  /**
   * @param element The toolbar element.
   * @param ports The ports for message resolution, activation and tooltips.
   */
  constructor(
    private readonly element: HTMLElement,
    private readonly ports: ToolbarPorts,
  ) {}

  /**
   * Registers an item into a slot.
   *
   * @param slot The slot.
   * @param item The item to register.
   * @returns Whether the registration succeeded. Re-registering into an occupied slot is refused.
   */
  register(slot: ToolbarSlot, item: ToolbarItem): boolean {
    if (this.entries.has(slot)) {
      return false;
    }

    const document = this.element.ownerDocument;
    const label = this.ports.localizer.getMessage(item.messageKey);

    const button = document.createElement('button');
    button.type = 'button';
    // An icon alone is not announced, so the resolved message becomes the accessible name.
    button.setAttribute('aria-label', label);
    button.append(createItemIcon(document, item.iconPath));

    // Tab stops on only one item in the item bar. Whether registered before or after attaching, an
    // existing stop is not moved.
    const hasStop = [...this.entries.values()].some((entry) => entry.button.getAttribute('tabindex') === '0');
    button.tabIndex = hasStop ? -1 : 0;

    if (item.kind === 'popup') {
      // A registration that passes no popup kind is announced as having a menu, as before.
      button.setAttribute('aria-haspopup', item.popupKind ?? 'menu');
      button.setAttribute('aria-expanded', 'false');
    }

    const container = document.createElement('div');
    container.dataset.slot = slot;
    container.append(button);

    const indicatorDescription = item.indicatorDescriptionKey === undefined
      ? undefined
      : this.ports.localizer.getMessage(item.indicatorDescriptionKey);
    const entry: RegisteredItem = { slot, item, container, button, label, indicatorDescription, state: {} };
    this.entries.set(slot, entry);

    // Button presses and slot activations from outside take the same path. Splitting them would let
    // an added check land on only one side.
    // Enter and Space from the keyboard also come through here, as the click raised by the button's
    // default press.
    button.addEventListener('click', () => {
      this.activateSlot(slot);
    });

    this.ports.tooltip.registerTarget(button, label);
    this.render();
    return true;
  }

  /**
   * Updates the state of a registered item. An empty slot does nothing.
   *
   * @param slot The slot.
   * @param state The state to update. A field left out keeps its previous value.
   */
  updateItemState(slot: ToolbarSlot, state: ToolbarItemState): void {
    const entry = this.entries.get(slot);
    if (entry === undefined) {
      return;
    }

    entry.state = { ...entry.state, ...state };
    const button = entry.button;

    applyPressedAttributes(button, entry.state.pressed);
    // Disabled is not expressed with `disabled`, so that the tooltip can still be shown while the
    // pointer rests on a disabled item.
    button.setAttribute('aria-disabled', String(entry.state.disabled === true));
    button.toggleAttribute('data-disabled', entry.state.disabled === true);

    // No element is created for an item that has never been given a label. Creating one would leave
    // an empty gap beside the icon.
    const label = entry.state.label;
    if (label !== undefined) {
      readOrCreateLabel(entry).textContent = label ?? entry.label;
    }

    // Only an update that names the icon redraws it. An update that leaves it out, such as a pressed
    // state change, keeps whatever icon is drawn now.
    if (state.iconPath !== undefined) {
      button.querySelector(':scope > svg')?.replaceWith(
        createItemIcon(button.ownerDocument, state.iconPath ?? entry.item.iconPath),
      );
    }

    // The popup contents also live in the container, so only its direct children are examined.
    const indicator = entry.container.querySelector(`:scope > .${INDICATOR_CLASS}`);
    if (entry.state.indicator === true) {
      if (indicator === null) {
        // The presence of the dot itself carries the meaning. Only changing a color would not be
        // distinguishable in a high contrast theme.
        const mark = button.ownerDocument.createElement('span');
        mark.className = INDICATOR_CLASS;
        mark.setAttribute('aria-hidden', 'true');
        entry.container.append(mark);
      }
    } else {
      indicator?.remove();
    }

    updateDescription(entry);
  }

  /**
   * Returns the buttons of the registered items in slot order.
   *
   * Popup contents, separators and indicators are not included. Moves within the item bar count in
   * this order.
   *
   * @returns The item buttons.
   */
  readButtons(): HTMLButtonElement[] {
    return TOOLBAR_SLOT_GROUPS.flat().flatMap((slot) => {
      const entry = this.entries.get(slot);
      return entry === undefined ? [] : [entry.button];
    });
  }

  /**
   * Returns the button of the item in the slot.
   *
   * @param slot The slot.
   * @returns The item's button, or `undefined` if not registered.
   */
  readButton(slot: ToolbarSlot): HTMLButtonElement | undefined {
    return this.entries.get(slot)?.button;
  }

  /**
   * Reflects on the item that its popup has opened, and gives the contents the same name as the
   * item. Does nothing for an unregistered slot.
   *
   * @param slot The slot of the opened item.
   * @param contents The element of the opened contents.
   */
  handlePopupOpened(slot: ToolbarSlot, contents: HTMLElement): void {
    const entry = this.entries.get(slot);
    if (entry === undefined) {
      return;
    }
    entry.button.setAttribute('aria-expanded', 'true');
    contents.setAttribute('aria-label', entry.label);
  }

  /**
   * Reflects on the item that its popup has closed. Does nothing for an unregistered slot.
   *
   * After reflecting the closed state on the item, hands the popup closure to the owner of that item's
   * popup contents. From the popup closure, the owner decides whether to return to the editor root when
   * the popup closed with focus still inside.
   *
   * @param slot The slot of the closed item.
   * @param closure The popup closure.
   */
  handlePopupClosed(slot: ToolbarSlot, closure: ToolbarPopupClosure): void {
    const entry = this.entries.get(slot);
    if (entry === undefined) {
      return;
    }
    entry.button.setAttribute('aria-expanded', 'false');
    if (entry.item.kind === 'popup') {
      entry.item.handleClosed?.(closure);
    }
  }

  /**
   * Returns the registered toolbar item.
   *
   * Reads the current registration on every call. Keeping a copy of the value would hide items
   * registered later.
   *
   * @param slot The slot.
   * @returns The registered toolbar item, or `undefined` if not registered.
   */
  readItem(slot: ToolbarSlot): RegisteredToolbarItem | undefined {
    const entry = this.entries.get(slot);
    if (entry === undefined) {
      return undefined;
    }
    const item = entry.item;
    return { kind: item.kind, messageKey: item.messageKey, iconPath: item.iconPath };
  }

  /**
   * Returns a copy of the current display state, without exposing the item's operation or mutable stored state.
   *
   * @param slot The slot to query.
   * @returns The state, or `undefined` for an unregistered slot.
   */
  readItemState(slot: ToolbarSlot): ToolbarItemState | undefined {
    const entry = this.entries.get(slot);
    return entry === undefined ? undefined : { ...entry.state };
  }

  /**
   * Activates the item in the given slot. Does nothing for an unregistered slot.
   *
   * The toolbar activation checks input stop, disabled, and composition. Adding checks here would
   * make it diverge from a button press.
   *
   * @param slot The slot to activate.
   */
  activateSlot(slot: ToolbarSlot): void {
    const entry = this.entries.get(slot);
    if (entry === undefined) {
      return;
    }
    this.ports.activation.activateItem(slot, toActivationTarget(entry));
  }

  /** Lays the registered items and the separators out again in the slot order. */
  private render(): void {
    const children: Element[] = [];
    for (const group of TOOLBAR_SLOT_GROUPS) {
      const containers = group.flatMap((slot) => {
        const entry = this.entries.get(slot);
        return entry === undefined ? [] : [entry.container];
      });
      if (containers.length === 0) {
        // A group with no registrations gets no separator, or a line would be left standing where
        // there is no operation.
        continue;
      }
      if (children.length > 0) {
        children.push(createSeparator(this.element.ownerDocument));
      }
      children.push(...containers);
    }
    this.element.replaceChildren(...children);
  }
}

/**
 * Creates the toolbar element and attaches it immediately before the editor root.
 *
 * This is called only when the mount succeeded. An unopenable document has no editor root, so
 * nothing is attached for it.
 *
 * @param view The view's window.
 * @param localizer The localizer.
 * @param activation The toolbar activation.
 * @param tooltip The tooltip controller.
 * @returns The attached toolbar, or `undefined` when there is no editor root.
 */
export function attachToolbar(
  view: Window,
  localizer: Localizer,
  activation: ToolbarActivation,
  tooltip: TooltipController,
): Toolbar | undefined {
  const root = view.document.getElementById(EDITOR_ROOT_ELEMENT_ID);
  if (root === null) {
    return undefined;
  }

  const element = view.document.createElement('div');
  element.id = TOOLBAR_ELEMENT_ID;
  element.setAttribute('role', 'toolbar');
  // The floating menu has the same role, so the two are told apart by name.
  element.setAttribute('aria-label', localizer.getMessage('toolbar.name'));

  // Keeps a press from moving focus off the editor root; once focus is lost, an operation can no
  // longer be run against the selection. The strip spans the full width, so binding this per button
  // would leave the padding, the separators and the space to the right of the last item uncovered,
  // and an item pressed after one of those would run against a selection that is already gone. The
  // listener is bound in the capture phase so that it still takes effect when an element inside
  // stops propagation.
  element.addEventListener('mousedown', (event) => {
    // An input field in popup contents cannot take a value unless the press moves focus to it, so the
    // default is not stopped. Only popup contents put input fields in the strip; presses on items,
    // padding and separators are still stopped as before.
    if (event.target instanceof HTMLInputElement) {
      return;
    }
    event.preventDefault();
  }, true);

  // Placed outside the editor root. Inside it, the toolbar would appear in the output.
  root.before(element);
  return new Toolbar(element, { localizer, activation, tooltip });
}

/**
 * Expresses the pressed state with attributes and a marker.
 *
 * The fixed toolbar and the floating menu use the same procedure. If only one of them changed the
 * spelling, the same state would look different on the two surfaces. A button that was not given a
 * pressed state gets no `aria-pressed`; adding it would make a one-off operation such as save be
 * read aloud as a toggle button.
 *
 * @param button The target button.
 * @param pressed Whether it is pressed. Unspecified when omitted.
 */
export function applyPressedAttributes(button: HTMLButtonElement, pressed: boolean | undefined): void {
  if (pressed !== undefined) {
    button.setAttribute('aria-pressed', String(pressed));
  }
  // High-contrast themes erase background color differences, so color alone is not used to distinguish it.
  button.toggleAttribute('data-pressed', pressed === true);
}

/**
 * Returns the element that holds the item label, creating and placing it if absent.
 *
 * @param entry The registered item.
 * @returns The element that holds the label.
 */
function readOrCreateLabel(entry: RegisteredItem): HTMLElement {
  const existing = entry.button.querySelector(`:scope > .${LABEL_CLASS}`);
  if (existing instanceof HTMLElement) {
    return existing;
  }
  const label = entry.button.ownerDocument.createElement('span');
  label.className = LABEL_CLASS;
  // Serves as the reference target when the replaced item label is associated as a description.
  label.id = `${TOOLBAR_ELEMENT_ID}-${entry.slot}-label`;
  // The button holds the accessible name. Mixing the label into what is read aloud would read the
  // operation's name twice.
  label.setAttribute('aria-hidden', 'true');
  entry.button.append(label);
  return label;
}

/**
 * Associates the indicator and the replaced item label with the item as its description. Anything
 * no longer present is removed from the association.
 *
 * Mixing the current value into the name would leave assistive technology unable to tell the
 * operation's name from the current value, so the name stays the message given at registration and
 * the current state is conveyed as the description.
 *
 * @param entry The registered item.
 */
function updateDescription(entry: RegisteredItem): void {
  const ids: string[] = [];

  const indicatorId = `${TOOLBAR_ELEMENT_ID}-${entry.slot}-indicator`;
  const existing = [...entry.container.children].find((child) => child.id === indicatorId);
  if (entry.state.indicator === true && entry.indicatorDescription !== undefined) {
    if (existing === undefined) {
      const description = entry.container.ownerDocument.createElement('span');
      description.id = indicatorId;
      // Used only as the reference target of the description; it appears neither on screen nor in
      // the reading flow.
      description.hidden = true;
      description.textContent = entry.indicatorDescription;
      entry.container.append(description);
    }
    ids.push(indicatorId);
  } else {
    existing?.remove();
  }

  // The item label element stays hidden from reading and is used only as the reference target of the
  // description. Once restored with null, it is no longer associated.
  if (typeof entry.state.label === 'string') {
    ids.push(readOrCreateLabel(entry).id);
  }

  if (ids.length === 0) {
    entry.button.removeAttribute('aria-describedby');
    return;
  }
  entry.button.setAttribute('aria-describedby', ids.join(' '));
}

/**
 * Builds the icon element from the given path.
 *
 * Icons are built here rather than taken from a library, so as not to add a runtime dependency.
 * They are built with `createElementNS` instead of being injected as an HTML string.
 *
 * @param document The view's document.
 * @param path The path drawn in a 24×24 view box.
 * @returns The icon's `svg` element.
 */
export function createItemIcon(document: Document, path: string): SVGSVGElement {
  const icon = document.createElementNS(SVG_NAMESPACE, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('width', '24');
  icon.setAttribute('height', '24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.5');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  // The button carries the accessible name, so the icon is kept out of the announcement.
  icon.setAttribute('aria-hidden', 'true');

  const shape = document.createElementNS(SVG_NAMESPACE, 'path');
  shape.setAttribute('d', path);
  icon.append(shape);
  return icon;
}

/**
 * Creates the separator placed between groups.
 *
 * @param document The view's document.
 */
function createSeparator(document: Document): HTMLElement {
  const separator = document.createElement('span');
  separator.className = 'toolbar-separator';
  separator.setAttribute('role', 'separator');
  return separator;
}

/**
 * Takes from a registered item only the values needed to decide a single press.
 *
 * @param entry The registered item.
 */
function toActivationTarget(entry: RegisteredItem): ToolbarActivationTarget {
  const disabled = entry.state.disabled === true;
  if (entry.item.kind === 'popup') {
    const item = entry.item;
    return { kind: 'popup', disabled, openPopup: () => item.buildPopup(entry.container) };
  }
  const item = entry.item;
  return { kind: 'button', disabled, run: () => item.run() };
}
