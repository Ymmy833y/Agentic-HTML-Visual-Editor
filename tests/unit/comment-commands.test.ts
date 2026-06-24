import { afterEach, describe, expect, it } from 'vitest';
import { addComment } from '../../webview/features/comment/comment-commands';
import { getBody } from '../../webview/features/comment/comment-dom';
import { clearDom, makeRoot, selectTextRange } from './helpers/selection';

afterEach(clearDom);

// Set a (possibly cross-node) selection from one boundary to another.
function selectRange(sc: Node, so: number, ec: Node, eo: number): void {
  const range = document.createRange();
  range.setStart(sc, so);
  range.setEnd(ec, eo);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

describe('addComment: refuses to nest or overlap comments', () => {
  it('returns null when the selection is inside an existing comment target', () => {
    const root = makeRoot('<p>hi <comment id="c1">target<comment-body>note</comment-body></comment> bye</p>');
    const target = root.querySelector('comment')!.firstChild!; // "target"
    selectTextRange(target, 0, 3); // "tar" — wholly inside the comment

    expect(addComment({ root })).toBeNull();
    expect(root.querySelectorAll('comment')).toHaveLength(1);
  });

  it('returns null when the selection contains an existing comment', () => {
    const root = makeRoot('<p>aa <comment id="c1">mid<comment-body>note</comment-body></comment> bb</p>');
    const p = root.querySelector('p')!;
    selectRange(p.firstChild!, 1, p.lastChild!, 2); // "a … bb" across the comment

    expect(addComment({ root })).toBeNull();
    expect(root.querySelectorAll('comment')).toHaveLength(1);
  });

  it('returns null when the selection partially overlaps an existing comment', () => {
    const root = makeRoot('<p>aa <comment id="c1">mid<comment-body>note</comment-body></comment> bb</p>');
    const p = root.querySelector('p')!;
    const commentTarget = root.querySelector('comment')!.firstChild!; // "mid"
    selectRange(p.firstChild!, 1, commentTarget, 2); // starts before the comment, ends inside it

    expect(addComment({ root })).toBeNull();
    expect(root.querySelectorAll('comment')).toHaveLength(1);
  });

  it('creates a comment for a plain selection that touches no existing comment', () => {
    const root = makeRoot('<p>hello world</p>');
    selectTextRange(root.querySelector('p')!.firstChild!, 0, 5); // "hello"

    const comment = addComment({ root });
    expect(comment).not.toBeNull();
    expect(comment!.tagName).toBe('COMMENT');
    expect(root.querySelectorAll('comment')).toHaveLength(1);
    expect(comment!.firstChild!.textContent).toBe('hello');
    expect(getBody(comment!)).toBe(''); // empty body is created and ready for input
  });

  it('allows a comment on text merely adjacent to an existing comment', () => {
    const root = makeRoot('<p>hi <comment id="c1">target<comment-body>note</comment-body></comment> bye</p>');
    const after = root.querySelector('comment')!.nextSibling!; // " bye"
    selectTextRange(after, 1, 4); // "bye" — adjacent to, not overlapping, the comment

    const comment = addComment({ root });
    expect(comment).not.toBeNull();
    expect(root.querySelectorAll('comment')).toHaveLength(2);
  });
});

describe('addComment: existing guards still apply', () => {
  it('returns null for a collapsed selection', () => {
    const root = makeRoot('<p>hello</p>');
    selectTextRange(root.querySelector('p')!.firstChild!, 2, 2); // collapsed

    expect(addComment({ root })).toBeNull();
    expect(root.querySelectorAll('comment')).toHaveLength(0);
  });

  it('returns null when the selection crosses a block boundary', () => {
    const root = makeRoot('<p>first</p><p>second</p>');
    const ps = root.querySelectorAll('p');
    selectRange(ps[0].firstChild!, 0, ps[1].firstChild!, 3);

    expect(addComment({ root })).toBeNull();
    expect(root.querySelectorAll('comment')).toHaveLength(0);
  });
});
