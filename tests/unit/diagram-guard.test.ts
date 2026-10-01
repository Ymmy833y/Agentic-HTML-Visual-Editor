import { describe, expect, it } from 'vitest';

import { createDiagramGuardRule } from '../../webview/editing/diagram-guard';
import { createRange, mountRoot, readChildText, readElement } from './helpers/format-dom';

/**
 * Runs the guard for one input.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @param inputType The input type.
 * @returns The rule's result.
 */
function runGuard(root: Element, range: Range, inputType: string): string {
  return createDiagramGuardRule()({ event: new InputEvent('beforeinput', { inputType, data: 'x' }), root, range });
}

describe('guarding the source of a diagram', () => {
  it('takes typing and deleting whose selection has an end inside a diagram, leaving the tree as it was', () => {
    const root = mountRoot('<p>ab</p><pre class="mermaid">graph TD</pre>');
    const source = readChildText(readElement(root, 'pre'), 0);
    const paragraph = readChildText(readElement(root, 'p'), 0);
    const before = root.innerHTML;

    const results = [
      runGuard(root, createRange(source, 2, source, 2), 'insertText'),
      runGuard(root, createRange(paragraph, 1, source, 2), 'deleteContentBackward'),
    ];

    expect([results, root.innerHTML]).toEqual([['consumed', 'consumed'], before]);
  });

  it('passes input whose selection ends are both outside diagrams, even when the range contains a whole diagram', () => {
    const root = mountRoot('<p>ab</p><pre class="mermaid">graph TD</pre><p>cd</p>');
    const [first, last] = [...root.querySelectorAll('p')].map((paragraph) => readChildText(paragraph, 0));

    expect([
      runGuard(root, createRange(first, 1, first, 1), 'insertText'),
      runGuard(root, createRange(first, 1, last, 1), 'deleteContentBackward'),
    ]).toEqual(['pass', 'pass']);
  });
});
