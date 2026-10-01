import { COMMENT_ATTRIBUTE, COMMENT_TAG_NAME } from '../../common/index';
import type { Localizer, MessageKey } from '../../common/index';
import { isHtmlWhitespaceOnly } from '../editing/block';
import { isCommentInTree, readCommentEntries } from '../editing/comment-read';
import { readEntryText } from '../editing/comment-thread-read';
import type { CommentEntryWrite, CommentWriteOutcome } from '../editing/comment-thread-write';
import type { CommentConfirmTarget } from './comment-confirm';

/** Input kind. Adding a body, adding a reply, or editing an entry. */
export type CommentThreadField = 'body' | 'reply' | 'edit';

/** How a commit is handled. End without writing, delete the entry, or write. */
export type CommentInputCommit = 'end' | 'delete' | 'write';

/**
 * Edit target.
 *
 * Holds values that let the same entry be found again in the new tree even when document replacement swaps the
 * elements.
 */
export interface CommentEditTarget {
  /** Entry being edited. */
  readonly entry: Element;
  /** Element name of the entry. */
  readonly tagName: string;
  /** Position among the direct entries of the comment. */
  readonly index: number;
  /** Value of `data-author`. `null` when missing. */
  readonly author: string | null;
  /** Text when the edit started. */
  readonly initialText: string;
}

/** Input state passed to the thread view. The thread view only places the field elements and never changes values. */
export interface CommentThreadInputState {
  readonly body: { readonly field: HTMLTextAreaElement; readonly active: boolean };
  readonly reply: { readonly field: HTMLTextAreaElement; readonly active: boolean };
  /** Edit field and the entry being edited. The entry is `undefined` when not editing. */
  readonly edit: { readonly field: HTMLTextAreaElement; readonly entry: Element | undefined };
}

/**
 * Ports of the inputs.
 *
 * None of them holds a value; each is read on every call, because input stop and the open comment change from moment
 * to moment.
 */
export interface CommentThreadInputPorts {
  /** Returns whether an input stop reason remains. */
  isInputStopped(): boolean;

  /**
   * Writes a set of committed entries in one edit attempt.
   *
   * @param writes Set of writes.
   * @returns Result for each input, in the order given.
   */
  writeEntries(writes: readonly CommentEntryWrite[]): readonly CommentWriteOutcome[];

  /**
   * Asks for confirmation when the target needs it.
   *
   * @param target Operation and target.
   * @returns Whether to go on.
   */
  confirm(target: CommentConfirmTarget): Promise<boolean>;

  /** Returns the comment the popup has open. `undefined` when it is not open. */
  readOpenComment(): Element | undefined;

  /** Redraws keeping the inputs, and places the popup again. Does nothing when the popup is closed. */
  requestRedraw(): void;

  /**
   * Records one diagnostic line for maintainers. Not used to notify the user.
   *
   * @param detail Line to record.
   */
  reportDiagnostic(detail: string): void;
}

// keyCode of a key the IME is processing. Some browsers deliver the key that starts a composition without
// isComposing set, so this is also used to tell it apart.
const IME_PROCESS_KEY_CODE = 229;

// Number of rows of a field. With one row, the lines around the caret are not visible when editing an entry that
// contains line breaks.
const FIELD_ROWS = 3;

// Order of committing on close or switch. The edit (including deleting a body emptied by editing) is written first.
// If the body addition came first, the body about to be deleted would still be there, and the added body would
// become a reply.
const COMMIT_ORDER: readonly CommentThreadField[] = ['edit', 'body', 'reply'];

/**
 * Holds the inputs being written in the popup that are not in the tree yet, and their three fields.
 *
 * There is one of each field per view, and they are never recreated. Recreating them would break focus, IME
 * composition and the selection in the field on every redraw. At most one edit input is held at a time.
 */
export class CommentThreadInputs {
  private readonly bodyField: HTMLTextAreaElement;
  private readonly replyField: HTMLTextAreaElement;
  private readonly editField: HTMLTextAreaElement;

  // Comment the inputs belong to. The popup clears its state before the close notification, so the open comment
  // cannot be looked up when committing.
  private comment: Element | undefined;
  private bodyActive = false;
  private replyActive = false;
  private edit: CommentEditTarget | undefined;

  /**
   * @param document Document of the view.
   * @param localizer Localizer.
   * @param ports Ports of the inputs.
   */
  constructor(
    private readonly document: Document,
    localizer: Localizer,
    private readonly ports: CommentThreadInputPorts,
  ) {
    this.bodyField = createField(document, localizer, 'commentThread.bodyField');
    this.replyField = createField(document, localizer, 'commentThread.replyField');
    this.editField = createField(document, localizer, 'commentThread.editField');
    this.bodyField.addEventListener('input', () => this.handleFieldInput('body'));
    this.replyField.addEventListener('input', () => this.handleFieldInput('reply'));
  }

  /**
   * Makes an addition input active or ends it, depending on whether its field has text.
   *
   * Input during composition is handled the same way. The field element is not detached on redraw, so redrawing does
   * not break the composition.
   *
   * @param field Body or reply field.
   */
  handleFieldInput(field: 'body' | 'reply'): void {
    const active = this.readField(field).value !== '';
    if (active === this.isActive(field)) {
      return;
    }
    if (active) {
      this.holdComment(this.ports.readOpenComment());
    }
    this.setAddActive(field, active);
    this.ports.requestRedraw();
  }

  /**
   * Starts editing an entry.
   *
   * If an edit of another entry is active, it is committed first. For an AI entry, the field opens only when
   * confirmed. Refusing after the user has finished writing would waste the input, so confirmation is asked at the
   * start.
   *
   * @param entry Entry to edit.
   * @returns Whether the edit field was opened.
   */
  async startEdit(entry: Element): Promise<boolean> {
    const current = this.edit;
    // Restarting the edit of the entry being edited would overwrite the typed text with the text at the start. Just
    // go back to the field.
    if (current?.entry === entry) {
      this.editField.focus();
      return true;
    }
    if (current !== undefined) {
      this.commit('edit');
      // If it could not be written because input is stopped, the earlier edit remains. To avoid holding two edit
      // inputs, the later edit is not started.
      if (this.edit !== undefined) {
        return false;
      }
    }
    if (!(await this.ports.confirm({ kind: 'editEntry', entry }))) {
      return false;
    }

    const comment = entry.parentElement;
    const initialText = readEntryText(entry);
    this.holdComment(comment ?? undefined);
    this.edit = {
      entry,
      tagName: entry.localName,
      index: comment === null ? -1 : readCommentEntries(comment).indexOf(entry),
      author: entry.getAttribute(COMMENT_ATTRIBUTE.author),
      initialText,
    };
    this.editField.value = initialText;
    this.ports.requestRedraw();
    this.editField.focus();
    return true;
  }

  /**
   * Commits an active field.
   *
   * While input is stopped, the commit is not accepted and the input is kept. The input is also kept when the write
   * attempt could not start and nothing was written.
   *
   * @param field Field to commit.
   */
  commit(field: CommentThreadField): void {
    if (!this.isActive(field) || this.ports.isInputStopped()) {
      return;
    }
    const write = this.readPendingWrite(field);
    // End the input before writing. The immediate notification of the write triggers a redraw, and if the input still
    // remained at that point, the edit of an entry deleted by emptying it would be discarded as an input whose target
    // has disappeared.
    const kept = this.detach(field);
    if (write !== undefined && this.ports.writeEntries([write])[0] === 'blocked') {
      this.restore(field, kept);
      return;
    }
    this.clearField(field);
    this.ports.requestRedraw();
  }

  /**
   * Cancels an active field without changing the tree. The popup stays open.
   *
   * @param field Field to cancel.
   * @returns Whether it was canceled. `false` when it is not active.
   */
  cancel(field: CommentThreadField): boolean {
    if (!this.isActive(field)) {
      return false;
    }
    this.detach(field);
    this.clearField(field);
    this.ports.requestRedraw();
    return true;
  }

  /**
   * Commits all active inputs in one edit attempt, as a set in the order edit, body, reply.
   *
   * Called on close and switch, and on moving to the previous or next comment. Inputs that could not be written are
   * not held back; they are discarded and recorded in the diagnostics.
   */
  commitAll(): void {
    if (!this.hasActiveInput()) {
      return;
    }
    const pending = COMMIT_ORDER.flatMap((field) => {
      const write = this.isActive(field) ? this.readPendingWrite(field) : undefined;
      return write === undefined ? [] : [{ field, write }];
    });
    this.endAll();
    if (pending.length > 0) {
      const outcomes = this.ports.writeEntries(pending.map((item) => item.write));
      pending.forEach((item, index) => {
        if (outcomes[index] !== 'written') {
          this.ports.reportDiagnostic(`Discarded the input (${item.field}) because it could not be written`);
        }
      });
    }
    this.ports.requestRedraw();
  }

  /**
   * Discards all active inputs without writing them.
   *
   * Closing by a tree change or an exception happens inside another edit attempt, and writing there would nest
   * attempts, so nothing is written. This is called after closing, so no redraw is requested.
   */
  discardAll(): void {
    if (!this.hasActiveInput()) {
      return;
    }
    this.endAll();
    this.ports.reportDiagnostic('Discarded the unwritten inputs because the popup closed by a tree change or an exception');
  }

  /**
   * After document replacement, reattaches the inputs to the comment in the new tree.
   *
   * Addition inputs are kept as inputs to the same comment. The edit moves its target when an entry of the same kind
   * at the same position has the same author and start text, and is discarded otherwise, so that the text being
   * written is not written to the tree from before the replacement.
   *
   * @param comment Comment in the new tree.
   */
  reattach(comment: Element): void {
    this.comment = comment;
    const edit = this.edit;
    if (edit === undefined) {
      return;
    }
    const entry = findReattachedEntry(comment, edit);
    if (entry === undefined) {
      this.detach('edit');
      this.clearField('edit');
      this.ports.reportDiagnostic('Discarded the edit input because the edit target was not found in the tree after document replacement');
      return;
    }
    this.edit = { ...edit, entry };
  }

  /**
   * Discards the edit input when the edit target has disappeared from the tree. Addition inputs are kept.
   *
   * @param root Editor root.
   */
  dropMissingEdit(root: Element): void {
    const edit = this.edit;
    if (edit === undefined) {
      return;
    }
    const comment = this.ports.readOpenComment();
    if (comment !== undefined && edit.entry.parentElement === comment && isCommentInTree(root, comment)) {
      return;
    }
    this.detach('edit');
    this.clearField('edit');
    this.ports.reportDiagnostic('Discarded the edit input because the edit target disappeared from the tree');
  }

  /**
   * Takes over Enter and Shift+Enter in a field, and Esc in an active field.
   *
   * Keys during composition commit or cancel the composition, so they are not handled. Esc in a field that is not
   * active is not taken over, and the popup closes.
   *
   * @param event Pressed key.
   * @returns Whether the key was taken over.
   */
  handleKeyDown(event: KeyboardEvent): boolean {
    const field = this.findField(event.target);
    if (field === undefined || event.isComposing || event.keyCode === IME_PROCESS_KEY_CODE) {
      return false;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return false;
    }
    if (event.key === 'Enter') {
      event.stopPropagation();
      if (event.shiftKey) {
        // Let the default handling through as a line break in the field.
        return true;
      }
      // Enter in an empty field is also taken over, so no line break goes into the field.
      event.preventDefault();
      this.commit(field);
      return true;
    }
    if (event.key === 'Escape' && !event.shiftKey && this.isActive(field)) {
      event.preventDefault();
      event.stopPropagation();
      this.cancel(field);
      return true;
    }
    return false;
  }

  /**
   * When a comment without a body is opened, moves focus to the body field, so that the user can start writing the
   * body right away.
   *
   * @param comment Opened comment.
   */
  focusBodyField(comment: Element): void {
    if (readCommentEntries(comment).some((entry) => entry.localName === COMMENT_TAG_NAME.body)) {
      return;
    }
    this.bodyField.focus();
  }

  /**
   * Returns the input state to the thread view.
   *
   * @returns Input state.
   */
  readState(): CommentThreadInputState {
    return {
      body: { field: this.bodyField, active: this.bodyActive },
      reply: { field: this.replyField, active: this.replyActive },
      edit: { field: this.editField, entry: this.edit?.entry },
    };
  }

  /**
   * Returns whether focus is in one of the three fields.
   *
   * @returns `true` when focus is in a field.
   */
  hasFocus(): boolean {
    const active = this.document.activeElement;
    return active === this.bodyField || active === this.replyField || active === this.editField;
  }

  /**
   * Returns the write for committing an active field.
   *
   * @param field Active field.
   * @returns Write. `undefined` when ending without writing.
   */
  private readPendingWrite(field: CommentThreadField): CommentEntryWrite | undefined {
    const raw = this.readField(field).value;
    if (field === 'edit') {
      const edit = this.edit;
      if (edit === undefined) {
        return undefined;
      }
      switch (readInputCommit(field, raw, edit.initialText)) {
        case 'end':
          return undefined;
        case 'delete':
          return { kind: 'delete', entry: edit.entry };
        case 'write':
          return { kind: 'edit', entry: edit.entry, text: raw };
      }
    }
    const comment = this.comment;
    if (comment === undefined || readInputCommit(field, raw, '') !== 'write') {
      return undefined;
    }
    return { kind: field === 'body' ? 'addBody' : 'addReply', comment, text: raw };
  }

  /**
   * Records the comment the inputs belong to, only when no input is active.
   *
   * @param comment Comment where the input started.
   */
  private holdComment(comment: Element | undefined): void {
    if (!this.hasActiveInput()) {
      this.comment = comment;
    }
  }

  /**
   * Puts a field's input in the ended state and returns what is needed to put it back. The field text is kept.
   *
   * @param field Field.
   * @returns Edit target before ending. `undefined` for an addition field.
   */
  private detach(field: CommentThreadField): CommentEditTarget | undefined {
    if (field === 'edit') {
      const edit = this.edit;
      this.edit = undefined;
      return edit;
    }
    this.setAddActive(field, false);
    return undefined;
  }

  /**
   * Puts back an input ended by `detach`.
   *
   * @param field Field.
   * @param kept Edit target before ending.
   */
  private restore(field: CommentThreadField, kept: CommentEditTarget | undefined): void {
    if (field === 'edit') {
      this.edit = kept;
      return;
    }
    this.setAddActive(field, true);
  }

  /** Ends all inputs and empties the fields. */
  private endAll(): void {
    for (const field of COMMIT_ORDER) {
      this.detach(field);
      this.clearField(field);
    }
  }

  /**
   * Empties a field.
   *
   * @param field Field.
   */
  private clearField(field: CommentThreadField): void {
    this.readField(field).value = '';
  }

  /**
   * Makes an addition input active or ends it.
   *
   * @param field Body or reply field.
   * @param active Whether to make it active.
   */
  private setAddActive(field: 'body' | 'reply', active: boolean): void {
    if (field === 'body') {
      this.bodyActive = active;
    } else {
      this.replyActive = active;
    }
  }

  /**
   * Returns whether a field's input is active.
   *
   * @param field Field.
   * @returns `true` when active.
   */
  private isActive(field: CommentThreadField): boolean {
    switch (field) {
      case 'body':
        return this.bodyActive;
      case 'reply':
        return this.replyActive;
      case 'edit':
        return this.edit !== undefined;
    }
  }

  /** Returns whether any input is active. */
  private hasActiveInput(): boolean {
    return this.bodyActive || this.replyActive || this.edit !== undefined;
  }

  /**
   * Returns the element of a field.
   *
   * @param field Field.
   * @returns Field element.
   */
  private readField(field: CommentThreadField): HTMLTextAreaElement {
    switch (field) {
      case 'body':
        return this.bodyField;
      case 'reply':
        return this.replyField;
      case 'edit':
        return this.editField;
    }
  }

  /**
   * Returns which field a key target is.
   *
   * @param target Key target.
   * @returns Field kind. `undefined` when it is not a field.
   */
  private findField(target: EventTarget | null): CommentThreadField | undefined {
    return COMMIT_ORDER.find((field) => this.readField(field) === target);
  }
}

/**
 * Decides from the committed raw input whether to end without writing, delete, or write.
 *
 * The value without surrounding whitespace is used only to decide whether it is whitespace only; the comparison with
 * the start and the value written use the raw input. Comparing the trimmed value would lose whitespace added around
 * the text as no change. An entry empty from the start that is committed unchanged is kept.
 *
 * @param field Field kind.
 * @param raw Raw input.
 * @param initial Text at the start. The empty string for an addition field.
 * @returns How the commit is handled.
 */
export function readInputCommit(field: CommentThreadField, raw: string, initial: string): CommentInputCommit {
  if (raw === initial) {
    return 'end';
  }
  if (isHtmlWhitespaceOnly(raw)) {
    return field === 'edit' ? 'delete' : 'end';
  }
  return 'write';
}

/**
 * Finds the entry corresponding to the edit target in the comment of the tree after document replacement.
 *
 * Only the one entry at the same position in the comment with the same ID is looked at. Searching entries at shifted
 * positions could write the input to a different entry.
 *
 * @param comment Comment in the new tree.
 * @param target Edit target.
 * @returns Entry whose element name, author and text all match. `undefined` when there is none.
 */
export function findReattachedEntry(comment: Element, target: CommentEditTarget): Element | undefined {
  const entry = target.index < 0 ? undefined : readCommentEntries(comment).at(target.index);
  if (
    entry === undefined
    || entry.localName !== target.tagName
    || entry.getAttribute(COMMENT_ATTRIBUTE.author) !== target.author
    || readEntryText(entry) !== target.initialText
  ) {
    return undefined;
  }
  return entry;
}

/**
 * Creates a field.
 *
 * @param document Document of the view.
 * @param localizer Localizer.
 * @param key Message key of the field name.
 * @returns Field.
 */
function createField(document: Document, localizer: Localizer, key: MessageKey): HTMLTextAreaElement {
  const field = document.createElement('textarea');
  const name = localizer.getMessage(key);
  field.rows = FIELD_ROWS;
  // A border alone does not tell what the field is for, so the name is also shown as visible text (placeholder).
  field.setAttribute('aria-label', name);
  field.placeholder = name;
  return field;
}
