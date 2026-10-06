import { INLINE_RUN_TAG_NAMES, findBlock } from './block';
import { readSelectionRange } from './caret';
import type { EditingSession } from './editing-session';
import { readTextSelection } from './format-command';
import { readFormatTarget } from './format-segment';
import { readFormatState } from './format-state';
import type { FormatState } from './format-state';
import { INLINE_FORMAT } from './inline-format';
import type { InlineFormat, ToggleFormat } from './inline-format';
import { readNeighbors } from './materialization';
import type { PositionNeighbors } from './materialization';

/** A listener that receives the change trigger of the pending format. */
export type PendingFormatListener = () => void;

/** The pending formats when nothing is held. Also what a read returns before any toggle. */
export const NO_PENDING_FORMATS: ReadonlySet<ToggleFormat> = new Set();

/**
 * The pending anchor: where the formats were held.
 *
 * The caret is remembered as a position counted over the editor root's text alone, together with the formats of
 * its ancestors and the block it sits in, not as a node and an offset. A paragraph materialized around a bare
 * caret for the first character moves the caret into it without changing the count or the ancestors, a click
 * that lands beside a format element at the same count changes the ancestors, which is what decides what the
 * held formats flip against, and an arrow key that crosses into the next block keeps the count, since the
 * whitespace between blocks is not counted, but changes the block. An arrow key that carries a bare caret
 * directly under the editor root past an element with no text, such as a horizontal rule, changes neither the
 * count nor the lack of a block, only the siblings around it. A click that carries a bare caret inside a bare run
 * past such an element into the next run changes only the run.
 */
interface PendingAnchor {
  /** The number of characters up to the caret. */
  readonly position: number;
  /** Whether each format is on the caret's ancestors. */
  readonly formats: FormatState;
  /** The block the caret sits in. `undefined` for a bare caret directly under the editor root. */
  readonly block: Element | undefined;
  /**
   * The elements directly under the editor root, read only for a bare caret directly under the editor root. Empty
   * when the caret has a block.
   */
  readonly rootElements: ReadonlySet<Element>;
  /**
   * The siblings around a bare caret directly under the editor root, skipping whitespace and HTML comments.
   * `undefined` when the caret has a block or is not between the elements directly under the editor root.
   */
  readonly neighbors: PositionNeighbors | undefined;
  /**
   * The first node of the bare run that holds a bare caret directly under the editor root, which stays the same
   * wherever in the run the caret is. `undefined` when the caret has a block or sits between the elements directly
   * under the editor root.
   */
  readonly runHead: Node | undefined;
}

// The root elements of an anchor whose caret has a block, which never compares them.
const NO_ROOT_ELEMENTS: ReadonlySet<Element> = new Set();

// The formats compared between two anchors, so that one loop decides all five.
const INLINE_FORMATS: readonly InlineFormat[] = Object.values(INLINE_FORMAT);

/**
 * The pending format: the formats a bare caret has toggled, carried over to the next typed character.
 *
 * A toggle without a range changes no tree. Instead the formats to flip against the caret's ancestors are held
 * here, together with where they were held (the pending anchor), until the next character
 * insertion or composition consumes them. Moving the caret away or making any other edit cancels them.
 * There is one per view, and it is not recreated on document replacement.
 */
export class PendingFormat {
  // The formats to flip, in the order they were toggled. Toggling a held format again takes it out.
  private readonly formats = new Set<ToggleFormat>();

  // Where the formats were held. `undefined` while nothing is held.
  private anchor: PendingAnchor | undefined;

  private readonly listeners: PendingFormatListener[] = [];

  /** Whether nothing is held. */
  get isEmpty(): boolean {
    return this.formats.size === 0;
  }

  /**
   * Flips whether a format is held, and records the current caret as the pending anchor.
   *
   * @param format The format to toggle.
   * @param root The editor root. Its selection is a bare caret.
   */
  toggle(format: ToggleFormat, root: Element): void {
    if (this.formats.has(format)) {
      this.formats.delete(format);
    } else {
      this.formats.add(format);
    }
    this.anchor = this.formats.size === 0 ? undefined : readAnchor(root);
    if (this.anchor === undefined) {
      // Without a caret to anchor to there is nothing the formats could be given to.
      this.formats.clear();
    }
    this.notify();
  }

  /**
   * Returns the held formats. Changes nothing.
   *
   * @returns The formats to flip, in the order they were toggled. Empty when nothing is held.
   */
  read(): ReadonlySet<ToggleFormat> {
    return this.formats;
  }

  /** Drops whatever is held. Does nothing, and notifies nobody, when nothing is held. */
  clear(): void {
    if (this.formats.size === 0) {
      return;
    }
    this.formats.clear();
    this.anchor = undefined;
    this.notify();
  }

  /**
   * Cancels the held formats when the caret has left the pending anchor.
   *
   * A selection change that keeps the caret at the same count with the same ancestors, such as the one a
   * toolbar press leaves behind or the move into a materialized paragraph, keeps them.
   *
   * @param root The editor root, or `undefined` before it is mounted.
   */
  handleSelectionChange(root: Element | undefined): void {
    const anchor = this.anchor;
    if (anchor === undefined) {
      return;
    }
    if (root === undefined) {
      this.clear();
      return;
    }
    const current = readAnchor(root);
    if (
      current === undefined
      || current.position !== anchor.position
      || !hasSameFormats(current, anchor)
      || !isSameBlock(current, anchor, root)
    ) {
      this.clear();
    }
  }

  /**
   * Drops the held formats in response to a successful mount, and cancels them on every edit of that mount's
   * editing session.
   *
   * The character insertion that consumes the formats clears them before it is reported as an edit, so the
   * edit trigger only ever cancels formats that some other edit has left behind.
   *
   * @param session That mount's editing session. Only its registration port is taken.
   */
  handleMountCompleted(session: Pick<EditingSession, 'addEditListener'>): void {
    this.clear();
    session.addEditListener(() => this.clear());
  }

  /**
   * Adds a listener that is called whenever what is held changes.
   *
   * @param listener The listener to add. It is responsible for not letting exceptions escape.
   */
  addChangeListener(listener: PendingFormatListener): void {
    this.listeners.push(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/**
 * Reads the pending anchor from the current selection.
 *
 * @param root The editor root.
 * @returns The anchor, or `undefined` when the selection is outside the editor root or is a range.
 */
function readAnchor(root: Element): PendingAnchor | undefined {
  const selection = readTextSelection(root);
  const range = readSelectionRange(root);
  if (selection === undefined || selection.start !== selection.end || range === undefined) {
    return undefined;
  }
  const block = findBlock(range.startContainer, root);
  const neighbors = block === undefined ? readNeighbors(root, range.startContainer, range.startOffset) : undefined;
  return {
    position: selection.start,
    formats: readFormatState(readFormatTarget(root)),
    block,
    rootElements: block === undefined ? new Set(Array.from(root.children)) : NO_ROOT_ELEMENTS,
    neighbors,
    runHead: block === undefined && neighbors === undefined ? readRunHead(root, range.startContainer) : undefined,
  };
}

/**
 * Returns the first node of the bare run directly under the editor root that holds a node.
 *
 * The run is counted the same way as the one that ensuring a target wraps in a paragraph.
 *
 * @param root The editor root.
 * @param node A node inside the run.
 * @returns The first node of the run, or `undefined` when the node is not inside the editor root.
 */
function readRunHead(root: Element, node: Node): Node | undefined {
  let head: Node | null = node;
  while (head !== null && head.parentNode !== root) {
    head = head.parentNode;
  }
  if (head === null) {
    return undefined;
  }
  while (isRunMember(head.previousSibling)) {
    head = head.previousSibling;
  }
  return head;
}

/**
 * Determines whether a node may continue a bare run.
 *
 * @param node The node to inspect.
 * @returns `true` for text or an element that belongs in a bare run.
 */
function isRunMember(node: Node | null): node is ChildNode {
  return node instanceof Text || (node instanceof Element && INLINE_RUN_TAG_NAMES.has(node.localName));
}

/**
 * Determines whether the caret is still in the block the formats were held in.
 *
 * A bare caret directly under the editor root has no block, and the first character typed there moves it into a
 * paragraph materialized for that character, so a block that did not exist when the formats were held is
 * accepted when it took the caret's place. An arrow key can also carry such a caret into a table or a paragraph
 * beside it at the same count, which is why a block inside an element that was already there is not, or past an
 * element with no text, which is why a caret that still has no block must keep its siblings, or its bare run when
 * it sits inside one. The place of a new block is checked because the character typed right after such a move can
 * be materialized before the selection change arrives.
 *
 * @param current The anchor read now.
 * @param held The anchor read when the formats were held.
 * @param root The editor root.
 * @returns `true` when the blocks are the same, when a caret with no block still has the same siblings or bare run,
 *   or when the caret has entered a block created since in its place.
 */
function isSameBlock(current: PendingAnchor, held: PendingAnchor, root: Element): boolean {
  if (held.block !== undefined) {
    return current.block === held.block;
  }
  if (current.block === undefined) {
    return hasSameNeighbors(current, held) && current.runHead === held.runHead;
  }
  let top = current.block;
  while (top.parentElement !== null && top.parentElement !== root) {
    top = top.parentElement;
  }
  return !held.rootElements.has(top) && isInPlaceOf(top, held, root);
}

/**
 * Determines whether an element created directly under the editor root took the place of the held caret.
 *
 * A paragraph materialized for the first character goes right after the element before the caret, or first when
 * there is none. Materializing in an empty editor root takes out every child, so an element before the caret that
 * is no longer there counts as none.
 *
 * @param element The element directly under the editor root that the caret has entered.
 * @param held The anchor read when the formats were held.
 * @param root The editor root.
 * @returns `true` when the element comes right after the element that was before the caret, or when the caret was
 *   not between the elements directly under the editor root.
 */
function isInPlaceOf(element: Element, held: PendingAnchor, root: Element): boolean {
  if (held.neighbors === undefined) {
    return true;
  }
  const { previous } = held.neighbors;
  const expected = previous !== null && previous.parentNode === root ? previous : null;
  const index = [...root.childNodes].indexOf(element);
  return readNeighbors(root, root, index)?.previous === expected;
}

/**
 * Determines whether two anchors with no block sit between the same siblings.
 *
 * @param first One anchor.
 * @param second The other anchor.
 * @returns `true` when the siblings agree, or when neither caret is between the elements directly under the editor
 *   root.
 */
function hasSameNeighbors(first: PendingAnchor, second: PendingAnchor): boolean {
  if (first.neighbors === undefined || second.neighbors === undefined) {
    return first.neighbors === second.neighbors;
  }
  return first.neighbors.previous === second.neighbors.previous && first.neighbors.next === second.neighbors.next;
}

/**
 * Determines whether two anchors have the same formats on the ancestors.
 *
 * @param first One anchor.
 * @param second The other anchor.
 * @returns `true` when every format agrees.
 */
function hasSameFormats(first: PendingAnchor, second: PendingAnchor): boolean {
  return INLINE_FORMATS.every((format) => first.formats[format] === second.formats[format]);
}

/**
 * Lays the pending formats over a format state, flipping each held format.
 *
 * The pressed state of the toolbar then shows what the next typed character gets, not only what the caret's
 * ancestors already carry.
 *
 * @param state The format state read from the selection.
 * @param pending The held formats.
 * @returns The state with each held format flipped. The same state when nothing is held.
 */
export function applyPendingFormats(state: FormatState, pending: ReadonlySet<ToggleFormat>): FormatState {
  if (pending.size === 0) {
    return state;
  }
  const flipped = { ...state };
  for (const format of pending) {
    flipped[format] = !state[format];
  }
  return flipped;
}
