// Capture and restore the current Selection across a full DOM re-mount of the
// editor root. The browser's live Range objects become invalid the moment
// root.replaceChildren() runs, so we encode the selection endpoints as a
// path of *significant* child indices from the root: whitespace-only text
// nodes (which the editor uses purely for source-level indentation between
// blocks) are skipped when computing indices.
//
// Why "significant" indexing matters: when the user types Enter to create a
// new block, the live DOM gets two block siblings adjacent with no
// whitespace between them. The serializer reinserts that whitespace on the
// way to the file. When the save echoes back via `documentChanged`, the
// remounted DOM now has an extra text node between the blocks. A raw
// child-index path would point at the new text node and the restore would
// reject the type mismatch (or land in the wrong block). Skipping
// whitespace-only siblings makes the path stable across this asymmetric
// round-trip — without forcing us to mutate either side to match.

export interface SavedPosition {
  /**
   * Significant-child indices from root down to (but not including) the
   * selection node's parent.
   */
  path: number[];
  /**
   * Significant-child index of the selection node itself among its parent's
   * children. -1 means the selection node is the root.
   */
  nodeIndex: number;
  /**
   * For text nodes: character offset within the text. For element nodes:
   * significant-child offset (count of significant children before the
   * caret), translated back to a raw child index on restore.
   */
  offset: number;
  /** True if the selection node is a text node, false if it is an element. */
  isText: boolean;
}

export interface SavedSelection {
  anchor: SavedPosition;
  focus: SavedPosition;
}

function isSignificantChild(node: Node | null): boolean {
  if (!node) return false;
  if (node.nodeType === Node.ELEMENT_NODE) return true;
  if (node.nodeType === Node.TEXT_NODE) {
    return !/^\s*$/.test((node as Text).data);
  }
  return false;
}

function significantIndexOf(child: Node): number {
  const parent = child.parentNode;
  if (!parent) return -1;
  let count = 0;
  for (let i = 0; i < parent.childNodes.length; i++) {
    const c = parent.childNodes[i];
    if (c === child) return count;
    if (isSignificantChild(c)) count++;
  }
  return -1;
}

function findNthSignificantChild(parent: Node, sigIdx: number): Node | null {
  let count = 0;
  for (let i = 0; i < parent.childNodes.length; i++) {
    const c = parent.childNodes[i];
    if (!isSignificantChild(c)) continue;
    if (count === sigIdx) return c;
    count++;
  }
  return null;
}

function rawOffsetToSignificant(parent: Node, rawOffset: number): number {
  let count = 0;
  const limit = Math.min(rawOffset, parent.childNodes.length);
  for (let i = 0; i < limit; i++) {
    if (isSignificantChild(parent.childNodes[i])) count++;
  }
  return count;
}

function significantOffsetToRaw(parent: Node, sigOffset: number): number {
  let count = 0;
  for (let i = 0; i < parent.childNodes.length; i++) {
    if (count === sigOffset) return i;
    if (isSignificantChild(parent.childNodes[i])) count++;
  }
  return parent.childNodes.length;
}

function encodePosition(root: HTMLElement, node: Node, offset: number): SavedPosition | null {
  if (!root.contains(node)) return null;

  const isText = node.nodeType === Node.TEXT_NODE;
  if (!isText && node.nodeType !== Node.ELEMENT_NODE) return null;

  const indices: number[] = [];
  let current: Node = node;
  while (current !== root) {
    const parent = current.parentNode;
    if (!parent) return null;
    const idx = significantIndexOf(current);
    if (idx < 0) return null;
    indices.push(idx);
    current = parent;
  }
  indices.reverse();

  const nodeIndex = indices.pop();
  if (nodeIndex === undefined) {
    // The selection node IS the root. Raw element offset → significant.
    return {
      path: [],
      nodeIndex: -1,
      offset: rawOffsetToSignificant(root, offset),
      isText: false,
    };
  }

  const adjustedOffset = isText ? offset : rawOffsetToSignificant(node, offset);
  return { path: indices, nodeIndex, offset: adjustedOffset, isText };
}

function resolvePosition(
  root: HTMLElement,
  pos: SavedPosition,
): { node: Node; offset: number } | null {
  if (pos.nodeIndex < 0) {
    const raw = significantOffsetToRaw(root, pos.offset);
    return { node: root, offset: raw };
  }

  let parent: Node = root;
  for (const idx of pos.path) {
    const child = findNthSignificantChild(parent, idx);
    if (!child) return null;
    parent = child;
  }
  const target = findNthSignificantChild(parent, pos.nodeIndex);
  if (!target) return null;

  const targetIsText = target.nodeType === Node.TEXT_NODE;
  if (targetIsText !== pos.isText) return null;

  if (targetIsText) {
    const len = (target as Text).data.length;
    const clamped = Math.min(Math.max(pos.offset, 0), len);
    return { node: target, offset: clamped };
  }

  if (target.nodeType !== Node.ELEMENT_NODE) return null;
  return { node: target, offset: significantOffsetToRaw(target, pos.offset) };
}

export function captureSelection(root: HTMLElement): SavedSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const { anchorNode, anchorOffset, focusNode, focusOffset } = sel;
  if (!anchorNode || !focusNode) return null;
  if (!root.contains(anchorNode) || !root.contains(focusNode)) return null;

  const anchor = encodePosition(root, anchorNode, anchorOffset);
  if (!anchor) return null;
  const focus = encodePosition(root, focusNode, focusOffset);
  if (!focus) return null;

  return { anchor, focus };
}

export function restoreSelection(root: HTMLElement, saved: SavedSelection): boolean {
  const sel = window.getSelection();
  if (!sel) return false;

  const anchor = resolvePosition(root, saved.anchor);
  const focus = resolvePosition(root, saved.focus);
  if (!anchor || !focus) return false;

  root.focus();
  sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  return true;
}
