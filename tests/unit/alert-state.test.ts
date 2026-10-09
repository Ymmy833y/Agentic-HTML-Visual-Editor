import { describe, expect, it } from 'vitest';

import { ALERT_KINDS } from '../../common/index';
import { ALERT_STATE, findAlertTarget, readAlertState } from '../../webview/editing/alert-state';
import { createRoot, readElement } from './helpers/format-dom';

/**
 * Builds a tree and reads the state of one element inside it.
 *
 * @param html The contents of the editor root.
 * @param selector The selector that finds the target.
 * @returns The alert state.
 */
function readStateOf(html: string, selector: string): string {
  return readAlertState(readElement(createRoot(html), selector));
}

describe('deciding the alert state', () => {
  it('returns the kind when the attribute value of a bare blockquote matches the list', () => {
    expect(readStateOf('<blockquote data-alert="warning">a</blockquote>', 'blockquote'))
      .toBe('warning');
  });

  it('returns none for a bare blockquote carrying no alert attribute', () => {
    expect(readStateOf('<blockquote>a</blockquote>', 'blockquote')).toBe(ALERT_STATE.none);
  });

  it('returns unknown and leaves the attribute value untouched for a value differing in case, one carrying surrounding whitespace, and an empty one', () => {
    const root = createRoot(
      '<blockquote data-alert="Note">a</blockquote>'
      + '<blockquote data-alert=" note ">b</blockquote>'
      + '<blockquote data-alert="">c</blockquote>',
    );
    const quotes = [...root.querySelectorAll('blockquote')];

    expect(quotes.map((quote) => [readAlertState(quote), quote.getAttribute('data-alert')]))
      .toEqual([
        [ALERT_STATE.unknown, 'Note'],
        [ALERT_STATE.unknown, ' note '],
        [ALERT_STATE.unknown, ''],
      ]);
  });

  it('returns none for an element other than a blockquote, even when it carries a known value', () => {
    expect(readStateOf('<p data-alert="note">a</p>', 'p')).toBe(ALERT_STATE.none);
  });

  it('returns the kind for a blockquote holding a paragraph as a child, the same as for a bare one', () => {
    expect(readStateOf('<blockquote data-alert="note"><p>a</p></blockquote>', 'blockquote'))
      .toBe('note');
  });

  it('returns none when there is no target, and that none is told apart from the unknown identifier and from all five kinds', () => {
    const identifiers: string[] = [ALERT_STATE.none, ALERT_STATE.unknown, ...ALERT_KINDS];

    expect([readAlertState(undefined), new Set(identifiers).size])
      .toEqual([ALERT_STATE.none, identifiers.length]);
  });
});

describe('finding the alert target', () => {
  it('returns a blockquote itself, bare or holding blocks', () => {
    const root = createRoot('<blockquote id="bare">a</blockquote><blockquote id="blocks"><p>b</p></blockquote>');
    const quotes = [...root.querySelectorAll('blockquote')];

    expect(quotes.map((quote) => findAlertTarget(quote, root) === quote)).toEqual([true, true]);
  });

  it('returns the innermost blockquote around a paragraph or a list item inside it', () => {
    const root = createRoot('<blockquote id="outer"><blockquote id="inner"><p>a</p></blockquote><ul><li>b</li></ul></blockquote>');

    expect([findAlertTarget(readElement(root, 'p'), root)?.id, findAlertTarget(readElement(root, 'li'), root)?.id])
      .toEqual(['inner', 'outer']);
  });

  it('returns a block outside any blockquote itself, and nothing when there is no block', () => {
    const root = createRoot('<p>a</p>');
    const paragraph = readElement(root, 'p');

    expect([findAlertTarget(paragraph, root) === paragraph, findAlertTarget(undefined, root)]).toEqual([true, undefined]);
  });
});
