import { describe, expect, it } from 'vitest';

import { normalizeFormatElements } from '../../webview/editing/inline-normalize';
import { createRoot, readElement } from './helpers/format-dom';

describe('format element normalization', () => {
  it('removes an empty format element that has no attributes', () => {
    const root = createRoot('<p>a<strong></strong>b</p>');

    normalizeFormatElements([readElement(root, 'p')]);

    expect(root.innerHTML).toBe('<p>ab</p>');
  });

  it('keeps an empty format element that has an attribute', () => {
    const root = createRoot('<p><a href="x.html"></a></p>');

    normalizeFormatElements([readElement(root, 'p')]);

    expect(root.innerHTML).toBe('<p><a href="x.html"></a></p>');
  });

  it('merges adjacent format elements with the same name and the same attributes into one', () => {
    const root = createRoot('<p><strong>a</strong><strong>b</strong></p>');

    normalizeFormatElements([readElement(root, 'p')]);

    expect(root.innerHTML).toBe('<p><strong>ab</strong></p>');
  });

  it('removes the inner element from a direct nesting of the same element name', () => {
    const root = createRoot('<p><strong>a<strong>b</strong></strong></p>');

    normalizeFormatElements([readElement(root, 'p')]);

    expect(root.innerHTML).toBe('<p><strong>ab</strong></p>');
  });

  it('does not merge an adjacent b and strong, and does not change either spelling', () => {
    const root = createRoot('<p><b>a</b><strong>b</strong></p>');

    normalizeFormatElements([readElement(root, 'p')]);

    expect(root.innerHTML).toBe('<p><b>a</b><strong>b</strong></p>');
  });

  it('does not merge adjacent elements with the same name but different attributes', () => {
    const root = createRoot('<p><a href="x.html">a</a><a href="y.html">b</a></p>');

    normalizeFormatElements([readElement(root, 'p')]);

    expect(root.innerHTML).toBe('<p><a href="x.html">a</a><a href="y.html">b</a></p>');
  });

  it('fixes a violation that was in the block before the operation by the same rules', () => {
    const root = createRoot('<p>ab<em>c</em><em>d</em></p>');

    normalizeFormatElements([readElement(root, 'p')]);

    expect(root.innerHTML).toBe('<p>ab<em>cd</em></p>');
  });

  it('leaves an empty format element inside a pre or a comment annotation body in place', () => {
    const body = '<blockquote>a<pre><code></code></pre>'
      + '<comment id="c1">b<comment-body><strong></strong></comment-body></comment></blockquote>';
    const root = createRoot(body);

    normalizeFormatElements([readElement(root, 'blockquote')]);

    expect(root.innerHTML).toBe(body);
  });

  it('leaves a violation inside a block that was not passed in as it is', () => {
    const root = createRoot(
      '<p><strong>a</strong><strong>b</strong></p><p><strong>c</strong><strong>d</strong></p>',
    );
    const [first] = [...root.querySelectorAll('p')];
    if (first === undefined) {
      throw new Error('paragraph not found');
    }

    normalizeFormatElements([first]);

    expect(root.innerHTML)
      .toBe('<p><strong>ab</strong></p><p><strong>c</strong><strong>d</strong></p>');
  });
});
