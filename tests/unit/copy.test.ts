import { afterEach, describe, expect, it } from 'vitest';
import { prepareCopy } from '../../webview/features/clipboard/copy';
import { mountMermaidSource, setMermaidSvg } from '../../webview/features/mermaid/mermaid-dom';
import { clearDom, makeRoot, selectContents, selectTextRange } from './helpers/selection';

afterEach(clearDom);

describe('prepareCopy', () => {
  it('copies Mermaid source without generated preview markup', () => {
    const html = '<pre class="mermaid">graph TD\nA--&gt;B</pre>';
    const root = makeRoot(html);
    const block = mountMermaidSource(root.querySelector('pre')!);
    setMermaidSvg(block, '<svg><text>A to B</text></svg>');
    window.getSelection()?.removeAllRanges();

    expect(prepareCopy(root)).toBe(html);
  });

  it('returns the full root innerHTML when nothing is selected', () => {
    const root = makeRoot('<p>hello</p><p>world</p>');
    window.getSelection()?.removeAllRanges();
    expect(prepareCopy(root)).toBe('<p>hello</p><p>world</p>');
  });

  it('preserves alert metadata in an HTML copy', () => {
    const root = makeRoot('<blockquote data-alert="important">Read this</blockquote>');
    window.getSelection()?.removeAllRanges();
    expect(prepareCopy(root)).toBe(
      '<blockquote data-alert="important">Read this</blockquote>',
    );
  });

  it('returns the full root innerHTML when the selection is collapsed', () => {
    const root = makeRoot('<p>hello</p>');
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(root.firstChild!, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    expect(prepareCopy(root)).toBe('<p>hello</p>');
  });

  it('returns only the selected fragment when a range is active', () => {
    const root = makeRoot('<p>hello</p><p>world</p>');
    selectContents(root.children[1]);
    const out = prepareCopy(root);
    expect(out).toBe('world');
  });

  it('drops an empty heading cloned only because the selection ends at its leading edge', () => {
    const root = makeRoot(
      '<p>This is sample text.</p>\n<h3>Level 3 heading</h3>',
    );
    const paragraph = root.querySelector('p')!;
    const heading = root.querySelector('h3')!;
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 0);
    range.setEnd(heading.firstChild!, 0);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(prepareCopy(root)).toBe('<p>This is sample text.</p>');
  });

  // Comment annotations are internal to this editor and must never leak into copied
  // HTML. The <comment> wrapper is unwrapped (the commented text and its inline
  // markup are kept) and the body/reply children are dropped.
  it('strips comment tags from a full-document html copy', () => {
    const root = makeRoot(
      '<p>x<comment id="c1" data-resolved=""><span>phrase</span>' +
        '<comment-body>note</comment-body><comment-reply>reply</comment-reply></comment>y</p>',
    );
    window.getSelection()?.removeAllRanges();
    expect(prepareCopy(root)).toBe('<p>x<span>phrase</span>y</p>');
  });

  it('merges a mid-word comment back into the surrounding text', () => {
    const root = makeRoot(
      '<h2>Hea<comment id="c2">di<comment-body>note</comment-body></comment>ng</h2>',
    );
    window.getSelection()?.removeAllRanges();
    expect(prepareCopy(root)).toBe('<h2>Heading</h2>');
  });

  it('unwraps a comment split by a partial selection', () => {
    const root = makeRoot(
      '<p>before<comment id="c3">target<comment-body>note</comment-body></comment>after</p>',
    );
    const before = root.querySelector('p')!.firstChild!; // "before"
    const target = root.querySelector('comment')!.firstChild!; // "target"
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.setStart(before, 3); // ...ore
    range.setEnd(target, 3); // tar...
    sel.removeAllRanges();
    sel.addRange(range);
    expect(prepareCopy(root)).toBe('oretar');
  });

  it('ignores a selection that lies outside the root', () => {
    const root = makeRoot('<p>inside</p>');
    const outside = document.createElement('p');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    selectContents(outside);
    expect(prepareCopy(root)).toBe('<p>inside</p>');
  });

  // Regression test: double-clicking "sample" inside <strong> sets the range on the
  // text node, so a naive cloneContents loses the <strong> wrapper. prepareCopy must
  // expand the range outward through inline wrappers the range fully covers, so that
  // bold survives a copy-and-paste round trip.
  it('expands the range to include a fully-covered <strong> wrapper', () => {
    const root = makeRoot('<p>This is <strong>sample</strong> text.</p>');
    const text = root.querySelector('strong')!.firstChild!;
    selectTextRange(text, 0, 6); // the whole content of "sample"
    expect(prepareCopy(root)).toBe('<strong>sample</strong>');
  });

  it('expands through nested inline wrappers (<em> inside <strong>)', () => {
    const root = makeRoot('<p><strong><em>hi</em></strong></p>');
    const text = root.querySelector('em')!.firstChild!;
    selectTextRange(text, 0, 2);
    expect(prepareCopy(root)).toBe('<strong><em>hi</em></strong>');
  });

  it('does not expand when the selection covers only a partial substring', () => {
    const root = makeRoot('<p><strong>sample</strong></p>');
    const text = root.querySelector('strong')!.firstChild!;
    selectTextRange(text, 1, 4); // "amp"
    expect(prepareCopy(root)).toBe('amp');
  });

  it('does not expand across block boundaries', () => {
    // The <p> ancestor is block-level and not in the inline-preserve set, so the
    // range stays on the inline content even when it covers the paragraph's entire
    // text.
    const root = makeRoot('<p>hello</p>');
    const text = root.querySelector('p')!.firstChild!;
    selectTextRange(text, 0, 5);
    expect(prepareCopy(root)).toBe('hello');
  });

  it('expands a selectContents range that targets the wrapper itself', () => {
    const root = makeRoot('<p><strong>bold</strong></p>');
    selectContents(root.querySelector('strong')!);
    expect(prepareCopy(root)).toBe('<strong>bold</strong>');
  });
});
