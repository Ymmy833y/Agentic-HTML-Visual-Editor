import { describe, expect, it } from 'vitest';

import { applyAlert } from '../../webview/editing/alert-apply';
import type { AlertSelection } from '../../webview/editing/alert-apply';
import { ALERT_STATE } from '../../webview/editing/alert-state';
import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { createRoot, readElement } from './helpers/format-dom';

/**
 * Builds a tree and applies an alert to the target inside it.
 *
 * @param html The contents of the editor root.
 * @param selector The selector that finds the target.
 * @param selection The alert selection.
 * @returns The contents of the editor root, and whether the tree was changed.
 */
function applyTo(
  html: string,
  selector: string,
  selection: AlertSelection,
): { html: string; changed: boolean } {
  const root = createRoot(html);
  const progress: BlockRewriteProgress = { changed: false };

  applyAlert([readElement(root, selector)], selection, progress, root);

  return { html: root.innerHTML, changed: progress.changed };
}

describe('applying an alert', () => {
  it('turns a convertible block that is not a blockquote into one and sets the attribute to that value', () => {
    expect(applyTo('<p>ab</p>', 'p', 'note'))
      .toEqual({ html: '<blockquote data-alert="note">ab</blockquote>', changed: true });
  });

  it('adds the attribute alone without replacing the element for a bare blockquote carrying none', () => {
    const root = createRoot('<blockquote>ab</blockquote>');
    const quote = readElement(root, 'blockquote');
    const progress: BlockRewriteProgress = { changed: false };

    applyAlert([quote], 'tip', progress, root);

    expect([root.innerHTML, readElement(root, 'blockquote') === quote])
      .toEqual(['<blockquote data-alert="tip">ab</blockquote>', true]);
  });

  it('swaps the attribute for the selection when a blockquote carries another kind', () => {
    expect(applyTo('<blockquote data-alert="note">ab</blockquote>', 'blockquote', 'caution'))
      .toEqual({ html: '<blockquote data-alert="caution">ab</blockquote>', changed: true });
  });

  it('removes the attribute and leaves the blockquote as it is when none is applied to a known value', () => {
    expect(applyTo('<blockquote data-alert="note">ab</blockquote>', 'blockquote', ALERT_STATE.none))
      .toEqual({ html: '<blockquote>ab</blockquote>', changed: true });
  });

  it('converts a paragraph carrying a known value into a blockquote and then removes the attribute when none is applied', () => {
    expect(applyTo('<p data-alert="note">ab</p>', 'p', ALERT_STATE.none))
      .toEqual({ html: '<blockquote>ab</blockquote>', changed: true });
  });

  it('leaves the attribute value as it is when none is applied to a blockquote carrying an unknown value', () => {
    expect(applyTo('<blockquote data-alert="Note">ab</blockquote>', 'blockquote', ALERT_STATE.none))
      .toEqual({ html: '<blockquote data-alert="Note">ab</blockquote>', changed: false });
  });

  it('overwrites the value with the selection when a kind is applied to a blockquote carrying an unknown value', () => {
    expect(applyTo('<blockquote data-alert="Note">ab</blockquote>', 'blockquote', 'note'))
      .toEqual({ html: '<blockquote data-alert="note">ab</blockquote>', changed: true });
  });

  it('changes neither the tree nor the rewrite progress when the same kind is applied again', () => {
    expect(applyTo('<blockquote data-alert="tip">ab</blockquote>', 'blockquote', 'tip'))
      .toEqual({ html: '<blockquote data-alert="tip">ab</blockquote>', changed: false });
  });

  it('does nothing for a blockquote carrying no attribute, because the none of the selection is the same value as the none of the state', () => {
    expect(applyTo('<blockquote>ab</blockquote>', 'blockquote', ALERT_STATE.none))
      .toEqual({ html: '<blockquote>ab</blockquote>', changed: false });
  });

  it('rewrites no target that is not convertible and outside a blockquote, and still processes the other targets in the same list', () => {
    const root = createRoot(
      '<ul><li>a</li></ul><table><tbody><tr><td>b</td></tr></tbody></table>'
      + '<blockquote><p>c</p></blockquote><p id="tail">d</p>',
    );
    const targets = ['li', 'td', 'blockquote', '#tail']
      .map((selector) => readElement(root, selector));
    const progress: BlockRewriteProgress = { changed: false };

    applyAlert(targets, 'note', progress, root);

    expect([root.innerHTML, progress.changed]).toEqual([
      '<ul><li>a</li></ul><table><tbody><tr><td>b</td></tr></tbody></table>'
      + '<blockquote data-alert="note"><p>c</p></blockquote><blockquote id="tail" data-alert="note">d</blockquote>',
      true,
    ]);
  });

  it('changes the alert of the blockquote around a paragraph inside it rather than nesting a new blockquote', () => {
    expect(applyTo('<blockquote data-alert="note"><p>ab</p></blockquote>', 'p', 'tip')).toEqual({
      html: '<blockquote data-alert="tip"><p>ab</p></blockquote>',
      changed: true,
    });
  });

  it('clears the alert of the blockquote around a paragraph inside it when none is applied', () => {
    expect(applyTo('<blockquote data-alert="note"><p>ab</p></blockquote>', 'p', ALERT_STATE.none)).toEqual({
      html: '<blockquote><p>ab</p></blockquote>',
      changed: true,
    });
  });

  it('acts on the blockquote around a list item, and once on a blockquote that two targets share', () => {
    const root = createRoot('<blockquote><ul><li>a</li></ul><p>b</p></blockquote>');
    const progress: BlockRewriteProgress = { changed: false };

    applyAlert([readElement(root, 'li'), readElement(root, 'p')], 'caution', progress, root);

    expect(root.innerHTML).toBe('<blockquote data-alert="caution"><ul><li>a</li></ul><p>b</p></blockquote>');
  });

  it('leaves the body text and the contents of a comment untouched when the attribute is added or removed', () => {
    const contents = 'a<strong>b</strong><comment id="c1">c'
      + '<comment-body data-author="ai">d</comment-body></comment>';

    expect(applyTo(`<blockquote data-alert="note">${contents}</blockquote>`, 'blockquote', 'tip'))
      .toEqual({ html: `<blockquote data-alert="tip">${contents}</blockquote>`, changed: true });
  });

  it('keeps the first rewrite in the progress even when rewriting the second target throws', () => {
    const root = createRoot('<blockquote>a</blockquote><blockquote>b</blockquote>');
    const quotes = [...root.querySelectorAll('blockquote')];
    Object.defineProperty(quotes[1], 'setAttribute', {
      value: () => {
        throw new Error('could not set the attribute');
      },
    });
    const progress: BlockRewriteProgress = { changed: false };

    // Exceptions are not caught here but left to the catch outside.
    expect(() => applyAlert(quotes, 'note', progress, root)).toThrow();
    expect([progress.changed, quotes[0].getAttribute('data-alert')]).toEqual([true, 'note']);
  });
});
