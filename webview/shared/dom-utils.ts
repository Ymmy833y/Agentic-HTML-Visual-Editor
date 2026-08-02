// Generic DOM traversal/mutation helpers shared across editing commands.
// These were previously copy-pasted into commands.ts, table-commands.ts,
// editor-core.ts, and paste-sanitize.ts.

import { BLOCK_TAGS } from './constants';
import type { DeleteDirection } from './constants';

/** Return the nearest ancestor element with the given (uppercase) tagName, inside stopAt. */
export function findAncestor(node: Node, tagName: string, stopAt: Element): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== stopAt) {
    if (cur instanceof HTMLElement && cur.tagName === tagName) return cur;
    cur = cur.parentNode;
  }
  return null;
}

/**
 * True when node sits inside a comment's metadata (`<comment-body>` /
 * `<comment-reply>`), which is rendered in the popup rather than inline. Callers
 * that walk visible text (inline-format coverage, document search) skip these.
 */
export function isInCommentMeta(node: Node, stopAt: Element): boolean {
  let cur: Node | null = node;
  while (cur && cur !== stopAt) {
    if (cur instanceof HTMLElement) {
      const t = cur.tagName;
      if (t === 'COMMENT-BODY' || t === 'COMMENT-REPLY') return true;
    }
    cur = cur.parentNode;
  }
  return false;
}

/** Return the nearest block-level ancestor element inside stopAt. */
export function findBlockAncestor(node: Node, stopAt: Element): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== stopAt) {
    if (cur instanceof HTMLElement && BLOCK_TAGS.has(cur.tagName)) return cur;
    cur = cur.parentNode;
  }
  return null;
}

/**
 * Return the nearest enclosing list container (UL or OL) inside stopAt, or null.
 * Walks caret→root and returns the FIRST list found, so the innermost list wins
 * when lists are nested. UL/OL are intentionally not in BLOCK_TAGS (they are
 * containers, not editable blocks), so this is kept separate from
 * {@link findBlockAncestor}.
 */
export function findListContainer(node: Node, stopAt: Element): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== stopAt) {
    if (cur instanceof HTMLElement && (cur.tagName === 'UL' || cur.tagName === 'OL')) {
      return cur;
    }
    cur = cur.parentNode;
  }
  return null;
}

/**
 * Resolve the editable container of a caret for the block-level commands: the
 * nearest {@link BLOCK_TAGS} ancestor, or — when a table cell (TD/TH) is reached
 * before any block — the cell itself, flagged `bareCell`. Table cells hold bare
 * inline content (no wrapping block), so a caret in a fresh cell has no block
 * ancestor; the `bareCell` result tells callers they must wrap the content first
 * (see {@link findBlockAncestor} returning null there). Returns null when neither
 * a block nor a cell is found inside stopAt.
 */
export function blockOrBareCell(
  node: Node,
  stopAt: Element,
): { el: HTMLElement; bareCell: boolean } | null {
  let cur: Node | null = node;
  while (cur && cur !== stopAt) {
    if (cur instanceof HTMLElement) {
      if (BLOCK_TAGS.has(cur.tagName)) return { el: cur, bareCell: false };
      if (cur.tagName === 'TD' || cur.tagName === 'TH') return { el: cur, bareCell: true };
    }
    cur = cur.parentNode;
  }
  return null;
}

/** Replace an element with its children (move children up, then remove the element). */
export function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  el.remove();
}

/** Number of ancestor steps from node up to (but not including) root. */
export function nodeDepth(node: Node, root: Element): number {
  let d = 0;
  let cur: Node | null = node;
  while (cur && cur !== root) { d++; cur = cur.parentNode; }
  return d;
}

/** True when a block has no element children and only whitespace text. */
export function isBlockEmpty(el: Element): boolean {
  return el.children.length === 0 && (el.textContent ?? '').trim() === '';
}

/**
 * Like {@link isBlockEmpty} but also treats a block whose only child is a stub
 * `<br>` (browsers insert these into otherwise-empty blocks) as empty.
 */
export function isBlockEmptyOrStubBr(el: Element): boolean {
  if (el.children.length === 0) {
    return (el.textContent ?? '').trim() === '';
  }
  if (el.children.length === 1 && el.children[0].tagName === 'BR') {
    return (el.textContent ?? '').trim() === '';
  }
  return false;
}

/**
 * A trailing node is insignificant if it is whitespace-only text, a <br>, or an
 * inline wrapper whose own children are all insignificant. This is what "the
 * caret is at the edge of its block" is decided by, so it is shared by the Enter
 * handlers, the block-merge handlers, and the structural-boundary commands.
 */
export function isInsignificantTail(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return /^\s*$/.test((node as Text).data);
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  if (el.tagName === 'BR') return true;
  if (BLOCK_TAGS.has(el.tagName)) return false;
  return Array.from(el.childNodes).every(isInsignificantTail);
}

/** Mirror of {@link isCaretAtBlockEnd}: nothing significant precedes the caret
 *  within the block (only whitespace / <br> / empty inline wrappers). */
export function isCaretAtBlockStart(range: Range, block: Element): boolean {
  const head = document.createRange();
  head.setStart(block, 0);
  head.setEnd(range.startContainer, range.startOffset);
  const fragment = head.cloneContents();
  return Array.from(fragment.childNodes).every(isInsignificantTail);
}

/** Nothing significant follows the caret within the block. */
export function isCaretAtBlockEnd(range: Range, block: Element): boolean {
  const tail = document.createRange();
  tail.setStart(range.endContainer, range.endOffset);
  tail.setEnd(block, block.childNodes.length);
  const fragment = tail.cloneContents();
  return Array.from(fragment.childNodes).every(isInsignificantTail);
}

/**
 * Whether an element is explicitly locked with `contenteditable="false"`.
 *
 * Read from the attribute rather than the `contentEditable` property on
 * purpose: jsdom does not implement that property (it answers `undefined`),
 * so a property test is dead in every unit test and only ever runs in the
 * browser — which makes the behaviour it guards impossible to cover at the
 * fastest layer. The attribute value is ASCII case-insensitive per the HTML
 * spec, which is why it is lowercased before comparing.
 */
export function isContentEditableFalse(el: Element): boolean {
  return el.getAttribute('contenteditable')?.toLowerCase() === 'false';
}

/**
 * Deepest non-empty text node inside `node`, taken from its start (`atEnd`
 * false) or its end (`atEnd` true). Hidden comment metadata and any
 * contenteditable=false subtree are skipped, so the result is always a spot a
 * caret can sit in and a deletion may touch.
 *
 * Single walker for every caller that needs "the first/last real text in here":
 * comment target resolution, the text following a comment, and structural caret
 * placement all share it, so a fix to the traversal cannot land in one and miss
 * the others.
 *
 * `skip` excludes one more kind of subtree, for callers that need a spot the
 * reader can actually SEE rather than merely one a caret can occupy. The two
 * differ: commands/structural-boundary passes it to stay out of a collapsed
 * <details> body, which renders nothing yet holds perfectly ordinary editable
 * text. Callers that omit it get the plain editability rule above.
 */
export function deepestEditableText(
  node: Node,
  atEnd: boolean,
  skip?: (element: HTMLElement) => boolean,
): Text | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node as Text).data.length > 0 ? node as Text : null;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const element = node as HTMLElement;
  if (
    element.tagName === 'COMMENT-BODY' ||
    element.tagName === 'COMMENT-REPLY' ||
    isContentEditableFalse(element) ||
    skip?.(element)
  ) {
    return null;
  }
  const children = Array.from(element.childNodes);
  if (atEnd) children.reverse();
  for (const child of children) {
    const text = deepestEditableText(child, atEnd, skip);
    if (text) return text;
  }
  return null;
}

/** The node directly before a collapsed caret, or null when the caret sits
 *  mid-text (a normal in-place deletion the caller should leave to the browser). */
export function nodeImmediatelyBeforeCaret(range: Range): Node | null {
  const { startContainer, startOffset } = range;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    return startOffset === 0 ? startContainer.previousSibling : null;
  }
  return startOffset > 0 ? startContainer.childNodes[startOffset - 1] : null;
}

/** The node directly after a collapsed caret, or null when the caret sits
 *  mid-text (a normal in-place forward deletion the caller should not redirect). */
export function nodeImmediatelyAfterCaret(range: Range): Node | null {
  const { startContainer, startOffset } = range;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    return startOffset === (startContainer as Text).data.length
      ? startContainer.nextSibling
      : null;
  }
  return startOffset < startContainer.childNodes.length
    ? startContainer.childNodes[startOffset]
    : null;
}

/** What a block-edge deletion faces, and the containers it had to leave. */
export interface BoundaryClimb {
  /** First significant node in the deletion's direction, or null. */
  neighbour: Node | null;
  /** Containers stepped out of on the way, innermost first. Each had no
   *  sibling in that direction, so the deletion leaves it entirely. */
  crossed: HTMLElement[];
}

/**
 * Climb from `block` towards `root` while there is no sibling in the deletion's
 * direction, and report what it ends up facing. Stopping at the first sibling
 * preserves native editing inside lists, quotes, and tables, while the climb is
 * what lets a container's outer edge answer for its first or last child.
 *
 * Shared because two guards ask the very same question — "what does this
 * block-edge deletion actually reach?" — and would otherwise answer it with two
 * subtly different walks: commands/structural-boundary blocks a structural
 * neighbour, features/comment/comment-deletion blocks one carrying an
 * annotation. Only the verdict differs.
 */
export function climbToBoundaryNeighbour(
  block: HTMLElement,
  root: HTMLElement,
  direction: DeleteDirection,
): BoundaryClimb {
  const crossed: HTMLElement[] = [];
  let current: HTMLElement = block;
  for (;;) {
    const adjacent = significantSiblingInDirection(current, direction);
    if (adjacent) return { neighbour: adjacent, crossed };
    const parent = current.parentElement;
    if (!parent || parent === root) return { neighbour: null, crossed };
    crossed.push(parent);
    current = parent;
  }
}

/**
 * The significant node a deletion leaving `block` in `direction` would cross
 * into, or null when it would leave the root instead. The containers-crossed
 * half of {@link climbToBoundaryNeighbour} discarded, for callers that only
 * need the verdict.
 */
export function blockBoundaryNeighbour(
  block: HTMLElement,
  root: HTMLElement,
  direction: DeleteDirection,
): Node | null {
  return climbToBoundaryNeighbour(block, root, direction).neighbour;
}

/**
 * The significant node a bare inline run faces, when the caret sits at that
 * run's edge — or null when the caret is not in such a run, or not at its edge.
 *
 * Bare inline content is a shape the editor already supports elsewhere (see
 * `findBareRootRun` in commands/block-format, which exists because "existing
 * HTML may place text or inline elements directly in <body> without a paragraph
 * wrapper"). Whenever such a run sits beside a block, the run's neighbour — not
 * the enclosing block's — is what a deletion crosses.
 *
 * Shared, like {@link climbToBoundaryNeighbour}, because both block-edge guards
 * need it and would otherwise answer it with two subtly different walks:
 * commands/structural-boundary asks whether the run faces a <pre>/<details>,
 * features/comment/comment-deletion whether it faces a block carrying an
 * annotation. Only the verdict differs.
 *
 * The host is whatever element the run is a direct child of, not a list of tag
 * names. Naming the shapes instead — the root, a table cell, a <details> body —
 * reads like the complete set only because those are the ones with no usable
 * block ancestor at all. `<div><pre>…</pre>text</div>` has the identical problem
 * with an ordinary block host: the block IS the container, so its own start sits
 * before the <pre> and the block-level edge test reports "not at a boundary"
 * while the run sits directly against it. A block child of the host is still
 * delimited by itself and is handed back to that test by returning null.
 */
export function bareRunSiblingInDirection(
  range: Range,
  root: HTMLElement,
  direction: DeleteDirection,
): Node | null {
  const host = blockOrBareCell(range.startContainer, root)?.el ?? root;

  // An element-level caret sits BETWEEN the host's children rather than inside
  // a run, so there is no node whose edge could be tested: the deletion simply
  // faces the adjacent child. {@link childOfHost} cannot answer here — asked
  // for the host itself it climbs straight past it — and treating that as "no
  // bare run" drops the whole guard at exactly the position
  // `removeAnchorlessComment` in features/comment/comment-deletion leaves the
  // caret in, so the next keystroke would meet the browser default these guards
  // stand in front of.
  if (range.startContainer === host) {
    const facing = host.childNodes[
      direction === 'backward' ? range.startOffset - 1 : range.startOffset
    ];
    return significantNodeFrom(facing ?? null, direction);
  }

  const node = childOfHost(range.startContainer, host);
  // A block child is delimited by itself; the ordinary edge test owns it.
  if (!node || (node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((node as Element).tagName))) {
    return null;
  }
  if (!isCaretAtNodeEdge(range, node, direction)) return null;

  return significantNodeFrom(
    direction === 'backward' ? node.previousSibling : node.nextSibling,
    direction,
  );
}

/** The ancestor of `node` that is a direct child of `host`, or null when
 *  `node` is not inside `host` — including when `node` IS `host`, which has no
 *  such ancestor (see the element-level branch in the caller). */
function childOfHost(node: Node, host: HTMLElement): Node | null {
  let current: Node | null = node;
  while (current && current.parentNode !== host) current = current.parentNode;
  return current;
}

/** Nothing significant sits between the caret and `node`'s edge on that side. */
function isCaretAtNodeEdge(range: Range, node: Node, direction: DeleteDirection): boolean {
  const edge = document.createRange();
  if (direction === 'backward') {
    edge.setStartBefore(node);
    edge.setEnd(range.startContainer, range.startOffset);
  } else {
    edge.setStart(range.startContainer, range.startOffset);
    edge.setEndAfter(node);
  }
  return Array.from(edge.cloneContents().childNodes).every(isInsignificantTail);
}

export function significantSiblingInDirection(
  element: Element,
  direction: DeleteDirection,
): Node | null {
  return significantNodeFrom(
    direction === 'backward' ? element.previousSibling : element.nextSibling,
    direction,
  );
}

/**
 * Walk a sibling list from `node` in `direction` until something significant is
 * found, or the list runs out. Single skip rule for every caller, so a caret
 * resolved from a run, from a sibling, or from an element-level offset all agree
 * on what counts as being in the way.
 */
export function significantNodeFrom(node: Node | null, direction: DeleteDirection): Node | null {
  let current = node;
  while (current && isIgnorableStructuralSibling(current)) {
    current = direction === 'backward' ? current.previousSibling : current.nextSibling;
  }
  return current;
}

/**
 * Only formatting noise is skipped when looking for the neighbouring block: an
 * HTML comment and whitespace between tags. A <br> is deliberately significant
 * — skipping it would extend a structural block's protection over the <br> and
 * leave it undeletable from either side.
 */
function isIgnorableStructuralSibling(node: Node): boolean {
  if (node.nodeType === Node.COMMENT_NODE) return true;
  return node.nodeType === Node.TEXT_NODE && /^\s*$/.test((node as Text).data);
}

/** Wrap a range's contents in wrapper, falling back to extract+insert when the
 * range partially intersects element boundaries (surroundContents throws). */
export function surroundSimple(range: Range, wrapper: Element): void {
  try {
    range.surroundContents(wrapper);
  } catch {
    const contents = range.extractContents();
    wrapper.appendChild(contents);
    range.insertNode(wrapper);
  }
}

/**
 * Resolve the caret position (node + offset) under a viewport point, bridging the
 * two browser APIs: the standard `caretPositionFromPoint` (Firefox / modern
 * Chromium) and the legacy `caretRangeFromPoint` (WebKit / older Chromium).
 * Over content slotted into a UA shadow tree (e.g. `<details>` body) both APIs
 * report the light-DOM text node, which is what Selection ranges operate on.
 * Returns null when no caret resolves at that point.
 */
export function caretPositionFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos) return { node: pos.offsetNode, offset: pos.offset };
  }
  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

/** Collapse the selection onto the full contents of el. */
export function selectContents(sel: Selection, el: Node): void {
  const r = document.createRange();
  r.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(r);
}

/**
 * Resolve a range boundary (container + offset) to a text-node level position.
 * When container is an Element node (e.g. from selectNodeContents), the offset
 * refers to a child index; we follow it to the child text node if possible.
 * This gives a stable reference that survives the unwrapping of ancestor elements.
 */
export function resolveToTextBoundary(container: Node, offset: number): [Node, number] {
  if (container.nodeType === Node.TEXT_NODE) return [container, offset];
  const child = container.childNodes[offset];
  if (child?.nodeType === Node.TEXT_NODE) return [child, 0];
  const prev = container.childNodes[offset - 1];
  if (prev?.nodeType === Node.TEXT_NODE) return [prev, (prev as Text).length];
  return [container, offset];
}
