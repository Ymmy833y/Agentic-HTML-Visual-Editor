import { describe, expect, it } from 'vitest';

import { convertBlock } from '../../webview/editing/block-convert';
import { BLOCK_KIND } from '../../webview/editing/block-format';
import { createRoot, readElement } from './helpers/format-dom';

describe('block conversion', () => {
  it('moves the children by reference and carries over every attribute when a paragraph becomes a heading', () => {
    const root = createRoot('<p id="x" style="color: red" data-alert="note">a<strong>b</strong></p>');
    const moved = readElement(root, 'strong');

    const created = convertBlock(readElement(root, 'p'), BLOCK_KIND.heading2);

    expect([root.innerHTML, created?.querySelector('strong') === moved]).toEqual([
      '<h2 id="x" style="color: red" data-alert="note">a<strong>b</strong></h2>',
      true,
    ]);
  });

  it('makes a bare blockquote without creating a paragraph inside when converting to a quote', () => {
    const root = createRoot('<p>ab</p>');

    convertBlock(readElement(root, 'p'), BLOCK_KIND.quote);

    expect(root.innerHTML).toBe('<blockquote>ab</blockquote>');
  });

  it('neither splits the annotation nor duplicates its id when converting a paragraph holding a comment annotation', () => {
    const root = createRoot('<p>a<comment id="c1">bc</comment>d</p>');
    const comment = readElement(root, 'comment');

    convertBlock(readElement(root, 'p'), BLOCK_KIND.heading3);

    expect([
      root.querySelectorAll('comment').length,
      root.querySelector('comment') === comment,
    ]).toEqual([1, true]);
  });

  it('puts a single code directly beneath the pre and turns br into newline characters when converting to a code block', () => {
    const root = createRoot('<p>ab<br>cd</p>');

    convertBlock(readElement(root, 'p'), BLOCK_KIND.codeBlock);

    expect(root.innerHTML).toBe('<pre><code>ab\ncd</code></pre>');
  });

  it('does not turn a br inside the body of a comment annotation into a newline character', () => {
    const body = '<comment-body contenteditable="false" data-author="ai">x<br>y</comment-body>';
    const root = createRoot(`<p>a<comment id="c1">b${body}</comment>c<br>d</p>`);

    convertBlock(readElement(root, 'p'), BLOCK_KIND.codeBlock);

    expect(root.innerHTML).toBe(`<pre><code>a<comment id="c1">b${body}</comment>c\nd</code></pre>`);
  });

  it('turns newline characters into br and keeps the format elements and links when going back from a code block to a paragraph', () => {
    const root = createRoot('<pre><code>ab\n<strong>cd</strong>\n<a href="x.html">ef</a></code></pre>');

    convertBlock(readElement(root, 'pre'), BLOCK_KIND.paragraph);

    expect(root.innerHTML).toBe('<p>ab<br><strong>cd</strong><br><a href="x.html">ef</a></p>');
  });

  it('keeps the code as an element and loses no text outside it when converting from a code block with content outside the code', () => {
    const root = createRoot('<pre>$ <code>npm test</code></pre>');

    convertBlock(readElement(root, 'pre'), BLOCK_KIND.paragraph);

    expect(root.innerHTML).toBe('<p>$ <code>npm test</code></p>');
  });

  it('carries over the attributes of the pre but not those of the code when leaving a code block', () => {
    const root = createRoot('<pre id="x"><code class="language-js">ab</code></pre>');

    convertBlock(readElement(root, 'pre'), BLOCK_KIND.paragraph);

    expect(root.innerHTML).toBe('<p id="x">ab</p>');
  });

  it('removes a trailing br rather than turning it into a newline character when converting to a code block', () => {
    const root = createRoot('<p>ab<br></p>');

    convertBlock(readElement(root, 'p'), BLOCK_KIND.codeBlock);

    expect(root.innerHTML).toBe('<pre><code>ab</code></pre>');
  });

  it('leaves the text empty with no placeholder when converting an empty block to a code block', () => {
    const root = createRoot('<p><br></p>');

    const created = convertBlock(readElement(root, 'p'), BLOCK_KIND.codeBlock);

    expect([root.innerHTML, created?.textContent]).toEqual(['<pre><code></code></pre>', '']);
  });

  it('adds a placeholder that keeps the height of the line when going back from an empty code block to a paragraph', () => {
    const root = createRoot('<pre><code></code></pre>');

    convertBlock(readElement(root, 'pre'), BLOCK_KIND.paragraph);

    expect(root.innerHTML).toBe('<p><br></p>');
  });

  it('moves the raw newlines and runs of whitespace in the text across without normalizing them', () => {
    const root = createRoot('<p>ab\n  cd</p>');

    convertBlock(readElement(root, 'p'), BLOCK_KIND.codeBlock);

    expect(root.innerHTML).toBe('<pre><code>ab\n  cd</code></pre>');
  });

  it('changes nothing and reports no rewrite when the kind already matches the target kind', () => {
    const root = createRoot('<h2>ab</h2>');

    const created = convertBlock(readElement(root, 'h2'), BLOCK_KIND.heading2);

    expect([created, root.innerHTML]).toEqual([undefined, '<h2>ab</h2>']);
  });

  it('does not rewrite a target block that is not convertible', () => {
    const html = '<ul><li>a</li></ul><table><tbody><tr><td>b</td></tr></tbody></table>'
      + '<details><summary>c</summary></details>';
    const root = createRoot(html);

    const created = [
      convertBlock(readElement(root, 'li'), BLOCK_KIND.heading2),
      convertBlock(readElement(root, 'td'), BLOCK_KIND.heading2),
      convertBlock(readElement(root, 'summary'), BLOCK_KIND.heading2),
    ];

    expect([created, root.innerHTML]).toEqual([[undefined, undefined, undefined], html]);
  });

  it('leaves the surrounding whitespace and line breaks unchanged when converting between headings', () => {
    const root = createRoot('\n<p>ab</p>\n<h2>cd</h2>\n<p>ef</p>\n');

    convertBlock(readElement(root, 'h2'), BLOCK_KIND.heading3);

    expect(root.innerHTML).toBe('\n<p>ab</p>\n<h3>cd</h3>\n<p>ef</p>\n');
  });
});
