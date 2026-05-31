// Mount-time DOM normalization for the editor.
//
// Empty editable blocks get a `<br>` placeholder so the contenteditable
// host can place a caret inside them. The saved file stays clean
// (`<p></p>`); the placeholder lives only in the live DOM and the
// serializer strips it back out.

import { EMPTYABLE_BLOCK_TAGS, isBlockEffectivelyEmpty } from './serialize';

const OPAQUE_TAGS = new Set(['PRE', 'CODE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR']);

export function injectEmptyBlockPlaceholders(scope: ParentNode): void {
  const selector = Array.from(EMPTYABLE_BLOCK_TAGS).map((t) => t.toLowerCase()).join(',');
  for (const block of Array.from(scope.querySelectorAll(selector))) {
    if (hasOpaqueAncestor(block)) continue;
    if (!isBlockEffectivelyEmpty(block)) continue;
    // Keep any inline-format wrappers the saved file carried (e.g.
    // `<strong></strong>`) so the formatting stays active on reload; inject the
    // `<br>` placeholder into the innermost wrapper. A plain empty block gets
    // the `<br>` directly.
    const host = innermostInsertionHost(block);
    if (hasBrChild(host)) continue;
    host.appendChild(block.ownerDocument.createElement('br'));
  }
}

// Descend through trailing inline-wrapper elements to the deepest element that
// should hold the `<br>` placeholder. Stops at the block itself when it has no
// wrapper child, and never descends into a `<br>`.
function innermostInsertionHost(block: Element): Element {
  let host = block;
  for (;;) {
    const child = host.lastElementChild;
    if (!child || child.tagName === 'BR') break;
    host = child;
  }
  return host;
}

function hasBrChild(el: Element): boolean {
  return Array.from(el.children).some((c) => c.tagName === 'BR');
}

function hasOpaqueAncestor(node: Node): boolean {
  let cur: Node | null = node.parentNode;
  while (cur) {
    if (cur.nodeType === Node.ELEMENT_NODE && OPAQUE_TAGS.has((cur as Element).tagName)) {
      return true;
    }
    cur = cur.parentNode;
  }
  return false;
}
