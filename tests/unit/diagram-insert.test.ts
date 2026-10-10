import { describe, expect, it } from 'vitest';

import { DIAGRAM_SAMPLE_SOURCE, insertDiagramSource } from '../../webview/editing/diagram-insert';
import { mountRoot, readElement } from './helpers/format-dom';

/**
 * Reads where the collapsed caret is.
 *
 * @returns The node and offset of the caret, or `undefined` when the selection is not collapsed.
 */
function readCaret(): { node: Node | null; offset: number } | undefined {
  const selection = window.getSelection();
  return selection?.isCollapsed === true ? { node: selection.anchorNode, offset: selection.anchorOffset } : undefined;
}

describe('inserting a diagram source block', () => {
  it('inserts a mermaid pre with the sample source after a non-empty reference and puts the caret at the start of the next paragraph', () => {
    const root = mountRoot('\n<p>ab</p>\n<p>cd</p>');

    const inserted = insertDiagramSource(readElement(root, 'p'));

    const next = root.querySelectorAll('p')[1];
    expect([inserted, root.innerHTML, readCaret()]).toEqual([
      true,
      `\n<p>ab</p>\n<pre class="mermaid">${DIAGRAM_SAMPLE_SOURCE.replace('>', '&gt;')}</pre>\n<p>cd</p>`,
      { node: next.firstChild, offset: 0 },
    ]);
  });

  it('inserts before an empty reference, leaving it after the block with the caret in it', () => {
    const root = mountRoot('\n<p><br></p>');

    insertDiagramSource(readElement(root, 'p'));

    const paragraph = readElement(root, 'p');
    expect([[...root.children].map((child) => child.localName), readCaret()])
      .toEqual([['pre', 'p'], { node: paragraph, offset: 0 }]);
  });

  it('adds an empty paragraph after the block when nothing follows, and puts the caret in it', () => {
    const root = mountRoot('\n<p>ab</p>');

    insertDiagramSource(readElement(root, 'p'));

    const added = root.querySelectorAll('p')[1];
    expect([[...root.children].map((child) => child.localName), added.innerHTML, readCaret()])
      .toEqual([['p', 'pre', 'p'], '<br>', { node: added, offset: 0 }]);
  });
});
