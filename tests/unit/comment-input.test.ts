import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { COMPOSITION_PLACEHOLDER_TEXT } from '../../webview/editing/code-composition';
import {
  createCommentInputRule,
  insertCommentLineBreak,
  prepareCommentComposition,
  toVisibleSpaces,
} from '../../webview/editing/comment-input';
import type { EditingHooks } from '../../webview/editing/editing-hooks';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

// A comment with characters before and after its annotated text.
const COMMENT = '<p>x<comment id="c">ab<comment-body>n</comment-body></comment>y</p>';

/**
 * Creates empty editing hooks.
 *
 * @returns The editing hooks.
 */
function createHooks(): EditingHooks {
  return { rangeDeleteGuards: [], compositionStartHooks: [], splitPreprocessors: [] };
}

/**
 * Reads both ends of the selection.
 *
 * @returns The anchor node and offset, and whether the selection is collapsed.
 */
function readSelection(): unknown[] {
  const selection = window.getSelection();
  return [selection?.anchorNode, selection?.anchorOffset, selection?.isCollapsed];
}

describe('Visible spaces', () => {
  it('a single space inserted at the end of a block becomes U+00A0', () => {
    const root = mountRoot('<p>ab</p>');

    expect(toVisibleSpaces(root, { container: readChildText(readElement(root, 'p'), 0), offset: 2 }, ' ')).toBe(' ');
  });

  it('a space inserted between words stays as is, and a space inserted right after a space becomes U+00A0', () => {
    const root = mountRoot('<p id="joined">abcd</p><p id="spaced">ab cd</p>');

    expect([
      toVisibleSpaces(root, { container: readChildText(readElement(root, '#joined'), 0), offset: 2 }, ' '),
      toVisibleSpaces(root, { container: readChildText(readElement(root, '#spaced'), 0), offset: 3 }, ' '),
    ]).toEqual([' ', ' ']);
  });

  it('does not change spaces inside pre', () => {
    const root = mountRoot('<pre><code>ab</code></pre>');

    expect(toVisibleSpaces(root, { container: readChildText(readElement(root, 'code'), 0), offset: 2 }, ' ')).toBe(' ');
  });

  it('a space inserted at the end of annotated text followed only by entries becomes U+00A0, not counting entry characters as following line content', () => {
    const root = mountRoot('<p><comment id="c">ab<comment-body>note</comment-body></comment></p>');

    expect(toVisibleSpaces(root, { container: readChildText(readElement(root, 'comment'), 0), offset: 2 }, ' '))
      .toBe(' ');
  });
});

describe('In-line line breaks at comment edges', () => {
  it('at the end of annotated text followed only by entries, two br are inserted and the caret goes just after the first', () => {
    const root = mountRoot('<p><comment id="c">ab<comment-body>n</comment-body></comment></p>');
    const comment = readElement(root, 'comment');
    const text = readChildText(comment, 0);
    const progress: BlockRewriteProgress = { changed: false };

    insertCommentLineBreak(createRange(text, 2, text, 2), root, progress);

    const selection = window.getSelection();
    const caretAfter = selection?.anchorNode?.childNodes[(selection.anchorOffset) - 1];
    expect([comment.innerHTML, caretAfter === comment.querySelector('br')])
      .toEqual(['ab<br><br><comment-body>n</comment-body>', true]);
  });

  it('when characters follow, only one br is inserted', () => {
    const root = mountRoot('<p><comment id="c">ab<comment-body>n</comment-body></comment>cd</p>');
    const comment = readElement(root, 'comment');
    const text = readChildText(comment, 0);

    insertCommentLineBreak(createRange(text, 2, text, 2), root, { changed: false });

    expect(comment.innerHTML).toBe('ab<br><comment-body>n</comment-body>');
  });
});

describe('Input rule for comment edges and comment-crossing ranges', () => {
  it('text input without characters returns "pass" without changing the tree', () => {
    const root = mountRoot(COMMENT);
    const paragraph = readElement(root, 'p');
    const rule = createCommentInputRule(createHooks(), () => undefined);

    const result = rule({
      event: new InputEvent('beforeinput', { inputType: 'insertText', data: '', cancelable: true }),
      root,
      range: createRange(paragraph, 2, paragraph, 2),
    });

    expect([result, root.innerHTML]).toEqual(['pass', COMMENT]);
  });

  it('when no target block can be ensured for a comment-crossing range, returns "consumed" without changing the tree', () => {
    // A range starting between bare runs directly under the editor root cannot ensure a target block.
    const html = 'ab<comment id="c">cd<comment-body>n</comment-body></comment>';
    const root = mountRoot(html);
    const rule = createCommentInputRule(createHooks(), () => undefined);

    const result = rule({
      event: new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', cancelable: true }),
      root,
      range: createRange(root, 1, readChildText(readElement(root, 'comment'), 0), 1),
    });

    expect([result, root.innerHTML]).toEqual(['consumed', html]);
  });

  it('an exception while inserting after deleting the range does not escape, leaves one diagnostic line, and returns "edited"', () => {
    const root = mountRoot(COMMENT);
    const diagnostics: string[] = [];
    const rule = createCommentInputRule(createHooks(), (detail) => diagnostics.push(detail));
    const range = createRange(readChildText(readElement(root, 'comment'), 0), 1, readChildText(readElement(root, 'p'), 2), 1);
    // Make inserting the text fail after the range has been deleted.
    Object.defineProperty(range, 'insertNode', {
      value: () => {
        throw new Error('cannot insert the text');
      },
    });

    const result = rule({
      event: new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', cancelable: true }),
      root,
      range,
    });

    expect([result, diagnostics.length]).toEqual(['edited', 1]);
  });

  it('text input returns "pass" without changing the tree for a caret inside at the end or outside at the start, and inserts and returns "edited" inside at the start or outside at the end', () => {
    const rule = createCommentInputRule(createHooks(), () => undefined);
    const typeAt = (root: HTMLElement, node: Node, offset: number): string => rule({
      event: new InputEvent('beforeinput', { inputType: 'insertText', data: 'X', cancelable: true }),
      root,
      range: createRange(node, offset, node, offset),
    });
    const passing = mountRoot(COMMENT);
    const annotated = readChildText(readElement(passing, 'comment'), 0);
    const passed = [typeAt(passing, annotated, 2), typeAt(passing, readElement(passing, 'p'), 1), passing.innerHTML];
    const insideStart = mountRoot(COMMENT);
    const startResult = typeAt(insideStart, readChildText(readElement(insideStart, 'comment'), 0), 0);
    const outsideEnd = mountRoot(COMMENT);
    const endResult = typeAt(outsideEnd, readElement(outsideEnd, 'p'), 2);

    expect([passed, [startResult, insideStart.innerHTML], [endResult, outsideEnd.innerHTML]]).toEqual([
      ['pass', 'pass', COMMENT],
      ['edited', '<p>x<comment id="c">Xab<comment-body>n</comment-body></comment>y</p>'],
      ['edited', '<p>x<comment id="c">ab<comment-body>n</comment-body></comment>Xy</p>'],
    ]);
  });

  it('inserting text just after a comment in a paragraph ending with br keeps the paragraph\'s trailing br', () => {
    const root = mountRoot('<p>x<comment id="c">ab<comment-body>n</comment-body></comment>y<br><br></p>');
    const paragraph = readElement(root, 'p');
    const rule = createCommentInputRule(createHooks(), () => undefined);

    rule({
      event: new InputEvent('beforeinput', { inputType: 'insertText', data: 'X', cancelable: true }),
      root,
      range: createRange(paragraph, 2, paragraph, 2),
    });

    expect(root.innerHTML).toBe('<p>x<comment id="c">ab<comment-body>n</comment-body></comment>Xy<br><br></p>');
  });

  it('when deleting a comment-touching range that fully contains a comment leaves only a placeholder br in the target block, that br does not remain after the inserted text', () => {
    const root = mountRoot('<p><comment id="c">ab<comment-body>n</comment-body></comment><br></p>');
    const paragraph = readElement(root, 'p');
    const rule = createCommentInputRule(createHooks(), () => undefined);

    rule({
      event: new InputEvent('beforeinput', { inputType: 'insertText', data: 'X', cancelable: true }),
      root,
      range: createRange(paragraph, 0, paragraph, 1),
    });

    expect(root.innerHTML).toBe('<p>X</p>');
  });
});

describe('Adjusting composition start', () => {
  it('for a caret just after a comment, a text with only a zero-width space is placed right there, the caret moves after that character, and it is passed to the port', () => {
    const root = mountRoot(COMMENT);
    const paragraph = readElement(root, 'p');
    select(createRange(paragraph, 2, paragraph, 2));
    const kept: Text[] = [];

    prepareCommentComposition(root, (text) => kept.push(text), () => undefined);

    const placed = paragraph.childNodes[2];
    expect([placed instanceof Text ? placed.data : undefined, readSelection(), kept])
      .toEqual([COMPOSITION_PLACEHOLDER_TEXT, [placed, 1, true], [placed]]);
  });

  it('for a caret inside at the start, the composition placeholder is placed at the start inside the comment', () => {
    const root = mountRoot(COMMENT);
    const comment = readElement(root, 'comment');
    const text = readChildText(comment, 0);
    select(createRange(text, 0, text, 0));

    prepareCommentComposition(root, () => undefined, () => undefined);

    expect(comment.innerHTML).toBe(`${COMPOSITION_PLACEHOLDER_TEXT}ab<comment-body>n</comment-body>`);
  });

  it('a comment-crossing range is collapsed to its start without changing the tree', () => {
    const root = mountRoot(COMMENT);
    const text = readChildText(readElement(root, 'comment'), 0);
    select(createRange(text, 1, readChildText(readElement(root, 'p'), 2), 1));
    const kept: Text[] = [];

    prepareCommentComposition(root, (placed) => kept.push(placed), () => undefined);

    expect([root.innerHTML, readSelection(), kept]).toEqual([COMMENT, [text, 1, true], []]);
  });

  it('for a comment-touching range and a caret not at a comment edge, neither the tree nor the selection changes and the port is not called', () => {
    const root = mountRoot(COMMENT);
    const paragraph = readElement(root, 'p');
    const after = readChildText(paragraph, 2);
    const text = readChildText(readElement(root, 'comment'), 0);
    const kept: Text[] = [];

    select(createRange(paragraph, 2, after, 1));
    prepareCommentComposition(root, (placed) => kept.push(placed), () => undefined);
    const touching = [window.getSelection()?.anchorNode, window.getSelection()?.focusNode];
    select(createRange(text, 1, text, 1));
    prepareCommentComposition(root, (placed) => kept.push(placed), () => undefined);

    expect([root.innerHTML, touching, readSelection(), kept]).toEqual([COMMENT, [paragraph, after], [text, 1, true], []]);
  });

  it('an exception after placing the composition placeholder removes it and leaves one diagnostic line', () => {
    const root = mountRoot(COMMENT);
    const paragraph = readElement(root, 'p');
    select(createRange(paragraph, 2, paragraph, 2));
    const diagnostics: string[] = [];

    prepareCommentComposition(
      root,
      () => {
        throw new Error('cannot record the composition placeholder');
      },
      (detail) => diagnostics.push(detail),
    );

    expect([root.innerHTML, diagnostics.length]).toEqual([COMMENT, 1]);
  });
});
