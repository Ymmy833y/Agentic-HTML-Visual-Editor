import { describe, expect, it } from 'vitest';

import type { EditingHooks, SplitPreprocessor } from '../../webview/editing/editing-hooks';
import { createPasteRule, insertPastedText, splitPastedLines } from '../../webview/editing/paste-rule';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

describe('pasted text line splitting', () => {
  it('produces the same line array from mixed LF, CRLF, and CR', () => {
    expect(splitPastedLines('a\nb\r\nc\rd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('produces one element for text without a line break', () => {
    expect(splitPastedLines('a')).toEqual(['a']);
  });

  it('retains a trailing line break as an empty final line', () => {
    expect(splitPastedLines('a\n')).toEqual(['a', '']);
  });
});

/** A preprocessor that inserts a line break at the caret and takes over with just after it as the boundary to continue from (the same shape as in the middle of a comment). */
const insertBreak: SplitPreprocessor = (_block, caret) => {
  const at = document.createRange();
  at.setStart(caret.container, caret.offset);
  const lineBreak = document.createElement('br');
  at.insertNode(lineBreak);
  at.setStartAfter(lineBreak);
  return { kind: 'takenOver', changed: true, boundary: { container: at.startContainer, offset: at.startOffset } };
};

describe('Paste and split preprocessors', () => {
  it('pasting two lines, when a preprocessor inserts a line break and takes over, the paragraph is not split and the second line goes after that line break', () => {
    const root = mountRoot('<p>ab</p>');
    const hooks: EditingHooks = { rangeDeleteGuards: [], compositionStartHooks: [], compositionEndHooks: [], splitPreprocessors: [insertBreak] };
    const text = readChildText(readElement(root, 'p'), 0);
    const range = createRange(text, 1, text, 1);
    select(range);
    const event = new InputEvent('beforeinput', { inputType: 'insertFromPaste', cancelable: true });
    // jsdom cannot create a paste DataTransfer, so give it only the getData the rule reads.
    Object.defineProperty(event, 'dataTransfer', { value: { getData: () => 'x\ny' } });

    const result = createPasteRule(root, hooks)({ event, root, range });

    expect([result, root.innerHTML]).toEqual(['edited', '<p>ax<br>yb</p>']);
  });
});

describe('text form paste into a range', () => {
  it('given a range, deletes it, inserts two lines splitting the paragraph, and returns true', () => {
    const root = mountRoot('<p>abcd</p>');
    const text = readChildText(readElement(root, 'p'), 0);
    const range = createRange(text, 1, text, 3);
    select(range);

    const changed = insertPastedText(root, range, 'x\ny');

    expect([changed, root.innerHTML]).toEqual([true, '<p>ax</p>\n<p>yd</p>']);
  });

  it('returns false without deleting the range if the text is empty', () => {
    const root = mountRoot('<p>abcd</p>');
    const text = readChildText(readElement(root, 'p'), 0);
    const range = createRange(text, 1, text, 3);
    select(range);

    const changed = insertPastedText(root, range, '');

    expect([changed, root.innerHTML]).toEqual([false, '<p>abcd</p>']);
  });
});
