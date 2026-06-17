// Read-only queries used by the toolbar to reflect the current selection's
// formatting state (active block tag, enclosing inline element).

import { BLOCK_TAGS } from '../shared/constants';
import { findAncestor, findListContainer } from '../shared/dom-utils';

/** Return the lowercase tag name of the nearest block ancestor inside root. */
export function getCurrentBlockTag(node: Node, root: Element): string {
  let cur: Node | null = node;
  while (cur && cur !== root) {
    if (cur instanceof HTMLElement && BLOCK_TAGS.has(cur.tagName)) {
      return cur.tagName.toLowerCase();
    }
    cur = cur.parentNode;
  }
  return '';
}

/** Return the type of the nearest enclosing list container, or '' if none. */
export function getNearestListType(node: Node, root: Element): 'ul' | 'ol' | '' {
  const list = findListContainer(node, root);
  return list ? (list.tagName.toLowerCase() as 'ul' | 'ol') : '';
}

/** Return the nearest ancestor element with tagName inside root. */
export function findInlineAncestor(
  node: Node,
  tagName: string,
  stopAt: Element,
): HTMLElement | null {
  return findAncestor(node, tagName, stopAt);
}
