import { describe, expect, it } from 'vitest';

import {
  findTitleWithCaretAtStart,
  isAtStructureBoundary,
  isStructureCrossingRange,
  isStructureElement,
  isTowardAdjacentBlock,
  isTypableLine,
} from '../../webview/editing/structure-boundary';
import { createRange, createRoot, readChildText, readElement } from './helpers/format-dom';

const TABLE = '<table><tbody><tr><td>a</td></tr></tbody></table>';

/**
 * Creates a range collapsed at a position.
 *
 * @param node The node of the position.
 * @param offset The offset of the position.
 * @returns A collapsed range.
 */
function caretAt(node: Node, offset: number): Range {
  return createRange(node, offset, node, offset);
}

describe('structure elements', () => {
  it('returns true for details, the title, pre and each table skeleton element, and false for a summary that is not the title, p, li and code', () => {
    const root = createRoot(
      '<details><summary>t</summary><summary>x</summary><p>b</p></details>'
      + '<pre><code>c</code></pre><ul><li>d</li></ul>'
      + '<table><caption>e</caption><colgroup><col></colgroup><thead><tr><th>f</th></tr></thead>'
      + '<tbody><tr><td>g</td></tr></tbody><tfoot><tr><td>h</td></tr></tfoot></table>',
    );
    const judge = (selector: string): boolean => isStructureElement(readElement(root, selector));

    expect([
      ['details', 'summary', 'pre', 'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td']
        .map(judge),
      ['summary:last-of-type', 'p', 'li', 'code'].map(judge),
    ]).toEqual([Array(13).fill(true), Array(4).fill(false)]);
  });
});

describe('typable line', () => {
  it('returns true for non-whitespace text and a paragraph, heading, div or blockquote with only inline children, and false for li, lists, tables, horizontal rules and whitespace-only text', () => {
    const root = createRoot(
      'ab<p>c</p><h2>d</h2><div>e</div><blockquote>f</blockquote>'
      + `<ul><li>g</li></ul>${TABLE}<hr>\n<div><p>h</p></div>`,
    );
    const nodes = [...root.childNodes, readElement(root, 'li')];

    expect(nodes.map((node) => isTypableLine(node))).toEqual([
      true, true, true, true, true, false, false, false, false, false, false,
    ]);
  });
});

describe('at a structure boundary', () => {
  it('returns true backward at the start of the paragraph right after a table (only a line break between)', () => {
    const root = createRoot(`${TABLE}\n<p>ab</p>`);
    const text = readChildText(readElement(root, 'p'), 0);

    expect(isAtStructureBoundary(root, caretAt(text, 0), 'backward')).toBe(true);
  });

  it('returns true backward at the start of bare text directly under the editor root right after a table', () => {
    const root = createRoot(`${TABLE}ab`);

    expect(isAtStructureBoundary(root, caretAt(readChildText(root, 1), 0), 'backward')).toBe(true);
  });

  it('returns true backward at the start of a details body that begins with bare text', () => {
    const root = createRoot('<details open=""><summary>t</summary>body</details>');
    const text = readChildText(readElement(root, 'details'), 1);

    expect(isAtStructureBoundary(root, caretAt(text, 0), 'backward')).toBe(true);
  });

  it('returns true forward at the end of bare text right before a table inside a cell', () => {
    const root = createRoot(`<table><tbody><tr><td>ab${TABLE}</td></tr></tbody></table>`);
    const text = readChildText(readElement(root, 'td'), 0);

    expect(isAtStructureBoundary(root, caretAt(text, 2), 'forward')).toBe(true);
  });

  it('also returns true when only an HTML comment and an empty strong lie between it and the table', () => {
    const root = createRoot(`${TABLE}<!-- note --><strong></strong>\n<p>ab</p>`);
    const text = readChildText(readElement(root, 'p'), 0);

    expect(isAtStructureBoundary(root, caretAt(text, 0), 'backward')).toBe(true);
  });

  it('returns false when a horizontal rule or image lies between it and the table, or when the neighbor is a paragraph that is not a structure', () => {
    const rule = createRoot(`${TABLE}<hr><p>ab</p>`);
    const image = createRoot(`${TABLE}<p><img src="x.png">ab</p>`);
    const paragraph = createRoot('<p>xy</p><p>ab</p>');
    const judge = (root: HTMLElement): boolean => {
      const target = readElement(root, 'p:last-of-type');
      const text = [...target.childNodes].find((node): node is Text => node instanceof Text);
      if (text === undefined) {
        throw new Error('text not found');
      }
      return isAtStructureBoundary(root, caretAt(text, 0), 'backward');
    };

    expect([rule, image, paragraph].map(judge)).toEqual([false, false, false]);
  });

  it('returns false backward after a leading line break of code, and true backward at the start of code', () => {
    const root = createRoot('<pre><code>\nab</code></pre>');
    const text = readChildText(readElement(root, 'code'), 0);

    expect([
      isAtStructureBoundary(root, caretAt(text, 1), 'backward'),
      isAtStructureBoundary(root, caretAt(text, 0), 'backward'),
    ]).toEqual([false, true]);
  });

  it('returns false at the start of the first paragraph of the editor root and for a range with a range selection', () => {
    const root = createRoot(`<p>ab</p>${TABLE}`);
    const text = readChildText(readElement(root, 'p'), 0);

    expect([
      isAtStructureBoundary(root, caretAt(text, 0), 'backward'),
      isAtStructureBoundary(root, createRange(text, 1, text, 2), 'forward'),
    ]).toEqual([false, false]);
  });
});

describe('toward an adjacent block', () => {
  it('returns true directly under the editor root right after a table, reaching the start of the following paragraph forward', () => {
    const root = createRoot(`${TABLE}\n<p>ab</p>`);

    expect(isTowardAdjacentBlock(root, caretAt(root, 1), 'forward')).toBe(true);
  });

  it('returns true directly under the editor root right before a table, reaching the end of the preceding paragraph backward', () => {
    const root = createRoot(`<p>ab</p>\n${TABLE}`);

    expect(isTowardAdjacentBlock(root, caretAt(root, 2), 'backward')).toBe(true);
  });

  it('returns false in the middle of bare text directly under the editor root (characters adjacent) and at a position inside a paragraph', () => {
    const root = createRoot(`abc<p>de</p>${TABLE}`);
    const bare = readChildText(root, 0);
    const text = readChildText(readElement(root, 'p'), 0);

    expect([
      isTowardAdjacentBlock(root, caretAt(bare, 1), 'forward'),
      isTowardAdjacentBlock(root, caretAt(text, 2), 'forward'),
    ]).toEqual([false, false]);
  });

  it('returns true forward at the end of bare text directly under a cell with block children, reaching the following paragraph', () => {
    const root = createRoot('<table><tbody><tr><td>ab<p>cd</p></td></tr></tbody></table>');
    const text = readChildText(readElement(root, 'td'), 0);

    expect(isTowardAdjacentBlock(root, caretAt(text, 2), 'forward')).toBe(true);
  });

  it('returns false forward after the last element of the editor root and for a range with a range selection', () => {
    const root = createRoot(`<p>ab</p>\n${TABLE}\n`);

    expect([
      isTowardAdjacentBlock(root, caretAt(root, 3), 'forward'),
      isTowardAdjacentBlock(root, createRange(root, 1, root, 3), 'backward'),
    ]).toEqual([false, false]);
  });
});

describe('structure-crossing range', () => {
  it('returns true for a range from a paragraph into a cell and a range from a paragraph to the middle of code', () => {
    const root = createRoot(`<p>ab</p>${TABLE}<pre><code>cd</code></pre>`);
    const text = readChildText(readElement(root, 'p'), 0);
    const cell = readChildText(readElement(root, 'td'), 0);
    const code = readChildText(readElement(root, 'code'), 0);

    expect([
      isStructureCrossingRange(createRange(text, 1, cell, 1), root),
      isStructureCrossingRange(createRange(text, 1, code, 1), root),
    ]).toEqual([true, true]);
  });

  it('returns true for a range into a cell of another row of the same table and a range from a title into the body', () => {
    const root = createRoot(
      '<table><tbody><tr><td>ab</td></tr><tr><td>cd</td></tr></tbody></table>'
      + '<details open=""><summary>ti</summary><p>body</p></details>',
    );
    const [first, second] = [...root.querySelectorAll('td')].map((cell) => readChildText(cell, 0));
    const title = readChildText(readElement(root, 'summary'), 0);
    const body = readChildText(readElement(root, 'details > p'), 0);

    expect([
      isStructureCrossingRange(createRange(first, 1, second, 1), root),
      isStructureCrossingRange(createRange(title, 1, body, 1), root),
    ]).toEqual([true, true]);
  });

  it('returns false for ranges within one cell, two body paragraphs, or code, and for a range containing a whole table', () => {
    const root = createRoot(
      `<p>xy</p><table><tbody><tr><td>abcd</td></tr></tbody></table><p>zw</p>`
      + '<details open=""><summary>t</summary><p>ef</p><p>gh</p></details><pre><code>ijkl</code></pre>',
    );
    const cell = readChildText(readElement(root, 'td'), 0);
    const [firstBody, secondBody] = [...root.querySelectorAll('details > p')].map((p) => readChildText(p, 0));
    const code = readChildText(readElement(root, 'code'), 0);
    const before = readChildText(readElement(root, 'p'), 0);
    const after = readChildText(readElement(root, 'p:nth-of-type(2)'), 0);

    expect([
      isStructureCrossingRange(createRange(cell, 1, cell, 3), root),
      isStructureCrossingRange(createRange(firstBody, 1, secondBody, 1), root),
      isStructureCrossingRange(createRange(code, 1, code, 3), root),
      isStructureCrossingRange(createRange(before, 1, after, 1), root),
    ]).toEqual([false, false, false, false]);
  });

  it('returns false for a range without a range selection', () => {
    const root = createRoot(TABLE);
    const cell = readChildText(readElement(root, 'td'), 0);

    expect(isStructureCrossingRange(caretAt(cell, 0), root)).toBe(false);
  });
});

describe('title with the caret at its start', () => {
  it('returns the title at the start of its text and at the start position inside the title', () => {
    const root = createRoot('<details open=""><summary>title</summary><p>body</p></details>');
    const title = readElement(root, 'summary');

    expect([
      findTitleWithCaretAtStart(root, caretAt(readChildText(title, 0), 0)) === title,
      findTitleWithCaretAtStart(root, caretAt(title, 0)) === title,
    ]).toEqual([true, true]);
  });

  it('also returns the title after an HTML comment and an empty strong at the start of the title', () => {
    const root = createRoot('<details><summary><!-- note --><strong></strong>title</summary><p>body</p></details>');
    const title = readElement(root, 'summary');

    expect(findTitleWithCaretAtStart(root, caretAt(readChildText(title, 2), 0)) === title).toBe(true);
  });

  it('returns the title at the start of a heading that is the first child of the title', () => {
    const root = createRoot('<details open=""><summary><h2>title</h2></summary><p>body</p></details>');
    const heading = readChildText(readElement(root, 'h2'), 0);

    expect(findTitleWithCaretAtStart(root, caretAt(heading, 0)) === readElement(root, 'summary')).toBe(true);
  });

  it('returns undefined in the middle of the title, at the start of the first body paragraph, at the start of a summary that is not the title, and for a range selection', () => {
    const root = createRoot('<details open=""><summary>title</summary><p>body</p><summary>extra</summary></details>');
    const title = readChildText(readElement(root, 'summary'), 0);
    const body = readChildText(readElement(root, 'details > p'), 0);
    const extra = readChildText(readElement(root, 'summary:last-of-type'), 0);

    expect([
      findTitleWithCaretAtStart(root, caretAt(title, 2)),
      findTitleWithCaretAtStart(root, caretAt(body, 0)),
      findTitleWithCaretAtStart(root, caretAt(extra, 0)),
      findTitleWithCaretAtStart(root, createRange(title, 0, title, 2)),
    ]).toEqual([undefined, undefined, undefined, undefined]);
  });
});
