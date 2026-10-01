import { readSelectionRange } from '../editing/caret';
import { findCommentAt, findCommentById, isCommentInTree, isInAnnotatedText } from '../editing/comment-read';
import type { EditingSession } from '../editing/editing-session';
import type { ShortcutKey, ShortcutOutcome, ShortcutReceiver } from '../editing/shortcut-receiver';
import type { CommentPopup, CommentPopupClosure } from './comment-popup';

/**
 * The shortcut key of the Escape that closes the popup in the editor root.
 *
 * Matched by position (Escape) with no modifiers. Escape with modifiers is a different operation and does not match.
 */
export const COMMENT_ESCAPE_KEY: ShortcutKey = { code: 'Escape', primary: false, shift: false, alt: false };

/** Ports of the trigger. They hold no values and are read on every call. */
export interface CommentPopupTriggerPorts {
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
 * Receives pointer, key, tree change and scroll events and decides whether to open, close, redraw, place again or reattach the popup.
 *
 * Exceptions inside each listener are not thrown out; one diagnostic line is left and the popup is closed. Throwing would
 * stop scheduling the body output and completing the attempt for edit notifications, and the remaining steps for document
 * replacement. One per view; not recreated on document replacement.
 */
export class CommentPopupTrigger {
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
    private readonly popup: CommentPopup,
    private readonly ports: CommentPopupTriggerPorts,
  ) {}

  /**
   * Closes the popup unless the press is inside it, over the annotated text of the open comment, or on the action
   * dialog, an overlay, or the search panel.
   *
   * Closes on pointerdown, which comes before mousedown. A toolbar press prevents the mousedown default and does not move
   * focus, so the return to the editor root is done before that, and the pressed item's operation acts on the restored selection.
   *
   * @param event The press. Any button and modifiers.
   */
  handlePointerDown(event: Event): void {
    this.guard(() => {
      const comment = this.popup.readOpenComment();
      const target = event.target instanceof Node ? event.target : null;
      if (comment === undefined || this.popup.contains(target)) {
        return;
      }
      // Closing on a press of a confirmation button would lose the operation that continues after confirming. During
      // the save round trip, a blank overlay covers the view in front, so a press aimed inside the popup also hits the
      // overlay. Closing then would discard the inputs being written without writing them.
      if (this.ports.isInDialogOrOverlay(target)) {
        return;
      }
      // Search opens the popup to show a match on a comment id. Closing on a press of the search panel would close the
      // comment it has just shown.
      if (this.ports.isInSearchPanel(target)) {
        return;
      }
      if (target !== null && isInAnnotatedText(target, comment)) {
        return;
      }
      this.popup.close({ kind: 'press', target });
    });
  }

  /**
   * On a primary-button click with no modifiers that makes no range, opens the innermost comment at the pressed position.
   * Does not move focus.
   *
   * A click with modifiers is a different operation, such as following a link. On a double click, the first click (which
   * makes no range) opens it, and the second, which selects a word and makes a range, neither closes nor reopens it.
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
      if (!(target instanceof Node)) {
        return;
      }
      const comment = findCommentAt(target, this.root, 'innermost');
      if (comment !== undefined) {
        this.popup.open(comment, false);
      }
    });
  }

  /**
   * The operation of the Escape shortcut aimed at the editor root. If the popup is open, closes it and takes over.
   *
   * If the same keystroke closed a toolbar popup, it does not take over, so one Escape closes only one thing. When it does
   * not take over, the Escape goes on to the cell range's Escape, registered later.
   *
   * @param event The Escape keystroke.
   * @returns "Allow default" if it closed (the Escape default does not change the tree), otherwise "pass".
   */
  handleEscape(event: KeyboardEvent): ShortcutOutcome {
    if (this.popup.readOpenComment() === undefined || this.ports.wasPopupClosedBy(event)) {
      return 'pass';
    }
    this.guard(() => {
      this.popup.close({ kind: 'escape' });
    });
    return 'allowDefault';
  }

  /** After a key operation in the editor root, closes if the selection start or end has left the open comment's annotated text. */
  handleKeyUp(): void {
    this.guard(() => {
      const comment = this.popup.readOpenComment();
      if (comment === undefined) {
        return;
      }
      // A selection that moved outside the editor root (such as into the popup) has not left the comment.
      const range = readSelectionRange(this.root);
      if (range === undefined) {
        return;
      }
      if (isInAnnotatedText(range.startContainer, comment) && isInAnnotatedText(range.endContainer, comment)) {
        return;
      }
      this.popup.close({ kind: 'selection' });
    });
  }

  /**
   * On an edit notification, redraws and places again if the open comment is in the tree, and closes otherwise.
   *
   * Done synchronously inside the notification. The popup reads from the tree each time, so without a redraw the shown entries would disagree with the tree.
   */
  handleEdit(): void {
    this.guard(() => {
      const comment = this.popup.readOpenComment();
      if (comment === undefined) {
        return;
      }
      if (isCommentInTree(this.root, comment)) {
        this.popup.refresh();
      } else {
        this.popup.close({ kind: 'treeChange' });
      }
    });
  }

  /**
   * On mount completion, starts receiving the edit notifications of that editing session, and reattaches or closes if open.
   *
   * The editing session is recreated on every document replacement and the subscription is lost, so this is called on every
   * mount, including the first. Only the ID can point at the same comment across a replacement, so it reattaches only when
   * exactly one comment has the same ID.
   *
   * @param session The editing session of that mount. Only its edit notification registration is used.
   */
  handleMountCompleted(session: Pick<EditingSession, 'addEditListener'>): void {
    session.addEditListener(this.onEdit);
    this.guard(() => {
      const comment = this.popup.readOpenComment();
      if (comment === undefined) {
        return;
      }
      const id = comment.getAttribute('id');
      const next = id === null ? undefined : findCommentById(this.root, id);
      if (next === undefined) {
        this.popup.close({ kind: 'treeChange' });
      } else {
        this.popup.reattach(next);
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
   * Calls the handling of a trigger; an exception inside it is not thrown out, one diagnostic line is left and the popup is closed.
   *
   * @param run The handling of the trigger.
   */
  private guard(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.ports.reportDiagnostic(`Could not handle a comment popup trigger: ${String(error)}`);
      this.closeAfterFailure({ kind: 'failure' });
    }
  }

  /**
   * Closes after an exception. If closing fails too, leaves that line as well and ends.
   *
   * @param closure The closure.
   */
  private closeAfterFailure(closure: CommentPopupClosure): void {
    try {
      this.popup.close(closure);
    } catch (error) {
      this.ports.reportDiagnostic(`Could not close the comment popup: ${String(error)}`);
    }
  }
}

/**
 * Attaches the trigger listeners and appends the Escape shortcut to the shortcut receiver's list.
 *
 * Presses are received in the document's capture phase, so the popup can close even if another listener stops propagation.
 * Scrolling of inner elements does not bubble, so it is also received in the capture phase. The editor root and the
 * shortcut receiver stay the same across document replacements, so this is called only once, on the first mount.
 * Called before the cell range selection, so one Escape closes the popup first, then the cell range.
 *
 * @param view The view's window.
 * @param root The editor root.
 * @param receiver The shortcut receiver.
 * @param popup The popup.
 * @param ports The ports of the trigger.
 * @returns The attached trigger.
 */
export function attachCommentPopupTrigger(
  view: Window,
  root: HTMLElement,
  receiver: ShortcutReceiver,
  popup: CommentPopup,
  ports: CommentPopupTriggerPorts,
): CommentPopupTrigger {
  const trigger = new CommentPopupTrigger(root, popup, ports);
  view.document.addEventListener('pointerdown', (event) => trigger.handlePointerDown(event), true);
  root.addEventListener('click', (event) => trigger.handleClick(event));
  root.addEventListener('keyup', () => trigger.handleKeyUp());
  view.addEventListener('scroll', () => trigger.handleViewportChange(), true);
  view.addEventListener('resize', () => trigger.handleViewportChange());
  receiver.register({ key: COMMENT_ESCAPE_KEY, run: (event) => trigger.handleEscape(event) });
  return trigger;
}
