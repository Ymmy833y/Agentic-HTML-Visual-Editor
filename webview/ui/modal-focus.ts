/** The ports the modal focus receives from outside. Nothing is cached; they are read on every call. */
export interface ModalFocusPorts {
  /** Returns the editor root. `undefined` before mounting. */
  readEditorRoot(): HTMLElement | undefined;

  /** Whether the view has focus. */
  hasViewFocus(): boolean;
}

/** The direction in which Tab cycles. */
export type TabDirection = 'forward' | 'backward';

/** The open action dialog. */
interface OpenDialog {
  readonly element: HTMLElement;
  /**
   * The element that receives focus when the dialog opens. It also serves as the surface entry
   * when focus is returned to the dialog.
   */
  readonly first: HTMLElement;
}

/** One surface's trap scope and surface entry. */
interface Surface {
  readonly element: HTMLElement;
  readonly entry: HTMLElement;
}

/**
 * Treats the action dialog and an overlay with content as modal surfaces: moves focus to them,
 * traps Tab inside them, and returns focus to the return target when they close.
 *
 * An overlay with content is a surface above the action dialog. While an overlay reason remains the
 * dialog cannot be confirmed, so trapping focus in the dialog would leave discarding the input and
 * cancelling as the only way forward from the keyboard. A blank overlay occurs often during the save
 * round trip, so it is not treated as a surface and does not move focus. While the view does not
 * have focus, nothing is moved so as not to steal keystrokes from another editor; focus moves to the
 * surface once the view gains it. Exactly one is created per view, at startup. An overlay can go up
 * even before mounting.
 */
export class ModalFocus {
  private dialog: OpenDialog | undefined;

  private overlay: HTMLElement | undefined;

  // The element outside the editor root that had focus when a surface opened from a state with no
  // surfaces.
  private returnTarget: Element | undefined;

  /**
   * @param view The view's window.
   * @param ports The ports for the editor root and the view focus.
   */
  constructor(
    private readonly view: Window,
    private readonly ports: ModalFocusPorts,
  ) {
    // Listened to in the capture phase, so that focus is still trapped when an element inside the
    // surface stops propagation.
    view.document.addEventListener('keydown', (event) => this.handleKeyDown(event), true);
    view.addEventListener('focus', () => this.handleViewFocused());
  }

  /**
   * Just before the action dialog opens, records the return target if there are no surfaces.
   *
   * Called before focus moves. The editor root and anything inside it are not used as the return
   * target. The input stop controller returns focus to the editor root together with the selection,
   * so this keeps two mechanisms from moving the same element.
   */
  handleDialogOpening(): void {
    if (this.readTopSurface() !== undefined) {
      return;
    }
    this.returnTarget = this.readReturnTarget();
  }

  /**
   * Adds the action dialog as a surface, and moves focus to its first element if it is the top
   * surface.
   *
   * @param element The dialog element.
   * @param first The first input field (the confirm button for a confirmation).
   */
  handleDialogOpened(element: HTMLElement, first: HTMLElement): void {
    this.dialog = { element, first };
    if (this.overlay === undefined && this.ports.hasViewFocus()) {
      first.focus();
    }
  }

  /**
   * Removes the action dialog from the surfaces, and returns focus to the entry of the remaining
   * surface or to the return target.
   *
   * @param wasFocusedInside Whether focus was inside the dialog before it closed. Its contents are
   *   removed once it has closed, so the closing side reads this before removing them and passes it
   *   in.
   */
  handleDialogClosed(wasFocusedInside: boolean): void {
    this.dialog = undefined;
    const overlay = this.overlay;
    if (overlay === undefined) {
      this.returnToTarget();
      return;
    }
    if (wasFocusedInside && this.ports.hasViewFocus()) {
      overlay.focus();
    }
  }

  /**
   * On every render of the overlay, adds or removes the surface according to whether the content
   * appeared, was replaced or disappeared, and moves focus.
   *
   * Focus moves to the overlay itself rather than to an overlay action. An overlay can appear
   * asynchronously in the middle of typing, so moving focus to an action would let a following Space
   * or Enter press the button.
   *
   * @param overlay The element of an overlay with content. `undefined` for a blank overlay and for
   *   removal.
   * @param wasFocusedInside Whether focus was inside the overlay before the render.
   */
  handleOverlayRendered(overlay: HTMLElement | undefined, wasFocusedInside: boolean): void {
    if (overlay !== undefined) {
      const appeared = this.overlay === undefined;
      if (appeared && this.readTopSurface() === undefined) {
        this.returnTarget = this.readReturnTarget();
      }
      this.overlay = overlay;
      // A re-render rebuilds the elements inside and focus is lost, so if focus was inside, it is put
      // back on the overlay itself.
      if ((appeared || wasFocusedInside) && this.ports.hasViewFocus()) {
        overlay.focus();
      }
      return;
    }

    if (this.overlay === undefined) {
      return;
    }
    this.overlay = undefined;
    const dialog = this.dialog;
    if (dialog === undefined) {
      this.returnToTarget();
      return;
    }
    if (wasFocusedInside && this.ports.hasViewFocus()) {
      dialog.first.focus();
    }
  }

  /**
   * While a surface exists, traps Tab and Shift+Tab inside the top surface, wrapping from one end to
   * the other.
   *
   * A Tab that is taken over does not reach VS Code. A press during composition, and a press with
   * Ctrl, Alt or Meta, are left alone so as not to interfere with IME conversion in an input field or
   * with switching tabs in VS Code.
   *
   * @param event The key press.
   */
  handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    const surface = this.readTopSurface();
    if (surface === undefined) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();

    const active = this.view.document.activeElement;
    if (active === null || !surface.element.contains(active)) {
      // For example, after focus was moved to a lower surface with the pointer. Focus is returned to
      // the top surface.
      surface.entry.focus();
      return;
    }
    const target = readCycleTarget(
      readTabbableElements(surface.element),
      active,
      event.shiftKey ? 'backward' : 'forward',
    );
    target?.focus();
  }

  /**
   * When the view gains focus, moves focus that is outside the surfaces to the entry of the top
   * surface.
   */
  handleViewFocused(): void {
    const surface = this.readTopSurface();
    if (surface === undefined) {
      return;
    }
    const active = this.view.document.activeElement;
    if (active !== null && surface.element.contains(active)) {
      return;
    }
    surface.entry.focus();
  }

  /**
   * Returns the top surface: the overlay if there is one, otherwise the action dialog.
   *
   * @returns The top surface, or `undefined` when there are no surfaces.
   */
  private readTopSurface(): Surface | undefined {
    if (this.overlay !== undefined) {
      return { element: this.overlay, entry: this.overlay };
    }
    if (this.dialog !== undefined) {
      return { element: this.dialog.element, entry: this.dialog.first };
    }
    return undefined;
  }

  /**
   * Returns the currently focused element if it can serve as the return target.
   *
   * @returns An element outside the editor root. `undefined` for the editor root and anything inside
   *   it, and when nothing has focus.
   */
  private readReturnTarget(): Element | undefined {
    const document = this.view.document;
    const active = document.activeElement;
    if (active === null || active === document.body) {
      return undefined;
    }
    const root = this.ports.readEditorRoot();
    return root !== undefined && root.contains(active) ? undefined : active;
  }

  /**
   * When the last surface closes, returns focus to the return target if the view has focus. The
   * return target is discarded in every case.
   *
   * Does nothing when the return target has been removed from the document or cannot receive focus.
   */
  private returnToTarget(): void {
    const target = this.returnTarget;
    this.returnTarget = undefined;
    if (target === undefined || !target.isConnected || !this.ports.hasViewFocus()) {
      return;
    }
    if (target instanceof HTMLElement || target instanceof SVGElement) {
      target.focus();
    }
  }
}

/**
 * Collects the elements Tab cycles through inside a surface, in document order.
 *
 * @param surface The surface element.
 * @returns The elements whose tabindex is 0 or greater and that are neither disabled nor hidden. The
 *   surface itself is not included.
 */
export function readTabbableElements(surface: Element): HTMLElement[] {
  return [...surface.querySelectorAll('*')].filter(
    (element): element is HTMLElement => element instanceof HTMLElement
      && element.tabIndex >= 0
      && !element.matches(':disabled')
      && element.closest('[hidden]') === null,
  );
}

/**
 * Decides the next element from the list of tabbable elements and the direction, wrapping at the
 * ends.
 *
 * @param elements The tabbable elements.
 * @param current The currently focused element.
 * @param direction `forward` for Tab, `backward` for Shift+Tab.
 * @returns The next element. From an element not in the list, the first for Tab and the last for
 *   Shift+Tab. `undefined` when the list is empty.
 */
export function readCycleTarget(
  elements: readonly HTMLElement[],
  current: Element | null,
  direction: TabDirection,
): HTMLElement | undefined {
  if (elements.length === 0) {
    return undefined;
  }
  const index = elements.findIndex((element) => element === current);
  if (index === -1) {
    return direction === 'forward' ? elements[0] : elements[elements.length - 1];
  }
  const step = direction === 'forward' ? 1 : -1;
  return elements[(index + step + elements.length) % elements.length];
}
