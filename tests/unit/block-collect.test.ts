import { describe, expect, it } from 'vitest';

import {
  collectBareRunHeads,
  collectTargetBlocks,
  readCurrentBlock,
} from '../../webview/editing/block-collect';
import {
  createRange,
  createRoot,
  mountRoot,
  readChildText,
  readElement,
  select,
} from './helpers/format-dom';

/**
 * Lists the tag names so the returned blocks read more easily.
 *
 * @param blocks The blocks.
 * @returns The tag names.
 */
function readTagNames(blocks: readonly Element[]): string[] {
  return blocks.map((block) => block.localName);
}

/**
 * Creates a range spanning the text of two elements.
 *
 * @param root The editor root.
 * @param startSelector The CSS selector that finds the element holding the start point.
 * @param endSelector The CSS selector that finds the element holding the end point.
 * @returns The range that was created.
 */
function createSpanningRange(root: Element, startSelector: string, endSelector: string): Range {
  return createRange(
    readChildText(readElement(root, startSelector), 0),
    0,
    readChildText(readElement(root, endSelector), 0),
    1,
  );
}

describe('deciding the target blocks', () => {
  it('returns only that block when the range fits inside a single block', () => {
    const root = createRoot('\n<p>abcd</p>\n<p>efgh</p>\n');
    const text = readChildText(readElement(root, 'p'), 0);

    const targets = collectTargetBlocks(root, createRange(text, 1, text, 3));

    expect(readTagNames(targets)).toEqual(['p']);
  });

  it('returns the innermost overlapping blocks in document order for a range across several blocks', () => {
    const root = createRoot('\n<p>ab</p>\n<blockquote><p>cd</p></blockquote>\n<h2>ef</h2>\n');

    const targets = collectTargetBlocks(root, createSpanningRange(root, 'p', 'h2'));

    expect(readTagNames(targets)).toEqual(['p', 'p', 'h2']);
  });

  it('leaves the scaffolding out for a range across a table and a list, taking the cell and the list item', () => {
    const root = createRoot(
      '\n<p>ab</p>\n<table><tbody><tr><td>cd</td></tr></tbody></table>'
      + '\n<ul><li>ef</li></ul>\n<p>gh</p>\n',
    );

    const targets = collectTargetBlocks(root, createSpanningRange(root, 'p', 'p:last-of-type'));

    expect(readTagNames(targets)).toEqual(['p', 'td', 'li', 'p']);
  });

  it('returns only the block containing the start point for a selection with no range', () => {
    const root = createRoot('\n<p>ab</p>\n<p>cd</p>\n');
    const text = readChildText(readElement(root, 'p'), 0);

    const targets = collectTargetBlocks(root, createRange(text, 1, text, 1));

    expect(readTagNames(targets)).toEqual(['p']);
  });

  it('returns one first node per bare run directly beneath the editor root', () => {
    const root = createRoot('ab<strong>cd</strong>\n<p>ef</p>\ngh');
    const range = createRange(readChildText(root, 0), 0, readChildText(root, 4), 2);

    const heads = collectBareRunHeads(root, range);

    expect(heads.map((head) => head.textContent)).toEqual(['ab', '\ngh']);
  });

  it('returns only one head for a bare run that includes b, treating it as a single run', () => {
    const root = createRoot('ab<b>cd</b>ef');
    const range = createRange(readChildText(root, 0), 0, readChildText(root, 2), 2);

    const heads = collectBareRunHeads(root, range);

    expect(heads.map((head) => head.textContent)).toEqual(['ab']);
  });

  it('returns the heads of the runs with content directly inside the cell that overlap the range when the cell is passed as the parent', () => {
    const root = createRoot('\n<table><tbody><tr><td>ab<p>cd</p>ef\n<ul><li>gh</li></ul>\n</td></tr></tbody></table>\n');
    const cell = readElement(root, 'td');
    const range = createRange(readChildText(cell, 0), 1, readChildText(readElement(cell, 'li'), 0), 1);

    const heads = collectBareRunHeads(cell, range);

    expect(heads.map((head) => head.textContent)).toEqual(['ab', 'ef\n']);
  });

  it('does not return bare text inside a cell', () => {
    const root = createRoot('\n<table><tbody><tr><td>ab</td></tr></tbody></table>\n');
    const text = readChildText(readElement(root, 'td'), 0);

    const heads = collectBareRunHeads(root, createRange(text, 0, text, 2));

    expect(heads).toEqual([]);
  });

  it('returns no target and changes neither the tree nor the selection when the selection is outside the editor root', () => {
    const root = mountRoot('ab');
    const outside = document.createElement('p');
    outside.textContent = 'cd';
    document.body.append(outside);
    const text = readChildText(outside, 0);
    select(createRange(text, 0, text, 2));

    expect([readCurrentBlock(root), root.innerHTML]).toEqual([undefined, 'ab']);
  });

  it('returns the block containing the start point without wrapping the bare run for a range selection', () => {
    const root = mountRoot('<h2>ab</h2>\ncd');
    select(createRange(
      readChildText(readElement(root, 'h2'), 0),
      1,
      readChildText(root, 1),
      2,
    ));

    const block = readCurrentBlock(root);

    expect([block?.localName, root.innerHTML]).toEqual(['h2', '<h2>ab</h2>\ncd']);
  });

  it('over a range crossing a closed details section, the body blocks are not in the list, while the surrounding paragraphs and the title are', () => {
    const root = createRoot(
      '\n<p id="before">ab</p>\n<details><summary>st</summary>\n<p>body</p>\n</details>\n<p id="after">cd</p>\n',
    );

    const targets = collectTargetBlocks(root, createSpanningRange(root, '#before', '#after'));

    expect(readTagNames(targets)).toEqual(['p', 'summary', 'p']);
  });

  it('over a range crossing an open details section, the body blocks are in the list', () => {
    const root = createRoot(
      '\n<p id="before">ab</p>\n<details open=""><summary>st</summary>\n<p>body</p>\n</details>\n<p id="after">cd</p>\n',
    );

    const targets = collectTargetBlocks(root, createSpanningRange(root, '#before', '#after'));

    expect(readTagNames(targets)).toEqual(['p', 'summary', 'p', 'p']);
  });
});
