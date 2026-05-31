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

/** Return the nearest block-level ancestor element inside stopAt. */
export function findBlockAncestor(node: Node, stopAt: Element): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== stopAt) {
    if (cur instanceof HTMLElement && BLOCK_TAGS.has(cur.tagName)) return cur;
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
