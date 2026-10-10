import { describe, expect, it } from 'vitest';

import { quarantineUnsafeAttributes } from '../../webview/document/attribute-sanitizer';
import { serializeBody } from '../../webview/document/body-serializer';
import { resolveImageSources } from '../../webview/document/image-source-resolver';
import { parseInertFragment } from '../../webview/document/inert-fragment';
import { CELL_RANGE_MARK_NAME, CELL_RANGE_MARK_NAMESPACE } from '../../webview/editing/cell-range';
import {
  createCopyContent,
  removeBoundaryEmptyBlocks,
  removeClosedDetailsBodies,
  removeCommentAnnotations,
  serializeCopyFragment,
  serializeCopyText,
} from '../../webview/editing/copy-html';
import { cloneRangeFragment } from '../../webview/editing/range-fragment';
import { COMMENT_CARET_MARK_NAME, COMMENT_CARET_MARK_NAMESPACE } from '../../webview/ui/comment-caret';
import { createRange, mountRoot, readChildText, readElement } from './helpers/format-dom';

// A closed collapsible section and the paragraph after it.
const CLOSED_DETAILS = '<details><summary>Title</summary>\n<p>Body</p>\n</details>\n<p>Next</p>';

/**
 * Creates a range between the texts that are the first children of two elements.
 *
 * @param root The element to start searching from.
 * @param start The selector of the element holding the start text, and the position in that text.
 * @param end The selector of the element holding the end text, and the position in that text.
 * @returns The range.
 */
function rangeBetween(root: Element, start: readonly [string, number], end: readonly [string, number]): Range {
  return createRange(
    readChildText(readElement(root, start[0]), 0),
    start[1],
    readChildText(readElement(root, end[0]), 0),
    end[1],
  );
}

/**
 * Removes comment annotations from fragment HTML and serializes it.
 *
 * @param html The fragment HTML.
 * @returns The fragment HTML without annotations.
 */
function unannotate(html: string): string {
  const fragment = parseInertFragment(html, document);
  removeCommentAnnotations(fragment);
  return serializeBody(fragment);
}

/**
 * Clones a range, removes closed collapsible section bodies, and serializes it.
 *
 * @param range The range to clone.
 * @param root The editor root.
 * @returns The fragment HTML without the bodies.
 */
function excludeBodies(range: Range, root: Element): string {
  const copied = cloneRangeFragment(range);
  removeClosedDetailsBodies(copied, range, root, () => undefined);
  return serializeBody(copied.fragment);
}

/**
 * Removes boundary empty blocks from fragment HTML and serializes it. The fragment is written directly in HTML in the
 * shape that cloning and rewrapping a range produce.
 *
 * @param html The fragment HTML.
 * @returns The fragment HTML without boundary empty blocks.
 */
function trimBoundary(html: string): string {
  const fragment = parseInertFragment(html, document);
  removeBoundaryEmptyBlocks(fragment);
  return serializeBody(fragment);
}

describe('creating the copy content', () => {
  it('when reading the range throws, does not let it escape, records one diagnostic line, and returns undefined', () => {
    const root = mountRoot('<p>abc</p>');
    const text = readChildText(readElement(root, 'p'), 0);
    const range = createRange(text, 1, text, 2);
    Object.defineProperty(range, 'startContainer', {
      get: () => {
        throw new Error('Cannot read the range');
      },
    });
    const diagnostics: string[] = [];

    const content = createCopyContent(range, root, (detail) => diagnostics.push(detail));

    expect([content, diagnostics.length]).toEqual([undefined, 1]);
  });

  it('creating the copy content from a range containing a comment and a closed collapsible section leaves the serialization of the live tree unchanged', () => {
    const body = `<p>a<comment id="c">bc<comment-body>n</comment-body></comment>d</p>\n${CLOSED_DETAILS}`;
    const root = mountRoot(body);

    createCopyContent(rangeBetween(root, ['comment', 1], ['details + p', 2]), root, () => undefined);

    expect(root.innerHTML).toBe(body);
  });
});

describe('removing annotations', () => {
  it('reduces a comment with entries whose annotated text is <em>x</em>y to just <em>x</em>y', () => {
    expect(unannotate(
      '<comment id="c"><em>x</em>y<comment-body>n</comment-body><comment-reply>r</comment-reply></comment>',
    )).toBe('<em>x</em>y');
  });

  it('unwraps comment at every level of nested comments, leaving the contents of the annotated text', () => {
    expect(unannotate(
      '<comment id="a">p<comment id="b">q<comment-body>n2</comment-body></comment>r<comment-body>n1</comment-body></comment>',
    )).toBe('pqr');
  });

  it('also removes entry elements placed outside a comment', () => {
    expect(unannotate('<p>a<comment-body>n</comment-body>b<comment-reply>r</comment-reply></p>')).toBe('<p>ab</p>');
  });

  it('leaves nothing for a comment whose annotated text is empty', () => {
    expect(unannotate('<comment id="c"><comment-body>n</comment-body></comment>')).toBe('');
  });

  it('keeps an edge paragraph out of the HTML when its only content is a comment with entries and empty annotated text', () => {
    const root = mountRoot('<p><comment id="c"><comment-body>n</comment-body></comment></p>\n<p>x</p>');
    const range = createRange(root, 0, readChildText(readElement(root, 'p + p'), 0), 1);

    expect(createCopyContent(range, root, () => undefined)?.html).toBe('<p>x</p>');
  });
});

describe('excluding closed collapsible section bodies', () => {
  it('for a range from the middle of the title of a closed collapsible section to the following paragraph, removes the body and keeps the title part', () => {
    const root = mountRoot(CLOSED_DETAILS);

    expect(excludeBodies(rangeBetween(root, ['summary', 2], ['details + p', 4]), root))
      .toBe('<details><summary>tle</summary></details>\n<p>Next</p>');
  });

  it('keeps the body too for a range wholly containing a closed collapsible section', () => {
    const root = mountRoot(CLOSED_DETAILS);
    const range = createRange(root, 0, readChildText(readElement(root, 'details + p'), 0), 2);

    expect(excludeBodies(range, root))
      .toBe('<details><summary>Title</summary>\n<p>Body</p>\n</details>\n<p>Ne</p>');
  });

  it('keeps the body of an open collapsible section', () => {
    const root = mountRoot(CLOSED_DETAILS.replace('<details>', '<details open="">'));

    expect(excludeBodies(rangeBetween(root, ['summary', 2], ['details + p', 4]), root))
      .toBe('<details open=""><summary>tle</summary>\n<p>Body</p>\n</details>\n<p>Next</p>');
  });

  it('for a range not wholly containing a closed collapsible section inside the body of an open one, removes only the inner body', () => {
    const root = mountRoot(
      '<details open=""><summary>Outer</summary>\n'
      + '<details><summary>Inner</summary>\n<p>Hidden</p>\n</details>\n<p>Shown</p>\n</details>',
    );

    expect(excludeBodies(rangeBetween(root, ['details details summary', 2], ['details details + p', 5]), root))
      .toBe('<details><summary>ner</summary></details>\n<p>Shown</p>');
  });

  it('removes a comment directly under the body of a closed collapsible section, together with its annotated text, even after annotation removal unwrapped it', () => {
    const root = mountRoot(
      '<details><summary>Title</summary>see <comment id="c">this<comment-body>n</comment-body></comment></details>'
      + '<p>Next</p>',
    );
    const range = rangeBetween(root, ['summary', 2], ['details + p', 2]);
    const copied = cloneRangeFragment(range);
    removeCommentAnnotations(copied.fragment);

    removeClosedDetailsBodies(copied, range, root, () => undefined);

    expect(serializeBody(copied.fragment)).toBe('<details><summary>tle</summary></details><p>Ne</p>');
  });
});

describe('removing boundary empty blocks', () => {
  it('reduces a fragment from the end of paragraph A to the start of paragraph C (all of paragraph B) to just <p>B</p>, with no line breaks left between', () => {
    expect(trimBoundary('<p></p>\n<p>B</p>\n<p></p>')).toBe('<p>B</p>');
  });

  it('turns a fragment from the end of an item to the middle of the next item into a one-item list without the empty item', () => {
    expect(trimBoundary('<ul><li></li><li>b</li></ul>')).toBe('<ul><li>b</li></ul>');
  });

  it('keeps an empty cell in a row with visible content', () => {
    const html = '<table><tbody><tr><td></td><td>x</td></tr></tbody></table>';

    expect(trimBoundary(html)).toBe(html);
  });

  it('keeps the column definitions (colgroup and col) of a table with visible content', () => {
    const html = '<table><colgroup><col style="width: 40%;"><col></colgroup><tbody><tr><td>x</td></tr></tbody></table>';

    expect(trimBoundary(html)).toBe(html);
  });

  it('keeps the empty title of a collapsible section with visible content', () => {
    const html = '<details open=""><summary></summary><p>x</p></details>';

    expect(trimBoundary(html)).toBe(html);
  });

  it('removes whole tables, lists, collapsible sections, and rows without visible content at the edges', () => {
    expect(trimBoundary(
      '<table><tbody><tr><td></td></tr></tbody></table><ul><li></li></ul><details><summary></summary></details>'
      + '<p>x</p><table><tbody><tr><td>y</td></tr><tr><td></td></tr></tbody></table>',
    )).toBe('<p>x</p><table><tbody><tr><td>y</td></tr></tbody></table>');
  });

  it('removes an originally empty paragraph at the edge', () => {
    expect(trimBoundary('<p><br></p>\n<p>x</p>')).toBe('<p>x</p>');
  });

  it('keeps an empty paragraph between the first and last visible content', () => {
    const html = '<p>a</p>\n<p><br></p>\n<p>b</p>';

    expect(trimBoundary(html)).toBe(html);
  });

  it('empties a fragment without visible content', () => {
    expect(trimBoundary('<p></p>\n<ul><li><br></li></ul>')).toBe('');
  });

  it('keeps an edge paragraph holding only img and an edge hr, and removes a paragraph holding only br', () => {
    expect(trimBoundary('<p><br></p><p><img src="a.png"></p><p>x</p><hr><p><br></p>'))
      .toBe('<p><img src="a.png"></p><p>x</p><hr>');
  });

  it('keeps a pre holding only whitespace, and removes a pre holding only the trailing line break that is not displayed', () => {
    expect(trimBoundary('<pre><code>  </code></pre>\n<p>x</p>\n<pre><code>\n</code></pre>'))
      .toBe('<pre><code>  </code></pre>\n<p>x</p>');
  });

  it('keeps whitespace-only text before a bold word at the start of the fragment', () => {
    expect(trimBoundary(' <strong>b</strong>')).toBe(' <strong>b</strong>');
  });
});

describe('finishing', () => {
  it('restores the src of an image with the rendering source attribute to the author-written relative path and drops the attribute', () => {
    const fragment = parseInertFragment('<p><img src="images/a.png" alt="a"></p>', document);
    resolveImageSources(fragment, 'file:///work/docs/page.html', 'file:///work/');

    expect([fragment.querySelector('img')?.getAttribute('src'), serializeCopyFragment(fragment).html])
      .toEqual(['file:///work/docs/images/a.png', '<p><img src="images/a.png" alt="a"></p>']);
  });

  it('drops a quarantined onclick and javascript: href instead of restoring their original spelling', () => {
    const fragment = parseInertFragment('<p onclick="alert(1)"><a href="javascript:alert(1)">x</a></p>', document);
    quarantineUnsafeAttributes(fragment);

    expect(serializeCopyFragment(fragment).html).toBe('<p><a>x</a></p>');
  });

  it('drops the cell range mark and the comment caret mark', () => {
    const html = '<table><tbody><tr><td>a</td></tr></tbody></table><p>b</p>';
    const fragment = parseInertFragment(html, document);
    fragment.querySelector('td')?.setAttributeNS(CELL_RANGE_MARK_NAMESPACE, CELL_RANGE_MARK_NAME, '');
    fragment.querySelector('p')?.setAttributeNS(COMMENT_CARET_MARK_NAMESPACE, COMMENT_CARET_MARK_NAME, 'human');

    expect(serializeCopyFragment(fragment).html).toBe(html);
  });

  it('drops empty inline elements without attributes, but keeps those under pre and tables', () => {
    const fragment = parseInertFragment(
      '<p>a<strong></strong>b</p><pre><code>c<em></em></code></pre>'
      + '<table><tbody><tr><td><span></span>d</td></tr></tbody></table>',
      document,
    );

    expect(serializeCopyFragment(fragment).html).toBe(
      '<p>ab</p><pre><code>c<em></em></code></pre><table><tbody><tr><td><span></span>d</td></tr></tbody></table>',
    );
  });

  it('makes both forms empty strings for an empty fragment', () => {
    expect(serializeCopyFragment(parseInertFragment('', document))).toEqual({ html: '', text: '' });
  });
});

describe('text form', () => {
  it('separates paragraphs with one blank line between them', () => {
    expect(serializeCopyText(parseInertFragment('<p>a</p>\n<p>b</p>', document))).toBe('a\n\nb');
  });

  it('separates list items with one line break', () => {
    expect(serializeCopyText(parseInertFragment('<ul>\n<li>a</li>\n<li>b</li>\n</ul>', document))).toBe('a\nb');
  });

  it('puts a tab after a cell that is not the last in its row, and a line break after a row that is not the last in its table', () => {
    const fragment = parseInertFragment(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>c</td><td>d</td></tr></tbody></table>',
      document,
    );

    expect(serializeCopyText(fragment)).toBe('a\tb\nc\td');
  });

  it('turns br into a line break', () => {
    expect(serializeCopyText(parseInertFragment('<p>a<br>b</p>', document))).toBe('a\nb');
  });

  it('collapses runs of whitespace outside pre into one space and removes spaces at the start and end of lines', () => {
    expect(serializeCopyText(parseInertFragment('<p>  a \n  <strong> b </strong>  c  </p>', document)))
      .toBe('a b c');
  });

  it('copies whitespace and line breaks inside pre as they are, but not the trailing line break that is not displayed', () => {
    expect(serializeCopyText(parseInertFragment('<pre><code>a\n  b\n</code></pre>', document))).toBe('a\n  b');
  });

  it('copies nothing for images and column definitions', () => {
    const fragment = parseInertFragment(
      '<table><colgroup><col style="width: 40%;"></colgroup><tbody><tr><td>a<img src="a.png" alt="x">b</td></tr></tbody></table>',
      document,
    );

    expect(serializeCopyText(fragment)).toBe('ab');
  });

  it('leaves the fragment unchanged after creating the text form', () => {
    const fragment = parseInertFragment('<p> a </p>\n<pre><code>b\n</code></pre><table><tbody><tr><td>c</td></tr></tbody></table>', document);
    const serializer = new XMLSerializer();
    const before = serializer.serializeToString(fragment);

    serializeCopyText(fragment);

    expect(serializer.serializeToString(fragment)).toBe(before);
  });
});
