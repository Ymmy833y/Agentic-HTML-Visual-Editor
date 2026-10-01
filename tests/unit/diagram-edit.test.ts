import { describe, expect, it } from 'vitest';

import {
  DIAGRAM_DELETE_EDIT_KIND,
  DIAGRAM_LEAD_PARAGRAPH_EDIT_KIND,
  DIAGRAM_UPDATE_EDIT_KIND,
  findAdjacentDiagram,
  findLeadingDiagram,
  insertParagraphBeforeDiagram,
  removeDiagram,
  updateDiagramSource,
} from '../../webview/editing/diagram-edit';
import type { DiagramEditPorts } from '../../webview/editing/diagram-edit';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/**
 * Creates the ports of the diagram edits over a root, recording the edit kinds passed to the command path.
 *
 * @param root The editor root.
 * @returns The ports and the recorded edit kinds.
 */
function createPorts(root: Element): { ports: DiagramEditPorts; kinds: string[] } {
  const kinds: string[] = [];
  const ports: DiagramEditPorts = {
    readEditorRoot: () => root,
    isComposing: () => false,
    isInputStopped: () => false,
    runCommandEdit: (kind, command) => {
      kinds.push(kind);
      return command();
    },
    reportDiagnostic: () => undefined,
  };
  return { ports, kinds };
}

/**
 * Reads where the collapsed caret is.
 *
 * @returns The node and offset of the caret.
 */
function readCaret(): { node: Node | null; offset: number } {
  const selection = window.getSelection();
  return { node: selection?.anchorNode ?? null, offset: selection?.anchorOffset ?? -1 };
}

describe('rewriting the source of a diagram', () => {
  it('replaces the contents of a mermaid pre, and of the code in the code form, as one edit each', () => {
    const root = mountRoot('<pre class="mermaid">graph TD</pre><pre><code class="language-mermaid">graph LR</code></pre>');
    const { ports, kinds } = createPorts(root);
    const [first, second] = root.querySelectorAll('pre');

    const changed = [updateDiagramSource(ports, first, 'graph TD\n  A --> B'), updateDiagramSource(ports, second, 'pie')];

    expect([changed, kinds, root.innerHTML]).toEqual([
      [true, true],
      [DIAGRAM_UPDATE_EDIT_KIND, DIAGRAM_UPDATE_EDIT_KIND],
      '<pre class="mermaid">graph TD\n  A --&gt; B</pre><pre><code class="language-mermaid">pie</code></pre>',
    ]);
  });

  it('makes no edit when the source is unchanged', () => {
    const root = mountRoot('<pre class="mermaid">graph TD</pre>');
    const { ports, kinds } = createPorts(root);

    const changed = updateDiagramSource(ports, readElement(root, 'pre'), 'graph TD');

    expect([changed, kinds]).toEqual([false, []]);
  });
});

describe('deleting a diagram', () => {
  it('removes the block as one edit and puts the caret at the start of the block after it', () => {
    const root = mountRoot('<p>ab</p>\n<pre class="mermaid">graph TD</pre>\n<p>cd</p>');
    const { ports, kinds } = createPorts(root);

    const changed = removeDiagram(ports, readElement(root, 'pre'));

    const after = root.querySelectorAll('p')[1];
    expect([changed, kinds, root.innerHTML, readCaret()]).toEqual([
      true,
      [DIAGRAM_DELETE_EDIT_KIND],
      '<p>ab</p>\n<p>cd</p>',
      { node: after.firstChild, offset: 0 },
    ]);
  });

  it('puts the caret at the end of the block before it when nothing follows, and leaves a paragraph when nothing is left', () => {
    const root = mountRoot('<p>ab</p><pre class="mermaid">graph TD</pre>');
    const { ports } = createPorts(root);
    removeDiagram(ports, readElement(root, 'pre'));
    const beforeCaret = readCaret();
    const alone = mountRoot('<pre class="mermaid">graph TD</pre>');
    removeDiagram(createPorts(alone).ports, readElement(alone, 'pre'));

    expect([beforeCaret, alone.innerHTML]).toEqual([
      { node: readChildText(readElement(root, 'p'), 0), offset: 2 },
      '<p><br></p>',
    ]);
  });
});

describe('finding the diagram next to the caret', () => {
  it('finds the diagram before the block whose start holds the caret, and after the block whose end holds it', () => {
    const root = mountRoot('<p>ab</p>\n<pre class="mermaid">graph TD</pre>\n<p>cd</p>');
    const diagram = readElement(root, 'pre');
    const [before, after] = [...root.querySelectorAll('p')].map((paragraph) => readChildText(paragraph, 0));

    expect([
      findAdjacentDiagram(root, createRange(after, 0, after, 0), 'backward') === diagram,
      findAdjacentDiagram(root, createRange(before, 2, before, 2), 'forward') === diagram,
    ]).toEqual([true, true]);
  });

  it('finds none from the middle of a block, from a range, or toward a block that is not a diagram', () => {
    const root = mountRoot('<p>ab</p>\n<pre class="mermaid">graph TD</pre>\n<p>cd</p>');
    const [before, after] = [...root.querySelectorAll('p')].map((paragraph) => readChildText(paragraph, 0));
    select(createRange(after, 1, after, 1));

    expect([
      findAdjacentDiagram(root, createRange(after, 1, after, 1), 'backward'),
      findAdjacentDiagram(root, createRange(after, 0, after, 1), 'backward'),
      findAdjacentDiagram(root, createRange(before, 0, before, 0), 'backward'),
    ]).toEqual([undefined, undefined, undefined]);
  });
});

describe('adding a line before a leading diagram', () => {
  it('finds the first of the diagrams before the block whose start holds the caret when nothing comes before them', () => {
    const root = mountRoot('\n<pre class="mermaid">graph TD</pre>\n<pre class="mermaid">pie</pre>\n<p>cd</p>');
    const text = readChildText(readElement(root, 'p'), 0);

    expect(findLeadingDiagram(root, createRange(text, 0, text, 0)) === root.querySelectorAll('pre')[0]).toBe(true);
  });

  it('finds none when a block comes before the diagram, or when the caret is not at the start of the block', () => {
    const root = mountRoot('<p>ab</p><pre class="mermaid">graph TD</pre><p>cd</p>');
    const after = readChildText(root.querySelectorAll('p')[1], 0);
    const alone = mountRoot('<pre class="mermaid">graph TD</pre><p>cd</p>');
    const text = readChildText(readElement(alone, 'p'), 0);

    expect([
      findLeadingDiagram(root, createRange(after, 0, after, 0)),
      findLeadingDiagram(alone, createRange(text, 1, text, 1)),
    ]).toEqual([undefined, undefined]);
  });

  it('finds the diagram before a list or a table whose first visible position holds the caret', () => {
    const list = mountRoot('<pre class="mermaid">graph TD</pre><ul><li>ab</li><li>cd</li></ul>');
    const item = readChildText(list.querySelectorAll('li')[0], 0);
    const listFound = findLeadingDiagram(list, createRange(item, 0, item, 0)) === readElement(list, 'pre');
    const table = mountRoot('<pre class="mermaid">graph TD</pre><table><tbody><tr><td>ab</td><td>cd</td></tr></tbody></table>');
    const cell = readChildText(table.querySelectorAll('td')[0], 0);

    expect([listFound, findLeadingDiagram(table, createRange(cell, 0, cell, 0)) === readElement(table, 'pre')])
      .toEqual([true, true]);
  });

  it('finds the diagram before a table that starts with a column group or a caption', () => {
    const grouped = mountRoot(
      '<pre class="mermaid">graph TD</pre><table><colgroup><col></colgroup><thead><tr><th>ab</th></tr></thead></table>',
    );
    const head = readChildText(readElement(grouped, 'th'), 0);
    const captioned = mountRoot('<pre class="mermaid">graph TD</pre><table><caption></caption><tbody><tr><td>ab</td></tr></tbody></table>');
    const cell = readChildText(readElement(captioned, 'td'), 0);

    expect([
      findLeadingDiagram(grouped, createRange(head, 0, head, 0)) === readElement(grouped, 'pre'),
      findLeadingDiagram(captioned, createRange(cell, 0, cell, 0)) === readElement(captioned, 'pre'),
    ]).toEqual([true, true]);
  });

  it('finds none from a later item or cell of the container, which has a line above it', () => {
    const list = mountRoot('<pre class="mermaid">graph TD</pre><ul><li>ab</li><li>cd</li></ul>');
    const second = readChildText(list.querySelectorAll('li')[1], 0);
    const table = mountRoot('<pre class="mermaid">graph TD</pre><table><tbody><tr><td>ab</td><td>cd</td></tr></tbody></table>');
    const cell = readChildText(table.querySelectorAll('td')[1], 0);

    expect([
      findLeadingDiagram(list, createRange(second, 0, second, 0)),
      findLeadingDiagram(table, createRange(cell, 0, cell, 0)),
    ]).toEqual([undefined, undefined]);
  });

  it('finds none from the row below an empty cell or the item after an empty item, which the caret can move up into', () => {
    const table = mountRoot(
      '<pre class="mermaid">graph TD</pre><table><tbody><tr><td></td></tr><tr><td>ab</td></tr></tbody></table>',
    );
    const cell = readChildText(table.querySelectorAll('td')[1], 0);
    const list = mountRoot('<pre class="mermaid">graph TD</pre><ul><li></li><li>cd</li></ul>');
    const item = readChildText(list.querySelectorAll('li')[1], 0);

    expect([
      findLeadingDiagram(table, createRange(cell, 0, cell, 0)),
      findLeadingDiagram(list, createRange(item, 0, item, 0)),
    ]).toEqual([undefined, undefined]);
  });

  it('adds an empty paragraph before the diagram as one edit and puts the caret in it', () => {
    const root = mountRoot('<pre class="mermaid">graph TD</pre><p>cd</p>');
    const { ports, kinds } = createPorts(root);

    const changed = insertParagraphBeforeDiagram(ports, readElement(root, 'pre'));

    const added = readElement(root, 'p');
    expect([changed, kinds, root.innerHTML, readCaret()]).toEqual([
      true,
      [DIAGRAM_LEAD_PARAGRAPH_EDIT_KIND],
      '\n<p><br></p>\n<pre class="mermaid">graph TD</pre><p>cd</p>',
      { node: added, offset: 0 },
    ]);
  });
});
