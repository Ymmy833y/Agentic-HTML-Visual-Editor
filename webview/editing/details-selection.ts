import { findBlock } from './block';
import { findOpenBodySection } from './details-section';
import type { DiagnosticReporter } from './input-dispatcher';

/** The direction and granularity used to work out where a move key's default action lands. */
export interface MoveKeyTarget {
  /** The direction to move. Left/right are held using the spelling that follows writing direction. */
  readonly direction: 'left' | 'right' | 'forward' | 'backward';
  /** The granularity to move by. */
  readonly granularity: 'character' | 'line';
}

/**
 * The move keys this intervenes on, and the direction/granularity used to find each one's target.
 *
 * Holds only the four arrow keys. Home/End do not cross a block boundary by default either, so there
 * is no reason to intervene on them.
 */
export const MOVE_KEY_TARGETS: ReadonlyMap<string, MoveKeyTarget> = new Map([
  ['ArrowLeft', { direction: 'left', granularity: 'character' }],
  ['ArrowRight', { direction: 'right', granularity: 'character' }],
  ['ArrowUp', { direction: 'backward', granularity: 'line' }],
  ['ArrowDown', { direction: 'forward', granularity: 'line' }],
]);

/** The receivers for one drag. Does not know what it is attached to. */
export interface DragExtender {
  /** A primary-button press. Inside an open collapsible section's body, remembers that position as the origin. */
  handlePointerDown(event: MouseEvent): void;
  /** A pointer move. Re-anchors the selection from the remembered origin to the current position. */
  handlePointerMove(event: MouseEvent): void;
  /** A button release. Discards the remembered origin. */
  handlePointerUp(): void;
  /** A drag start. Stops the default only while an origin is remembered. */
  handleDragStart(event: Event): void;
}

/** A caret position obtained from a pointer position. */
interface CaretPoint {
  readonly node: Node;
  readonly offset: number;
}

/** Of `MouseEvent.buttons`, the bit that represents the primary button being pressed. */
const PRIMARY_BUTTON_FLAG = 1;

/**
 * Creates receivers that let a drag inside a body cross block boundaries with the selection.
 *
 * The browser stops a drag selection at block boundaries inside an open collapsible section's body,
 * so this re-anchors the selection from the remembered origin instead. Does not change the tree.
 *
 * @param root The editor root.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 * @returns The receivers for one drag.
 */
export function createDragExtender(
  root: Element,
  reportDiagnostic: DiagnosticReporter,
): DragExtender {
  // The origin for one drag. Set on press, discarded on release and on exception.
  let origin: CaretPoint | undefined;
  let originBlock: Element | undefined;

  const forget = (error: unknown): void => {
    reportDiagnostic(`Failed to continue extending the selection by dragging inside the body: ${String(error)}`);
    origin = undefined;
    originBlock = undefined;
  };

  return {
    handlePointerDown(event: MouseEvent): void {
      origin = undefined;
      originBlock = undefined;
      // A press whose default is already stopped belongs to another feature, such as the marker area.
      if (event.button !== 0 || event.defaultPrevented) {
        return;
      }
      try {
        const point = readCaretPoint(root, event);
        if (point === undefined || findOpenBodySection(point.node, root) === undefined) {
          return;
        }
        origin = point;
        originBlock = findBlock(point.node, root);
      } catch (error) {
        forget(error);
      }
    },

    handlePointerMove(event: MouseEvent): void {
      const start = origin;
      if (start === undefined) {
        return;
      }
      if ((event.buttons & PRIMARY_BUTTON_FLAG) === 0) {
        // Releasing the button outside the editor root never reaches the release receiver. A move
        // with no button pressed is what that leaves behind, and without discarding the origin here,
        // the selection would keep re-anchoring itself every time the pointer comes back.
        origin = undefined;
        originBlock = undefined;
        return;
      }
      try {
        const point = readCaretPoint(root, event);
        const block = point === undefined ? undefined : findBlock(point.node, root);
        // Do not re-anchor within the same block; that would overwrite a word- or line-granularity selection.
        if (point === undefined || block === undefined || block === originBlock) {
          return;
        }
        const selection = root.ownerDocument.defaultView?.getSelection();
        selection?.setBaseAndExtent(start.node, start.offset, point.node, point.offset);
      } catch (error) {
        forget(error);
      }
    },

    handlePointerUp(): void {
      origin = undefined;
      originBlock = undefined;
    },

    handleDragStart(event: Event): void {
      // If the browser started a selection drag over the re-anchored selection, it would move the tree.
      if (origin !== undefined) {
        event.preventDefault();
      }
    },
  };
}

/**
 * With Shift+move key, moves only the selection's focus end past a block boundary.
 *
 * Intervenes only when both the anchor and the focus are inside an open collapsible section's body.
 * Does not change the tree, and allows the extended result to land outside the collapsible section.
 *
 * @param root The editor root.
 * @param event The key press.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 * @returns `true` when the default was stopped.
 */
export function extendSelectionByKey(
  root: Element,
  event: KeyboardEvent,
  reportDiagnostic: DiagnosticReporter,
): boolean {
  const target = MOVE_KEY_TARGETS.get(event.key);
  if (
    target === undefined
    || !event.shiftKey
    || event.ctrlKey
    || event.altKey
    || event.metaKey
    || event.isComposing
  ) {
    return false;
  }

  const selection = root.ownerDocument.defaultView?.getSelection();
  if (selection === null || selection === undefined) {
    return false;
  }
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  if (anchorNode === null || focusNode === null) {
    return false;
  }
  if (
    findOpenBodySection(anchorNode, root) === undefined
    || findOpenBodySection(focusNode, root) === undefined
  ) {
    return false;
  }
  if (typeof selection.modify !== 'function') {
    return false;
  }

  try {
    // Read where the default would move to by collapsing the selection to the focus end and moving it
    // one step. Moving it while still extended would run into the very behavior that stops at block boundaries.
    selection.collapse(focusNode, focusOffset);
    selection.modify('move', target.direction, target.granularity);
    const movedNode = selection.focusNode;
    const movedOffset = selection.focusOffset;
    if (movedNode === null || (movedNode === focusNode && movedOffset === focusOffset)) {
      selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
      return false;
    }
    selection.setBaseAndExtent(anchorNode, anchorOffset, movedNode, movedOffset);
    event.preventDefault();
    return true;
  } catch (error) {
    reportDiagnostic(`Failed to finish extending the selection by key press: ${String(error)}`);
    selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
    return false;
  }
}

/**
 * Obtains a caret position from a pointer position.
 *
 * @param root The editor root.
 * @param event The mouse event.
 * @returns The caret position. `undefined` if none can be obtained, or if it is outside the editor root.
 */
function readCaretPoint(root: Element, event: MouseEvent): CaretPoint | undefined {
  const position = root.ownerDocument.caretPositionFromPoint?.(event.clientX, event.clientY);
  if (position === null || position === undefined || !root.contains(position.offsetNode)) {
    return undefined;
  }
  return { node: position.offsetNode, offset: position.offset };
}
