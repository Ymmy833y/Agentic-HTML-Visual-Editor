// Selection-aware copy helpers. The Webview prepares the HTML string and hands it to
// the extension host, which performs the actual clipboard write through
// vscode.env.clipboard.

import { stripCommentsFromHtml } from './strip-comments';
import { isBlockEffectivelyEmpty } from '../../core/serialize';
import { stripMermaidPresentation } from '../mermaid/mermaid-dom';

// Inline wrappers that survive cloneContents. When a range's boundaries sit inside
// one of these elements but cover its entire content, the range is expanded to
// include the wrapper itself — otherwise double-clicking "sample" in
// `<strong>sample</strong>` copies only the bare text and the bold is lost on paste.
const INLINE_PRESERVE_TAGS = new Set([
  'STRONG', 'EM', 'CODE', 'S', 'DEL', 'U', 'MARK', 'SUB', 'SUP', 'A', 'B', 'I', 'SPAN',
]);

const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'DIV', 'LI', 'SUMMARY',
]);

export function prepareCopy(root: HTMLElement): string {
  // Comment annotations are internal to this editor. Strip them from the copied HTML
  // so that only the commented text (and its inline markup) is written out.
  return stripCommentsFromHtml(currentHtml(root));
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
    trimEmptyBoundaryBlocks(fragment);
    stripMermaidPresentation(fragment);
    const tpl = document.createElement('template');
    tpl.content.appendChild(fragment);
    return tpl.innerHTML;
  }
  const clone = root.cloneNode(true) as HTMLElement;
  stripMermaidPresentation(clone);
  return clone.innerHTML;
}

// A drag that visually ends after a paragraph can still leave the Range's endpoint at
// offset 0 inside the next heading, and cloneContents then includes an empty wrapper
// for a heading that was never really selected. Remove empty blocks at either outer
// boundary along with the whitespace outside them, while keeping empty blocks that
// genuinely sit *between* the selected content.
function trimEmptyBoundaryBlocks(fragment: DocumentFragment): void {
  trimBoundary(fragment, 'start');
  trimBoundary(fragment, 'end');
}

function trimBoundary(fragment: DocumentFragment, side: 'start' | 'end'): void {
  let removedBlock = false;
  while (true) {
    const edge = side === 'start' ? fragment.firstChild : fragment.lastChild;
    if (!edge) return;
    if (isWhitespaceText(edge)) {
      const next = side === 'start' ? edge.nextSibling : edge.previousSibling;
      if (removedBlock || isEmptyBlock(next)) {
        edge.remove();
        continue;
      }
      return;
    }
    if (!isEmptyBlock(edge)) return;
    edge.remove();
    removedBlock = true;
  }
}

function isWhitespaceText(node: Node | null): boolean {
  return node?.nodeType === Node.TEXT_NODE && /^\s*$/.test((node as Text).data);
}

function isEmptyBlock(node: Node | null): node is Element {
  return node instanceof Element && BLOCK_TAGS.has(node.tagName) && isBlockEffectivelyEmpty(node);
}

/**
 * Expands the range outward through inline wrappers (`<strong>`, `<em>`, …) that the
 * range fully covers but whose tags cloneContents would otherwise lose (cloneContents
 * only reproduces markup the range's boundaries *cross*, not markup that *contains*
 * them).
 */
function expandToInlineWrappers(range: Range, root: Element): void {
  expandSide(range, root, 'start');
  expandSide(range, root, 'end');
}

function expandSide(range: Range, root: Element, side: 'start' | 'end'): void {
  while (true) {
    const container = side === 'start' ? range.startContainer : range.endContainer;
    const offset = side === 'start' ? range.startOffset : range.endOffset;

    // Walk up from the boundary container looking for an inline wrapper whose edge on
    // this side is reached by the current range.
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
