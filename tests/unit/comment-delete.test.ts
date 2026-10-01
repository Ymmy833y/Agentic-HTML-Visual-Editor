import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CommentShiftRecord,
  clampAtCommentBoundary,
  collectCommentKeep,
  createCommentRemoveRule,
  createCommentShiftRule,
  deleteKeepingEntries,
  readCommentDeleteStep,
} from '../../webview/editing/comment-delete';
import { readDeleteKind } from '../../webview/editing/delete-rule';
import type { DeleteKind } from '../../webview/editing/delete-rule';
import type { EditingHooks } from '../../webview/editing/editing-hooks';
import type { InputRuleResult } from '../../webview/editing/input-dispatcher';
import { prepareTargetBlock } from '../../webview/editing/target-block';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

afterEach(() => {
  vi.restoreAllMocks();
});

// A comment with characters before and after its annotated text.
const COMMENT = '<p>x<comment id="c">ab<comment-body>n</comment-body></comment>y</p>';

/**
 * Reads the delete kind from an input type.
 *
 * @param inputType The delete input type.
 * @returns The delete kind.
 */
function kindOf(inputType: string): DeleteKind {
  const kind = readDeleteKind(inputType);
  if (kind === undefined) {
    throw new Error(`Not a delete input type: ${inputType}`);
  }
  return kind;
}

/**
 * Places a collapsed selection at a position and returns a range at that position.
 *
 * @param node The position's node.
 * @param offset The position's offset.
 * @returns A range at the same position as the selection, separate from the selection.
 */
function caretAt(node: Node, offset: number): Range {
  select(createRange(node, offset, node, offset));
  return createRange(node, offset, node, offset);
}

/**
 * Reads the selection position.
 *
 * @returns The selection's anchor node and offset.
 */
function readSelection(): unknown[] {
  const selection = window.getSelection();
  return [selection?.anchorNode, selection?.anchorOffset];
}

/**
 * Calls a rule once.
 *
 * @param rule The rule.
 * @param root The editor root.
 * @param inputType The input type.
 * @param range The range.
 * @returns The input and the rule result.
 */
function runRule(
  rule: ReturnType<typeof createCommentShiftRule>,
  root: HTMLElement,
  inputType: string,
  range: Range,
): { event: InputEvent; result: InputRuleResult } {
  const event = new InputEvent('beforeinput', { inputType, cancelable: true });
  return { event, result: rule({ event, root, range }) };
}

describe('Shifting outward deletes', () => {
  it('a backward delete from inside at the start moves the selection and range just before the comment, records the input, and returns "pass"', () => {
    const root = mountRoot(COMMENT);
    const record = new CommentShiftRecord();
    const range = caretAt(readChildText(readElement(root, 'comment'), 0), 0);
    const paragraph = readElement(root, 'p');

    const { event, result } = runRule(createCommentShiftRule(record, () => undefined), root, 'deleteContentBackward', range);

    expect([result, readSelection(), [range.startContainer, range.startOffset], record.has(event)])
      .toEqual(['pass', [paragraph, 1], [paragraph, 1], true]);
  });

  it('a forward word delete from inside at the end moves the selection and range just after the comment', () => {
    const root = mountRoot(COMMENT);
    const range = caretAt(readChildText(readElement(root, 'comment'), 0), 2);
    const paragraph = readElement(root, 'p');

    runRule(createCommentShiftRule(new CommentShiftRecord(), () => undefined), root, 'deleteWordForward', range);

    expect([readSelection(), [range.startContainer, range.startOffset]]).toEqual([[paragraph, 2], [paragraph, 2]]);
  });

  it('a backward delete from just after a comment with empty annotated text moves the selection just before the comment', () => {
    const root = mountRoot('<p>x<comment id="c"><comment-body>n</comment-body></comment>y</p>');
    const paragraph = readElement(root, 'p');
    const range = caretAt(paragraph, 2);

    runRule(createCommentShiftRule(new CommentShiftRecord(), () => undefined), root, 'deleteContentBackward', range);

    expect(readSelection()).toEqual([paragraph, 1]);
  });

  it('a backward delete already just before the comment and an inward delete change neither the selection nor the record', () => {
    const root = mountRoot(COMMENT);
    const record = new CommentShiftRecord();
    const rule = createCommentShiftRule(record, () => undefined);
    const paragraph = readElement(root, 'p');
    const text = readChildText(readElement(root, 'comment'), 0);

    const before = runRule(rule, root, 'deleteContentBackward', caretAt(paragraph, 1));
    const beforeSelection = readSelection();
    const inward = runRule(rule, root, 'deleteContentBackward', caretAt(text, 2));
    const inwardSelection = readSelection();

    expect([beforeSelection, record.has(before.event), inwardSelection, record.has(inward.event)])
      .toEqual([[paragraph, 1], false, [text, 2], false]);
  });

  it('a delete with a range selection returns "pass" without changing the selection', () => {
    const root = mountRoot(COMMENT);
    const text = readChildText(readElement(root, 'comment'), 0);
    select(createRange(text, 0, text, 1));

    const { result } = runRule(
      createCommentShiftRule(new CommentShiftRecord(), () => undefined),
      root,
      'deleteContentBackward',
      createRange(text, 0, text, 1),
    );

    const selection = window.getSelection();
    expect([result, selection?.anchorOffset, selection?.focusOffset]).toEqual(['pass', 0, 1]);
  });

  it('an exception while reading does not escape, leaves one diagnostic line, and returns "pass" without changing the selection', () => {
    const root = mountRoot(COMMENT);
    const diagnostics: string[] = [];
    const text = readChildText(readElement(root, 'comment'), 0);
    const range = caretAt(text, 0);
    // Make the comment edge check fail when it reads a copy of the range contents.
    vi.spyOn(Range.prototype, 'cloneContents').mockImplementation(() => {
      throw new Error('cannot read the copy');
    });

    const { result } = runRule(
      createCommentShiftRule(new CommentShiftRecord(), (detail) => diagnostics.push(detail)),
      root,
      'deleteContentBackward',
      range,
    );

    expect([result, diagnostics.length, readSelection()]).toEqual(['pass', 1, [text, 0]]);
  });
});

describe('Steps of a delete keeping entries', () => {
  it('a line delete is a no-op if the caret\'s block has a comment, and pass otherwise', () => {
    const root = mountRoot(`${COMMENT}<p id="plain">plain</p>`);
    const kind = kindOf('deleteSoftLineBackward');

    expect([
      readCommentDeleteStep(root, caretAt(readChildText(readElement(root, 'p'), 0), 1), kind, false),
      readCommentDeleteStep(root, caretAt(readChildText(readElement(root, '#plain'), 0), 3), kind, false),
    ]).toEqual([{ kind: 'noop' }, { kind: 'pass' }]);
  });

  it('an inward word delete from the outside neighbor becomes a crossing delete of one character that places the caret back at that outside neighbor', () => {
    const root = mountRoot(COMMENT);
    const comment = readElement(root, 'comment');

    expect(readCommentDeleteStep(root, caretAt(readElement(root, 'p'), 2), kindOf('deleteWordBackward'), false))
      .toEqual({ kind: 'crossing', placeAt: { comment, side: 'end' } });
  });

  it('a delete with a shift record becomes a crossing delete of one character even when outward', () => {
    const root = mountRoot(COMMENT);
    const comment = readElement(root, 'comment');

    expect(readCommentDeleteStep(root, caretAt(readElement(root, 'p'), 1), kindOf('deleteContentBackward'), true))
      .toEqual({ kind: 'crossing', placeAt: { comment, side: 'start' } });
  });

  it('an inward delete from inside is a clamp step leaving the caret where it deleted, and an unshifted outward delete from the outside neighbor is a clamp step placing the caret back at the outside neighbor', () => {
    const root = mountRoot(COMMENT);
    const comment = readElement(root, 'comment');
    const text = readChildText(comment, 0);

    expect([
      readCommentDeleteStep(root, caretAt(text, 2), kindOf('deleteContentBackward'), false),
      readCommentDeleteStep(root, caretAt(readElement(root, 'p'), 2), kindOf('deleteContentForward'), false),
    ]).toEqual([
      { kind: 'clamp', atEdge: true, placeAt: undefined },
      { kind: 'clamp', atEdge: true, placeAt: { comment, side: 'end' } },
    ]);
  });

  it('an outward delete from inside without a shift record is a no-op', () => {
    const root = mountRoot(COMMENT);
    const text = readChildText(readElement(root, 'comment'), 0);

    expect(readCommentDeleteStep(root, caretAt(text, 0), kindOf('deleteContentBackward'), false)).toEqual({ kind: 'noop' });
  });
});

describe('Clamping at a comment boundary', () => {
  it('a range going backward from inside at the end past the comment start is cut at the start of the annotated text', () => {
    const root = mountRoot('<p>ab<comment id="c">cd<comment-body>n</comment-body></comment></p>');
    const comment = readElement(root, 'comment');
    const annotated = readChildText(comment, 0);
    const extent = createRange(readChildText(readElement(root, 'p'), 0), 0, annotated, 2);

    const clamped = clampAtCommentBoundary(extent, { container: annotated, offset: 2 });

    expect([clamped?.startContainer, clamped?.startOffset, clamped?.endContainer, clamped?.endOffset])
      .toEqual([comment, 0, annotated, 2]);
  });

  it('a range not crossing a comment boundary returns nothing and leaves the argument range unchanged', () => {
    const root = mountRoot('<p>ab<comment id="c">cd<comment-body>n</comment-body></comment></p>');
    const annotated = readChildText(readElement(root, 'comment'), 0);
    const extent = createRange(annotated, 0, annotated, 2);

    const clamped = clampAtCommentBoundary(extent, { container: annotated, offset: 2 });

    expect([clamped, extent.startContainer, extent.startOffset, extent.endOffset]).toEqual([undefined, annotated, 0, 2]);
  });

  it('with (hand-written) nesting, the range is cut at the boundary of the inner comment nearer the caret', () => {
    const root = mountRoot('<p>xy<comment id="o"><comment id="i">cd</comment></comment></p>');
    const inner = readElement(root, '#i');
    const annotated = readChildText(inner, 0);
    const extent = createRange(readChildText(readElement(root, 'p'), 0), 0, annotated, 2);

    const clamped = clampAtCommentBoundary(extent, { container: annotated, offset: 2 });

    expect([clamped?.startContainer, clamped?.startOffset]).toEqual([inner, 0]);
  });
});

describe('Delete keeping entries', () => {
  it('deleting a range from the last annotated character past the body and reply to the end of the comment removes only the characters, keeping the entries and the comment element in their original order', () => {
    const root = mountRoot(
      '<p><comment id="c">abc<comment-body>n</comment-body><comment-reply>r</comment-reply></comment>d</p>',
    );
    const comment = readElement(root, 'comment');

    deleteKeepingEntries(createRange(readChildText(comment, 0), 2, comment, 3));

    expect(root.innerHTML)
      .toBe('<p><comment id="c">ab<comment-body>n</comment-body><comment-reply>r</comment-reply></comment>d</p>');
  });
});

describe('Delete-keeping-entries rule', () => {
  it('when the range to delete cannot be determined at a comment edge (jsdom lacks Selection.modify), returns "consumed" without changing the tree', () => {
    const root = mountRoot(COMMENT);
    const rule = createCommentRemoveRule(new CommentShiftRecord(), () => undefined);

    const { result } = runRule(rule, root, 'deleteContentBackward', caretAt(readElement(root, 'p'), 2));

    expect([result, root.innerHTML]).toEqual(['consumed', COMMENT]);
  });

  it('when the range to delete cannot be determined away from a comment edge, returns "pass"', () => {
    const html = `${COMMENT}<p id="plain">plain</p>`;
    const root = mountRoot(html);
    const rule = createCommentRemoveRule(new CommentShiftRecord(), () => undefined);

    const { result } = runRule(rule, root, 'deleteContentBackward', caretAt(readChildText(readElement(root, '#plain'), 0), 3));

    expect([result, root.innerHTML]).toEqual(['pass', html]);
  });

  it('an exception while deciding the step does not escape, leaves one diagnostic line, and returns "consumed"', () => {
    const root = mountRoot(COMMENT);
    const diagnostics: string[] = [];
    const rule = createCommentRemoveRule(new CommentShiftRecord(), (detail) => diagnostics.push(detail));
    const range = caretAt(readChildText(readElement(root, 'comment'), 0), 1);
    vi.spyOn(Range.prototype, 'cloneContents').mockImplementation(() => {
      throw new Error('cannot read the copy');
    });

    const { result } = runRule(rule, root, 'deleteContentBackward', range);

    expect([result, diagnostics.length]).toEqual(['consumed', 1]);
  });
});

describe('Range delete guard', () => {
  // A comment with a body and a reply, followed by characters.
  const THREAD = '<p><comment id="c">abc<comment-body>n</comment-body><comment-reply>r</comment-reply></comment>d</p>';

  it('for a range starting inside the annotated text and ending after the comment, the body and reply within the range are returned as nodes to keep whole', () => {
    const root = mountRoot(THREAD);
    const range = createRange(readChildText(readElement(root, 'comment'), 0), 1, readChildText(readElement(root, 'p'), 1), 1);

    expect(collectCommentKeep(range, root, () => undefined)).toEqual({
      emptiedElements: [],
      keptNodes: [readElement(root, 'comment-body'), readElement(root, 'comment-reply')],
    });
  });

  it('returns nothing for a range fully containing the comment and for a range only inside the annotated text', () => {
    const root = mountRoot(THREAD);
    const paragraph = readElement(root, 'p');
    const annotated = readChildText(readElement(root, 'comment'), 0);

    expect([
      collectCommentKeep(createRange(paragraph, 0, paragraph, 2), root, () => undefined).keptNodes,
      collectCommentKeep(createRange(annotated, 0, annotated, 2), root, () => undefined).keptNodes,
    ]).toEqual([[], []]);
  });

  it('with (hand-written) nesting, when only the outer comment is partly covered, only the outer entries are returned', () => {
    const root = mountRoot(
      '<p><comment id="o">a<comment id="i">b<comment-body id="inner">ni</comment-body></comment>c'
      + '<comment-body id="outer">no</comment-body></comment>d</p>',
    );
    const range = createRange(readChildText(readElement(root, '#o'), 0), 0, readChildText(readElement(root, 'p'), 1), 1);

    expect(collectCommentKeep(range, root, () => undefined).keptNodes).toEqual([readElement(root, '#outer')]);
  });

  it('an exception while reading does not escape, leaves one diagnostic line, and returns empty', () => {
    const root = mountRoot(THREAD);
    const diagnostics: string[] = [];
    const range = createRange(readChildText(readElement(root, 'comment'), 0), 1, readChildText(readElement(root, 'p'), 1), 1);
    Object.defineProperty(root, 'querySelectorAll', {
      value: () => {
        throw new Error('cannot enumerate comments');
      },
    });

    const keep = collectCommentKeep(range, root, (detail) => diagnostics.push(detail));

    expect([keep, diagnostics.length]).toEqual([{ emptiedElements: [], keptNodes: [] }, 1]);
  });

  it('with the guard in the editing hooks, calling range deletion (prepareTargetBlock) keeps the entries and comment element of a partly covered comment', () => {
    const root = mountRoot(THREAD);
    const hooks: EditingHooks = {
      rangeDeleteGuards: [(range, editorRoot) => collectCommentKeep(range, editorRoot, () => undefined)],
      compositionStartHooks: [],
      splitPreprocessors: [],
    };
    const range = createRange(readChildText(readElement(root, 'comment'), 0), 1, readChildText(readElement(root, 'p'), 1), 1);

    prepareTargetBlock(root, range, hooks);

    expect(root.innerHTML)
      .toBe('<p><comment id="c">a<comment-body>n</comment-body><comment-reply>r</comment-reply></comment></p>');
  });
});
