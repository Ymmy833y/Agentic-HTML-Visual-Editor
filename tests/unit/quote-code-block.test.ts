import { describe, expect, it } from 'vitest';

import { convertQuoteLines, planQuoteLines, splitQuoteLines } from '../../webview/editing/quote-code-block';
import type { QuoteLinePoints } from '../../webview/editing/quote-code-block';
import { createRange, mountRoot, readChildText, readElement } from './helpers/format-dom';

/**
 * Plans and converts the lines of the only blockquote in the editor root.
 *
 * @param html The contents of the editor root.
 * @param readRange Returns the selection range from the blockquote.
 * @returns The blockquote and where the ends of the selection go.
 */
function convert(
  html: string,
  readRange: (quote: Element) => Range,
): { quote: Element; points: QuoteLinePoints } {
  const root = mountRoot(html);
  const quote = readElement(root, 'blockquote');
  const points = convertQuoteLines(planQuoteLines(quote, readRange(quote)));
  return { quote, points };
}

/**
 * Returns a function that puts a collapsed range inside a text child of the blockquote.
 *
 * @param index The index of the text among the children of the blockquote.
 * @param offset The position within the text.
 * @returns The function that creates the range.
 */
function caretInText(index: number, offset: number): (quote: Element) => Range {
  return (quote) => {
    const text = readChildText(quote, index);
    return createRange(text, offset, text, offset);
  };
}

describe('converting the lines of a bare blockquote into a code block', () => {
  it('keeps the blockquote and makes the second of three lines a code block with the first and third as paragraphs', () => {
    const { quote } = convert('<blockquote>ab<br>cd<br>ef</blockquote>', caretInText(2, 1));

    expect(quote.outerHTML)
      .toBe('<blockquote><p>ab</p>\n<pre><code>cd</code></pre>\n<p>ef</p></blockquote>');
  });

  it('puts two lines before the code block into one paragraph that keeps the br between them', () => {
    const { quote } = convert('<blockquote>ab<br>cd<br>ef</blockquote>', caretInText(4, 1));

    expect(quote.innerHTML).toBe('<p>ab<br>cd</p>\n<pre><code>ef</code></pre>');
  });

  it('makes no paragraph before the first line or after the last line', () => {
    const first = convert('<blockquote>ab<br>cd</blockquote>', caretInText(0, 1)).quote.innerHTML;
    const last = convert('<blockquote>ab<br>cd</blockquote>', caretInText(2, 1)).quote.innerHTML;

    expect([first, last]).toEqual([
      '<pre><code>ab</code></pre>\n<p>cd</p>',
      '<p>ab</p>\n<pre><code>cd</code></pre>',
    ]);
  });

  it('joins the two lines a range covers with a newline character into one code block', () => {
    const { quote } = convert(
      '<blockquote>ab<br>cd<br>ef</blockquote>',
      (element) => createRange(readChildText(element, 0), 1, readChildText(element, 2), 1),
    );

    expect(quote.innerHTML).toBe('<pre><code>ab\ncd</code></pre>\n<p>ef</p>');
  });

  it('does not split a line at a br inside a format element, and moves the format element into the code block whole', () => {
    const { quote } = convert('<blockquote>a<strong>b<br>c</strong>d<br>ef</blockquote>', caretInText(2, 1));

    expect(quote.innerHTML).toBe('<pre><code>a<strong>b\nc</strong>d</code></pre>\n<p>ef</p>');
  });

  it('does not split a comment, and keeps the br inside its body rather than turning it into a newline character', () => {
    const comment = '<comment id="c-a1b2c3d4">cd<comment-body contenteditable="false">x<br>y</comment-body></comment>';
    const { quote } = convert(`<blockquote>ab${comment}<br>ef</blockquote>`, caretInText(0, 1));

    expect(quote.innerHTML).toBe(`<pre><code>ab${comment}</code></pre>\n<p>ef</p>`);
  });

  it('makes a code block with no content from an empty line and puts the ends at the start of its pre', () => {
    const { quote, points } = convert(
      '<blockquote>ab<br><br>cd</blockquote>',
      (element) => createRange(element, 2, element, 2),
    );
    const pre = readElement(quote, 'pre');

    expect([quote.innerHTML, points.start?.node === pre, points.start?.offset, points.end === points.start])
      .toEqual(['<p>ab</p>\n<pre><code></code></pre>\n<p>cd</p>', true, 0, true]);
  });

  it('keeps an empty line before the code block showing by leaving a br at the end of the paragraph', () => {
    const { quote } = convert('<blockquote>ab<br><br>cd</blockquote>', caretInText(3, 1));

    expect(quote.innerHTML).toBe('<p>ab<br><br></p>\n<pre><code>cd</code></pre>');
  });

  it('does not turn the trailing br of the blockquote into a newline character, leaving no newline at the end of the code block', () => {
    const { quote } = convert('<blockquote>ab<br></blockquote>', caretInText(0, 1));

    expect(quote.innerHTML).toBe('<pre><code>ab</code></pre>');
  });

  it('keeps data-alert on the blockquote and gives the new paragraph and code block no attributes', () => {
    const { quote } = convert('<blockquote data-alert="note">ab<br>cd</blockquote>', caretInText(2, 1));

    expect(quote.outerHTML)
      .toBe('<blockquote data-alert="note"><p>ab</p>\n<pre><code>cd</code></pre></blockquote>');
  });

  it('points a caret that was partway through a text at the same character after the conversion', () => {
    const { quote, points } = convert('<blockquote>ab<br>cdef</blockquote>', caretInText(2, 2));
    const text = readChildText(readElement(quote, 'code'), 0);

    expect([points.start?.node === text, points.start?.offset, points.end === points.start])
      .toEqual([true, 2, true]);
  });

  it('puts a caret from the end of the annotated text after the comment rather than inside its body', () => {
    const comment = '<comment id="c-a1b2c3d4">d<comment-body contenteditable="false">x</comment-body></comment>';
    const { quote, points } = convert(
      `<blockquote>ab<br>c${comment}e</blockquote>`,
      (element) => {
        const text = readChildText(readElement(element, 'comment'), 0);
        return createRange(text, 1, text, 1);
      },
    );
    const after = readChildText(readElement(quote, 'code'), 2);

    expect([points.start?.node === after, points.start?.offset]).toEqual([true, 0]);
  });
});

/**
 * Plans and splits the lines of the only blockquote in the editor root into paragraphs.
 *
 * @param html The contents of the editor root.
 * @param readRange Returns the selection range from the blockquote.
 * @returns The blockquote and where the ends of the selection go.
 */
function split(
  html: string,
  readRange: (quote: Element) => Range,
): { quote: Element; points: QuoteLinePoints } {
  const root = mountRoot(html);
  const quote = readElement(root, 'blockquote');
  const points = splitQuoteLines(planQuoteLines(quote, readRange(quote)));
  return { quote, points };
}

describe('splitting the lines of a bare blockquote into paragraphs', () => {
  it('keeps the blockquote and makes the second of three lines a paragraph of its own between the first and the third', () => {
    const { quote } = split('<blockquote>ab<br>cd<br>ef</blockquote>', caretInText(2, 1));

    expect(quote.outerHTML).toBe('<blockquote><p>ab</p>\n<p>cd</p>\n<p>ef</p></blockquote>');
  });

  it('keeps the br between the lines before and after the covered line in one paragraph each', () => {
    const { quote } = split('<blockquote>ab<br>cd<br>ef<br>gh<br>ij</blockquote>', caretInText(4, 1));

    expect(quote.innerHTML).toBe('<p>ab<br>cd</p>\n<p>ef</p>\n<p>gh<br>ij</p>');
  });

  it('makes each line a range covers a paragraph of its own and keeps the range over the same string', () => {
    const { quote, points } = split(
      '<blockquote>ab<br>cd<br>ef</blockquote>',
      (element) => createRange(readChildText(element, 0), 1, readChildText(element, 2), 1),
    );
    const range = document.createRange();
    range.setStart(points.start?.node ?? quote, points.start?.offset ?? 0);
    range.setEnd(points.end?.node ?? quote, points.end?.offset ?? 0);

    expect([quote.innerHTML, range.toString()]).toEqual(['<p>ab</p>\n<p>cd</p>\n<p>ef</p>', 'b\nc']);
  });

  it('gives an empty covered line a placeholder br and puts the caret in front of it', () => {
    const { quote, points } = split(
      '<blockquote>ab<br><br>cd</blockquote>',
      (element) => createRange(element, 2, element, 2),
    );
    const empty = quote.children[1];

    expect([quote.innerHTML, points.start?.node === empty, points.start?.offset, points.end === points.start])
      .toEqual(['<p>ab</p>\n<p><br></p>\n<p>cd</p>', true, 0, true]);
  });

  it('uses the trailing br as the placeholder of an empty last line', () => {
    const { quote } = split(
      '<blockquote>ab<br><br></blockquote>',
      (element) => createRange(element, 2, element, 2),
    );

    expect(quote.innerHTML).toBe('<p>ab</p>\n<p><br></p>');
  });

  it('keeps data-alert on the blockquote and gives the new paragraphs no attributes', () => {
    const { quote } = split('<blockquote data-alert="note">ab<br>cd</blockquote>', caretInText(0, 1));

    expect(quote.outerHTML).toBe('<blockquote data-alert="note"><p>ab</p>\n<p>cd</p></blockquote>');
  });

  it('points a caret that was partway through a line at the same character in its paragraph', () => {
    const { quote, points } = split('<blockquote>ab<br>cdef</blockquote>', caretInText(2, 2));
    const text = readChildText(quote.children[1], 0);

    expect([points.start?.node === text, points.start?.offset, points.end === points.start])
      .toEqual([true, 2, true]);
  });

  it('leaves out the end of a range that lies after the blockquote', () => {
    const root = mountRoot('<blockquote>ab<br>cd</blockquote><p>ef</p>');
    const quote = readElement(root, 'blockquote');
    const range = createRange(readChildText(quote, 2), 1, readChildText(readElement(root, 'p'), 0), 1);

    const points = splitQuoteLines(planQuoteLines(quote, range));

    expect([quote.innerHTML, points.start?.offset, points.end]).toEqual(['<p>ab</p>\n<p>cd</p>', 1, undefined]);
  });
});
