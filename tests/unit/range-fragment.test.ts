import { describe, expect, it } from 'vitest';

import { serializeBody } from '../../webview/document/body-serializer';
import { cloneRangeFragment, wrapRangeFragment } from '../../webview/editing/range-fragment';
import { createRange, mountRoot, readChildText, readElement } from './helpers/format-dom';

/**
 * Clones and rewraps a range, then serializes the fragment.
 *
 * @param range The range to clone.
 * @param root The editor root.
 * @returns The HTML of the rewrapped fragment.
 */
function wrapToHtml(range: Range, root: Element): string {
  const copied = cloneRangeFragment(range);
  wrapRangeFragment(copied, range, root);
  return serializeBody(copied.fragment);
}

/**
 * Creates a range between two positions in the text that is an element's first child.
 *
 * @param root The element to start searching from.
 * @param selector The selector of the element holding the text.
 * @param start The start position.
 * @param end The end position.
 * @returns The range.
 */
function rangeIn(root: Element, selector: string, start: number, end: number): Range {
  const text = readChildText(readElement(root, selector), 0);
  return createRange(text, start, text, end);
}

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

describe('cloning a range', () => {
  it('serializing the clone of a range spanning two paragraphs matches serializing Range.cloneContents of the same range', () => {
    const root = mountRoot('<p>ab<em>cd</em>ef</p>\n<p>gh<strong>ij</strong></p>');
    const range = rangeBetween(root, ['em', 1], ['strong', 1]);

    expect(serializeBody(cloneRangeFragment(range).fragment)).toBe(serializeBody(range.cloneContents()));
  });

  it('the clone and the image clone inside it belong to a document other than the live one', () => {
    const root = mountRoot('<p>a<img src="a.png">b</p>');
    const paragraph = readElement(root, 'p');

    const { fragment } = cloneRangeFragment(createRange(paragraph, 0, paragraph, 3));

    const image = fragment.querySelector('img');
    expect([fragment.ownerDocument !== document, image !== null && image.ownerDocument !== document])
      .toEqual([true, true]);
  });

  it('the mapping resolves copies from partly covered text and elements as well as from wholly contained nodes', () => {
    const root = mountRoot('<p>ab<em>cd</em>ef</p><p>gh</p>');
    const first = readElement(root, 'p');
    const second = readElement(root, 'p + p');
    const em = readElement(root, 'em');
    const live = [readChildText(first, 0), first, em, readChildText(em, 0), readChildText(first, 2), second, readChildText(second, 0)];

    const { liveToCopy } = cloneRangeFragment(createRange(live[0], 1, live[6], 1));

    expect(live.map((node) => liveToCopy.get(node)?.textContent)).toEqual(['b', 'bcdef', 'cd', 'cd', 'ef', 'g', 'g']);
  });

  it('cloning leaves the serialization of the live tree and the range endpoints unchanged', () => {
    const body = '<p>ab<img src="a.png">cd</p>\n<p>ef</p>';
    const root = mountRoot(body);
    const range = rangeBetween(root, ['p', 1], ['p + p', 1]);
    const { startContainer, endContainer } = range;

    cloneRangeFragment(range);

    expect([
      root.innerHTML,
      range.startContainer === startContainer,
      range.startOffset,
      range.endContainer === endContainer,
      range.endOffset,
    ]).toEqual([body, true, 1, true, 1]);
  });
});

describe('rewrapping', () => {
  it('wraps a range over part of a bold word in strong', () => {
    const root = mountRoot('<p>a <strong>bold</strong></p>');

    expect(wrapToHtml(rangeIn(root, 'strong', 1, 3), root)).toBe('<strong>ol</strong>');
  });

  it('wraps a range over part of a bold word inside a link in strong and an a with href, innermost first', () => {
    const root = mountRoot('<p>x<a href="a.html"><strong>link</strong></a>y</p>');

    expect(wrapToHtml(rangeIn(root, 'strong', 1, 3), root)).toBe('<a href="a.html"><strong>in</strong></a>');
  });

  it('wraps a range inside code inside pre in code and pre', () => {
    const root = mountRoot('<pre><code>ab\ncd</code></pre>');

    expect(wrapToHtml(rangeIn(root, 'code', 1, 4), root)).toBe('<pre><code>b\nc</code></pre>');
  });

  it('does not wrap a range selecting the whole contents of a paragraph in the paragraph element', () => {
    const root = mountRoot('<p>a<strong>b</strong>c</p>');
    const paragraph = readElement(root, 'p');

    expect(wrapToHtml(createRange(paragraph, 0, paragraph, 3), root)).toBe('a<strong>b</strong>c');
  });

  it('wraps a range spanning the second and third items of an ordered list in an ol with the start attribute', () => {
    const root = mountRoot('<ol start="5"><li>a</li><li>b</li><li>c</li></ol>');

    expect(wrapToHtml(rangeBetween(root, ['li + li', 0], ['li + li + li', 1]), root))
      .toBe('<ol start="5"><li>b</li><li>c</li></ol>');
  });

  it('wraps a range spanning two cells in the same row in table, tbody, and tr', () => {
    const root = mountRoot('<table><tbody><tr><td>ab</td><td>cd</td></tr></tbody></table>');

    expect(wrapToHtml(rangeBetween(root, ['td', 1], ['td + td', 1]), root))
      .toBe('<table><tbody><tr><td>b</td><td>c</td></tr></tbody></table>');
  });

  it('wraps a range spanning two rows in table and tbody', () => {
    const root = mountRoot('<table><tbody><tr><td>ab</td></tr><tr><td>cd</td></tr></tbody></table>');

    expect(wrapToHtml(rangeBetween(root, ['tr td', 1], ['tr + tr td', 1]), root))
      .toBe('<table><tbody><tr><td>b</td></tr><tr><td>c</td></tr></tbody></table>');
  });

  it('does not wrap a range inside one cell in table elements', () => {
    const root = mountRoot('<table><tbody><tr><td>abc</td></tr></tbody></table>');

    expect(wrapToHtml(rangeIn(root, 'td', 1, 2), root)).toBe('b');
  });

  it('wraps a range from the title of an open collapsible section to a body paragraph in a details with open', () => {
    const root = mountRoot('<details open=""><summary>Title</summary><p>Body</p></details>');

    expect(wrapToHtml(rangeBetween(root, ['summary', 2], ['p', 2]), root))
      .toBe('<details open=""><summary>tle</summary><p>Bo</p></details>');
  });

  it('wraps a range spanning two items of a nested list in the inner list only', () => {
    const root = mountRoot('<ul><li>a<ul><li>bc</li><li>de</li></ul></li></ul>');

    expect(wrapToHtml(rangeBetween(root, ['li li', 1], ['li li + li', 1]), root))
      .toBe('<ul><li>c</li><li>d</li></ul>');
  });

  it('wraps a range starting and ending at positions directly under a list in the list, not in inline elements', () => {
    const root = mountRoot('<ul><li>a</li><li>b</li><li>c</li></ul>');
    const list = readElement(root, 'ul');

    expect(wrapToHtml(createRange(list, 1, list, 3), root)).toBe('<ul><li>b</li><li>c</li></ul>');
  });

  it('after rewrapping, the fragment nodes remain the nodes the mapping resolves to', () => {
    const root = mountRoot('<table><tbody><tr><td>ab</td><td>cd</td></tr></tbody></table>');
    const range = rangeBetween(root, ['td', 1], ['td + td', 1]);
    const copied = cloneRangeFragment(range);

    wrapRangeFragment(copied, range, root);

    expect([...copied.liveToCopy.values()].map((copy) => copied.fragment.contains(copy)))
      .toEqual([true, true, true, true]);
  });
});
