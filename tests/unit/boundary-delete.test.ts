import { describe, expect, it } from 'vitest';

import type { BlockCommandPorts } from '../../webview/editing/block-command';
import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import {
  applyBoundaryDelete,
  findEmptyBlockBesideCode,
  findStructureBesideEmptyBlock,
  hasTypableLineBeyond,
  readBoundaryDelete,
  removeEmptyBlock,
} from '../../webview/editing/boundary-delete';
import type { BoundaryDelete } from '../../webview/editing/boundary-delete';
import { readSelectionRange } from '../../webview/editing/caret';
import type { DeleteKind } from '../../webview/editing/delete-rule';
import { ensureTargetBlock } from '../../webview/editing/target-block';
import {
  createRange,
  createRoot,
  mountRoot,
  readChildText,
  readElement,
  select,
} from './helpers/format-dom';

const TABLE = '<table><tbody><tr><td>a</td></tr></tbody></table>';

const BACKWARD: DeleteKind = { backward: true, line: false, granularity: 'character' };
const FORWARD: DeleteKind = { backward: false, line: false, granularity: 'character' };
const WORD_BACKWARD: DeleteKind = { backward: true, line: false, granularity: 'word' };
const LINE_BACKWARD: DeleteKind = { backward: true, line: true, granularity: 'lineboundary' };

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
 * Reads the current caret position.
 *
 * @returns The node and offset of the caret.
 */
function readCaret(): unknown[] {
  const selection = window.getSelection();
  return [selection?.anchorNode, selection?.anchorOffset];
}

/**
 * Creates the block command ports. Among the boundary delete steps, only the blank code block uses them, for block conversion.
 *
 * @param root The editor root.
 * @returns The block command ports.
 */
function createPorts(root: HTMLElement): BlockCommandPorts {
  return {
    readEditorRoot: () => root,
    isComposing: () => false,
    isInputStopped: () => false,
    runCommandEdit: (_kind, command) => command(),
    ensureTargetBlock: () => ensureTargetBlock(root, readSelectionRange(root)),
    reportDiagnostic: () => undefined,
  };
}

/**
 * Reads the step matched at the caret position, failing if none matches.
 *
 * @param root The editor root.
 * @param range The caret range.
 * @param kind The delete kind.
 * @returns The matched step.
 */
function readStep(root: Element, range: Range, kind: DeleteKind): BoundaryDelete {
  const step = readBoundaryDelete(root, range, kind);
  if (step === undefined) {
    throw new Error('no boundary delete');
  }
  return step;
}

describe('deciding the boundary delete step', () => {
  it('returns no match when there is a range selection', () => {
    const root = createRoot(`${TABLE}\n<p>ab</p>`);
    const text = readChildText(readElement(root, 'p'), 0);

    expect(readBoundaryDelete(root, createRange(text, 0, text, 1), BACKWARD)).toBeUndefined();
  });

  it('returns the blank code block step for a character delete in a blank code block', () => {
    const root = createRoot('<pre><code></code></pre>');
    const code = readElement(root, 'code');

    expect([
      readBoundaryDelete(root, caretAt(code, 0), BACKWARD),
      readBoundaryDelete(root, caretAt(code, 0), FORWARD),
    ]).toEqual([{ kind: 'blankCodeBlock' }, { kind: 'blankCodeBlock' }]);
  });

  it('returns the blank code block step also for a code block whose code holds only a trailing pre break', () => {
    const root = createRoot('<pre><code>\n</code></pre>');
    const text = readChildText(readElement(root, 'code'), 0);

    expect(readBoundaryDelete(root, caretAt(text, 0), BACKWARD)).toEqual({ kind: 'blankCodeBlock' });
  });

  it('returns the noop step for a line delete in a blank code block', () => {
    const root = createRoot('<pre><code></code></pre>');

    expect(readBoundaryDelete(root, caretAt(readElement(root, 'code'), 0), LINE_BACKWARD)).toEqual({ kind: 'noop' });
  });

  it('returns the noop step for a backward delete at the start of a non-empty paragraph right after a table', () => {
    const root = createRoot(`${TABLE}\n<p>ab</p>`);
    const text = readChildText(readElement(root, 'p'), 0);

    expect(readBoundaryDelete(root, caretAt(text, 0), BACKWARD)).toEqual({ kind: 'noop' });
  });

  it('returns the noop step for a forward delete directly under the editor root right after a table', () => {
    const root = createRoot(`${TABLE}\n<p>ab</p>`);

    expect(readBoundaryDelete(root, caretAt(root, 1), FORWARD)).toEqual({ kind: 'noop' });
  });

  it('returns no match for a delete in the middle of cell text and for a delete at the border between paragraphs', () => {
    const root = createRoot('<table><tbody><tr><td>abc</td></tr></tbody></table>\n<p>xy</p>\n<p>zw</p>');
    const cell = readChildText(readElement(root, 'td'), 0);
    const second = readChildText(readElement(root, 'p:last-of-type'), 0);

    expect([
      readBoundaryDelete(root, caretAt(cell, 1), BACKWARD),
      readBoundaryDelete(root, caretAt(second, 0), BACKWARD),
    ]).toEqual([undefined, undefined]);
  });

  it('returns the same step for a word backward delete as for a character delete at the same position', () => {
    const blank = createRoot('<pre><code></code></pre>');
    const empty = createRoot(`${TABLE}\n<p><br></p>`);
    const filled = createRoot(`${TABLE}\n<p>ab</p>`);
    const carets: [Element, Range][] = [
      [blank, caretAt(readElement(blank, 'code'), 0)],
      [empty, caretAt(readElement(empty, 'p'), 0)],
      [filled, caretAt(readChildText(readElement(filled, 'p'), 0), 0)],
    ];

    const words = carets.map(([root, range]) => readBoundaryDelete(root, range, WORD_BACKWARD));
    const characters = carets.map(([root, range]) => readBoundaryDelete(root, range, BACKWARD));

    expect([words.map((step) => step?.kind), words]).toEqual([
      ['blankCodeBlock', 'emptyBesideStructure', 'noop'],
      characters,
    ]);
  });

  it('returns noop, not the empty standalone block step, for a line delete in an empty paragraph right after a table', () => {
    const root = createRoot(`${TABLE}\n<p><br></p>`);

    expect(readBoundaryDelete(root, caretAt(readElement(root, 'p'), 0), LINE_BACKWARD)).toEqual({ kind: 'noop' });
  });

  it('returns the noop step in an empty paragraph right after a closed details section without a title', () => {
    const root = createRoot('<details><p>x</p></details>\n<p><br></p>');
    const empty = readElement(root, ':scope > p');

    expect(readBoundaryDelete(root, caretAt(empty, 0), BACKWARD)).toEqual({ kind: 'noop' });
  });

  it('returns the unwrap step carrying the title for a character backward delete at the start of the title', () => {
    const root = createRoot('<details open=""><summary>title</summary><p>body</p></details>');
    const title = readElement(root, 'summary');

    const step = readBoundaryDelete(root, caretAt(readChildText(title, 0), 0), BACKWARD);

    expect([step?.kind, step?.kind === 'unwrapDetails' && step.title === title]).toEqual(['unwrapDetails', true]);
  });

  it('at the start of the title, returns the same unwrap step for a word backward delete and the noop step for a line backward delete', () => {
    const root = createRoot('<details open=""><summary>title</summary><p>body</p></details>');
    const title = readElement(root, 'summary');
    const text = readChildText(title, 0);

    const word = readBoundaryDelete(root, caretAt(text, 0), WORD_BACKWARD);

    expect([
      word?.kind === 'unwrapDetails' && word.title === title,
      readBoundaryDelete(root, caretAt(text, 0), LINE_BACKWARD),
    ]).toEqual([true, { kind: 'noop' }]);
  });
});

describe('empty standalone block next to a structure', () => {
  it('returns the paragraph and the table backward in an empty paragraph right after a table', () => {
    const root = createRoot(`${TABLE}\n<p><br></p>`);
    const empty = readElement(root, 'p');

    const found = findStructureBesideEmptyBlock(root, caretAt(empty, 0), 'backward');

    expect([found?.empty === empty, found?.structure === readElement(root, 'table')]).toEqual([true, true]);
  });

  it('returns a match forward in an empty paragraph right before a list, but not backward in an empty paragraph right after a list whose last item ends with a paragraph', () => {
    const before = createRoot('<p><br></p>\n<ul><li>a</li></ul>');
    const after = createRoot('<ul><li>\n<p>a</p>\n</li></ul>\n<p><br></p>');

    const forward = findStructureBesideEmptyBlock(before, caretAt(readElement(before, 'p'), 0), 'forward');
    const backward = findStructureBesideEmptyBlock(after, caretAt(readElement(after, ':scope > p'), 0), 'backward');

    expect([forward?.structure === readElement(before, 'ul'), backward]).toEqual([true, undefined]);
  });

  it('returns the paragraph and the list backward in an empty paragraph right after a list whose last item ends with a table', () => {
    const root = createRoot(`<ul><li>a${TABLE}</li></ul>\n<p><br></p>`);
    const empty = readElement(root, ':scope > p');

    const found = findStructureBesideEmptyBlock(root, caretAt(empty, 0), 'backward');

    expect([found?.empty === empty, found?.structure === readElement(root, 'ul')]).toEqual([true, true]);
  });

  it('returns nothing for an empty item, a non-empty paragraph, or the last empty paragraph in a blockquote (the outer table is not a sibling)', () => {
    const item = createRoot(`${TABLE}\n<ul><li><br></li></ul>`);
    const filled = createRoot(`${TABLE}\n<p>ab</p>`);
    const quoted = createRoot(`<blockquote><p>a</p><p><br></p></blockquote>\n${TABLE}`);

    expect([
      findStructureBesideEmptyBlock(item, caretAt(readElement(item, 'li'), 0), 'backward'),
      findStructureBesideEmptyBlock(filled, caretAt(readChildText(readElement(filled, 'p'), 0), 0), 'backward'),
      findStructureBesideEmptyBlock(quoted, caretAt(readElement(quoted, 'p:last-of-type'), 0), 'forward'),
    ]).toEqual([undefined, undefined, undefined]);
  });
});

describe('typable line on the opposite side', () => {
  it('returns true if the sibling on that side is a paragraph, and false if there is none or it is a table, list or horizontal rule', () => {
    const root = createRoot(
      `<p id="first"><br></p>\n<p>a</p>\n<p id="text"><br></p>\n${TABLE}\n<p id="table"><br></p>\n`
      + '<ul><li>b</li></ul>\n<p id="list"><br></p>\n<hr>',
    );
    const judge = (id: string, side: 'backward' | 'forward'): boolean =>
      hasTypableLineBeyond(readElement(root, `#${id}`), side);

    expect([
      judge('text', 'backward'),
      judge('first', 'backward'),
      judge('table', 'backward'),
      judge('list', 'backward'),
      judge('list', 'forward'),
    ]).toEqual([true, false, false, false, false]);
  });
});

describe('empty standalone block next to a code block', () => {
  it('returns the empty paragraph right after pre forward at the end of code', () => {
    const root = createRoot('<pre><code>ab</code></pre>\n<p><br></p>');
    const text = readChildText(readElement(root, 'code'), 0);

    expect(findEmptyBlockBesideCode(root, caretAt(text, 2), 'forward')).toBe(readElement(root, 'p'));
  });

  it('returns nothing before a line break that forms a blank line, but returns it before the trailing pre break', () => {
    const blankLine = createRoot('<pre><code>ab\n\n</code></pre>\n<p><br></p>');
    const trailing = createRoot('<pre><code>ab\n</code></pre>\n<p><br></p>');
    const blankLineText = readChildText(readElement(blankLine, 'code'), 0);
    const trailingText = readChildText(readElement(trailing, 'code'), 0);

    expect([
      findEmptyBlockBesideCode(blankLine, caretAt(blankLineText, 2), 'forward'),
      findEmptyBlockBesideCode(trailing, caretAt(trailingText, 2), 'forward') === readElement(trailing, 'p'),
    ]).toEqual([undefined, true]);
  });
});

describe('removing an empty standalone block', () => {
  it('removes the empty standalone block together with the line break text before it and sets the progress to true', () => {
    const root = createRoot('<p>a</p>\n<p id="empty"><br></p>\n<p>b</p>');
    const progress: BlockRewriteProgress = { changed: false };

    removeEmptyBlock(readElement(root, '#empty'), progress);

    expect([root.innerHTML, progress.changed]).toEqual(['<p>a</p>\n<p>b</p>', true]);
  });

  it('removes an empty paragraph with id and style the same way', () => {
    const root = createRoot('<p>a</p>\n<p id="empty" style="color: red;"><br></p>\n<p>b</p>');

    removeEmptyBlock(readElement(root, '#empty'), { changed: false });

    expect(root.innerHTML).toBe('<p>a</p>\n<p>b</p>');
  });
});

describe('running the boundary delete step', () => {
  it('for a removable empty standalone block next to a structure, removes the block, places the caret at the placement and returns edited', () => {
    const root = mountRoot(`${TABLE}\n<p id="empty"><br></p>\n<p>b</p>`);
    const cell = readChildText(readElement(root, 'td'), 0);
    const range = caretAt(readElement(root, '#empty'), 0);
    select(range.cloneRange());
    const progress: BlockRewriteProgress = { changed: false };

    const result = applyBoundaryDelete(readStep(root, range, BACKWARD), range, createPorts(root), progress);

    expect([
      result,
      progress.changed,
      root.innerHTML,
      readCaret(),
      [range.startContainer === cell, range.startOffset],
    ]).toEqual(['edited', true, `${TABLE}\n<p>b</p>`, [cell, 1], [true, 1]]);
  });

  it('for a non-removable empty standalone block next to a structure, leaves the tree unchanged, moves only the caret to the placement and returns consumed', () => {
    const html = `${TABLE}\n<p><br></p>`;
    const root = mountRoot(html);
    const cell = readChildText(readElement(root, 'td'), 0);
    const range = caretAt(readElement(root, 'p'), 0);
    select(range.cloneRange());
    const progress: BlockRewriteProgress = { changed: false };

    const result = applyBoundaryDelete(readStep(root, range, BACKWARD), range, createPorts(root), progress);

    expect([result, progress.changed, root.innerHTML, readCaret()]).toEqual(['consumed', false, html, [cell, 1]]);
  });

  it('given the noop step, changes neither the tree nor the caret and returns consumed', () => {
    const html = `${TABLE}\n<p>ab</p>`;
    const root = mountRoot(html);
    const text = readChildText(readElement(root, 'p'), 0);
    const range = caretAt(text, 0);
    select(range.cloneRange());
    const progress: BlockRewriteProgress = { changed: false };

    const result = applyBoundaryDelete({ kind: 'noop' }, range, createPorts(root), progress);

    expect([
      result,
      root.innerHTML,
      readCaret(),
      [range.startContainer === text, range.startOffset],
    ]).toEqual(['consumed', html, [text, 0], [true, 0]]);
  });

  it('given the unwrap step, replaces the details section with the title paragraph and the body, places the caret and the range at the start of the paragraph, and returns edited', () => {
    const root = mountRoot('<details open="">\n<summary>title</summary>\n<p>body</p>\n</details>');
    const text = readChildText(readElement(root, 'summary'), 0);
    const range = caretAt(text, 0);
    select(range.cloneRange());
    const progress: BlockRewriteProgress = { changed: false };

    const result = applyBoundaryDelete(readStep(root, range, BACKWARD), range, createPorts(root), progress);

    expect([
      result,
      root.innerHTML,
      readCaret(),
      [range.startContainer === text, range.startOffset],
    ]).toEqual(['edited', '<p>title</p>\n<p>body</p>', [text, 0], [true, 0]]);
  });
});
