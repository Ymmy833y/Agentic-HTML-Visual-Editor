import type { EncodedSelection } from '../../common/index';
import { captureSelection } from '../selection/selection-capture';
import { restoreSelection } from '../selection/selection-restore';

/** The ports the editor return receives from outside. Nothing is cached; they are read on every call. */
export interface EditorReturnPorts {
  /** Returns the editor root. `undefined` before mounting. */
  readEditorRoot(): HTMLElement | undefined;

  /** Whether the editor root is editable. False while at least one input stop reason remains. */
  isEditable(): boolean;

  /** Whether the view has focus. */
  hasViewFocus(): boolean;

  /**
   * Returns whether the node is inside an item bar, including popup contents.
   *
   * @param node The node to check.
   */
  isInItemBar(node: Node | null): boolean;

  /**
   * Returns whether the node is inside the search panel.
   *
   * Used only as a condition for returning just before running an operation. Not used for capturing when focus
   * leaves the editor root or for restoring when it enters. The search panel captures and restores its own return
   * selection.
   *
   * @param node The target node.
   */
  isInSearchPanel(node: Node | null): boolean;

  /**
   * Returns whether the node is inside the sidebar.
   *
   * Used only as a condition for returning just before running an operation, in the same way as the search panel.
   *
   * @param node The target node.
   */
  isInSidebar(node: Node | null): boolean;

  /** Moves focus to the stop of the fixed toolbar. */
  focusToolbarStop(): void;
}

/** A deferred return. One without a selection to restore returns focus only. */
interface DeferredReturn {
  readonly selection: EncodedSelection | undefined;
}

/**
 * Returns focus and the selection to the editor root from an item bar or a popup, and at the
 * request of later UI components.
 *
 * Whether the selection survives while focus is in an item bar depends on the browser, so the
 * selection to restore is captured at the moment focus leaves the editor root. While the view does
 * not have focus, the return is deferred so as not to steal keystrokes from another editor, and it
 * is carried out once it becomes possible. Exactly one is created per view, at startup.
 */
export class EditorReturn {
  // The selection at the moment focus left the editor root for an item bar.
  private captured: EncodedSelection | undefined;

  private deferred: DeferredReturn | undefined;

  // Set while this object itself is returning focus. A focusin during that time neither returns
  // focus again nor discards the captured selection.
  private returning = false;

  /**
   * @param view The view's window.
   * @param ports The ports for the editor root, whether it is editable, the view focus, whether a
   *   node is inside an item bar, and moving to the stop.
   */
  constructor(
    private readonly view: Window,
    private readonly ports: EditorReturnPorts,
  ) {
    view.addEventListener('focus', () => this.handleViewFocused());
  }

  /**
   * Subscribes to focus entering and leaving the editor root, and to pointer presses on it.
   *
   * Called once, on the first mount. The editor root stays the same element across document
   * replacements.
   *
   * @param root The editor root.
   */
  attach(root: HTMLElement): void {
    root.addEventListener('focusout', (event) => this.handleEditorFocusOut(event));
    root.addEventListener('focusin', (event) => this.handleEditorFocusIn(event));
    root.addEventListener('pointerdown', () => this.handleEditorPointerDown());
  }

  /**
   * Captures the selection at the moment of leaving when focus is moving into an item bar.
   *
   * Nothing is captured when focus leaves for a dialog or for outside the view; returning to the
   * editor root from there is handled by a different mechanism. When focus leaves during an IME
   * composition, this event arrives after the focus move has committed the composition, so the
   * selection after the commit is captured.
   *
   * @param event The focusout on the editor root.
   */
  handleEditorFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !this.ports.isInItemBar(next)) {
      return;
    }
    const root = this.ports.readEditorRoot();
    if (root === undefined) {
      return;
    }
    this.captured = captureSelection(root)?.selection;
  }

  /**
   * Restores the captured selection when focus entered from an item bar by the default focus
   * movement, and otherwise discards it without restoring. The deferred return is discarded either
   * way.
   *
   * @param event The focusin on the editor root.
   */
  handleEditorFocusIn(event: FocusEvent): void {
    if (this.returning) {
      return;
    }
    const captured = this.captured;
    this.captured = undefined;
    this.deferred = undefined;

    const previous = event.relatedTarget;
    if (captured === undefined || !(previous instanceof Node) || !this.isFromItemBar(previous)) {
      return;
    }
    const root = this.ports.readEditorRoot();
    if (root !== undefined) {
      restoreSelection(root, captured);
    }
  }

  /**
   * Entering by pointer cannot be told apart from the default focus movement by the previous
   * element alone, so the captured selection is discarded at the moment of the press. The
   * selection placed where the pointer was pressed is not overwritten with the captured one.
   */
  handleEditorPointerDown(): void {
    this.captured = undefined;
  }

  /**
   * When editable, returns focus to the editor root, and restores and discards the captured
   * selection if there is one.
   *
   * Does nothing while not editable or while the view does not have focus. Without a captured
   * selection, the selection is left untouched.
   */
  returnToEditor(): void {
    this.returnWith(this.captured);
  }

  /**
   * Just before an operation is called, returns to the editor root if the focus at the moment of
   * the press was inside an item bar or a popup.
   *
   * The registrant's operations are called on the premise that the editor root has focus, so this
   * lets them be called on the same premise when run from the keyboard.
   * Also returns when focus was in the search panel at the time of the press. Pressing an item does not move focus,
   * so without returning, the operation would act on an editor root that has no selection.
   * The same goes for the sidebar: without returning, the operation would run while focus stays on a sidebar item.
   *
   * @param focusedAtPress The focus at the moment of the press.
   */
  handleBeforeRun(focusedAtPress: Element | null): void {
    if (
      focusedAtPress === null
      || !(
        this.isFromItemBar(focusedAtPress)
        || this.ports.isInSearchPanel(focusedAtPress)
        || this.ports.isInSidebar(focusedAtPress)
      )
    ) {
      return;
    }
    this.returnToEditor();
  }

  /**
   * Returns whether focus is being moved to the editor root.
   *
   * Used to tell the `focusin` the editor root receives during that move apart from focus entering by other means.
   *
   * @returns True only while the editor root's `focus` is being called.
   */
  isReturning(): boolean {
    return this.returning;
  }

  /**
   * Keeps focus from being stranded when the floating menu hides while holding focus.
   *
   * While not editable, focus moves to the stop of the fixed toolbar, so that Esc can return once
   * the stop lifts. While the view does not have focus, focus is not moved, and the return is
   * deferred if editable.
   */
  handleFloatingMenuHidden(): void {
    if (this.ports.hasViewFocus()) {
      if (this.ports.isEditable()) {
        this.returnToEditor();
        return;
      }
      this.ports.focusToolbarStop();
      return;
    }
    if (this.ports.isEditable()) {
      this.deferReturn(this.captured);
    }
  }

  /**
   * Receives a selection that the input stop controller did not restore because the view did not
   * have focus, and defers the return.
   *
   * Also receives from later UI parts (the table context menu). The menu passes its selection here, whether or not
   * the editor root is editable, when it closes because the view lost focus and when it closes while the editor root
   * is not editable. Once a menu that had focus disappears, the caret would not return to the editor root either
   * when the stop ends or when focus comes back to the view.
   * Also received from the comment popup. When it closes while holding focus, during a time when editing is disabled or the
   * view does not have focus, it passes its return selection (or none) here. As with the table menu, it would otherwise not
   * return to the editor root even after the stop ends.
   *
   * @param selection The selection to restore. `undefined` when none was captured.
   */
  deferReturn(selection: EncodedSelection | undefined): void {
    this.deferred = { selection };
    this.captured = undefined;
  }

  /**
   * Once the stop lifts, carries out the deferred return if possible. Otherwise the deferred return
   * is kept.
   */
  handleResumed(): void {
    this.resumeDeferred();
  }

  /**
   * When the view gains focus, carries out or discards the deferred return.
   *
   * If an element already has focus, the deferred return is discarded so as not to take away the
   * place the user chose.
   */
  handleViewFocused(): void {
    if (this.deferred === undefined) {
      return;
    }
    if (this.readFocusedElement() !== undefined) {
      this.deferred = undefined;
      return;
    }
    this.resumeDeferred();
  }

  /**
   * On a document replacement, discards the captured selection and the selection of the deferred
   * return.
   *
   * After the replacement, the selection it placed is authoritative and is not overwritten with
   * stale coordinates. The deferred return itself is kept, and when carried out it returns focus
   * only.
   */
  handleDocumentReplaced(): void {
    this.captured = undefined;
    if (this.deferred !== undefined) {
      this.deferred = { selection: undefined };
    }
  }

  /**
   * The single port through which later UI components return to the editor root.
   *
   * When editable, returns focus and the given selection (or the captured one if none is given),
   * and discards the captured selection. Does nothing while not editable or while the view does not
   * have focus.
   *
   * @param selection The selection to restore. When omitted, the captured selection is restored.
   */
  requestReturn(selection?: EncodedSelection): void {
    this.returnWith(selection ?? this.captured);
  }

  /**
   * Returns whether the node came from inside an item bar or a popup.
   *
   * A closed popup is removed together with its contents, and the before run notification for an
   * operation inside it, as well as the focusin when leaving it with Tab, arrive after it has
   * closed. The only nodes removed from the document in the middle of a press or a move are the
   * contents of a closed popup, so a detached node is treated as having been inside a popup.
   *
   * @param node The previous element, or the focus at the moment of the press.
   */
  private isFromItemBar(node: Node): boolean {
    return !node.isConnected || this.ports.isInItemBar(node);
  }

  /**
   * Returns focus and the selection only when editable and the view has focus.
   *
   * @param selection The selection to restore. `undefined` leaves the selection untouched.
   */
  private returnWith(selection: EncodedSelection | undefined): void {
    if (!this.ports.isEditable() || !this.ports.hasViewFocus()) {
      return;
    }
    const root = this.ports.readEditorRoot();
    if (root === undefined) {
      return;
    }
    this.focusRoot(root, selection);
  }

  /** Carries out the deferred return if there is one and the conditions for it are met. */
  private resumeDeferred(): void {
    const deferred = this.deferred;
    if (
      deferred === undefined
      || !this.ports.hasViewFocus()
      || !this.ports.isEditable()
      || this.readFocusedElement() !== undefined
    ) {
      return;
    }
    const root = this.ports.readEditorRoot();
    if (root === undefined) {
      return;
    }
    this.focusRoot(root, deferred.selection);
  }

  /**
   * Moves focus to the editor root and restores the selection if there is one. The captured
   * selection and the deferred return are discarded here.
   *
   * @param root The editor root.
   * @param selection The selection to restore. `undefined` leaves the selection untouched.
   */
  private focusRoot(root: HTMLElement, selection: EncodedSelection | undefined): void {
    this.captured = undefined;
    this.deferred = undefined;
    this.returning = true;
    try {
      root.focus();
    } finally {
      this.returning = false;
    }
    if (selection !== undefined) {
      restoreSelection(root, selection);
    }
  }

  /**
   * Returns the focused element.
   *
   * An element that is not rendered, such as an item of a hidden floating menu, is not counted,
   * because keystrokes do not reach it even when it receives focus.
   *
   * @returns The focused element, or `undefined` when no element has focus.
   */
  private readFocusedElement(): Element | undefined {
    const document = this.view.document;
    const active = document.activeElement;
    if (active === null || active === document.body || active.getClientRects().length === 0) {
      return undefined;
    }
    return active;
  }
}
