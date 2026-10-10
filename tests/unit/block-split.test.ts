import { describe, expect, it } from 'vitest';

import { extractSplitTail, prepareSplit, splitBlock } from '../../webview/editing/block-split';
import type { SplitPreprocessor } from '../../webview/editing/editing-hooks';
import type { NodeBoundary } from '../../webview/selection/selection-position';

/**
 * Creates an element representing an editor root.
 *
 * @param html The editor root contents.
 * @returns An editor root with the supplied contents.
 */
function createRoot(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

/**
 * Selects one element.
 *
 * @param root The search root.
 * @param selector The selector.
 * @returns The matching element.
 */
function select(root: Element, selector: string): Element {
  const found = root.querySelector(selector);
  if (found === null) {
    throw new Error(`Element not found: ${selector}`);
  }
  return found;
}

/**
 * Creates a collapsed range.
 *
 * @param container The node in which to place the range.
 * @param offset The position within the node.
 * @returns The collapsed range.
 */
function createCollapsedRange(container: Node, offset: number): Range {
  const range = document.createRange();
  range.setStart(container, offset);
  range.collapse(true);
  return range;
}

describe('block split', () => {
  it('moves the tail to a new block of the same type with one preceding line break', () => {
    const root = createRoot('\n<p>abc</p>');
    const paragraph = select(root, 'p');

    splitBlock(paragraph, createCollapsedRange(paragraph.childNodes[0], 1));

    expect(root.innerHTML).toBe('\n<p>a</p>\n<p>bc</p>');
  });

  it('creates an empty same-type block with a placeholder after a split at the end', () => {
    const root = createRoot('\n<p>abc</p>');
    const paragraph = select(root, 'p');

    splitBlock(paragraph, createCollapsedRange(paragraph.childNodes[0], 3));

    expect(root.innerHTML).toBe('\n<p>abc</p>\n<p><br></p>');
  });

  it('creates a paragraph when splitting at the end of a heading', () => {
    const root = createRoot('\n<h2>abc</h2>');
    const heading = select(root, 'h2');

    const target = splitBlock(heading, createCollapsedRange(heading.childNodes[0], 3));

    expect(target.localName).toBe('p');
  });

  it('creates an empty preceding heading and returns the original block when splitting at the start', () => {
    const root = createRoot('\n<h2>abc</h2>');
    const heading = select(root, 'h2');

    const target = splitBlock(heading, createCollapsedRange(heading.childNodes[0], 0));

    expect(target).toBe(heading);
    expect(heading.previousElementSibling?.outerHTML).toBe('<h2><br></h2>');
  });

  it('leaves matching closed inline elements on both sides when splitting within one', () => {
    const root = createRoot('<p><strong>ab</strong></p>');
    const strong = select(root, 'strong');

    splitBlock(select(root, 'p'), createCollapsedRange(strong.childNodes[0], 1));

    expect(root.innerHTML).toBe('<p><strong>a</strong></p>\n<p><strong>b</strong></p>');
  });

  it('does not copy attributes to the new block', () => {
    const root = createRoot('<p id="x" style="color:red">abc</p>');
    const paragraph = select(root, 'p');

    const target = splitBlock(paragraph, createCollapsedRange(paragraph.childNodes[0], 1));

    expect(target.attributes.length).toBe(0);
  });

  it('creates a placeholder-only block when the trailing side is whitespace-only', () => {
    const root = createRoot('<p>a<br>  </p>');
    const paragraph = select(root, 'p');

    const target = splitBlock(paragraph, createCollapsedRange(paragraph.childNodes[0], 1));

    expect(target.outerHTML).toBe('<p><br></p>');
  });
});

describe('extracting the tail of a split', () => {
  it('extracts only from the caret to the given end point, closing inline elements on both sides', () => {
    const root = createRoot('<ul><li><strong>ab</strong>cd<ul><li>x</li></ul></li></ul>');
    const item = select(root, 'li');
    const container = document.createElement('div');

    container.append(extractSplitTail(createCollapsedRange(select(root, 'strong').childNodes[0], 1), item, 2));

    expect([container.innerHTML, item.innerHTML])
      .toEqual(['<strong>b</strong>cd', '<strong>a</strong><ul><li>x</li></ul>']);
  });
});

/**
 * Reads the start of the range as a boundary.
 *
 * @param range The range.
 * @returns The container and offset of the start.
 */
function readStart(range: Range): NodeBoundary {
  return { container: range.startContainer, offset: range.startOffset };
}

describe('Calling split preprocessors', () => {
  it('without preprocessors, returns a split at the current position and leaves the range unchanged', () => {
    const root = createRoot('<p>abc</p>');
    const text = select(root, 'p').childNodes[0];
    const range = createCollapsedRange(text, 1);

    const preparation = prepareSplit(select(root, 'p'), range, []);

    expect([preparation, readStart(range)]).toEqual([
      { kind: 'split', boundary: { container: text, offset: 1 } },
      { container: text, offset: 1 },
    ]);
  });

  it('with two preprocessors, the boundary the first returns becomes the caret of the second, and the range moves to the boundary the second returns', () => {
    const root = createRoot('<p>abc</p>');
    const paragraph = select(root, 'p');
    const received: NodeBoundary[] = [];
    const first: SplitPreprocessor = () => ({ kind: 'split', boundary: { container: paragraph, offset: 0 } });
    const second: SplitPreprocessor = (_block, caret) => {
      received.push(caret);
      return { kind: 'split', boundary: { container: paragraph, offset: 1 } };
    };
    const range = createCollapsedRange(paragraph.childNodes[0], 1);

    prepareSplit(paragraph, range, [first, second]);

    expect([received, readStart(range)]).toEqual([
      [{ container: paragraph, offset: 0 }],
      { container: paragraph, offset: 1 },
    ]);
  });

  it('when the first takes over, the second is not called and the range moves to the boundary to continue from', () => {
    const root = createRoot('<p>abc</p>');
    const paragraph = select(root, 'p');
    const called: string[] = [];
    const first: SplitPreprocessor = () => {
      called.push('first');
      return { kind: 'takenOver', changed: true, boundary: { container: paragraph, offset: 1 } };
    };
    const second: SplitPreprocessor = (_block, caret) => {
      called.push('second');
      return { kind: 'split', boundary: caret };
    };
    const range = createCollapsedRange(paragraph.childNodes[0], 2);

    prepareSplit(paragraph, range, [first, second]);

    expect([called, readStart(range)]).toEqual([['first'], { container: paragraph, offset: 1 }]);
  });
});
