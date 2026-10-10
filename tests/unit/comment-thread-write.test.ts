import { describe, expect, it } from 'vitest';

import type { EncodedSelection } from '../../common/index';
import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import {
  COMMENT_THREAD_EDIT_KIND,
  removeComment,
  toggleCommentResolved,
  unwrapComment,
  writeCommentEntries,
} from '../../webview/editing/comment-thread-write';
import type { CommentThreadWritePorts } from '../../webview/editing/comment-thread-write';
import { mountRoot, readElement } from './helpers/format-dom';

// Current time that goes into the update time of entries. toISOString gives 2026-09-26T01:02:03.456Z.
const NOW = new Date(Date.UTC(2026, 8, 26, 1, 2, 3, 456));
const NOW_TEXT = '2026-09-26T01:02:03.456Z';

/** Ports to override. Omitted ports stop nothing, as in the real environment. */
interface PortOverrides {
  readonly isInputStopped?: () => boolean;
  readonly runCommandEdit?: (kind: string, command: () => boolean) => boolean;
  readonly readNow?: () => Date;
}

/** Ports and a record of how they were called. */
interface WriteHarness {
  readonly ports: CommentThreadWritePorts;
  readonly diagnostics: string[];
  /** Kinds of the opened attempts and how they closed (complete or abort), in order. */
  readonly attempts: string[];
  /** Selections attached to return requests. */
  readonly returns: (EncodedSelection | undefined)[];
}

/**
 * Creates a stand-in for the ports for rewriting a thread.
 *
 * As in the real environment, the command path closes as completed only when the tree was changed. Without calling
 * in the same order, it could not tell whether an attempt was opened.
 *
 * @param root Editor root.
 * @param overrides Ports to override.
 * @returns Ports and records.
 */
function createPorts(root: HTMLElement, overrides: PortOverrides = {}): WriteHarness {
  const diagnostics: string[] = [];
  const attempts: string[] = [];
  const returns: (EncodedSelection | undefined)[] = [];
  const ports: CommentThreadWritePorts = {
    readEditorRoot: () => root,
    isInputStopped: overrides.isInputStopped ?? (() => false),
    runCommandEdit: overrides.runCommandEdit ?? ((kind, command) => {
      attempts.push(`begin:${kind}`);
      const changed = command();
      attempts.push(changed ? 'complete' : 'abort');
      return changed;
    }),
    readNow: overrides.readNow ?? (() => NOW),
    requestReturn: (selection) => {
      returns.push(selection);
    },
    reportDiagnostic: (detail) => {
      diagnostics.push(detail);
    },
  };
  return { ports, diagnostics, attempts, returns };
}

describe('Rewriting entries', () => {
  it('adding a body inserts, before the first entry, a body with the attributes contenteditable, data-author and data-updated in that order and the raw input', () => {
    const root = mountRoot('<p><comment id="c">ab<comment-reply>r</comment-reply></comment></p>');
    const comment = readElement(root, 'comment');
    const { ports } = createPorts(root);

    writeCommentEntries(ports, [{ kind: 'addBody', comment, text: 'note' }]);

    expect(comment.innerHTML).toBe(
      `ab<comment-body contenteditable="false" data-author="human" data-updated="${NOW_TEXT}">note</comment-body>`
      + '<comment-reply>r</comment-reply>',
    );
  });

  it('adding a body to a comment without entries inserts it at the end of the comment', () => {
    const root = mountRoot('<p><comment id="c">ab</comment></p>');
    const comment = readElement(root, 'comment');
    const { ports } = createPorts(root);

    writeCommentEntries(ports, [{ kind: 'addBody', comment, text: 'note' }]);

    expect(comment.innerHTML).toBe(
      `ab<comment-body contenteditable="false" data-author="human" data-updated="${NOW_TEXT}">note</comment-body>`,
    );
  });

  it('adding a body to a comment with a body inserts a reply after the last entry, and there is still one body', () => {
    const root = mountRoot('<p><comment id="c">ab<comment-body>n</comment-body><comment-reply>r</comment-reply></comment></p>');
    const comment = readElement(root, 'comment');
    const { ports } = createPorts(root);

    writeCommentEntries(ports, [{ kind: 'addBody', comment, text: 'late' }]);

    expect([...comment.children].map((child) => [child.localName, child.textContent])).toEqual([
      ['comment-body', 'n'],
      ['comment-reply', 'r'],
      ['comment-reply', 'late'],
    ]);
  });

  it('in a hand-written comment with annotated text also after the reply, the body goes before the first entry and the other children do not move', () => {
    const root = mountRoot('<p><comment id="c">A<comment-reply>r</comment-reply>B</comment></p>');
    const comment = readElement(root, 'comment');
    const { ports } = createPorts(root);

    writeCommentEntries(ports, [{ kind: 'addBody', comment, text: 'n' }]);

    expect(comment.innerHTML).toBe(
      `A<comment-body contenteditable="false" data-author="human" data-updated="${NOW_TEXT}">n</comment-body>`
      + '<comment-reply>r</comment-reply>B',
    );
  });

  it('adding a reply inserts it after the last entry', () => {
    const root = mountRoot('<p><comment id="c">A<comment-body>n</comment-body>B</comment></p>');
    const comment = readElement(root, 'comment');
    const { ports } = createPorts(root);

    writeCommentEntries(ports, [{ kind: 'addReply', comment, text: 'r' }]);

    expect(comment.innerHTML).toBe(
      'A<comment-body>n</comment-body>'
      + `<comment-reply contenteditable="false" data-author="human" data-updated="${NOW_TEXT}">r</comment-reply>B`,
    );
  });

  it('editing an AI entry makes its content the raw input, renews only data-updated, and keeps data-author as ai', () => {
    const root = mountRoot(
      '<p><comment id="c">A<comment-body contenteditable="false" data-author="ai" data-updated="2026-01-01T00:00:00Z">'
      + 'old <code>x</code></comment-body></comment></p>',
    );
    const entry = readElement(root, 'comment-body');
    const { ports } = createPorts(root);

    writeCommentEntries(ports, [{ kind: 'edit', entry, text: 'new' }]);

    expect(entry.outerHTML).toBe(
      `<comment-body contenteditable="false" data-author="ai" data-updated="${NOW_TEXT}">new</comment-body>`,
    );
  });

  it('deleting the last entry leaves the comment without entries', () => {
    const root = mountRoot('<p><comment id="c">ab<comment-body>n</comment-body></comment></p>');
    const { ports } = createPorts(root);

    writeCommentEntries(ports, [{ kind: 'delete', entry: readElement(root, 'comment-body') }]);

    expect(readElement(root, 'p').innerHTML).toBe('<comment id="c">ab</comment>');
  });

  it('a set of an edit, a body and a reply is written in one attempt, and all three share one update time', () => {
    const root = mountRoot('<p><comment id="c">ab<comment-reply data-updated="old">r</comment-reply></comment></p>');
    const comment = readElement(root, 'comment');
    const reply = readElement(root, 'comment-reply');
    // A clock that advances on every read. If it is read only once, the three update times match.
    let tick = 0;
    const { ports, attempts } = createPorts(root, {
      readNow: () => {
        tick += 1;
        return new Date(Date.UTC(2026, 8, 26, 0, 0, 0, tick));
      },
    });

    writeCommentEntries(ports, [
      { kind: 'edit', entry: reply, text: 'r2' },
      { kind: 'addBody', comment, text: 'b' },
      { kind: 'addReply', comment, text: 'c' },
    ]);

    const updated = [...comment.children].map((child) => child.getAttribute('data-updated'));
    expect([attempts, new Set(updated).size]).toEqual([[`begin:${COMMENT_THREAD_EDIT_KIND.entry}`, 'complete'], 1]);
  });

  it('an edit of an entry not in the tree within a set becomes failed with one diagnostic line, and the others are written', () => {
    const root = mountRoot('<p><comment id="c">ab</comment></p>');
    const comment = readElement(root, 'comment');
    const detached = document.createElement('comment-body');
    const { ports, diagnostics } = createPorts(root);

    const outcomes = writeCommentEntries(ports, [
      { kind: 'edit', entry: detached, text: 'x' },
      { kind: 'addReply', comment, text: 'r' },
    ]);

    expect([outcomes, diagnostics.length, comment.querySelectorAll('comment-reply').length])
      .toEqual([['failed', 'written'], 1, 1]);
  });

  it('while input is stopped, no attempt is opened and all become blocked', () => {
    const root = mountRoot('<p><comment id="c">ab</comment></p>');
    const comment = readElement(root, 'comment');
    const { ports, attempts } = createPorts(root, { isInputStopped: () => true });

    const outcomes = writeCommentEntries(ports, [
      { kind: 'addBody', comment, text: 'b' },
      { kind: 'addReply', comment, text: 'r' },
    ]);

    expect([outcomes, attempts]).toEqual([['blocked', 'blocked'], []]);
  });

  it('when the attempt cannot start, all become blocked and the tree does not change', () => {
    const root = mountRoot('<p><comment id="c">ab</comment></p>');
    const comment = readElement(root, 'comment');
    const before = root.innerHTML;
    const { ports } = createPorts(root, { runCommandEdit: () => false });

    const outcomes = writeCommentEntries(ports, [{ kind: 'addBody', comment, text: 'b' }]);

    expect([outcomes, root.innerHTML]).toEqual([['blocked'], before]);
  });

  it('an exception after writing the first one does not escape, leaves one diagnostic line, closes the attempt as completed, and makes the rest failed', () => {
    const root = mountRoot('<p><comment id="c">ab<comment-body>n</comment-body></comment></p>');
    const comment = readElement(root, 'comment');
    const body = readElement(root, 'comment-body');
    Object.defineProperty(body, 'replaceChildren', {
      value: () => {
        throw new Error('cannot replace the entry content');
      },
    });
    const { ports, diagnostics, attempts } = createPorts(root);

    const outcomes = writeCommentEntries(ports, [
      { kind: 'addReply', comment, text: 'r' },
      { kind: 'edit', entry: body, text: 'x' },
      { kind: 'addReply', comment, text: 's' },
    ]);

    expect([outcomes, diagnostics.length, attempts.at(-1)]).toEqual([['written', 'failed', 'failed'], 1, 'complete']);
  });

  it('an exception before writing starts closes the attempt as aborted', () => {
    const root = mountRoot('<p><comment id="c">ab</comment></p>');
    const comment = readElement(root, 'comment');
    const { ports, attempts } = createPorts(root, {
      readNow: () => {
        throw new Error('cannot read the current time');
      },
    });

    writeCommentEntries(ports, [{ kind: 'addBody', comment, text: 'b' }]);

    expect(attempts).toEqual([`begin:${COMMENT_THREAD_EDIT_KIND.entry}`, 'abort']);
  });
});

describe('Toggling the resolved state', () => {
  it('an unresolved comment gets an empty data-resolved, and it is removed from a comment with data-resolved="false"', () => {
    const root = mountRoot('<p><comment id="u">a</comment><comment id="f" data-resolved="false">b</comment></p>');
    const unresolved = readElement(root, '#u');
    const resolved = readElement(root, '#f');
    const { ports } = createPorts(root);

    toggleCommentResolved(ports, unresolved);
    toggleCommentResolved(ports, resolved);

    expect([unresolved.getAttribute('data-resolved'), resolved.hasAttribute('data-resolved')]).toEqual(['', false]);
  });

  it('toggling does not change the attributes of the entries', () => {
    const root = mountRoot(
      '<p><comment id="c">a<comment-body contenteditable="false" data-author="ai" data-updated="2026-01-01T00:00:00Z">n'
      + '</comment-body></comment></p>',
    );
    const comment = readElement(root, 'comment');
    const before = readElement(root, 'comment-body').outerHTML;
    const { ports } = createPorts(root);

    toggleCommentResolved(ports, comment);

    expect(readElement(root, 'comment-body').outerHTML).toBe(before);
  });

  it('while input is stopped, nothing changes and no attempt is opened', () => {
    const root = mountRoot('<p><comment id="c">a</comment></p>');
    const comment = readElement(root, 'comment');
    const { ports, attempts } = createPorts(root, { isInputStopped: () => true });

    const changed = toggleCommentResolved(ports, comment);

    expect([changed, comment.hasAttribute('data-resolved'), attempts]).toEqual([false, false, []]);
  });
});

describe('Removing a comment', () => {
  it('the annotated characters and elements stay in order where the comment was, the comment and entries disappear, and the boundary at the end is returned', () => {
    const root = mountRoot(
      '<p>x<comment id="c">a<strong>b</strong>c<comment-body>n</comment-body><comment-reply>r</comment-reply></comment>y</p>',
    );
    const paragraph = readElement(root, 'p');
    const progress: BlockRewriteProgress = { changed: false };

    const boundary = unwrapComment(readElement(root, 'comment'), progress);

    expect([paragraph.innerHTML, boundary.container === paragraph, boundary.offset]).toEqual(['xa<strong>b</strong>cy', true, 4]);
  });

  it('a nested comment (hand-written) inside the annotated text stays', () => {
    const root = mountRoot(
      '<p><comment id="o">a<comment id="i">b<comment-body>inner</comment-body></comment>c'
      + '<comment-body>outer</comment-body></comment></p>',
    );
    const progress: BlockRewriteProgress = { changed: false };

    unwrapComment(readElement(root, '#o'), progress);

    expect(readElement(root, 'p').innerHTML).toBe('a<comment id="i">b<comment-body>inner</comment-body></comment>c');
  });

  it('for a comment without annotated text, the boundary where the comment was is returned', () => {
    const root = mountRoot('<p>x<comment id="c"><comment-body>n</comment-body></comment>y</p>');
    const paragraph = readElement(root, 'p');
    const progress: BlockRewriteProgress = { changed: false };

    const boundary = unwrapComment(readElement(root, 'comment'), progress);

    expect([paragraph.innerHTML, boundary.container === paragraph, boundary.offset]).toEqual(['xy', true, 1]);
  });

  it('after removal, a return is requested once with a selection whose start and end are the end of the kept annotated text', () => {
    const root = mountRoot('<p>x<comment id="c">ab<comment-body>n</comment-body></comment>y</p>');
    const { ports, returns } = createPorts(root);

    removeComment(ports, readElement(root, 'comment'));

    // The body output after removal is <p>xaby</p>, and the end of the kept annotated text ab is after the 6th character.
    expect(returns).toEqual([{ start: { line: 0, column: 6 }, end: { line: 0, column: 6 } }]);
  });

  it('while input is stopped, it neither removes nor requests a return', () => {
    const root = mountRoot('<p>x<comment id="c">ab</comment>y</p>');
    const before = root.innerHTML;
    const { ports, returns } = createPorts(root, { isInputStopped: () => true });

    const removed = removeComment(ports, readElement(root, 'comment'));

    expect([removed, root.innerHTML, returns]).toEqual([false, before, []]);
  });
});
