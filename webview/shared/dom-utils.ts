// Generic DOM traversal/mutation helpers shared across editing commands.
// These were previously copy-pasted into commands.ts, table-commands.ts,
// editor-core.ts, and paste-sanitize.ts.

import { BLOCK_TAGS } from './constants';

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
