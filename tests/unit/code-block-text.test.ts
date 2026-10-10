import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import {
  findEmptyCodeAt,
  findEmptyCodeBlock,
  insertTextIntoCodeBlock,
  placeRangeInEmptyCode,
} from '../../webview/editing/code-block-text';
import { createRange, mountRoot, readChildText, readElement } from './helpers/format-dom';

describe('empty code position', () => {
  it('in a pre with content outside code, returns the code for a caret inside the empty code', () => {
    const root = mountRoot('<pre>$ <code></code></pre>');
    const code = readElement(root, 'code');

    expect(findEmptyCodeAt(root, createRange(code, 0, code, 0))).toBe(code);
  });

  it('returns the code at positions inside pre touching it before or after with no content in between, and at the start of pre right after conversion', () => {
    const root = mountRoot('<pre>$ <code></code> tail</pre>\n<pre><code></code></pre>');
    const [spaced, converted] = [...root.querySelectorAll('pre')];
    const before = readChildText(spaced, 0);
    const after = readChildText(spaced, 2);
    const [spacedCode, convertedCode] = [...root.querySelectorAll('code')];

    expect([
      findEmptyCodeAt(root, createRange(before, 2, before, 2)),
      findEmptyCodeAt(root, createRange(after, 0, after, 0)),
      findEmptyCodeAt(root, createRange(converted, 0, converted, 0)),
    ]).toEqual([spacedCode, spacedCode, convertedCode]);
  });

  it('returns undefined when there is text between the caret and code, for code with content, and for a range selection', () => {
    const root = mountRoot('<pre>$ <code></code></pre>\n<pre><code>ab</code></pre>');
    const [spaced, filled] = [...root.querySelectorAll('pre')];
    const before = readChildText(spaced, 0);
    const text = readChildText(readElement(filled, 'code'), 0);
    const emptyCode = readElement(spaced, 'code');

    expect([
      findEmptyCodeAt(root, createRange(before, 1, before, 1)),
      findEmptyCodeAt(root, createRange(text, 1, text, 1)),
      findEmptyCodeAt(root, createRange(before, 2, emptyCode, 0)),
    ]).toEqual([undefined, undefined, undefined]);
  });

  it('at an empty code position, also returns a pre that has content outside code', () => {
    const root = mountRoot('<pre>$ <code></code></pre>');
    const code = readElement(root, 'code');

    expect(findEmptyCodeBlock(root, createRange(code, 0, code, 0))).toBe(readElement(root, 'pre'));
  });

  it('characters go into code even in a pre with content before code', () => {
    const root = mountRoot('<pre>$ <code></code></pre>');
    const pre = readElement(root, 'pre');
    const before = readChildText(pre, 0);
    const progress: BlockRewriteProgress = { changed: false };

    insertTextIntoCodeBlock(pre, createRange(before, 2, before, 2), 'x', progress);

    expect(root.innerHTML).toBe('<pre>$ <code>x</code></pre>');
  });

  it('the range moves into code even in a pre with content after code', () => {
    const root = mountRoot('<pre><code></code>\ntail</pre>');
    const pre = readElement(root, 'pre');
    const range = createRange(pre, 0, pre, 0);

    placeRangeInEmptyCode(root, range);

    expect([range.startContainer === readElement(root, 'code'), range.startOffset]).toEqual([true, 0]);
  });
});

describe('detecting an empty code block', () => {
  it('returns the pre when the caret is in a pre whose only child is a code with no children', () => {
    const root = mountRoot('<pre><code></code></pre>');
    // Right after a conversion the caret is placed outside the `code`, at the start of the `pre`.
    const pre = readElement(root, 'pre');

    const found = findEmptyCodeBlock(root, createRange(pre, 0, pre, 0));

    expect(found).toBe(pre);
  });

  it('returns nothing when the code has contents', () => {
    const root = mountRoot('<pre><code>ab</code></pre>');
    const text = readChildText(readElement(root, 'code'), 0);

    const found = findEmptyCodeBlock(root, createRange(text, 1, text, 1));

    expect(found).toBeUndefined();
  });

  it('returns nothing when the pre has a child other than the code directly beneath it', () => {
    const root = mountRoot('<pre>$ <code></code></pre>');
    const pre = readElement(root, 'pre');

    const found = findEmptyCodeBlock(root, createRange(pre, 0, pre, 0));

    expect(found).toBeUndefined();
  });

  it('returns nothing when a range is selected or the caret is outside the pre', () => {
    const root = mountRoot('<pre><code></code></pre>\n<p>ab</p>');
    const pre = readElement(root, 'pre');
    const outside = readChildText(readElement(root, 'p'), 0);

    expect([
      findEmptyCodeBlock(root, createRange(pre, 0, pre, 1)),
      findEmptyCodeBlock(root, createRange(outside, 0, outside, 0)),
    ]).toEqual([undefined, undefined]);
  });
});

describe('typing into an empty code block', () => {
  it('puts the typed characters inside the code and marks the progress as changed', () => {
    const root = mountRoot('<pre><code></code></pre>');
    const pre = readElement(root, 'pre');
    const progress: BlockRewriteProgress = { changed: false };

    insertTextIntoCodeBlock(pre, createRange(pre, 0, pre, 0), 'ab', progress);

    expect([root.innerHTML, progress.changed]).toEqual(['<pre><code>ab</code></pre>', true]);
  });

  it('puts both the caret and the range the input dispatcher carries around just after the inserted characters', () => {
    const root = mountRoot('<pre><code></code></pre>');
    const pre = readElement(root, 'pre');
    const range = createRange(pre, 0, pre, 0);
    const progress: BlockRewriteProgress = { changed: false };

    insertTextIntoCodeBlock(pre, range, 'ab', progress);

    const caret = window.getSelection();
    const code = readElement(root, 'code');
    // Just after the inserted characters is after that text, the sole child, which is the end of the `code`.
    expect([
      range.startContainer === code,
      range.startOffset,
      caret?.anchorNode === code,
      caret?.anchorOffset,
    ]).toEqual([true, code.childNodes.length, true, code.childNodes.length]);
  });
});

describe('moving the insertion point of a paste', () => {
  it('moves the range into the code for an empty code block and leaves it alone when the code has contents', () => {
    const root = mountRoot('<pre><code></code></pre>\n<pre><code>ab</code></pre>');
    const empty = readElement(root, 'pre:nth-of-type(1)');
    const filled = readChildText(readElement(root, 'pre:nth-of-type(2) code'), 0);
    const emptyRange = createRange(empty, 0, empty, 0);
    const filledRange = createRange(filled, 1, filled, 1);

    placeRangeInEmptyCode(root, emptyRange);
    placeRangeInEmptyCode(root, filledRange);

    expect([
      emptyRange.startContainer === readElement(root, 'pre:nth-of-type(1) code'),
      emptyRange.startOffset,
      filledRange.startContainer === filled,
      filledRange.startOffset,
    ]).toEqual([true, 0, true, 1]);
  });
});
