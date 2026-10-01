import { describe, expect, it } from 'vitest';

import { countCharacters, findCountedPosition } from '../../webview/editing/character-count';
import type { CountRule } from '../../webview/editing/character-count';
import { createRoot, readChildText, readElement } from './helpers/format-dom';

// The rule a recorded selection of a block operation uses.
const SKIP_WHITESPACE: CountRule = { skipsWhitespaceBetweenBlocks: true, skipsCommentText: false };

// The rule used inside a blockquote whose lines become blocks.
const SKIP_COMMENT_TEXT: CountRule = { skipsWhitespaceBetweenBlocks: false, skipsCommentText: true };

// A comment annotation whose body holds a br and whose reply holds a text.
const COMMENT = '<comment id="c-a1b2c3d4">b<comment-body contenteditable="false">x<br>y</comment-body>'
  + '<comment-reply contenteditable="false">z</comment-reply></comment>';

/**
 * Counts every character inside an element.
 *
 * @param element The element.
 * @param rule Which nodes the count leaves out.
 * @param skipped A `br` left out of the count.
 * @returns The number of characters.
 */
function countAll(element: Element, rule: CountRule, skipped?: Element): number {
  return countCharacters(
    element,
    { node: element, offset: 0 },
    { node: element, offset: element.childNodes.length },
    rule,
    skipped,
  );
}

describe('counting the characters between two boundary points', () => {
  it('counts the length of each text and one character for each br', () => {
    const root = createRoot('<p>ab<br>cd</p>');

    expect(countAll(root, SKIP_WHITESPACE)).toBe(5);
  });

  it('leaves out whitespace-only text between blocks only when the rule says so', () => {
    const root = createRoot('<p>ab</p>\n<p>cd</p>');

    expect([countAll(root, SKIP_WHITESPACE), countAll(root, SKIP_COMMENT_TEXT)]).toEqual([4, 5]);
  });

  it('leaves out the text and br inside the body and replies of a comment only when the rule skips comment text', () => {
    const root = createRoot(`<p>a${COMMENT}c</p>`);

    expect([countAll(root, SKIP_WHITESPACE), countAll(root, SKIP_COMMENT_TEXT)]).toEqual([7, 3]);
  });

  it('counts only the part of a text between two boundary points inside it', () => {
    const root = createRoot('<p>abcdef</p>');
    const text = readChildText(readElement(root, 'p'), 0);

    expect(countCharacters(root, { node: text, offset: 1 }, { node: text, offset: 4 }, SKIP_WHITESPACE)).toBe(3);
  });

  it('counts a br right after the start point and not one right after the end point', () => {
    const root = createRoot('<p>ab<br>cd</p>');
    const paragraph = readElement(root, 'p');

    expect([
      countCharacters(root, { node: paragraph, offset: 1 }, { node: paragraph, offset: 2 }, SKIP_WHITESPACE),
      countCharacters(root, { node: paragraph, offset: 0 }, { node: paragraph, offset: 1 }, SKIP_WHITESPACE),
    ]).toEqual([1, 2]);
  });

  it('leaves out the br it is given', () => {
    const root = createRoot('<blockquote>ab<br></blockquote>');
    const quote = readElement(root, 'blockquote');

    expect([countAll(quote, SKIP_COMMENT_TEXT), countAll(quote, SKIP_COMMENT_TEXT, readElement(quote, 'br'))])
      .toEqual([3, 2]);
  });
});

describe('finding the position a character count points at', () => {
  it('takes the start of the next text for a start and the end of the previous text for an end at a seam', () => {
    const root = createRoot('<p>ab<strong>cd</strong></p>');
    const before = readChildText(readElement(root, 'p'), 0);
    const after = readChildText(readElement(root, 'strong'), 0);

    const start = findCountedPosition(root, 2, 'start', SKIP_WHITESPACE);
    const end = findCountedPosition(root, 2, 'end', SKIP_WHITESPACE);

    expect([start?.node === after, start?.offset, end?.node === before, end?.offset]).toEqual([true, 0, true, 2]);
  });

  it('points just before a br for a start and just after it for an end, within its parent', () => {
    const root = createRoot('<p>ab<br>cd</p>');
    const paragraph = readElement(root, 'p');

    const start = findCountedPosition(root, 2, 'start', SKIP_WHITESPACE);
    const end = findCountedPosition(root, 3, 'end', SKIP_WHITESPACE);

    expect([start?.node === paragraph, start?.offset, end?.node === paragraph, end?.offset])
      .toEqual([true, 1, true, 2]);
  });

  it('points at the end of the last counted node when the count runs past it', () => {
    const root = createRoot('<p>ab</p>');
    const text = readChildText(readElement(root, 'p'), 0);

    const end = findCountedPosition(root, 5, 'end', SKIP_WHITESPACE);

    expect([end?.node === text, end?.offset]).toEqual([true, 2]);
  });

  it('returns undefined when the element holds nothing to count', () => {
    const root = createRoot('<p></p>');

    expect(findCountedPosition(root, 0, 'start', SKIP_WHITESPACE)).toBeUndefined();
  });

  it('points at the text after a comment rather than inside its body when the rule skips comment text', () => {
    const root = createRoot(`<p>a${COMMENT}c</p>`);
    const after = readChildText(readElement(root, 'p'), 2);

    const start = findCountedPosition(root, 2, 'start', SKIP_COMMENT_TEXT);

    expect([start?.node === after, start?.offset]).toEqual([true, 0]);
  });
});
