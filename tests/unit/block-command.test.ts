import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readBlockSelection,
  restoreBlockSelection,
  runBlockOperation,
} from '../../webview/editing/block-command';
import type { BlockCommandPorts } from '../../webview/editing/block-command';
import { convertBlock } from '../../webview/editing/block-convert';
import { BLOCK_KIND } from '../../webview/editing/block-format';
import { readSelectionRange } from '../../webview/editing/caret';
import { LIST_KIND } from '../../webview/editing/list-structure';
import { ensureTargetBlock } from '../../webview/editing/target-block';
import {
  createRange,
  mountRoot,
  readChildText,
  readElement,
  select,
} from './helpers/format-dom';

/** The ports to replace. Any port left out behaves as it does in the real environment. */
interface PortOverrides {
  readonly isComposing?: () => boolean;
  readonly isInputStopped?: () => boolean;
  readonly runCommandEdit?: (kind: string, command: () => boolean) => boolean;
  readonly ensureTargetBlock?: () => Element | undefined;
}

/**
 * Creates a stub of the block command ports together with a record of the calls.
 *
 * The command path, like the editing session, closes the edit attempt as complete only when the tree was
 * changed. Unless it is called in the same order as in the real environment, there is no way to tell whether an
 * attempt was opened.
 *
 * @param root The editor root.
 * @param overrides The ports to replace.
 * @returns The ports, together with the records of diagnostics and attempts.
 */
function createPorts(root: HTMLElement, overrides: PortOverrides = {}): {
  ports: BlockCommandPorts;
  diagnostics: string[];
  attempts: string[];
} {
  const diagnostics: string[] = [];
  const attempts: string[] = [];
  const ports: BlockCommandPorts = {
    readEditorRoot: () => root,
    isComposing: overrides.isComposing ?? (() => false),
    isInputStopped: overrides.isInputStopped ?? (() => false),
    runCommandEdit: overrides.runCommandEdit ?? ((kind, command) => {
      attempts.push(`begin:${kind}`);
      const changed = command();
      attempts.push(changed ? 'complete' : 'abort');
      return changed;
    }),
    ensureTargetBlock: overrides.ensureTargetBlock
      ?? (() => ensureTargetBlock(root, readSelectionRange(root))),
    reportDiagnostic: (detail) => diagnostics.push(detail),
  };
  return { ports, diagnostics, attempts };
}

/**
 * Selects text inside the editor root.
 *
 * @param root The editor root.
 * @param selector The CSS selector that finds the element holding the text.
 * @param start The position of the start point.
 * @param end The position of the end point.
 */
function selectText(root: Element, selector: string, start: number, end: number): void {
  const text = readChildText(readElement(root, selector), 0);
  select(createRange(text, start, text, end));
}

/** Selects a paragraph outside the editor root. */
function selectOutside(): void {
  const outside = document.createElement('p');
  outside.textContent = 'xy';
  document.body.append(outside);
  const text = readChildText(outside, 0);
  select(createRange(text, 0, text, 2));
}

describe('accepting a block operation', () => {
  it('opens no attempt, changes nothing, and returns false while input is stopped', () => {
    const root = mountRoot('<p>ab</p>');
    selectText(root, 'p', 0, 2);
    const { ports, attempts } = createPorts(root, { isInputStopped: () => true });

    const changed = runBlockOperation(ports, { kind: 'convert', to: BLOCK_KIND.heading2 }, 'command');

    expect([changed, attempts, root.innerHTML]).toEqual([false, [], '<p>ab</p>']);
  });

  it('opens no attempt, changes nothing, and returns false during an IME composition', () => {
    const root = mountRoot('<p>ab</p>');
    selectText(root, 'p', 0, 2);
    const { ports, attempts } = createPorts(root, { isComposing: () => true });

    const changed = runBlockOperation(ports, { kind: 'convert', to: BLOCK_KIND.heading2 }, 'command');

    expect([changed, attempts, root.innerHTML]).toEqual([false, [], '<p>ab</p>']);
  });

  it('changes nothing and returns false when the selection is outside a editor root that is not effectively empty', () => {
    const root = mountRoot('<p>ab</p>');
    selectOutside();
    const { ports } = createPorts(root);

    const changed = runBlockOperation(ports, { kind: 'convert', to: BLOCK_KIND.heading2 }, 'command');

    expect([changed, root.innerHTML]).toEqual([false, '<p>ab</p>']);
  });

  it('changes nothing and returns false when the command path cannot be started', () => {
    const root = mountRoot('<p>ab</p>');
    selectText(root, 'p', 0, 2);
    const { ports } = createPorts(root, { runCommandEdit: () => false });

    const changed = runBlockOperation(ports, { kind: 'convert', to: BLOCK_KIND.heading2 }, 'command');

    expect([changed, root.innerHTML]).toEqual([false, '<p>ab</p>']);
  });

  it('does not call the command path or open an attempt for a rule trigger', () => {
    const root = mountRoot('<p>ab</p>');
    selectText(root, 'p', 0, 2);
    const { ports, attempts } = createPorts(root);

    const changed = runBlockOperation(ports, { kind: 'convert', to: BLOCK_KIND.heading2 }, 'rule');

    expect([changed, attempts, root.innerHTML]).toEqual([true, [], '<h2>ab</h2>']);
  });

  it('lets no exception escape, leaves one diagnostic line, and returns true when a rewrite throws after changing the tree', () => {
    const root = mountRoot('ab<hr>cd');
    select(createRange(readChildText(root, 0), 0, readChildText(root, 2), 2));
    let calls = 0;
    const { ports, diagnostics } = createPorts(root, {
      ensureTargetBlock: () => {
        calls += 1;
        if (calls === 2) {
          throw new Error('could not ensure a target block');
        }
        return ensureTargetBlock(root, readSelectionRange(root));
      },
    });

    const changed = runBlockOperation(ports, { kind: 'convert', to: BLOCK_KIND.heading2 }, 'command');

    // One run was wrapped before the exception, and that is what counts as "the tree was changed".
    expect([changed, diagnostics.length, root.querySelectorAll('p').length]).toEqual([true, 1, 1]);
  });

  it('leaves one diagnostic line and returns false when an exception is thrown without changing the tree', () => {
    const root = mountRoot('ab');
    const text = readChildText(root, 0);
    select(createRange(text, 0, text, 2));
    const { ports, diagnostics } = createPorts(root, {
      ensureTargetBlock: () => {
        throw new Error('could not ensure a target block');
      },
    });

    const changed = runBlockOperation(ports, { kind: 'convert', to: BLOCK_KIND.heading2 }, 'command');

    expect([changed, diagnostics.length, root.innerHTML]).toEqual([false, 1, 'ab']);
  });

  it('makes paragraph the target kind of the code block toggle when the first target is a code block', () => {
    const root = mountRoot('<pre><code>ab</code></pre>');
    selectText(root, 'code', 0, 2);
    const { ports } = createPorts(root);

    const changed = runBlockOperation(ports, { kind: 'toggleCodeBlock' }, 'command');

    expect([changed, root.innerHTML]).toEqual([true, '<p>ab</p>']);
  });

  it('splits the lines of a bare blockquote rather than replacing it when the first target of the code block toggle is that blockquote', () => {
    const root = mountRoot('<blockquote>ab<br>cd<br>ef</blockquote>');
    const text = readChildText(readElement(root, 'blockquote'), 2);
    select(createRange(text, 1, text, 1));
    const { ports } = createPorts(root);

    const changed = runBlockOperation(ports, { kind: 'toggleCodeBlock' }, 'command');

    expect([changed, root.innerHTML])
      .toEqual([true, '<blockquote><p>ab</p>\n<pre><code>cd</code></pre>\n<p>ef</p></blockquote>']);
  });

  it('turns a paragraph and the first line of a bare blockquote into code blocks each and keeps the selection over the same string', () => {
    const root = mountRoot('<p>ab</p>\n<blockquote>cd<br>ef</blockquote>');
    select(createRange(
      readChildText(readElement(root, 'p'), 0),
      1,
      readChildText(readElement(root, 'blockquote'), 0),
      1,
    ));
    const { ports } = createPorts(root);

    runBlockOperation(ports, { kind: 'toggleCodeBlock' }, 'command');

    expect([root.innerHTML, window.getSelection()?.toString()]).toEqual([
      '<pre><code>ab</code></pre>\n<blockquote><pre><code>cd</code></pre>\n<p>ef</p></blockquote>',
      'b\nc',
    ]);
  });

  it('opens and completes an alert operation as one edit attempt, the same way a kind conversion does', () => {
    const root = mountRoot('<p>ab</p>');
    selectText(root, 'p', 0, 2);
    const { ports, attempts } = createPorts(root);

    const changed = runBlockOperation(ports, { kind: 'alert', to: 'note' }, 'command');

    expect([changed, attempts, root.innerHTML])
      .toEqual([true, ['begin:block:alert', 'complete'], '<blockquote data-alert="note">ab</blockquote>']);
  });

  it('closes the attempt as an abort and returns false for an alert operation that rewrote nothing', () => {
    const root = mountRoot('<ul><li>ab</li></ul>');
    selectText(root, 'li', 0, 2);
    const { ports, attempts } = createPorts(root);

    const changed = runBlockOperation(ports, { kind: 'alert', to: 'note' }, 'command');

    expect([changed, attempts, root.innerHTML])
      .toEqual([false, ['begin:block:alert', 'abort'], '<ul><li>ab</li></ul>']);
  });

  it('opens and completes inserting a collapsible section as one edit attempt', () => {
    const root = mountRoot('<p>ab</p>');
    selectText(root, 'p', 2, 2);
    const { ports, attempts } = createPorts(root);

    const changed = runBlockOperation(ports, { kind: 'insertDetails' }, 'command');

    expect([changed, attempts, root.querySelectorAll('details').length])
      .toEqual([true, ['begin:block:insertDetails', 'complete'], 1]);
  });

  it('closes inserting a collapsible section as aborted when the reference is a summary', () => {
    const root = mountRoot('<details open=""><summary>ab</summary></details>');
    selectText(root, 'summary', 0, 2);
    const { ports, attempts } = createPorts(root);

    const changed = runBlockOperation(ports, { kind: 'insertDetails' }, 'command');

    expect([changed, attempts, root.innerHTML])
      .toEqual([false, ['begin:block:insertDetails', 'abort'], '<details open=""><summary>ab</summary></details>']);
  });

  it('splits the list when inserting a collapsible section with an item as the reference, and closes the attempt as complete', () => {
    const root = mountRoot('<ul><li>a</li><li>b</li></ul>');
    selectText(root, 'li', 1, 1);
    const { ports, attempts } = createPorts(root);

    const changed = runBlockOperation(ports, { kind: 'insertDetails' }, 'command');

    expect([changed, attempts, root.querySelectorAll(':scope > ul').length, readElement(root, 'details').parentElement])
      .toEqual([true, ['begin:block:insertDetails', 'complete'], 2, root]);
  });

  it('opens and completes inserting a diagram source block as one edit attempt, keeping the caret it placed after the block', () => {
    const root = mountRoot('<p>ab</p>');
    selectText(root, 'p', 2, 2);
    const { ports, attempts } = createPorts(root);

    const changed = runBlockOperation(ports, { kind: 'insertDiagram' }, 'command');

    // The restore would put the caret back into the paragraph before the diagram; the insert put it after.
    expect([changed, attempts, window.getSelection()?.anchorNode === root.querySelectorAll('p')[1]])
      .toEqual([true, ['begin:block:insertDiagram', 'complete'], true]);
  });

  it('splits the list when inserting a diagram source block with an item as the reference', () => {
    const root = mountRoot('<ul><li>a</li><li>b</li></ul>');
    selectText(root, 'li', 1, 1);
    const { ports } = createPorts(root);

    runBlockOperation(ports, { kind: 'insertDiagram' }, 'command');

    expect([root.querySelectorAll(':scope > ul').length, readElement(root, 'pre.mermaid').parentElement])
      .toEqual([2, root]);
  });

  it('opens and completes a list toggle as one edit attempt with the edit kind block:toggleList', () => {
    const root = mountRoot('<p>ab</p>');
    selectText(root, 'p', 1, 1);
    const { ports, attempts } = createPorts(root);

    const changed = runBlockOperation(ports, { kind: 'toggleList', to: LIST_KIND.bullet }, 'command');

    expect([changed, attempts, root.innerHTML])
      .toEqual([true, ['begin:block:toggleList', 'complete'], '<ul><li>ab</li></ul>']);
  });

  it('makes the cell the only target for a bulleted list from a range inside a section that is a child of the cell, and closes the attempt as aborted', () => {
    // A cell of bare text is wrapped in a paragraph that becomes the target. A range inside an element among the
    // cell's children that is not phrasing content is not wrapped, so the cell is the only target.
    const root = mountRoot('<table><tbody><tr><td><section>ab</section></td></tr></tbody></table>');
    selectText(root, 'section', 0, 2);
    const before = root.innerHTML;
    const { ports, attempts } = createPorts(root);

    const changed = runBlockOperation(ports, { kind: 'toggleList', to: LIST_KIND.bullet }, 'command');

    expect([changed, attempts, root.innerHTML]).toEqual([false, ['begin:block:toggleList', 'abort'], before]);
  });

  it('does not run selection restoration for inserting a collapsible section, so the caret is not overwritten', () => {
    const root = mountRoot('<p>ab</p>');
    selectText(root, 'p', 2, 2);
    const { ports } = createPorts(root);

    runBlockOperation(ports, { kind: 'insertDetails' }, 'command');

    const anchor = window.getSelection()?.anchorNode ?? root;
    expect(readElement(root, 'summary').contains(anchor)).toBe(true);
  });

  it('changes neither the tree nor the selection and returns false when no target is convertible', () => {
    const root = mountRoot('<ul><li>ab</li></ul>');
    selectText(root, 'li', 0, 2);
    const { ports } = createPorts(root);

    const changed = runBlockOperation(ports, { kind: 'convert', to: BLOCK_KIND.heading2 }, 'command');

    expect([changed, root.innerHTML, window.getSelection()?.toString()])
      .toEqual([false, '<ul><li>ab</li></ul>', 'ab']);
  });
});

describe('block operations from a bare run in a cell', () => {
  it('creates an empty heading in the cell with the caret inside it when converting to a heading in an empty cell with only a br', () => {
    const root = mountRoot('<table><tbody><tr><td><br></td></tr></tbody></table>');
    const cell = readElement(root, 'td');
    select(createRange(cell, 0, cell, 0));
    const { ports } = createPorts(root);

    runBlockOperation(ports, { kind: 'convert', to: BLOCK_KIND.heading2 }, 'command');

    const anchor = window.getSelection()?.anchorNode ?? root;
    expect([cell.innerHTML, readElement(cell, 'h2').contains(anchor)]).toEqual(['\n<h2><br></h2>', true]);
  });

  it('keeps that paragraph as the only target, as before, when the start is inside a paragraph in a cell, and does not wrap the bare run in the same cell', () => {
    const root = mountRoot('<table><tbody><tr><td><p>ab</p>cd</td></tr></tbody></table>');
    selectText(root, 'td p', 1, 1);
    const { ports } = createPorts(root);

    runBlockOperation(ports, { kind: 'convert', to: BLOCK_KIND.heading2 }, 'command');

    expect(readElement(root, 'td').innerHTML).toBe('<h2>ab</h2>cd');
  });
});

describe('insert table', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens insert table as one edit attempt and closes it as completed', () => {
    const root = mountRoot('<p>ab</p>');
    selectText(root, 'p', 2, 2);
    const { ports, attempts } = createPorts(root);

    const changed = runBlockOperation(ports, { kind: 'insertTable', rows: 2, columns: 2 }, 'command');

    expect([changed, attempts, root.querySelectorAll('table').length])
      .toEqual([true, ['begin:block:insertTable', 'complete'], 1]);
  });

  it('when the target block is a summary, closes the attempt as aborted and returns false', () => {
    const html = '<details open=""><summary>ab</summary></details>';
    const root = mountRoot(html);
    selectText(root, 'summary', 0, 2);
    const { ports, attempts } = createPorts(root);

    const changed = runBlockOperation(ports, { kind: 'insertTable', rows: 2, columns: 2 }, 'command');

    expect([changed, attempts, root.innerHTML]).toEqual([false, ['begin:block:insertTable', 'abort'], html]);
  });

  it('when the target block is a paragraph that is an item line, inserts the table inside the item without splitting the list', () => {
    const root = mountRoot('<ul><li><p>a</p></li><li><p>b</p></li></ul>');
    selectText(root, 'p', 1, 1);
    const { ports } = createPorts(root);

    runBlockOperation(ports, { kind: 'insertTable', rows: 1, columns: 1 }, 'command');

    expect([root.querySelectorAll('ul').length, readElement(root, 'table').parentElement?.localName])
      .toEqual([1, 'li']);
  });

  it('insert table does not restore the selection, so the caret in the first cell is not overwritten', () => {
    const root = mountRoot('<p>ab</p>');
    selectText(root, 'p', 1, 2);
    const { ports } = createPorts(root);

    runBlockOperation(ports, { kind: 'insertTable', rows: 2, columns: 2 }, 'command');

    const selection = window.getSelection();
    expect([selection?.isCollapsed, selection?.anchorNode, selection?.anchorOffset])
      .toEqual([true, readElement(root, 'th'), 0]);
  });

  it('when an exception occurs while inserting the table, it does not escape, one diagnostic line is left, and the changed tree is closed as completed', () => {
    const root = mountRoot('<p>ab</p>');
    selectText(root, 'p', 2, 2);
    const { ports, diagnostics, attempts } = createPorts(root);
    // Fail at the point of creating the empty paragraph added after the table, once the table is in.
    const original = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((name: string, options?: ElementCreationOptions) => {
      if (name === 'p') {
        throw new Error('could not create the paragraph');
      }
      return original(name, options);
    });

    const changed = runBlockOperation(ports, { kind: 'insertTable', rows: 1, columns: 1 }, 'command');

    expect([changed, diagnostics.length, attempts, root.querySelectorAll('table').length])
      .toEqual([true, 1, ['begin:block:insertTable', 'complete'], 1]);
  });
});

describe('recording the selection across an operation', () => {
  it('skips whitespace-only text between blocks and counts a br as one character', () => {
    const root = mountRoot('\n<p>ab<br>cd</p>\n<p>ef</p>');
    selectText(root, 'p:last-of-type', 0, 1);

    expect(readBlockSelection(root)).toEqual({ start: 5, end: 6 });
  });

  it('records the element together with its ordinal for a caret inside an empty block', () => {
    const root = mountRoot('\n<p>ab</p>\n<p><br></p>\n');
    const empty = readElement(root, 'p:last-of-type');
    select(createRange(empty, 0, empty, 0));

    expect(readBlockSelection(root)).toEqual({ start: 2, end: 2, emptyBlock: { index: 1, element: empty } });
  });

  it('restores into the recorded empty block while it remains, even when fewer blocks before it shift the ordinal', () => {
    const root = mountRoot('\n<p>ab</p>\n<p>cd</p>\n<p><br></p>\n');
    const empty = readElement(root, 'p:last-of-type');
    select(createRange(empty, 0, empty, 0));
    const captured = readBlockSelection(root);
    if (captured === undefined) {
      throw new Error('could not record the selection');
    }

    readElement(root, 'p').remove();
    restoreBlockSelection(root, captured);

    expect(window.getSelection()?.anchorNode).toBe(empty);
  });

  it('covers the same string as before the operation when the recorded position is restored', () => {
    const root = mountRoot('\n<p>abcd</p>\n');
    selectText(root, 'p', 1, 3);
    const captured = readBlockSelection(root);
    if (captured === undefined) {
      throw new Error('could not record the selection');
    }

    convertBlock(readElement(root, 'p'), BLOCK_KIND.heading2);
    restoreBlockSelection(root, captured);

    expect(window.getSelection()?.toString()).toBe('bc');
  });

  it('returns into the same block after the conversion, not into the neighbour, for a record holding an index', () => {
    const root = mountRoot('\n<p>ab</p>\n<p><br></p>\n');
    const empty = readElement(root, 'p:last-of-type');
    select(createRange(empty, 0, empty, 0));
    const { ports } = createPorts(root);

    runBlockOperation(ports, { kind: 'convert', to: BLOCK_KIND.heading2 }, 'command');

    const anchor = window.getSelection()?.anchorNode ?? root;
    expect([root.innerHTML, readElement(root, 'h2').contains(anchor)])
      .toEqual(['\n<p>ab</p>\n<h2><br></h2>\n', true]);
  });
});

describe('block conversion at a between-blocks position', () => {
  const TABLE = '<table><tbody><tr><td>a</td></tr></tbody></table>';

  it('converting to a heading with the caret directly under the editor root right after a table turns the paragraph created right after the table into a heading with the caret inside', () => {
    const root = mountRoot(`${TABLE}\n<p>ab</p>`);
    select(createRange(root, 1, root, 1));
    const { ports } = createPorts(root);

    const changed = runBlockOperation(ports, { kind: 'convert', to: BLOCK_KIND.heading2 }, 'command');

    const anchor = window.getSelection()?.anchorNode ?? root;
    expect([changed, root.innerHTML, readElement(root, 'h2').contains(anchor)])
      .toEqual([true, `${TABLE}\n<h2><br></h2>\n<p>ab</p>`, true]);
  });

  it('converting a range whose start is at a between-blocks position creates no paragraph and changes only the blocks the range overlaps', () => {
    const root = mountRoot(`${TABLE}\n<p>ab</p>\n<p>cd</p>`);
    select(createRange(root, 1, readChildText(readElement(root, 'p'), 0), 1));
    const { ports } = createPorts(root);

    const changed = runBlockOperation(ports, { kind: 'convert', to: BLOCK_KIND.heading2 }, 'command');

    expect([changed, root.innerHTML]).toEqual([true, `${TABLE}\n<h2>ab</h2>\n<p>cd</p>`]);
  });
});
