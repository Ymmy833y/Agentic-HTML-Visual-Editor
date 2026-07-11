import { afterEach, describe, expect, it } from 'vitest';
import { insertFragmentAtCursor } from '../../webview/features/clipboard/insert';
import { caretAtEnd, clearDom, makeRoot } from './helpers/selection';

afterEach(clearDom);

function fragment(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

describe('insertFragmentAtCursor', () => {
  it('replaces a backward paragraph selection without leaving its end block', () => {
    const root = makeRoot('<h2>Heading2</h2><p>This is sample text.</p>');
    const paragraph = root.querySelector('p')!;
    const paragraphIndex = Array.from(root.childNodes).indexOf(paragraph);
    const range = document.createRange();
    range.setStart(root, paragraphIndex);
    range.setEnd(paragraph.firstChild!, paragraph.textContent.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    insertFragmentAtCursor(root, fragment('<p>This is sample text.</p>'));

    expect(root.innerHTML).toBe(
      '<h2>Heading2</h2><p>This is sample text.</p>',
    );
  });

  it('replaces a paragraph selection whose end boundary is outside the paragraph', () => {
    const root = makeRoot('<h2>Heading</h2><p>This is sample text.</p>');
    const paragraph = root.querySelector('p')!;
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 0);
    range.setEndAfter(paragraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    insertFragmentAtCursor(root, fragment('<p>This is sample text.</p>'));

    expect(root.innerHTML).toBe(
      '<h2>Heading</h2><p>This is sample text.</p>',
    );
  });

  it('inserts a copied paragraph beside the caret paragraph instead of nesting it', () => {
    const root = makeRoot('<h2>Heading</h2><p>This is sample text.</p>');
    caretAtEnd(root.querySelector('p')!);

    insertFragmentAtCursor(root, fragment('<p>This is sample text.</p>'));

    expect(root.innerHTML).toBe(
      '<h2>Heading</h2><p>This is sample text.</p><p>This is sample text.</p>',
    );
    expect(root.querySelector('p p')).toBeNull();
  });

  it('keeps inline clipboard content inside the caret paragraph', () => {
    const root = makeRoot('<p>before</p>');
    caretAtEnd(root.querySelector('p')!);

    insertFragmentAtCursor(root, fragment('<strong>after</strong>'));

    expect(root.innerHTML).toBe('<p>before<strong>after</strong></p>');
  });

  it('removes the empty inline wrapper left when splitting at a styled paragraph start', () => {
    const root = makeRoot(
      '<p><span style="font-size: 1.25em; font-weight: 600;">Level 3 heading</span></p>',
    );
    const headingText = root.querySelector('span')!.firstChild!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(headingText, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    insertFragmentAtCursor(root, fragment('<p>This is sample text.</p>'));

    expect(root.innerHTML).toBe(
      '<p>This is sample text.</p>' +
        '<p><span style="font-size: 1.25em; font-weight: 600;">Level 3 heading</span></p>',
    );
  });
});
