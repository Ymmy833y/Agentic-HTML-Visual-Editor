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
 * <comment>text</comment> is unknown to Confluence and would either be dropped
 * or rendered as raw text. Convert each into a labelled <blockquote> so the
 * intent (a side note for AI/human context) survives the round trip.
 */
function rewriteComments(root: ParentNode): void {
  const comments = Array.from((root as ParentNode).querySelectorAll('comment'));
  for (const comment of comments) {
    const blockquote = document.createElement('blockquote');
    const para = document.createElement('p');
    const label = document.createElement('strong');
    label.textContent = 'Comment: ';
    para.appendChild(label);
    while (comment.firstChild) {
      para.appendChild(comment.firstChild);
    }
    blockquote.appendChild(para);
    comment.replaceWith(blockquote);
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
