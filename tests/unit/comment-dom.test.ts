import { afterEach, describe, expect, it } from 'vitest';
import {
  addReply,
  commentsInDocumentOrder,
  findCommentById,
  getBody,
  getReplies,
  lockChildren,
  newCommentId,
  removeReply,
  setBody,
  updateReply,
} from '../../webview/features/comment/comment-dom';
import { clearDom, makeRoot } from './helpers/selection';

afterEach(clearDom);

describe('newCommentId', () => {
  it('returns an id that does not collide with existing comments', () => {
    const root = makeRoot('<p><comment id="c-existing">x</comment></p>');
    const id = newCommentId(root);
    expect(id).not.toBe('c-existing');
    expect(id).toMatch(/^c-[a-z0-9]+$/);
  });
});

describe('findCommentById', () => {
  it('finds a comment element by its id', () => {
    const root = makeRoot('<p><comment id="c1">a</comment> <comment id="c2">b</comment></p>');
    const found = findCommentById(root, 'c2');
    expect(found?.textContent).toBe('b');
  });

  it('returns null when no comment matches', () => {
    const root = makeRoot('<p><comment id="c1">a</comment></p>');
    expect(findCommentById(root, 'c-missing')).toBeNull();
  });
});

describe('setBody / getBody', () => {
  it('creates a <comment-body> child when absent and stores the text', () => {
    const root = makeRoot('<p><comment id="c1">target</comment></p>');
    const comment = findCommentById(root, 'c1')!;
    setBody(comment, 'hello');
    expect(comment.innerHTML).toBe('target<comment-body contenteditable="false">hello</comment-body>');
    expect(getBody(comment)).toBe('hello');
  });

  it('updates the existing <comment-body> in place', () => {
    const root = makeRoot('<p><comment id="c1">x<comment-body>old</comment-body></comment></p>');
    const comment = findCommentById(root, 'c1')!;
    setBody(comment, 'new');
    expect(getBody(comment)).toBe('new');
    expect(comment.querySelectorAll('comment-body').length).toBe(1);
  });

  it('inserts <comment-body> before any existing <comment-reply> siblings', () => {
    const root = makeRoot('<p><comment id="c1">x<comment-reply>r</comment-reply></comment></p>');
    const comment = findCommentById(root, 'c1')!;
    setBody(comment, 'body');
    const children = Array.from(comment.children);
    expect(children[0].tagName.toLowerCase()).toBe('comment-body');
    expect(children[1].tagName.toLowerCase()).toBe('comment-reply');
  });
});

describe('replies', () => {
  it('addReply appends a <comment-reply> with contenteditable=false', () => {
    const root = makeRoot('<p><comment id="c1">x</comment></p>');
    const comment = findCommentById(root, 'c1')!;
    const r1 = addReply(comment, 'first');
    const r2 = addReply(comment, 'second');
    expect(r1.getAttribute('contenteditable')).toBe('false');
    expect(getReplies(comment).map((r) => r.textContent)).toEqual(['first', 'second']);
    expect(getReplies(comment)).toEqual([r1, r2]);
  });

  it('updateReply replaces the text content', () => {
    const root = makeRoot('<p><comment id="c1">x</comment></p>');
    const reply = addReply(findCommentById(root, 'c1')!, 'old');
    updateReply(reply, 'new');
    expect(reply.textContent).toBe('new');
  });

  it('removeReply detaches the reply from the comment', () => {
    const root = makeRoot('<p><comment id="c1">x</comment></p>');
    const comment = findCommentById(root, 'c1')!;
    const r1 = addReply(comment, 'a');
    addReply(comment, 'b');
    removeReply(r1);
    expect(getReplies(comment).map((r) => r.textContent)).toEqual(['b']);
  });
});

describe('commentsInDocumentOrder', () => {
  it('returns <comment id> elements in DOM order', () => {
    const root = makeRoot(
      '<p><comment id="c1">a</comment></p>' +
        '<p><comment id="c2">b</comment><comment id="c3">c</comment></p>',
    );
    const ids = commentsInDocumentOrder(root).map((c) => c.getAttribute('id'));
    expect(ids).toEqual(['c1', 'c2', 'c3']);
  });

  it('skips <comment> elements without an id', () => {
    const root = makeRoot('<p><comment>legacy</comment><comment id="c1">x</comment></p>');
    const ids = commentsInDocumentOrder(root).map((c) => c.getAttribute('id'));
    expect(ids).toEqual(['c1']);
  });
});

describe('lockChildren', () => {
  it('adds contenteditable=false to <comment-body> and <comment-reply> children', () => {
    const root = makeRoot(
      '<p><comment id="c1">x<comment-body>b</comment-body><comment-reply>r</comment-reply></comment></p>',
    );
    const comment = findCommentById(root, 'c1')!;
    lockChildren(comment);
    expect(comment.querySelector('comment-body')!.getAttribute('contenteditable')).toBe('false');
    expect(comment.querySelector('comment-reply')!.getAttribute('contenteditable')).toBe('false');
  });
});
