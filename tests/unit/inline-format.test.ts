import { describe, expect, it } from 'vitest';

import { collectFormatSegments } from '../../webview/editing/format-segment';
import { readFormatState } from '../../webview/editing/format-state';
import type { FormatState } from '../../webview/editing/format-state';
import {
  CREATED_FORMAT_TAG_NAME,
  FORMAT_TAG_NAMES,
  INLINE_FORMAT,
  isFormatElement,
  isFormattingExcluded,
} from '../../webview/editing/inline-format';
import { createRange, createRoot, readChildText, readElement } from './helpers/format-dom';

// A state in which no format is formatted.
const NO_FORMAT: FormatState = {
  bold: false,
  italic: false,
  strikethrough: false,
  inlineCode: false,
  link: false,
};

// The five formats, used to cross-check the identifiers, the spellings read as a format, and the
// spellings that are created.
const FORMAT_NAMES = ['bold', 'italic', 'strikethrough', 'inlineCode', 'link'];

describe('format element spellings', () => {
  it('holds strong and b as the same format for bold, and em and i for italic', () => {
    expect([
      [...FORMAT_TAG_NAMES[INLINE_FORMAT.bold]],
      [...FORMAT_TAG_NAMES[INLINE_FORMAT.italic]],
    ]).toEqual([['strong', 'b'], ['em', 'i']]);
  });

  it('does not treat a code directly inside a pre as an inline code format element', () => {
    const root = createRoot('<pre><code>a</code></pre><p><code>b</code></p>');

    expect([
      isFormatElement(readElement(root, 'pre code'), INLINE_FORMAT.inlineCode),
      isFormatElement(readElement(root, 'p code'), INLINE_FORMAT.inlineCode),
    ]).toEqual([false, true]);
  });

  it('covers the same five formats across the identifiers, the spellings read, and the spellings created', () => {
    expect([
      Object.values(INLINE_FORMAT),
      Object.keys(FORMAT_TAG_NAMES),
      Object.keys(CREATED_FORMAT_TAG_NAME),
    ]).toEqual([FORMAT_NAMES, FORMAT_NAMES, FORMAT_NAMES]);
  });
});

describe('reading the format state', () => {
  it('reports bold as formatted when every format segment lies inside a b', () => {
    const root = createRoot('<p><b>abc</b></p>');
    const text = readChildText(readElement(root, 'b'), 0);
    const segments = collectFormatSegments(root, createRange(text, 0, text, 3));

    expect(readFormatState({ kind: 'segments', segments }).bold).toBe(true);
  });

  it('does not report a format as formatted when even one character of the target text lies outside it', () => {
    const root = createRoot('<p><strong>ab</strong>c</p>');
    const inside = readChildText(readElement(root, 'strong'), 0);
    const outside = readChildText(readElement(root, 'p'), 1);
    const segments = collectFormatSegments(root, createRange(inside, 0, outside, 1));

    expect(readFormatState({ kind: 'segments', segments }).bold).toBe(false);
  });

  it('reports a format as formatted for a bare caret when an ancestor is a format element', () => {
    const root = createRoot('<p><em>ab</em></p>');
    const text = readChildText(readElement(root, 'em'), 0);

    expect(readFormatState({ kind: 'caret', caret: createRange(text, 1, text, 1) }).italic)
      .toBe(true);
  });

  it('reports none of the five formats as formatted when there is no target', () => {
    expect(readFormatState({ kind: 'none' })).toEqual(NO_FORMAT);
  });

  it('reports none of the five formats as formatted for a whitespace-only target', () => {
    const root = createRoot('<p><strong>a</strong> <strong>b</strong></p>');
    const space = readChildText(readElement(root, 'p'), 1);
    const segments = collectFormatSegments(root, createRange(space, 0, space, 1));

    expect(readFormatState({ kind: 'segments', segments })).toEqual(NO_FORMAT);
  });

  it('treats the link as formatted and bold as not formatted for a format segment of only an image inside a link', () => {
    // Placed inside bold, so that counting the image for the four other formats too would make bold formatted.
    const root = createRoot('<p><strong><a href="a.html"><img src="a.png"></a></strong></p>');
    const link = readElement(root, 'a');
    const segments = collectFormatSegments(root, createRange(link, 0, link, 1), true);

    const state = readFormatState({ kind: 'segments', segments });

    expect([state.link, state.bold]).toEqual([true, false]);
  });

  it('treats the link as not formatted for a format segment holding text inside a link and an image outside it', () => {
    const root = createRoot('<p><a href="a.html">ab</a><img src="a.png"></p>');
    const paragraph = readElement(root, 'p');
    const segments = collectFormatSegments(root, createRange(paragraph, 0, paragraph, 2), true);

    expect(readFormatState({ kind: 'segments', segments }).link).toBe(false);
  });
});

describe('exclusion from format targets', () => {
  it('returns true inside a closed details body, and false inside its title and inside an open body', () => {
    const root = createRoot(
      '<details><summary>t</summary><p id="closed">x</p></details>'
      + '<details open=""><summary>u</summary><p id="opened">y</p></details>',
    );
    const judge = (selector: string): boolean =>
      isFormattingExcluded(readChildText(readElement(root, selector), 0), root);

    expect(['#closed', 'summary', '#opened'].map(judge)).toEqual([true, false, false]);
  });
});
