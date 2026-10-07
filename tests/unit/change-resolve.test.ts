import { describe, expect, it } from 'vitest';

import type { EncodedSelection } from '../../common/index';
import { CHANGE_EDIT_KIND, resolveAllChanges, resolveChange } from '../../webview/editing/change-resolve';
import type { ChangeResolvePorts } from '../../webview/editing/change-resolve';
import { captureRange } from '../../webview/selection/selection-capture';
import { mountRoot, readElement } from './helpers/format-dom';

/** Ports to override. Omitted ports stop nothing, as in the real environment. */
interface PortOverrides {
  readonly isInputStopped?: () => boolean;
}

/** Ports and a record of how they were called. */
interface ResolveHarness {
  readonly ports: ChangeResolvePorts;
  readonly diagnostics: string[];
  /** Kinds of the opened attempts and how they closed (complete or abort), in order. */
  readonly attempts: string[];
  /** Selections attached to return requests. */
  readonly returns: (EncodedSelection | undefined)[];
}

/**
 * Creates a stand-in for the ports.
 *
 * As in the real environment, the command path closes as completed only when the tree was changed.
 *
 * @param root Editor root.
 * @param overrides Ports to override.
 * @returns Ports and records.
 */
function createPorts(root: HTMLElement, overrides: PortOverrides = {}): ResolveHarness {
  const diagnostics: string[] = [];
  const attempts: string[] = [];
  const returns: (EncodedSelection | undefined)[] = [];
  const ports: ChangeResolvePorts = {
    readEditorRoot: () => root,
    isInputStopped: overrides.isInputStopped ?? (() => false),
    runCommandEdit: (kind, command) => {
      attempts.push(`begin:${kind}`);
      const changed = command();
      attempts.push(changed ? 'complete' : 'abort');
      return changed;
    },
    requestReturn: (selection) => {
      returns.push(selection);
    },
    reportDiagnostic: (detail) => {
      diagnostics.push(detail);
    },
  };
  return { ports, diagnostics, attempts, returns };
}

/**
 * Encodes a position the same way the return request does, so that the place the caret goes to can be compared.
 *
 * @param root Editor root.
 * @param container The container of the position.
 * @param offset The offset in the container.
 */
function selectionAt(root: Element, container: Node, offset: number): EncodedSelection | undefined {
  const range = document.createRange();
  range.setStart(container, offset);
  range.collapse(true);
  return captureRange(root, range)?.selection;
}

describe('accepting and rejecting one change mark', () => {
  it('accepting an insertion keeps the content, unwraps the mark in one accept edit, and returns to the end of the content', () => {
    const root = mountRoot('<p>a<ins data-author="ai" data-updated="2026-10-07T00:00:00.000Z">b</ins>c</p><p>d</p>');
    const { ports, attempts, returns } = createPorts(root);
    const paragraph = readElement(root, 'p');

    const changed = resolveChange(ports, readElement(root, 'ins'), 'accept');

    expect([changed, root.innerHTML, attempts, returns]).toEqual([
      true,
      '<p>abc</p><p>d</p>',
      [`begin:${CHANGE_EDIT_KIND.accept}`, 'complete'],
      [selectionAt(root, paragraph, 2)],
    ]);
  });

  it('rejecting an insertion takes the content out in one reject edit and returns to the place it was taken out at', () => {
    const root = mountRoot('<p>a<ins>b</ins>c</p><p>d</p>');
    const { ports, attempts, returns } = createPorts(root);
    const paragraph = readElement(root, 'p');

    const changed = resolveChange(ports, readElement(root, 'ins'), 'reject');

    expect([changed, root.innerHTML, attempts, returns]).toEqual([
      true,
      '<p>ac</p><p>d</p>',
      [`begin:${CHANGE_EDIT_KIND.reject}`, 'complete'],
      [selectionAt(root, paragraph, 1)],
    ]);
  });

  it('accepting a deletion takes the content out, and rejecting it keeps the content and unwraps the mark', () => {
    const accepted = mountRoot('<p>a<del>b</del>c</p>');
    const acceptedPorts = createPorts(accepted);
    resolveChange(acceptedPorts.ports, readElement(accepted, 'del'), 'accept');
    const acceptedHtml = accepted.innerHTML;

    const rejected = mountRoot('<p>a<del>b</del>c</p>');
    const rejectedPorts = createPorts(rejected);
    resolveChange(rejectedPorts.ports, readElement(rejected, 'del'), 'reject');

    expect([acceptedHtml, rejected.innerHTML, acceptedPorts.attempts[0], rejectedPorts.attempts[0]]).toEqual([
      '<p>ac</p>',
      '<p>abc</p>',
      `begin:${CHANGE_EDIT_KIND.accept}`,
      `begin:${CHANGE_EDIT_KIND.reject}`,
    ]);
  });

  it('accepting a row that carries the kind removes only the three attributes and returns to the end of its last cell', () => {
    const root = mountRoot(
      '<table><tbody><tr id="r" data-change="ins" data-author="ai" data-updated="t" class="keep"><td>x</td><td>y</td></tr></tbody></table>',
    );
    const { ports, returns } = createPorts(root);

    resolveChange(ports, readElement(root, '#r'), 'accept');

    expect([root.innerHTML, returns]).toEqual([
      '<table><tbody><tr id="r" class="keep"><td>x</td><td>y</td></tr></tbody></table>',
      [selectionAt(root, readElement(root, 'td:last-child'), 1)],
    ]);
  });

  it('rejecting a row that carries the kind removes the row and returns to the start of the next row\'s first cell', () => {
    const root = mountRoot(
      '<table><tbody><tr data-change="ins"><td>x</td></tr><tr id="next"><td>y</td></tr></tbody></table>',
    );
    const { ports, returns } = createPorts(root);

    resolveChange(ports, readElement(root, 'tr'), 'reject');

    expect([root.innerHTML, returns]).toEqual([
      '<table><tbody><tr id="next"><td>y</td></tr></tbody></table>',
      [selectionAt(root, readElement(root, '#next > td'), 0)],
    ]);
  });

  it('gives the block an inline mark leaves empty its placeholder and returns to the start of the block', () => {
    const root = mountRoot('<p id="p"><ins>b</ins></p><p>c</p>');
    const { ports, returns } = createPorts(root);

    resolveChange(ports, readElement(root, 'ins'), 'reject');

    expect([root.innerHTML, returns]).toEqual(['<p id="p"><br></p><p>c</p>', [selectionAt(root, readElement(root, '#p'), 0)]]);
  });

  it('removes the list and the table that the last item or row taken out leaves empty, from the inside out', () => {
    const list = mountRoot('<p id="p">a</p><ul>\n<li data-change="ins">b</li>\n</ul><p id="n">c</p>');
    const listPorts = createPorts(list);
    resolveChange(listPorts.ports, readElement(list, 'li'), 'reject');
    const listExpected = selectionAt(list, readElement(list, '#n'), 0);

    const nested = mountRoot('<ul><li id="o">a<ul><li data-change="del">b</li></ul></li></ul>');
    resolveChange(createPorts(nested).ports, readElement(nested, 'li li'), 'accept');

    const table = mountRoot('<table><colgroup><col></colgroup><tbody><tr data-change="ins"><td>x</td></tr></tbody></table><p id="n">c</p>');
    resolveChange(createPorts(table).ports, readElement(table, 'tr'), 'reject');

    expect([list.innerHTML, listPorts.returns, nested.innerHTML, table.innerHTML]).toEqual([
      '<p id="p">a</p><p id="n">c</p>',
      [listExpected],
      '<ul><li id="o">a</li></ul>',
      '<p id="n">c</p>',
    ]);
  });

  it('gives the block that an element taken out leaves empty its placeholder and returns to the start of that block', () => {
    const root = mountRoot(
      '<blockquote id="q" data-alert="note"><p data-change="del">x</p></blockquote>'
      + '<ul><li id="o"><ol>\n<li data-change="del">b</li>\n</ol></li></ul>',
    );
    const { ports, returns } = createPorts(root);

    resolveChange(ports, readElement(root, 'blockquote > p'), 'accept');
    resolveChange(ports, readElement(root, 'ol > li'), 'accept');

    expect([root.innerHTML, returns]).toEqual([
      '<blockquote id="q" data-alert="note"><br></blockquote><ul><li id="o"><br></li></ul>',
      [selectionAt(root, readElement(root, '#q'), 0), selectionAt(root, readElement(root, '#o'), 0)],
    ]);
  });

  it('taking a mark out takes the comment and the nested marks inside it along', () => {
    const root = mountRoot('<p>a<del>x<comment id="c">y<comment-body>n</comment-body></comment><ins>z</ins></del>b</p>');
    const { ports } = createPorts(root);

    resolveChange(ports, readElement(root, 'del'), 'accept');

    expect(root.innerHTML).toBe('<p>ab</p>');
  });

  it('after taking an element out, returns to the end of the previous block when no block follows, and to the start of the root when there is no block', () => {
    const withPrevious = mountRoot('<p id="p">a</p><p data-change="ins">b</p>');
    const previousPorts = createPorts(withPrevious);
    resolveChange(previousPorts.ports, readElement(withPrevious, 'p[data-change]'), 'reject');
    const previousExpected = selectionAt(withPrevious, readElement(withPrevious, '#p'), 1);

    const bare = mountRoot('<p data-change="ins">b</p>');
    const barePorts = createPorts(bare);
    resolveChange(barePorts.ports, readElement(bare, 'p'), 'reject');

    expect([previousPorts.returns, barePorts.returns]).toEqual([[previousExpected], [selectionAt(bare, bare, 0)]]);
  });

  it('does nothing and returns false while input is stopped, and when the mark is not in the tree', () => {
    const root = mountRoot('<p><ins>a</ins></p>');
    const stopped = createPorts(root, { isInputStopped: () => true });
    const detached = document.createElement('ins');
    const open = createPorts(root);

    const results = [
      resolveChange(stopped.ports, readElement(root, 'ins'), 'accept'),
      resolveChange(open.ports, detached, 'accept'),
    ];

    expect([results, root.innerHTML, stopped.attempts, open.attempts]).toEqual([[false, false], '<p><ins>a</ins></p>', [], []]);
  });

  it('does not throw out an exception from the rewrite, records one diagnostic line, and requests no return', () => {
    const root = mountRoot('<p><ins>a</ins></p>');
    const mark = readElement(root, 'ins');
    Object.defineProperty(mark, 'remove', {
      value: () => {
        throw new Error('boom');
      },
    });
    const { ports, diagnostics, returns } = createPorts(root);

    const changed = resolveChange(ports, mark, 'accept');

    expect([changed, diagnostics.length, returns]).toEqual([false, 1, []]);
  });
});

describe('deciding a replacement pair', () => {
  /** A deletion followed at once by an insertion from the same author: one replacement. */
  const REPLACEMENT = '<p>The cache is cleared every <del id="d" data-author="ai">hour</del><ins id="i" data-author="ai">30 minutes</ins>.</p>';

  it('accepting takes the deletion out and keeps the insertion in one accept edit, from either half, and returns to the end of the kept text', () => {
    const fromDeletion = mountRoot(REPLACEMENT);
    const first = createPorts(fromDeletion);
    resolveChange(first.ports, readElement(fromDeletion, '#d'), 'accept');
    const expected = selectionAt(fromDeletion, readElement(fromDeletion, 'p'), 2);

    const fromInsertion = mountRoot(REPLACEMENT);
    const second = createPorts(fromInsertion);
    resolveChange(second.ports, readElement(fromInsertion, '#i'), 'accept');

    expect([fromDeletion.innerHTML, first.attempts, first.returns, fromInsertion.innerHTML, second.attempts]).toEqual([
      '<p>The cache is cleared every 30 minutes.</p>',
      [`begin:${CHANGE_EDIT_KIND.accept}`, 'complete'],
      [expected],
      '<p>The cache is cleared every 30 minutes.</p>',
      [`begin:${CHANGE_EDIT_KIND.accept}`, 'complete'],
    ]);
  });

  it('rejecting takes the insertion out and keeps the deletion in one reject edit, and returns to the end of the kept text', () => {
    const root = mountRoot(REPLACEMENT);
    const { ports, attempts, returns } = createPorts(root);

    resolveChange(ports, readElement(root, '#i'), 'reject');

    expect([root.innerHTML, attempts, returns]).toEqual([
      '<p>The cache is cleared every hour.</p>',
      [`begin:${CHANGE_EDIT_KIND.reject}`, 'complete'],
      [selectionAt(root, readElement(root, 'p'), 2)],
    ]);
  });

  it('decides a pair of items or of rows the same way, leaves their list or table section in place, and returns to the end of the kept row', () => {
    const items = '<ul>\n<li id="a" data-change="del" data-author="ai">old</li>\n<li id="b" data-change="ins" data-author="ai">new</li>\n</ul>';
    const rows = '<table><tbody>\n<tr id="c" data-change="del" data-author="ai"><td>old</td></tr>\n'
      + '<tr id="d" data-change="ins" data-author="ai"><td>new</td></tr>\n</tbody></table>';
    const accepted = mountRoot(items);
    resolveChange(createPorts(accepted).ports, readElement(accepted, '#a'), 'accept');
    const rejected = mountRoot(items);
    resolveChange(createPorts(rejected).ports, readElement(rejected, '#b'), 'reject');
    const acceptedRows = mountRoot(rows);
    const rowHarness = createPorts(acceptedRows);
    resolveChange(rowHarness.ports, readElement(acceptedRows, '#c'), 'accept');
    const rejectedRows = mountRoot(rows);
    resolveChange(createPorts(rejectedRows).ports, readElement(rejectedRows, '#d'), 'reject');

    expect([accepted.innerHTML, rejected.innerHTML, acceptedRows.innerHTML, rejectedRows.innerHTML, rowHarness.returns]).toEqual([
      '<ul>\n\n<li id="b">new</li>\n</ul>',
      '<ul>\n<li id="a">old</li>\n\n</ul>',
      '<table><tbody>\n\n<tr id="d"><td>new</td></tr>\n</tbody></table>',
      '<table><tbody>\n<tr id="c"><td>old</td></tr>\n\n</tbody></table>',
      [selectionAt(acceptedRows, readElement(acceptedRows, '#d > td'), 1)],
    ]);
  });
});

describe('accepting or rejecting every change mark', () => {
  it('accepts every mark in document order in one acceptAll edit and requests no return', () => {
    const root = mountRoot(
      '<p><ins>a</ins><del>b</del></p><ul><li data-change="del">c</li><li data-change="ins" data-author="ai">d</li></ul>',
    );
    const { ports, attempts, returns } = createPorts(root);

    const changed = resolveAllChanges(ports, 'accept');

    expect([changed, root.innerHTML, attempts, returns]).toEqual([
      true,
      '<p>a</p><ul><li>d</li></ul>',
      [`begin:${CHANGE_EDIT_KIND.acceptAll}`, 'complete'],
      [],
    ]);
  });

  it('rejects every mark in document order in one rejectAll edit and requests no return', () => {
    const root = mountRoot(
      '<p><ins>a</ins><del>b</del></p><ul><li data-change="del">c</li><li data-change="ins" data-author="ai">d</li></ul>',
    );
    const { ports, attempts, returns } = createPorts(root);

    const changed = resolveAllChanges(ports, 'reject');

    expect([changed, root.innerHTML, attempts, returns]).toEqual([
      true,
      '<p>b</p><ul><li>c</li></ul>',
      [`begin:${CHANGE_EDIT_KIND.rejectAll}`, 'complete'],
      [],
    ]);
  });

  it('skips the marks that an accepted deletion took out of the tree', () => {
    const root = mountRoot('<p><del>a<ins>b</ins></del>c</p>');
    const { ports, diagnostics } = createPorts(root);

    resolveAllChanges(ports, 'accept');

    expect([root.innerHTML, diagnostics]).toEqual(['<p>c</p>', []]);
  });

  it('opens no completed attempt when there is no mark, and does nothing while input is stopped', () => {
    const empty = mountRoot('<p>a</p>');
    const emptyPorts = createPorts(empty);
    const emptyResult = resolveAllChanges(emptyPorts.ports, 'accept');

    const stopped = mountRoot('<p><ins>a</ins></p>');
    const stoppedPorts = createPorts(stopped, { isInputStopped: () => true });
    const stoppedResult = resolveAllChanges(stoppedPorts.ports, 'reject');

    expect([emptyResult, emptyPorts.attempts, stoppedResult, stopped.innerHTML, stoppedPorts.attempts]).toEqual([
      false,
      [`begin:${CHANGE_EDIT_KIND.acceptAll}`, 'abort'],
      false,
      '<p><ins>a</ins></p>',
      [],
    ]);
  });
});
