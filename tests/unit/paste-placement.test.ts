import { describe, expect, it } from 'vitest';

import { parseInertFragment } from '../../webview/document/inert-fragment';
import { decidePastePlacement, isPasteBlock } from '../../webview/editing/paste-placement';
import type { PastePlacement } from '../../webview/editing/paste-placement';
import { mountRoot, readChildText, readElement } from './helpers/format-dom';

// A fragment with only one paragraph.
const PARAGRAPH = '<p>X</p>';
// A paragraph with text on both sides of a comment that has annotated text cd and a body.
const COMMENT_PARAGRAPH = '<p>ab<comment id="c">cd<comment-body>note</comment-body></comment>ef</p>';

/**
 * Decides the placement from the fragment HTML and a position.
 *
 * @param html The fragment HTML.
 * @param root The editor root.
 * @param container The node of the position.
 * @param offset The offset of the position.
 * @returns The placement.
 */
function decide(html: string, root: Element, container: Node, offset: number): PastePlacement {
  return decidePastePlacement(parseInertFragment(html, document), root, { container, offset });
}

/**
 * Decides the placement of a paragraph fragment at a position in the text of the element's first child.
 *
 * @param root The editor root.
 * @param selector The element selector.
 * @returns The placement.
 */
function decideParagraphIn(root: Element, selector: string): PastePlacement {
  return decide(PARAGRAPH, root, readChildText(readElement(root, selector), 0), 1);
}

describe('deciding the placement', () => {
  it('an inline-only fragment is placed at the caret in the middle of a paragraph', () => {
    const root = mountRoot('<p>abcd</p>');

    expect(decide('<b>X</b> <i>Y</i>', root, readChildText(readElement(root, 'p'), 0), 2)).toEqual({ kind: 'caret' });
  });

  it('a paragraph fragment goes next to the current block inside a paragraph, heading, or div', () => {
    const root = mountRoot('<p>ab</p><h3>cd</h3><div>ef</div>');

    expect([decideParagraphIn(root, 'p'), decideParagraphIn(root, 'h3'), decideParagraphIn(root, 'div')]).toEqual([
      { kind: 'adjacent', block: readElement(root, 'p') },
      { kind: 'adjacent', block: readElement(root, 'h3') },
      { kind: 'adjacent', block: readElement(root, 'div') },
    ]);
  });

  it('a fragment whose top level is a single pre without line breaks becomes inline code, and a pre with line breaks goes next to the block', () => {
    const root = mountRoot('<p>abcd</p>');
    const text = readChildText(readElement(root, 'p'), 0);

    expect([decide('\n<pre><code>x</code></pre>\n', root, text, 2), decide('<pre><code>x\ny</code></pre>', root, text, 2)])
      .toEqual([{ kind: 'inlineCode' }, { kind: 'adjacent', block: readElement(root, 'p') }]);
  });

  it('a single-line pre with only a trailing pre break becomes inline code, and a pre containing br does not', () => {
    const root = mountRoot('<p>abcd</p>');
    const text = readChildText(readElement(root, 'p'), 0);

    expect([decide('<pre><code>x\n</code></pre>', root, text, 2), decide('<pre>x<br>y</pre>', root, text, 2)])
      .toEqual([{ kind: 'inlineCode' }, { kind: 'adjacent', block: readElement(root, 'p') }]);
  });

  it('a fragment with a single pre that draws lines with div and has no newline characters goes next to the block instead of becoming inline code', () => {
    const root = mountRoot('<p>abcd</p>');

    expect(decide('<pre><div>x</div><div>y</div></pre>', root, readChildText(readElement(root, 'p'), 0), 2))
      .toEqual({ kind: 'adjacent', block: readElement(root, 'p') });
  });

  it('a list-only fragment (ignoring whitespace text in the list) becomes items of the same list in an item without block children, and goes into the container in an item with block children', () => {
    const root = mountRoot('<ul><li id="flat">ab</li><li id="nested">cd<ul><li>ef</li></ul></li></ul>');
    // A list copied within the editor has line break text before, after, and between items.
    const list = '<ul>\n<li>X</li>\n<li>Z</li>\n</ul>\n<ol><li>Y</li></ol>';

    expect([
      decide(list, root, readChildText(readElement(root, '#flat'), 0), 1),
      decide(list, root, readChildText(readElement(root, '#nested'), 0), 1),
    ]).toEqual([
      { kind: 'listItem', item: readElement(root, '#flat') },
      { kind: 'container', container: readElement(root, '#nested') },
    ]);
  });

  it('a fragment with a nested list directly under the list goes into the container even in an item without block children', () => {
    const root = mountRoot('<ul><li>ab</li></ul>');
    const item = readElement(root, 'li');
    const text = readChildText(item, 0);

    expect([
      decide('<ul><li>X</li><ul><li>Y</li></ul></ul>', root, text, 1),
      decide('<ol><li>X</li><ol><li>Y</li></ol></ol>', root, text, 1),
    ]).toEqual([
      { kind: 'container', container: item },
      { kind: 'container', container: item },
    ]);
  });

  it('a paragraph fragment goes into the container directly under an item, cell, blockquote, or details', () => {
    const root = mountRoot('<ul><li>a</li></ul><table><tbody><tr><td>b</td></tr></tbody></table>'
      + '<blockquote>c</blockquote><details open=""><summary>t</summary>d</details>');

    expect([
      decideParagraphIn(root, 'li'),
      decideParagraphIn(root, 'td'),
      decideParagraphIn(root, 'blockquote'),
      decide(PARAGRAPH, root, readChildText(readElement(root, 'details'), 1), 1),
    ]).toEqual([
      { kind: 'container', container: readElement(root, 'li') },
      { kind: 'container', container: readElement(root, 'td') },
      { kind: 'container', container: readElement(root, 'blockquote') },
      { kind: 'container', container: readElement(root, 'details') },
    ]);
  });

  it('a paragraph fragment becomes the text form inside a title and inside a heading in a title', () => {
    const root = mountRoot('<details><summary>t</summary></details><details><summary><h2>u</h2></summary></details>');

    expect([decideParagraphIn(root, 'summary'), decideParagraphIn(root, 'h2')])
      .toEqual([{ kind: 'text' }, { kind: 'text' }]);
  });

  it('a paragraph fragment becomes the text form in the middle of a comment, and goes next to the current block at a comment edge (inside or outside neighbor)', () => {
    const root = mountRoot(COMMENT_PARAGRAPH);
    const annotated = readChildText(readElement(root, 'comment'), 0);
    const paragraph = readElement(root, 'p');

    expect([
      decide(PARAGRAPH, root, annotated, 1),
      decide(PARAGRAPH, root, annotated, 2),
      decide(PARAGRAPH, root, paragraph, 2),
    ]).toEqual([{ kind: 'text' }, { kind: 'adjacent', block: paragraph }, { kind: 'adjacent', block: paragraph }]);
  });

  it('an inline-only fragment is placed at the caret even in the middle of a comment', () => {
    const root = mountRoot(COMMENT_PARAGRAPH);

    expect(decide('<b>X</b>', root, readChildText(readElement(root, 'comment'), 0), 1)).toEqual({ kind: 'caret' });
  });

  it('an inline-only fragment also becomes the text form inside code inside pre', () => {
    const root = mountRoot('<pre><code>abcd</code></pre>');

    expect(decide('<b>X</b>', root, readChildText(readElement(root, 'code'), 0), 2)).toEqual({ kind: 'text' });
  });

  it('in bare text directly under the editor root there is no current block, so a paragraph fragment goes into the container', () => {
    const root = mountRoot('ab');

    expect(decide(PARAGRAPH, root, readChildText(root, 0), 1)).toEqual({ kind: 'container', container: root });
  });
});

describe('deciding blocks', () => {
  it('an a wrapping div is a block, and strong, img, and text are inline', () => {
    const fragment = parseInertFragment('<a href="a.html"><div>x</div></a><strong>y</strong><img src="a.png">z', document);

    expect([...fragment.childNodes].map((node) => isPasteBlock(node))).toEqual([true, false, false, false]);
  });

  it('svg with path and select with option are inline', () => {
    const fragment = parseInertFragment('<svg><path d="M0 0L1 1"></path></svg><select><option>a</option></select>', document);

    expect([...fragment.childNodes].map((node) => isPasteBlock(node))).toEqual([false, false]);
  });

  it('font, strike, big, tt, and nobr are inline, and a font wrapping div is a block', () => {
    const fragment = parseInertFragment(
      '<font color="#ff0000">a</font><strike>b</strike><big>c</big><tt>d</tt><nobr>e</nobr><font><div>f</div></font>',
      document,
    );

    expect([...fragment.childNodes].map((node) => isPasteBlock(node))).toEqual([false, false, false, false, false, true]);
  });

  it('ruby with rb, custom elements such as g-emoji, and acronym are inline, and a custom element wrapping a paragraph is a block', () => {
    const fragment = parseInertFragment(
      '<ruby><rb>kan</rb><rp>(</rp><rt>ji</rt><rp>)</rp></ruby><g-emoji>x</g-emoji><acronym>y</acronym>'
      + '<x-card><p>z</p></x-card>',
      document,
    );

    expect([...fragment.childNodes].map((node) => isPasteBlock(node))).toEqual([false, false, false, true]);
  });
});
