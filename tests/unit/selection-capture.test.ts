import { describe, expect, it } from 'vitest';

import { serializeBody } from '../../webview/document/body-serializer';
import { removeEditingArtifacts } from '../../webview/document/editing-artifact';
import { createInverseTransformedCopy } from '../../webview/document/inverse-transform';
import {
  captureRange,
  captureSelection,
  serializeWithSelectionMarkers,
} from '../../webview/selection/selection-capture';
import type { NodeBoundary } from '../../webview/selection/selection-position';

/**
 * Builds an editor root.
 *
 * @param html The body HTML.
 * @returns The editor root containing the body.
 */
function buildRoot(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

/**
 * Gets the current form of a tree using the same process that creates output.
 *
 * @param root The editor root.
 * @returns The current form.
 */
function currentForm(root: Element): string {
  const copy = createInverseTransformedCopy(root);
  removeEditingArtifacts(copy);
  return serializeBody(copy);
}

/**
 * Gets the first text node in an element.
 *
 * @param parent The element to search.
 * @returns The text node.
 */
function firstText(parent: Element): Text {
  const first = parent.firstChild;
  if (!(first instanceof Text)) {
    throw new Error('The test input contains no text node');
  }
  return first;
}

describe('serialization through markers', () => {
  it('produces a marker-free string matching the current form of the same tree', () => {
    const root = buildRoot('<p>abc</p><p>def</p>');
    const text = firstText(root.children[1]);

    const markers = serializeWithSelectionMarkers(root, [{ container: text, offset: 1 }]);

    expect(markers?.text).toBe(currentForm(root));
  });

  it('removes a trailing br and matches the current form when inserted immediately after it', () => {
    const root = buildRoot('<p>abc<br></p>');
    const paragraph = root.children[0];

    const markers = serializeWithSelectionMarkers(root, [{ container: paragraph, offset: 2 }]);

    expect(markers?.text).toBe(currentForm(root));
  });

  it('removes an empty attribute-free em and matches the current form when inserted inside it', () => {
    const root = buildRoot('<p>ab<em></em>cd</p>');
    const emphasis = root.querySelector('em');
    if (emphasis === null) {
      throw new Error('The test input contains no em');
    }

    const markers = serializeWithSelectionMarkers(root, [{ container: emphasis, offset: 0 }]);

    expect(markers?.text).toBe(currentForm(root));
  });

  it('encodes a boundary in an empty block without a text node as a character offset', () => {
    const root = buildRoot('<p><br></p>');
    const paragraph = root.children[0];

    const markers = serializeWithSelectionMarkers(root, [{ container: paragraph, offset: 0 }]);

    expect(markers?.offsets).toEqual(['<p>'.length]);
  });

  it('gives boundaries before and after an img distinct character offsets', () => {
    const root = buildRoot('<p><img src="a.png"></p>');
    const paragraph = root.children[0];
    const boundaries: NodeBoundary[] = [
      { container: paragraph, offset: 0 },
      { container: paragraph, offset: 1 },
    ];

    const markers = serializeWithSelectionMarkers(root, boundaries);

    expect(markers?.offsets).toEqual(['<p>'.length, '<p><img src="a.png">'.length]);
  });

  it('gives two boundaries in one text node two character offsets in document order', () => {
    const root = buildRoot('<p>abcdef</p>');
    const text = firstText(root.children[0]);
    const boundaries: NodeBoundary[] = [
      { container: text, offset: 1 },
      { container: text, offset: 4 },
    ];

    const markers = serializeWithSelectionMarkers(root, boundaries);

    expect(markers?.offsets).toEqual(['<p>a'.length, '<p>abcd'.length]);
  });

  it('does not encode a boundary whose node is outside the editor root', () => {
    const root = buildRoot('<p>abc</p>');
    const outside = document.createElement('p');

    expect(serializeWithSelectionMarkers(root, [{ container: outside, offset: 0 }]))
      .toBeUndefined();
  });

  it('does not change the tree when given a boundary whose node is outside the editor root', () => {
    const root = buildRoot('<p>abc</p>');
    const outside = document.createElement('p');

    serializeWithSelectionMarkers(root, [{ container: outside, offset: 0 }]);

    expect(root.innerHTML).toBe('<p>abc</p>');
  });
});

describe('capturing the live selection', () => {
  it('does not capture a selection outside the editor root', () => {
    const root = buildRoot('<p>abc</p>');
    const outside = document.createElement('p');
    outside.textContent = 'x';
    document.body.append(root, outside);

    const range = document.createRange();
    range.selectNodeContents(outside);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(captureSelection(root)).toBeUndefined();

    root.remove();
    outside.remove();
  });
});

describe('Capturing a range', () => {
  it('passing a range different from the live selection encodes both ends of the given range, not the live selection, and returns them with the current at capture time', () => {
    const root = buildRoot('<p>abcdef</p>');
    document.body.append(root);
    const text = firstText(root.children[0]);
    // Keep the live selection as a caret at the start, and check that the given range is what gets encoded.
    window.getSelection()?.collapse(text, 0);
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 4);

    const captured = captureRange(root, range);

    expect(captured).toEqual({
      selection: { start: { line: 0, column: '<p>a'.length }, end: { line: 0, column: '<p>abcd'.length } },
      text: currentForm(root),
    });

    root.remove();
  });

  it('passing a range with an end outside the editor root returns undefined (no capture)', () => {
    const root = buildRoot('<p>abc</p>');
    const outside = document.createElement('p');
    outside.textContent = 'x';
    const range = document.createRange();
    range.selectNodeContents(outside);

    expect(captureRange(root, range)).toBeUndefined();
  });
});
