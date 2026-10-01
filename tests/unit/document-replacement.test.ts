import { describe, expect, it } from 'vitest';

import {
  replaceDocumentPreservingSelection,
  replaceDocumentRestoringSelection,
} from '../../webview/selection/document-replacement';
import type { DocumentReplacementPorts } from '../../webview/selection/document-replacement';
import { createRange, mountRoot, readChildText, select } from './helpers/format-dom';

/**
 * Creates a stand-in for the document replacement ports. Swapping the tree only replaces the editor root's contents.
 *
 * @param root The editor root.
 * @param canPlaceSelection The can place selection port. When omitted, there is no such port.
 * @returns The document replacement ports.
 */
function createPorts(root: HTMLElement, canPlaceSelection?: () => boolean): DocumentReplacementPorts {
  const ports: DocumentReplacementPorts = {
    readEditorRoot: () => root,
    replaceDocument: (text) => {
      root.innerHTML = text;
      return true;
    },
    createBodyOutput: () => undefined,
    notifyDocumentReplaced: () => undefined,
  };
  return canPlaceSelection === undefined ? ports : { ...ports, canPlaceSelection };
}

/**
 * Places text outside the editor root and puts the selection there. Stands in for writing in a field.
 *
 * @returns The outside element.
 */
function selectOutside(): HTMLElement {
  const outside = document.createElement('div');
  outside.textContent = 'outside';
  document.body.append(outside);
  const text = readChildText(outside, 0);
  select(createRange(text, 1, text, 1));
  return outside;
}

/**
 * Returns whether the selection start is inside the editor root.
 *
 * @param root The editor root.
 * @returns `true` when inside.
 */
function isSelectionInRoot(root: HTMLElement): boolean {
  return root.contains(window.getSelection()?.anchorNode ?? null);
}

describe('Whether document replacement places the selection', () => {
  it('when the can place selection port returns false, no selection is placed in the editor root after document replacement', () => {
    const root = mountRoot('<p>a</p>');
    selectOutside();

    replaceDocumentPreservingSelection('<p>b</p>', createPorts(root, () => false));

    expect(isSelectionInRoot(root)).toBe(false);
  });

  it('when the can place selection port returns false, no selection is placed in the editor root after applying history', () => {
    const root = mountRoot('<p>a</p>');
    selectOutside();

    replaceDocumentRestoringSelection(
      '<p>b</p>',
      { start: { line: 0, column: 4 }, end: { line: 0, column: 4 } },
      createPorts(root, () => false),
    );

    expect(isSelectionInRoot(root)).toBe(false);
  });

  it('without the can place selection port, the selection is placed in the editor root after document replacement', () => {
    const root = mountRoot('<p>a</p>');
    selectOutside();

    replaceDocumentPreservingSelection('<p>b</p>', createPorts(root));

    expect(isSelectionInRoot(root)).toBe(true);
  });
});
