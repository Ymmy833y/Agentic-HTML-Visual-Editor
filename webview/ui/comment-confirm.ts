import type { Localizer, MessageKey } from '../../common/index';
import { isCommentInTree } from '../editing/comment-read';
import { hasAiEntry, isAiEntry } from '../editing/comment-thread-read';
import type { ActionDialogResult, ActionDialogSpec } from './action-dialog';

/**
 * Operations that may need confirmation.
 *
 * Adding and toggling the resolved state do not overwrite the other party's entries, so they are not included.
 */
export type CommentConfirmTarget =
  | { readonly kind: 'editEntry'; readonly entry: Element }
  | { readonly kind: 'deleteEntry'; readonly entry: Element }
  | { readonly kind: 'deleteComment'; readonly comment: Element };

/**
 * Ports for confirmation.
 *
 * None of them holds a value; each is read on every call, because the popup may open or close and the tree may
 * change while the confirmation is shown.
 */
export interface CommentConfirmPorts {
  /** Localizer. */
  readonly localizer: Localizer;

  /**
   * Opens an action dialog and waits for the result.
   *
   * @param spec Action dialog spec.
   */
  openDialog(spec: ActionDialogSpec): Promise<ActionDialogResult>;

  /** Returns the comment the popup has open. `undefined` when it is not open. */
  readOpenComment(): Element | undefined;

  /** Returns the editor root. `undefined` before mounting. */
  readEditorRoot(): Element | undefined;
}

// Confirmation messages for each target. The confirm label reuses the operation name (edit, delete) as it is, without
// a separate key.
const CONFIRM_MESSAGE_KEYS: Readonly<Record<CommentConfirmTarget['kind'], {
  readonly title: MessageKey;
  readonly confirmation: MessageKey;
  readonly confirmLabel: MessageKey;
}>> = {
  editEntry: {
    title: 'commentThread.confirmEditTitle',
    confirmation: 'commentThread.confirmEditMessage',
    confirmLabel: 'commentThread.editEntry',
  },
  deleteEntry: {
    title: 'commentThread.confirmDeleteEntryTitle',
    confirmation: 'commentThread.confirmDeleteEntryMessage',
    confirmLabel: 'commentThread.deleteEntry',
  },
  deleteComment: {
    title: 'commentThread.confirmDeleteCommentTitle',
    confirmation: 'commentThread.confirmDeleteCommentMessage',
    confirmLabel: 'commentThread.deleteEntry',
  },
};

/**
 * Asks for confirmation before an operation that touches an AI entry, and returns whether to go on.
 *
 * This keeps the user from overwriting annotations the other party wrote by mistake. Only editing or deleting an AI
 * entry, and deleting a comment that contains an AI entry, are covered. Even after confirming, it does not go on if
 * the popup has moved to another comment or the target has disappeared by the time the result returns. Going on
 * would rewrite a target other than the one the user confirmed.
 *
 * @param ports Ports for confirmation.
 * @param target Operation and target.
 * @returns `true` to go on. For a target that needs no confirmation, `true` without opening a dialog.
 */
export async function confirmCommentOperation(
  ports: CommentConfirmPorts,
  target: CommentConfirmTarget,
): Promise<boolean> {
  const needed = target.kind === 'deleteComment' ? hasAiEntry(target.comment) : isAiEntry(target.entry);
  if (!needed) {
    return true;
  }

  const comment = target.kind === 'deleteComment' ? target.comment : target.entry.parentElement;
  const keys = CONFIRM_MESSAGE_KEYS[target.kind];
  const localizer = ports.localizer;
  const result = await ports.openDialog({
    title: localizer.getMessage(keys.title),
    fields: [],
    confirmation: localizer.getMessage(keys.confirmation),
    confirmLabel: localizer.getMessage(keys.confirmLabel),
    cancelLabel: localizer.getMessage('commentThread.cancel'),
  });
  if (!result.confirmed) {
    return false;
  }

  const root = ports.readEditorRoot();
  if (comment === null || root === undefined || ports.readOpenComment() !== comment || !isCommentInTree(root, comment)) {
    return false;
  }
  return target.kind === 'deleteComment' || target.entry.parentElement === comment;
}
