import { describe, expect, it } from 'vitest';

import {
  findListTailStructure,
  findStructurePlacement,
  findVisibleEdge,
} from '../../webview/editing/boundary-placement';
import { createRoot, readChildText, readElement } from './helpers/format-dom';

describe('structure placement', () => {
  it('for a code block, returns the end of the code text backward and the start of code forward', () => {
    const root = createRoot('<pre><code>abc</code></pre>');
    const pre = readElement(root, 'pre');
    const text = readChildText(readElement(root, 'code'), 0);

    expect([findStructurePlacement(pre, 'backward'), findStructurePlacement(pre, 'forward')]).toEqual([
      { container: text, offset: 3 },
      { container: text, offset: 0 },
    ]);
  });

  it('returns a position inside code for an empty code, and inside pre for a pre without code', () => {
    const root = createRoot('<pre><code></code></pre><pre></pre>');
    const [withCode, withoutCode] = [...root.querySelectorAll('pre')];

    expect([
      findStructurePlacement(withCode, 'backward'),
      findStructurePlacement(withoutCode, 'forward'),
    ]).toEqual([
      { container: readElement(root, 'code'), offset: 0 },
      { container: withoutCode, offset: 0 },
    ]);
  });

  it('for a pre with text before code, returns the start of that text forward', () => {
    const root = createRoot('<pre>$ <code>npm</code></pre>');
    const pre = readElement(root, 'pre');

    expect(findStructurePlacement(pre, 'forward')).toEqual({ container: readChildText(pre, 0), offset: 0 });
  });

  it('for a table with tfoot written first, returns the end of the last cell in table order backward', () => {
    const root = createRoot(
      '<table><tfoot><tr><td>foot</td></tr></tfoot><tbody><tr><td>body</td></tr></tbody></table>',
    );
    const foot = readChildText(readElement(root, 'tfoot td'), 0);

    expect(findStructurePlacement(readElement(root, 'table'), 'backward')).toEqual({ container: foot, offset: 4 });
  });

  it('forward of a table, returns the first visible position of the first cell', () => {
    const root = createRoot('<table><tbody><tr><td>\n<p>ab</p></td><td>cd</td></tr></tbody></table>');
    const text = readChildText(readElement(root, 'td p'), 0);

    expect(findStructurePlacement(readElement(root, 'table'), 'forward')).toEqual({ container: text, offset: 0 });
  });

  it('for a closed details section, returns the end of the title backward and the start of the title forward', () => {
    const root = createRoot('<details><summary>title</summary><p>body</p></details>');
    const section = readElement(root, 'details');
    const title = readChildText(readElement(root, 'summary'), 0);

    expect([findStructurePlacement(section, 'backward'), findStructurePlacement(section, 'forward')]).toEqual([
      { container: title, offset: 5 },
      { container: title, offset: 0 },
    ]);
  });

  it('for an open details section, returns the last visible position of the body backward, or the end of the title if the body is empty', () => {
    const root = createRoot(
      '<details open=""><summary>t</summary><p>ab</p>\n<p>cd</p>\n</details>'
      + '<details open=""><summary>u</summary>\n</details>',
    );
    const [filled, empty] = [...root.querySelectorAll('details')];
    const last = readChildText(readElement(filled, 'p:last-of-type'), 0);
    const title = readChildText(readElement(empty, 'summary'), 0);

    expect([findStructurePlacement(filled, 'backward'), findStructurePlacement(empty, 'backward')]).toEqual([
      { container: last, offset: 2 },
      { container: title, offset: 1 },
    ]);
  });

  it('returns undefined for a closed details section without a title, and the first position of the body forward for an open one without a title', () => {
    const root = createRoot('<details><p>ab</p></details><details open=""><p>cd</p></details>');
    const [closed, opened] = [...root.querySelectorAll('details')];
    const body = readChildText(readElement(opened, 'p'), 0);

    expect([
      findStructurePlacement(closed, 'backward'),
      findStructurePlacement(closed, 'forward'),
      findStructurePlacement(opened, 'forward'),
    ]).toEqual([undefined, undefined, { container: body, offset: 0 }]);
  });

  it('forward of a list, returns the start of the first item line (the start of the paragraph if the line is a paragraph)', () => {
    const root = createRoot('<ul><li>ab</li><li>cd</li></ul><ol>\n<li>\n<p>ef</p></li></ol>');
    const plain = readChildText(readElement(root, 'ul li'), 0);
    const paragraph = readChildText(readElement(root, 'ol p'), 0);

    expect([
      findStructurePlacement(readElement(root, 'ul'), 'forward'),
      findStructurePlacement(readElement(root, 'ol'), 'forward'),
    ]).toEqual([{ container: plain, offset: 0 }, { container: paragraph, offset: 0 }]);
  });

  it('backward of a list whose last item ends with a table, returns the end of the last cell of that table', () => {
    const root = createRoot(
      '<ul><li>ab<table><tbody><tr><td>cd</td><td>ef</td></tr></tbody></table></li></ul>',
    );
    const last = readChildText(readElement(root, 'td:last-of-type'), 0);

    expect(findStructurePlacement(readElement(root, 'ul'), 'backward')).toEqual({ container: last, offset: 2 });
  });
});

describe('visible positions inside an element', () => {
  it('on the last side, when the last child is a table cell, returns a position inside the last cell of that table', () => {
    const root = createRoot(
      '<table><tbody><tr><td>ab<table><tbody><tr><td>cd</td></tr></tbody></table></td></tr></tbody></table>',
    );
    const outer = readElement(root, 'td');
    const inner = readChildText(readElement(outer, 'td'), 0);

    expect(findVisibleEdge(outer, 'last')).toEqual({ container: inner, offset: 2 });
  });

  it('on the last side of a paragraph ending with a placeholder br, returns the position before the br', () => {
    const root = createRoot('<p>ab<br></p>');
    const paragraph = readElement(root, 'p');

    expect(findVisibleEdge(paragraph, 'last')).toEqual({ container: paragraph, offset: 1 });
  });

  it('when the body ends with a closed details section, returns the end of its title without descending into the closed body', () => {
    const root = createRoot(
      '<details open=""><summary>t</summary><details><summary>inner</summary><p>hidden</p></details></details>',
    );
    const inner = readChildText(readElement(root, 'details details summary'), 0);

    expect(findVisibleEdge(readElement(root, 'details'), 'last')).toEqual({ container: inner, offset: 5 });
  });

  it('for a paragraph ending with an element whose contenteditable is false, does not return a position inside that element', () => {
    const root = createRoot('<p>ab<span contenteditable="false">cd</span></p>');
    const text = readChildText(readElement(root, 'p'), 0);

    expect(findVisibleEdge(readElement(root, 'p'), 'last')).toEqual({ container: text, offset: 2 });
  });
});

describe('list tail structure', () => {
  it('returns the structure for lists whose last item ends with a table, code block or details section', () => {
    const root = createRoot(
      '<ul><li>a<table><tbody><tr><td>b</td></tr></tbody></table></li></ul>'
      + '<ul><li>c<pre><code>d</code></pre>\n</li></ul>'
      + '<ul><li>e<details><summary>f</summary></details><!-- note --></li></ul>',
    );
    const lists = [...root.querySelectorAll(':scope > ul')];

    expect(lists.map((list) => findListTailStructure(list)?.localName)).toEqual(['table', 'pre', 'details']);
  });

  it('when the last item of a nested list ends with a table, descends into the nested list and returns that table', () => {
    const root = createRoot(
      '<ul><li>a<ul><li>b<table><tbody><tr><td>c</td></tr></tbody></table></li></ul></li></ul>',
    );

    expect(findListTailStructure(readElement(root, 'ul'))).toBe(readElement(root, 'table'));
  });

  it('returns undefined for lists whose last item ends with a horizontal rule or paragraph, and for lists ending with an item without block children', () => {
    const root = createRoot(
      '<ul><li>a<hr></li></ul><ul><li>b<p>c</p></li></ul><ul><li>d</li></ul>',
    );
    const lists = [...root.querySelectorAll(':scope > ul')];

    expect(lists.map((list) => findListTailStructure(list))).toEqual([undefined, undefined, undefined]);
  });
});
