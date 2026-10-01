import { beforeEach, describe, expect, it } from 'vitest';

import { ALERT_STATE } from '../../webview/editing/alert-state';
import { BLOCK_KIND } from '../../webview/editing/block-format';
import { NO_CARET_STATE, readCaretState } from '../../webview/editing/caret-state';
import type { CaretState } from '../../webview/editing/caret-state';
import { LIST_KIND } from '../../webview/editing/list-structure';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** The state in which no format is formatted. */
const NO_FORMAT = {
  bold: false,
  italic: false,
  strikethrough: false,
  inlineCode: false,
  link: false,
};

/**
 * Builds the tree, places the caret inside the first text of the given element, and evaluates.
 *
 * @param html Contents of the editor root.
 * @param selector Selector that finds the element to place the caret in.
 * @returns The caret state.
 */
function readStateAtCaret(html: string, selector: string): CaretState {
  const root = mountRoot(html);
  const text = readChildText(readElement(root, selector), 0);
  select(createRange(text, 1, text, 1));
  return readCaretState(root);
}

describe('Evaluating the current selection', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('with no selection, returns no kind, not convertible, no alert, and nothing formatted', () => {
    const root = mountRoot('<p>a</p>');
    window.getSelection()?.removeAllRanges();

    expect(readCaretState(root)).toEqual({
      blockKind: undefined,
      convertible: false,
      alert: ALERT_STATE.none,
      formats: NO_FORMAT,
    });
  });

  it('with the caret inside bold, only bold is formatted', () => {
    expect(readStateAtCaret('<p><strong>abc</strong></p>', 'strong').formats).toEqual({
      ...NO_FORMAT,
      bold: true,
    });
  });

  it('with the caret in a bare blockquote with note, the kind is quote and the alert is note', () => {
    const state = readStateAtCaret('<blockquote data-alert="note">abc</blockquote>', 'blockquote');

    expect([state.blockKind, state.alert]).toEqual([BLOCK_KIND.quote, 'note']);
  });

  it('with the caret directly inside a blockquote that has a paragraph child, the kind stays quote and it is not convertible', () => {
    const state = readStateAtCaret('<blockquote>abc<p>d</p></blockquote>', 'blockquote');

    expect([state.blockKind, state.convertible]).toEqual([BLOCK_KIND.quote, false]);
  });

  it('with the caret in a bare run, there is no kind and the formats are those determined from ancestors', () => {
    const state = readStateAtCaret('<em>abc</em>', 'em');

    expect([state.blockKind, state.formats.italic]).toEqual([undefined, true]);
  });

  it('the no-target default matches the caret state with no selection', () => {
    const root = mountRoot('<p>a</p>');
    window.getSelection()?.removeAllRanges();

    expect(readCaretState(root)).toEqual(NO_CARET_STATE);
  });

  it('the list kind is ordered when the caret is in a numbered list item', () => {
    expect(readStateAtCaret('<ol><li>abc</li></ol>', 'li').listKind).toBe(LIST_KIND.ordered);
  });

  it('the list kind is "none", the same as the no-target default, when the caret is in a paragraph outside the list', () => {
    const state = readStateAtCaret('<p>abc</p><ul><li>d</li></ul>', 'p');

    expect([state.listKind, NO_CARET_STATE.listKind]).toEqual([undefined, undefined]);
  });

  it('for a selection crossing a closed details section, the bold format state is true if all visible characters are bold, even if the body is not', () => {
    const root = mountRoot(
      '<p id="before"><strong>ab</strong></p>'
      + '<details><summary><strong>st</strong></summary><p>plain</p></details>'
      + '<p id="after"><strong>cd</strong></p>',
    );
    select(createRange(
      readChildText(readElement(root, '#before strong'), 0),
      0,
      readChildText(readElement(root, '#after strong'), 0),
      2,
    ));

    expect(readCaretState(root).formats.bold).toBe(true);
  });
});
