import { describe, expect, it } from 'vitest';

import { clearFormats } from '../../webview/editing/format-clear';
import { applyLink, findEnclosingLink, removeLink } from '../../webview/editing/format-link';
import { collectFormatSegments } from '../../webview/editing/format-segment';
import { applyFormat, removeFormat } from '../../webview/editing/format-toggle';
import { createRange, createRoot, readChildText, readElement } from './helpers/format-dom';

describe('toggling a format', () => {
  it('wraps the format segment in one strong and gathers it into one, removing the b that was inside', () => {
    const root = createRoot('<p>a<b>bc</b>d</p>');
    const paragraph = readElement(root, 'p');
    const range = createRange(readChildText(paragraph, 0), 0, readChildText(paragraph, 2), 1);

    applyFormat('bold', collectFormatSegments(root, range));

    expect(root.innerHTML).toBe('<p><strong>abcd</strong></p>');
  });

  it('does not wrap and returns no touched block when the whole format segment is already inside the same format', () => {
    const root = createRoot('<p><strong>abc</strong></p>');
    const text = readChildText(readElement(root, 'strong'), 0);
    const segments = collectFormatSegments(root, createRange(text, 1, text, 2));

    const touched = applyFormat('bold', segments);

    expect([touched, root.innerHTML]).toEqual([[], '<p><strong>abc</strong></p>']);
  });

  it('wraps only the inside without splitting an element of another format that the format segment partly covers', () => {
    const root = createRoot('<p><em>ab</em></p>');
    const text = readChildText(readElement(root, 'em'), 0);

    applyFormat('bold', collectFormatSegments(root, createRange(text, 1, text, 2)));

    expect(root.innerHTML).toBe('<p><em>a<strong>b</strong></em></p>');
  });

  it('splits a format element that reaches beyond the format segment at the boundary and keeps it outside', () => {
    const root = createRoot('<p><strong>abc</strong></p>');
    const text = readChildText(readElement(root, 'strong'), 0);

    removeFormat('bold', collectFormatSegments(root, createRange(text, 1, text, 2)));

    expect(root.innerHTML).toBe('<p><strong>a</strong>b<strong>c</strong></p>');
  });

  it('copies the attributes to both sides when splitting an element with attributes, keeping the id on the leading side only', () => {
    const root = createRoot('<p><strong id="s1" class="x">abc</strong></p>');
    const text = readChildText(readElement(root, 'strong'), 0);

    removeFormat('bold', collectFormatSegments(root, createRange(text, 1, text, 2)));

    expect(root.innerHTML)
      .toBe('<p><strong id="s1" class="x">a</strong>b<strong class="x">c</strong></p>');
  });

  it('does not split a comment even when the format segment boundary lies inside it', () => {
    const root = createRoot('<p><strong>a<comment id="c1">b</comment>c</strong></p>');
    const strong = readElement(root, 'strong');
    const text = readChildText(strong, 2);

    removeFormat('bold', collectFormatSegments(root, createRange(text, 0, text, 1)));

    expect(root.innerHTML).toBe('<p><strong>a<comment id="c1">b</comment></strong>c</p>');
  });

  it('removes a format element that straddles a comment from inside the comment too, without splitting it', () => {
    const root = createRoot('<p><strong>a<comment id="c1">bc</comment>d</strong></p>');
    const strong = readElement(root, 'strong');
    const range = createRange(readChildText(strong, 0), 0, readChildText(strong, 2), 1);

    removeFormat('bold', collectFormatSegments(root, range));

    expect(root.innerHTML).toBe('<p>a<comment id="c1">bc</comment>d</p>');
  });

  it('keeps the format on the rest of a comment when only part of its inside is unformatted', () => {
    const root = createRoot('<p><strong>a<comment id="c1">bc</comment></strong></p>');
    const text = readChildText(readElement(root, 'comment'), 0);

    removeFormat('bold', collectFormatSegments(root, createRange(text, 0, text, 1)));

    expect(root.innerHTML)
      .toBe('<p><strong>a</strong><comment id="c1">b<strong>c</strong></comment></p>');
  });

  it('creates an em when italic is applied, never an i', () => {
    const root = createRoot('<p><i>a</i>b</p>');
    const text = readChildText(readElement(root, 'p'), 1);

    applyFormat('italic', collectFormatSegments(root, createRange(text, 0, text, 1)));

    expect(root.innerHTML).toBe('<p><i>a</i><em>b</em></p>');
  });
});

describe('applying, changing, and removing a link', () => {
  it('changes the href of the whole link when the selection fits inside one link, even for a partial range', () => {
    const root = createRoot('<p><a href="old.html">abc</a></p>');
    const text = readChildText(readElement(root, 'a'), 0);
    const segments = collectFormatSegments(root, createRange(text, 1, text, 2));

    applyLink('new.html', { kind: 'segments', segments }, root);

    expect(root.innerHTML).toBe('<p><a href="new.html">abc</a></p>');
  });

  it('removes the intersecting links for a range spanning several links, so the new link is not nested', () => {
    const root = createRoot('<p><a href="a.html">ab</a>c<a href="b.html">de</a></p>');
    const [first, second] = [...root.querySelectorAll('a')];
    if (first === undefined || second === undefined) {
      throw new Error('link not found');
    }
    const range = createRange(readChildText(first, 0), 1, readChildText(second, 0), 1);
    const segments = collectFormatSegments(root, range);

    applyLink('n.html', { kind: 'segments', segments }, root);

    expect(root.innerHTML).toBe(
      '<p><a href="a.html">a</a><a href="n.html">b</a><a href="n.html">c</a>'
      + '<a href="n.html">d</a><a href="b.html">e</a></p>',
    );
  });

  it('removes the link only on the target text side and keeps it outside when the range spans several links', () => {
    const root = createRoot('<p><a href="a.html">ab</a>c<a href="b.html">de</a></p>');
    const [first, second] = [...root.querySelectorAll('a')];
    if (first === undefined || second === undefined) {
      throw new Error('link not found');
    }
    const range = createRange(readChildText(first, 0), 1, readChildText(second, 0), 1);
    const segments = collectFormatSegments(root, range);

    removeLink({ kind: 'segments', segments }, root);

    expect(root.innerHTML).toBe('<p><a href="a.html">a</a>bcd<a href="b.html">e</a></p>');
  });

  it('returns undefined and leaves the tree unchanged when the caret is outside a link', () => {
    const root = createRoot('<p><a href="a.html">ab</a>c</p>');
    const text = readChildText(readElement(root, 'p'), 1);
    const caret = createRange(text, 1, text, 1);

    expect([findEnclosingLink({ kind: 'caret', caret }, root), root.innerHTML])
      .toEqual([undefined, '<p><a href="a.html">ab</a>c</p>']);
  });

  it('creates one link per block with the same URL for format segments spanning several blocks', () => {
    const root = createRoot('\n<p>ab</p>\n<p>cd</p>');
    const [first, second] = [...root.querySelectorAll('p')];
    if (first === undefined || second === undefined) {
      throw new Error('paragraph not found');
    }
    const range = createRange(readChildText(first, 0), 1, readChildText(second, 0), 1);
    const segments = collectFormatSegments(root, range);

    applyLink('x.html', { kind: 'segments', segments }, root);

    expect(root.innerHTML)
      .toBe('\n<p>a<a href="x.html">b</a></p>\n<p><a href="x.html">c</a>d</p>');
  });
});

describe('clearing formats', () => {
  it('removes the format elements of the four formats and the spans, keeping a and the elements the extension does not know', () => {
    const root = createRoot(
      '<p><strong>a</strong><span style="color:red">b</span><a href="x.html">c</a><kbd>d</kbd></p>',
    );
    const paragraph = readElement(root, 'p');
    const range = createRange(paragraph, 0, paragraph, paragraph.childNodes.length);

    clearFormats(collectFormatSegments(root, range), range, root);

    expect(root.innerHTML).toBe('<p>ab<a href="x.html">c</a><kbd>d</kbd></p>');
  });

  it('removes a span with a style as a whole element too, dropping the text color', () => {
    const root = createRoot('<p><span style="color:red">ab</span></p>');
    const paragraph = readElement(root, 'p');
    const range = createRange(paragraph, 0, paragraph, paragraph.childNodes.length);

    clearFormats(collectFormatSegments(root, range), range, root);

    expect(root.innerHTML).toBe('<p>ab</p>');
  });

  it('returns no touched block and leaves the tree unchanged when there is nothing to remove', () => {
    const root = createRoot('<p>ab</p>');
    const text = readChildText(readElement(root, 'p'), 0);
    const range = createRange(text, 0, text, 2);

    const touched = clearFormats(collectFormatSegments(root, range), range, root);

    expect([touched, root.innerHTML]).toEqual([[], '<p>ab</p>']);
  });

  it('removes a format element that straddles a comment from inside the comment even when it is nested', () => {
    const root = createRoot('<p><strong><em>a<comment id="c1">bc</comment>d</em></strong></p>');
    const em = readElement(root, 'em');
    const range = createRange(readChildText(em, 0), 0, readChildText(em, 2), 1);

    clearFormats(collectFormatSegments(root, range), range, root);

    expect(root.innerHTML).toBe('<p>a<comment id="c1">bc</comment>d</p>');
  });

  it('removes every element of the four formats inside the format segment, however deeply nested', () => {
    const root = createRoot('<p><strong>a<em><s>b</s></em></strong></p>');
    const paragraph = readElement(root, 'p');
    const range = createRange(paragraph, 0, paragraph, paragraph.childNodes.length);

    clearFormats(collectFormatSegments(root, range), range, root);

    expect(root.innerHTML).toBe('<p>ab</p>');
  });
});

describe('clearing the style of blocks', () => {
  it('removes the style of the paragraph and of the li and ul around it when the selection covers all their text, returning the three as touched blocks', () => {
    const root = createRoot('<ul style="color:red"><li style="color:blue"><p style="text-align:center">ab</p></li></ul>');
    const text = readChildText(readElement(root, 'p'), 0);
    const range = createRange(text, 0, text, 2);

    const touched = clearFormats(collectFormatSegments(root, range), range, root);

    expect([touched.map((block) => block.localName), root.innerHTML])
      .toEqual([['p', 'li', 'ul'], '<ul><li><p>ab</p></li></ul>']);
  });

  it('keeps the style of a paragraph the selection covers only in part and returns no touched block', () => {
    const root = createRoot('<p style="color:red">abc</p>');
    const text = readChildText(readElement(root, 'p'), 0);
    const range = createRange(text, 1, text, 2);

    const touched = clearFormats(collectFormatSegments(root, range), range, root);

    expect([touched, root.innerHTML]).toEqual([[], '<p style="color:red">abc</p>']);
  });

  it('removes the style of the first li and keeps that of the ul when only the first item is selected', () => {
    const root = createRoot('<ul style="color:red"><li style="color:blue">a</li><li>b</li></ul>');
    const text = readChildText(readElement(root, 'li'), 0);
    const range = createRange(text, 0, text, 1);

    clearFormats(collectFormatSegments(root, range), range, root);

    expect(root.innerHTML).toBe('<ul style="color:red"><li>a</li><li>b</li></ul>');
  });

  it('removes the style of a paragraph when the selection covers all its visible text but not the whitespace at its ends', () => {
    const root = createRoot('<p style="color:red"> ab </p>');
    const text = readChildText(readElement(root, 'p'), 0);
    const range = createRange(text, 1, text, 3);

    clearFormats(collectFormatSegments(root, range), range, root);

    expect(root.innerHTML).toBe('<p> ab </p>');
  });

  it('removes the style of a paragraph when the selection covers the text up to the annotated text but not the comment body', () => {
    const root = createRoot('<p style="color:red">a<comment id="c1">b<comment-body>note</comment-body></comment></p>');
    const range = createRange(
      readChildText(readElement(root, 'p'), 0),
      0,
      readChildText(readElement(root, 'comment'), 0),
      1,
    );

    clearFormats(collectFormatSegments(root, range), range, root);

    expect(root.innerHTML).toBe('<p>a<comment id="c1">b<comment-body>note</comment-body></comment></p>');
  });

  it('keeps the style of a u, which is phrasing content, and removes only that of the paragraph', () => {
    const root = createRoot('<p style="color:blue"><u style="color:red">ab</u></p>');
    const paragraph = readElement(root, 'p');
    const range = createRange(paragraph, 0, paragraph, paragraph.childNodes.length);

    clearFormats(collectFormatSegments(root, range), range, root);

    expect(root.innerHTML).toBe('<p><u style="color:red">ab</u></p>');
  });

  it('keeps the style of a text inside SVG and removes only that of the paragraph', () => {
    const root = createRoot('<p style="color:blue"><svg><text style="fill:red">ab</text></svg></p>');
    const paragraph = readElement(root, 'p');
    const range = createRange(paragraph, 0, paragraph, paragraph.childNodes.length);

    clearFormats(collectFormatSegments(root, range), range, root);

    expect(root.innerHTML).toBe('<p><svg><text style="fill:red">ab</text></svg></p>');
  });
});
