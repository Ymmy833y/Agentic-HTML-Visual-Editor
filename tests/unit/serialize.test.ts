import { afterEach, describe, expect, it } from 'vitest';
import { formatForSerialize } from '../../webview/serialize';
import { injectEmptyBlockPlaceholders } from '../../webview/placeholder';
import { clearDom, makeRoot } from './helpers/selection';

afterEach(() => {
  clearDom();
});

function format(html: string): string {
  return formatForSerialize(makeRoot(html));
}

// Helper for the round-trip simulation: parse a saved string, run the same
// mount-time placeholder injection the webview performs, then serialize.
function roundtrip(savedHtml: string): string {
  const root = makeRoot(savedHtml);
  injectEmptyBlockPlaceholders(root);
  return formatForSerialize(root);
}

describe('formatForSerialize: empty-block pruning', () => {
  it('strips a <br> placeholder from an empty <p>', () => {
    expect(format('<p>x</p><p><br></p>')).toBe('<p>x</p>\n<p></p>');
  });

  it('strips a <br> placeholder from an empty heading', () => {
    expect(format('<h2>A</h2><h2><br></h2>')).toBe('<h2>A</h2>\n<h2></h2>');
  });

  it('inserts a newline between non-empty heading siblings', () => {
    expect(format('<h2>A</h2><h2>B</h2>')).toBe('<h2>A</h2>\n<h2>B</h2>');
  });

  it('removes empty inline wrappers around the <br>', () => {
    expect(format('<p><strong><br></strong></p>')).toBe('<p></p>');
  });

  it('removes deeply nested empty inline wrappers', () => {
    expect(format('<p><strong><em><br></em></strong></p>')).toBe('<p></p>');
  });

  it('does not strip a <br> that sits among real text', () => {
    expect(format('<p>line one<br>line two</p>')).toBe('<p>line one<br>line two</p>');
  });

  it('treats an empty <div> the same way', () => {
    expect(format('<div><br></div>')).toBe('<div></div>');
  });
});

describe('formatForSerialize: preserves existing whitespace', () => {
  it('keeps a leading whitespace text node before the first block', () => {
    const root = document.createElement('div');
    root.append(document.createTextNode('\n  '));
    const p1 = document.createElement('p');
    p1.textContent = 'a';
    const p2 = document.createElement('p');
    p2.appendChild(document.createElement('br'));
    root.append(p1, document.createTextNode('\n  '), p2);
    document.body.replaceChildren(root);

    expect(formatForSerialize(root)).toBe('\n  <p>a</p>\n  <p></p>');
  });

  it('mirrors the existing inter-block indent when filling a missing gap', () => {
    // Equivalent of "<p>a</p><p><br></p>" with one indented gap already
    // present before <p>a</p>. The new gap between <p>a</p> and <p></p>
    // should copy the same "\n  " pattern.
    const root = document.createElement('div');
    root.append(document.createTextNode('\n  '));
    const p1 = document.createElement('p');
    p1.textContent = 'a';
    const p2 = document.createElement('p');
    const p3 = document.createElement('p');
    p3.appendChild(document.createElement('br'));
    p2.textContent = 'b';
    root.append(p1, document.createTextNode('\n  '), p2, p3);
    document.body.replaceChildren(root);

    expect(formatForSerialize(root)).toBe('\n  <p>a</p>\n  <p>b</p>\n  <p></p>');
  });

  it('falls back to a bare newline when the parent has no indent sample', () => {
    expect(format('<p>x</p><p><br></p>')).toBe('<p>x</p>\n<p></p>');
  });

  it('leaves a text-then-block adjacency alone (no whitespace injected)', () => {
    expect(format('<li>b<ul><li>c</li></ul></li>')).toBe(
      '<li>b<ul><li>c</li></ul></li>',
    );
  });
});

describe('formatForSerialize: nested formatting', () => {
  it('formats inside <blockquote>', () => {
    expect(format('<blockquote><p>q</p><p><br></p></blockquote>')).toBe(
      '<blockquote><p>q</p>\n<p></p></blockquote>',
    );
  });

  it('formats inside <ul> and prunes the trailing empty <li>', () => {
    expect(format('<ul><li>a</li><li><br></li></ul>')).toBe(
      '<ul><li>a</li>\n<li></li></ul>',
    );
  });
});

describe('formatForSerialize: opaque regions', () => {
  it('does not strip a <br> inside <pre>', () => {
    expect(format('<pre><br></pre>')).toBe('<pre><br></pre>');
  });

  it('preserves whitespace inside <pre><code>...</code></pre>', () => {
    const html = '<pre><code>foo\nbar\n</code></pre>';
    expect(format(html)).toBe(html);
  });

  it('leaves table internals untouched', () => {
    const html = '<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>';
    expect(format(html)).toBe(html);
  });

  it('still inserts a newline between a <table> and a sibling block', () => {
    const html = '<p>before</p><table><tbody><tr><td>x</td></tr></tbody></table><p>after</p>';
    expect(format(html)).toBe(
      '<p>before</p>\n<table><tbody><tr><td>x</td></tr></tbody></table>\n<p>after</p>',
    );
  });
});

describe('formatForSerialize: round-trip idempotency', () => {
  it('a saved file round-trips to itself (parse + inject + serialize)', () => {
    const saved = '<p>x</p>\n<p></p>\n<h2>y</h2>';
    expect(roundtrip(saved)).toBe(saved);
  });

  it('a saved file with custom indentation round-trips to itself', () => {
    const saved = '\n  <p>x</p>\n  <p></p>\n';
    expect(roundtrip(saved)).toBe(saved);
  });

  it('opening a file then re-saving (no edits) leaves indented HTML alone', () => {
    const saved = '\n  <h1>Title</h1>\n  <p>\n    body\n  </p>\n';
    expect(roundtrip(saved)).toBe(saved);
  });
});

describe('formatForSerialize: live DOM is untouched', () => {
  it('does not mutate the source root', () => {
    const root = makeRoot('<p>x</p><p><br></p>');
    const before = root.innerHTML;
    formatForSerialize(root);
    expect(root.innerHTML).toBe(before);
  });
});
