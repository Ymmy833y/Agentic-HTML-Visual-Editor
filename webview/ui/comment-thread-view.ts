import { COMMENT_TAG_NAME } from '../../common/index';
import type { Localizer, MessageKey } from '../../common/index';
import { readCommentEntries } from '../editing/comment-read';
import {
  isAiEntry,
  isCommentResolved,
  readEntryAuthorName,
  readEntryText,
  readEntryUpdated,
} from '../editing/comment-thread-read';
import type { AdjacentComments, CommentMoveDirection } from './comment-navigation';
import type { CommentThreadField, CommentThreadInputState } from './comment-thread-input';
import { createItemIcon } from './toolbar';

/**
 * Icons of the thread operations. Each is drawn in a 24×24 view box.
 *
 * They carry no color and are drawn in the text color like toolbar items, so they do not sink into the background
 * in high contrast themes.
 */
export const COMMENT_THREAD_ICON_PATH = {
  // Upward chevron. Moves to the previous (upper) comment in the document.
  previous: 'M6 15l6-6 6 6',
  // Downward chevron. Moves to the next (lower) comment in the document.
  next: 'M6 9l6 6 6-6',
  // Check mark.
  resolved: 'M5 12.5l4.5 4.5L19 7',
  // The speech bubble of the comment button with an × over it.
  deleteComment: 'M4 5h16v11H10l-4 4v-4H4Z M9.5 8l5 5 M14.5 8l-5 5',
  // Pencil.
  editEntry: 'M4 20h4L19 9l-4-4L4 16Z M13 7l4 4',
  // Trash can.
  deleteEntry: 'M5 7h14 M10 7V4h4v3 M7 7l1 13h8l1-13 M10 11v5 M14 11v5',
} as const;

/**
 * Ports of the thread view.
 *
 * None of them holds a value; each is read on every call. The handlers are called on each press of a control.
 */
export interface CommentThreadViewPorts {
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

  /**
   * Moves to the previous or next comment.
   *
   * @param direction Move direction.
   */
  move(direction: CommentMoveDirection): void;

  /** Toggles the resolved state of the open comment. */
  toggleResolved(): void;

  /** Removes the open comment. */
  deleteComment(): void;

  /**
   * Starts editing an entry.
   *
   * @param entry Entry.
   */
  editEntry(entry: Element): void;

  /**
   * Deletes an entry.
   *
   * @param entry Entry.
   */
  deleteEntry(entry: Element): void;

  /**
   * Commits the input of a field.
   *
   * @param field Field kind.
   */
  save(field: CommentThreadField): void;

  /**
   * Cancels the input of a field.
   *
   * @param field Field kind.
   */
  cancel(field: CommentThreadField): void;
}

// Keep in sync with the spelling in the bundled stylesheet.
const HEADER_CLASS = 'comment-thread-header';
const ENTRY_CLASS = 'comment-thread-entry';
const AI_ENTRY_CLASS = 'comment-thread-entry-ai';
const META_CLASS = 'comment-thread-meta';
const EMPTY_ENTRY_CLASS = 'comment-thread-empty-entry';
// Save takes the primary button colors and cancel the secondary ones.
const SAVE_BUTTON_CLASS = 'comment-thread-save';
const CANCEL_BUTTON_CLASS = 'comment-thread-cancel';

// The entry text and the empty message use the same spelling as the popup's default drawing, keeping the same look
// and the same references.
const ENTRY_TEXT_CLASS = 'comment-popup-entry';
const EMPTY_CLASS = 'comment-popup-empty';

/** Name of an icon operation. */
type CommentThreadIconName = keyof typeof COMMENT_THREAD_ICON_PATH;

/** Kind of a recreated control. Kept to find the control of the same kind and entry before and after a redraw. */
interface ThreadPart {
  readonly kind: CommentThreadIconName | 'save' | 'cancel';
  readonly entry?: Element;
  readonly field?: CommentThreadField;
}

/** A drawn control and its kind. */
interface PlacedPart {
  readonly element: HTMLButtonElement;
  readonly part: ThreadPart;
}

/** Where focus was before drawing. */
type FocusSnapshot =
  | { readonly kind: 'none' }
  | { readonly kind: 'part'; readonly part: ThreadPart }
  | { readonly kind: 'field'; readonly field: CommentThreadField; readonly entry: Element | undefined };

/**
 * Draws a thread inside the popup.
 *
 * The controls inside are recreated on every draw, but the three fields and the editing row are never detached.
 * Detaching them would drop focus and break IME composition and the selection in the field. Exists once per view and
 * is not recreated on document replacement.
 */
export class CommentThreadView {
  private readonly header: HTMLElement;
  private readonly bodySection: HTMLElement;
  private readonly replySection: HTMLElement;
  private editingRow: HTMLElement | undefined;
  private editingEntry: Element | undefined;
  private parts: PlacedPart[] = [];
  // Maps each entry text drawn in the latest render to the entry it represents. Rebuilt on every render so stale texts cannot be looked up.
  private readonly entryTexts = new Map<Element, Element>();

  /**
   * Places the thread header before the entries container, and the sections for the body and reply fields after it.
   *
   * The popup description keeps pointing at the entries container, so that the operations and fields are not read
   * out as part of the description.
   *
   * @param popup Popup element.
   * @param entries Entries container.
   * @param inputs Input state. The body and reply fields go into their sections.
   * @param ports Ports of the thread view.
   */
  constructor(
    private readonly popup: HTMLElement,
    private readonly entries: HTMLElement,
    inputs: CommentThreadInputState,
    private readonly ports: CommentThreadViewPorts,
  ) {
    const document = popup.ownerDocument;
    this.header = document.createElement('div');
    this.header.className = HEADER_CLASS;
    this.bodySection = document.createElement('div');
    this.bodySection.append(inputs.body.field);
    this.replySection = document.createElement('div');
    this.replySection.append(inputs.reply.field);
    entries.before(this.header);
    entries.after(this.bodySection, this.replySection);
  }

  /**
   * Draws the thread of the open comment.
   *
   * If focus was on a recreated control before drawing, it is moved back to the control of the same kind and entry
   * afterwards. If focus is outside the popup, it is not moved, so that opening by a click does not steal keystrokes
   * from the editor root.
   *
   * @param comment Open comment.
   * @param adjacent Adjacent comments.
   * @param inputs Input state.
   */
  render(comment: Element, adjacent: AdjacentComments, inputs: CommentThreadInputState): void {
    const focus = this.readFocus(inputs);
    const entries = readCommentEntries(comment);
    const parts: PlacedPart[] = [];
    this.entryTexts.clear();
    this.renderHeader(comment, adjacent, parts);
    this.renderEntries(entries, inputs, parts);
    this.renderSection(this.bodySection, 'body', inputs.body, !this.isBodyFieldShown(entries, inputs), parts);
    this.renderSection(this.replySection, 'reply', inputs.reply, entries.length === 0 && !inputs.reply.active, parts);
    this.parts = parts;
    this.restoreFocus(focus, inputs);
  }

  /**
   * Returns the entry represented by the entry text that contains the node.
   *
   * Looks up only texts from the latest render. Controls, fields, and the author and date line are not entry texts, so they are not found.
   *
   * @param node The node.
   * @returns The entry. `undefined` outside any entry text.
   */
  readEntryAt(node: Node): Element | undefined {
    for (let current: Node | null = node; current !== null; current = current.parentNode) {
      if (current instanceof Element) {
        const entry = this.entryTexts.get(current);
        if (entry !== undefined) {
          return entry;
        }
      }
    }
    return undefined;
  }

  /**
   * Draws the thread header. Previous and next go on the left, the resolved toggle and comment deletion on the right.
   *
   * @param comment Open comment.
   * @param adjacent Adjacent comments.
   * @param parts Record of the drawn controls.
   */
  private renderHeader(comment: Element, adjacent: AdjacentComments, parts: PlacedPart[]): void {
    const document = this.popup.ownerDocument;
    const previous = this.createIconButton('previous', undefined, 'commentThread.previous', parts, () => {
      this.ports.move('previous');
    });
    // Show that a direction without a move target cannot be pressed. Leaving a control that does nothing when pressed
    // would not tell the user they have reached the end.
    previous.disabled = adjacent.previous === undefined;
    const next = this.createIconButton('next', undefined, 'commentThread.next', parts, () => {
      this.ports.move('next');
    });
    next.disabled = adjacent.next === undefined;
    const resolved = this.createIconButton('resolved', undefined, 'commentThread.resolved', parts, () => {
      this.ports.toggleResolved();
    });
    resolved.setAttribute('aria-pressed', String(isCommentResolved(comment)));
    const remove = this.createIconButton('deleteComment', undefined, 'commentThread.deleteComment', parts, () => {
      this.ports.deleteComment();
    });

    const navigation = document.createElement('div');
    navigation.append(previous, next);
    const actions = document.createElement('div');
    actions.append(resolved, remove);
    this.header.replaceChildren(navigation, actions);
  }

  /**
   * Draws the entries in document order. For the entry being edited, the edit field with save and cancel replaces
   * the text and the edit and delete operations.
   *
   * @param entries Direct entries of the comment.
   * @param inputs Input state.
   * @param parts Record of the drawn controls.
   */
  private renderEntries(entries: readonly Element[], inputs: CommentThreadInputState, parts: PlacedPart[]): void {
    const rows: HTMLElement[] = [];
    let kept: HTMLElement | undefined;
    for (const entry of entries) {
      if (entry === inputs.edit.entry) {
        kept = this.renderEditingRow(entry, inputs.edit.field, parts);
        rows.push(kept);
      } else {
        rows.push(this.createEntryRow(entry, parts));
      }
    }
    if (kept === undefined) {
      this.editingRow = undefined;
      this.editingEntry = undefined;
    }
    if (rows.length === 0) {
      const empty = this.popup.ownerDocument.createElement('div');
      empty.className = EMPTY_CLASS;
      empty.textContent = this.ports.localizer.getMessage('commentPopup.empty');
      rows.push(empty);
    }
    placeChildren(this.entries, rows, kept);
  }

  /**
   * Creates the row of one entry. Surrounds it with a border in the author's color, and places the display name, the
   * time, the text, and the edit and delete operations.
   *
   * @param entry Entry.
   * @param parts Record of the drawn controls.
   * @returns Row.
   */
  private createEntryRow(entry: Element, parts: PlacedPart[]): HTMLElement {
    const document = this.popup.ownerDocument;
    const row = document.createElement('div');
    row.className = readEntryClass(entry);
    const meta = this.createMeta(entry);
    if (meta !== undefined) {
      row.append(meta);
    }

    const text = document.createElement('div');
    const value = readEntryText(entry);
    if (value === '') {
      // Show an empty entry as one entry too. Otherwise the empty body of an opened document could neither be deleted
      // nor have a body added.
      text.className = `${ENTRY_TEXT_CLASS} ${EMPTY_ENTRY_CLASS}`;
      text.textContent = this.ports.localizer.getMessage('commentThread.emptyEntry');
    } else {
      text.className = ENTRY_TEXT_CLASS;
      text.textContent = value;
    }
    // Make the entry reachable from its text so that clicking the text can open editing. The same applies to the empty entry display.
    this.entryTexts.set(text, entry);
    row.append(
      text,
      this.createIconButton('editEntry', entry, 'commentThread.editEntry', parts, () => {
        this.ports.editEntry(entry);
      }),
      this.createIconButton('deleteEntry', entry, 'commentThread.deleteEntry', parts, () => {
        this.ports.deleteEntry(entry);
      }),
    );
    return row;
  }

  /**
   * Draws the editing row. The row and the edit field stay the same elements until the edit ends; only the other
   * controls inside are recreated.
   *
   * @param entry Entry being edited.
   * @param field Edit field.
   * @param parts Record of the drawn controls.
   * @returns Editing row.
   */
  private renderEditingRow(entry: Element, field: HTMLTextAreaElement, parts: PlacedPart[]): HTMLElement {
    const row = this.editingRow ?? this.popup.ownerDocument.createElement('div');
    this.editingRow = row;
    this.editingEntry = entry;
    row.className = readEntryClass(entry);
    const children: Element[] = [];
    const meta = this.createMeta(entry);
    if (meta !== undefined) {
      children.push(meta);
    }
    children.push(
      field,
      this.createTextButton({ kind: 'save', field: 'edit' }, 'commentThread.save', parts, () => {
        this.ports.save('edit');
      }),
      this.createTextButton({ kind: 'cancel', field: 'edit' }, 'commentThread.cancel', parts, () => {
        this.ports.cancel('edit');
      }),
    );
    placeChildren(row, children, field);
    return row;
  }

  /**
   * Draws the section of the body or reply field. An active field gets save and cancel.
   *
   * @param section Section.
   * @param field Field kind.
   * @param state Field element and whether it is active.
   * @param hidden Whether to hide the section.
   * @param parts Record of the drawn controls.
   */
  private renderSection(
    section: HTMLElement,
    field: 'body' | 'reply',
    state: { readonly field: HTMLTextAreaElement; readonly active: boolean },
    hidden: boolean,
    parts: PlacedPart[],
  ): void {
    section.hidden = hidden;
    const children: Element[] = [state.field];
    if (state.active) {
      children.push(
        this.createTextButton({ kind: 'save', field }, 'commentThread.save', parts, () => {
          this.ports.save(field);
        }),
        this.createTextButton({ kind: 'cancel', field }, 'commentThread.cancel', parts, () => {
          this.ports.cancel(field);
        }),
      );
    }
    placeChildren(section, children, state.field);
  }

  /**
   * Returns whether to show the body field. There is at most one body, so with a body present the field is shown only
   * while active.
   *
   * @param entries Direct entries of the comment.
   * @param inputs Input state.
   * @returns `true` to show it.
   */
  private isBodyFieldShown(entries: readonly Element[], inputs: CommentThreadInputState): boolean {
    return inputs.body.active || !entries.some((entry) => entry.localName === COMMENT_TAG_NAME.body);
  }

  /**
   * Creates the line with the author's display name and the update time.
   *
   * @param entry Entry.
   * @returns Line. `undefined` when neither exists (no empty line leaves a gap).
   */
  private createMeta(entry: Element): HTMLElement | undefined {
    const values = [
      readEntryAuthorName(entry, this.ports.localizer),
      readEntryUpdated(entry, (date) => this.ports.formatDate(date)),
    ].filter((value): value is string => value !== undefined);
    if (values.length === 0) {
      return undefined;
    }
    const document = this.popup.ownerDocument;
    const meta = document.createElement('div');
    meta.className = META_CLASS;
    for (const value of values) {
      const span = document.createElement('span');
      span.textContent = value;
      meta.append(span);
    }
    return meta;
  }

  /**
   * Creates an icon operation.
   *
   * An icon alone is not read out, so the message becomes its name. No `title` is set; it would overlap with the
   * browser's default tooltip, showing two.
   *
   * @param icon Icon name. Also serves as the control kind.
   * @param entry The entry, for a per-entry operation.
   * @param key Message key of the name.
   * @param parts Record of the drawn controls.
   * @param run Operation on press.
   * @returns Operation.
   */
  private createIconButton(
    icon: CommentThreadIconName,
    entry: Element | undefined,
    key: MessageKey,
    parts: PlacedPart[],
    run: () => void,
  ): HTMLButtonElement {
    const document = this.popup.ownerDocument;
    const button = document.createElement('button');
    button.type = 'button';
    const label = this.ports.localizer.getMessage(key);
    button.setAttribute('aria-label', label);
    button.append(createItemIcon(document, COMMENT_THREAD_ICON_PATH[icon]));
    this.ports.registerTooltip(button, label);
    button.addEventListener('click', run);
    parts.push({ element: button, part: { kind: icon, entry } });
    return button;
  }

  /**
   * Creates a text operation (save or cancel).
   *
   * @param part Control kind.
   * @param key Message key of the text.
   * @param parts Record of the drawn controls.
   * @param run Operation on press.
   * @returns Operation.
   */
  private createTextButton(part: ThreadPart, key: MessageKey, parts: PlacedPart[], run: () => void): HTMLButtonElement {
    const button = this.popup.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = part.kind === 'save' ? SAVE_BUTTON_CLASS : CANCEL_BUTTON_CLASS;
    button.textContent = this.ports.localizer.getMessage(key);
    button.addEventListener('click', run);
    parts.push({ element: button, part });
    return button;
  }

  /**
   * Reads where focus was before drawing.
   *
   * @param inputs Input state.
   * @returns Focus snapshot.
   */
  private readFocus(inputs: CommentThreadInputState): FocusSnapshot {
    const active = this.popup.ownerDocument.activeElement;
    if (active === null || !this.popup.contains(active)) {
      return { kind: 'none' };
    }
    const placed = this.parts.find((item) => item.element === active);
    if (placed !== undefined) {
      return { kind: 'part', part: placed.part };
    }
    if (active === inputs.body.field) {
      return { kind: 'field', field: 'body', entry: undefined };
    }
    if (active === inputs.reply.field) {
      return { kind: 'field', field: 'reply', entry: undefined };
    }
    if (active === inputs.edit.field) {
      return { kind: 'field', field: 'edit', entry: this.editingEntry };
    }
    return { kind: 'none' };
  }

  /**
   * Moves focus back after drawing.
   *
   * Without a control to go back to, focus moves from the edit field to that entry's edit operation, from the body
   * field to the reply field, and otherwise to the popup. Leaving focus on a hidden field or a detached control would
   * make keystrokes reach nothing.
   *
   * @param focus Focus snapshot before drawing.
   * @param inputs Input state.
   */
  private restoreFocus(focus: FocusSnapshot, inputs: CommentThreadInputState): void {
    switch (focus.kind) {
      case 'none':
        return;
      case 'part':
        this.focusPart(focus.part);
        return;
      case 'field':
        if (this.isFieldShown(readInputField(inputs, focus.field))) {
          return;
        }
        if (focus.field === 'edit') {
          this.focusPart({ kind: 'editEntry', entry: focus.entry });
        } else if (focus.field === 'body' && this.isFieldShown(inputs.reply.field)) {
          inputs.reply.field.focus({ preventScroll: true });
        } else {
          this.popup.focus({ preventScroll: true });
        }
    }
  }

  /**
   * Moves focus to the control of the same kind and entry. Without one, moves it to the popup.
   *
   * @param part Control kind.
   */
  private focusPart(part: ThreadPart): void {
    const match = this.parts.find((item) => isSamePart(item.part, part) && !item.element.disabled);
    (match?.element ?? this.popup).focus({ preventScroll: true });
  }

  /**
   * Returns whether a field is visible inside the popup.
   *
   * @param field Field.
   * @returns `true` when it is placed and not inside a hidden section.
   */
  private isFieldShown(field: HTMLTextAreaElement): boolean {
    return this.popup.contains(field) && field.closest('[hidden]') === null;
  }
}

/**
 * Rearranges children. The element to keep is not detached; the other children are placed before and after it.
 *
 * Detaching and placing it again would drop the focus inside the element and break IME composition and the
 * selection in the field.
 *
 * @param container Container.
 * @param children Children to arrange.
 * @param kept Element not to detach. Included in `children`.
 */
function placeChildren(container: Element, children: readonly Element[], kept: Element | undefined): void {
  const index = kept === undefined ? -1 : children.indexOf(kept);
  if (kept === undefined || index === -1 || kept.parentNode !== container) {
    container.replaceChildren(...children);
    return;
  }
  for (const child of [...container.childNodes]) {
    if (child !== kept) {
      child.remove();
    }
  }
  kept.before(...children.slice(0, index));
  kept.after(...children.slice(index + 1));
}

/**
 * Returns the class of an entry row. An AI entry gets a border in the AI color.
 *
 * @param entry Entry.
 * @returns Class value.
 */
function readEntryClass(entry: Element): string {
  return isAiEntry(entry) ? `${ENTRY_CLASS} ${AI_ENTRY_CLASS}` : ENTRY_CLASS;
}

/**
 * Returns the field element from the input state.
 *
 * @param inputs Input state.
 * @param field Field kind.
 * @returns Field.
 */
function readInputField(inputs: CommentThreadInputState, field: CommentThreadField): HTMLTextAreaElement {
  switch (field) {
    case 'body':
      return inputs.body.field;
    case 'reply':
      return inputs.reply.field;
    case 'edit':
      return inputs.edit.field;
  }
}

/**
 * Returns whether two control kinds are the same.
 *
 * @param left One side.
 * @param right Other side.
 * @returns `true` when the kind, entry and field are all the same.
 */
function isSamePart(left: ThreadPart, right: ThreadPart): boolean {
  return left.kind === right.kind && left.entry === right.entry && left.field === right.field;
}
