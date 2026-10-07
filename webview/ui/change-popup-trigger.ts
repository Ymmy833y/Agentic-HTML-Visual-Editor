import { readSelectionRange } from '../editing/caret';
import { findChangeAt, isChangeInTree, readChangeKind } from '../editing/change-read';
import { findCommentAt } from '../editing/comment-read';
import type { EditingSession } from '../editing/editing-session';
import type { ShortcutOutcome, ShortcutReceiver } from '../editing/shortcut-receiver';
import type { ChangePopup, ChangePopupClosure } from './change-popup';
import { COMMENT_ESCAPE_KEY, COMMENT_OPEN_KEY } from './comment-popup-trigger';

/** Ports of the trigger. They hold no values and are read on every call. */
export interface ChangePopupTriggerPorts {
  /** Returns whether an input stop reason remains. */
  isInputStopped(): boolean;

  /** Returns whether the current editing session is composing text. */
  isComposing(): boolean;

  /**
   * Returns whether the same keystroke closed a toolbar popup.
   *
   * @param event The Escape keystroke.
   */
  wasPopupClosedBy(event: KeyboardEvent): boolean;

  /**
   * Returns whether a node is inside the action dialog or an overlay. Any overlay counts, with or without content.
   *
   * @param node The press target.
   */
  isInDialogOrOverlay(node: Node | null): boolean;

  /**
   * Returns whether a node is inside the search panel.
   *
   * @param node The press target.
   */
  isInSearchPanel(node: Node | null): boolean;

  /**
   * Leaves one diagnostic line for maintainers. Not used to notify users.
   *
   * @param detail The line to leave.
   */
  reportDiagnostic(detail: string): void;
}

/**
 * Receives pointer, key, tree change and scroll events and decides whether to open, close, redraw or place again the
 * change popup.
 *
 * A click inside the annotated text of a comment opens the comment, never a change: the comment is the core feature,
 * and two popups over one place would hide each other. A change inside a comment is reached from the sidebar. The same
 * goes for Alt+Enter, which the comment trigger takes first.
 *
 * Exceptions inside each listener are not thrown out; one diagnostic line is left and the popup is closed. One per
 * view; not recreated on document replacement.
 */
export class ChangePopupTrigger {
  private readonly onEdit = (): void => {
    this.handleEdit();
  };

  /**
   * @param root The editor root.
   * @param popup The popup. Whether it is open is read from the popup's state.
   * @param ports The ports of the trigger.
   */
  constructor(
    private readonly root: HTMLElement,
    private readonly popup: ChangePopup,
    private readonly ports: ChangePopupTriggerPorts,
  ) {}

  /**
   * Closes the popup unless the press is inside it, over the open change (either half of a replacement pair), or on
   * the action dialog, an overlay, or the search panel.
   *
   * Closes on pointerdown, which comes before mousedown, so that a toolbar press acts on the restored selection.
   *
   * @param event The press. Any button and modifiers.
   */
  handlePointerDown(event: Event): void {
    this.guard(() => {
      const marks = this.popup.readOpenMarks();
      const target = event.target instanceof Node ? event.target : null;
      if (marks.length === 0 || this.popup.contains(target)) {
        return;
      }
      // During the save round trip, a blank overlay covers the view in front, so a press aimed inside the popup also
      // hits the overlay. Closing then would lose the decision the user was about to make.
      if (this.ports.isInDialogOrOverlay(target) || this.ports.isInSearchPanel(target)) {
        return;
      }
      if (target !== null && marks.some((mark) => mark.contains(target))) {
        return;
      }
      this.popup.close({ kind: 'press', target });
    });
  }

  /**
   * On a primary-button click with no modifiers that makes no range, opens the nearest change around the pressed
   * position, unless the position is inside the annotated text of a comment. Does not move focus.
   *
   * @param event The click.
   */
  handleClick(event: MouseEvent): void {
    this.guard(() => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
        return;
      }
      if (readSelectionRange(this.root)?.collapsed === false) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Node) || findCommentAt(target, this.root, 'innermost') !== undefined) {
        return;
      }
      const change = findChangeAt(target, this.root);
      if (change !== undefined) {
        this.popup.open(change, false);
      }
    });
  }

  /**
   * Opens the nearest change around a collapsed caret and moves focus into the popup.
   *
   * Registered after the comment's Alt+Enter, which takes the key over inside a comment, so this runs only outside
   * comments.
   *
   * @param event The Alt+Enter keystroke.
   * @returns "Prevent default" inside a change, otherwise "pass".
   */
  handleOpen(event: KeyboardEvent): ShortcutOutcome {
    let outcome: ShortcutOutcome = 'preventDefault';
    this.guard(() => {
      const range = readSelectionRange(this.root);
      const change = range?.collapsed === true && findCommentAt(range.startContainer, this.root, 'innermost') === undefined
        ? findChangeAt(range.startContainer, this.root)
        : undefined;
      if (change === undefined) {
        outcome = 'pass';
        return;
      }
      if (event.isComposing || this.ports.isComposing() || this.ports.isInputStopped()) {
        return;
      }
      this.popup.open(change, true);
    });
    return outcome;
  }

  /**
   * The operation of the Escape shortcut aimed at the editor root. If the popup is open, closes it and takes over.
   *
   * If the same keystroke closed a toolbar popup, it does not take over, so one Escape closes only one thing.
   *
   * @param event The Escape keystroke.
   * @returns "Allow default" if it closed (the Escape default does not change the tree), otherwise "pass".
   */
  handleEscape(event: KeyboardEvent): ShortcutOutcome {
    if (this.popup.readOpenChange() === undefined || this.ports.wasPopupClosedBy(event)) {
      return 'pass';
    }
    this.guard(() => {
      this.popup.close({ kind: 'escape' });
    });
    return 'allowDefault';
  }

  /**
   * After a key operation in the editor root, closes if the selection start or end has left the open change. Either
   * half of a replacement pair counts as the open change.
   */
  handleKeyUp(): void {
    this.guard(() => {
      const marks = this.popup.readOpenMarks();
      if (marks.length === 0) {
        return;
      }
      // A selection that moved outside the editor root (such as into the popup) has not left the change.
      const range = readSelectionRange(this.root);
      const inside = (node: Node): boolean => marks.some((mark) => mark.contains(node));
      if (range === undefined || (inside(range.startContainer) && inside(range.endContainer))) {
        return;
      }
      this.popup.close({ kind: 'selection' });
    });
  }

  /**
   * On an edit notification, redraws and places again if the open change is still a mark in the tree, and closes
   * otherwise.
   *
   * A decision takes an inline mark out of the tree, or leaves an element in it without the attributes of the mark,
   * so this is also what closes the popup after a decision.
   */
  handleEdit(): void {
    this.guard(() => {
      const change = this.popup.readOpenChange();
      if (change === undefined) {
        return;
      }
      if (isChangeInTree(this.root, change) && readChangeKind(change) !== undefined) {
        this.popup.refresh();
      } else {
        this.popup.close({ kind: 'treeChange' });
      }
    });
  }

  /**
   * On mount completion, starts receiving the edit notifications of that editing session, and closes if open.
   *
   * The editing session is recreated on every document replacement and the subscription is lost, so this is called on
   * every mount, including the first. A mark carries no id, so nothing can point at the same change in the new tree.
   *
   * @param session The editing session of that mount. Only its edit notification registration is used.
   */
  handleMountCompleted(session: Pick<EditingSession, 'addEditListener'>): void {
    session.addEditListener(this.onEdit);
    this.guard(() => {
      if (this.popup.readOpenChange() !== undefined) {
        this.popup.close({ kind: 'treeChange' });
      }
    });
  }

  /** On scroll and on a change of the view size, places the popup again if it is open. */
  handleViewportChange(): void {
    this.guard(() => {
      this.popup.place();
    });
  }

  /**
   * Calls the handling of a trigger; an exception inside it is not thrown out, one diagnostic line is left and the
   * popup is closed.
   *
   * @param run The handling of the trigger.
   */
  private guard(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.ports.reportDiagnostic(`Could not handle a change popup trigger: ${String(error)}`);
      this.closeAfterFailure({ kind: 'failure' });
    }
  }

  /**
   * Closes after an exception. If closing fails too, leaves that line as well and ends.
   *
   * @param closure The closure.
   */
  private closeAfterFailure(closure: ChangePopupClosure): void {
    try {
      this.popup.close(closure);
    } catch (error) {
      this.ports.reportDiagnostic(`Could not close the change popup: ${String(error)}`);
    }
  }
}

/**
 * Attaches the trigger listeners and appends the Escape and Alt+Enter shortcuts to the shortcut receiver's list.
 *
 * Called after the comment popup trigger, so that the comment's Escape and Alt+Enter come first in the list and this
 * one runs only when they pass. The editor root and the shortcut receiver stay the same across document replacements,
 * so this is called only once, on the first mount.
 *
 * @param view The view's window.
 * @param root The editor root.
 * @param receiver The shortcut receiver.
 * @param popup The popup.
 * @param ports The ports of the trigger.
 * @returns The attached trigger.
 */
export function attachChangePopupTrigger(
  view: Window,
  root: HTMLElement,
  receiver: ShortcutReceiver,
  popup: ChangePopup,
  ports: ChangePopupTriggerPorts,
): ChangePopupTrigger {
  const trigger = new ChangePopupTrigger(root, popup, ports);
  view.document.addEventListener('pointerdown', (event) => trigger.handlePointerDown(event), true);
  root.addEventListener('click', (event) => trigger.handleClick(event));
  root.addEventListener('keyup', () => trigger.handleKeyUp());
  view.addEventListener('scroll', () => trigger.handleViewportChange(), true);
  view.addEventListener('resize', () => trigger.handleViewportChange());
  receiver.register({ key: COMMENT_ESCAPE_KEY, run: (event) => trigger.handleEscape(event) });
  receiver.register({ key: COMMENT_OPEN_KEY, run: (event) => trigger.handleOpen(event) });
  return trigger;
}
