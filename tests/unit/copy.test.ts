import { afterEach, describe, expect, it } from 'vitest';
import { prepareCopy } from '../../webview/copy';
import { clearDom, makeRoot, selectContents, selectTextRange } from './helpers/selection';

afterEach(clearDom);

describe('prepareCopy', () => {
  it('returns the full root innerHTML when nothing is selected (format=html)', () => {
    const root = makeRoot('<p>hello</p><p>world</p>');
    window.getSelection()?.removeAllRanges();
    expect(prepareCopy(root, 'html')).toBe('<p>hello</p><p>world</p>');
  });

  it('returns the full root innerHTML when the selection is collapsed', () => {
    const root = makeRoot('<p>hello</p>');
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(root.firstChild!, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    expect(prepareCopy(root, 'html')).toBe('<p>hello</p>');
  });

  it('returns only the selected fragment when a range is active', () => {
    const root = makeRoot('<p>hello</p><p>world</p>');
    selectContents(root.children[1]);
    const out = prepareCopy(root, 'html');
    expect(out).toBe('world');
  });

  it('applies the Confluence transform when format=confluence', () => {
    const root = makeRoot(
      '<p><comment id="c1">target<comment-body>note</comment-body></comment></p>',
    );
    window.getSelection()?.removeAllRanges();
    const out = prepareCopy(root, 'confluence');
    expect(out).toBe('<p>target</p>');
  });

  it('ignores a selection that lies outside the root', () => {
    const root = makeRoot('<p>inside</p>');
    const outside = document.createElement('p');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    selectContents(outside);
    expect(prepareCopy(root, 'html')).toBe('<p>inside</p>');
  });

  // Regression: double-clicking "sample" inside <strong> sets the range on
  // the text node, so a naive cloneContents would drop the <strong> wrapper.
  // prepareCopy must inflate the range outward through inline wrappers it
  // fully covers so the bold survives a copy-paste round trip.
  it('expands the range to include a fully-covered <strong> wrapper', () => {
    const root = makeRoot('<p>This is <strong>sample</strong> text.</p>');
    const text = root.querySelector('strong')!.firstChild!;
    selectTextRange(text, 0, 6); // entire content of "sample"
    expect(prepareCopy(root, 'html')).toBe('<strong>sample</strong>');
  });

  it('expands through nested inline wrappers (<em> inside <strong>)', () => {
    const root = makeRoot('<p><strong><em>hi</em></strong></p>');
    const text = root.querySelector('em')!.firstChild!;
    selectTextRange(text, 0, 2);
    expect(prepareCopy(root, 'html')).toBe('<strong><em>hi</em></strong>');
  });

  it('does not expand when the selection covers only a partial substring', () => {
    const root = makeRoot('<p><strong>sample</strong></p>');
    const text = root.querySelector('strong')!.firstChild!;
    selectTextRange(text, 1, 4); // "amp"
    expect(prepareCopy(root, 'html')).toBe('amp');
  });

  it('does not expand across block boundaries', () => {
    // The <p> ancestor is block-level and is not in the inline preserve set,
    // so the range stays on the inline content even when it covers the
    // entire paragraph text.
    const root = makeRoot('<p>hello</p>');
    const text = root.querySelector('p')!.firstChild!;
    selectTextRange(text, 0, 5);
    expect(prepareCopy(root, 'html')).toBe('hello');
  });

  it('expands a selectContents range that targets the wrapper itself', () => {
    const root = makeRoot('<p><strong>bold</strong></p>');
    selectContents(root.querySelector('strong')!);
    expect(prepareCopy(root, 'html')).toBe('<strong>bold</strong>');
  });
});
