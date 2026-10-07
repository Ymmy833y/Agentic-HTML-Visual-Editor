import { CHANGE_KIND } from '../../common/index';
import type { EncodedSelection, Localizer, MessageKey } from '../../common/index';
import { INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX } from '../document/internal-attribute';
import { readSelectionRange } from '../editing/caret';
import {
  REPLACEMENT_KIND,
  readChangeAuthor,
  readChangeHead,
  readChangeKind,
  readReplacementPartner,
} from '../editing/change-read';
import type { ChangeUnitKind } from '../editing/change-read';
import type { ChangeDecision } from '../editing/change-resolve';
import { readEntryAuthorName, readEntryUpdated } from '../editing/comment-thread-read';
import { isInsideClosedDetailsBody } from '../editing/details-body-guard';
import { captureRange } from '../selection/selection-capture';
import { readCommentPopupPlacement } from './comment-popup';
import type { CommentPopupClosure } from './comment-popup';
import { readCycleTarget, readTabbableElements } from './modal-focus';
import { TOOLBAR_ELEMENT_ID, createItemIcon } from './toolbar';

/** The ID of the popup element. The bundled stylesheet and E2E look it up by the same spelling. */
export const CHANGE_POPUP_ELEMENT_ID = 'editor-change-popup';

/**
 * The namespace of the mark on the open change.
 *
 * Placed under the internal namespace that the inverse transform drops from the output, as the mark of the open comment
 * is. The mark only shows which change the popup belongs to and must not appear in the saved content, the unsaved
 * content, or the history.
 */
export const CHANGE_OPEN_MARK_NAMESPACE = `${INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX}change-open`;

/** The local name of the mark attribute. The bundled stylesheet and E2E tests look it up with the same spelling. */
export const CHANGE_OPEN_MARK_NAME = 'data-ahve-change-open';

/**
 * The icon of each kind, drawn in a 24×24 view box: a plus for an insertion, a minus for a deletion, and two arrows
 * passing each other for a replacement pair. The popup and the sidebar list lead a change with the same icon, so the
 * kind reads the same in both places. They carry no color of their own; the stylesheet draws them in the color of the
 * kind.
 */
export const CHANGE_KIND_ICON_PATH: Readonly<Record<ChangeUnitKind, string>> = {
  [CHANGE_KIND.insertion]: 'M12 5v14 M5 12h14',
  [CHANGE_KIND.deletion]: 'M5 12h14',
  [REPLACEMENT_KIND]: 'M5 9h11 M13 6l3 3-3 3 M19 15H8 M11 12l-3 3 3 3',
};

// The name of each kind on the first line of the popup.
const KIND_MESSAGE_KEY: Readonly<Record<ChangeUnitKind, MessageKey>> = {
  [CHANGE_KIND.insertion]: 'changePopup.insertion',
  [CHANGE_KIND.deletion]: 'changePopup.deletion',
  [REPLACEMENT_KIND]: 'changePopup.replacement',
};

/** Icons of the two decisions, drawn in a 24×24 view box: a check mark for accepting and a cross for rejecting. */
export const CHANGE_POPUP_ICON_PATH = {
  accept: 'M5 12.5l4.5 4.5L19 7',
  reject: 'M6 6l12 12 M18 6L6 18',
} as const;

// The ID of the line with the author and the time. The popup's description points at it, so assistive technology reads
// who made the change after the name.
const META_ELEMENT_ID = 'editor-change-popup-meta';

// Classes kept identical to the spelling in the bundled stylesheet.
const HEADER_CLASS = 'change-popup-header';
const META_CLASS = 'change-popup-meta';
const ACTIONS_CLASS = 'change-popup-actions';
const ACCEPT_CLASS = 'change-popup-accept';
const REJECT_CLASS = 'change-popup-reject';

/** What closed the popup. The same closures as the comment popup, decided the same way. */
export type ChangePopupClosure = CommentPopupClosure;

/**
 * Ports of the popup.
 *
 * None of them holds a value; each is read on every call. The item bars are created after the popup, and the input stop
 * and view focus change from moment to moment.
 */
export interface ChangePopupPorts {
  /** Resolves messages. */
  readonly localizer: Localizer;

  /**
   * Turns a date and time into local notation.
   *
   * @param date Date and time.
   */
  formatDate(date: Date): string;

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
   * Accepts or rejects the open change.
   *
   * @param change The change mark.
   * @param decision The decision.
   */
  resolve(change: Element, decision: ChangeDecision): void;

  /**
   * Leaves one diagnostic line for maintainers. Not used to notify users.
   *
   * @param detail The line to leave.
   */
  reportDiagnostic(detail: string): void;
}

/** State of an open popup. */
interface OpenChangePopup {
  /** The open change mark. For a replacement pair, the deletion that leads it. */
  readonly change: Element;
  /**
   * Selection returned to the editor root on close. A copy of the selection at the moment focus moved from the editor
   * root to the popup, which follows tree changes.
   */
  returnRange: Range | undefined;
}

/**
 * The popup that shows what a change mark is and offers to accept or reject it.
 *
 * Placed outside the editor root, so it never appears in the output. It reads the kind, the author and the time from
 * the mark each time it draws, and keeps no copy. Only one is open at a time; opening another change replaces its
 * contents and position. One per view; not recreated on document replacement.
 */
export class ChangePopup {
  private state: OpenChangePopup | undefined;

  // Whether open is moving focus into the popup. Keeps the focusin caused by that move from recapturing the selection
  // already captured before the move.
  private movingFocus = false;

  // The changes carrying the open mark: the open change and, for a replacement pair, its other half. Kept apart from
  // the state, because closing replaces the state before the mark is removed from the earlier changes.
  private marked: readonly Element[] = [];

  /**
   * @param view The view's window.
   * @param root The editor root.
   * @param element The popup element.
   * @param header The line with the kind.
   * @param meta The line with the author and the time.
   * @param ports The ports of the popup.
   */
  constructor(
    private readonly view: Window,
    private readonly root: HTMLElement,
    private readonly element: HTMLElement,
    private readonly header: HTMLElement,
    private readonly meta: HTMLElement,
    private readonly ports: ChangePopupPorts,
  ) {}

  /**
   * Opens the popup for a change. If another change is open, replaces the contents and position without closing.
   *
   * Opening by click does not move focus: most clicks on a mark move the caret for editing, and stealing focus would
   * stop typing. Opening from the keyboard does move focus, to the popup itself: Tab then reaches the two decisions,
   * so that Enter right after opening does not decide anything by accident.
   *
   * @param change The change mark to open. Either half of a replacement pair opens the popup of the pair.
   * @param moveFocus Whether to move focus into the popup.
   */
  open(change: Element, moveFocus: boolean): void {
    // A replacement pair is one change, so the popup stands on its deletion whichever half was pressed.
    const head = readChangeHead(change);
    if (this.state?.change === head && !moveFocus) {
      return;
    }
    try {
      // Capture before moving focus. Whether the selection survives after focus leaves the editor root differs
      // between browsers.
      const returnRange = moveFocus ? readSelectionRange(this.root)?.cloneRange() : undefined;
      this.state = { change: head, returnRange };
      this.moveOpenMark(readPairMarks(head));
      this.render(head);
      this.element.hidden = false;
      if (!this.placeElement(head)) {
        this.close({ kind: 'treeChange' });
        return;
      }
      if (moveFocus) {
        // If it were recaptured and the move dropped the editor root's selection, the capture would be overwritten
        // with none, and closing could not return to the original selection.
        this.movingFocus = true;
        try {
          this.element.focus({ preventScroll: true });
        } finally {
          this.movingFocus = false;
        }
      }
    } catch (error) {
      this.fail('open', error);
    }
  }

  /** Reads the mark again, redraws, and places again. Does nothing if not open. Does not move focus. */
  refresh(): void {
    const state = this.state;
    if (state === undefined) {
      return;
    }
    try {
      this.render(state.change);
    } catch (error) {
      this.fail('redraw', error);
      return;
    }
    this.place();
  }

  /**
   * Places the popup again to match the position of the mark. Does nothing if not open.
   *
   * Closes if the mark has no position (for example, it went into a closed details body). A popup pointing at something
   * invisible does not tell which change it belongs to.
   */
  place(): void {
    const state = this.state;
    if (state === undefined) {
      return;
    }
    try {
      if (!this.placeElement(state.change)) {
        this.close({ kind: 'treeChange' });
      }
    } catch (error) {
      this.fail('place', error);
    }
  }

  /**
   * Closes. Does nothing if not open.
   *
   * If focus was inside, requests a return to the editor root. Otherwise focus would be left behind on a hidden element
   * and keystrokes would go nowhere. A press outside the item bars does not request it, because the pressed target
   * receives focus. A press in an item bar does not move focus, so it requests it.
   *
   * @param closure What closed the popup.
   */
  close(closure: ChangePopupClosure): void {
    const state = this.state;
    if (state === undefined) {
      return;
    }
    // Hiding also removes focus, so read whether it was inside before hiding.
    const active = this.view.document.activeElement;
    const focusedInside = active !== null && this.element.contains(active);
    // Clear the state first, so the editor root's focusin caused by the return is not counted as entering the editor
    // root by other means.
    this.state = undefined;
    this.moveOpenMark([]);
    this.element.hidden = true;
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
    const selection = returnRange === undefined ? undefined : captureRange(this.root, returnRange)?.selection;
    // While editing is disabled or the view does not have focus, a return request does nothing, so hand it to the
    // deferral and return when that ends.
    if (!this.ports.isInputStopped() && this.ports.hasViewFocus()) {
      this.ports.requestReturn(selection);
    } else {
      this.ports.deferReturn(selection);
    }
  }

  /**
   * Returns the open change mark.
   *
   * @returns The open change: the deletion of a replacement pair, or the mark itself. `undefined` if not open.
   */
  readOpenChange(): Element | undefined {
    return this.state?.change;
  }

  /**
   * Returns the marks the open popup stands on: the open change and, for a replacement pair, its insertion.
   *
   * @returns The marks in document order. Empty if not open.
   */
  readOpenMarks(): readonly Element[] {
    return this.state === undefined ? [] : readPairMarks(this.state.change);
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
   * Tabbing out would move focus outside the view (to VS Code), so Tab cycles inside. Registered shortcuts would
   * trigger other key bindings if they reached VS Code, so they are taken over without calling their operation. Other
   * keys (including undo and redo) are left alone.
   *
   * @param event The pressed key.
   */
  handleKeyDown(event: KeyboardEvent): void {
    if (this.state === undefined || event.isComposing) {
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
      readCycleTarget(
        readTabbableElements(this.element),
        this.view.document.activeElement,
        event.shiftKey ? 'backward' : 'forward',
      )?.focus();
      return;
    }
    if (this.ports.hasShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  /**
   * When focus moves from the editor root into the popup, captures the editor root's selection at that time as the
   * return selection. While open itself moves focus, it does not recapture, to keep the selection captured before the
   * move.
   *
   * @param event The popup's focusin.
   */
  handleFocusIn(event: FocusEvent): void {
    const state = this.state;
    const previous = event.relatedTarget;
    if (state === undefined || this.movingFocus || !(previous instanceof Node) || !this.root.contains(previous)) {
      return;
    }
    state.returnRange = readSelectionRange(this.root)?.cloneRange();
  }

  /**
   * Discards the return selection when the editor root receives focus while the popup is open.
   *
   * A focusin while open came by other means (such as a click), and the selection placed there must not be overwritten
   * with an old one.
   */
  handleEditorFocusIn(): void {
    if (this.state !== undefined) {
      this.state.returnRange = undefined;
    }
  }

  /**
   * Passes the decision about the open change to the resolution. Does nothing if not open.
   *
   * The resolution takes the mark out of the tree, and the edit notification then closes the popup.
   *
   * @param decision The decision.
   */
  decide(decision: ChangeDecision): void {
    const state = this.state;
    if (state === undefined) {
      return;
    }
    try {
      this.ports.resolve(state.change, decision);
    } catch (error) {
      this.fail(decision, error);
    }
  }

  /**
   * Moves the open mark from the previously marked changes to the given ones, or only removes it.
   *
   * An attribute already there is not set again, because an attribute change stops edit endpoints from being reused.
   *
   * @param changes The changes to mark. Empty only removes the mark.
   */
  private moveOpenMark(changes: readonly Element[]): void {
    for (const previous of this.marked) {
      if (!changes.includes(previous)) {
        previous.removeAttributeNS(CHANGE_OPEN_MARK_NAMESPACE, CHANGE_OPEN_MARK_NAME);
      }
    }
    this.marked = changes;
    for (const change of changes) {
      if (!change.hasAttributeNS(CHANGE_OPEN_MARK_NAMESPACE, CHANGE_OPEN_MARK_NAME)) {
        change.setAttributeNS(CHANGE_OPEN_MARK_NAMESPACE, CHANGE_OPEN_MARK_NAME, '');
      }
    }
  }

  /**
   * Draws the kind, the author and the time of a change.
   *
   * The author and the time share the attributes of comment entries, so they are read with the same rules and shown
   * with the same names. A replacement pair shows as one replacement, with the author and the time of the deletion
   * that leads it.
   *
   * @param change The change mark. The deletion of a replacement pair.
   */
  private render(change: Element): void {
    const document = this.view.document;
    const localizer = this.ports.localizer;
    const kind: ChangeUnitKind = readReplacementPartner(change) === undefined
      ? readChangeKind(change) ?? CHANGE_KIND.insertion
      : REPLACEMENT_KIND;
    const label = document.createElement('span');
    label.textContent = localizer.getMessage(KIND_MESSAGE_KEY[kind]);
    this.header.replaceChildren(createItemIcon(document, CHANGE_KIND_ICON_PATH[kind]), label);
    // The kind and the side of the author color the popup through the stylesheet, as the first entry colors the
    // comment popup.
    this.element.dataset.change = kind;
    this.element.dataset.author = readChangeAuthor(change);

    const values = [
      readEntryAuthorName(change, localizer),
      readEntryUpdated(change, (date) => this.ports.formatDate(date)),
    ].filter((value): value is string => value !== undefined);
    this.meta.replaceChildren(...values.map((value) => {
      const span = document.createElement('span');
      span.textContent = value;
      return span;
    }));
  }

  /**
   * Places the popup in view coordinates to match the position of the mark.
   *
   * The placement is decided the same way as for a comment, from the rectangle of the mark below the toolbar.
   *
   * @param change The change mark.
   * @returns `true` if placed. `false` if the mark has no rectangle or is inside a closed details body.
   */
  private placeElement(change: Element): boolean {
    if (isInsideClosedDetailsBody(change, this.root) || change.getClientRects().length === 0) {
      return false;
    }
    // Measured at the previous position, the width could come out shrunk near the right edge of the screen. Move it
    // back to the top left before measuring its natural size.
    this.element.style.left = '0px';
    this.element.style.top = '0px';
    this.element.style.removeProperty('max-height');
    const toolbar = this.view.document.getElementById(TOOLBAR_ELEMENT_ID)?.getBoundingClientRect();
    const size = this.element.getBoundingClientRect();
    const view = this.view.document.documentElement;
    const position = readCommentPopupPlacement(
      change.getBoundingClientRect(),
      { width: size.width, height: size.height },
      { left: 0, top: toolbar?.bottom ?? 0, right: view.clientWidth, bottom: view.clientHeight },
    );
    this.element.style.left = `${position.left}px`;
    this.element.style.top = `${position.top}px`;
    if (position.maxHeight !== undefined) {
      this.element.style.maxHeight = `${position.maxHeight}px`;
    }
    return true;
  }

  /**
   * Leaves one diagnostic line and closes, without throwing the exception out.
   *
   * @param step The step that failed.
   * @param error The caught exception.
   */
  private fail(step: string, error: unknown): void {
    this.ports.reportDiagnostic(`Could not ${step} the change popup: ${String(error)}`);
    this.close({ kind: 'failure' });
  }
}

/**
 * Returns a change and the other half of its replacement pair, if any, in document order.
 *
 * @param head The change mark. The deletion of a replacement pair.
 */
function readPairMarks(head: Element): Element[] {
  const partner = readReplacementPartner(head);
  return partner === undefined ? [head] : [head, partner];
}

/**
 * Places the hidden popup outside the editor root and attaches listeners for its buttons, for keys inside it and for
 * focus moving in and out.
 *
 * Placed inside the editor root, it would appear in the body output. It is not modal, so `aria-modal` is not set. The
 * editor root is the same element across document replacements, so this is called only once, on the first mount.
 *
 * @param view The view's window.
 * @param root The editor root.
 * @param ports The ports of the popup.
 * @returns The attached popup.
 */
export function attachChangePopup(view: Window, root: HTMLElement, ports: ChangePopupPorts): ChangePopup {
  const document = view.document;
  const localizer = ports.localizer;
  const element = document.createElement('div');
  element.id = CHANGE_POPUP_ELEMENT_ID;
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-label', localizer.getMessage('changePopup.name'));
  element.setAttribute('aria-describedby', META_ELEMENT_ID);
  // The popup itself receives focus when opened from the keyboard, so the kind and the author are read first.
  element.tabIndex = -1;
  element.hidden = true;

  const header = document.createElement('div');
  header.className = HEADER_CLASS;
  const meta = document.createElement('div');
  meta.id = META_ELEMENT_ID;
  meta.className = META_CLASS;

  const createButton = (className: string, iconPath: string, label: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.append(createItemIcon(document, iconPath), label);
    return button;
  };
  const accept = createButton(ACCEPT_CLASS, CHANGE_POPUP_ICON_PATH.accept, localizer.getMessage('changePopup.accept'));
  const reject = createButton(REJECT_CLASS, CHANGE_POPUP_ICON_PATH.reject, localizer.getMessage('changePopup.reject'));
  const actions = document.createElement('div');
  actions.className = ACTIONS_CLASS;
  actions.append(accept, reject);

  element.append(header, meta, actions);
  document.body.append(element);

  const popup = new ChangePopup(view, root, element, header, meta, ports);
  accept.addEventListener('click', () => popup.decide('accept'));
  reject.addEventListener('click', () => popup.decide('reject'));
  element.addEventListener('keydown', (event) => popup.handleKeyDown(event));
  element.addEventListener('focusin', (event) => popup.handleFocusIn(event));
  root.addEventListener('focusin', () => popup.handleEditorFocusIn());
  return popup;
}
