// Link command: insert, update, or remove an <a> around the current selection.

import {
  findAncestor,
  resolveToTextBoundary,
  selectContents,
  surroundSimple,
  unwrap,
} from '../shared/dom-utils';
import type { CommandContext } from '../shared/command-context';

/**
 * Insert or update a link. Pass href='' to remove.
 *
 * Non-collapsed selection: removes all intersecting <a> elements first,
 * then (if href non-empty) wraps the entire selection in a new <a>.
 */
export function insertLink(href: string, ctx: CommandContext): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  if (range.collapsed) {
    const existing = findAncestor(range.startContainer, 'A', ctx.root);
    if (existing) {
      if (href === '') { unwrap(existing); } else { existing.setAttribute('href', href); }
    } else if (href !== '') {
      const a = document.createElement('a');
      a.setAttribute('href', href);
      a.textContent = href;
      range.insertNode(a);
      selectContents(sel, a);
    }
    return;
  }

  const links = Array.from(ctx.root.querySelectorAll<HTMLElement>('a'))
    .filter(a => range.intersectsNode(a));

  // If the selection is entirely within one existing <a>, update/remove it directly.
  // Avoids the remove-and-rewrap path which breaks when the range container is
  // the element node (e.g. from selectNodeContents) rather than a text node.
  if (links.length === 1) {
    const existingA = links[0];
    const startIn = existingA === range.startContainer || existingA.contains(range.startContainer);
    const endIn   = existingA === range.endContainer   || existingA.contains(range.endContainer);
    if (startIn && endIn) {
      if (href === '') { unwrap(existingA); } else { existingA.setAttribute('href', href); }
      return;
    }
  }

  // General case: save text-node boundary positions before any DOM mutations,
  // then unwrap all intersecting <a> elements (which may move their text nodes),
  // then rebuild the range from the still-live text node references.
  // Using the live range after unwrap is unreliable because jsdom (and browsers)
  // adjust range offsets by child-index, not by following the moved text node.
  const [startNode, startOff] = resolveToTextBoundary(range.startContainer, range.startOffset);
  const [endNode, endOff]     = resolveToTextBoundary(range.endContainer,   range.endOffset);

  for (const a of links) unwrap(a);
  if (href === '') return;

  // Rebuild range from saved text-node positions (nodes remain in the DOM after unwrapping).
  const freshRange = document.createRange();
  try {
    freshRange.setStart(startNode, startOff);
    freshRange.setEnd(endNode, endOff);
  } catch {
    return; // positions became invalid after DOM mutation
  }

  const a = document.createElement('a');
  a.setAttribute('href', href);
  surroundSimple(freshRange, a);
  selectContents(sel, a);
}
