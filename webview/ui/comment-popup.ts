import type { EncodedSelection, Localizer } from '../../common/index';
import { INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX } from '../document/internal-attribute';
import { readSelectionRange } from '../editing/caret';
import { readCommentEntries } from '../editing/comment-read';
import { isInsideClosedDetailsBody } from '../editing/details-body-guard';
import { captureRange } from '../selection/selection-capture';
import { readCycleTarget, readTabbableElements } from './modal-focus';
import { TOOLBAR_ELEMENT_ID } from './toolbar';

/** The ID of the popup element. The bundled stylesheet and E2E look it up by the same spelling. */
export const COMMENT_POPUP_ELEMENT_ID = 'editor-comment-popup';

/**
 * The namespace of the mark on the open comment.
 *
 * Placed under the internal namespace that the inverse transform drops from the output. The mark only shows which annotated
 * text the popup belongs to and must not appear in the saved content, the unsaved content, or the history.
 */
export const COMMENT_OPEN_MARK_NAMESPACE = `${INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX}comment-open`;

/** The local name of the mark attribute. The bundled stylesheet and E2E tests look it up with the same spelling. */
export const COMMENT_OPEN_MARK_NAME = 'data-ahve-comment-open';

// The ID of the entries container. The popup's description points at it, so assistive technology reads the entries after the name.
const ENTRIES_ELEMENT_ID = 'editor-comment-popup-entries';

// Classes of one entry and of the empty message. Must match the spelling in the bundled stylesheet.
const ENTRY_CLASS = 'comment-popup-entry';
const EMPTY_CLASS = 'comment-popup-empty';

// Distance between the annotated text and the popup. Overlapping them would hide the annotated text behind the popup.
const ANNOTATION_GAP_PX = 6;

// HTML whitespace at the start and end of an entry. Line breaks and indentation the writer put between tags are not entry content.
const HTML_WHITESPACE_EDGES_PATTERN = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu;

/**
 * Ports of the popup.
 *
 * None of them holds a value; each is read on every call. The item bars are created after the popup, and the input stop
 * and view focus change from moment to moment.
 */
export interface CommentPopupPorts {
  /** Resolves messages. */
  readonly localizer: Localizer;

  /** Whether any input stop reason remains. */
  isInputStopped(): boolean;

  /** Whether the view has focus. */
  hasViewFocus(): boolean;

  /**
   * Returns whether the node is inside an item bar (the fixed toolbar or the floating menu).
   *
   * @param node The node to check.
   */
  isInItemBar(node: Node | null): boolean;

  /**
   * Returns only whether the pressed key matches a registered shortcut, without calling its operation.
   *
   * @param event The pressed key.
   */
  hasShortcut(event: KeyboardEvent): boolean;

  /**
   * Returns focus and the selection to the editor root.
   *
   * @param selection The selection to restore. When omitted, the selection is not touched.
   */
  requestReturn(selection?: EncodedSelection): void;

  /**
   * Defers the return to the editor root. It happens when the stop ends or the view gains focus.
   *
   * @param selection The selection to restore. When absent, only focus is returned.
   */
  deferReturn(selection: EncodedSelection | undefined): void;

  /**
   * Leaves one diagnostic line for maintainers. Not used to notify users.
   *
   * @param detail The line to leave.
   */
  reportDiagnostic(detail: string): void;
}

/**
 * What closed the popup.
 *
 * The closure decides whether a return is requested with the return selection. Escape and a press in an item bar include it,
 * because the operation after closing should act on the original selection. A selection move by keys, a tree change and an
 * exception do not, because the selection at that time is the right one.
 */
export type CommentPopupClosure =
  | { readonly kind: 'escape' }
  | { readonly kind: 'press'; readonly target: Node | null }
  | { readonly kind: 'selection' }
  | { readonly kind: 'treeChange' }
  | { readonly kind: 'failure' };

/**
 * Departure of the content from the popup. A closure, plus switching to another comment.
 *
 * The content uses it to decide whether to commit or discard the inputs being written.
 */
export type CommentPopupDeparture = CommentPopupClosure | { readonly kind: 'switch' };

/**
 * Ports a registered content satisfies.
 *
 * The popup notifies when to draw, continue input and end, without knowing the content's type, so that the popup,
 * created first, does not depend on the content, created later. Only `handleKeyDown` returns a result.
 */
export interface CommentPopupContent {
  /**
   * Receives the popup element and the entries container, only once, on registration.
   *
   * @param element Popup element.
   * @param entries Entries container.
   */
  attach(element: HTMLElement, entries: HTMLElement): void;

  /**
   * On opening, draws before placing, because the content's size decides the placement.
   *
   * @param comment Comment to open.
   */
  handleOpening(comment: Element): void;

  /**
   * Notified after focus has moved and opening has finished.
   *
   * @param comment Opened comment.
   */
  handleOpened(comment: Element): void;

  /**
   * Redraws for a tree change.
   *
   * @param comment Open comment.
   */
  handleRefresh(comment: Element): void;

  /**
   * After document replacement, reattaches to the comment with the same ID in the new tree and redraws.
   *
   * @param comment Comment in the new tree.
   */
  handleReattached(comment: Element): void;

  /**
   * Notified after the popup has left the open comment. Called after the popup state is cleared.
   *
   * @param departure Departure.
   */
  handleDeparted(departure: CommentPopupDeparture): void;

  /**
   * Receives keys inside the popup before the default handling.
   *
   * @param event Pressed key.
   * @returns Whether the key was taken over. When taken over, the popup skips the default handling.
   */
  handleKeyDown(event: KeyboardEvent): boolean;
}

/** State of an open popup. */
interface OpenCommentPopup {
  /** The open comment. */
  readonly comment: Element;
  /**
   * Selection returned to the editor root on close. A copy of the selection at the moment focus moved from the editor
   * root to the popup, which follows tree changes.
   *
   * Encoding it when recorded would return to a different position after closing if a write while open changed the
   * text before the recorded position.
   */
  returnRange: Range | undefined;
}

/**
 * The popup that shows a comment's thread.
 *
 * Placed outside the editor root; entries are read from the tree each time and shown as text. It keeps no copy, so the
 * tree is always the source of truth for entries. Only one is open at a time; opening another comment replaces its contents
 * and position. One per view; not recreated on document replacement.
 */
export class CommentPopup {
  private state: OpenCommentPopup | undefined;

  // Whether open is moving focus into the popup. Keeps the focusin caused by that move from recapturing the selection
  // already captured before the move.
  private movingFocus = false;

  // Registered content. Does not change after being registered on the first mount. Without one, entries are listed as
  // text by default.
  private content: CommentPopupContent | undefined;

  // The comment carrying the open mark. Kept apart from the state, because closing and reattaching replace the state
  // before the mark is removed from the earlier comment.
  private marked: Element | undefined;

  /**
   * @param view The view's window.
   * @param root The editor root.
   * @param element The popup element.
   * @param entries The entries container.
   * @param ports The ports of the popup.
   */
  constructor(
    private readonly view: Window,
    private readonly root: HTMLElement,
    private readonly element: HTMLElement,
    private readonly entries: HTMLElement,
    private readonly ports: CommentPopupPorts,
  ) {}

  /**
   * Opens the comment popup. If another comment is open, replaces its contents and position without closing.
   *
   * Opening by click does not move focus: most clicks on annotated text move the caret for editing, and stealing focus
   * would stop typing. Opening from the comment button does move focus: keyboard users cannot read the entries unless they
   * can move inside.
   *
   * @param comment The comment to open.
   * @param moveFocus Whether to move focus into the popup.
   */
  open(comment: Element, moveFocus: boolean): void {
    if (this.state?.comment === comment && !moveFocus) {
      return;
    }
    try {
      // When switching from another comment, clear the state first, then notify the content of the switch. Because
      // the state is cleared first, the notification of the edit that wrote the earlier inputs does not redraw the
      // earlier comment.
      if (this.content !== undefined && this.state !== undefined && this.state.comment !== comment) {
        this.state = undefined;
        this.notifyDeparted({ kind: 'switch' });
      }
      // Capture before moving focus. Whether the selection survives after focus leaves the editor root differs between browsers.
      const returnRange = moveFocus ? copySelectionRange(this.root) : undefined;
      this.state = { comment, returnRange };
      this.moveOpenMark(comment);
      this.drawOpening(comment);
      this.element.hidden = false;
      if (!this.placeElement(comment)) {
        this.close({ kind: 'treeChange' });
        return;
      }
      if (moveFocus) {
        // If it were recaptured and the move dropped the editor root's selection, the capture would be overwritten with
        // none, and closing could not return to the original selection.
        this.movingFocus = true;
        try {
          this.element.focus({ preventScroll: true });
        } finally {
          this.movingFocus = false;
        }
        // The content moves focus to a field only after focus has moved into the popup. Moving it earlier would have
        // it taken back here.
        this.content?.handleOpened(comment);
      }
    } catch (error) {
      this.fail('open', error);
    }
  }

  /**
   * Registers one content and passes it the popup element and the entries container.
   *
   * Registrations after the first are ignored. If the content were swapped, the owner of the inputs being written
   * would be unclear.
   *
   * @param content Popup content.
   */
  registerContent(content: CommentPopupContent): void {
    if (this.content !== undefined) {
      return;
    }
    this.content = content;
    content.attach(this.element, this.entries);
  }

  /**
   * Switches from the open comment to another comment in the document. Does nothing if not open or for the same
   * comment.
   *
   * The contents change without closing, so the return selection stays the one from the first opening. After the
   * switch, focus moves to the first tabbable element inside, so that a user who moved by keyboard can go straight on
   * to the next operation.
   *
   * @param comment Comment to switch to.
   */
  switchTo(comment: Element): void {
    const state = this.state;
    if (state === undefined || state.comment === comment) {
      return;
    }
    try {
      this.state = undefined;
      this.notifyDeparted({ kind: 'switch' });
      this.state = { comment, returnRange: state.returnRange };
      this.moveOpenMark(comment);
      this.drawOpening(comment);
      if (!this.placeElement(comment)) {
        this.close({ kind: 'treeChange' });
        return;
      }
      this.movingFocus = true;
      try {
        (readTabbableElements(this.element).at(0) ?? this.element).focus({ preventScroll: true });
      } finally {
        this.movingFocus = false;
      }
    } catch (error) {
      this.ports.reportDiagnostic(`Could not switch the comment popup:${String(error)}`);
      this.close({ kind: 'failure' });
    }
  }

  /** Reads the entries from the tree again, redraws, and places again. Does nothing if not open. Does not move focus. */
  refresh(): void {
    const state = this.state;
    if (state === undefined) {
      return;
    }
    try {
      if (this.content === undefined) {
        this.render(state.comment);
      } else {
        this.content.handleRefresh(state.comment);
      }
    } catch (error) {
      this.fail('redraw', error);
      return;
    }
    this.place();
  }

  /**
   * Places the popup again to match the position of the annotated text. Does nothing if not open.
   *
   * Closes if the annotated text has no position (for example, it went into a closed details body). A popup pointing at
   * something invisible does not tell which thread it belongs to.
   */
  place(): void {
    const state = this.state;
    if (state === undefined) {
      return;
    }
    try {
      if (!this.placeElement(state.comment)) {
        this.close({ kind: 'treeChange' });
      }
    } catch (error) {
      this.fail('place', error);
    }
  }

  /**
   * Redraws and places again with the comment of the same ID in the tree after a document replacement. Does nothing if not
   * open. Does not move focus.
   *
   * The return selection is in the old tree's coordinates, so it is discarded. It must not overwrite the selection the replacement placed.
   *
   * @param comment The comment in the new tree.
   */
  reattach(comment: Element): void {
    if (this.state === undefined) {
      return;
    }
    this.state = { comment, returnRange: undefined };
    this.moveOpenMark(comment);
    const content = this.content;
    if (content === undefined) {
      this.refresh();
      return;
    }
    // Notify as a reattach, not as a redraw. The content moves the inputs being written to their targets in the new
    // tree before drawing.
    try {
      content.handleReattached(comment);
    } catch (error) {
      this.fail('redraw', error);
      return;
    }
    this.place();
  }

  /**
   * Closes. Does nothing if not open.
   *
   * If focus was inside, requests a return to the editor root. Otherwise focus would be left behind on a hidden element and
   * keystrokes would go nowhere. A press outside the item bars does not request it, because the pressed target receives
   * focus. A press in an item bar does not move focus, so it requests it.
   *
   * @param closure What closed the popup.
   */
  close(closure: CommentPopupClosure): void {
    const state = this.state;
    if (state === undefined) {
      return;
    }
    // Hiding also removes focus, so read whether it was inside before hiding.
    const active = this.view.document.activeElement;
    const focusedInside = active !== null && this.element.contains(active);
    // Clear the state first, so the editor root's focusin caused by the return is not counted as entering the editor root by other means.
    this.state = undefined;
    this.moveOpenMark(undefined);
    this.element.hidden = true;
    this.entries.replaceChildren();
    // Notify after clearing the state, so that the notification of the edit in which the content committed its inputs
    // does not redraw the closed comment.
    this.notifyDeparted(closure);
    if (!focusedInside) {
      return;
    }

    let returnRange: Range | undefined;
    switch (closure.kind) {
      case 'escape':
        returnRange = state.returnRange;
        break;
      case 'press':
        if (!this.ports.isInItemBar(closure.target)) {
          return;
        }
        returnRange = state.returnRange;
        break;
      default:
        returnRange = undefined;
    }
    // Encode after notifying the content, so that the writes of inputs committed on the close notification are also
    // reflected in the coordinates of the return position.
    const selection = returnRange === undefined ? undefined : captureRange(this.root, returnRange)?.selection;
    // While editing is disabled or the view does not have focus, a return request does nothing, so hand it to the deferral
    // and return when that ends.
    if (!this.ports.isInputStopped() && this.ports.hasViewFocus()) {
      this.ports.requestReturn(selection);
    } else {
      this.ports.deferReturn(selection);
    }
  }

  /**
   * Returns the open comment.
   *
   * @returns The open comment. `undefined` if not open.
   */
  readOpenComment(): Element | undefined {
    return this.state?.comment;
  }

  /**
   * Returns whether the node is the popup element or inside it.
   *
   * @param node The node to check.
   * @returns `true` if inside.
   */
  contains(node: Node | null): boolean {
    return node !== null && this.element.contains(node);
  }

  /**
   * Handles keys while focus is in the popup.
   *
   * Tabbing out would move focus outside the view (to VS Code), so Tab cycles inside. Registered shortcuts would trigger
   * other key bindings if they reached VS Code, so they are taken over without calling their operation. Other keys
   * (including undo and redo) are left alone.
   *
   * @param event The pressed key.
   */
  handleKeyDown(event: KeyboardEvent): void {
    if (this.state === undefined || event.isComposing) {
      // Escape during a composition is left to cancel the conversion in an input field. Closing would lose the value being entered.
      return;
    }

    // The content takes over Esc in an active field (cancel) and arrows outside the fields (moving to the previous or
    // next comment). Running the default handling first would close the popup.
    if (this.delegateKeyDown(event)) {
      return;
    }

    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      // While editing is disabled, closing cannot return to the editor root. Keep it open and keep focus.
      if (!this.ports.isInputStopped()) {
        this.close({ kind: 'escape' });
      }
      return;
    }

    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      // With no tabbable elements, focus stays on the popup itself.
      readCycleTarget(
        readTabbableElements(this.element),
        this.view.document.activeElement,
        event.shiftKey ? 'backward' : 'forward',
      )?.focus();
      return;
    }

    // Unmodified ← and → are registered as shortcuts that switch the comment side, but they are not stopped inside the popup.
    // Stopping them would freeze the caret inside the fields. Outside the fields, the popup content already takes ← and → as previous/next moves.
    if (this.ports.hasShortcut(event) && !isPlainHorizontalArrow(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  /**
   * When focus moves from the editor root into the popup, captures the editor root's selection at that time as the return selection.
   *
   * So even after opening by click and then pressing inside to move there, closing returns to the original selection. While
   * open itself moves focus, it does not recapture, to keep the selection captured before the move.
   *
   * @param event The popup's focusin.
   */
  handleFocusIn(event: FocusEvent): void {
    const state = this.state;
    const previous = event.relatedTarget;
    if (state === undefined || this.movingFocus || !(previous instanceof Node) || !this.root.contains(previous)) {
      return;
    }
    state.returnRange = copySelectionRange(this.root);
  }

  /**
   * Discards the return selection when the editor root receives focus while the popup is open.
   *
   * This feature's return happens after closing, so a focusin while open came by other means (such as a click). The
   * selection placed there must not be overwritten with an old one.
   */
  handleEditorFocusIn(): void {
    if (this.state !== undefined) {
      this.state.returnRange = undefined;
    }
  }

  /**
   * Moves the open mark from the previously marked comment to the given one, or only removes it.
   *
   * An attribute already there is not set again, because an attribute change stops edit endpoints from being reused.
   *
   * @param comment The comment to mark. `undefined` only removes the mark.
   */
  private moveOpenMark(comment: Element | undefined): void {
    if (this.marked !== undefined && this.marked !== comment) {
      this.marked.removeAttributeNS(COMMENT_OPEN_MARK_NAMESPACE, COMMENT_OPEN_MARK_NAME);
    }
    this.marked = comment;
    if (comment !== undefined && !comment.hasAttributeNS(COMMENT_OPEN_MARK_NAMESPACE, COMMENT_OPEN_MARK_NAME)) {
      comment.setAttributeNS(COMMENT_OPEN_MARK_NAMESPACE, COMMENT_OPEN_MARK_NAME, '');
    }
  }

  /**
   * Draws the contents on opening. With a registered content, the content draws instead of the default drawing.
   *
   * @param comment Comment to open.
   */
  private drawOpening(comment: Element): void {
    if (this.content === undefined) {
      this.render(comment);
    } else {
      this.content.handleOpening(comment);
    }
  }

  /**
   * Notifies the content that the popup has left the open comment.
   *
   * Exceptions from the content are not thrown out. Throwing would stop the return after closing, or the switch,
   * halfway.
   *
   * @param departure Departure.
   */
  private notifyDeparted(departure: CommentPopupDeparture): void {
    try {
      this.content?.handleDeparted(departure);
    } catch (error) {
      this.ports.reportDiagnostic(`Could not notify the comment popup content of the departure:${String(error)}`);
    }
  }

  /**
   * Passes a key to the content first.
   *
   * Exceptions from the content are not thrown out; the key is treated as not taken over and the default handling
   * continues, so that closing with Esc is not lost as well.
   *
   * @param event Pressed key.
   * @returns Whether the content took it over.
   */
  private delegateKeyDown(event: KeyboardEvent): boolean {
    const content = this.content;
    if (content === undefined) {
      return false;
    }
    try {
      return content.handleKeyDown(event);
    } catch (error) {
      this.ports.reportDiagnostic(`The comment popup content could not handle a key:${String(error)}`);
      return false;
    }
  }

  /**
   * Draws the entries as text. Elements inside are not interpreted.
   *
   * Placing copies of the elements outside the editor root would bring in duplicate `id`s, link navigation and resolution
   * of images with relative paths.
   *
   * @param comment The comment.
   */
  private render(comment: Element): void {
    const document = this.view.document;
    const texts = readCommentEntries(comment)
      .map((entry) => (entry.textContent ?? '').replace(HTML_WHITESPACE_EDGES_PATTERN, ''))
      .filter((text) => text.length > 0);

    const children = texts.map((text) => {
      const item = document.createElement('div');
      item.className = ENTRY_CLASS;
      item.textContent = text;
      return item;
    });
    if (children.length === 0) {
      const empty = document.createElement('div');
      empty.className = EMPTY_CLASS;
      empty.textContent = this.ports.localizer.getMessage('commentPopup.empty');
      children.push(empty);
    }
    this.entries.replaceChildren(...children);
  }

  /**
   * Places the popup in view coordinates to match the position of the annotated text.
   *
   * @param comment The comment.
   * @returns `true` if placed. `false` if the annotated text has no rectangle or is inside a closed details body.
   */
  private placeElement(comment: Element): boolean {
    if (isInsideClosedDetailsBody(comment, this.root) || comment.getClientRects().length === 0) {
      return false;
    }
    // Measured at the previous position, the width could come out shrunk near the right edge of the screen. Move it back
    // to the top left and drop the previous height limit before measuring its natural size.
    this.element.style.left = '0px';
    this.element.style.top = '0px';
    // Dropping the limit clamps the inner scroll position to the taller box, and scrolling inside places the popup again,
    // so without putting the position back the last part of a long thread could never be scrolled into view.
    const scrollTop = this.element.scrollTop;
    this.element.style.removeProperty('max-height');
    // Overlapping the fixed toolbar strip would make its items unpressable, so the area above the strip's bottom edge is excluded.
    const toolbar = this.view.document.getElementById(TOOLBAR_ELEMENT_ID)?.getBoundingClientRect();
    // The rendered size rather than offsetWidth, which rounds to whole pixels and would let the popup overflow the right
    // edge by a fraction of a pixel.
    const size = this.element.getBoundingClientRect();
    // The size of the view without scrollbars. innerWidth and innerHeight include them, and a fixed element is laid out
    // inside the area without them, so using those would let the popup slip under a scrollbar and be cut off.
    const view = this.view.document.documentElement;
    const position = readCommentPopupPlacement(
      comment.getBoundingClientRect(),
      { width: size.width, height: size.height },
      { left: 0, top: toolbar?.bottom ?? 0, right: view.clientWidth, bottom: view.clientHeight },
    );
    this.element.style.left = `${position.left}px`;
    this.element.style.top = `${position.top}px`;
    if (position.maxHeight !== undefined) {
      this.element.style.maxHeight = `${position.maxHeight}px`;
    }
    this.element.scrollTop = scrollTop;
    return true;
  }

  /**
   * Leaves one diagnostic line and closes, without throwing the exception out.
   *
   * @param step The step that failed.
   * @param error The caught exception.
   */
  private fail(step: string, error: unknown): void {
    this.ports.reportDiagnostic(`Could not ${step} the comment popup: ${String(error)}`);
    this.close({ kind: 'failure' });
  }
}

/**
 * Places the hidden popup outside the editor root and attaches listeners for keys inside it and for focus moving in and out.
 *
 * Placed inside the editor root, it would appear in the body output. It is not modal, so `aria-modal` is not set. The press
 * default is not prevented (so text inside can be selected). The editor root is the same element across document
 * replacements, so this is called only once, on the first mount.
 *
 * @param view The view's window.
 * @param root The editor root.
 * @param ports The ports of the popup.
 * @returns The attached popup.
 */
export function attachCommentPopup(view: Window, root: HTMLElement, ports: CommentPopupPorts): CommentPopup {
  const document = view.document;
  const element = document.createElement('div');
  element.id = COMMENT_POPUP_ELEMENT_ID;
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-label', ports.localizer.getMessage('commentPopup.name'));
  element.setAttribute('aria-describedby', ENTRIES_ELEMENT_ID);
  // Even with no tabbable elements inside, the popup itself receives focus so the entries are read.
  element.tabIndex = -1;
  element.hidden = true;

  const entries = document.createElement('div');
  entries.id = ENTRIES_ELEMENT_ID;
  element.append(entries);
  document.body.append(element);

  const popup = new CommentPopup(view, root, element, entries, ports);
  element.addEventListener('keydown', (event) => popup.handleKeyDown(event));
  element.addEventListener('focusin', (event) => popup.handleFocusIn(event));
  root.addEventListener('focusin', () => popup.handleEditorFocusIn());
  return popup;
}

/**
 * Decides where to place the popup from the rectangle of the annotated text.
 *
 * Placed below the annotated text when it fits. Otherwise it goes on the side with more room, and when that room is
 * shorter than the popup, the height is limited to it and the rest scrolls inside; a popup running off the screen could
 * not show the end of a long thread. Horizontally it is pulled into the area, but not vertically: pulling it in vertically
 * too would leave the popup alone at the edge after the annotated text scrolls off screen. When the annotated text covers
 * the area and there is no room on either side, it stays below without a limit.
 *
 * @param anchor The rectangle of the annotated text (viewport coordinates).
 * @param size The size of the popup.
 * @param area The area where the popup can go (viewport coordinates).
 * @returns The top left of the popup (viewport coordinates), and the height limit when the popup must be shortened.
 */
export function readCommentPopupPlacement(
  anchor: { readonly left: number; readonly top: number; readonly bottom: number },
  size: { readonly width: number; readonly height: number },
  area: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
): { readonly left: number; readonly top: number; readonly maxHeight: number | undefined } {
  const left = Math.max(area.left, Math.min(anchor.left, area.right - size.width));
  const below = anchor.bottom + ANNOTATION_GAP_PX;
  const roomBelow = area.bottom - below;
  const roomAbove = anchor.top - ANNOTATION_GAP_PX - area.top;
  if (size.height <= roomBelow || Math.max(roomBelow, roomAbove) <= 0) {
    return { left, top: below, maxHeight: undefined };
  }
  const room = Math.max(roomBelow, roomAbove);
  const height = Math.min(size.height, room);
  const maxHeight = height < size.height ? height : undefined;
  return roomAbove > roomBelow
    ? { left, top: anchor.top - ANNOTATION_GAP_PX - height, maxHeight }
    : { left, top: below, maxHeight };
}

/**
 * Returns whether the key is ← or → without modifiers.
 *
 * @param event The pressed key.
 * @returns `true` for ← or → without Ctrl, Alt, Meta, or Shift.
 */
function isPlainHorizontalArrow(event: KeyboardEvent): boolean {
  return (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
}

/**
 * Creates a copy of the editor root's selection.
 *
 * The copy is detached from the selection and follows tree changes. It keeps pointing at the recorded position,
 * unaffected by selection changes after focus moves or by writes before closing that change the text before it.
 *
 * @param root Editor root.
 * @returns Copy of the selection. `undefined` when either end of the selection is outside the editor root.
 */
function copySelectionRange(root: Element): Range | undefined {
  return readSelectionRange(root)?.cloneRange();
}
