import type { EncodedSelection, Localizer } from '../../common/index';
import { removeComment, toggleCommentResolved, writeCommentEntries } from '../editing/comment-thread-write';
import type { CommentThreadWritePorts } from '../editing/comment-thread-write';
import type { ActionDialogResult, ActionDialogSpec } from './action-dialog';
import { confirmCommentOperation } from './comment-confirm';
import type { CommentConfirmPorts } from './comment-confirm';
import { moveToAdjacentComment, readAdjacentComments } from './comment-navigation';
import type { AdjacentComments, CommentMoveDirection, CommentNavigationPorts } from './comment-navigation';
import type { CommentPopup, CommentPopupContent, CommentPopupDeparture } from './comment-popup';
import { CommentThreadInputs } from './comment-thread-input';
import { CommentThreadView } from './comment-thread-view';

/**
 * Ports used by the thread content.
 *
 * None of them holds a value; each is read on every call. Document replacement switches the editing session, and
 * input stop and the action dialog change from moment to moment.
 */
export interface CommentThreadPorts {
  /** Localizer. */
  readonly localizer: Localizer;

  /**
   * Turns a date and time into local notation.
   *
   * @param date Date and time.
   */
  formatDate(date: Date): string;

  /**
   * Registers a tooltip on a control.
   *
   * @param target Control.
   * @param label Tooltip message.
   */
  registerTooltip(target: Element, label: string): void;

  /** Returns whether an input stop reason remains. */
  isInputStopped(): boolean;

  /** Command path. Closes the attempt as completed only when the tree was changed. */
  runCommandEdit(kind: string, command: () => boolean): boolean;

  /** Returns the current date and time. */
  readNow(): Date;

  /**
   * Opens an action dialog and waits for the result.
   *
   * @param spec Action dialog spec.
   */
  openDialog(spec: ActionDialogSpec): Promise<ActionDialogResult>;

  /**
   * Requests a return to the editor root.
   *
   * @param selection Selection to restore. When omitted, the selection is left untouched.
   */
  requestReturn(selection?: EncodedSelection): void;

  /**
   * Opens a closed details section as one edit.
   *
   * @param section Details section.
   * @returns Whether the tree was changed.
   */
  openDetails(section: Element): boolean;

  /**
   * Records one diagnostic line for maintainers. Not used to notify the user.
   *
   * @param detail Line to record.
   */
  reportDiagnostic(detail: string): void;
}

/**
 * Content registered on the comment popup.
 *
 * Routes the popup's notifications and the user's operations to drawing, inputs, rewriting, confirmation and moving.
 * Holds one thread view and one set of inputs, exists once per view, and is not recreated on document replacement.
 */
export class CommentThread implements CommentPopupContent {
  private readonly inputs: CommentThreadInputs;
  private readonly writePorts: CommentThreadWritePorts;
  private readonly confirmPorts: CommentConfirmPorts;
  private readonly navigationPorts: CommentNavigationPorts;
  private view: CommentThreadView | undefined;

  /**
   * @param view Window of the view.
   * @param root Editor root.
   * @param popup Comment popup.
   * @param ports Ports used by the thread content.
   */
  constructor(
    view: Window,
    private readonly root: HTMLElement,
    private readonly popup: CommentPopup,
    private readonly ports: CommentThreadPorts,
  ) {
    this.writePorts = {
      readEditorRoot: () => root,
      isInputStopped: () => ports.isInputStopped(),
      runCommandEdit: (kind, command) => ports.runCommandEdit(kind, command),
      readNow: () => ports.readNow(),
      requestReturn: (selection) => ports.requestReturn(selection),
      reportDiagnostic: (detail) => ports.reportDiagnostic(detail),
    };
    this.confirmPorts = {
      localizer: ports.localizer,
      openDialog: (spec) => ports.openDialog(spec),
      readOpenComment: () => popup.readOpenComment(),
      readEditorRoot: () => root,
    };
    this.navigationPorts = {
      readOpenComment: () => popup.readOpenComment(),
      isInputStopped: () => ports.isInputStopped(),
      commitInputs: () => this.inputs.commitAll(),
      openDetails: (section) => ports.openDetails(section),
      switchTo: (comment) => popup.switchTo(comment),
      reportDiagnostic: (detail) => ports.reportDiagnostic(detail),
    };
    this.inputs = new CommentThreadInputs(view.document, ports.localizer, {
      isInputStopped: () => ports.isInputStopped(),
      writeEntries: (writes) => writeCommentEntries(this.writePorts, writes),
      confirm: (target) => confirmCommentOperation(this.confirmPorts, target),
      readOpenComment: () => popup.readOpenComment(),
      requestRedraw: () => this.redraw(),
      reportDiagnostic: (detail) => ports.reportDiagnostic(detail),
    });
  }

  /**
   * Creates the thread view with the element and the entries container received from the popup. Called only once,
   * on registration.
   *
   * @param element Popup element.
   * @param entries Entries container.
   */
  attach(element: HTMLElement, entries: HTMLElement): void {
    this.view = new CommentThreadView(element, entries, this.inputs.readState(), {
      localizer: this.ports.localizer,
      formatDate: (date) => this.ports.formatDate(date),
      registerTooltip: (target, label) => this.ports.registerTooltip(target, label),
      move: (direction) => this.move(direction),
      toggleResolved: () => this.toggleResolved(),
      deleteComment: () => {
        void this.deleteComment();
      },
      editEntry: (entry) => {
        void this.inputs.startEdit(entry);
      },
      deleteEntry: (entry) => {
        void this.deleteEntry(entry);
      },
      save: (field) => this.inputs.commit(field),
      cancel: (field) => {
        this.inputs.cancel(field);
      },
    });
  }

  /**
   * On opening, before placing, finds whether move targets exist and draws.
   *
   * Exceptions while drawing are not caught here. The popup records them in the diagnostics and closes.
   *
   * @param comment Comment to open.
   */
  handleOpening(comment: Element): void {
    this.render(comment);
  }

  /**
   * Once focus has moved and opening has finished, focuses the requested input field.
   *
   * @param comment Opened comment.
   * @param preferReply Whether to focus the reply field instead of the body field for a comment without a body.
   */
  handleOpened(comment: Element, preferReply = false): void {
    if (preferReply) {
      this.inputs.focusReplyField(comment);
    } else {
      this.inputs.focusBodyField(comment);
    }
  }

  /**
   * Redraws for a tree change, keeping the inputs. An edit of an entry that has disappeared is discarded.
   *
   * @param comment Open comment.
   */
  handleRefresh(comment: Element): void {
    this.inputs.dropMissingEdit(this.root);
    this.render(comment);
  }

  /**
   * After document replacement, moves the inputs to the new tree or discards them, then redraws.
   *
   * Called during document replacement. Focus is not moved away from the field.
   *
   * @param comment Comment in the new tree.
   */
  handleReattached(comment: Element): void {
    this.inputs.reattach(comment);
    this.render(comment);
  }

  /**
   * When the popup has left the open comment, commits or discards the inputs.
   *
   * Leaving by a user operation commits them. Closing by a tree change or an exception happens inside another edit
   * attempt, and writing there would nest attempts, so the inputs are discarded.
   *
   * @param departure Departure.
   */
  handleDeparted(departure: CommentPopupDeparture): void {
    switch (departure.kind) {
      case 'escape':
      case 'press':
      case 'selection':
      case 'switch':
        this.inputs.commitAll();
        return;
      case 'treeChange':
      case 'failure':
        this.inputs.discardAll();
        return;
    }
  }

  /**
   * Receives keys inside the popup.
   *
   * Keys in a field go to the inputs. Outside the fields, unmodified ↑ and ← move to the previous comment, and ↓ and
   * → to the next. Arrows inside a field move the caret within the field, so they are not taken over.
   *
   * @param event Pressed key.
   * @returns Whether the key was taken over.
   */
  handleKeyDown(event: KeyboardEvent): boolean {
    if (this.inputs.handleKeyDown(event)) {
      return true;
    }
    const state = this.inputs.readState();
    const target = event.target;
    if (target === state.body.field || target === state.reply.field || target === state.edit.field) {
      return false;
    }
    const direction = readMoveDirection(event);
    if (direction === undefined) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    this.move(direction);
    return true;
  }

  /**
   * Deletes an entry. An AI entry is deleted only when confirmed. Inputs in progress are kept.
   *
   * @param entry Entry.
   */
  async deleteEntry(entry: Element): Promise<void> {
    if (!(await confirmCommentOperation(this.confirmPorts, { kind: 'deleteEntry', entry }))) {
      return;
    }
    writeCommentEntries(this.writePorts, [{ kind: 'delete', entry }]);
  }

  /**
   * Toggles the resolved state of the open comment. Resolving is a human operation, so no confirmation is asked even
   * for an AI thread.
   */
  toggleResolved(): void {
    const comment = this.popup.readOpenComment();
    if (comment !== undefined) {
      toggleCommentResolved(this.writePorts, comment);
    }
  }

  /**
   * Removes the open comment. If it contains an AI entry, it is removed only when confirmed.
   *
   * The inputs are discarded on the notification that the popup closed through the tree change of the removal.
   */
  async deleteComment(): Promise<void> {
    const comment = this.popup.readOpenComment();
    if (comment === undefined) {
      return;
    }
    if (!(await confirmCommentOperation(this.confirmPorts, { kind: 'deleteComment', comment }))) {
      return;
    }
    removeComment(this.writePorts, comment);
  }

  /**
   * Returns whether focus is in one of this feature's fields.
   *
   * Used for the document replacement decision. If a selection is placed in the editor root while the user is writing
   * in a field, the following keystrokes are lost, entering neither the field nor the document.
   *
   * @returns `true` when focus is in a field.
   */
  isInputFocused(): boolean {
    return this.inputs.hasFocus();
  }

  /**
   * Returns the entry represented by the entry text that contains the node.
   *
   * Used to open editing of an entry when its text in the popup is clicked.
   *
   * @param node The node.
   * @returns The entry. `undefined` when there is no thread view or the node is outside any entry text.
   */
  readEntryAt(node: Node): Element | undefined {
    return this.view?.readEntryAt(node);
  }

  /**
   * Starts editing an entry. Opens it through the same path as pressing the entry's edit control, with a confirmation for AI entries.
   *
   * Does not wait for the confirmation result. The caller is the click handler and does not use the result.
   *
   * @param entry The entry.
   */
  startEdit(entry: Element): void {
    void this.inputs.startEdit(entry);
  }

  /**
   * Moves to the previous or next comment.
   *
   * @param direction Move direction.
   */
  private move(direction: CommentMoveDirection): void {
    moveToAdjacentComment(this.root, direction, this.navigationPorts);
  }

  /**
   * Finds whether move targets exist and draws.
   *
   * An exception while looking up move targets does not stop drawing; it draws as if neither exists.
   *
   * @param comment Open comment.
   */
  private render(comment: Element): void {
    const view = this.view;
    if (view === undefined) {
      return;
    }
    let adjacent: AdjacentComments;
    try {
      adjacent = readAdjacentComments(this.root, comment);
    } catch (error) {
      this.ports.reportDiagnostic(`Could not find the adjacent comments: ${String(error)}`);
      adjacent = { previous: undefined, next: undefined };
    }
    view.render(comment, adjacent, this.inputs.readState());
  }

  /**
   * Redraws after the input state has changed, and places the popup again because its size may have changed. Does
   * nothing when the popup is closed.
   *
   * Exceptions while drawing are not thrown out. This is called from field events, so nobody would catch them.
   */
  private redraw(): void {
    const comment = this.popup.readOpenComment();
    if (comment === undefined) {
      return;
    }
    try {
      this.render(comment);
    } catch (error) {
      this.ports.reportDiagnostic(`Could not redraw the comment thread: ${String(error)}`);
      this.popup.close({ kind: 'failure' });
      return;
    }
    this.popup.place();
  }
}

/**
 * Creates the content and registers it on the popup.
 *
 * Called only once, on the first mount. Neither the popup nor the editor root is recreated on document replacement,
 * so it is not registered again.
 *
 * @param view Window of the view.
 * @param root Editor root.
 * @param popup Comment popup.
 * @param ports Ports used by the thread content.
 * @returns Registered content.
 */
export function attachCommentThread(
  view: Window,
  root: HTMLElement,
  popup: CommentPopup,
  ports: CommentThreadPorts,
): CommentThread {
  const thread = new CommentThread(view, root, popup, ports);
  popup.registerContent(thread);
  return thread;
}

/**
 * Returns the direction for a move key.
 *
 * Arrows with modifiers are other operations such as extending a selection, so they do not move.
 *
 * @param event Pressed key.
 * @returns Direction. `undefined` when it is not a move key.
 */
function readMoveDirection(event: KeyboardEvent): CommentMoveDirection | undefined {
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
    return undefined;
  }
  switch (event.key) {
    case 'ArrowUp':
    case 'ArrowLeft':
      return 'previous';
    case 'ArrowDown':
    case 'ArrowRight':
      return 'next';
    default:
      return undefined;
  }
}
