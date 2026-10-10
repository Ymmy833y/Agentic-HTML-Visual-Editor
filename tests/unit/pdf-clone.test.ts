import { describe, expect, it } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID } from '../../common/index';
import { CELL_RANGE_MARK_NAME, CELL_RANGE_MARK_NAMESPACE } from '../../webview/editing/cell-range';
import { preparePdfClone } from '../../webview/export/pdf-clone';
import { CHANGE_OPEN_MARK_NAME, CHANGE_OPEN_MARK_NAMESPACE } from '../../webview/ui/change-popup';
import { COMMENT_CARET_MARK_NAME, COMMENT_CARET_MARK_NAMESPACE } from '../../webview/ui/comment-caret';
import { COMMENT_OPEN_MARK_NAME, COMMENT_OPEN_MARK_NAMESPACE } from '../../webview/ui/comment-popup';

/** A copied document and its editor root. */
interface Copy {
  readonly document: Document;
  readonly root: HTMLElement;
}

/**
 * Builds a document shaped like the copy html2canvas-pro makes: a toolbar before the editor root and a popup after it.
 *
 * @param body The body of the editor root.
 */
function createCopy(body: string): Copy {
  const copy = document.implementation.createHTMLDocument();
  copy.body.innerHTML = `<div id="toolbar"></div><div id="${EDITOR_ROOT_ELEMENT_ID}">${body}</div><div id="popup"></div>`;
  const root = copy.getElementById(EDITOR_ROOT_ELEMENT_ID);
  if (root === null) {
    throw new Error('no editor root');
  }
  return { document: copy, root };
}

describe('preparing the copy for the PDF', () => {
  it('takes the theme variables, the theme classes and the theme attributes of VS Code out of the copy', () => {
    const { document: copy, root } = createCopy('<p>a</p>');
    copy.documentElement.style.setProperty('--vscode-editor-background', '#1e1e1e');
    copy.documentElement.style.setProperty('--ahve-diagram-error-label', '"x"');
    copy.body.className = 'vscode-dark vscode-body other';
    copy.body.setAttribute('data-vscode-theme-kind', 'vscode-dark');

    preparePdfClone(copy, root, { diagramImages: new Map() });

    expect([
      copy.documentElement.style.getPropertyValue('--vscode-editor-background'),
      copy.documentElement.style.getPropertyValue('--ahve-diagram-error-label'),
      [...copy.body.classList],
      copy.body.hasAttribute('data-vscode-theme-kind'),
    ]).toEqual(['', '"x"', ['other'], false]);
  });

  it('keeps only the editor root in the body, removes the copied stylesheets, and drops the marks of the cell range, the open popups and the caret', () => {
    const { document: copy, root } = createCopy(
      '<table><tbody><tr><td>a</td></tr></tbody></table><p><comment id="c">b</comment><ins>c</ins></p>',
    );
    copy.head.innerHTML = '<link rel="stylesheet" href="webview.css"><style>p {}</style>';
    root.setAttributeNS(COMMENT_CARET_MARK_NAMESPACE, COMMENT_CARET_MARK_NAME, 'ai');
    root.querySelector('td')?.setAttributeNS(CELL_RANGE_MARK_NAMESPACE, CELL_RANGE_MARK_NAME, '');
    root.querySelector('comment')?.setAttributeNS(COMMENT_OPEN_MARK_NAMESPACE, COMMENT_OPEN_MARK_NAME, '');
    root.querySelector('ins')?.setAttributeNS(CHANGE_OPEN_MARK_NAMESPACE, CHANGE_OPEN_MARK_NAME, '');

    preparePdfClone(copy, root, { diagramImages: new Map() });

    expect([
      [...copy.body.children].map((child) => child.id),
      copy.querySelectorAll('link, style').length,
      root.hasAttributeNS(COMMENT_CARET_MARK_NAMESPACE, COMMENT_CARET_MARK_NAME),
      root.querySelector('td')?.hasAttributeNS(CELL_RANGE_MARK_NAMESPACE, CELL_RANGE_MARK_NAME),
      root.querySelector('comment')?.hasAttributeNS(COMMENT_OPEN_MARK_NAMESPACE, COMMENT_OPEN_MARK_NAME),
      root.querySelector('ins')?.hasAttributeNS(CHANGE_OPEN_MARK_NAMESPACE, CHANGE_OPEN_MARK_NAME),
    ]).toEqual([[EDITOR_ROOT_ELEMENT_ID], 0, false, false, false, false]);
  });

  it('replaces a diagram source block with an image of its light drawing, found by its position among the pre elements', () => {
    const { document: copy, root } = createCopy('<pre>plain</pre><pre class="mermaid">graph TD</pre>');

    preparePdfClone(copy, root, {
      diagramImages: new Map([[1, { kind: 'image', url: 'data:image/svg+xml,light', width: 120, height: 60 }]]),
    });

    expect([...root.children].map((child) => [child.localName, child.getAttribute('src')])).toEqual([
      ['pre', null],
      ['img', 'data:image/svg+xml,light'],
    ]);
  });

  it('removes everything but the summary from a closed collapsible section and leaves an open one as it is', () => {
    const { document: copy, root } = createCopy(
      '<details><summary>Closed</summary><p>Hidden</p></details><details open><summary>Open</summary><p>Shown</p></details>',
    );

    preparePdfClone(copy, root, { diagramImages: new Map() });

    expect([...root.querySelectorAll('details')].map((section) => section.children.length)).toEqual([1, 2]);
  });
});
