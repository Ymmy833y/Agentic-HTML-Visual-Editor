import { afterEach, describe, expect, it } from 'vitest';
import { insertFragmentAtCursor } from '../../webview/features/clipboard/insert';
import { caretAtEnd, caretAtStart, clearDom, makeRoot } from './helpers/selection';

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

// A fresh .html opened straight in the WYSIWYG view has no block for the
// insertion to anchor to, so inline clipboard content landed directly under the
// root. Typing, Enter and IME composition all materialize the canonical
// paragraph first (see core/editor-core); paste is the remaining entry point,
// and without it the document's initial shape depended on which one the user
// happened to use.
describe('insertFragmentAtCursor — an effectively empty document', () => {
  it('wraps pasted inline content in a paragraph', () => {
    const root = makeRoot('');
    caretAtStart(root);

    insertFragmentAtCursor(root, fragment('pasted'));

    expect(root.innerHTML).toBe('<p>pasted</p>');
  });

  it('does not leave the paragraph placeholder beside the pasted text', () => {
    const root = makeRoot('');
    caretAtStart(root);

    insertFragmentAtCursor(root, fragment('<strong>bold</strong>'));

    expect(root.innerHTML).toBe('<p><strong>bold</strong></p>');
    expect(root.querySelector('br')).toBeNull();
  });

  it('leaves no empty paragraph behind when the clipboard carries blocks', () => {
    const root = makeRoot('');
    caretAtStart(root);

    insertFragmentAtCursor(root, fragment('<h2>Heading</h2><p>body</p>'));

    expect(root.innerHTML).toBe('<h2>Heading</h2><p>body</p>');
  });

  it('treats a whitespace-and-break document as empty too', () => {
    const root = makeRoot('<br>');
    caretAtStart(root);

    insertFragmentAtCursor(root, fragment('pasted'));

    expect(root.innerHTML).toBe('<p>pasted</p>');
  });

  it('leaves an existing bare root-level run alone', () => {
    // Bare runs in an existing document are a supported shape; pasting into one
    // must not rewrite it into a paragraph.
    const root = makeRoot('hello');
    caretAtEnd(root.firstChild!);

    insertFragmentAtCursor(root, fragment(' there'));

    expect(root.innerHTML).toBe('hello there');
  });

  it('leaves a document holding an image to the ordinary path', () => {
    const root = makeRoot('<img src="a.png" alt="a">');
    caretAtStart(root);

    insertFragmentAtCursor(root, fragment('pasted'));

    expect(root.querySelector('p')).toBeNull();
    expect(root.querySelector('img')).not.toBeNull();
  });
});
