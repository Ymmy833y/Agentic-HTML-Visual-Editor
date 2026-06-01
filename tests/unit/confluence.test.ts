import { describe, expect, it } from 'vitest';
import { toConfluenceHtml } from '../../webview/features/clipboard/confluence';

describe('toConfluenceHtml', () => {
  it('strips <comment-body> and <comment-reply> children and unwraps <comment>', () => {
    const out = toConfluenceHtml(
      '<p>x <comment id="c1">target<comment-body>note</comment-body><comment-reply>r</comment-reply></comment> y</p>',
    );
    expect(out).toBe('<p>x target y</p>');
  });

  it('strips multiple <comment> annotations independently', () => {
    const out = toConfluenceHtml(
      '<p><comment id="c1">a<comment-body>na</comment-body></comment></p>' +
        '<p>x</p>' +
        '<p><comment id="c2">b<comment-body>nb</comment-body></comment></p>',
    );
    expect(out).toBe('<p>a</p><p>x</p><p>b</p>');
  });

  it('preserves inline element children of <comment> when unwrapping', () => {
    const out = toConfluenceHtml(
      '<p><comment id="c1">a <strong>bold</strong> b<comment-body>note</comment-body></comment></p>',
    );
    expect(out).toBe('<p>a <strong>bold</strong> b</p>');
  });

  it('adds border="1" to <table> elements that lack it', () => {
    const out = toConfluenceHtml('<table><tbody><tr><td>x</td></tr></tbody></table>');
    expect(out).toContain('border="1"');
  });

  it('preserves an existing border attribute on <table>', () => {
    const out = toConfluenceHtml('<table border="3"><tbody><tr><td>x</td></tr></tbody></table>');
    expect(out).toContain('border="3"');
    expect(out).not.toContain('border="1"');
  });

  it('wraps <pre> contents in <code> when missing', () => {
    const out = toConfluenceHtml('<pre>line1\nline2</pre>');
    expect(out).toBe('<pre><code>line1\nline2</code></pre>');
  });

  it('does not double-wrap when <pre> already contains a single <code>', () => {
    const out = toConfluenceHtml('<pre><code>line</code></pre>');
    expect(out).toBe('<pre><code>line</code></pre>');
  });

  it('wraps when <pre> has mixed children (code + extra)', () => {
    const out = toConfluenceHtml('<pre><code>a</code><span>b</span></pre>');
    expect(out).toBe('<pre><code><code>a</code><span>b</span></code></pre>');
  });

  it('leaves unrelated content untouched', () => {
    const html = '<h1>Title</h1><p>body</p><ul><li>item</li></ul>';
    expect(toConfluenceHtml(html)).toBe(html);
  });
});
