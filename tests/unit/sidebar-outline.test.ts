import { describe, expect, it } from 'vitest';

import { readChangeOutline, readCommentOutline, readHeadingOutline } from '../../webview/ui/sidebar-outline';
import { createRoot } from './helpers/format-dom';

/**
 * Returns the heading outline as pairs of the tag name and the depth.
 *
 * @param html The contents of the editor root.
 * @returns The tag name and the depth of each heading, in the order returned.
 */
function readDepths(html: string): [string, number][] {
  return readHeadingOutline(createRoot(html)).map((item) => [item.element.localName, item.depth]);
}

describe('Reading the heading outline', () => {
  it('returns h1, h2 and h3 in document order with depths 0, 1 and 2', () => {
    expect(readDepths('<h1>A</h1><p>x</p><h2>B</h2><p>y</p><h3>C</h3>')).toEqual([
      ['h1', 0],
      ['h2', 1],
      ['h3', 2],
    ]);
  });

  it('nests an h3 right after an h1 only one step deeper, and gives the h2 after it the same depth', () => {
    expect(readDepths('<h1>A</h1><h3>B</h3><h2>C</h2>')).toEqual([
      ['h1', 0],
      ['h3', 1],
      ['h2', 1],
    ]);
  });

  it('starts from depth 0 when the first heading is an h2, and gives a later h1 depth 0 too', () => {
    expect(readDepths('<h2>A</h2><h3>B</h3><h1>C</h1><h2>D</h2>')).toEqual([
      ['h2', 0],
      ['h3', 1],
      ['h1', 0],
      ['h2', 1],
    ]);
  });

  it('leaves out headings inside entries and keeps headings in the body of a closed collapsible section', () => {
    const root = createRoot(
      '<h1>Top</h1>'
      + '<div><comment id="c-a">x<comment-body><h2>In body</h2></comment-body>'
      + '<comment-reply><h3>In reply</h3></comment-reply></comment></div>'
      + '<details><summary>Title</summary><h2>Folded</h2></details>',
    );

    expect(readHeadingOutline(root).map((item) => item.text)).toEqual(['Top', 'Folded']);
  });

  it('reads the heading text without the entries inside it, with runs of whitespace and line breaks collapsed to one space and the ends trimmed', () => {
    const root = createRoot(
      '<h2>\n  Alpha&nbsp; <em>beta</em> <comment id="c-a">gamma<comment-body>note</comment-body></comment>'
      + '<br>delta\n</h2>',
    );

    expect(readHeadingOutline(root).map((item) => item.text)).toEqual(['Alpha beta gamma delta']);
  });
});

describe('Reading the comment outline', () => {
  it('returns the comments in the document order of their start tags, counting a nested inner comment as one', () => {
    const root = createRoot(
      '<p><comment id="c-a">one <comment id="c-b">two</comment></comment></p>'
      + '<h2><comment id="c-c">three</comment></h2>',
    );

    expect(readCommentOutline(root).map((item) => item.element.id)).toEqual(['c-a', 'c-b', 'c-c']);
  });

  it('reads the annotated text without its own entries and the entries of nested comments', () => {
    const root = createRoot(
      '<p><comment id="c-a">one <comment id="c-b">two<comment-body>inner</comment-body></comment> end'
      + '<comment-body>outer</comment-body><comment-reply>reply</comment-reply></comment></p>',
    );

    expect(readCommentOutline(root).map((item) => [item.element.id, item.text])).toEqual([
      ['c-a', 'one two end'],
      ['c-b', 'two'],
    ]);
  });

  it('treats a comment with data-resolved as resolved whatever its value, and one without it as not resolved', () => {
    const root = createRoot(
      '<p><comment id="c-a" data-resolved="">a</comment><comment id="c-b" data-resolved="false">b</comment>'
      + '<comment id="c-c">c</comment></p>',
    );

    expect(readCommentOutline(root).map((item) => [item.element.id, item.resolved])).toEqual([
      ['c-a', true],
      ['c-b', true],
      ['c-c', false],
    ]);
  });

  it('takes the author side from the first entry alone, counting anything but ai, and a comment without entries, as human', () => {
    const root = createRoot(
      '<p><comment id="c-a">a<comment-body data-author="ai">x</comment-body></comment>'
      + '<comment id="c-b">b<comment-body data-author="human">x</comment-body></comment>'
      + '<comment id="c-c">c<comment-body data-author="AI">x</comment-body></comment>'
      + '<comment id="c-d">d</comment>'
      + '<comment id="c-e">e<comment-body data-author="human">x</comment-body><comment-reply data-author="ai">y</comment-reply></comment>'
      + '<comment id="c-f">f<comment-reply data-author="ai">y</comment-reply></comment></p>',
    );

    expect(readCommentOutline(root).map((item) => [item.element.id, item.author])).toEqual([
      ['c-a', 'ai'],
      ['c-b', 'human'],
      ['c-c', 'human'],
      ['c-d', 'human'],
      ['c-e', 'human'],
      ['c-f', 'ai'],
    ]);
  });
});

describe('Reading the change outline', () => {
  it('returns the marks in document order with their kinds and author sides, and the text of their content without entries', () => {
    const root = createRoot(
      '<p><ins id="i-a" data-author="ai">one <comment id="c">two<comment-body>note</comment-body></comment></ins>'
      + ' <del id="d-a" data-author="human">three</del></p>'
      + '<p><comment id="c-b">x<comment-body><ins id="hidden">in entry</ins></comment-body></comment></p>',
    );

    expect(readChangeOutline(root).map((item) => [item.element.id, item.kind, item.author, item.text])).toEqual([
      ['i-a', 'ins', 'ai', 'one two'],
      ['d-a', 'del', 'human', 'three'],
    ]);
  });

  it('reads the text of an element that carries the kind from the element itself', () => {
    const root = createRoot(
      '<table><tbody><tr id="r" data-change="del"><td>cell\n  one</td><td>two</td></tr></tbody></table>'
      + '<ul><li id="l" data-change="ins"><strong>bold</strong> item</li></ul>',
    );

    expect(readChangeOutline(root).map((item) => [item.element.id, item.kind, item.text])).toEqual([
      ['r', 'del', 'cell onetwo'],
      ['l', 'ins', 'bold item'],
    ]);
  });

  it('lists a deletion followed by an insertion from the same author side as one replacement with both texts, and keeps other neighbours apart', () => {
    const root = createRoot(
      '<p><del id="d" data-author="ai">hour</del><ins id="i" data-author="ai">30 minutes</ins> '
      + '<del id="x" data-author="ai">a</del><ins id="y" data-author="human">b</ins></p>',
    );

    expect(readChangeOutline(root).map((item) => [item.element.id, item.kind, item.author, item.text])).toEqual([
      ['d', 'replacement', 'ai', 'hour → 30 minutes'],
      ['x', 'del', 'ai', 'a'],
      ['y', 'ins', 'human', 'b'],
    ]);
  });
});
