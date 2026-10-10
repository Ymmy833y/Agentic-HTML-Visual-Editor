import {
  COMMENT_ATTRIBUTE,
  COMMENT_AUTHOR,
  COMMENT_ENTRY_EDITABLE_VALUE,
  COMMENT_TAG_NAME,
} from '../../common/index';
import type { EncodedSelection } from '../../common/index';
import type { BlockRewriteProgress } from './block-format';
import { isCommentInTree, readCommentEntries } from './comment-read';
import { serializeWithSelectionMarkers } from '../selection/selection-capture';
import { toEncodedPosition } from '../selection/selection-position';
import type { NodeBoundary } from '../selection/selection-position';

/**
 * Edit kinds for rewriting a thread.
 *
 * They are spelled differently from typing and deletion, so that the history treats them as standalone edits
 * instead of grouping them with the surrounding input.
 */
export const COMMENT_THREAD_EDIT_KIND = {
  entry: 'comment:entry',
  resolve: 'comment:resolve',
  remove: 'comment:delete',
} as const;

/** One committed entry write. Adding a body, adding a reply, editing or deleting. */
export type CommentEntryWrite =
  | { readonly kind: 'addBody'; readonly comment: Element; readonly text: string }
  | { readonly kind: 'addReply'; readonly comment: Element; readonly text: string }
  | { readonly kind: 'edit'; readonly entry: Element; readonly text: string }
  | { readonly kind: 'delete'; readonly entry: Element };

/**
 * Result of one entry write.
 *
 * `blocked` means input is stopped or the attempt could not start; `failed` means the target is not in the tree or
 * an exception prevented the write. On `blocked`, the caller can keep the input and write it again later.
 */
export type CommentWriteOutcome = 'written' | 'blocked' | 'failed';

/**
 * Ports for rewriting a thread.
 *
 * None of them holds a value; each is read on every call, because document replacement switches the editing session.
 */
export interface CommentThreadWritePorts {
  /** Returns the editor root. `undefined` before mounting. */
  readEditorRoot(): Element | undefined;

  /** Returns whether an input stop reason remains. */
  isInputStopped(): boolean;

  /** Command path. Closes the attempt as completed only when the tree was changed. */
  runCommandEdit(kind: string, command: () => boolean): boolean;

  /** Returns the current date and time. */
  readNow(): Date;

  /**
   * Requests a return to the editor root.
   *
   * @param selection Selection to restore. When omitted, the selection is left untouched.
   */
  requestReturn(selection?: EncodedSelection): void;

  /**
   * Records one diagnostic line for maintainers. Not used to notify the user.
   *
   * @param detail Line to record.
   */
  reportDiagnostic(detail: string): void;
}

/**
 * Writes a set of committed entries in one edit attempt, in the order given.
 *
 * Committing several inputs on close or switch is also grouped into one attempt. Splitting one user operation into
 * several undo units would take several undos to get back to the state before closing. Exceptions while writing are
 * not thrown out; throwing would close the attempt as aborted, and the changed tree would not reach change detection.
 *
 * @param ports Ports for rewriting a thread.
 * @param writes Set of writes (one or more).
 * @returns Result for each input, in the order given.
 */
export function writeCommentEntries(
  ports: CommentThreadWritePorts,
  writes: readonly CommentEntryWrite[],
): CommentWriteOutcome[] {
  if (ports.isInputStopped()) {
    return writes.map(() => 'blocked');
  }

  // When the attempt cannot start, the rewrite is never called. The results then stay uncreated, and all are blocked.
  let outcomes: CommentWriteOutcome[] | undefined;
  ports.runCommandEdit(COMMENT_THREAD_EDIT_KIND.entry, () => {
    const results: CommentWriteOutcome[] = [];
    outcomes = results;
    const progress: BlockRewriteProgress = { changed: false };
    try {
      // Read only once per call. The writes in the set share one update time, so the value also shows they were
      // written by one operation.
      const updated = ports.readNow().toISOString();
      const root = ports.readEditorRoot();
      for (const write of writes) {
        if (root === undefined || !isTargetInTree(root, write)) {
          ports.reportDiagnostic(`Did not write because the target comment is not in the tree (${write.kind})`);
          results.push('failed');
          continue;
        }
        applyEntryWrite(write, updated, progress);
        results.push('written');
      }
    } catch (error) {
      ports.reportDiagnostic(`Could not finish writing the entries: ${String(error)}`);
      while (results.length < writes.length) {
        results.push('failed');
      }
    }
    return progress.changed;
  });
  return outcomes ?? writes.map(() => 'blocked');
}

/**
 * Flips the resolved state of a comment in one edit attempt.
 *
 * The resolved state changes only by the user's toggle, so the author and update time of the entries are left
 * untouched.
 *
 * @param ports Ports for rewriting a thread.
 * @param comment Comment.
 * @returns Whether the tree was changed. `false` when input is stopped, the attempt cannot start, or the comment is
 *   not in the tree.
 */
export function toggleCommentResolved(ports: CommentThreadWritePorts, comment: Element): boolean {
  const root = ports.readEditorRoot();
  if (ports.isInputStopped() || root === undefined || !isCommentInTree(root, comment)) {
    return false;
  }
  return ports.runCommandEdit(COMMENT_THREAD_EDIT_KIND.resolve, () => {
    const progress: BlockRewriteProgress = { changed: false };
    try {
      if (comment.hasAttribute(COMMENT_ATTRIBUTE.resolved)) {
        comment.removeAttribute(COMMENT_ATTRIBUTE.resolved);
      } else {
        comment.setAttribute(COMMENT_ATTRIBUTE.resolved, '');
      }
      progress.changed = true;
    } catch (error) {
      ports.reportDiagnostic(`Could not finish toggling the resolved state: ${String(error)}`);
    }
    return progress.changed;
  });
}

/**
 * Removes a comment together with its entries, leaving the annotated text in its original place.
 *
 * Exceptions are not caught here; they are left to the caller.
 *
 * @param comment Comment.
 * @param progress Record of whether the tree was changed. Set to true when moving the annotated text starts.
 * @returns Boundary at the end of the kept annotated text (where the comment was).
 */
export function unwrapComment(comment: Element, progress: BlockRewriteProgress): NodeBoundary {
  const parent = comment.parentNode;
  if (parent === null) {
    throw new Error('The comment to remove has no parent');
  }
  const entries = new Set<Node>(readCommentEntries(comment));
  const annotated = [...comment.childNodes].filter((child) => !entries.has(child));
  progress.changed = true;
  // Nested comments (hand-written) move along as children of the annotated text, so only this comment is removed.
  for (const child of annotated) {
    parent.insertBefore(child, comment);
  }
  const offset = [...parent.childNodes].indexOf(comment);
  comment.remove();
  return { container: parent, offset };
}

/**
 * Removes a comment in one edit attempt, keeping the annotated text, and requests a return to the editor root at the
 * end of the kept annotated text.
 *
 * Removing closes the popup through the tree change, which returns to the editor root without a selection and
 * makes the caret jump to the start of the editor root. To avoid that, a return with a selection at the end is
 * requested after the attempt closes. Only the return handler moves the selection and focus.
 *
 * @param ports Ports for rewriting a thread.
 * @param comment Comment.
 * @returns Whether it was removed. `false` when input is stopped, the attempt cannot start, the comment is not in the
 *   tree, or an exception prevented finishing the removal.
 */
export function removeComment(ports: CommentThreadWritePorts, comment: Element): boolean {
  const root = ports.readEditorRoot();
  if (ports.isInputStopped() || root === undefined || !isCommentInTree(root, comment)) {
    return false;
  }

  let boundary: NodeBoundary | undefined;
  ports.runCommandEdit(COMMENT_THREAD_EDIT_KIND.remove, () => {
    const progress: BlockRewriteProgress = { changed: false };
    try {
      boundary = unwrapComment(comment, progress);
    } catch (error) {
      ports.reportDiagnostic(`Could not finish removing the comment: ${String(error)}`);
    }
    return progress.changed;
  });
  if (boundary === undefined) {
    return false;
  }
  ports.requestReturn(readCollapsedSelection(ports, root, boundary));
  return true;
}

/**
 * Writes one entry to the tree.
 *
 * @param write Write.
 * @param updated Update time value.
 * @param progress Record of whether the tree was changed. Set to true right before touching the tree.
 */
function applyEntryWrite(write: CommentEntryWrite, updated: string, progress: BlockRewriteProgress): void {
  switch (write.kind) {
    case 'addBody':
    case 'addReply': {
      const entries = readCommentEntries(write.comment);
      // Never make two bodies. If a body arrived through reattaching, add the input as a reply so its text is not lost.
      const asBody = write.kind === 'addBody'
        && !entries.some((entry) => entry.localName === COMMENT_TAG_NAME.body);
      const created = createEntry(
        write.comment.ownerDocument,
        asBody ? COMMENT_TAG_NAME.body : COMMENT_TAG_NAME.reply,
        write.text,
        updated,
      );
      // A body goes before the first entry and a reply after the last entry; existing children out of order are
      // not moved. Without entries, both go at the end of the comment.
      const reference = asBody ? (entries.at(0) ?? null) : (entries.at(-1)?.nextSibling ?? null);
      progress.changed = true;
      write.comment.insertBefore(created, reference);
      return;
    }
    case 'edit':
      progress.changed = true;
      write.entry.replaceChildren(write.text);
      // The author is not changed. Moving it to the human side would let an AI entry, once edited, be overwritten
      // next time without confirmation.
      write.entry.setAttribute(COMMENT_ATTRIBUTE.updated, updated);
      return;
    case 'delete':
      progress.changed = true;
      write.entry.remove();
      return;
  }
}

/**
 * Creates the element of an entry to add.
 *
 * @param document Document of the editor root.
 * @param tagName Element name of a body or a reply.
 * @param text Raw input.
 * @param updated Update time value.
 * @returns Created entry.
 */
function createEntry(document: Document, tagName: string, text: string, updated: string): Element {
  const entry = document.createElement(tagName);
  entry.setAttribute(COMMENT_ATTRIBUTE.editable, COMMENT_ENTRY_EDITABLE_VALUE);
  entry.setAttribute(COMMENT_ATTRIBUTE.author, COMMENT_AUTHOR.human);
  entry.setAttribute(COMMENT_ATTRIBUTE.updated, updated);
  entry.append(text);
  return entry;
}

/**
 * Returns whether the target comment of a write is in the tree.
 *
 * @param root Editor root.
 * @param write Write.
 * @returns `true` when the comment (for an addition) or the parent comment of the entry (for an edit or deletion)
 *   is in the tree.
 */
function isTargetInTree(root: Element, write: CommentEntryWrite): boolean {
  if (write.kind === 'addBody' || write.kind === 'addReply') {
    return isCommentInTree(root, write.comment);
  }
  const parent = write.entry.parentElement;
  return parent !== null && parent.localName === COMMENT_TAG_NAME.comment && isCommentInTree(root, parent);
}

/**
 * Encodes a boundary as a selection whose start and end are the same.
 *
 * @param ports Ports for rewriting a thread.
 * @param root Editor root.
 * @param boundary Boundary.
 * @returns Selection. `undefined` when it cannot be encoded (a return is then requested without a selection).
 */
function readCollapsedSelection(
  ports: CommentThreadWritePorts,
  root: Element,
  boundary: NodeBoundary,
): EncodedSelection | undefined {
  try {
    const markers = serializeWithSelectionMarkers(root, [boundary]);
    const offset = markers?.offsets.at(0);
    if (markers === undefined || offset === undefined) {
      return undefined;
    }
    const position = toEncodedPosition(markers.text, offset);
    return { start: position, end: position };
  } catch (error) {
    // The attempt is already closed, so the removal cannot be undone. Returning without a selection at least
    // brings the focus back.
    ports.reportDiagnostic(`Could not create the selection after the removal: ${String(error)}`);
    return undefined;
  }
}
