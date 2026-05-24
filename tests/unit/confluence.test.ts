import { describe, expect, it } from 'vitest';
import { toConfluenceHtml } from '../../webview/confluence';

describe('toConfluenceHtml', () => {
  it('rewrites <comment> to a labelled <blockquote>', () => {
    const out = toConfluenceHtml('<comment>note</comment>');
    expect(out).toBe('<blockquote><p><strong>Comment: </strong>note</p></blockquote>');
  });

  it('rewrites multiple <comment> elements', () => {
    const out = toConfluenceHtml('<comment>a</comment><p>x</p><comment>b</comment>');
    expect(out).toBe(
      '<blockquote><p><strong>Comment: </strong>a</p></blockquote>' +
        '<p>x</p>' +
        '<blockquote><p><strong>Comment: </strong>b</p></blockquote>',
    );
  });

  it('preserves inline children inside <comment>', () => {
    const out = toConfluenceHtml('<comment>a <strong>bold</strong> b</comment>');
    expect(out).toContain('<strong>Comment: </strong>a <strong>bold</strong> b');
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
