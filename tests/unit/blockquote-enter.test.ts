import { describe, expect, it } from 'vitest';

import {
  exitBlockquote,
  exitQuoteParagraph,
  findBareBlockquote,
  findTrailingQuoteParagraph,
  isAtTrailingBlankLine,
} from '../../webview/editing/blockquote-enter';
import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { createRange, createRoot, mountRoot, readChildText, readElement } from './helpers/format-dom';

/**
 * Creates a collapsed range pointing at a position inside a blockquote.
 *
 * @param container The node holding the position.
 * @param offset The position within the node.
 * @returns The collapsed range.
 */
function caretAt(container: Node, offset: number): Range {
  return createRange(container, offset, container, offset);
}

describe('detecting a bare blockquote', () => {
  it('returns the blockquote when the caret sits inside a bare one', () => {
    const root = createRoot('<blockquote>ab</blockquote>');
    const quote = readElement(root, 'blockquote');

    expect(findBareBlockquote(root, caretAt(readChildText(quote, 0), 1))).toBe(quote);
  });

  it('returns nothing for a paragraph inside a blockquote that holds paragraphs as children', () => {
    const root = createRoot('<blockquote><p>ab</p></blockquote>');
    const paragraph = readElement(root, 'p');

    expect(findBareBlockquote(root, caretAt(readChildText(paragraph, 0), 1))).toBeUndefined();
  });

  it('returns nothing when a range is selected, even inside a bare blockquote', () => {
    const root = createRoot('<blockquote>ab</blockquote>');
    const text = readChildText(readElement(root, 'blockquote'), 0);

    expect(findBareBlockquote(root, createRange(text, 0, text, 2))).toBeUndefined();
  });
});

describe('detecting the trailing blank line of a blockquote', () => {
  it('returns true when two br elements run at the end and the caret sits between them', () => {
    const root = createRoot('<blockquote>ab<br><br></blockquote>');
    const quote = readElement(root, 'blockquote');

    expect(isAtTrailingBlankLine(quote, caretAt(quote, 2))).toBe(true);
  });

  it('returns false for a blockquote with empty content, whichever side of it the caret is on', () => {
    const root = createRoot('<blockquote><br></blockquote>');
    const quote = readElement(root, 'blockquote');

    expect([
      isAtTrailingBlankLine(quote, caretAt(quote, 0)),
      isAtTrailingBlankLine(quote, caretAt(quote, 1)),
    ]).toEqual([false, false]);
  });

  it('counts the trailing br elements even inside a format element and returns true', () => {
    const root = createRoot('<blockquote>a<strong>b<br><br></strong></blockquote>');
    const strong = readElement(root, 'strong');

    expect(isAtTrailingBlankLine(readElement(root, 'blockquote'), caretAt(strong, 2))).toBe(true);
  });

  it('returns true with three br elements running at the end as well, as long as the caret sits before the last one', () => {
    const root = createRoot('<blockquote>ab<br><br><br></blockquote>');
    const quote = readElement(root, 'blockquote');

    expect(isAtTrailingBlankLine(quote, caretAt(quote, 3))).toBe(true);
  });
});

describe('leaving a blockquote', () => {
  it('removes only one of the three trailing br elements and keeps the blank line before it', () => {
    const root = mountRoot('\n<blockquote>ab<br><br><br></blockquote>\n');
    const quote = readElement(root, 'blockquote');
    const progress: BlockRewriteProgress = { changed: false };

    exitBlockquote(quote, caretAt(quote, 3), progress);

    expect(root.innerHTML).toBe('\n<blockquote>ab<br><br></blockquote>\n<p><br></p>\n');
  });

  it('leaves one placeholder that holds the height of the line in a blockquote emptied by the exit', () => {
    const root = mountRoot('\n<blockquote><br><br></blockquote>\n');
    const quote = readElement(root, 'blockquote');
    const progress: BlockRewriteProgress = { changed: false };

    exitBlockquote(quote, caretAt(quote, 1), progress);

    expect(quote.innerHTML).toBe('<br>');
  });
});

describe('detecting the trailing quote paragraph', () => {
  it('returns the paragraph when the caret sits in the empty last paragraph of a blockquote holding paragraphs', () => {
    const root = createRoot('<blockquote data-alert="note"><p>ab</p>\n<p><br></p>\n</blockquote>');
    const paragraph = root.querySelectorAll('p')[1];

    expect(findTrailingQuoteParagraph(root, caretAt(paragraph, 0))).toBe(paragraph);
  });

  it('returns nothing for a paragraph that is not empty, not last, or not in a blockquote, or with a range selected', () => {
    const root = createRoot(
      '<blockquote><p>ab</p></blockquote>'
      + '<blockquote><p><br></p><p>cd</p></blockquote>'
      + '<div><p><br></p></div>'
      + '<blockquote><p>ef</p><p><br></p></blockquote>',
    );
    const paragraphs = [...root.querySelectorAll('p')];
    const text = readChildText(paragraphs[0], 0);

    expect([
      findTrailingQuoteParagraph(root, caretAt(text, 2)),
      findTrailingQuoteParagraph(root, caretAt(paragraphs[1], 0)),
      findTrailingQuoteParagraph(root, caretAt(paragraphs[3], 0)),
      findTrailingQuoteParagraph(root, createRange(readChildText(paragraphs[4], 0), 0, paragraphs[5], 0)),
    ]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('leaving a blockquote from its trailing quote paragraph', () => {
  it('removes the paragraph and inserts an empty paragraph right after the blockquote, moving the caret into it', () => {
    const root = mountRoot('<blockquote data-alert="note"><p>ab</p>\n<p><br></p></blockquote>\n<p>cd</p>');
    const trailing = root.querySelectorAll('p')[1];
    const range = caretAt(trailing, 0);
    const progress: BlockRewriteProgress = { changed: false };

    exitQuoteParagraph(trailing, range, progress);

    const inserted = root.querySelectorAll('p')[1];
    expect([
      root.innerHTML,
      progress.changed,
      range.startContainer === inserted,
      window.getSelection()?.anchorNode === inserted,
    ]).toEqual([
      '<blockquote data-alert="note"><p>ab</p></blockquote>\n<p><br></p>\n<p>cd</p>',
      true,
      true,
      true,
    ]);
  });

  it('leaves the blockquote with one placeholder when removing the paragraph empties it', () => {
    const root = mountRoot('<blockquote><p><br></p></blockquote>');
    const paragraph = readElement(root, 'p');
    const progress: BlockRewriteProgress = { changed: false };

    exitQuoteParagraph(paragraph, caretAt(paragraph, 0), progress);

    expect(root.innerHTML).toBe('<blockquote><br></blockquote>\n<p><br></p>');
  });
});
