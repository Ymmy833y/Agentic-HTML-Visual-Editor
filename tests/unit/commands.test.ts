import { afterEach, describe, expect, it } from 'vitest';
import {
  addComment,
  type CommandContext,
  findInlineAncestor,
  getCurrentBlockTag,
  insertHr,
  insertLink,
  removeComment,
  setBlockTag,
  toggleInline,
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

describe('addComment', () => {
  it('wraps the selected range in <comment id> with an empty <comment-body>', () => {
    const root = makeRoot('<p>hello world</p>');
    const text = root.querySelector('p')!.firstChild!;
    selectTextRange(text, 0, 5);
    const created = addComment(ctxOf(root));
    expect(created).not.toBeNull();
    const id = created!.getAttribute('id');
    expect(id).toMatch(/^c-[a-z0-9]+$/);
    expect(root.innerHTML).toBe(
      `<p><comment id="${id}">hello<comment-body contenteditable="false"></comment-body></comment> world</p>`,
    );
  });

  it('returns null and does nothing when the selection is collapsed', () => {
    const root = makeRoot('<p>hello</p>');
    caretAtStart(root.querySelector('p')!);
    expect(addComment(ctxOf(root))).toBeNull();
    expect(root.innerHTML).toBe('<p>hello</p>');
  });

  it('returns null and does nothing when the selection spans multiple block ancestors', () => {
    const root = makeRoot('<p>first</p><p>second</p>');
    const firstText = root.querySelectorAll('p')[0].firstChild!;
    const secondText = root.querySelectorAll('p')[1].firstChild!;
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(firstText, 0);
    r.setEnd(secondText, 3);
    sel.removeAllRanges();
    sel.addRange(r);
    expect(addComment(ctxOf(root))).toBeNull();
    expect(root.innerHTML).toBe('<p>first</p><p>second</p>');
  });

  it('wraps a selection inside a table cell (<td>)', () => {
    const root = makeRoot(
      '<table><tbody><tr><td>hello world</td></tr></tbody></table>',
    );
    const text = root.querySelector('td')!.firstChild!;
    selectTextRange(text, 0, 5);
    const created = addComment(ctxOf(root));
    expect(created).not.toBeNull();
    const id = created!.getAttribute('id')!;
    expect(root.innerHTML).toBe(
      '<table><tbody><tr><td>' +
        `<comment id="${id}">hello<comment-body contenteditable="false"></comment-body></comment>` +
        ' world</td></tr></tbody></table>',
    );
  });

  it('wraps a selection inside a header cell (<th>)', () => {
    const root = makeRoot(
      '<table><thead><tr><th>column header</th></tr></thead></table>',
    );
    const text = root.querySelector('th')!.firstChild!;
    selectTextRange(text, 0, 6);
    const created = addComment(ctxOf(root));
    expect(created).not.toBeNull();
    expect(root.querySelector('th > comment')?.textContent?.startsWith('column')).toBe(true);
  });

  it('returns null when the selection spans two different table cells', () => {
    const root = makeRoot(
      '<table><tbody><tr><td>aaa</td><td>bbb</td></tr></tbody></table>',
    );
    const cells = root.querySelectorAll('td');
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(cells[0].firstChild!, 0);
    r.setEnd(cells[1].firstChild!, 3);
    sel.removeAllRanges();
    sel.addRange(r);
    expect(addComment(ctxOf(root))).toBeNull();
    expect(root.querySelector('comment')).toBeNull();
  });
});

describe('removeComment', () => {
  it('unwraps the comment and discards body/replies, leaving only the target text', () => {
    const root = makeRoot(
      '<p>before <comment id="c1">target<comment-body>note</comment-body><comment-reply>r1</comment-reply></comment> after</p>',
    );
    const comment = root.querySelector('comment')!;
    removeComment(ctxOf(root), comment as HTMLElement);
    expect(root.innerHTML).toBe('<p>before target after</p>');
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

describe('toggleInline — strikethrough (s)', () => {
  it('wraps the selected range in <s>', () => {
    const root = makeRoot('<p>hello world</p>');
    const text = root.querySelector('p')!.firstChild!;
    selectTextRange(text, 0, 5);
    toggleInline('s', ctxOf(root));
    expect(root.innerHTML).toBe('<p><s>hello</s> world</p>');
  });

  it('unwraps an existing <s> wrapper', () => {
    const root = makeRoot('<p><s>hello</s> world</p>');
    const s = root.querySelector('s')!;
    selectContents(s);
    toggleInline('s', ctxOf(root));
    expect(root.innerHTML).toBe('<p>hello world</p>');
  });
});

describe('setBlockTag — pre', () => {
  it('converts a <p> to <pre>', () => {
    const root = makeRoot('<p>code here</p>');
    caretAtStart(root.querySelector('p')!);
    setBlockTag('pre', ctxOf(root));
    expect(root.innerHTML).toBe('<pre>code here</pre>');
  });

  it('converts a <pre> back to <p>', () => {
    const root = makeRoot('<pre>code here</pre>');
    caretAtStart(root.querySelector('pre')!);
    setBlockTag('p', ctxOf(root));
    expect(root.innerHTML).toBe('<p>code here</p>');
  });
});

describe('getCurrentBlockTag', () => {
  it('returns "p" when cursor is in a paragraph', () => {
    const root = makeRoot('<p>text</p>');
    expect(getCurrentBlockTag(root.querySelector('p')!.firstChild!, root)).toBe('p');
  });

  it('returns "h2" when cursor is in an h2', () => {
    const root = makeRoot('<h2>heading</h2>');
    expect(getCurrentBlockTag(root.querySelector('h2')!.firstChild!, root)).toBe('h2');
  });

  it('returns "blockquote" when cursor is in a blockquote', () => {
    const root = makeRoot('<blockquote>quote</blockquote>');
    expect(getCurrentBlockTag(root.querySelector('blockquote')!.firstChild!, root)).toBe('blockquote');
  });

  it('returns "pre" when cursor is in a pre element', () => {
    const root = makeRoot('<pre>code</pre>');
    expect(getCurrentBlockTag(root.querySelector('pre')!.firstChild!, root)).toBe('pre');
  });

  it('returns the nearest block tag even when cursor is inside inline elements', () => {
    const root = makeRoot('<p><strong><em>text</em></strong></p>');
    const text = root.querySelector('em')!.firstChild!;
    expect(getCurrentBlockTag(text, root)).toBe('p');
  });

  it('returns "" when cursor is directly in the root with no block ancestor', () => {
    const root = makeRoot('plain text');
    expect(getCurrentBlockTag(root.firstChild!, root)).toBe('');
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
