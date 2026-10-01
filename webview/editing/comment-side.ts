import { placeCaret, readSelectionRange } from './caret';
import { readCommentEdge, readCommentEdgePosition } from './comment-edge';
import type { CommentEdgeSide } from './comment-edge';
import type { ShortcutKey, ShortcutOutcome, ShortcutReceiver } from './shortcut-receiver';
import type { DeleteDirection } from './structure-boundary';
import type { NodeBoundary } from '../selection/selection-position';

/**
 * The key pair that switches the comment side. ← is backward and → is forward.
 *
 * Matched by position and requires no modifier. ← and → with modifiers extend the selection or move by word, so they do not match.
 */
export const COMMENT_SIDE_KEYS: { readonly backward: ShortcutKey; readonly forward: ShortcutKey } = {
  backward: { code: 'ArrowLeft', primary: false, shift: false, alt: false },
  forward: { code: 'ArrowRight', primary: false, shift: false, alt: false },
};

/** Ports for switching the comment side. Holds no values and reads them on every call, because document replacement swaps the editing session. */
export interface CommentSidePorts {
  /** Returns the editor root. `undefined` before mounting. */
  readEditorRoot(): HTMLElement | undefined;

  /** Whether an IME composition is in progress. */
  isComposing(): boolean;

  /**
   * Records one diagnostic line for maintainers. Not used for user notifications.
   *
   * @param detail The line to record.
   */
  reportDiagnostic(detail: string): void;
}

/**
 * Determines the side target for switching the comment side from a collapsed caret and a direction. Changes neither the tree nor the selection.
 *
 * Swaps inside and outside neighbor at the same visual position. The default caret movement does not stop inside at the start side or at the outside neighbor at the end side,
 * so the caret first passes through the opposite side at the same visual position before advancing in the direction of movement.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @param direction The direction. ← is backward and → is forward.
 * @returns The side target. `undefined` for a range selection, a position that is not a comment edge, or the same direction on the opposite side.
 */
export function readCommentSideTarget(root: Element, range: Range, direction: DeleteDirection): NodeBoundary | undefined {
  if (!range.collapsed) {
    return undefined;
  }
  const edge = readCommentEdge(root, { container: range.startContainer, offset: range.startOffset }, direction);
  if (edge === undefined) {
    return undefined;
  }
  // → goes from inside to outside on the end side and from outside to inside on the start side. ← is the reverse.
  const leavingSide: CommentEdgeSide = direction === 'forward' ? 'end' : 'start';
  if (edge.place === 'inside' && edge.side === leavingSide) {
    return readCommentEdgePosition(edge.comment, 'outside', edge.side);
  }
  if (edge.place === 'outside' && edge.side !== leavingSide) {
    return readCommentEdgePosition(edge.comment, 'inside', edge.side);
  }
  return undefined;
}

/**
 * As the action of the ← and → shortcuts, moves the caret to the opposite side and takes over when a switch applies.
 *
 * ← and → during composition are left to the IME and the browser. Exceptions are not left to the receiver's handling (stopping the key), so the default caret movement remains.
 *
 * @param direction The direction.
 * @param ports The ports.
 * @returns "Prevent default" if the caret was moved, otherwise "pass".
 */
export function switchCommentSide(direction: DeleteDirection, ports: CommentSidePorts): ShortcutOutcome {
  try {
    if (ports.isComposing()) {
      return 'pass';
    }
    const root = ports.readEditorRoot();
    const range = root === undefined ? undefined : readSelectionRange(root);
    if (root === undefined || range === undefined) {
      return 'pass';
    }
    const target = readCommentSideTarget(root, range, direction);
    if (target === undefined) {
      return 'pass';
    }
    placeCaret(target.container, target.offset);
    return 'preventDefault';
  } catch (error) {
    ports.reportDiagnostic(`Could not switch the comment side: ${String(error)}`);
    return 'pass';
  }
}

/**
 * Appends shortcuts for unmodified ← and → to the end of the receiver's list.
 *
 * The receiver lives as long as the view, so call this only once on the first mount. There are no other shortcuts for unmodified ← and →, so it does not rely on registration order.
 *
 * @param receiver The shortcut receiver.
 * @param ports The ports.
 */
export function registerCommentSideKeys(receiver: Pick<ShortcutReceiver, 'register'>, ports: CommentSidePorts): void {
  receiver.register({ key: COMMENT_SIDE_KEYS.backward, run: () => switchCommentSide('backward', ports) });
  receiver.register({ key: COMMENT_SIDE_KEYS.forward, run: () => switchCommentSide('forward', ports) });
}
