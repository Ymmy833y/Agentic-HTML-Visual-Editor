// Multi-block selection inside a <details> body.
//
// Native <details> renders its body (everything after <summary>) through a UA
// shadow-DOM slot (`::details-content`). Inside a contenteditable host, Blink's
// own selection-extension cannot cross that slot/block boundary once a selection
// spans it: a Shift+Arrow or drag that reaches into the next body block clamps,
// so the user cannot extend a selection across the body's paragraphs. This is a
// browser limitation, not a structural one — a Range set programmatically across
// the blocks renders fine, and (crucially) `Selection.modify` off a *collapsed*
// caret does cross the boundary correctly, preserving the goal column.
//
// So we drive the selection ourselves for gestures inside a details body:
//   * Mouse drag — resolve the focus with caretPositionFromPoint and extend the
//     selection past the boundary once the pointer crosses into another block.
//   * Shift+Arrow / Home / End — collapse to the current focus (a single-block
//     caret Blink handles fine), run the native modification to find the new
//     focus, then reattach the original anchor across the boundary. Vertical
//     arrows are always driven so the crossing lands at the right column;
//     horizontal / line-edge keys are driven only once the selection already
//     straddles the slot (native handles them fine until then).
//
// All of this leaves the native <details> element (and the saved HTML) untouched.
//
// Note: unlike the native drag, our custom drag does not auto-scroll the
// viewport when the pointer leaves it. That edge case is out of scope here.

import { caretPositionFromPoint, findAncestor, findBlockAncestor } from '../../shared/dom-utils';

/** A caret position within the editor, as a node + offset pair. */
interface CaretPos {
  node: Node;
  offset: number;
}

/** A Shift-navigation key mapped to the Selection.modify move it performs. */
interface NavMove {
  dir: 'forward' | 'backward';
  granularity: 'character' | 'line' | 'lineboundary';
  vertical: boolean;
}

const NAV_MOVES: Record<string, NavMove> = {
  ArrowDown: { dir: 'forward', granularity: 'line', vertical: true },
  ArrowUp: { dir: 'backward', granularity: 'line', vertical: true },
  ArrowRight: { dir: 'forward', granularity: 'character', vertical: false },
  ArrowLeft: { dir: 'backward', granularity: 'character', vertical: false },
  End: { dir: 'forward', granularity: 'lineboundary', vertical: false },
  Home: { dir: 'backward', granularity: 'lineboundary', vertical: false },
};

/** The caret's <details> body host (never the <summary>), or null. */
function detailsBodyHost(node: Node, root: HTMLElement): HTMLElement | null {
  const details = findAncestor(node, 'DETAILS', root);
  if (!details) return null;
  if (findAncestor(node, 'SUMMARY', root)) return null;
  return details;
}

export function mountDetailsSelection(root: HTMLElement): void {
  // The fixed anchor of an in-progress custom drag (the mousedown caret), or
  // null when no details-body drag is active.
  let dragAnchor: CaretPos | null = null;

  root.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    const anchor = caretPositionFromPoint(e.clientX, e.clientY);
    if (!anchor || !root.contains(anchor.node)) return;
    // Only arm for drags that start inside a details body; elsewhere the native
    // selection is fine and must not be disturbed.
    if (!detailsBodyHost(anchor.node, root)) return;
    dragAnchor = anchor;
  });

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragAnchor) return;
    // Primary button released (possibly outside the window): end the drag.
    if ((e.buttons & 1) === 0) {
      dragAnchor = null;
      return;
    }
    const focus = caretPositionFromPoint(e.clientX, e.clientY);
    if (!focus || !root.contains(focus.node)) return;

    // Within the anchor's own block the native drag already works (and keeps
    // word/line granularity), so only take over once the pointer crosses into
    // a different block, which is exactly where the browser clamps.
    const anchorBlock = findBlockAncestor(dragAnchor.node, root);
    const focusBlock = findBlockAncestor(focus.node, root);
    if (anchorBlock && focusBlock && anchorBlock === focusBlock) return;

    const sel = window.getSelection();
    if (!sel) return;
    sel.setBaseAndExtent(dragAnchor.node, dragAnchor.offset, focus.node, focus.offset);
  });

  document.addEventListener('mouseup', () => {
    dragAnchor = null;
  });

  root.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const move = NAV_MOVES[e.key];
    if (move && extendFocusAcrossBoundary(root, move)) e.preventDefault();
  });
}

/**
 * Extend the selection's focus for a Shift-navigation key that the browser would
 * otherwise clamp at a details body block boundary. The move is computed off a
 * collapsed focus — which Blink resolves correctly even across the slot — then
 * the original anchor is reattached with setBaseAndExtent. Acts only when the
 * focus sits in a details body; horizontal / line-edge keys are left to the
 * (working) native behavior until the selection actually straddles two blocks.
 * Returns whether it acted.
 */
function extendFocusAcrossBoundary(root: HTMLElement, move: NavMove): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const { anchorNode, anchorOffset, focusNode, focusOffset } = sel;
  if (!anchorNode || !focusNode) return false;
  if (!root.contains(anchorNode) || !root.contains(focusNode)) return false;
  if (!detailsBodyHost(focusNode, root)) return false;

  if (!move.vertical) {
    const anchorBlock = findBlockAncestor(anchorNode, root);
    const focusBlock = findBlockAncestor(focusNode, root);
    if (!anchorBlock || !focusBlock || anchorBlock === focusBlock) return false;
  }

  sel.collapse(focusNode, focusOffset);
  sel.modify('extend', move.dir, move.granularity);
  const newFocusNode = sel.focusNode;
  if (!newFocusNode) return false;
  sel.setBaseAndExtent(anchorNode, anchorOffset, newFocusNode, sel.focusOffset);
  return true;
}
