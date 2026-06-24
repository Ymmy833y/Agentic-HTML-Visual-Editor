// Comment commands: wrap a selection in an inline <comment> and remove an
// existing comment highlight. Comment body/reply storage lives in comment-dom.

import { BLOCK_TAGS } from '../../shared/constants';
import { selectContents, surroundSimple, unwrap } from '../../shared/dom-utils';
import type { CommandContext } from '../../shared/command-context';
import { newCommentId, setBody } from './comment-dom';

const COMMENT_SCOPE_TAGS = new Set([
  ...BLOCK_TAGS,
  'TD', 'TH', 'CAPTION',
]);

/**
 * Wrap the selection in an inline <comment>. Returns null when:
 * - selection is collapsed, or
 * - selection crosses block boundaries.
 */
export function addComment(ctx: CommandContext): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return null;

  const startScope = findCommentScopeAncestor(range.startContainer, ctx.root);
  const endScope = findCommentScopeAncestor(range.endContainer, ctx.root);
  if (!startScope || startScope !== endScope) return null;

  // Comments are flat: a new comment must not nest inside, contain, or partially
  // overlap an existing one (that produces corrupt structures like a <comment>
  // wrapping another <comment>). Reject when the selection intersects any
  // existing comment. Range.intersectsNode treats a merely-adjacent boundary as
  // no overlap, so commenting text right next to an existing comment is allowed.
  for (const existing of ctx.root.querySelectorAll('comment')) {
    if (range.intersectsNode(existing)) return null;
  }

  const comment = document.createElement('comment');
  comment.setAttribute('id', newCommentId(ctx.root));
  try {
    surroundSimple(range, comment);
  } catch {
    return null;
  }
  setBody(comment, '');
  selectContents(sel, comment);
  return comment;
}

/** Remove a comment highlight, discarding body/replies but keeping target text. */
export function removeComment(_ctx: CommandContext, comment: Element): void {
  for (const child of Array.from(comment.children)) {
    const t = child.tagName.toLowerCase();
    if (t === 'comment-body' || t === 'comment-reply') child.remove();
  }
  unwrap(comment);
}

function findCommentScopeAncestor(node: Node, stopAt: Element): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== stopAt) {
    if (cur instanceof HTMLElement && COMMENT_SCOPE_TAGS.has(cur.tagName)) return cur;
    cur = cur.parentNode;
  }
  return null;
}
