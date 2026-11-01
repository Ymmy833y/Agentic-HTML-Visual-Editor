import type { EncodedSelection } from '../../common/index';
import { createEmptyBlock } from '../editing/block';
import { placeCaret } from '../editing/caret';
import { readCaretState } from '../editing/caret-state';
import type { CaretState } from '../editing/caret-state';
import { readEntryContentKey, toEntryContent } from '../editing/comment-entry-content';
import { attachEditingCore } from '../editing/editing-session';
import type { EditingSession } from '../editing/editing-session';
import type { EditTransactionLifecycle } from '../history/edit-transaction-controller';
import { PendingFormat } from '../editing/pending-format';
import { captureSelection } from '../selection/selection-capture';
import { restoreSelection } from '../selection/selection-restore';
import type { ActionDialogResult, ActionDialogSpec } from './action-dialog';

/** The class of a field's frame. Kept in line with the spelling in the bundled stylesheet. */
export const COMMENT_FIELD_CLASS = 'comment-thread-field';

/**
 * The class of the editable area inside a field. Kept in line with the spelling in the bundled stylesheet, which draws
 * its blocks as the document's.
 */
export const COMMENT_FIELD_TEXT_CLASS = 'comment-thread-field-text';

// Set on the editable area while the field holds nothing, so the stylesheet can show the field's name in its place.
const EMPTY_ATTRIBUTE = 'data-empty';

// The frame carries the name the stylesheet shows in an empty field.
const PLACEHOLDER_ATTRIBUTE = 'data-placeholder';

// Elements a caret cannot go inside. Placing the caret at the end stops before them.
const CARET_STOP_TAG_NAMES: ReadonlySet<string> = new Set(['br', 'hr', 'img', 'table']);

/**
 * Ports a comment field reads.
 *
 * None of them holds a value; each is read on every call, because the action dialog changes from moment to moment.
 */
export interface CommentFieldPorts {
  /**
   * Opens an action dialog and waits for the result.
   *
   * @param spec Action dialog spec.
   */
  openDialog(spec: ActionDialogSpec): Promise<ActionDialogResult>;

  /**
   * Prepares content before it goes into the field, as the document's content is prepared when it is mounted: images
   * get the source the view can show.
   *
   * @param content The content.
   */
  prepareContent(content: DocumentFragment): void;

  /** Notifies that what the toolbar shows for the field may have changed: the focus, the selection or the formats held. */
  notifyStateChanged(): void;

  /**
   * Records one diagnostic line for maintainers. Not used to notify the user.
   *
   * @param detail Line to record.
   */
  reportDiagnostic(detail: string): void;
}

/**
 * A field of the comment popup: an editing area that holds blocks, as the editor root does.
 *
 * It has an editing core of its own, so the input rules of the document apply to it, and the toolbar, the floating menu
 * and the keys are attached to it from outside, with ports that point at it. The field is not part of the document:
 * its edits open no attempt in the history, and what is written in it reaches the history only when it is committed to
 * an entry.
 */
export class CommentField {
  /** The frame. Placed in the popup. */
  readonly element: HTMLElement;

  /** The editable area, which holds the blocks. */
  readonly root: HTMLElement;

  /** The editing core of the editable area. */
  readonly session: EditingSession;

  /** The formats held for the next character typed in the field. */
  readonly pending = new PendingFormat();

  /**
   * @param document Document of the view.
   * @param name Name of the field, read out and shown while it is empty.
   * @param ports Ports of the field.
   * @param onContentChange Called after the user changed the content.
   */
  constructor(
    document: Document,
    name: string,
    private readonly ports: CommentFieldPorts,
    private readonly onContentChange: () => void,
  ) {
    this.element = document.createElement('div');
    this.element.className = COMMENT_FIELD_CLASS;
    this.element.setAttribute(PLACEHOLDER_ATTRIBUTE, name);
    this.root = document.createElement('div');
    this.root.className = COMMENT_FIELD_TEXT_CLASS;
    this.root.contentEditable = 'true';
    this.root.tabIndex = 0;
    this.root.setAttribute('role', 'textbox');
    this.root.setAttribute('aria-multiline', 'true');
    this.root.setAttribute('aria-label', name);
    this.root.setAttribute('aria-placeholder', name);
    this.element.append(this.root);

    // Attached before the editing core, so that a drop is turned into a paste before the core prevents it.
    this.root.addEventListener('beforeinput', (event) => this.handleDrop(event));
    this.session = attachEditingCore(
      this.root,
      () => undefined,
      (detail) => ports.reportDiagnostic(detail),
      this.createLifecycle(),
    );
    this.pending.handleMountCompleted(this.session);
    // What a composition shows counts as written, so the field's name is not drawn over it. The core does not report
    // the input of a composition until it ends.
    this.root.addEventListener('input', () => this.handleChanged());
    this.root.addEventListener('focus', () => ports.notifyStateChanged());
    this.root.addEventListener('blur', () => {
      // The formats are held for the caret in this field. A caret elsewhere would give them to the wrong text.
      this.pending.clear();
      ports.notifyStateChanged();
    });
    this.pending.addChangeListener(() => ports.notifyStateChanged());
    document.addEventListener('selectionchange', () => {
      if (this.hasFocus()) {
        this.pending.handleSelectionChange(this.root);
      }
    });
    this.clear();
  }

  /** Whether an IME composition is in progress in the field. */
  get isComposing(): boolean {
    return this.session.isComposing;
  }

  /**
   * Moves focus into the field.
   *
   * @param options Focus options.
   */
  focus(options?: FocusOptions): void {
    this.root.focus(options);
  }

  /** Moves focus into the field with the caret after its content, as when an edit starts. */
  focusAtEnd(): void {
    this.root.focus();
    placeCaretAtEnd(this.root);
  }

  /**
   * Returns whether focus is in the field.
   *
   * @returns `true` when the focused element is inside the frame.
   */
  hasFocus(): boolean {
    return this.contains(this.root.ownerDocument.activeElement);
  }

  /**
   * Returns whether a node is the frame or inside it.
   *
   * @param node The node.
   * @returns `true` when inside.
   */
  contains(node: EventTarget | null): boolean {
    return node instanceof Node && this.element.contains(node);
  }

  /**
   * Returns whether the field is placed in the popup and not inside a hidden section.
   *
   * @returns `true` when shown.
   */
  isShown(): boolean {
    return this.element.isConnected && this.element.closest('[hidden]') === null;
  }

  /**
   * Returns the content as an entry is written with it.
   *
   * @returns The content: the line form for paragraphs alone, otherwise the block form.
   */
  readContent(): DocumentFragment {
    return toEntryContent(this.root, this.root.ownerDocument);
  }

  /**
   * Replaces the content. Formats held for the next character are dropped.
   *
   * @param content The blocks, as `copyEntryContent` returns them. A copy is put in, so the fragment stays as it is.
   */
  setContent(content: DocumentFragment): void {
    const copy = content.cloneNode(true);
    if (!(copy instanceof DocumentFragment) || copy.childNodes.length === 0) {
      this.clear();
      return;
    }
    this.ports.prepareContent(copy);
    this.root.replaceChildren(copy);
    this.pending.clear();
    this.markEmpty();
  }

  /**
   * Empties the field. Formats held for the next character are dropped.
   *
   * An empty paragraph stays, as in an empty block of the document, so that the first character typed, a composition
   * included, goes into a block.
   */
  clear(): void {
    this.root.replaceChildren(createEmptyBlock(this.root.ownerDocument, 'p'));
    this.pending.clear();
    this.markEmpty();
  }

  /**
   * Returns whether the field holds nothing, not even an empty line.
   *
   * @returns `true` when empty.
   */
  isEmpty(): boolean {
    return readEntryContentKey(this.readContent()) === '';
  }

  /**
   * Returns the state the toolbar shows while the field is where the user writes.
   *
   * @returns The caret state of the field, with the formats held for the next character.
   */
  readCaretState(): CaretState {
    return readCaretState(this.root, this.pending.read());
  }

  /**
   * Splits the block at the caret, as Enter does in the document: a new paragraph, a new list item or a new line of a
   * code block.
   *
   * Enter commits the field, so another key does this, and it takes the same route as the document's Enter.
   */
  splitBlock(): void {
    this.root.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertParagraph',
      bubbles: true,
      cancelable: true,
    }));
  }

  /**
   * Opens an action dialog and, when it closes, puts focus and the selection back in the field before the result is
   * applied.
   *
   * The dialog takes focus, and focusing the field again would put the caret at its start, so the result would go to
   * the wrong place.
   *
   * @param spec Action dialog spec.
   * @returns The result, resolved after the selection is back in the field.
   */
  async openDialogKeepingSelection(spec: ActionDialogSpec): Promise<ActionDialogResult> {
    const selection = captureSelection(this.root)?.selection;
    const result = await this.ports.openDialog(spec);
    this.returnFocus(selection);
    return result;
  }

  /**
   * Moves focus back into the field and puts a selection captured in it back.
   *
   * @param selection The selection, as captured over the field. Omitted, the caret goes after the content.
   */
  returnFocus(selection?: EncodedSelection): void {
    this.root.focus({ preventScroll: true });
    if (selection === undefined) {
      placeCaretAtEnd(this.root);
      return;
    }
    restoreSelection(this.root, selection);
  }

  /**
   * Creates the endpoints of the edits in the field. Every edit may start, and none reaches the history: a field is not
   * part of the document.
   *
   * @returns The lifecycle.
   */
  private createLifecycle(): EditTransactionLifecycle {
    return {
      beginEdit: () => true,
      completeEdit: () => this.handleChanged(),
      abortEdit: () => undefined,
    };
  }

  /**
   * Turns a drop into a paste at the drop position, so that what is dropped goes in by the same rules as a paste.
   *
   * @param event The input about to happen.
   */
  private handleDrop(event: InputEvent): void {
    if (event.inputType !== 'insertFromDrop' || this.session.isComposing) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const data = event.dataTransfer;
    const target = event.getTargetRanges().at(0);
    if (data === null) {
      return;
    }
    if (target !== undefined) {
      const range = this.root.ownerDocument.createRange();
      range.setStart(target.startContainer, target.startOffset);
      range.setEnd(target.endContainer, target.endOffset);
      if (!this.root.contains(range.startContainer)) {
        return;
      }
      const selection = this.root.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    this.root.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertFromPaste',
      dataTransfer: data,
      bubbles: true,
      cancelable: true,
    }));
  }

  /** Marks whether the field is empty and tells the owner that the content changed. */
  private handleChanged(): void {
    this.markEmpty();
    this.onContentChange();
  }

  /** Marks the editable area while the field is empty. */
  private markEmpty(): void {
    this.root.toggleAttribute(EMPTY_ATTRIBUTE, this.isEmpty());
  }
}

/**
 * Places the caret after the last character of an editing area.
 *
 * @param root The editing area.
 */
function placeCaretAtEnd(root: Element): void {
  let container: Node = root;
  let last = container.lastChild;
  while (last instanceof Element && !CARET_STOP_TAG_NAMES.has(last.localName)) {
    container = last;
    last = container.lastChild;
  }
  if (last instanceof Text) {
    placeCaret(last, last.data.length);
    return;
  }
  // Before a trailing br, which only holds the height of an empty line; after anything else the caret cannot enter.
  placeCaret(container, container.childNodes.length - (last instanceof Element && last.localName === 'br' ? 1 : 0));
}
