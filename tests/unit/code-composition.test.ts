import { describe, expect, it } from 'vitest';

import {
  COMPOSITION_PLACEHOLDER_TEXT,
  insertCompositionPlaceholder,
  removeCompositionPlaceholder,
} from '../../webview/editing/code-composition';
import type { CompositionPlaceholder } from '../../webview/editing/code-composition';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/**
 * Sets the selection to a range collapsed at a position.
 *
 * @param node The node of the position.
 * @param offset The offset of the position.
 */
function placeAt(node: Node, offset: number): void {
  select(createRange(node, offset, node, offset));
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
 * Places the caret inside an empty `code` and inserts the placeholder.
 *
 * @param html The content of the editor root.
 * @returns The editor root, the `code`, and the inserted placeholder.
 */
function insertIntoEmptyCode(html: string): { root: HTMLElement; code: Element; placeholder: CompositionPlaceholder } {
  const root = mountRoot(html);
  const code = readElement(root, 'code');
  placeAt(code, 0);
  const placeholder = insertCompositionPlaceholder(root);
  if (placeholder === undefined) {
    throw new Error('placeholder not inserted');
  }
  return { root, code, placeholder };
}

describe('composition start placeholder', () => {
  it('for a caret inside an empty code, inserts a placeholder into code and places the caret after it', () => {
    const { code, placeholder } = insertIntoEmptyCode('<pre><code></code></pre>');

    expect([[...code.childNodes], placeholder.text.data, readCaret()])
      .toEqual([[placeholder.text], COMPOSITION_PLACEHOLDER_TEXT, [placeholder.text, 1]]);
  });

  it('also inserts into code at the start of pre right after conversion and right before code in a pre with text before code', () => {
    const root = mountRoot('<pre><code></code></pre>\n<pre>$ <code></code></pre>');
    const [converted, prompted] = [...root.querySelectorAll('pre')];

    placeAt(converted, 0);
    const first = insertCompositionPlaceholder(root);
    placeAt(readChildText(prompted, 0), 2);
    const second = insertCompositionPlaceholder(root);

    expect([
      first?.text.parentNode === readElement(converted, 'code'),
      second?.text.parentNode === readElement(prompted, 'code'),
    ]).toEqual([true, true]);
  });

  it('inserts nothing and returns undefined for code with content and for a range selection', () => {
    const html = '<pre><code>ab</code></pre>\n<pre><code></code></pre>';
    const root = mountRoot(html);
    const text = readChildText(readElement(root, 'code'), 0);
    const empty = readElement(root, 'pre:nth-of-type(2)');

    placeAt(text, 1);
    const filled = insertCompositionPlaceholder(root);
    select(createRange(empty, 0, empty, 1));
    const selected = insertCompositionPlaceholder(root);

    expect([filled, selected, root.innerHTML]).toEqual([undefined, undefined, html]);
  });

  it('does not let an exception from the insertion escape, leaves the tree as it was, and records one diagnostic line', () => {
    const root = mountRoot('<pre><code></code></pre>');
    const code = readElement(root, 'code');
    placeAt(code, 0);
    // Fail after inserting, to confirm that what was inserted is undone.
    const append = code.append.bind(code);
    Object.defineProperty(code, 'append', {
      value: (...nodes: (Node | string)[]) => {
        append(...nodes);
        throw new Error('Failure');
      },
    });
    const diagnostics: string[] = [];

    const placeholder = insertCompositionPlaceholder(root, (detail) => diagnostics.push(detail));

    expect([placeholder, code.childNodes.length, diagnostics.length]).toEqual([undefined, 0, 1]);
  });
});

describe('removing the placeholder when the composition ends', () => {
  it('if characters follow the placeholder, removes only one character, leaves the characters in code, and puts the caret right after them', () => {
    const { root, placeholder } = insertIntoEmptyCode('<pre><code></code></pre>');
    placeholder.text.appendData('a');
    placeAt(placeholder.text, 2);

    removeCompositionPlaceholder(placeholder);

    expect([root.innerHTML, readCaret()]).toEqual(['<pre><code>a</code></pre>', [placeholder.text, 1]]);
  });

  it('with only the placeholder, removes the whole text and code has no children', () => {
    const { code, placeholder } = insertIntoEmptyCode('<pre><code></code></pre>');

    removeCompositionPlaceholder(placeholder);

    expect([code.childNodes.length, readCaret()]).toEqual([0, [code, 0]]);
  });

  it('does nothing and does not throw if the text is detached from the tree', () => {
    const { placeholder } = insertIntoEmptyCode('<pre><code></code></pre>');
    placeholder.text.remove();
    const diagnostics: string[] = [];

    removeCompositionPlaceholder(placeholder, (detail) => diagnostics.push(detail));

    expect([placeholder.text.data, diagnostics]).toEqual([COMPOSITION_PLACEHOLDER_TEXT, []]);
  });
});
