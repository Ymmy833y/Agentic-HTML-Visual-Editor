// Normalizes an HTML fragment for pasting into a Confluence editor.
//
// Confluence's paste handler interprets common HTML tags but ignores unknown
// custom elements and may render bare <table>/<pre> oddly. We rewrite a few
// constructs so the result renders predictably after paste.

import { stripCommentTags } from './strip-comments';

export function toConfluenceHtml(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  transform(tpl.content);
  return tpl.innerHTML;
}

function transform(root: ParentNode): void {
  stripCommentTags(root);
  ensureTableBorders(root);
  ensurePreHasCode(root);
}

/** Older Confluence pastes ignore CSS borders; the legacy border attribute renders reliably. */
function ensureTableBorders(root: ParentNode): void {
  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (!table.hasAttribute('border')) {
      table.setAttribute('border', '1');
    }
  }
}

/** Wrap <pre> contents in <code> when missing, so Confluence treats it as a code block. */
function ensurePreHasCode(root: ParentNode): void {
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    const firstEl = pre.firstElementChild;
    if (firstEl && firstEl.tagName === 'CODE' && pre.children.length === 1) {
      continue;
    }
    const code = document.createElement('code');
    while (pre.firstChild) {
      code.appendChild(pre.firstChild);
    }
    pre.appendChild(code);
  }
}
