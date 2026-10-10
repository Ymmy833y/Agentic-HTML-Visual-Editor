import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import {
  collapseStructureCrossingSelection,
  insertLineBreak,
  insertTypedText,
  needsRangeReplacement,
} from '../../webview/editing/crossing-input';
import {
  createRange,
  createRoot,
  mountRoot,
  readChildText,
  readElement,
  select,
} from './helpers/format-dom';

const TABLE = '<table><tbody><tr><td>a</td></tr></tbody></table>';

/**
 * Creates a range collapsed at a position.
 *
 * @param node The node of the position.
 * @param offset The offset of the position.
 * @returns A collapsed range.
 */
function caretAt(node: Node, offset: number): Range {
  return createRange(node, offset, node, offset);
}

/**
 * Reads both ends of the current selection.
 *
 * @returns The nodes and offsets of the anchor and the focus.
 */
function readSelectionEnds(): unknown[] {
  const selection = window.getSelection();
  return [selection?.anchorNode, selection?.anchorOffset, selection?.focusNode, selection?.focusOffset];
}

/** A reporter that discards diagnostics. */
function ignoreDiagnostic(): void {
  // Only the tests for the exception case look at whether a diagnostic was recorded.
}

describe('deciding input that goes through the range delete', () => {
  it('returns true for a range crossing a table and false for a range inside a paragraph that crosses no structure', () => {
    const root = createRoot(`<p>ab</p>${TABLE}`);
    const text = readChildText(readElement(root, 'p'), 0);
    const cell = readChildText(readElement(root, 'td'), 0);

    expect([
      needsRangeReplacement(createRange(text, 1, cell, 1), root),
      needsRangeReplacement(createRange(text, 0, text, 2), root),
    ]).toEqual([true, false]);
  });

  it('returns true for select-all of a document starting with a table (start directly under the editor root before the table) and false for a collapsed caret', () => {
    const root = createRoot(`${TABLE}\n<p>ab</p>`);
    const text = readChildText(readElement(root, 'p'), 0);

    expect([
      needsRangeReplacement(createRange(root, 0, root, root.childNodes.length), root),
      needsRangeReplacement(caretAt(text, 1), root),
    ]).toEqual([true, false]);
  });
});

describe('inserting characters after deleting the range', () => {
  it('inserts the characters in the middle of a paragraph, places the caret and range right after them, and sets the progress to true', () => {
    const root = mountRoot('<p>ab</p>');
    const paragraph = readElement(root, 'p');
    const range = caretAt(readChildText(paragraph, 0), 1);
    const progress: BlockRewriteProgress = { changed: false };

    insertTypedText(range, root, 'x', progress);

    expect([
      root.innerHTML,
      progress.changed,
      [range.startContainer === paragraph, range.startOffset, range.collapsed],
      readSelectionEnds(),
    ]).toEqual(['<p>axb</p>', true, [true, 2, true], [paragraph, 2, paragraph, 2]]);
  });

  it('inserts the characters into code when the range is right before an empty code', () => {
    const root = mountRoot('<pre><code></code></pre>');

    insertTypedText(caretAt(readElement(root, 'pre'), 0), root, 'x', { changed: false });

    expect(root.innerHTML).toBe('<pre><code>x</code></pre>');
  });

  it('inserting into a block with only a placeholder removes the placeholder br', () => {
    const root = mountRoot('<p><br></p>');

    insertTypedText(caretAt(readElement(root, 'p'), 0), root, 'x', { changed: false });

    expect(root.innerHTML).toBe('<p>x</p>');
  });
});

describe('inserting a line break after deleting the range', () => {
  it('in the middle of text, inserts one br and places the caret right after it', () => {
    const root = mountRoot('<p>ab</p>');
    const paragraph = readElement(root, 'p');
    const progress: BlockRewriteProgress = { changed: false };

    insertLineBreak(caretAt(readChildText(paragraph, 0), 1), root, progress);

    expect([root.innerHTML, progress.changed, readSelectionEnds()])
      .toEqual(['<p>a<br>b</p>', true, [paragraph, 2, paragraph, 2]]);
  });

  it('at the end of a block, results in two br elements with the caret between them', () => {
    const root = mountRoot('<p>ab</p>');
    const paragraph = readElement(root, 'p');

    insertLineBreak(caretAt(readChildText(paragraph, 0), 2), root, { changed: false });

    expect([root.innerHTML, readSelectionEnds()]).toEqual(['<p>ab<br><br></p>', [paragraph, 2, paragraph, 2]]);
  });

  it('in a block with only a placeholder, results in two br elements, not three', () => {
    const root = mountRoot('<p><br></p>');
    const paragraph = readElement(root, 'p');

    insertLineBreak(caretAt(paragraph, 0), root, { changed: false });

    expect([root.innerHTML, readSelectionEnds()]).toEqual(['<p><br><br></p>', [paragraph, 1, paragraph, 1]]);
  });
});

describe('collapsing a structure-crossing selection before a composition', () => {
  it('for a range crossing a table, collapses the selection to the start and leaves the tree unchanged', () => {
    const html = `<p>ab</p>${TABLE}`;
    const root = mountRoot(html);
    const text = readChildText(readElement(root, 'p'), 0);
    select(createRange(text, 1, readChildText(readElement(root, 'td'), 0), 1));

    collapseStructureCrossingSelection(root, ignoreDiagnostic);

    expect([root.innerHTML, readSelectionEnds()]).toEqual([html, [text, 1, text, 1]]);
  });

  it('for a range crossing no structure, changes neither the selection nor the tree even if the start is at a between-blocks position', () => {
    const html = `${TABLE}\n<p>ab</p>`;
    const root = mountRoot(html);
    const text = readChildText(readElement(root, 'p'), 0);
    select(createRange(root, 1, text, 1));

    collapseStructureCrossingSelection(root, ignoreDiagnostic);

    expect([root.innerHTML, readSelectionEnds()]).toEqual([html, [root, 1, text, 1]]);
  });

  it('does not let an exception from the check escape, leaves the selection unchanged, and records one diagnostic line', () => {
    const root = mountRoot(`<p>ab</p>${TABLE}`);
    const text = readChildText(readElement(root, 'p'), 0);
    const cell = readElement(root, 'td');
    const cellText = readChildText(cell, 0);
    select(createRange(text, 1, cellText, 1));
    Object.defineProperty(cell, 'contains', {
      value: () => {
        throw new Error('Could not walk the ancestors');
      },
    });
    const diagnostics: string[] = [];

    collapseStructureCrossingSelection(root, (detail) => diagnostics.push(detail));

    expect([readSelectionEnds(), diagnostics.length]).toEqual([[text, 1, cellText, 1], 1]);
  });
});
