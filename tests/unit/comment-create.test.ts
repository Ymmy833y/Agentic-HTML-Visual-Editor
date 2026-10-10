import { afterEach, describe, expect, it, vi } from 'vitest';

import { readSelectionRange } from '../../webview/editing/caret';
import { readCommentCreation, runCommentItem, wrapRangeInComment } from '../../webview/editing/comment-create';
import type { CommentItemPorts } from '../../webview/editing/comment-create';
import { ensureTargetBlock } from '../../webview/editing/target-block';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** Ports of the comment button, and a record of their calls. */
interface ItemHarness {
  readonly root: HTMLElement;
  readonly ports: CommentItemPorts;
  /** How attempts closed (complete, abort). As on the command path, decided by whether the rewrite changed the tree. */
  readonly attempts: string[];
  /** Comments passed to the port that opens the popup. */
  readonly opened: Element[];
  readonly diagnostics: string[];
}

/** Port overrides. Omitted ports return defaults that block nothing. */
interface PortOverrides {
  readonly readOpenComment?: () => Element | undefined;
  readonly runCommandEdit?: CommentItemPorts['runCommandEdit'];
  readonly fillRandom?: CommentItemPorts['fillRandom'];
}

/**
 * Places the body and creates the ports of the comment button.
 *
 * @param html The body.
 * @param overrides The ports to override.
 * @returns The ports and the record.
 */
function createItemHarness(html: string, overrides: PortOverrides = {}): ItemHarness {
  const root = mountRoot(html);
  const attempts: string[] = [];
  const opened: Element[] = [];
  const diagnostics: string[] = [];
  const ports: CommentItemPorts = {
    readEditorRoot: () => root,
    readOpenComment: overrides.readOpenComment ?? (() => undefined),
    openComment: (comment) => {
      opened.push(comment);
    },
    // As on the editing session's command path, close as complete only when the rewrite changed the tree.
    runCommandEdit: overrides.runCommandEdit ?? ((_kind, command) => {
      const changed = command();
      attempts.push(changed ? 'complete' : 'abort');
      return changed;
    }),
    ensureTargetBlock: () => ensureTargetBlock(root, readSelectionRange(root)),
    readOutsideBodyTexts: () => [],
    fillRandom: overrides.fillRandom ?? ((bytes) => crypto.getRandomValues(bytes)),
    reportDiagnostic: (detail) => {
      diagnostics.push(detail);
    },
  };
  return { root, ports, attempts, opened, diagnostics };
}

/**
 * Selects two positions in one text as a range.
 *
 * @param text The text.
 * @param start The start offset.
 * @param end The end offset.
 * @returns The selected range.
 */
function selectInText(text: Text, start: number, end: number): Range {
  const range = createRange(text, start, text, end);
  select(range);
  return range;
}

/**
 * Makes only the creation of comment elements throw. Other elements (such as paragraphs) can still be created.
 */
function failCreatingComment(): void {
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
    if (tagName === 'comment') {
      throw new Error('Cannot create a comment');
    }
    return create(tagName);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Conditions for creation', () => {
  it('rejects a range whose common parent lies inside an existing annotation', () => {
    const root = mountRoot('<p><comment id="c"><strong>abcd</strong></comment></p>');
    const text = readChildText(readElement(root, 'strong'), 0);

    expect(readCommentCreation(root, createRange(text, 1, text, 3))).toBeUndefined();
  });

  it('rejects a range inside a hidden entry of an existing annotation', () => {
    const root = mountRoot('<p><comment id="c">ab<comment-body>note</comment-body></comment></p>');
    const text = readChildText(readElement(root, 'comment-body'), 0);

    expect(readCommentCreation(root, createRange(text, 1, text, 3))).toBeUndefined();
  });

  it('rejects an existing annotation enclosed by the range under its common parent', () => {
    const root = mountRoot('<p>ab<comment id="c">cd</comment>ef</p>');
    const paragraph = readElement(root, 'p');

    expect(readCommentCreation(root, createRange(readChildText(paragraph, 0), 1, readChildText(paragraph, 2), 1)))
      .toBeUndefined();
  });
  it('a range within one paragraph creates inside the block', () => {
    const root = mountRoot('<p>abcd</p>');
    const text = readChildText(readElement(root, 'p'), 0);

    expect(readCommentCreation(root, createRange(text, 1, text, 3))).toBe('inBlock');
  });

  it('a range spanning two paragraphs gives nothing', () => {
    const root = mountRoot('<p>ab</p><p>cd</p>');
    const [first, second] = [...root.querySelectorAll('p')].map((paragraph) => readChildText(paragraph, 0));

    expect(readCommentCreation(root, createRange(first, 1, second, 1))).toBeUndefined();
  });

  it('a range overlapping one character of the annotated text of an existing comment gives nothing', () => {
    const root = mountRoot('<p>ab<comment id="c">cd</comment></p>');
    const range = createRange(readChildText(readElement(root, 'p'), 0), 1, readChildText(readElement(root, 'comment'), 0), 1);

    expect(readCommentCreation(root, range)).toBeUndefined();
  });

  it('a range of only whitespace and br gives nothing', () => {
    const root = mountRoot('<p>a<br>  b</p>');
    const paragraph = readElement(root, 'p');

    expect(readCommentCreation(root, createRange(readChildText(paragraph, 0), 1, readChildText(paragraph, 2), 2)))
      .toBeUndefined();
  });

  it('a range whose start falls inside u gives nothing', () => {
    const root = mountRoot('<p>a<u>bc</u>de</p>');
    const range = createRange(readChildText(readElement(root, 'u'), 0), 1, readChildText(readElement(root, 'p'), 2), 1);

    expect(readCommentCreation(root, range)).toBeUndefined();
  });

  it('a range whose start falls inside span creates inside the block', () => {
    const root = mountRoot('<p>a<span>bc</span>de</p>');
    const range = createRange(
      readChildText(readElement(root, 'span'), 0),
      1,
      readChildText(readElement(root, 'p'), 2),
      1,
    );

    expect(readCommentCreation(root, range)).toBe('inBlock');
  });

  it('a range starting inside the code directly under pre and ending outside it gives nothing', () => {
    const root = mountRoot('<pre><code>ab</code>cd</pre>');
    const range = createRange(
      readChildText(readElement(root, 'code'), 0),
      1,
      readChildText(readElement(root, 'pre'), 1),
      1,
    );

    expect(readCommentCreation(root, range)).toBeUndefined();
  });

  it('a range within the same bare run directly under the editor root creates in the bare run', () => {
    const root = mountRoot('ab<strong>cd</strong>ef');

    expect(readCommentCreation(root, createRange(readChildText(root, 0), 1, readChildText(root, 2), 1)))
      .toBe('inBareRun');
  });

  it('a range in an item whose end is in an item of a nested list gives nothing', () => {
    const root = mountRoot('<ul><li>ab<ul><li>cd</li></ul></li></ul>');
    const range = createRange(
      readChildText(readElement(root, 'li'), 0),
      1,
      readChildText(readElement(root, 'li li'), 0),
      1,
    );

    expect(readCommentCreation(root, range)).toBeUndefined();
  });
});

describe('Wrapping a range in a comment', () => {
  it('for a range starting in the middle of a strong with id and class, the strong is split, the latter part keeps only class, and the comment wraps from the latter part to the end', () => {
    const root = mountRoot('<p>a<strong id="s" class="k">bc</strong>de</p>');
    const range = createRange(
      readChildText(readElement(root, 'strong'), 0),
      1,
      readChildText(readElement(root, 'p'), 2),
      1,
    );

    wrapRangeInComment(range, 'c-test0001', { changed: false });

    expect(readElement(root, 'p').innerHTML).toBe(
      'a<strong id="s" class="k">b</strong><comment id="c-test0001"><strong class="k">c</strong>d</comment>e',
    );
  });

  it('the created comment has only the id attribute and no entries', () => {
    const root = mountRoot('<p>abcd</p>');
    const text = readChildText(readElement(root, 'p'), 0);

    const comment = wrapRangeInComment(createRange(text, 1, text, 3), 'c-test0001', { changed: false });

    expect([comment.getAttributeNames(), comment.querySelectorAll('comment-body, comment-reply').length])
      .toEqual([['id'], 0]);
  });

  it('after wrapping, the selection is the whole contents of the new comment', () => {
    const root = mountRoot('<p>a<em>bc</em>d</p>');
    const range = createRange(readChildText(readElement(root, 'em'), 0), 1, readChildText(readElement(root, 'p'), 2), 1);
    select(range);

    const comment = wrapRangeInComment(range, 'c-test0001', { changed: false });

    const selected = window.getSelection()?.getRangeAt(0);
    expect([selected?.startContainer, selected?.startOffset, selected?.endContainer, selected?.endOffset])
      .toEqual([comment, 0, comment, comment.childNodes.length]);
  });
});

describe('The comment button operation', () => {
  it('when no ID is found, no attempt is opened, the tree is unchanged, and one diagnostic line is left', () => {
    const html = '<p><span id="c-aaaaaaaa">ab</span>cd</p>';
    const harness = createItemHarness(html, { fillRandom: (bytes) => bytes.fill(0) });
    selectInText(readChildText(readElement(harness.root, 'p'), 1), 0, 2);

    runCommentItem(harness.ports);

    expect([harness.attempts, harness.root.innerHTML, harness.diagnostics.length]).toEqual([[], html, 1]);
  });

  it('when the attempt cannot be opened, the tree is unchanged and the port that opens the popup is not called', () => {
    const html = '<p>abcd</p>';
    const harness = createItemHarness(html, { runCommandEdit: () => false });
    selectInText(readChildText(readElement(harness.root, 'p'), 0), 1, 3);

    runCommentItem(harness.ports);

    expect([harness.root.innerHTML, harness.opened]).toEqual([html, []]);
  });

  it('when wrapping throws, the exception does not escape, one diagnostic line is left, and the attempt closes as aborted', () => {
    const harness = createItemHarness('<p>abcd</p>');
    selectInText(readChildText(readElement(harness.root, 'p'), 0), 1, 3);
    failCreatingComment();

    runCommentItem(harness.ports);

    expect([harness.diagnostics.length, harness.attempts]).toEqual([1, ['abort']]);
  });

  it('when it throws after wrapping a bare run in a paragraph, the attempt closes as complete and the port that opens the popup is not called', () => {
    const harness = createItemHarness('ab<strong>cd</strong>ef');
    select(createRange(readChildText(harness.root, 0), 1, readChildText(harness.root, 2), 1));
    failCreatingComment();

    runCommentItem(harness.ports);

    expect([harness.attempts, harness.opened]).toEqual([['complete'], []]);
  });

  it('while the popup is open, the tree is unchanged even with a different range selected, and the port that opens the popup is called with the open comment', () => {
    const html = '<p><comment id="c">ab</comment>cd</p>';
    let open: Element | undefined;
    const harness = createItemHarness(html, { readOpenComment: () => open });
    open = readElement(harness.root, 'comment');
    selectInText(readChildText(readElement(harness.root, 'p'), 1), 0, 2);

    runCommentItem(harness.ports);

    expect([harness.root.innerHTML, harness.opened]).toEqual([html, [open]]);
  });

  it('with only a caret outside any comment, neither the attempt nor the port that opens the popup is called', () => {
    const harness = createItemHarness('<p>ab<comment id="c">cd</comment></p>');
    selectInText(readChildText(readElement(harness.root, 'p'), 0), 1, 1);

    runCommentItem(harness.ports);

    expect([harness.attempts, harness.opened]).toEqual([[], []]);
  });
});
