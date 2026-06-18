import { afterEach, describe, expect, it } from 'vitest';
import {
  addReply,
  commentsInDocumentOrder,
  findCommentById,
  getAuthor,
  getBody,
  getReplies,
  getUpdated,
  hasCounterpartEntry,
  isCounterpart,
  isResolved,
  lockChildren,
  newCommentId,
  removeReply,
  setBody,
  setResolved,
  updateReply,
} from '../../webview/features/comment/comment-dom';
import { clearDom, makeRoot } from './helpers/selection';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

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
    const body = comment.querySelector('comment-body')!;
    expect(body.getAttribute('contenteditable')).toBe('false');
    expect(body.textContent).toBe('hello');
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

describe('author / updated metadata', () => {
  it('setBody stamps author and an ISO updated time on creation', () => {
    const root = makeRoot('<p><comment id="c1">x</comment></p>');
    const comment = findCommentById(root, 'c1')!;
    setBody(comment, 'note', 'ai');
    const body = comment.querySelector('comment-body')!;
    expect(getAuthor(body)).toBe('ai');
    expect(getUpdated(body)).toMatch(ISO_RE);
  });

  it('setBody defaults the author to the local human label', () => {
    const root = makeRoot('<p><comment id="c1">x</comment></p>');
    const comment = findCommentById(root, 'c1')!;
    setBody(comment, 'note');
    expect(getAuthor(comment.querySelector('comment-body')!)).toBe('human');
  });

  it('setBody keeps the original author but refreshes the time on later edits', () => {
    const root = makeRoot(
      '<p><comment id="c1">x<comment-body data-author="ai" data-updated="2000-01-01T00:00:00Z">old</comment-body></comment></p>',
    );
    const comment = findCommentById(root, 'c1')!;
    setBody(comment, 'edited');
    const body = comment.querySelector('comment-body')!;
    expect(getAuthor(body)).toBe('ai');
    expect(getUpdated(body)).not.toBe('2000-01-01T00:00:00Z');
    expect(getUpdated(body)).toMatch(ISO_RE);
  });

  it('addReply stamps author and updated time', () => {
    const root = makeRoot('<p><comment id="c1">x</comment></p>');
    const reply = addReply(findCommentById(root, 'c1')!, 'hi', 'ai');
    expect(getAuthor(reply)).toBe('ai');
    expect(getUpdated(reply)).toMatch(ISO_RE);
  });

  it('updateReply refreshes the time but keeps the author', () => {
    const root = makeRoot('<p><comment id="c1">x</comment></p>');
    const reply = addReply(findCommentById(root, 'c1')!, 'hi', 'ai');
    reply.setAttribute('data-updated', '2000-01-01T00:00:00Z');
    updateReply(reply, 'edited');
    expect(getAuthor(reply)).toBe('ai');
    expect(getUpdated(reply)).not.toBe('2000-01-01T00:00:00Z');
  });
});

describe('counterpart detection', () => {
  it('isCounterpart is true only for AI-authored entries', () => {
    const root = makeRoot(
      '<p><comment id="c1">x<comment-body data-author="ai">b</comment-body>' +
        '<comment-reply data-author="human">r</comment-reply></comment></p>',
    );
    const comment = findCommentById(root, 'c1')!;
    expect(isCounterpart(comment.querySelector('comment-body')!)).toBe(true);
    expect(isCounterpart(comment.querySelector('comment-reply')!)).toBe(false);
  });

  it('hasCounterpartEntry detects an AI body or AI reply', () => {
    const root = makeRoot(
      '<p><comment id="human-only">x<comment-body data-author="human">b</comment-body></comment>' +
        '<comment id="ai-reply">y<comment-body data-author="human">b</comment-body>' +
        '<comment-reply data-author="ai">r</comment-reply></comment></p>',
    );
    expect(hasCounterpartEntry(findCommentById(root, 'human-only')!)).toBe(false);
    expect(hasCounterpartEntry(findCommentById(root, 'ai-reply')!)).toBe(true);
  });
});

describe('resolved state', () => {
  it('toggles the data-resolved attribute on the comment', () => {
    const root = makeRoot('<p><comment id="c1">x</comment></p>');
    const comment = findCommentById(root, 'c1')!;
    expect(isResolved(comment)).toBe(false);
    setResolved(comment, true);
    expect(comment.hasAttribute('data-resolved')).toBe(true);
    expect(isResolved(comment)).toBe(true);
    setResolved(comment, false);
    expect(comment.hasAttribute('data-resolved')).toBe(false);
  });
});
