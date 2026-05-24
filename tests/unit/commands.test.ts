import { afterEach, describe, expect, it } from 'vitest';
import {
  type CommandContext,
  findInlineAncestor,
  insertHr,
  insertLink,
  setBlockTag,
  toggleInline,
  wrapInComment,
} from '../../webview/commands';
import { caretAtStart, clearDom, makeRoot, selectContents, selectTextRange } from './helpers/selection';

afterEach(clearDom);

function ctxOf(root: HTMLElement): CommandContext {
  return { root };
}

describe('toggleInline', () => {
  it('wraps the selected range in the requested inline tag', () => {
    const root = makeRoot('<p>hello world</p>');
    const text = root.querySelector('p')!.firstChild!;
    selectTextRange(text, 0, 5); // "hello"
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p><strong>hello</strong> world</p>');
  });

  it('unwraps when the selection is already inside the requested tag', () => {
    const root = makeRoot('<p><strong>hello</strong> world</p>');
    const strong = root.querySelector('strong')!;
    selectContents(strong);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p>hello world</p>');
  });

  it('does nothing when the selection is collapsed', () => {
    const root = makeRoot('<p>hello</p>');
    caretAtStart(root.querySelector('p')!);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p>hello</p>');
  });

  it('supports em and code in the same way', () => {
    const root = makeRoot('<p>hello world</p>');
    const text = root.querySelector('p')!.firstChild!;
    selectTextRange(text, 0, 5);
    toggleInline('em', ctxOf(root));
    expect(root.innerHTML).toBe('<p><em>hello</em> world</p>');

    const em = root.querySelector('em')!;
    selectContents(em);
    toggleInline('em', ctxOf(root));
    expect(root.innerHTML).toBe('<p>hello world</p>');
  });
});

describe('setBlockTag', () => {
  it('replaces a P with the requested heading and preserves text content', () => {
    const root = makeRoot('<p>title</p>');
    caretAtStart(root.querySelector('p')!);
    setBlockTag('h1', ctxOf(root));
    expect(root.innerHTML).toBe('<h1>title</h1>');
  });

  it('preserves attributes on the replaced block', () => {
    const root = makeRoot('<p class="x" id="y">title</p>');
    caretAtStart(root.querySelector('p')!);
    setBlockTag('h2', ctxOf(root));
    const h2 = root.querySelector('h2')!;
    expect(h2.getAttribute('class')).toBe('x');
    expect(h2.getAttribute('id')).toBe('y');
    expect(h2.textContent).toBe('title');
  });

  it('does nothing when no block ancestor is found', () => {
    const root = makeRoot('plain text');
    const r = document.createRange();
    r.setStart(root.firstChild!, 0);
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    setBlockTag('h1', ctxOf(root));
    expect(root.innerHTML).toBe('plain text');
  });
});

describe('insertHr', () => {
  it('inserts an <hr> after the current block and follows with a fresh paragraph', () => {
    const root = makeRoot('<p>hello</p>');
    caretAtStart(root.querySelector('p')!);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe('<p>hello</p><hr><p><br></p>');
  });

  it('removes the original block if it is empty', () => {
    const root = makeRoot('<p></p>');
    caretAtStart(root.querySelector('p')!);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe('<hr><p><br></p>');
  });

  it('falls back to appending at the root if no block ancestor exists', () => {
    const root = makeRoot('plain');
    const r = document.createRange();
    r.setStart(root.firstChild!, 0);
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe('plain<hr><p><br></p>');
  });
});

describe('wrapInComment', () => {
  it('wraps the selected range in <comment>', () => {
    const root = makeRoot('<p>hello world</p>');
    const text = root.querySelector('p')!.firstChild!;
    selectTextRange(text, 0, 5);
    wrapInComment(ctxOf(root));
    expect(root.innerHTML).toBe('<p><comment>hello</comment> world</p>');
  });

  it('inserts an empty <comment> at the caret when the selection is collapsed', () => {
    const root = makeRoot('<p>hello</p>');
    caretAtStart(root.querySelector('p')!);
    wrapInComment(ctxOf(root));
    expect(root.innerHTML).toBe('<p><comment><br></comment>hello</p>');
  });
});

describe('insertLink', () => {
  it('wraps the selected range in <a href>', () => {
    const root = makeRoot('<p>click here</p>');
    const text = root.querySelector('p')!.firstChild!;
    selectTextRange(text, 0, 5);
    insertLink('https://example.com', ctxOf(root));
    expect(root.innerHTML).toBe('<p><a href="https://example.com">click</a> here</p>');
  });

  it('inserts the URL as text when called at a collapsed caret', () => {
    const root = makeRoot('<p>foo</p>');
    caretAtStart(root.querySelector('p')!);
    insertLink('https://example.com', ctxOf(root));
    expect(root.innerHTML).toBe('<p><a href="https://example.com">https://example.com</a>foo</p>');
  });

  it('updates the href of an existing <a> wrapper', () => {
    const root = makeRoot('<p><a href="https://old">x</a></p>');
    const a = root.querySelector('a')!;
    selectContents(a);
    insertLink('https://new', ctxOf(root));
    expect(root.innerHTML).toBe('<p><a href="https://new">x</a></p>');
  });

  it('unwraps when an empty href is passed and an <a> already exists', () => {
    const root = makeRoot('<p><a href="https://old">x</a></p>');
    const a = root.querySelector('a')!;
    selectContents(a);
    insertLink('', ctxOf(root));
    expect(root.innerHTML).toBe('<p>x</p>');
  });

  it('does nothing when href is empty and no <a> exists', () => {
    const root = makeRoot('<p>foo</p>');
    caretAtStart(root.querySelector('p')!);
    insertLink('', ctxOf(root));
    expect(root.innerHTML).toBe('<p>foo</p>');
  });
});

describe('findInlineAncestor', () => {
  it('returns the matching ancestor inside the root', () => {
    const root = makeRoot('<p><a href="x"><strong>hi</strong></a></p>');
    const strong = root.querySelector('strong')!;
    expect(findInlineAncestor(strong, 'A', root)).toBe(root.querySelector('a'));
  });

  it('returns null when the tag is not an ancestor', () => {
    const root = makeRoot('<p>hi</p>');
    expect(findInlineAncestor(root.querySelector('p')!.firstChild!, 'A', root)).toBeNull();
  });

  it('stops at the root and does not escape it', () => {
    const root = makeRoot('<p>hi</p>');
    const wrapperA = document.createElement('a');
    wrapperA.appendChild(root.cloneNode(true));
    expect(findInlineAncestor(root.querySelector('p')!.firstChild!, 'A', root)).toBeNull();
  });
});
