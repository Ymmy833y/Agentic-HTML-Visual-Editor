import { describe, expect, it } from 'vitest';

import { findTrailingPreBreak, isAtBlockEnd, isAtBlockStart } from '../../webview/editing/caret';
import { createRange, createRoot, readChildText, readElement } from './helpers/format-dom';

/**
 * Creates a range collapsed at a position within a text.
 *
 * @param text The text.
 * @param offset The position within the text.
 * @returns A collapsed range.
 */
function caretAt(text: Text, offset: number): Range {
  return createRange(text, offset, text, offset);
}

describe('block edges inside pre', () => {
  it('inside pre, the position after a leading line break of code and after the indentation of the first line are not the start', () => {
    const newline = createRoot('<pre><code>\nabc</code></pre>');
    const indent = createRoot('<pre><code>  abc</code></pre>');
    const newlineText = readChildText(readElement(newline, 'code'), 0);
    const indentText = readChildText(readElement(indent, 'code'), 0);

    expect([
      isAtBlockStart(caretAt(newlineText, 1), readElement(newline, 'pre')),
      isAtBlockStart(caretAt(indentText, 2), readElement(indent, 'pre')),
    ]).toEqual([false, false]);
  });

  it('inside pre, the position before a line break that forms a blank line is not the end', () => {
    const root = createRoot('<pre><code>abc\n\n</code></pre>');
    const text = readChildText(readElement(root, 'code'), 0);

    expect(isAtBlockEnd(caretAt(text, 3), readElement(root, 'pre'))).toBe(false);
  });

  it('inside pre, the position before the trailing pre break is judged the end', () => {
    const root = createRoot('<pre><code>abc\n</code></pre>');
    const text = readChildText(readElement(root, 'code'), 0);

    expect(isAtBlockEnd(caretAt(text, 3), readElement(root, 'pre'))).toBe(true);
  });

  it('the start of code is judged the start, and the end of code without a line break is judged the end', () => {
    const root = createRoot('<pre><code>abc</code></pre>');
    const pre = readElement(root, 'pre');
    const text = readChildText(readElement(root, 'code'), 0);

    expect([isAtBlockStart(caretAt(text, 0), pre), isAtBlockEnd(caretAt(text, 3), pre)]).toEqual([true, true]);
  });

  it('in a paragraph outside pre, the position after whitespace-only text is also judged the start', () => {
    const root = createRoot('<p>  abc</p>');
    const text = readChildText(readElement(root, 'p'), 0);

    expect(isAtBlockStart(caretAt(text, 2), readElement(root, 'p'))).toBe(true);
  });

  it('returns both the last line break inside code and the one after code, and undefined if the last character is not a line break', () => {
    const inside = createRoot('<pre><code>ab\n</code></pre>');
    const outside = createRoot('<pre><code>ab</code>\n</pre>');
    const none = createRoot('<pre><code>ab\n</code>c</pre>');
    const insideText = readChildText(readElement(inside, 'code'), 0);
    const outsideText = readChildText(readElement(outside, 'pre'), 1);

    const found = [inside, outside, none].map((root) => findTrailingPreBreak(readElement(root, 'pre')));

    expect(found).toEqual([
      { text: insideText, offset: 2 },
      { text: outsideText, offset: 0 },
      undefined,
    ]);
  });
});

describe('checking the end of a block', () => {
  it('treats a caret right before the given boundary child as at the end', () => {
    const root = createRoot('<ul><li>ab<ul><li>c</li></ul></li></ul>');
    const item = readElement(root, 'li');
    const text = readChildText(item, 0);

    expect(isAtBlockEnd(createRange(text, 2, text, 2), item, readElement(item, 'ul'))).toBe(true);
  });

  it('does not treat a position followed by a block child as at the end when the boundary is omitted, as before', () => {
    const root = createRoot('<ul><li>ab<ul><li>c</li></ul></li></ul>');
    const item = readElement(root, 'li');
    const text = readChildText(item, 0);

    expect(isAtBlockEnd(createRange(text, 2, text, 2), item)).toBe(false);
  });
});
