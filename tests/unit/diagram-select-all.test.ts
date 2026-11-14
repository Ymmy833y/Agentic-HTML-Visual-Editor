import { describe, expect, it } from 'vitest';

import { attachSelectAllKey, readSelectAllBoundaries } from '../../webview/editing/diagram-select-all';
import { mountRoot, readChildText, readElement } from './helpers/format-dom';

describe('widening select all over the diagrams outside it', () => {
  it('moves the start before a diagram that opens the editing area and the end after one that closes it', () => {
    const root = mountRoot('<pre class="mermaid">graph TD</pre><p>ab</p><pre class="mermaid">graph LR</pre>');
    const text = readChildText(readElement(root, 'p'), 0);

    const widened = readSelectAllBoundaries(root, {
      start: { container: text, offset: 0 },
      end: { container: text, offset: 2 },
    });

    expect([
      widened.start.container === root,
      widened.start.offset,
      widened.end.container === root,
      widened.end.offset,
    ]).toEqual([true, 0, true, 3]);
  });

  it('moves the start before a diagram that opens a blockquote, inside the blockquote', () => {
    const root = mountRoot('<blockquote><pre class="mermaid">graph TD</pre><p>ab</p></blockquote><p>cd</p>');
    const [first, last] = [...root.querySelectorAll('p')].map((paragraph) => readChildText(paragraph, 0));

    const widened = readSelectAllBoundaries(root, {
      start: { container: first, offset: 0 },
      end: { container: last, offset: 2 },
    });

    expect([
      widened.start.container === readElement(root, 'blockquote'),
      widened.start.offset,
      widened.end.container === last,
      widened.end.offset,
    ]).toEqual([true, 0, true, 2]);
  });

  it('keeps both ends when the only diagram lies between them', () => {
    const root = mountRoot('<p>ab</p><pre class="mermaid">graph TD</pre><p>cd</p>');
    const [first, last] = [...root.querySelectorAll('p')].map((paragraph) => readChildText(paragraph, 0));
    const boundaries = { start: { container: first, offset: 0 }, end: { container: last, offset: 2 } };

    const widened = readSelectAllBoundaries(root, boundaries);

    expect([widened.start === boundaries.start, widened.end === boundaries.end]).toEqual([true, true]);
  });

  it('keeps both ends when the diagram after them is inside a closed details body', () => {
    const root = mountRoot(
      '<p>ab</p><details><summary>title</summary><pre class="mermaid">graph TD</pre></details>',
    );
    const first = readChildText(readElement(root, 'p'), 0);
    const title = readChildText(readElement(root, 'summary'), 0);
    const boundaries = { start: { container: first, offset: 0 }, end: { container: title, offset: 5 } };

    const widened = readSelectAllBoundaries(root, boundaries);

    expect([widened.start === boundaries.start, widened.end === boundaries.end]).toEqual([true, true]);
  });
});

describe('the select-all key', () => {
  it('keeps the default and the propagation of Ctrl+A in an editing area with no diagram', () => {
    const root = mountRoot('<p>ab</p><p>cd</p>');
    attachSelectAllKey(root, 'other', () => undefined);
    const reached: string[] = [];
    document.addEventListener('keydown', (event) => reached.push(event.code), { once: true });
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    root.dispatchEvent(event);

    expect([event.defaultPrevented, reached]).toEqual([false, ['KeyA']]);
  });
});
