// Selection-aware copy helpers. The webview prepares the HTML string and
// hands it off to the extension host, which performs the actual clipboard
// write through vscode.env.clipboard.

import { toConfluenceHtml } from './confluence';
import type { CopyFormat } from '../src/shared/messages';

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
    const fragment = sel.getRangeAt(0).cloneContents();
    const tpl = document.createElement('template');
    tpl.content.appendChild(fragment);
    return tpl.innerHTML;
  }
  return root.innerHTML;
}
