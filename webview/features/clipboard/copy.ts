// Selection-aware copy helpers. The webview prepares the HTML string and
// hands it off to the extension host, which performs the actual clipboard
// write through vscode.env.clipboard.

import { toConfluenceHtml } from './confluence';
import type { CopyFormat } from '../../../src/shared/messages';

// Inline wrappers that survive cloneContents. When a user selects text whose
// range boundaries land inside one of these elements but cover its full
// content, we expand the range to include the wrapper itself — otherwise
// double-clicking "sample" inside `<strong>sample</strong>` would copy the
// bare text and lose the bold on paste.
const INLINE_PRESERVE_TAGS = new Set([
  'STRONG', 'EM', 'CODE', 'S', 'DEL', 'U', 'MARK', 'SUB', 'SUP', 'A', 'B', 'I', 'SPAN',
]);

export function prepareCopy(root: HTMLElement, format: CopyFormat): string {
  const html = currentHtml(root);
  return format === 'confluence' ? toConfluenceHtml(html) : html;
}

function currentHtml(root: HTMLElement): string {
  const sel = window.getSelection();
  if (
    sel &&
    sel.rangeCount > 0 &&
    !sel.isCollapsed &&
    root.contains(sel.getRangeAt(0).commonAncestorContainer)
  ) {
    const range = sel.getRangeAt(0).cloneRange();
    expandToInlineWrappers(range, root);
    const fragment = range.cloneContents();
    const tpl = document.createElement('template');
    tpl.content.appendChild(fragment);
    return tpl.innerHTML;
  }
  return root.innerHTML;
}

/**
 * Grow the range outward through inline wrappers (`<strong>`, `<em>`, ...)
 * that the range covers in full but whose tags would otherwise be lost by
 * cloneContents (which only clones markup that the range boundaries
 * straddle, not markup that contains the boundaries).
 */
function expandToInlineWrappers(range: Range, root: Element): void {
  expandSide(range, root, 'start');
  expandSide(range, root, 'end');
}

function expandSide(range: Range, root: Element, side: 'start' | 'end'): void {
  while (true) {
    const container = side === 'start' ? range.startContainer : range.endContainer;
    const offset = side === 'start' ? range.startOffset : range.endOffset;

    // Walk up from the boundary container looking for an inline wrapper
    // whose extent on the relevant side is reached by the current range.
    let target: Element | null = null;
    let n: Node | null = container;
    while (n && n !== root) {
      if (n instanceof Element && INLINE_PRESERVE_TAGS.has(n.tagName)) {
        const atEdge = side === 'start'
          ? isPositionAtNodeStart(container, offset, n)
          : isPositionAtNodeEnd(container, offset, n);
        if (atEdge) target = n;
      }
      n = n.parentNode;
    }

    if (!target) return;
    const parent = target.parentNode;
    if (!parent || parent === root) return;
    const idx = childIndex(parent, target);
    if (side === 'start') range.setStart(parent, idx);
    else range.setEnd(parent, idx + 1);
  }
}

function isPositionAtNodeStart(container: Node, offset: number, node: Node): boolean {
  if (container === node) return hasNothingBeforeInNode(node, offset);
  if (!hasNothingBeforeInNode(container, offset)) return false;
  let cur: Node | null = container;
  while (cur && cur !== node) {
    if (!hasNoPrecedingContent(cur)) return false;
    cur = cur.parentNode;
  }
  return cur === node;
}

function isPositionAtNodeEnd(container: Node, offset: number, node: Node): boolean {
  if (container === node) return hasNothingAfterInNode(node, offset);
  if (!hasNothingAfterInNode(container, offset)) return false;
  let cur: Node | null = container;
  while (cur && cur !== node) {
    if (!hasNoFollowingContent(cur)) return false;
    cur = cur.parentNode;
  }
  return cur === node;
}

function hasNothingBeforeInNode(node: Node, offset: number): boolean {
  if (node.nodeType === Node.TEXT_NODE) return offset === 0;
  for (let i = 0; i < offset; i++) {
    if (!isEmptyNode(node.childNodes[i])) return false;
  }
  return true;
}

function hasNothingAfterInNode(node: Node, offset: number): boolean {
  if (node.nodeType === Node.TEXT_NODE) return offset === (node as Text).length;
  for (let i = offset; i < node.childNodes.length; i++) {
    if (!isEmptyNode(node.childNodes[i])) return false;
  }
  return true;
}

function hasNoPrecedingContent(node: Node): boolean {
  for (let p = node.previousSibling; p; p = p.previousSibling) {
    if (!isEmptyNode(p)) return false;
  }
  return true;
}

function hasNoFollowingContent(node: Node): boolean {
  for (let n = node.nextSibling; n; n = n.nextSibling) {
    if (!isEmptyNode(n)) return false;
  }
  return true;
}

function isEmptyNode(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data.length === 0;
  return false;
}

function childIndex(parent: Node, child: Node): number {
  let i = 0;
  for (let n: Node | null = parent.firstChild; n; n = n.nextSibling) {
    if (n === child) return i;
    i++;
  }
  return -1;
}
