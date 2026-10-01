import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCommentSplitPreprocessor,
  readCommentSplit,
  registerCommentSplit,
} from '../../webview/editing/comment-split';
import { attachEditingCore } from '../../webview/editing/editing-session';
import type { EditTransactionLifecycle } from '../../webview/history/edit-transaction-controller';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Checking comments when splitting', () => {
  it('is keep when the caret is outside any comment', () => {
    const root = mountRoot('<p>ab<comment id="c">cd</comment></p>');
    const paragraph = readElement(root, 'p');

    expect(readCommentSplit(paragraph, { container: readChildText(paragraph, 0), offset: 1 })).toEqual({ kind: 'keep' });
  });

  it('is the boundary just after the comment at the end of the outermost comment', () => {
    const root = mountRoot('<p>a<comment id="c">bc</comment>d</p>');
    const paragraph = readElement(root, 'p');

    const split = readCommentSplit(paragraph, { container: readChildText(readElement(root, 'comment'), 0), offset: 2 });

    expect(split).toEqual({ kind: 'edge', boundary: { container: paragraph, offset: 2 } });
  });

  it('is the boundary just before the comment at the comment start', () => {
    const root = mountRoot('<p>a<comment id="c">bc</comment>d</p>');
    const paragraph = readElement(root, 'p');

    const split = readCommentSplit(paragraph, { container: readChildText(readElement(root, 'comment'), 0), offset: 0 });

    expect(split).toEqual({ kind: 'edge', boundary: { container: paragraph, offset: 1 } });
  });

  it('is middle in the middle of the annotated text', () => {
    const root = mountRoot('<p>a<comment id="c">bc</comment>d</p>');

    const split = readCommentSplit(
      readElement(root, 'p'),
      { container: readChildText(readElement(root, 'comment'), 0), offset: 1 },
    );

    expect(split).toEqual({ kind: 'middle' });
  });

  it('is the boundary just after inside a comment with no visible content', () => {
    const root = mountRoot('<p>a<comment id="c"><comment-body>x</comment-body></comment>b</p>');
    const paragraph = readElement(root, 'p');

    const split = readCommentSplit(paragraph, { container: readElement(root, 'comment'), offset: 0 });

    expect(split).toEqual({ kind: 'edge', boundary: { container: paragraph, offset: 2 } });
  });

  it('is middle when nested, at the end of the inner comment but in the middle of the outer', () => {
    const root = mountRoot('<p><comment id="o">a<comment id="i">b</comment>c</comment></p>');

    const split = readCommentSplit(
      readElement(root, 'p'),
      { container: readChildText(readElement(root, '#i'), 0), offset: 1 },
    );

    expect(split).toEqual({ kind: 'middle' });
  });

  it('is keep in a paragraph inside a handwritten comment that contains a block', () => {
    const root = mountRoot('<comment id="c"><p>ab</p></comment>');
    const paragraph = readElement(root, 'p');

    expect(readCommentSplit(paragraph, { container: readChildText(paragraph, 0), offset: 1 })).toEqual({ kind: 'keep' });
  });
});

describe('The split preprocessor that keeps comments from breaking', () => {
  it('in the middle, inserts br inside the comment and returns a takeover that changed the tree with just after it as the boundary to continue from', () => {
    const root = mountRoot('<p><comment id="c">ab</comment></p>');
    const comment = readElement(root, 'comment');
    const preprocess = createCommentSplitPreprocessor(() => undefined);

    const preparation = preprocess(readElement(root, 'p'), { container: readChildText(comment, 0), offset: 1 });

    expect([preparation, comment.innerHTML]).toEqual([
      { kind: 'takenOver', changed: true, boundary: { container: comment, offset: 2 } },
      'a<br>b',
    ]);
  });

  it('when the check throws, the exception does not escape, one diagnostic line is left, and a takeover with no boundary to continue from that did not change the tree is returned', () => {
    const root = mountRoot('<p><comment id="c">ab</comment></p>');
    const diagnostics: string[] = [];
    const preprocess = createCommentSplitPreprocessor((detail) => diagnostics.push(detail));
    // Make the edge check throw when it reads the copy of the range contents.
    vi.spyOn(Range.prototype, 'cloneContents').mockImplementation(() => {
      throw new Error('Cannot read the copy');
    });

    const preparation = preprocess(
      readElement(root, 'p'),
      { container: readChildText(readElement(root, 'comment'), 0), offset: 1 },
    );

    expect([preparation, diagnostics.length]).toEqual([{ kind: 'takenOver', changed: false, boundary: undefined }, 1]);
  });
});

describe('Registering the split preprocessor', () => {
  it('a paragraph insertion in the middle of the annotated text in the registered editing session inserts br without splitting the paragraph', () => {
    const root = mountRoot('<p><comment id="c">ab</comment></p>');
    const transactions: EditTransactionLifecycle = {
      beginEdit: () => true,
      completeEdit: () => undefined,
      abortEdit: () => undefined,
    };
    const session = attachEditingCore(root, () => undefined, () => undefined, transactions);
    registerCommentSplit(session, () => undefined);
    const text = readChildText(readElement(root, 'comment'), 0);
    select(createRange(text, 1, text, 1));

    root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', cancelable: true }));

    expect(root.innerHTML).toBe('<p><comment id="c">a<br>b</comment></p>');
    session.dispose();
  });
});
