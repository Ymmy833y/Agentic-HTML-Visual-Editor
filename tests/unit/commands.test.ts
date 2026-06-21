import { afterEach, describe, expect, it } from 'vitest';
import { clearFormatting, toggleInline } from '../../webview/commands/inline-format';
import { insertDetails, insertHr, setBlockTag } from '../../webview/commands/block-format';
import { insertLink } from '../../webview/commands/link';
import { findInlineAncestor, getCurrentBlockTag } from '../../webview/commands/query';
import { addComment, removeComment } from '../../webview/features/comment/comment-commands';
import type { CommandContext } from '../../webview/shared/command-context';
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

  it('leaves a <summary> tag untouched (does not rewrite to a heading)', () => {
    const root = makeRoot('<details open><summary>title</summary><p>body</p></details>');
    caretAtStart(root.querySelector('summary')!);
    setBlockTag('h1', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<details open=""><summary>title</summary><p>body</p></details>',
    );
  });
});

describe('insertDetails', () => {
  it('inserts an open <details> with a summary and empty body after the block', () => {
    const root = makeRoot('<p>hello</p>');
    caretAtStart(root.querySelector('p')!);
    insertDetails(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<p>hello</p><details open=""><summary>Details</summary><p><br></p></details>',
    );
  });

  it('removes the original block if it is empty', () => {
    const root = makeRoot('<p></p>');
    caretAtStart(root.querySelector('p')!);
    insertDetails(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<details open=""><summary>Details</summary><p><br></p></details>',
    );
  });

  it('selects the summary contents so typing overwrites the placeholder', () => {
    const root = makeRoot('<p>hello</p>');
    caretAtStart(root.querySelector('p')!);
    insertDetails(ctxOf(root));
    const sel = window.getSelection()!;
    const summary = root.querySelector('summary')!;
    expect(sel.isCollapsed).toBe(false);
    expect(sel.toString()).toBe('Details');
    expect(summary.contains(sel.getRangeAt(0).commonAncestorContainer)).toBe(true);
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
    expect(created!.childNodes[0].textContent).toBe('hello');
    const body = created!.querySelector('comment-body')!;
    expect(body.getAttribute('contenteditable')).toBe('false');
    expect(body.textContent).toBe('');
    // The creator (a human editing in the WYSIWYG view) is recorded.
    expect(body.getAttribute('data-author')).toBe('human');
    expect(body.getAttribute('data-updated')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(root.querySelector('p')!.lastChild!.textContent).toBe(' world');
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
    const comment = root.querySelector('td > comment')!;
    expect(comment).toBe(created);
    expect(comment.childNodes[0].textContent).toBe('hello');
    expect(comment.querySelector('comment-body')!.getAttribute('contenteditable')).toBe('false');
    expect(root.querySelector('td')!.lastChild!.textContent).toBe(' world');
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
    removeComment(ctxOf(root), comment);
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

  it('places cursor inside the new <a> after wrapping a selection', () => {
    const root = makeRoot('<p>click here</p>');
    const text = root.querySelector('p')!.firstChild!;
    selectTextRange(text, 0, 5);
    insertLink('https://example.com', ctxOf(root));
    const sel = window.getSelection()!;
    const a = root.querySelector('a')!;
    expect(a.contains(sel.anchorNode)).toBe(true);
  });

  it('places cursor inside the new <a> after inserting at a collapsed caret', () => {
    const root = makeRoot('<p>foo</p>');
    caretAtStart(root.querySelector('p')!);
    insertLink('https://example.com', ctxOf(root));
    const sel = window.getSelection()!;
    const a = root.querySelector('a')!;
    expect(a.contains(sel.anchorNode)).toBe(true);
  });
});

// Helper: set a cross-node selection from (startNode, startOff) to (endNode, endOff).
function selectRange(startNode: Node, startOff: number, endNode: Node, endOff: number): void {
  const sel = window.getSelection()!;
  const r = document.createRange();
  r.setStart(startNode, startOff);
  r.setEnd(endNode, endOff);
  sel.removeAllRanges();
  sel.addRange(r);
}

describe('toggleInline — multi-style combinations', () => {
  it('applies italic to a fully-bold selection, nesting em inside strong', () => {
    const root = makeRoot('<p><strong>sample</strong></p>');
    selectContents(root.querySelector('strong')!);
    toggleInline('em', ctxOf(root));
    expect(root.innerHTML).toBe('<p><strong><em>sample</em></strong></p>');
  });

  it('removes bold from a bold+italic selection, leaving em intact', () => {
    const root = makeRoot('<p><strong><em>sample</em></strong></p>');
    selectContents(root.querySelector('strong')!);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p><em>sample</em></p>');
  });

  it('applies italic across bold and plain text, wrapping the whole selection in em', () => {
    const root = makeRoot('<p><strong>bold</strong> plain</p>');
    const p = root.querySelector('p')!;
    selectRange(p.querySelector('strong')!.firstChild!, 0, p.lastChild!, 6);
    toggleInline('em', ctxOf(root));
    expect(root.innerHTML).toBe('<p><em><strong>bold</strong> plain</em></p>');
  });

  it('removes bold from a fully-bold multi-element selection and merges adjacent em', () => {
    const root = makeRoot('<p><strong><em>bi</em><em>i</em></strong></p>');
    selectContents(root.querySelector('strong')!);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p><em>bii</em></p>');
  });

  it('applies code inside bold+italic nesting', () => {
    const root = makeRoot('<p><strong><em>sample</em></strong></p>');
    selectContents(root.querySelector('em')!);
    toggleInline('code', ctxOf(root));
    expect(root.innerHTML).toBe('<p><strong><em><code>sample</code></em></strong></p>');
  });
});

describe('toggleInline — partial overlap and multi-element', () => {
  it('extends bold into plain text and merges into a single <strong>', () => {
    const root = makeRoot('<p><strong>sam</strong>ple text</p>');
    const strong = root.querySelector('strong')!;
    const textAfter = strong.nextSibling!;
    selectRange(strong.firstChild!, 3, textAfter, 8); // from end of "sam" to end of "ple text"
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p><strong>sample text</strong></p>');
  });

  it('applies bold to a mixed bold+plain selection (any-lacks rule)', () => {
    const root = makeRoot('<p><strong>sam</strong>ple text</p>');
    const strong = root.querySelector('strong')!;
    const textAfter = strong.nextSibling!;
    selectRange(strong.firstChild!, 0, textAfter, 8);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p><strong>sample text</strong></p>');
  });

  it('applies bold across two bold elements and plain middle text', () => {
    const root = makeRoot('<p><strong>bold1</strong> middle <strong>bold2</strong></p>');
    const strongs = root.querySelectorAll('strong');
    selectRange(strongs[0].firstChild!, 0, strongs[1].firstChild!, 5);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p><strong>bold1 middle bold2</strong></p>');
  });

  it('removes bold from two adjacent bold elements when all selected text is bold', () => {
    const root = makeRoot('<p><strong>bold1</strong><strong>bold2</strong></p>');
    const strongs = root.querySelectorAll('strong');
    selectRange(strongs[0].firstChild!, 0, strongs[1].firstChild!, 5);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p>bold1bold2</p>');
  });

  it('removes all nesting when toggling off double-nested bold', () => {
    const root = makeRoot('<p><strong><strong>sample</strong></strong></p>');
    selectContents(root.querySelector('strong')!);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p>sample</p>');
  });

  it('applies bold to bold+plain text without creating redundant nesting', () => {
    const root = makeRoot('<p>This is <strong>sample</strong> text.</p>');
    const p = root.querySelector('p')!;
    selectRange(p.firstChild!, 0, p.lastChild!, 6);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p><strong>This is sample text.</strong></p>');
  });

  it('applies bold across bold+italic and italic-only, merging adjacent em', () => {
    const root = makeRoot('<p><strong><em>bi</em></strong><em>i</em></p>');
    const p = root.querySelector('p')!;
    const strong = p.querySelector('strong')!;
    const em2 = p.querySelectorAll('em')[1];
    selectRange(strong.firstChild!.firstChild!, 0, em2.firstChild!, 1);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p><strong><em>bii</em></strong></p>');
  });
});

describe('toggleInline — text-node bounded selections matching element content', () => {
  it('removes bold cleanly when a text-node-bounded selection matches the strong content exactly', () => {
    const root = makeRoot('<p>This is <strong>sample text</strong>.</p>');
    const text = root.querySelector('strong')!.firstChild!;
    selectRange(text, 0, text, 11);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p>This is sample text.</p>');
  });

  it('removes bold cleanly when text-node selection matches the nested em content exactly', () => {
    const root = makeRoot('<p>This is <strong><em>sample</em></strong> text.</p>');
    const text = root.querySelector('em')!.firstChild!;
    selectRange(text, 0, text, 6);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p>This is <em>sample</em> text.</p>');
  });

  it('splits cleanly when a partial range covers only the trailing portion of a strong', () => {
    const root = makeRoot('<p>This is <strong>sample text</strong>.</p>');
    const text = root.querySelector('strong')!.firstChild!;
    selectRange(text, 7, text, 11); // "text"
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p>This is <strong>sample </strong>text.</p>');
  });

  it('splits cleanly when a partial range covers only the middle portion of a strong (straddle)', () => {
    const root = makeRoot('<p><strong>hello world</strong></p>');
    const text = root.querySelector('strong')!.firstChild!;
    selectRange(text, 3, text, 9); // "lo wor"
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p><strong>hel</strong>lo wor<strong>ld</strong></p>');
  });

  it('merges adjacent em siblings as a side-effect of any toggle operation', () => {
    const root = makeRoot('<p><em>a</em><em>b</em>plain</p>');
    const text = root.querySelector('p')!.lastChild!; // "plain"
    selectRange(text, 0, text, 5);
    toggleInline('strong', ctxOf(root));
    // The toggle wraps "plain" in strong; normalizeInline also merges the adjacent em pair.
    expect(root.innerHTML).toBe('<p><em>ab</em><strong>plain</strong></p>');
  });
});

describe('insertLink — multi-link and partial-overlap selections', () => {
  it('merges two adjacent links into one when both are selected', () => {
    const root = makeRoot('<p><a href="url1">A</a><a href="url2">B</a></p>');
    const links = root.querySelectorAll('a');
    selectRange(links[0].firstChild!, 0, links[1].firstChild!, 1);
    insertLink('url3', ctxOf(root));
    expect(root.innerHTML).toBe('<p><a href="url3">AB</a></p>');
  });

  it('wraps link and adjacent plain text in a single new link', () => {
    const root = makeRoot('<p><a href="url1">link</a> plain</p>');
    const p = root.querySelector('p')!;
    const a = p.querySelector('a')!;
    selectRange(a.firstChild!, 0, p.lastChild!, 6);
    insertLink('url2', ctxOf(root));
    expect(root.innerHTML).toBe('<p><a href="url2">link plain</a></p>');
  });

  it('replaces a partially-overlapping link with a new link covering the selection', () => {
    const root = makeRoot('<p>pre<a href="url">link</a>post</p>');
    const p = root.querySelector('p')!;
    const pre = p.firstChild!;
    const a = p.querySelector('a')!;
    selectRange(pre, 1, a.firstChild!, 4); // "re" + "link"
    insertLink('url2', ctxOf(root));
    expect(root.innerHTML).toBe('<p>p<a href="url2">relink</a>post</p>');
  });
});

describe('toggleInline — cross-paragraph (multi-block) selections', () => {
  it('applies bold per-paragraph to a cross-paragraph selection', () => {
    const root = makeRoot('<p>hoge</p><p>fuga</p>');
    const paras = root.querySelectorAll('p');
    selectRange(paras[0].firstChild!, 2, paras[1].firstChild!, 2);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p>ho<strong>ge</strong></p><p><strong>fu</strong>ga</p>');
  });

  it('removes bold per-paragraph when all selected cross-paragraph text is bold', () => {
    const root = makeRoot('<p>ho<strong>ge</strong></p><p><strong>fu</strong>ga</p>');
    const paras = root.querySelectorAll('p');
    const strong1 = paras[0].querySelector('strong')!;
    const strong2 = paras[1].querySelector('strong')!;
    selectRange(strong1.firstChild!, 0, strong2.firstChild!, 2);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p>hoge</p><p>fuga</p>');
  });
});

describe('toggleInline — comment boundary', () => {
  it('applies bold inside a comment without touching comment-body', () => {
    const root = makeRoot(
      '<p><comment id="c1">highlight<comment-body contenteditable="false">note</comment-body></comment></p>',
    );
    const comment = root.querySelector('comment')!;
    const text = comment.firstChild!;
    selectRange(text, 0, text, 9);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<p><comment id="c1"><strong>highlight</strong><comment-body contenteditable="false">note</comment-body></comment></p>',
    );
  });

  it('applies bold inside and outside a comment independently when selection crosses the comment boundary', () => {
    const root = makeRoot(
      '<p><comment id="c1">light<comment-body contenteditable="false">note</comment-body></comment> tex</p>',
    );
    const comment = root.querySelector('comment')!;
    const inside = comment.firstChild!;
    const outside = root.querySelector('p')!.lastChild!;
    selectRange(inside, 0, outside, 4);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<p><comment id="c1"><strong>light</strong><comment-body contenteditable="false">note</comment-body></comment><strong> tex</strong></p>',
    );
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

describe('clearFormatting', () => {
  it('unwraps decorative tags and strips style+class inside the range', () => {
    const root = makeRoot('<p>plain <strong style="color:red" class="x">bold</strong> tail</p>');
    selectContents(root.querySelector('p')!);
    clearFormatting(ctxOf(root));
    expect(root.innerHTML).toBe('<p>plain bold tail</p>');
  });

  it('keeps <a> wrappers and unwraps <strong> nested inside', () => {
    const root = makeRoot('<p><a href="x"><strong>link</strong></a></p>');
    selectContents(root.querySelector('a')!);
    clearFormatting(ctxOf(root));
    expect(root.innerHTML).toBe('<p><a href="x">link</a></p>');
  });

  it('keeps <comment> wrappers and their body/replies', () => {
    const root = makeRoot(
      '<p><comment id="c1">x<comment-body contenteditable="false">y</comment-body></comment></p>',
    );
    const comment = root.querySelector('comment')!;
    selectRange(comment.firstChild!, 0, comment.firstChild!, 1);
    clearFormatting(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<p><comment id="c1">x<comment-body contenteditable="false">y</comment-body></comment></p>',
    );
  });

  it('splits decorative tags so only the in-range portion is unwrapped', () => {
    const root = makeRoot('<p>aaa<strong>bbb<em>ccc</em>ddd</strong>eee</p>');
    const p = root.querySelector('p')!;
    const strong = p.querySelector('strong')!;
    const bbb = strong.firstChild!; // "bbb"
    const ddd = strong.lastChild!;  // "ddd"
    selectRange(bbb, 1, ddd, 2); // "bb<em>ccc</em>dd"
    clearFormatting(ctxOf(root));
    expect(root.innerHTML).toBe('<p>aaa<strong>b</strong>bbcccdd<strong>d</strong>eee</p>');
  });

  it('clears style on a structural element (col) when fully covered', () => {
    const root = makeRoot(
      '<table><colgroup><col style="width:100px"></colgroup>' +
      '<tbody><tr><td>x</td></tr></tbody></table>',
    );
    selectContents(root.querySelector('table')!);
    clearFormatting(ctxOf(root));
    expect(root.innerHTML).not.toContain('style');
  });

  it('preserves block style when only partial inline content is selected', () => {
    const root = makeRoot('<p style="text-align:center">hello <strong>bold</strong></p>');
    const strong = root.querySelector('strong')!;
    selectContents(strong);
    clearFormatting(ctxOf(root));
    // The <p> retains text-align because the range does not cover it; the
    // <strong> wrapper is unwrapped because the range fully covers it.
    expect(root.innerHTML).toBe('<p style="text-align:center">hello bold</p>');
  });

  it('is a no-op when the selection is collapsed', () => {
    const root = makeRoot('<p><strong>bold</strong></p>');
    caretAtStart(root.querySelector('strong')!);
    clearFormatting(ctxOf(root));
    expect(root.innerHTML).toBe('<p><strong>bold</strong></p>');
  });

  it('unwraps bare <span> wrappers in the range', () => {
    const root = makeRoot('<p><span style="color:red">hi</span></p>');
    selectContents(root.querySelector('span')!);
    clearFormatting(ctxOf(root));
    expect(root.innerHTML).toBe('<p>hi</p>');
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
