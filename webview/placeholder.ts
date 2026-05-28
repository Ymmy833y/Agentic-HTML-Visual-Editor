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
    if (
      block.childNodes.length === 1 &&
      block.firstChild?.nodeType === Node.ELEMENT_NODE &&
      (block.firstChild as Element).tagName === 'BR'
    ) {
      continue;
    }
    const br = block.ownerDocument.createElement('br');
    block.replaceChildren(br);
  }
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
