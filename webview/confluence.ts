// Normalizes an HTML fragment for pasting into a Confluence editor.
//
// Confluence's paste handler interprets common HTML tags but ignores unknown
// custom elements and may render bare <table>/<pre> oddly. We rewrite a few
// constructs so the result renders predictably after paste.

export function toConfluenceHtml(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  transform(tpl.content);
  return tpl.innerHTML;
}

function transform(root: ParentNode): void {
  rewriteComments(root);
  ensureTableBorders(root);
  ensurePreHasCode(root);
}

/**
 * Strip comment annotations from the exported HTML: drop the <comment-body>
 * and <comment-reply> children, then unwrap the <comment> element so only
 * the highlighted target text remains. Confluence sees clean source HTML
 * with no trace of the annotation layer.
 */
function rewriteComments(root: ParentNode): void {
  for (const child of Array.from(root.querySelectorAll('comment-body, comment-reply'))) {
    child.remove();
  }
  for (const comment of Array.from(root.querySelectorAll('comment'))) {
    const parent = comment.parentNode;
    if (!parent) continue;
    while (comment.firstChild) parent.insertBefore(comment.firstChild, comment);
    comment.remove();
  }
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
