import { describe, expect, it } from 'vitest';

import { ReturnSelection } from '../../webview/search/return-selection';
import { createBoundaryIndex } from '../../webview/selection/selection-restore';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/**
 * Reads the current form of the tree, using the same steps as building the body output.
 *
 * @param root The editor root.
 * @returns The current form.
 */
function readCurrentForm(root: Element): string {
  const index = createBoundaryIndex(root);
  if (index === undefined) {
    throw new Error('Could not build the boundary index');
  }
  return index.text;
}

/**
 * Turns the start of a range into a pair of the container's text and the offset.
 *
 * @param range The range.
 * @returns The start pair. `undefined` if there is no range.
 */
function readStart(range: Range | undefined): (string | number | null)[] | undefined {
  return range === undefined ? undefined : [range.startContainer.textContent, range.startOffset];
}

describe('capturing the return selection', () => {
  it('keeps nothing when the selection is outside the editor root', () => {
    const root = mountRoot('<p>ab</p>');
    const inside = readChildText(readElement(root, 'p'), 0);
    select(createRange(inside, 1, inside, 1));
    const selection = new ReturnSelection(root);
    selection.capture();
    const outside = document.createElement('p');
    outside.textContent = 'x';
    document.body.append(outside);
    select(createRange(outside, 0, outside, 1));

    selection.capture();

    expect(selection.readRange()).toBeUndefined();
  });
});

describe('refreshing and remapping the return selection', () => {
  it('shifts the encoding to keep pointing at the same character when refreshed after adding an attribute to an earlier element on the same line', () => {
    const root = mountRoot('<p><em>x</em>ab</p>');
    const text = readChildText(readElement(root, 'p'), 1);
    select(createRange(text, 1, text, 1));
    const selection = new ReturnSelection(root);
    selection.capture();
    readElement(root, 'em').setAttribute('class', 'k');

    selection.refresh();
    // Remapping with an unchanged current form turns the encoding directly into a range, so this checks which
    // character the encoding points at.
    selection.remap(readCurrentForm(root));

    expect(readStart(selection.readRange())).toEqual(['ab', 1]);
  });

  it('becomes a range pointing at the same character in the new tree when remapped to a current form with one line added before', () => {
    const root = mountRoot('\n<p>ab</p>\n');
    const text = readChildText(readElement(root, 'p'), 0);
    select(createRange(text, 1, text, 1));
    const selection = new ReturnSelection(root);
    selection.capture();
    root.innerHTML = '\n<p>new</p>\n<p>ab</p>\n';

    selection.remap(readCurrentForm(root));

    const range = selection.readRange();
    expect([readStart(range), range?.startContainer === readChildText(readElement(root, 'p + p'), 0)])
      .toEqual([['ab', 1], true]);
  });

  it('discards the kept selection when the current form is empty or missing', () => {
    const root = mountRoot('<p>ab</p>');
    const text = readChildText(readElement(root, 'p'), 0);
    select(createRange(text, 1, text, 1));
    const selection = new ReturnSelection(root);
    selection.capture();
    selection.remap('');
    const afterEmpty = selection.readRange();
    selection.capture();

    selection.remap(undefined);

    expect([afterEmpty, selection.readRange()]).toEqual([undefined, undefined]);
  });
});

describe('a kept selection in the body of a closed collapsible section', () => {
  it('encode returns undefined when either end is in the body of a closed collapsible section', () => {
    const root = mountRoot('<details open=""><summary>t</summary><p>body</p></details>');
    const text = readChildText(readElement(root, 'details > p'), 0);
    select(createRange(text, 1, text, 2));
    const selection = new ReturnSelection(root);
    selection.capture();
    readElement(root, 'details').removeAttribute('open');

    expect(selection.encode()).toBeUndefined();
  });

  it('restore discards the kept selection without changing the selection when an end is in the body of a closed collapsible section', () => {
    const root = mountRoot('<details open=""><summary>t</summary><p>body</p></details>');
    const text = readChildText(readElement(root, 'details > p'), 0);
    select(createRange(text, 1, text, 2));
    const selection = new ReturnSelection(root);
    selection.capture();
    readElement(root, 'details').removeAttribute('open');
    const title = readChildText(readElement(root, 'summary'), 0);
    select(createRange(title, 1, title, 1));

    selection.restore();

    const current = window.getSelection();
    expect([current?.anchorNode === title, current?.anchorOffset, selection.readRange()])
      .toEqual([true, 1, undefined]);
  });
});
