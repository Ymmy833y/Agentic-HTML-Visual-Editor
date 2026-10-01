import type { ToolbarSlot } from './toolbar-slots';

/**
 * The popup closure: what closed the popup, and whether focus was inside the popup contents right
 * before it closed.
 *
 * The closing path decides the trigger, and receivers only read it. If a receiver guessed the
 * trigger, it would repeat, after closing, the return to the editor root already done right before
 * running.
 */
export interface ToolbarPopupClosure {
  /**
   * What closed the popup: running an action inside, Esc, or anything else (a press outside,
   * pressing the item again, or a call from outside).
   */
  readonly trigger: 'run' | 'escape' | 'other';
  /** Whether focus was inside the popup contents right before closing. */
  readonly focusedInside: boolean;
}

/**
 * The port that reads the state at the moment of a press. Nothing is cached; it is read on every
 * press.
 */
export interface ToolbarActivationPorts {
  /** Whether at least one input stop reason remains. */
  isInputStopped(): boolean;

  /** Whether an IME composition is in progress at the moment of the call. */
  isComposing(): boolean;

  /**
   * Notifies synchronously after the popup has been opened and its reference retained. The receiver
   * does not let exceptions escape.
   *
   * @param slot The slot of the opened item.
   * @param contents The element of the placed contents.
   */
  notifyPopupOpened(slot: ToolbarSlot, contents: HTMLElement): void;

  /**
   * Notifies synchronously after the popup element has been removed. The receiver does not let
   * exceptions escape.
   *
   * @param slot The slot of the closed item.
   * @param closure The popup closure. A receiver that does not use it can be passed as is, in a
   *   form that takes no such parameter.
   */
  notifyPopupClosed(slot: ToolbarSlot, closure: ToolbarPopupClosure): void;

  /**
   * Notifies synchronously just before an operation is called. The receiver does not let exceptions
   * escape.
   *
   * @param focusedAtPress The focus at the moment of the press. For an operation inside a popup, it
   *   is read before the popup closes.
   */
  notifyBeforeRun(focusedAtPress: Element | null): void;
}

/** The pressed button, carrying only the values needed to decide a single press. */
export interface ToolbarActivationButton {
  readonly kind: 'button';
  /** Whether the item is disabled at the moment of the press. */
  readonly disabled: boolean;
  /** The registrant's operation. */
  run(): void;
}

/** The pressed popup item, carrying only the values needed to decide a single press. */
export interface ToolbarActivationPopup {
  readonly kind: 'popup';
  /** Whether the item is disabled at the moment of the press. */
  readonly disabled: boolean;
  /**
   * Builds and places the popup contents, then returns that element.
   *
   * The owner of the contents decides their appearance and layout. The toolbar activation holds
   * only the single reference to what is open, and removes it when closing.
   */
  openPopup(): HTMLElement;
}

/**
 * The activation target, defining only the values needed to decide a single press.
 *
 * It carries neither the message nor the icon. Including them would tie it to the shape of a
 * registration and create a cycle with the toolbar.
 */
export type ToolbarActivationTarget = ToolbarActivationButton | ToolbarActivationPopup;

/** A reference to the open popup. */
interface OpenPopup {
  readonly slot: ToolbarSlot;
  readonly element: HTMLElement;
}

/**
 * Connects a press on a toolbar item to the registrant's operation, through the checks for input
 * stop, disabled, composition and whether a popup is open.
 *
 * Exactly one is created per view. The subscriptions for Esc and for presses outside are bound only
 * while a popup is open. Keeping them bound while none is open would make this controller receive
 * every press and key event in the view.
 *
 * The appearance and layout of the contents belong to their owner, but keeping the editor root
 * focused on a press inside them is taken on here, because this is what calls those operations.
 *
 * The horizontal position of the contents is also placed inside the view here. The owner only hangs the contents
 * right below the item, so for an item near the right edge they would run off the screen; placing them here applies
 * the same rule to every popup. Changes in the view width are subscribed to only while a popup is open, like Esc and
 * presses outside.
 */
export class ToolbarActivation {
  private open: OpenPopup | undefined;

  // The last keystroke that closed a popup with Escape. When the same keystroke later reaches the receiver of the
  // editor root, this tells it that the keystroke was used for closing, so that one Escape closes only the topmost
  // thing.
  private closedByEscape: KeyboardEvent | undefined;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') {
      return;
    }
    const target = event.target;
    if (event.isComposing && target instanceof Node && this.open?.element.contains(target) === true) {
      // Esc during composition in an input field of the popup contents cancels the conversion, and
      // closing would lose the value being typed. Esc during composition in the editor root still
      // closes, as before.
      return;
    }
    // Recorded before closing, so that listeners of the close notification get the same answer when they query.
    this.closedByEscape = event;
    this.closePopup('escape');
  };

  private readonly onMouseDown = (event: Event): void => {
    // An input field in the popup contents cannot take a value unless the press moves focus to it,
    // so the default is not stopped.
    if (event.target instanceof HTMLInputElement) {
      return;
    }
    event.preventDefault();
  };

  private readonly onPointerDown = (event: Event): void => {
    const open = this.open;
    if (open === undefined) {
      return;
    }
    // The button that opened the popup sits in the same container as the popup. Not closing on a
    // press inside that container avoids the mix-up where pressing the same button again closes it
    // here and the press handler then opens it right back up.
    const container = open.element.parentElement ?? open.element;
    const target = event.target;
    if (target instanceof Node && container.contains(target)) {
      return;
    }
    this.closePopup();
  };

  // A change in the view width changes the strip's wrapping and the visible width, so the position placed on opening
  // no longer fits. It is measured again.
  private readonly onResize = (): void => {
    const open = this.open;
    if (open === undefined) {
      return;
    }
    this.placeInsideView(open.element);
  };

  /**
   * @param view The view's window.
   * @param ports The port that reads the input stop and the composition state.
   */
  constructor(
    private readonly view: Window,
    private readonly ports: ToolbarActivationPorts,
  ) {}

  /**
   * Activates one pressed item.
   *
   * While input is stopped, and for a disabled item, an open popup is left open. Folding the popup
   * away merely because an overlay went up would make a list that was open disappear on every
   * autosave.
   *
   * @param slot The slot that was pressed.
   * @param target The pressed item.
   */
  activateItem(slot: ToolbarSlot, target: ToolbarActivationTarget): void {
    if (this.ports.isInputStopped() || target.disabled) {
      return;
    }

    if (target.kind === 'popup') {
      const wasOpen = this.open?.slot === slot;
      this.closePopup();
      if (wasOpen) {
        return;
      }
      const contents = target.openPopup();
      this.placeInsideView(contents);
      this.retain(slot, contents);
      this.ports.notifyPopupOpened(slot, contents);
      return;
    }

    if (this.ports.isComposing()) {
      // Operations are called with the editor root still focused, so calling one mid-composition
      // would let the registrant rewrite the tree that is being composed. Committing the
      // composition and pressing again runs it.
      return;
    }

    // The registrant's operations are called on the premise that the editor root has focus. Even when
    // an item has focus from the keyboard, the receiver is notified so that it can return focus to
    // the editor root just before the call.
    this.ports.notifyBeforeRun(this.view.document.activeElement);

    // Exceptions are let through rather than swallowed. Swallowing one would keep it from reaching
    // the diagnostics along the registrant's own path.
    target.run();
  }

  /**
   * Calls an operation inside the open popup through the same checks as a button.
   *
   * @param run The operation inside the popup.
   */
  activatePopupAction(run: () => void): void {
    if (this.ports.isInputStopped() || this.ports.isComposing()) {
      return;
    }

    // Closing removes the items inside and focus is lost, so the focus at the moment of the press is
    // read before closing.
    const focusedAtPress = this.view.document.activeElement;
    // Closed before calling, so that the reference is already updated even if the operation throws.
    this.closePopup('run');
    this.ports.notifyBeforeRun(focusedAtPress);
    run();
  }

  /**
   * Closes the open popup. Does nothing when none is open.
   *
   * @param trigger What closed the popup. Left out for a press outside, pressing the item again, or
   *   a call from outside, which passes it as anything else.
   */
  closePopup(trigger: ToolbarPopupClosure['trigger'] = 'other'): void {
    const open = this.open;
    if (open === undefined) {
      return;
    }

    // Removing the element also removes focus, so whether it was inside is read before removing.
    const active = this.view.document.activeElement;
    const focusedInside = active !== null && open.element.contains(active);
    this.open = undefined;
    open.element.remove();
    this.view.document.removeEventListener('keydown', this.onKeyDown, true);
    this.view.document.removeEventListener('pointerdown', this.onPointerDown, true);
    this.view.removeEventListener('resize', this.onResize);
    this.ports.notifyPopupClosed(open.slot, { trigger, focusedInside });
  }

  /**
   * Returns whether the keystroke closed a popup with Escape.
   *
   * Compares by keystroke identity. Comparing by key value would also report a different Escape pressed after closing
   * as used for closing.
   *
   * @param event The keystroke.
   * @returns `true` if that keystroke closed a popup with Escape. `false` when the popup was closed by an outside
   *   press, by running an item or by an external call, and for keystrokes that closed nothing.
   */
  wasClosedBy(event: KeyboardEvent): boolean {
    return this.closedByEscape === event;
  }

  /**
   * Retains the opened popup and subscribes to the triggers that close it.
   *
   * @param slot The slot of the item that was opened.
   * @param element The element placed by the owner of the contents.
   */
  private retain(slot: ToolbarSlot, element: HTMLElement): void {
    this.open = { slot, element };

    // Keeps the editor root focused on a press inside the popup as well. Leaving this to each owner
    // of the contents would mean that forgetting it breaks nothing visibly, while the operation
    // runs at a position whose selection is already gone. The listener is bound in the capture
    // phase so that it still takes effect when the contents stop propagation. Closing removes the
    // element itself, so the subscription needs no removal.
    element.addEventListener('mousedown', this.onMouseDown, true);
    this.view.document.addEventListener('keydown', this.onKeyDown, true);
    this.view.document.addEventListener('pointerdown', this.onPointerDown, true);
    this.view.addEventListener('resize', this.onResize);
  }

  /**
   * Shifts the opened contents left just far enough not to run past the right edge of the visible width.
   *
   * They never go past the left edge of the view; contents wider than the view show their start. The visible width
   * excludes what the vertical scrollbar hides. The vertical position is left as the owner placed it.
   *
   * @param element The opened contents.
   */
  private placeInsideView(element: HTMLElement): void {
    // Clear any earlier placement and measure again from where the owner put the contents.
    element.style.removeProperty('left');
    const bounds = element.getBoundingClientRect();
    // Shift by whole pixels. A fractional remainder could leave the right edge just past the visible width and bring
    // up a horizontal scrollbar.
    const shift = Math.min(
      Math.ceil(bounds.right - this.view.document.documentElement.clientWidth),
      Math.floor(bounds.left),
    );
    if (shift <= 0) {
      return;
    }
    const left = Number.parseFloat(this.view.getComputedStyle(element).left);
    element.style.left = `${(Number.isNaN(left) ? 0 : left) - shift}px`;
  }
}
