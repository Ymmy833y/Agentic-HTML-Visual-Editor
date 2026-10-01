import { describe, expect, it } from 'vitest';

import {
  BLOCK_KIND,
  BLOCK_KIND_TAG_NAME,
  isConvertibleBlock,
  readBlockKind,
} from '../../webview/editing/block-format';
import { createRoot, readElement } from './helpers/format-dom';

/**
 * Builds an editor root and reads the kind of an element inside it.
 *
 * @param html The contents of the editor root.
 * @param selector The CSS selector that finds the target block.
 * @returns The block kind that was read.
 */
function readKindOf(html: string, selector: string): string | undefined {
  return readBlockKind(readElement(createRoot(html), selector));
}

describe('reading the current block kind', () => {
  it('gives paragraph, headings, quote, code block, and div the kind their tag name says', () => {
    const kinds = [
      readKindOf('<p>a</p>', 'p'),
      readKindOf('<h1>a</h1>', 'h1'),
      readKindOf('<h2>a</h2>', 'h2'),
      readKindOf('<h3>a</h3>', 'h3'),
      readKindOf('<h4>a</h4>', 'h4'),
      readKindOf('<h5>a</h5>', 'h5'),
      readKindOf('<h6>a</h6>', 'h6'),
      readKindOf('<blockquote>a</blockquote>', 'blockquote'),
      readKindOf('<pre><code>a</code></pre>', 'pre'),
      readKindOf('<div>a</div>', 'div'),
    ];

    expect(kinds).toEqual([
      BLOCK_KIND.paragraph,
      BLOCK_KIND.heading1,
      BLOCK_KIND.heading2,
      BLOCK_KIND.heading3,
      BLOCK_KIND.heading4,
      BLOCK_KIND.heading5,
      BLOCK_KIND.heading6,
      BLOCK_KIND.quote,
      BLOCK_KIND.codeBlock,
      BLOCK_KIND.div,
    ]);
  });

  it('gives a list item, a cell, a summary, and a details no kind', () => {
    const kinds = [
      readKindOf('<ul><li>a</li></ul>', 'li'),
      readKindOf('<table><tbody><tr><td>a</td></tr></tbody></table>', 'td'),
      readKindOf('<details><summary>a</summary></details>', 'summary'),
      readKindOf('<details><summary>a</summary></details>', 'details'),
    ];

    expect(kinds).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('gives no kind when no target is passed', () => {
    expect(readBlockKind(undefined)).toBeUndefined();
  });

  it('decides the kind by the target block\'s own tag name even inside a quote, details, list item, or cell', () => {
    const kinds = [
      readKindOf('<blockquote><p>a</p></blockquote>', 'p'),
      readKindOf('<details><summary>a</summary><p>b</p></details>', 'p'),
      readKindOf('<ul><li><p>a</p></li></ul>', 'p'),
      readKindOf('<table><tbody><tr><td><p>a</p></td></tr></tbody></table>', 'p'),
    ];

    expect(kinds).toEqual([
      BLOCK_KIND.paragraph,
      BLOCK_KIND.paragraph,
      BLOCK_KIND.paragraph,
      BLOCK_KIND.paragraph,
    ]);
  });

  it('does not treat a quote with a paragraph child as a convertible block', () => {
    const root = createRoot('<blockquote>a<p>b</p></blockquote>');

    const quote = readElement(root, 'blockquote');

    expect([readBlockKind(quote), isConvertibleBlock(quote)]).toEqual([BLOCK_KIND.quote, false]);
  });

  it('treats a code block whose only child is a single code as a convertible block', () => {
    const root = createRoot('<pre><code>a</code></pre>');

    expect(isConvertibleBlock(readElement(root, 'pre'))).toBe(true);
  });

  it('does not treat a paragraph that is an item line as convertible, but treats a paragraph after the own content as convertible', () => {
    const root = createRoot('<ul><li><p id="line">a</p></li><li>b<p id="child">c</p></li></ul>');

    expect([isConvertibleBlock(readElement(root, '#line')), isConvertibleBlock(readElement(root, '#child'))])
      .toEqual([false, true]);
  });

  it('treats a paragraph whose only children are a comment annotation and an unknown element as convertible', () => {
    const root = createRoot('<p>a<comment id="c1">b</comment><x-unknown>c</x-unknown></p>');

    expect(isConvertibleBlock(readElement(root, 'p'))).toBe(true);
  });

  it('covers the same ten kinds one to one across the identifiers and the tag names', () => {
    const kinds = Object.values(BLOCK_KIND);
    const tagNames = kinds.map((kind) => BLOCK_KIND_TAG_NAME[kind]);

    expect([Object.keys(BLOCK_KIND_TAG_NAME).sort(), tagNames]).toEqual([
      [...kinds].sort(),
      ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'div'],
    ]);
  });
});
