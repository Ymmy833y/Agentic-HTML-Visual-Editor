import { describe, expect, it } from 'vitest';

import { indentCode, outdentCode, runCodeIndent } from '../../webview/editing/code-block-indent';
import type { CodeIndentPorts } from '../../webview/editing/code-block-indent';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/**
 * Mounts one code block and returns its pieces.
 *
 * @param html The contents of the editor root.
 * @returns The editor root, the `pre` and the first text of the `code`.
 */
function mountCode(html: string): { root: HTMLElement; pre: Element; text: Text } {
  const root = mountRoot(html);
  const pre = readElement(root, 'pre');
  const code = pre.querySelector('code') ?? pre;
  return { root, pre, text: readChildText(code, 0) };
}

/**
 * Reads the code of a block as text, comment entries included.
 *
 * @param pre The code block.
 * @returns The text content.
 */
function readCode(pre: Element): string {
  return pre.textContent ?? '';
}

describe('indenting code', () => {
  it('puts four spaces at a caret in the middle of a line', () => {
    const { root, pre, text } = mountCode('<pre><code>ab\ncd\n</code></pre>');
    const range = createRange(text, 1, text, 1);
    select(range);

    indentCode(root, pre, range);

    expect(readCode(pre)).toBe('a    b\ncd\n');
  });

  it('puts four spaces at the start of each line a range touches, leaving out a blank line between them', () => {
    const { root, pre, text } = mountCode('<pre><code>a\n\nb\nc\nd\n</code></pre>');
    const range = createRange(text, 1, text, 6);
    select(range);

    indentCode(root, pre, range);

    expect(readCode(pre)).toBe('    a\n\n    b\n    c\nd\n');
  });

  it('does not indent the line a range ends at the start of', () => {
    const { root, pre, text } = mountCode('<pre><code>a\nb\nc\n</code></pre>');
    const range = createRange(text, 0, text, 4);
    select(range);

    indentCode(root, pre, range);

    expect(readCode(pre)).toBe('    a\n    b\nc\n');
  });

  it('keeps the selection on the same characters', () => {
    const { root, pre, text } = mountCode('<pre><code>ab\ncd\n</code></pre>');
    const range = createRange(text, 1, text, 4);
    select(range);

    indentCode(root, pre, range);

    expect(window.getSelection()?.toString()).toBe('b\n    c');
  });

  it('treats the position after a br as a line start in a pre without code', () => {
    const { root, pre, text } = mountCode('<pre>a<br>b</pre>');
    const last = readChildText(pre, 2);
    const range = createRange(text, 0, last, 1);
    select(range);

    indentCode(root, pre, range);

    expect(pre.innerHTML).toBe('    a<br>    b');
  });

  it('does not count a line break inside a comment entry as a line', () => {
    const { root, pre, text } = mountCode(
      '<pre><code>a<comment id="c-1">b<comment-body contenteditable="false">x\ny</comment-body></comment>\nc\n</code></pre>',
    );
    const last = readChildText(readElement(pre, 'code'), 2);
    const range = createRange(text, 0, last, 2);
    select(range);

    indentCode(root, pre, range);

    expect([readElement(pre, 'comment-body').textContent, readCode(pre).startsWith('    a')])
      .toEqual(['x\ny', true]);
  });
});

describe('outdenting code', () => {
  it('removes up to four leading spaces from each line, and a single leading tab', () => {
    const { pre, text } = mountCode('<pre><code>      a\n  b\n\t\tc\n</code></pre>');
    const range = createRange(text, 0, text, text.data.length - 1);
    select(range);

    const changed = outdentCode(pre, range);

    expect([changed, readCode(pre)]).toEqual([true, '  a\nb\n\tc\n']);
  });

  it('returns that nothing changed and leaves the tree for a line without indent', () => {
    const { pre, text } = mountCode('<pre><code>ab\n</code></pre>');
    const range = createRange(text, 1, text, 1);
    select(range);

    const changed = outdentCode(pre, range);

    expect([changed, readCode(pre)]).toEqual([false, 'ab\n']);
  });
});

describe('the code indent shortcut', () => {
  /**
   * Creates stand-in ports and a record of the edit kinds passed to the command path.
   *
   * @param root The editor root.
   * @param composing Whether a composition is in progress.
   * @returns The ports and the record of edit kinds.
   */
  function createPorts(root: HTMLElement, composing: boolean): { ports: CodeIndentPorts; editKinds: string[] } {
    const editKinds: string[] = [];
    const ports: CodeIndentPorts = {
      readEditorRoot: () => root,
      isComposing: () => composing,
      isInputStopped: () => false,
      runCommandEdit: (kind, command) => {
        editKinds.push(kind);
        return command();
      },
    };
    return { ports, editKinds };
  }

  it('takes Tab over during a composition without changing the tree', () => {
    const { root, pre, text } = mountCode('<pre><code>ab\n</code></pre>');
    select(createRange(text, 1, text, 1));
    const { ports, editKinds } = createPorts(root, true);

    const takenOver = runCodeIndent(ports, 'indent');

    expect([takenOver, editKinds, readCode(pre)]).toEqual([true, [], 'ab\n']);
  });
});
