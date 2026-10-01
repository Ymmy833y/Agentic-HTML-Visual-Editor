import { describe, expect, it } from 'vitest';

import { serializeBody } from '../../webview/document/body-serializer';
import { removeEditingArtifacts } from '../../webview/document/editing-artifact';
import { createInverseTransformedCopy } from '../../webview/document/inverse-transform';
import {
  applySelection,
  createBoundaryIndex,
  findBoundaryAtOffset,
  resolveSelectionRange,
  resolveTextOffset,
  restoreSelection,
  toLiveBoundary,
} from '../../webview/selection/selection-restore';
import type { BoundaryIndex } from '../../webview/selection/selection-restore';

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
 * Builds an index, throwing if it cannot be built.
 *
 * @param root The editor root.
 * @returns The boundary index.
 */
function buildIndex(root: Element): BoundaryIndex {
  const index = createBoundaryIndex(root);
  if (index === undefined) {
    throw new Error('The boundary index could not be built');
  }
  return index;
}

describe('candidate boundary index', () => {
  it('contains a string matching the current form of the same tree', () => {
    const root = buildRoot('<p>ab<em></em>cd<br></p><p>ef</p>');

    expect(buildIndex(root).text).toBe(currentForm(root));
  });

  it('orders candidate character offsets in document order', () => {
    const index = buildIndex(buildRoot('<p>ab</p><p>cd</p>'));
    const sorted = [...index.offsets].sort((left, right) => left - right);

    expect(index.offsets).toEqual(sorted);
  });
});

describe('finding boundaries from character offsets', () => {
  it('returns the candidate boundary at a matching character offset', () => {
    const root = buildRoot('<p>ab</p>');
    const index = buildIndex(root);

    // Immediately after `<p>ab`, which is the child offset at the end of the paragraph.
    const boundary = findBoundaryAtOffset(index, '<p>ab'.length);

    expect(index.candidates).toContainEqual(boundary);
  });

  it('clamps a character offset inside a start tag before the element first child', () => {
    const root = buildRoot('<p class="x">ab</p>');
    const index = buildIndex(root);

    // Within `<p cl`, which is inside the start tag.
    const boundary = findBoundaryAtOffset(index, 5);

    expect(boundary.offset).toBe(0);
    expect(boundary.container).toBe(index.candidates[1].container);
  });

  it('clamps a character offset inside an img tag to the boundary before the img', () => {
    const root = buildRoot('<p><img src="a.png">b</p>');
    const index = buildIndex(root);
    const paragraph = root.children[0];

    // Within `<p><img sr`, which is inside the tag of an element that cannot have content.
    const boundary = findBoundaryAtOffset(index, '<p><img'.length);

    expect(toLiveBoundary(index, boundary)).toEqual({ container: paragraph, offset: 0 });
  });

  it('clamps a character offset inside an end tag after the element last child', () => {
    const root = buildRoot('<p>ab</p>');
    const index = buildIndex(root);

    // Within `<p>ab</`, which is inside the end tag.
    const boundary = findBoundaryAtOffset(index, '<p>ab<'.length + 1);

    expect(boundary).toEqual({ container: index.candidates[2].container, offset: 1 });
  });
});

describe('resolving character offsets within text nodes', () => {
  it('resolves an offset within text containing & from escaped length to the raw offset', () => {
    const text = document.createTextNode('a&b');

    // The six characters through `a&amp;` correspond to the position after two raw characters, `a&`.
    expect(resolveTextOffset(text, 6)).toBe(2);
  });

  it('returns the end when the serialized length exceeds the complete text', () => {
    const text = document.createTextNode('a&b');

    expect(resolveTextOffset(text, 99)).toBe(3);
  });
});

describe('mapping back to the live tree', () => {
  it('maps to the live child offset when editing-artifact removal deletes an empty em', () => {
    const root = buildRoot('<p>ab<em></em>cd</p>');
    const index = buildIndex(root);
    const paragraph = root.children[0];

    // In the copy, the em is gone and this is the position between adjacent `ab` and `cd`.
    const boundary = findBoundaryAtOffset(index, '<p>ab'.length);

    // In the live tree, the em remains between them, making `cd` the third child.
    expect(toLiveBoundary(index, boundary)).toEqual({ container: paragraph, offset: 2 });
  });

  it('preserves the mapped position with whitespace-only text nodes between blocks', () => {
    const root = buildRoot('\n<p>ab</p>\n<p>cd</p>\n');
    const index = buildIndex(root);

    // Immediately after the second paragraph's start tag.
    const boundary = findBoundaryAtOffset(index, '\n<p>ab</p>\n<p>'.length);

    expect(toLiveBoundary(index, boundary)).toEqual({ container: root.children[1], offset: 0 });
  });
});

describe('applying a selection', () => {
  it('does not apply or change the selection when the boundary is invalid', () => {
    const root = buildRoot('<p>ab</p>');
    document.body.append(root);
    const paragraph = root.children[0];

    // An absent boundary at the ninth child of a paragraph with only one child.
    const applied = applySelection({ container: paragraph, offset: 9 }, { container: paragraph, offset: 9 });

    expect(applied).toBe(false);
    root.remove();
  });
});

describe('turning an encoded selection into a range', () => {
  it('turns an encoded selection into a range with the same boundaries restoreSelection applies, without changing the selection', () => {
    const root = buildRoot('<p>ab<em>cd</em></p>');
    document.body.append(root);
    const encoded = { start: { line: 0, column: 4 }, end: { line: 0, column: 10 } };
    const before = document.createRange();
    before.selectNodeContents(root);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(before);

    const range = resolveSelectionRange(root, encoded);
    const kept = window.getSelection()?.getRangeAt(0);
    const ends = [range?.startContainer, range?.startOffset, range?.endContainer, range?.endOffset];
    restoreSelection(root, encoded);
    const restored = window.getSelection()?.getRangeAt(0);

    expect([
      kept === before,
      ends,
    ]).toEqual([
      true,
      [restored?.startContainer, restored?.startOffset, restored?.endContainer, restored?.endOffset],
    ]);
    root.remove();
  });

  it('returns undefined for a selection whose character offsets cannot be determined', () => {
    const root = buildRoot('<p>ab</p>');

    expect(resolveSelectionRange(root, { start: { line: 5, column: 0 }, end: { line: 5, column: 0 } }))
      .toBeUndefined();
  });
});

describe('restoring a selection', () => {
  it('places the caret at the editor root start without throwing when no selection is encoded', () => {
    const root = buildRoot('<p>ab</p>');
    document.body.append(root);

    restoreSelection(root, undefined);

    const range = window.getSelection()?.getRangeAt(0);
    expect({ container: range?.startContainer, offset: range?.startOffset })
      .toEqual({ container: root, offset: 0 });

    root.remove();
  });
});
