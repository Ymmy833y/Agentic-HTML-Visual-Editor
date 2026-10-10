import { beforeAll, describe, expect, it } from 'vitest';

import { TEXT_REPLACE_EDIT_KIND, replaceTexts } from '../../webview/editing/text-replace';
import type { ReplaceTarget, TextReplacePorts } from '../../webview/editing/text-replace';
import type { EditEndpointSelections } from '../../webview/history/edit-transaction-controller';
import { findSearchMatches, readReplaceTarget } from '../../webview/search/search-text';
import type { SearchOptions } from '../../webview/search/search-text';
import { mountRoot } from './helpers/format-dom';

/** A search condition with both toggles off. */
const PLAIN: SearchOptions = { matchCase: false, wholeWord: false };

// jsdom has no default style sheet for these elements and computes them as blocks, which would cut the visible text
// at each of them.
beforeAll(() => {
  const style = document.createElement('style');
  style.textContent = 'b, i, a, span, comment { display: inline; } [hidden] { display: none; }';
  document.head.append(style);
});

/** The record of the edit attempts the ports ran. */
interface EditRecord {
  readonly kinds: string[];
  readonly endpoints: string[][];
  /** What each command returned. */
  readonly changed: boolean[];
  readonly diagnostics: string[];
}

/**
 * Creates ports that run every command as an edit, recording its kind and the text of its endpoints.
 *
 * @param state Whether composition is in progress and whether input is stopped.
 * @returns The ports and the record.
 */
function createPorts(state: { composing?: boolean; stopped?: boolean } = {}): {
  ports: TextReplacePorts;
  record: EditRecord;
} {
  const record: EditRecord = { kinds: [], endpoints: [], changed: [], diagnostics: [] };
  const ports: TextReplacePorts = {
    isComposing: () => state.composing === true,
    isInputStopped: () => state.stopped === true,
    runCommandEdit: (kind: string, command: () => boolean, endpoints: EditEndpointSelections) => {
      record.kinds.push(kind);
      const before = endpoints.start?.toString() ?? '';
      const changed = command();
      record.endpoints.push([before, endpoints.end?.toString() ?? '']);
      record.changed.push(changed);
      return changed;
    },
    reportDiagnostic: (detail) => {
      record.diagnostics.push(detail);
    },
  };
  return { ports, record };
}

/**
 * Finds the matches of a query in the root and returns the targets of those that can be replaced.
 *
 * @param root The editor root.
 * @param query The query.
 * @returns The targets in document order.
 */
function readTargets(root: Element, query: string): ReplaceTarget[] {
  return findSearchMatches(root, query, PLAIN).flatMap((match) => {
    const target = readReplaceTarget(match);
    return target === undefined ? [] : [target];
  });
}

describe('which matches can be replaced', () => {
  it('replaces a match inside annotated text, but not one that crosses its edge, one that contains a whole comment, or a comment id match', () => {
    const root = mountRoot('<p>x<comment id="c-k0000001">ab<comment-body>n</comment-body></comment>y '
      + 'p<comment id="c-k0000002">q</comment>r</p>');

    const replaceable = ['xa', 'ab', 'by', 'y p', 'pqr', 'c-k0'].map((query) => readTargets(root, query).length);

    expect(replaceable).toEqual([0, 1, 0, 1, 0, 0]);
  });

  it('replaces a text match equal to the annotated text even when the comment id also contains the query', () => {
    const root = mountRoot('<p>see <comment id="c-a1b20000">a1<comment-body>n</comment-body></comment> and a1</p>');
    const { ports } = createPorts();

    const targets = readTargets(root, 'a1');
    replaceTexts(root, ports, targets, 'z');

    expect([targets.length, root.innerHTML]).toEqual([
      2,
      '<p>see <comment id="c-a1b20000">z<comment-body>n</comment-body></comment> and z</p>',
    ]);
  });
});

describe('replacing text', () => {
  it('puts the replacement in the text of the first character and removes a bold element left empty', () => {
    const root = mountRoot('<p>ca<b>t</b>s</p>');
    const { ports } = createPorts();

    replaceTexts(root, ports, readTargets(root, 'cat'), 'dog');

    expect(root.innerHTML).toBe('<p>dogs</p>');
  });

  it('takes the formatting of the first character when the match starts inside a format element', () => {
    const root = mountRoot('<p><i>ca</i>t!</p>');
    const { ports } = createPorts();

    replaceTexts(root, ports, readTargets(root, 'cat'), 'dog');

    expect(root.innerHTML).toBe('<p><i>dog</i>!</p>');
  });

  it('keeps an emptied link, which carries a destination, and keeps hidden text inside the match', () => {
    const root = mountRoot('<p>a<a href="x">b</a><span hidden="">h</span>c</p>');
    const { ports } = createPorts();

    replaceTexts(root, ports, readTargets(root, 'abc'), 'z');

    expect(root.innerHTML).toBe('<p>z<a href="x"></a><span hidden="">h</span></p>');
  });

  it('removes the whole run of whitespace a collapsed space stands for, across text nodes', () => {
    const root = mountRoot('<p>a \n<b> </b>\n b</p>');
    const { ports } = createPorts();

    replaceTexts(root, ports, readTargets(root, 'a b'), 'ab');

    expect(root.innerHTML).toBe('<p>ab</p>');
  });

  it('replaces every target as one edit and records the first target before and its replacement after', () => {
    const root = mountRoot('<p>cat cat</p><p>cat</p>');
    const { ports, record } = createPorts();

    const placed = replaceTexts(root, ports, readTargets(root, 'cat'), 'dog');

    expect([root.innerHTML, record.kinds, record.endpoints, placed?.toString()]).toEqual([
      '<p>dog dog</p><p>dog</p>',
      [TEXT_REPLACE_EDIT_KIND],
      [['cat', 'dog']],
      'dog',
    ]);
  });

  it('replaces adjacent matches in one text node without disturbing each other', () => {
    const root = mountRoot('<p>aaa</p>');
    const { ports } = createPorts();

    replaceTexts(root, ports, readTargets(root, 'a'), 'bc');

    expect(root.innerHTML).toBe('<p>bcbcbc</p>');
  });

  it('gives a line emptied by an empty replacement a placeholder br, and leaves an emptied table cell and code block as they are', () => {
    const root = mountRoot('<p>cat</p><table><tbody><tr><td>cat</td></tr></tbody></table><pre><code>cat</code></pre>');
    const { ports } = createPorts();

    replaceTexts(root, ports, readTargets(root, 'cat'), '');

    expect(root.innerHTML).toBe('<p><br></p><table><tbody><tr><td></td></tr></tbody></table><pre><code></code></pre>');
  });

  it('closes the edit as changed when an exception is thrown after the first characters were removed', () => {
    const root = mountRoot('<p>ab<b>cd</b></p>');
    const { ports, record } = createPorts();
    const [target] = readTargets(root, 'bc');
    const [head, ...rest] = target.spans;
    // A head span past the end of its text node throws only after the span in the bold element was removed.
    const stale: ReplaceTarget = { range: target.range, spans: [{ ...head, start: head.start + 5, end: head.end + 5 }, ...rest] };

    replaceTexts(root, ports, [stale], 'x');

    expect([root.innerHTML, record.changed, record.diagnostics.length]).toEqual(['<p>ab<b>d</b></p>', [true], 1]);
  });

  it('changes nothing and opens no edit during composition or while input is stopped', () => {
    const root = mountRoot('<p>cat</p>');
    const composing = createPorts({ composing: true });
    const stopped = createPorts({ stopped: true });

    const results = [
      replaceTexts(root, composing.ports, readTargets(root, 'cat'), 'dog'),
      replaceTexts(root, stopped.ports, readTargets(root, 'cat'), 'dog'),
    ];

    expect([results, composing.record.kinds, stopped.record.kinds, root.innerHTML])
      .toEqual([[undefined, undefined], [], [], '<p>cat</p>']);
  });
});
