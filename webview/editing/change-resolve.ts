import { CHANGE_ATTRIBUTE, CHANGE_KIND } from '../../common/index';
import type { ChangeKind, EncodedSelection } from '../../common/index';
import { BLOCK_TAG_NAMES, fillPlaceholder, findBlock, isEmptyBlock } from './block';
import type { BlockRewriteProgress } from './block-format';
import {
  isChangeInTree,
  isInlineChange,
  isInsideEntry,
  readChangeHead,
  readChangeKind,
  readChanges,
  readReplacementPartner,
} from './change-read';
import { captureRange } from '../selection/selection-capture';
import type { NodeBoundary } from '../selection/selection-position';

/**
 * Edit kinds for resolving change marks.
 *
 * They are spelled differently from typing and deletion, so that the history treats them as standalone edits instead
 * of grouping them with the surrounding input.
 */
export const CHANGE_EDIT_KIND = {
  accept: 'change:accept',
  reject: 'change:reject',
  acceptAll: 'change:acceptAll',
  rejectAll: 'change:rejectAll',
} as const;

/** What the user decided about a change mark. */
export type ChangeDecision = 'accept' | 'reject';

/**
 * Ports for resolving change marks.
 *
 * None of them holds a value; each is read on every call, because document replacement switches the editing session.
 */
export interface ChangeResolvePorts {
  /** Returns the editor root. `undefined` before mounting. */
  readEditorRoot(): Element | undefined;

  /** Returns whether an input stop reason remains. */
  isInputStopped(): boolean;

  /** Command path. Closes the attempt as completed only when the tree was changed. */
  runCommandEdit(kind: string, command: () => boolean): boolean;

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

// The attributes a mark carries. Keeping the content removes all of them, so that nothing of the mark stays behind.
const MARK_ATTRIBUTE_NAMES: readonly string[] = [
  CHANGE_ATTRIBUTE.kind,
  CHANGE_ATTRIBUTE.author,
  CHANGE_ATTRIBUTE.updated,
];

// Selects the elements that may hold the caret, used to place it after a mark is taken out.
const BLOCK_SELECTOR = [...BLOCK_TAG_NAMES].join(', ');

// Containers that hold nothing but their items or rows. One left without them after an element is taken out would
// stay in the document unseen, so it goes too.
const ITEM_CONTAINER_TAG_NAMES: ReadonlySet<string> = new Set(['ul', 'ol', 'thead', 'tbody', 'tfoot', 'table']);

/**
 * Accepts or rejects one change mark, or the replacement pair it belongs to, in one edit attempt, and requests a
 * return to the editor root at the place the caret should be afterwards.
 *
 * Accepting an insertion and rejecting a deletion keep the content: an inline mark is unwrapped, an element that
 * carries the kind loses the attributes of the mark. Accepting a deletion and rejecting an insertion take the content
 * out together with the mark, with everything inside it. A replacement pair is decided as one, whichever half the
 * decision came through: accepting takes the deletion out and keeps the insertion, rejecting does the opposite. No
 * confirmation is asked: the edit can be undone, and deciding about a change is what the mark is for.
 *
 * Taking the mark out closes its popup through the tree change, which returns to the editor root without a selection
 * and makes the caret jump to the start of the editor root. So a return with a selection is requested after the
 * attempt closes. Only the return handler moves the selection and focus.
 *
 * @param ports Ports for resolving change marks.
 * @param change The change mark. Either half of a replacement pair stands for the pair.
 * @param decision Whether to accept or reject it.
 * @returns Whether the tree was changed. `false` when input is stopped, the attempt cannot start, the mark is not in
 *   the tree, or an exception prevented finishing.
 */
export function resolveChange(ports: ChangeResolvePorts, change: Element, decision: ChangeDecision): boolean {
  const root = ports.readEditorRoot();
  const head = readChangeHead(change);
  const kind = readChangeKind(head);
  if (ports.isInputStopped() || root === undefined || kind === undefined || !isChangeInTree(root, head)) {
    return false;
  }
  const partner = readReplacementPartner(head);

  let boundary: NodeBoundary | undefined;
  ports.runCommandEdit(decision === 'accept' ? CHANGE_EDIT_KIND.accept : CHANGE_EDIT_KIND.reject, () => {
    const progress: BlockRewriteProgress = { changed: false };
    try {
      boundary = partner === undefined
        ? resolveOne(head, kind, decision, root, progress)
        : resolvePair(head, partner, decision, root, progress);
    } catch (error) {
      ports.reportDiagnostic(`Could not finish resolving the change: ${String(error)}`);
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
 * Accepts or rejects every change mark of the editor root in document order, in one edit attempt.
 *
 * One attempt, so that one undo brings the whole document back. The selection is not touched: the browser moves a
 * selection whose container is taken out to the nearest place that remains.
 *
 * @param ports Ports for resolving change marks.
 * @param decision Whether to accept or reject them all.
 * @returns Whether the tree was changed. `false` when input is stopped, the attempt cannot start, or there is no mark.
 */
export function resolveAllChanges(ports: ChangeResolvePorts, decision: ChangeDecision): boolean {
  const root = ports.readEditorRoot();
  if (ports.isInputStopped() || root === undefined) {
    return false;
  }
  return ports.runCommandEdit(decision === 'accept' ? CHANGE_EDIT_KIND.acceptAll : CHANGE_EDIT_KIND.rejectAll, () => {
    const progress: BlockRewriteProgress = { changed: false };
    try {
      for (const change of readChanges(root)) {
        // A mark taken out before this one took it out of the tree together with the content.
        if (!change.isConnected) {
          continue;
        }
        const keep = (readChangeKind(change) === CHANGE_KIND.insertion) === (decision === 'accept');
        if (keep) {
          keepChange(change, progress);
        } else {
          dropChange(change, root, progress);
        }
      }
    } catch (error) {
      ports.reportDiagnostic(`Could not finish resolving every change: ${String(error)}`);
    }
    return progress.changed;
  });
}

/**
 * Keeps or takes out one mark on its own: accepting an insertion and rejecting a deletion keep the content.
 *
 * @param change The change mark.
 * @param kind Its kind.
 * @param decision The decision.
 * @param root The editor root.
 * @param progress Record of whether the tree was changed.
 * @returns The boundary the caret goes to.
 */
function resolveOne(
  change: Element,
  kind: ChangeKind,
  decision: ChangeDecision,
  root: Element,
  progress: BlockRewriteProgress,
): NodeBoundary {
  const keep = (kind === CHANGE_KIND.insertion) === (decision === 'accept');
  return keep ? keepChange(change, progress) : dropChange(change, root, progress);
}

/**
 * Decides a replacement pair as one: accepting takes the deletion out and keeps the insertion, rejecting does the
 * opposite.
 *
 * The half that goes is taken out first, so that the content kept is the last touched and the caret lands at its end,
 * where the reader goes on.
 *
 * @param deletion The deletion that leads the pair.
 * @param insertion The insertion that follows it.
 * @param decision The decision.
 * @param root The editor root.
 * @param progress Record of whether the tree was changed.
 * @returns The boundary at the end of the kept content.
 */
function resolvePair(
  deletion: Element,
  insertion: Element,
  decision: ChangeDecision,
  root: Element,
  progress: BlockRewriteProgress,
): NodeBoundary {
  const [dropped, kept] = decision === 'accept' ? [deletion, insertion] : [insertion, deletion];
  dropChange(dropped, root, progress);
  return keepChange(kept, progress);
}

/**
 * Keeps the content of a mark: unwraps an inline mark, or removes the attributes of the mark from an element.
 *
 * Exceptions are not caught here; they are left to the caller.
 *
 * @param change The change mark.
 * @param progress Record of whether the tree was changed. Set to true right before touching the tree.
 * @returns Boundary at the end of the kept content.
 */
function keepChange(change: Element, progress: BlockRewriteProgress): NodeBoundary {
  if (!isInlineChange(change)) {
    progress.changed = true;
    for (const name of MARK_ATTRIBUTE_NAMES) {
      change.removeAttribute(name);
    }
    return readContentEnd(change);
  }
  const parent = change.parentNode;
  if (parent === null) {
    throw new Error('The change mark to unwrap has no parent');
  }
  progress.changed = true;
  // Nested marks and comments move along as children of the content, so only this mark is removed.
  for (const child of [...change.childNodes]) {
    parent.insertBefore(child, change);
  }
  const offset = [...parent.childNodes].indexOf(change);
  change.remove();
  return { container: parent, offset };
}

/**
 * Takes a mark out together with its content.
 *
 * Exceptions are not caught here; they are left to the caller.
 *
 * An inline mark sits in the middle of a line, so the caret stays at the place it was taken out at and the reader goes
 * on in the same line. An element that carried the kind may have held the only place the caret could be, so the caret
 * goes to the nearest block instead, and the lists and table sections it leaves without items or rows go with it.
 * Either way, a block left empty (a paragraph, a quote, an item, a cell) gets its placeholder, so that the line keeps
 * its height and the caret stays visible.
 *
 * @param change The change mark.
 * @param root The editor root.
 * @param progress Record of whether the tree was changed. Set to true right before touching the tree.
 * @returns Boundary at the place an inline mark was taken out at. For an element that carried the kind, the start of
 *   the first block after it, or the end of the last block before it, or the start of the editor root when there is no
 *   block.
 */
function dropChange(change: Element, root: Element, progress: BlockRewriteProgress): NodeBoundary {
  const parent = change.parentNode;
  if (parent === null) {
    throw new Error('The change mark to remove has no parent');
  }
  const point: NodeBoundary = { container: parent, offset: [...parent.childNodes].indexOf(change) };
  const inline = isInlineChange(change);
  progress.changed = true;
  change.remove();
  if (inline) {
    return fillEmptiedBlock(root, point);
  }
  return readDropBoundary(root, fillEmptiedBlock(root, removeEmptiedContainers(root, point)));
}

/**
 * Gives the block a mark was taken out of its placeholder when nothing is left in it.
 *
 * @param root The editor root.
 * @param point The point the mark, or the outermost container that went with it, was taken out at.
 * @returns The start of the block when it was filled, otherwise the point itself.
 */
function fillEmptiedBlock(root: Element, point: NodeBoundary): NodeBoundary {
  const block = findBlock(point.container, root);
  if (block === undefined || !isEmptyBlock(block)) {
    return point;
  }
  fillPlaceholder(block);
  return { container: block, offset: 0 };
}

/**
 * Removes the lists and table sections that an element taken out left without items or rows, from the inside out.
 *
 * @param root The editor root. Never removed.
 * @param point The point the element was taken out at.
 * @returns The point the outermost removed container was at, or the given point when none was removed.
 */
function removeEmptiedContainers(root: Element, point: NodeBoundary): NodeBoundary {
  let current = point;
  for (
    let container = current.container;
    container instanceof Element && container !== root && isEmptiedContainer(container);
    container = current.container
  ) {
    const parent = container.parentNode;
    if (parent === null) {
      break;
    }
    current = { container: parent, offset: [...parent.childNodes].indexOf(container) };
    container.remove();
  }
  return current;
}

/**
 * Returns whether a list or a table section holds no item or row any more.
 *
 * A table keeps its column definitions and caption, which hold no row, so it counts as emptied without a row.
 *
 * @param element The element to check.
 */
function isEmptiedContainer(element: Element): boolean {
  if (!ITEM_CONTAINER_TAG_NAMES.has(element.localName)) {
    return false;
  }
  return element.localName === 'table' ? element.querySelector('tr') === null : element.children.length === 0;
}

/**
 * Returns the end of the last block inside an element, or of the element itself when it holds no block.
 *
 * An element that carries the kind (a row, a list item, a table) may not hold the caret itself, while its last block
 * does.
 *
 * @param element The element whose content was kept.
 */
function readContentEnd(element: Element): NodeBoundary {
  const blocks = element.querySelectorAll(BLOCK_SELECTOR);
  const last = blocks[blocks.length - 1] ?? element;
  return { container: last, offset: last.childNodes.length };
}

/**
 * Returns where the caret goes after an element that carried the kind was taken out at a point.
 *
 * Blocks inside entries are not candidates: they are not shown in the document flow.
 *
 * @param root The editor root.
 * @param point The point the element was taken out at.
 */
function readDropBoundary(root: Element, point: NodeBoundary): NodeBoundary {
  const probe = root.ownerDocument.createRange();
  probe.setStart(point.container, point.offset);
  probe.collapse(true);
  const blocks = [...root.querySelectorAll(BLOCK_SELECTOR)].filter((block) => !isInsideEntry(block, root));
  const next = blocks.find((block) => probe.comparePoint(block, 0) >= 0);
  if (next !== undefined) {
    return { container: next, offset: 0 };
  }
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (probe.comparePoint(block, block.childNodes.length) <= 0) {
      return { container: block, offset: block.childNodes.length };
    }
  }
  return { container: root, offset: 0 };
}

/**
 * Encodes a boundary as a selection whose start and end are the same.
 *
 * @param ports Ports for resolving change marks.
 * @param root Editor root.
 * @param boundary Boundary.
 * @returns Selection. `undefined` when it cannot be encoded (a return is then requested without a selection).
 */
function readCollapsedSelection(
  ports: ChangeResolvePorts,
  root: Element,
  boundary: NodeBoundary,
): EncodedSelection | undefined {
  try {
    const range = root.ownerDocument.createRange();
    range.setStart(boundary.container, boundary.offset);
    range.collapse(true);
    return captureRange(root, range)?.selection;
  } catch (error) {
    // The attempt is already closed, so the resolution cannot be undone here. Returning without a selection at least
    // brings the focus back.
    ports.reportDiagnostic(`Could not create the selection after resolving the change: ${String(error)}`);
    return undefined;
  }
}
