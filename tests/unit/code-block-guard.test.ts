import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BlockCommandPorts } from '../../webview/editing/block-command';
import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { readSelectionRange } from '../../webview/editing/caret';
import {
  clearCodeContents,
  coversCodeContents,
  isBlankCodeBlock,
  readCodeClearing,
  readDeletionExtent,
  replaceBlankCodeBlock,
} from '../../webview/editing/code-block-guard';
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

const BACKWARD: DeleteKind = { backward: true, line: false, granularity: 'character' };
const FORWARD: DeleteKind = { backward: false, line: false, granularity: 'character' };

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

describe('blank code block', () => {
  it('returns true for code without children, code with only a br, an empty pre without code, and a pre with only a br', () => {
    const root = createRoot('<pre><code></code></pre><pre><code><br></code></pre><pre></pre><pre><br></pre>');

    expect([...root.querySelectorAll('pre')].map((pre) => isBlankCodeBlock(pre))).toEqual([true, true, true, true]);
  });

  it('returns true for code and pre holding only a trailing pre break', () => {
    const root = createRoot('<pre><code>\n</code></pre><pre><code></code>\n</pre>');

    expect([...root.querySelectorAll('pre')].map((pre) => isBlankCodeBlock(pre))).toEqual([true, true]);
  });

  it('returns false for a pre with two line breaks and for a pre with content outside code', () => {
    const root = createRoot('<pre><code>\n\n</code></pre><pre>$ <code></code></pre>');

    expect([...root.querySelectorAll('pre')].map((pre) => isBlankCodeBlock(pre))).toEqual([false, false]);
  });
});

describe('whether the deletion extent contains the code content', () => {
  it('returns true for an extent containing all of the code text, and false for one leaving a character', () => {
    const root = createRoot('<pre><code>abc</code></pre>');
    const code = readElement(root, 'code');
    const text = readChildText(code, 0);

    expect([
      coversCodeContents(code, createRange(text, 0, text, 3)),
      coversCodeContents(code, createRange(text, 1, text, 3)),
    ]).toEqual([true, false]);
  });

  it('returns true for an extent without the trailing pre break if it contains all other content', () => {
    const root = createRoot('<pre><code>ab\n</code></pre>');
    const code = readElement(root, 'code');
    const text = readChildText(code, 0);

    expect(coversCodeContents(code, createRange(text, 0, text, 2))).toBe(true);
  });

  it('returns true for an extent that also contains characters outside code, and false for an empty code', () => {
    const root = createRoot('<pre>$ <code>ab</code></pre><pre><code></code></pre>');
    const [filled, empty] = [...root.querySelectorAll('pre')];
    const code = readElement(filled, 'code');

    expect([
      coversCodeContents(code, createRange(readChildText(filled, 0), 0, readChildText(code, 0), 2)),
      coversCodeContents(readElement(empty, 'code'), createRange(empty, 0, empty, 1)),
    ]).toEqual([true, false]);
  });
});

describe('deletion extent', () => {
  it('returns undefined and leaves the selection unchanged in an environment without selection extension', () => {
    // The jsdom selection has no extension (modify).
    const root = mountRoot('<p>xy</p><pre><code>ab</code></pre>');
    const paragraph = readChildText(readElement(root, 'p'), 0);
    const text = readChildText(readElement(root, 'code'), 0);
    select(createRange(paragraph, 0, paragraph, 2));
    const range = caretAt(text, 2);

    const extent = readDeletionExtent(root, range, BACKWARD);

    expect([extent, readSelectionEnds(), range.startContainer === text, range.startOffset, range.collapsed])
      .toEqual([undefined, [paragraph, 0, paragraph, 2], true, 2, true]);
  });
});

describe('identifying deletes that lose code', () => {
  afterEach(() => {
    Reflect.deleteProperty(Selection.prototype, 'modify');
  });

  it('returns undefined without extending the selection when the caret is outside pre or where code content remains on the side opposite the direction', () => {
    // To see whether the selection was extended, inject a selection extension, absent in jsdom, that only records calls.
    const modify = vi.fn();
    Object.defineProperty(Selection.prototype, 'modify', { configurable: true, writable: true, value: modify });
    const root = mountRoot('<p>xy</p><pre><code>ab</code></pre>');
    const outside = readChildText(readElement(root, 'p'), 0);
    const text = readChildText(readElement(root, 'code'), 0);

    const found = [
      readCodeClearing(root, caretAt(outside, 1), BACKWARD),
      readCodeClearing(root, caretAt(text, 1), BACKWARD),
      readCodeClearing(root, caretAt(text, 1), FORWARD),
    ];

    expect([found, modify.mock.calls.length]).toEqual([[undefined, undefined, undefined], 0]);
  });
});

describe('code clearing', () => {
  it('deletes the content in the extent, leaves code without children, and places the caret and range inside code', () => {
    const root = mountRoot('<pre><code>ab</code></pre>');
    const code = readElement(root, 'code');
    const text = readChildText(code, 0);
    const range = caretAt(text, 2);
    const progress: BlockRewriteProgress = { changed: false };

    clearCodeContents({ code, extent: createRange(text, 0, text, 2) }, range, progress);

    expect([
      root.innerHTML,
      root.querySelector('code') === code,
      progress.changed,
      [range.startContainer === code, range.startOffset, range.collapsed],
      readSelectionEnds(),
    ]).toEqual(['<pre><code></code></pre>', true, true, [true, 0, true], [code, 0, code, 0]]);
  });

  it('for code with a trailing pre break, leaves only the line break and places the caret before it', () => {
    const root = mountRoot('<pre><code>ab\n</code></pre>');
    const code = readElement(root, 'code');
    const text = readChildText(code, 0);
    const range = caretAt(text, 2);

    clearCodeContents({ code, extent: createRange(text, 0, text, 3) }, range, { changed: false });

    expect([root.innerHTML, readSelectionEnds()]).toEqual(['<pre><code>\n</code></pre>', [code, 0, code, 0]]);
  });

  it('when the extent reaches characters before code, deletes them too and keeps the code element', () => {
    const root = mountRoot('<pre>$ <code>a</code></pre>');
    const pre = readElement(root, 'pre');
    const code = readElement(root, 'code');
    const text = readChildText(code, 0);

    clearCodeContents({ code, extent: createRange(readChildText(pre, 0), 0, text, 1) }, caretAt(text, 1), {
      changed: false,
    });

    expect([root.innerHTML, root.querySelector('code') === code]).toEqual(['<pre><code></code></pre>', true]);
  });

  it('even when the extent contains the whole code, keeps the code element and deletes only its content', () => {
    const root = mountRoot('<pre>x<code>ab</code>y</pre>');
    const pre = readElement(root, 'pre');
    const code = readElement(root, 'code');

    clearCodeContents({ code, extent: createRange(pre, 0, pre, 3) }, caretAt(pre, 3), { changed: false });

    expect([root.innerHTML, root.querySelector('code') === code]).toEqual(['<pre><code></code></pre>', true]);
  });
});

describe('replacing a blank code block', () => {
  it('passes a conversion to paragraph with the rule trigger and replaces it with an empty paragraph (with a placeholder) carrying over the id', () => {
    const root = mountRoot('<pre id="k"><code></code></pre>');
    const code = readElement(root, 'code');
    select(caretAt(code, 0));
    const attempts: string[] = [];
    const ports: BlockCommandPorts = {
      readEditorRoot: () => root,
      isComposing: () => false,
      isInputStopped: () => false,
      // With the rule trigger, the edit attempt opened by the input dispatcher is used, so this is not called.
      runCommandEdit: (kind, command) => {
        attempts.push(kind);
        return command();
      },
      ensureTargetBlock: () => ensureTargetBlock(root, readSelectionRange(root)),
      reportDiagnostic: () => undefined,
    };

    const changed = replaceBlankCodeBlock(ports);

    expect([changed, attempts, root.innerHTML]).toEqual([true, [], '<p id="k"><br></p>']);
  });
});
