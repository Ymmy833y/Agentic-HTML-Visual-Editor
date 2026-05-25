import { afterEach, describe, expect, it } from 'vitest';
import { prepareCopy } from '../../webview/copy';
import { clearDom, makeRoot, selectContents } from './helpers/selection';

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
});
