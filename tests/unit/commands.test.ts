import { afterEach, describe, expect, it } from 'vitest';
import { clearFormatting, collectSegments, segmentsCovered, toggleInline } from '../../webview/commands/inline-format';
import { headingShortcutTag, insertDetails, insertHr, setAlertType, setBlockTag } from '../../webview/commands/block-format';
import { insertLink } from '../../webview/commands/link';
import { findInlineAncestor, getCurrentAlertType, getCurrentBlockTag } from '../../webview/commands/query';
import { addComment, removeComment } from '../../webview/features/comment/comment-commands';
import type { CommandContext } from '../../webview/shared/command-context';
import { caretAtStart, clearDom, makeRoot, selectContents, selectTextRange } from './helpers/selection';

afterEach(clearDom);

function ctxOf(root: HTMLElement): CommandContext {
  return { root };
}

/** The coverage verdict as the toolbar reads it: segment once, ask per tag. */
function covered(range: Range, tagName: string, root: HTMLElement): boolean {
  return segmentsCovered(collectSegments(range, root), tagName, root);
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

  it('removes alert metadata when converting an alert to another block type', () => {
    const root = makeRoot('<blockquote data-alert="warning" id="keep">text</blockquote>');
    caretAtStart(root.querySelector('blockquote')!);
    setBlockTag('p', ctxOf(root));
    expect(root.innerHTML).toBe('<p id="keep">text</p>');
  });

  it('wraps bare root text before applying a block type', () => {
    const root = makeRoot('plain text');
    const r = document.createRange();
    r.setStart(root.firstChild!, 0);
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    setBlockTag('h1', ctxOf(root));
    expect(root.innerHTML).toBe('<h1>plain text</h1>');
  });

  it('leaves a <summary> tag untouched (does not rewrite to a heading)', () => {
    const root = makeRoot('<details open><summary>title</summary><p>body</p></details>');
    caretAtStart(root.querySelector('summary')!);
    setBlockTag('h1', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<details open=""><summary>title</summary><p>body</p></details>',
    );
  });

  it('leaves a structural <li> untouched', () => {
    const root = makeRoot('<ul><li>item</li></ul>');
    caretAtStart(root.querySelector('li')!);
    setBlockTag('h1', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>item</li></ul>');
  });
});

// A document with no block structure AT ALL — a fresh .html opened straight in
// the WYSIWYG view, whose root holds no child nodes. commandBlock resolves its
// target through findBareRootRun, which starts from a CHILD of the root, so
// these commands found nothing and returned in silence; the identical document
// one <br> later worked, which is what made the hole hard to see.
describe('block commands on a document with no children at all', () => {
  it('turns an untouched empty document into the requested heading', () => {
    const root = makeRoot('');
    caretAtStart(root);
    setBlockTag('h2', ctxOf(root));
    expect(root.innerHTML).toBe('<h2><br></h2>');
  });

  it('produces a paragraph for the plain block tag', () => {
    const root = makeRoot('');
    caretAtStart(root);
    setBlockTag('p', ctxOf(root));
    expect(root.innerHTML).toBe('<p><br></p>');
  });

  it('turns it into a typed alert blockquote', () => {
    const root = makeRoot('');
    caretAtStart(root);
    setAlertType('warning', ctxOf(root));
    expect(root.innerHTML).toBe('<blockquote data-alert="warning"><br></blockquote>');
  });

  it('leaves the caret inside the new block so typing continues there', () => {
    const root = makeRoot('');
    caretAtStart(root);
    setBlockTag('h2', ctxOf(root));
    const selection = window.getSelection()!;
    expect(selection.rangeCount).toBe(1);
    const heading = root.querySelector('h2')!;
    expect(heading.contains(selection.getRangeAt(0).startContainer)).toBe(true);
  });

  it('agrees with a document that already holds a lone break', () => {
    // The shape that always worked, pinned so the two entry points cannot
    // drift apart again.
    const root = makeRoot('<br>');
    caretAtStart(root);
    setBlockTag('h2', ctxOf(root));
    expect(root.innerHTML).toBe('<h2><br></h2>');
  });

  it('does NOT materialize anything when the document holds real content', () => {
    // The shape that reaches the new fallback and must be turned away by it:
    // findBareRootRun finds no run (a <table> is a root block boundary), so
    // the caret has no block — but the document is not empty, and a command
    // that cannot act must not leave a paragraph behind as its only effect.
    const html = '<table><tbody><tr><td>x</td></tr></tbody></table>';
    const root = makeRoot(html);
    caretAtStart(root);
    setBlockTag('h2', ctxOf(root));
    expect(root.innerHTML).toBe(html);
  });
});

describe('setAlertType', () => {
  it('converts a paragraph to a normal blockquote', () => {
    const root = makeRoot('<p>text</p>');
    caretAtStart(root.querySelector('p')!);
    setAlertType(null, ctxOf(root));
    expect(root.innerHTML).toBe('<blockquote>text</blockquote>');
  });

  it('converts the current block to a typed blockquote', () => {
    const root = makeRoot('<p>text</p>');
    caretAtStart(root.querySelector('p')!);
    setAlertType('note', ctxOf(root));
    expect(root.innerHTML).toBe('<blockquote data-alert="note">text</blockquote>');
  });

  it('wraps bare root text before creating an alert', () => {
    const root = makeRoot('bare text');
    caretAtStart(root.firstChild!);
    setAlertType('important', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<blockquote data-alert="important">bare text</blockquote>',
    );
  });

  it('changes an existing alert type and preserves unrelated attributes', () => {
    const root = makeRoot(
      '<blockquote data-alert="note" id="keep" style="text-align: center">text</blockquote>',
    );
    caretAtStart(root.querySelector('blockquote')!);
    setAlertType('caution', ctxOf(root));
    const quote = root.querySelector('blockquote')!;
    expect(quote.getAttribute('data-alert')).toBe('caution');
    expect(quote.getAttribute('id')).toBe('keep');
    expect(quote.getAttribute('style')).toContain('text-align: center');
  });

  it('removes only alert metadata and leaves an ordinary blockquote', () => {
    const root = makeRoot('<blockquote data-alert="tip" id="keep">text</blockquote>');
    caretAtStart(root.querySelector('blockquote')!);
    setAlertType(null, ctxOf(root));
    expect(root.innerHTML).toBe('<blockquote id="keep">text</blockquote>');
  });

  it('does not replace a structural list item', () => {
    const root = makeRoot('<ul><li>item</li></ul>');
    caretAtStart(root.querySelector('li')!);
    setAlertType('warning', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>item</li></ul>');
  });
});

describe('headingShortcutTag', () => {
  it('maps Digit1–Digit6 to h1–h6', () => {
    expect(headingShortcutTag('Digit1')).toBe('h1');
    expect(headingShortcutTag('Digit2')).toBe('h2');
    expect(headingShortcutTag('Digit3')).toBe('h3');
    expect(headingShortcutTag('Digit4')).toBe('h4');
    expect(headingShortcutTag('Digit5')).toBe('h5');
    expect(headingShortcutTag('Digit6')).toBe('h6');
  });

  it('maps Digit0 to p (plain)', () => {
    expect(headingShortcutTag('Digit0')).toBe('p');
  });

  // Regression: Ctrl+Shift+<digit> must be matched on `code`, because with Shift
  // held `event.key` is the shifted symbol ('!', '@', …), never the digit.
  it('matches on event.code, so the shifted symbol on event.key is irrelevant', () => {
    expect(headingShortcutTag('Digit2')).toBe('h2'); // event.key would be '@'
  });

  it('returns null for digits outside 0–6 and non-digit codes', () => {
    expect(headingShortcutTag('Digit7')).toBeNull();
    expect(headingShortcutTag('Digit9')).toBeNull();
    expect(headingShortcutTag('KeyA')).toBeNull();
    expect(headingShortcutTag('Numpad2')).toBeNull();
    expect(headingShortcutTag('')).toBeNull();
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

  // Only a list item is emptied by its stub <br> (an abandoned item would show
  // a stray bullet); an ordinary block keeps the blank line the user made.
  it('keeps a paragraph that holds only a stub <br>', () => {
    const root = makeRoot('<p><br></p>');
    caretAtStart(root.querySelector('p')!);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe('<p><br></p><hr><p><br></p>');
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

  for (const attribute of ['', ' data-alert="important"']) {
    const kind = attribute ? 'alert' : 'blockquote';
    it(`creates a code block inside a bare ${kind}`, () => {
      const root = makeRoot(`<blockquote${attribute}>code here</blockquote>`);
      caretAtStart(root.querySelector('blockquote')!.firstChild!);

      setBlockTag('pre', ctxOf(root));

      expect(root.innerHTML).toBe(
        `<blockquote${attribute}><pre>code here</pre></blockquote>`,
      );
    });
  }

  it('converts a nested quote code block back to a paragraph', () => {
    const root = makeRoot(
      '<blockquote data-alert="tip"><pre>code here</pre></blockquote>',
    );
    caretAtStart(root.querySelector('pre')!);

    setBlockTag('p', ctxOf(root));

    expect(root.innerHTML).toBe(
      '<blockquote data-alert="tip"><p>code here</p></blockquote>',
    );
  });

  it('wraps only the selected bare inline run beside existing quote blocks', () => {
    const root = makeRoot(
      '<blockquote><p>before</p>bare <em>run</em><table><tbody><tr><td>x</td></tr></tbody></table></blockquote>',
    );
    const quote = root.querySelector('blockquote')!;
    caretAtStart(quote.childNodes[1]);

    setBlockTag('pre', ctxOf(root));

    expect(quote.innerHTML).toBe(
      '<p>before</p><pre>bare <em>run</em></pre><table><tbody><tr><td>x</td></tr></tbody></table>',
    );
  });

  it('converts only the current br-delimited quote line to a code block', () => {
    const root = makeRoot(
      '<blockquote data-alert="note">before<br>code<br>after</blockquote>',
    );
    const quote = root.querySelector('blockquote')!;
    caretAtStart(quote.childNodes[2]);

    setBlockTag('pre', ctxOf(root));

    expect(root.innerHTML).toBe(
      '<blockquote data-alert="note"><p>before</p><pre>code</pre><p>after</p></blockquote>',
    );
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

describe('getCurrentAlertType', () => {
  it('returns a recognized alert type inside an alert blockquote', () => {
    const root = makeRoot('<blockquote data-alert="important">text</blockquote>');
    expect(getCurrentAlertType(root.querySelector('blockquote')!.firstChild!, root)).toBe(
      'important',
    );
  });

  it('returns null for an ordinary quote or an unknown value', () => {
    const root = makeRoot(
      '<blockquote>ordinary</blockquote><blockquote data-alert="future">future</blockquote>',
    );
    expect(getCurrentAlertType(root.children[0].firstChild!, root)).toBeNull();
    expect(getCurrentAlertType(root.children[1].firstChild!, root)).toBeNull();
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

// The command rewrites the tree ELEVEN times over — once per decorative tag —
// and its own splitAtStart/splitAtEnd/splitAtBoth call splitText at the range's
// boundaries, so the boundary node comes back SHORTER and an offset into it
// counts different characters. Clamping that offset (which is what this used to
// do) collapsed the range against its own start whenever both boundaries shared
// one text node, and every tag after the first was then skipped in silence.
// pinSelectionText is what removes the offsets from the picture.
describe('clearFormatting — a selection whose ends share one text node', () => {
  it('reaches the tags processed AFTER the one that split the boundary', () => {
    // 'EM' comes before 'SPAN' in DECORATIVE_INLINE_TAGS, so the <em> split is
    // what used to strand the <span>: the colour stayed on the cleared text.
    const root = makeRoot('<p><em><span style="color:red">abcdef</span></em></p>');
    const text = root.querySelector('span')!.firstChild!;
    selectRange(text, 2, text, 5); // "cde"
    clearFormatting(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<p><em><span style="color:red">ab</span></em>cde'
      + '<em><span style="color:red">f</span></em></p>',
    );
  });

  it('leaves nothing of the cleared run inside a decorative wrapper', () => {
    // The same case stated as the invariant, so a different split shape still
    // has to satisfy it: the text the user selected carries no formatting.
    const root = makeRoot('<p><strong><em>abcdef</em></strong></p>');
    const text = root.querySelector('em')!.firstChild!;
    selectRange(text, 2, text, 5);
    clearFormatting(ctxOf(root));
    expect(root.textContent).toBe('abcdef');
    for (const el of Array.from(root.querySelectorAll('strong, em'))) {
      expect(el.textContent).not.toContain('c');
    }
  });

  it('still clears style and class on an element the selection fully covers', () => {
    // Phase 2 runs on the same pinned text once its own element-level snapshot
    // is invalidated by the splits, so a fully covered <a> is still cleared —
    // and its href, which is not formatting, is not.
    const root = makeRoot(
      '<p><em>abc<a href="x" class="y" style="color:red">def</a>ghi</em></p>',
    );
    const em = root.querySelector('em')!;
    selectRange(em.firstChild!, 1, em.lastChild!, 2); // "bc<a>def</a>gh"
    clearFormatting(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<p><em>a</em>bc<a href="x">def</a>gh<em>i</em></p>',
    );
  });

  it('leaves the document byte-identical when there is nothing to clear', () => {
    // The pin splits text nodes up front, so this is what says those splits
    // stay invisible: no empty text node, and no change to the saved HTML.
    const root = makeRoot('<p>plain text</p>');
    const text = root.querySelector('p')!.firstChild!;
    selectRange(text, 2, text, 6);
    clearFormatting(ctxOf(root));
    expect(root.innerHTML).toBe('<p>plain text</p>');
  });
});

// Ctrl+\ removes decorative wrappers with the very same splitAtStart /
// splitAtEnd machinery toggleInline uses, so a wrapper that ENCLOSES a
// <comment>, a list, or a table corrupts the document the same way: the
// extraction runs from a boundary inside that child out to the wrapper's own
// end, and extractContents CLONES whatever it only partially contains. The
// shape is reachable with two ordinary commands — bold a phrase, comment a word
// inside it — and every case here fails without the splitWrappersAroundStructure
// pass in clearFormatting.
describe('clearFormatting — a wrapper that encloses structure', () => {
  const BODY = '<comment-body contenteditable="false">note</comment-body>';
  const COMMENT = `<comment id="c1">tgt${BODY}</comment>`;

  /** Exactly one comment, whole, with its body still inside it. */
  function expectCommentIntact(root: HTMLElement): void {
    expect(root.querySelectorAll('comment')).toHaveLength(1);
    expect(root.querySelectorAll('comment-body')).toHaveLength(1);
    expect(root.querySelector('comment > comment-body')!.textContent).toBe('note');
    expect(root.querySelector('comment')!.getAttribute('id')).toBe('c1');
    expect(root.querySelector('comment')!.textContent).toContain('tgt');
  }

  it('never duplicates the comment when the selection ends inside it', () => {
    const root = makeRoot(`<p><strong>pre${COMMENT}post</strong></p>`);
    const pre = root.querySelector('strong')!.firstChild!;
    const target = root.querySelector('comment')!.firstChild!;
    selectRange(pre, 0, target, 2);
    clearFormatting(ctxOf(root));
    expectCommentIntact(root);
    expect(root.innerHTML).toBe(
      `<p>pre<comment id="c1">tg<strong>t</strong>${BODY}</comment><strong>post</strong></p>`,
    );
  });

  it('never duplicates the comment when the selection starts inside it', () => {
    // The mirror, which reaches splitAtStart rather than splitAtEnd.
    const root = makeRoot(`<p><em>pre${COMMENT}post</em></p>`);
    const target = root.querySelector('comment')!.firstChild!;
    const post = root.querySelector('em')!.lastChild!;
    selectRange(target, 1, post, 2);
    clearFormatting(ctxOf(root));
    expectCommentIntact(root);
    expect(root.querySelector('em comment')).toBeNull();
  });

  it('keeps the comment body out of the wrapper for a mid-word selection', () => {
    // Both boundaries strictly inside their own text node, which is the
    // straddle case (splitAtBoth) rather than either one-sided split.
    const root = makeRoot(`<p><em>pre${COMMENT}post</em></p>`);
    const pre = root.querySelector('em')!.firstChild!;
    const target = root.querySelector('comment')!.firstChild!;
    selectRange(pre, 1, target, 1);
    clearFormatting(ctxOf(root));
    expectCommentIntact(root);
    expect(root.querySelector('em comment-body')).toBeNull();
  });

  it('leaves a list whole instead of splitting it in two', () => {
    const root = makeRoot('<div><em>a<ul><li>one</li><li>two</li></ul>b</em></div>');
    const a = root.querySelector('em')!.firstChild!;
    selectRange(a, 0, root.querySelector('li')!.firstChild!, 2);
    clearFormatting(ctxOf(root));
    expect(root.querySelectorAll('ul')).toHaveLength(1);
    expect(root.querySelectorAll('li')).toHaveLength(2);
    // An <em> may never end up holding the list itself — invalid nesting that
    // reached the saved file.
    expect(root.querySelector('em ul')).toBeNull();
    expect(root.querySelector('ul')!.textContent).toBe('onetwo');
  });

  it('leaves a table whole', () => {
    const root = makeRoot(
      '<div><em>a<table><tbody><tr><td>cell</td></tr></tbody></table>b</em></div>',
    );
    const a = root.querySelector('em')!.firstChild!;
    selectRange(a, 0, root.querySelector('td')!.firstChild!, 2);
    clearFormatting(ctxOf(root));
    expect(root.querySelectorAll('table')).toHaveLength(1);
    expect(root.querySelector('em table')).toBeNull();
    expect(root.querySelector('td')!.textContent).toBe('cell');
  });

  it('still clears the whole wrapper when the range covers it entirely', () => {
    // The fully-covered path must keep working: it never straddled a boundary,
    // so the distribution has to leave it looking exactly as it did before.
    const root = makeRoot(`<p><strong style="color:red">pre${COMMENT}post</strong></p>`);
    selectContents(root.querySelector('p')!);
    clearFormatting(ctxOf(root));
    expectCommentIntact(root);
    expect(root.innerHTML).toBe(`<p>pre${COMMENT}post</p>`);
  });

  it('leaves a wrapper holding nothing structural on the ordinary path', () => {
    // The guard must not disturb the overwhelmingly common case.
    const root = makeRoot('<p>aaa<strong>bbb<em>ccc</em>ddd</strong>eee</p>');
    const strong = root.querySelector('strong')!;
    selectRange(strong.firstChild!, 1, strong.lastChild!, 2);
    clearFormatting(ctxOf(root));
    expect(root.innerHTML).toBe('<p>aaa<strong>b</strong>bbcccdd<strong>d</strong>eee</p>');
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

describe('toggleInline — bare root-level text beside blocks', () => {
  const tableHtml =
    '<table><tbody><tr><td>x</td></tr></tbody></table>';

  it('still wraps a plain bare-text selection without adding structure', () => {
    const root = makeRoot('hello');
    selectTextRange(root.firstChild!, 0, 5);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<strong>hello</strong>');
  });

  it('never wraps a table when the selection covers table plus bare text', () => {
    // The table itself must stay outside the wrapper — but its cell text is in
    // the selection, so the walk descends and formats it where it lives.
    const root = makeRoot(tableHtml + 'para');
    selectRange(root, 0, root, 2); // Ctrl+A shape: element-level over everything
    toggleInline('strong', ctxOf(root));
    expect(root.querySelector('strong table')).toBeNull();
    expect(root.innerHTML).toBe(
      '<table><tbody><tr><td><strong>x</strong></td></tr></tbody></table><strong>para</strong>',
    );
  });

  it('handles a selection from inside a cell out to the bare text', () => {
    const root = makeRoot(tableHtml + 'para');
    const cellText = root.querySelector('td')!.firstChild!;
    selectRange(cellText, 0, root.lastChild!, 4);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<table><tbody><tr><td><strong>x</strong></td></tr></tbody></table><strong>para</strong>',
    );
  });

  it('formats bare runs on both sides of a table separately', () => {
    // Three segments, not one: each bare run on its own, and the cell text
    // inside the cell. Nothing spans the table's edges.
    const root = makeRoot('one' + tableHtml + 'two');
    selectRange(root.firstChild!, 0, root.lastChild!, 3);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<strong>one</strong>'
      + '<table><tbody><tr><td><strong>x</strong></td></tr></tbody></table>'
      + '<strong>two</strong>',
    );
  });

  it('formats a paragraph between bare runs inside its own block', () => {
    const root = makeRoot('a<p>m</p>b');
    selectRange(root.firstChild!, 0, root.lastChild!, 1);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<strong>a</strong><p><strong>m</strong></p><strong>b</strong>',
    );
  });

  it('handles bare text before a paragraph', () => {
    const root = makeRoot('text<p>a</p>');
    selectRange(root.firstChild!, 0, root.querySelector('p')!.firstChild!, 1);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<strong>text</strong><p><strong>a</strong></p>');
  });

  it('removes the tag per bare run when everything is already covered', () => {
    // Every text node in range is bold (the cell included), so this is the
    // removal branch — and it reaches exactly the text the applying branch
    // reaches, the cell's included.
    const root = makeRoot(
      '<strong>one</strong><table><tbody><tr><td><strong>x</strong></td></tr></tbody></table><strong>two</strong>',
    );
    selectRange(
      root.querySelector('strong')!.firstChild!,
      0,
      root.lastChild!.firstChild!,
      3,
    );
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(
      'one<table><tbody><tr><td>x</td></tr></tbody></table>two',
    );
  });
});

describe('toggleInline — a <comment> inside a bare root-level run', () => {
  // A bare run is delimited by root-level BLOCKS only, so it runs straight
  // through an inline <comment> — which is a segment boundary. Each of these
  // is a shape where one side's run overlaps the element the other side owns;
  // without clipping them against each other, the wider side wraps the comment
  // and its contenteditable=false body in the inline tag, and formats text the
  // user never selected.
  const commentHtml =
    '<comment id="c1">tgt<comment-body contenteditable="false">note</comment-body></comment>';

  it('keeps the comment out of the wrapper when the selection starts inside it', () => {
    const root = makeRoot('pre' + commentHtml + 'post');
    const target = root.querySelector('comment')!.firstChild!;
    selectRange(target, 1, root.lastChild!, 2);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(
      'pre<comment id="c1">t<strong>gt</strong>'
      + '<comment-body contenteditable="false">note</comment-body></comment>'
      + '<strong>po</strong>st',
    );
  });

  it('keeps the comment out of the wrapper when the selection ends inside it', () => {
    // The mirror: here the START side's run reaches forward past the comment.
    const root = makeRoot('pre' + commentHtml + 'post');
    const target = root.querySelector('comment')!.firstChild!;
    selectRange(root.firstChild!, 1, target, 2);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(
      'p<strong>re</strong><comment id="c1"><strong>tg</strong>t'
      + '<comment-body contenteditable="false">note</comment-body></comment>post',
    );
  });

  it('formats around and inside the comment when the whole run is selected', () => {
    // Ctrl+A shape. Both ends resolve to the SAME run, which used to make the
    // run one flat segment — and one wrapper around the comment, body and all.
    const root = makeRoot('pre' + commentHtml + 'post');
    selectRange(root, 0, root, 3);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<strong>pre</strong><comment id="c1"><strong>tgt</strong>'
      + '<comment-body contenteditable="false">note</comment-body></comment>'
      + '<strong>post</strong>',
    );
  });

  it('round-trips that whole-run toggle', () => {
    const html = 'pre' + commentHtml + 'post';
    const root = makeRoot(html);
    selectRange(root, 0, root, 3);
    toggleInline('strong', ctxOf(root));

    selectRange(root, 0, root, 3);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(html);
  });

  it('never puts a comment-body inside the inline wrapper', () => {
    // The invariant behind all of the above, asserted directly so a future
    // segmentation change cannot regress it quietly.
    for (const [start, end] of [[0, 3], [0, 2], [1, 3]] as const) {
      const root = makeRoot('pre' + commentHtml + 'post');
      selectRange(root, start, root, end);
      toggleInline('strong', ctxOf(root));
      expect(root.querySelector('strong comment-body')).toBeNull();
      expect(root.querySelector('strong comment')).toBeNull();
    }
  });
});

describe('toggleInline — a <comment> the selection spans INSIDE one block', () => {
  // The gesture the whole-document cases above never reach: an ordinary drag
  // that starts and ends in the same block. findSegmentBoundary reports the
  // COMMENT only for a boundary INSIDE it, so both ends resolve to the
  // enclosing block and the range used to be taken verbatim — one flat segment
  // whose surroundContents swallowed the comment and its
  // contenteditable=false body, straight into the saved file.
  const commentHtml =
    '<comment id="c1">tgt<comment-body contenteditable="false">note</comment-body></comment>';
  const bolded =
    '<strong>b</strong><comment id="c1"><strong>tgt</strong>'
    + '<comment-body contenteditable="false">note</comment-body></comment><strong>c</strong>';

  /**
   * Select the block's whole content at element level. Deliberately not
   * `firstChild`/`lastChild` with a text offset: a toggle leaves zero-length
   * text nodes behind (extractContents keeps the original and moves a clone),
   * so a second selection built that way would anchor on one of those.
   */
  function selectWholeBlock(block: Element): void {
    selectRange(block, 0, block, block.childNodes.length);
  }

  it('keeps the comment out of the wrapper for a drag inside a paragraph', () => {
    const root = makeRoot(`<p>b${commentHtml}c</p>`);
    selectWholeBlock(root.querySelector('p')!);
    toggleInline('strong', ctxOf(root));
    expect(root.querySelector('strong comment-body')).toBeNull();
    expect(root.querySelector('strong comment')).toBeNull();
    expect(root.innerHTML).toBe(`<p>${bolded}</p>`);
  });

  it('does the same inside a list item', () => {
    const root = makeRoot(`<ul><li>b${commentHtml}c</li></ul>`);
    selectWholeBlock(root.querySelector('li')!);
    toggleInline('strong', ctxOf(root));
    expect(root.querySelector('strong comment-body')).toBeNull();
    expect(root.innerHTML).toBe(`<ul><li>${bolded}</li></ul>`);
  });

  it('does the same inside a table cell', () => {
    const root = makeRoot(`<table><tbody><tr><td>b${commentHtml}c</td></tr></tbody></table>`);
    selectWholeBlock(root.querySelector('td')!);
    toggleInline('strong', ctxOf(root));
    expect(root.querySelector('strong comment-body')).toBeNull();
    expect(root.innerHTML).toBe(
      `<table><tbody><tr><td>${bolded}</td></tr></tbody></table>`,
    );
  });

  it('round-trips the in-block toggle', () => {
    const html = `<p>b${commentHtml}c</p>`;
    const root = makeRoot(html);
    selectWholeBlock(root.querySelector('p')!);
    toggleInline('strong', ctxOf(root));

    selectWholeBlock(root.querySelector('p')!);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(html);
  });

  it('still clips a mid-word selection exactly in a block holding a comment', () => {
    // The fast path is only given up, not replaced by something coarser: the
    // walk clips each run to the range, so character offsets survive.
    const root = makeRoot(`<p>hello world${commentHtml}</p>`);
    selectTextRange(root.querySelector('p')!.firstChild!, 2, 7);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(`<p>he<strong>llo w</strong>orld${commentHtml}</p>`);
  });

  it('leaves a block with no structural child on the verbatim fast path', () => {
    const root = makeRoot('<p>hello world</p>');
    selectTextRange(root.querySelector('p')!.firstChild!, 0, 5);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p><strong>hello</strong> world</p>');
  });
});

describe('toggleInline — the apply/remove verdict follows the segments', () => {
  const tableHtml =
    '<table><tbody><tr><td>x</td></tr></tbody></table>';

  it('removes again what a whole-document toggle applied beside a table', () => {
    // The verdict must be read from the segments the toggle actually operates
    // on, or apply and remove end up talking about different text.
    const root = makeRoot(tableHtml + 'para');
    const bolded =
      '<table><tbody><tr><td><strong>x</strong></td></tr></tbody></table><strong>para</strong>';
    selectRange(root, 0, root, 2); // Ctrl+A shape: element-level over everything
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(bolded);

    selectRange(root, 0, root, 2);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(tableHtml + 'para');
  });

  it('round-trips a whole-document toggle beside a list, formatting the items too', () => {
    // The walk descends into the <ul> and formats each <li> where it lives, so
    // a whole-document toggle reaches everything the user selected — and the
    // second press removes exactly the same text again.
    const root = makeRoot('<p>a</p><ul><li>b</li></ul>');
    selectRange(root, 0, root, 2);
    toggleInline('strong', ctxOf(root));
    expect(root.querySelector('strong ul')).toBeNull();
    expect(root.querySelector('strong li')).toBeNull();
    expect(root.innerHTML).toBe(
      '<p><strong>a</strong></p><ul><li><strong>b</strong></li></ul>',
    );

    selectRange(root, 0, root, 2);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p>a</p><ul><li>b</li></ul>');
  });

  it('reports the toolbar state from the same segments the toggle uses', () => {
    // The button and the document now agree: every text the toggle touched is
    // bold, so "applied" is the truth rather than a stopgap.
    const root = makeRoot('<p>a</p><ul><li>b</li></ul>');
    selectRange(root, 0, root, 2);
    toggleInline('strong', ctxOf(root));
    expect(root.querySelector('li')!.innerHTML).toBe('<strong>b</strong>');

    selectRange(root, 0, root, 2);
    const range = window.getSelection()!.getRangeAt(0);
    expect(covered(range, 'STRONG', root)).toBe(true);
  });

  it('reports "not applied" while a nested list item is still plain', () => {
    // The half that used to be impossible to observe: the item is inside a
    // container the walk once stepped over, so the button lit up regardless of
    // what the item looked like. It has to answer for that item now.
    const root = makeRoot('<p><strong>a</strong></p><ul><li>b</li></ul>');
    selectRange(root, 0, root, 2);
    const range = window.getSelection()!.getRangeAt(0);
    expect(covered(range, 'STRONG', root)).toBe(false);
  });

  it('still reports a partially formatted selection as not covered', () => {
    const root = makeRoot('<p><strong>a</strong></p><p>b</p>');
    selectRange(root, 0, root, 2);
    const range = window.getSelection()!.getRangeAt(0);
    expect(covered(range, 'STRONG', root)).toBe(false);
  });

  it('judges a root-anchored segment by the text it actually overlaps', () => {
    // The coverage walk REJECTS element subtrees that do not intersect the
    // range, so a segment whose common ancestor is the root itself (every
    // bare-run segment is anchored on root's own children) must still ignore
    // the unformatted blocks around it rather than reporting "not covered".
    const root = makeRoot('<p>plain</p><strong>bare</strong><p>other</p>');
    selectRange(root, 1, root, 2);
    const range = window.getSelection()!.getRangeAt(0);
    expect(covered(range, 'STRONG', root)).toBe(true);
    expect(covered(range, 'EM', root)).toBe(false);
  });

  it('judges a selection inside one text node by that text alone', () => {
    // The coverage walk is scoped to the range's own subtree, so a range whose
    // common ancestor IS a text node must still find that text (a TreeWalker
    // never yields its own root) and must not be swayed by unformatted text
    // elsewhere in the document.
    const root = makeRoot('<p><strong>bold</strong></p><p>plain</p>');
    const boldText = root.querySelector('strong')!.firstChild!;
    selectTextRange(boldText, 1, 3);
    const range = window.getSelection()!.getRangeAt(0);
    expect(covered(range, 'STRONG', root)).toBe(true);
    expect(covered(range, 'EM', root)).toBe(false);
  });
});

describe('toggleInline — a <comment> a bare run reaches past the selection ends', () => {
  // A bare root-level run is not bounded by the selection: collectSegmentsIn
  // groups every contiguous NON-structural child into one run, so a run one end
  // sits in keeps growing until it meets a structural child. An inline
  // <comment> is one (isStructuralChild), which is why the run is broken there
  // and its contenteditable=false body — unreachable past commentContentEnd —
  // is never wrapped. These are the shapes where one end sits in such a run and
  // the other end does not, so the run reaches past the selection on its own
  // side and the per-run clip in flushRun is what bounds the segment.
  const commentHtml =
    '<comment id="c1">tgt<comment-body contenteditable="false">note</comment-body></comment>';

  it('keeps the comment out of the wrapper when the run is the START side', () => {
    const root = makeRoot('pre' + commentHtml + 'post<p>x</p>');
    selectRange(root.firstChild!, 1, root.querySelector('p')!.firstChild!, 1);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(
      'p<strong>re</strong><comment id="c1"><strong>tgt</strong>'
      + '<comment-body contenteditable="false">note</comment-body></comment>'
      + '<strong>post</strong><p><strong>x</strong></p>',
    );
  });

  it('keeps the comment out of the wrapper when the run is the END side', () => {
    const root = makeRoot('<p>x</p>pre' + commentHtml + 'post');
    selectRange(root.querySelector('p')!.firstChild!, 0, root.lastChild!, 2);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<p><strong>x</strong></p><strong>pre</strong>'
      + '<comment id="c1"><strong>tgt</strong>'
      + '<comment-body contenteditable="false">note</comment-body></comment>'
      + '<strong>po</strong>st',
    );
  });

  it('formats the whole document without wrapping the comment', () => {
    const root = makeRoot('<p>x</p>pre' + commentHtml + 'post');
    selectRange(root, 0, root, 4); // Ctrl+A shape
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<p><strong>x</strong></p><strong>pre</strong>'
      + '<comment id="c1"><strong>tgt</strong>'
      + '<comment-body contenteditable="false">note</comment-body></comment>'
      + '<strong>post</strong>',
    );
  });

  it('round-trips the whole-document toggle', () => {
    const html = '<p>x</p>pre' + commentHtml + 'post';
    const root = makeRoot(html);
    selectRange(root, 0, root, 4);
    toggleInline('strong', ctxOf(root));
    selectRange(root, 0, root, 4);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(html);
  });

  it('never puts a comment-body inside the wrapper, whichever end owns the run', () => {
    // The invariant behind all of the above, asserted directly across the
    // shapes so a future segmentation change cannot regress it quietly.
    const documents = ['pre' + commentHtml + 'post<p>x</p>', '<p>x</p>pre' + commentHtml + 'post'];
    for (const html of documents) {
      for (const [start, end] of [[0, 4], [0, 3], [1, 4], [1, 3]] as const) {
        const root = makeRoot(html);
        selectRange(root, start, root, end);
        toggleInline('strong', ctxOf(root));
        expect(root.querySelector('strong comment-body')).toBeNull();
        expect(root.querySelector('strong comment')).toBeNull();
      }
    }
  });
});

describe('toggleInline — the selection survives the toggle', () => {
  const tableHtml = '<table><tbody><tr><td>x</td></tr></tbody></table>';

  it('removes again on a second toggle without re-selecting', () => {
    // What a user actually presses: Ctrl+A, Ctrl+B, Ctrl+B. surroundContents
    // extracts the segment and inserts the wrapper in its place, which left
    // the live range covering only the table — so the second press read "not
    // covered" and applied again instead of removing.
    const html = tableHtml + 'para';
    const root = makeRoot(html);
    selectRange(root, 0, root, 2);

    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<table><tbody><tr><td><strong>x</strong></td></tr></tbody></table><strong>para</strong>',
    );

    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(html);
  });

  it('still spans what the user selected after a whole-document toggle', () => {
    const root = makeRoot('<p>a</p><p>b</p>');
    selectRange(root, 0, root, 2);
    toggleInline('strong', ctxOf(root));
    const sel = window.getSelection()!;
    expect(sel.getRangeAt(0).toString()).toBe('ab');
  });

  it('leaves a plain in-block toggle reversible as well', () => {
    const root = makeRoot('<p>hello world</p>');
    const text = root.querySelector('p')!.firstChild!;
    selectTextRange(text, 0, 5);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p><strong>hello</strong> world</p>');
  });

  it('still spans exactly what the user selected when the two ends live in different text nodes', () => {
    // The shape the whole-document cases cannot stand in for: BOTH boundary
    // nodes are only PARTIALLY extracted here. extractContents keeps the
    // original text node and moves a clone of the selected stretch, so both
    // come back shorter and every offset into them names different characters.
    // Clamping such an offset to the node's new length produced a valid range
    // over text the user never selected — here the untouched "re" as well.
    const root = makeRoot('<p>plain <em>italic</em> more</p>');
    const p = root.querySelector('p')!;
    selectRange(p.firstChild!, 0, p.lastChild!, 3);

    toggleInline('strong', ctxOf(root));

    expect(root.innerHTML).toBe('<p><strong>plain <em>italic</em> mo</strong>re</p>');
    expect(window.getSelection()!.getRangeAt(0).toString()).toBe('plain italic mo');
  });

  it('keeps the NEXT command off the text the toggle was never given', () => {
    // What a stretched selection actually costs: whatever the user presses next
    // operates on it. With the end clamped into the shortened tail, Ctrl+B then
    // Ctrl+Shift+X struck through the untouched "re" as well — a formatting
    // change to text that was never selected, and one that reaches the file.
    const root = makeRoot('<p>plain <em>italic</em> more</p>');
    const p = root.querySelector('p')!;
    selectRange(p.firstChild!, 0, p.lastChild!, 3);

    toggleInline('strong', ctxOf(root));
    toggleInline('s', ctxOf(root));

    expect(root.innerHTML).toBe(
      '<p><s><strong>plain <em>italic</em> mo</strong></s>re</p>',
    );
  });

  it('measures the over-extension rather than only its smallest case', () => {
    // The end boundary was clamped to the tail's NEW length, so the selection
    // grew by as many characters as the original end offset — a two-character
    // tail hides that, a long one does not.
    const root = makeRoot(`<p>plain <em>italic</em> ${'z'.repeat(40)}</p>`);
    const p = root.querySelector('p')!;
    selectRange(p.firstChild!, 0, p.lastChild!, 20);

    toggleInline('strong', ctxOf(root));

    expect(window.getSelection()!.getRangeAt(0).toString())
      .toBe(`plain italic ${'z'.repeat(19)}`);
  });
});

describe('collectSegments / segmentsCovered — the toolbar\'s coverage read', () => {
  // The toolbar refreshes four buttons from one unthrottled selectionchange, so
  // it segments once and asks per tag. That one segment list has to answer for
  // every tag independently — no tag's verdict may leak into another's.
  const cases: Array<[string, string, string[]]> = [
    ['<p>a</p><p>b</p>', 'nothing formatted', []],
    ['<p><strong>a</strong></p><p><strong>b</strong></p>', 'every block bold', ['STRONG']],
    ['<p><strong>a</strong></p><p>b</p>', 'only one block bold', []],
    [
      '<p><strong><em>a</em></strong></p><p><em><strong>b</strong></em></p>',
      'bold and italic together',
      ['STRONG', 'EM'],
    ],
    [
      '<table><tbody><tr><td><strong>x</strong></td></tr></tbody></table><strong>bare</strong>',
      'a bare run beside a table whose cell is bold too',
      ['STRONG'],
    ],
    [
      '<table><tbody><tr><td>x</td></tr></tbody></table><strong>bare</strong>',
      'a bare run beside a table whose cell is NOT bold',
      [],
    ],
  ];

  for (const [html, label, active] of cases) {
    it(`reports exactly the active tags — ${label}`, () => {
      const root = makeRoot(html);
      selectRange(root, 0, root, 2);
      const range = window.getSelection()!.getRangeAt(0);
      const segments = collectSegments(range, root);
      for (const tag of ['STRONG', 'EM', 'S', 'CODE']) {
        expect(segmentsCovered(segments, tag, root)).toBe(active.includes(tag));
      }
    });
  }

  it('reports nothing active when the selection produces no segment', () => {
    // Whitespace between blocks yields no segment at all. The buttons have to
    // read "not applied" there — every() over an empty list is vacuously true,
    // so the emptiness has to be rejected explicitly.
    const root = makeRoot('<p>a</p>\n<p>b</p>');
    selectRange(root, 1, root, 2);
    const range = window.getSelection()!.getRangeAt(0);
    expect(collectSegments(range, root)).toHaveLength(0);
    expect(segmentsCovered([], 'STRONG', root)).toBe(false);
  });
});

describe('inline coverage — empty text nodes do not vote', () => {
  // The cell is bold as well, so the ONLY thing that could pull the verdict
  // down is the zero-length node these cases are about.
  const tableHtml = '<table><tbody><tr><td><strong>x</strong></td></tr></tbody></table>';

  it('reports a fully bold run as covered despite a zero-length node beside it', () => {
    // extractContents keeps the ORIGINAL text node and moves a CLONE into the
    // wrapper, so applying a tag to a whole root-level run leaves a
    // zero-length node behind it, outside the wrapper. It renders nothing, but
    // it was enough to make the verdict answer "not covered" forever — so a
    // second Ctrl+B re-applied instead of removing.
    const root = makeRoot(tableHtml + '<strong>para</strong>');
    root.appendChild(document.createTextNode(''));
    selectRange(root, 0, root, 3);
    const range = window.getSelection()!.getRangeAt(0);
    expect(covered(range, 'STRONG', root)).toBe(true);
  });

  it('removes the tag from such a selection instead of re-applying it', () => {
    const root = makeRoot(tableHtml + '<strong>para</strong>');
    root.appendChild(document.createTextNode(''));
    selectRange(root, 0, root, 3);
    toggleInline('strong', ctxOf(root));
    expect(root.querySelector('strong')).toBeNull();
    expect(root.textContent).toBe('xpara');
  });

  it('still reports a genuinely unformatted neighbour as not covered', () => {
    // The rule is about EMPTY nodes only — real text beside the wrapper must
    // keep the verdict at "not covered".
    const root = makeRoot(tableHtml + '<strong>para</strong>tail');
    selectRange(root, 0, root, 3);
    const range = window.getSelection()!.getRangeAt(0);
    expect(covered(range, 'STRONG', root)).toBe(false);
  });
});

describe('toggleInline — bare content BETWEEN two blocks the selection ends in', () => {
  // The mirror of the bare-run cases above, and the shape the root-level
  // segmentation never sees: both ends of the selection sit inside real
  // blocks, so collectSegments takes the ordinary sibling walk. That walk
  // tested only its siblings' TAGS, so a text node or a bare inline element
  // between the two blocks was dropped — the user selected it, it stayed
  // plain, and the toolbar (reading the same segments) reported "applied".
  const CB = '<comment-body contenteditable="false">note</comment-body>';

  it('formats a bare text run the drag selection spans', () => {
    const root = makeRoot('<p>a</p>mid<p>b</p>');
    selectRange(
      root.querySelector('p')!.firstChild!,
      0,
      root.querySelector('p:last-child')!.firstChild!,
      1,
    );
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<p><strong>a</strong></p><strong>mid</strong><p><strong>b</strong></p>',
    );
  });

  it('round-trips that selection back to the original document', () => {
    const html = '<p>a</p>mid<p>b</p>';
    const root = makeRoot(html);
    selectRange(
      root.querySelector('p')!.firstChild!,
      0,
      root.querySelector('p:last-child')!.firstChild!,
      1,
    );
    toggleInline('strong', ctxOf(root));

    // Re-select the same visible text, now wrapped, and toggle back off.
    const wrappers = root.querySelectorAll('strong');
    selectRange(wrappers[0].firstChild!, 0, wrappers[wrappers.length - 1].firstChild!, 1);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(html);
  });

  it('reports the middle run in the coverage verdict instead of ignoring it', () => {
    // The half the user sees: with the run skipped, every segment was covered
    // and the B button lit up while `mid` was visibly plain.
    const root = makeRoot('<p><strong>a</strong></p>mid<p><strong>b</strong></p>');
    selectRange(
      root.querySelector('strong')!.firstChild!,
      0,
      root.querySelectorAll('strong')[1].firstChild!,
      1,
    );
    const range = window.getSelection()!.getRangeAt(0);
    expect(covered(range, 'STRONG', root)).toBe(false);
  });

  it('formats a bare inline element between the blocks too', () => {
    // Not only text nodes: an inline element is just as invisible to a walk
    // that keys off SEGMENT_BOUNDARY_TAGS.
    const root = makeRoot('<p>a</p><strong>bare</strong><p>b</p>');
    selectRange(
      root.querySelector('p')!.firstChild!,
      0,
      root.querySelector('p:last-child')!.firstChild!,
      1,
    );
    toggleInline('em', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<p><em>a</em></p><em><strong>bare</strong></em><p><em>b</em></p>',
    );
  });

  it('leaves the whitespace between pretty-printed blocks alone', () => {
    // The run collection must not turn formatting noise into an empty wrapper.
    const root = makeRoot('<p>a</p>\n<p>b</p>');
    selectRange(
      root.querySelector('p')!.firstChild!,
      0,
      root.querySelector('p:last-child')!.firstChild!,
      1,
    );
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p><strong>a</strong></p>\n<p><strong>b</strong></p>');
  });

  it('descends into a list container between the blocks', () => {
    // The <ul> is not wrappable, but its items are: the walk steps INTO it and
    // formats each <li> where it lives, so nothing the user selected is left
    // behind and no <strong> ever holds a <ul> or an <li>.
    const root = makeRoot('<p>a</p><ul><li>l</li></ul><p>b</p>');
    selectRange(
      root.querySelector('p')!.firstChild!,
      0,
      root.querySelector('p:last-child')!.firstChild!,
      1,
    );
    toggleInline('strong', ctxOf(root));
    expect(root.querySelector('strong ul')).toBeNull();
    expect(root.querySelector('strong li')).toBeNull();
    expect(root.innerHTML).toBe(
      '<p><strong>a</strong></p><ul><li><strong>l</strong></li></ul><p><strong>b</strong></p>',
    );
  });

  it('descends through a nested list without wrapping the inner container', () => {
    // The shape the old flat "wrap this whole boundary element" segment could
    // not express: an <li> holding both inline text AND another list. Wrapping
    // the item whole put the nested <ul> inside a <strong>.
    const root = makeRoot('<p>a</p><ul><li>x<ul><li>y</li></ul></li></ul><p>b</p>');
    selectRange(
      root.querySelector('p')!.firstChild!,
      0,
      root.querySelector('p:last-child')!.firstChild!,
      1,
    );
    toggleInline('strong', ctxOf(root));
    expect(root.querySelector('strong ul')).toBeNull();
    expect(root.innerHTML).toBe(
      '<p><strong>a</strong></p>'
      + '<ul><li><strong>x</strong><ul><li><strong>y</strong></li></ul></li></ul>'
      + '<p><strong>b</strong></p>',
    );
  });

  it('stops at the block holding the comment the selection ends in', () => {
    // The sibling walk looked for endBoundary among the siblings, but a
    // <comment> nested in a later block is not one — so the walk ran to the
    // END of the sibling list: it formatted blocks past the selection and
    // wrapped the comment, contenteditable=false body included.
    const root = makeRoot(
      `<p>a</p><p>b<comment id="c1">tgt${CB}</comment>c</p><p>d</p>`,
    );
    selectRange(root.querySelector('p')!.firstChild!, 0, root.querySelector('comment')!.firstChild!, 1);
    toggleInline('strong', ctxOf(root));

    expect(root.innerHTML).toBe(
      '<p><strong>a</strong></p>'
      + `<p><strong>b</strong><comment id="c1"><strong>t</strong>gt${CB}</comment>c</p>`
      + '<p>d</p>',
    );
  });

  it('never puts a comment-body inside the wrapper on that path either', () => {
    // The same invariant the bare-run tests assert, on the sibling walk.
    const root = makeRoot(
      `<p>a</p><p>b<comment id="c1">tgt${CB}</comment>c</p><p>d</p>`,
    );
    selectRange(root.querySelector('p')!.firstChild!, 0, root.querySelector('comment')!.firstChild!, 2);
    toggleInline('strong', ctxOf(root));
    expect(root.querySelector('strong comment-body')).toBeNull();
    expect(root.querySelector('strong comment')).toBeNull();
  });

  it('leaves a block beyond the selection completely untouched', () => {
    const root = makeRoot(
      `<p>a</p><p>b<comment id="c1">tgt${CB}</comment>c</p><p>d</p>`,
    );
    selectRange(root.querySelector('p')!.firstChild!, 0, root.querySelector('comment')!.firstChild!, 1);
    toggleInline('strong', ctxOf(root));
    expect(root.querySelectorAll('p')[2].innerHTML).toBe('d');
  });
});

describe('toggleInline — a CONTAINER holds the block the selection ends in', () => {
  // The selection ends in a second list item, a second cell, a later row, or a
  // details body — so everything between its start and that end lives at
  // several different depths inside one container. The walk has to reach all of
  // it and still never let a segment span the container's own structure: a
  // range over a <ul>'s children spans list items, one over a <table>'s spans
  // rows, and surroundContents wraps them without complaint — which put a
  // <strong> directly inside a <ul>, split a <table> into two <tbody>
  // elements, and wrapped a <summary>. One case per container kind, because
  // each reaches its content through a different nesting depth.
  const CB = '<comment-body contenteditable="false">note</comment-body>';

  /** Nothing structural may end up inside an inline wrapper, ever. */
  function expectNoStructureWrapped(root: HTMLElement): void {
    for (const selector of [
      'strong li', 'strong ul', 'strong ol',
      'strong table', 'strong tbody', 'strong tr', 'strong td',
      'strong summary', 'strong details', 'strong p',
      'strong comment', 'strong comment-body',
    ]) {
      expect(root.querySelector(selector), selector).toBeNull();
    }
  }

  it('keeps the list intact when the selection ends in the second item', () => {
    const root = makeRoot('<p>a</p><ul><li>b</li><li>c</li></ul>');
    const items = root.querySelectorAll('li');
    selectRange(root.querySelector('p')!.firstChild!, 0, items[1].firstChild!, 1);
    toggleInline('strong', ctxOf(root));

    expectNoStructureWrapped(root);
    // Both items are inside the selection, so both are formatted — each in its
    // own item, never in a segment that spans the two.
    expect(root.innerHTML).toBe(
      '<p><strong>a</strong></p><ul><li><strong>b</strong></li><li><strong>c</strong></li></ul>',
    );
  });

  it('leaves an item BEYOND the selection alone', () => {
    // The other side of descending: reaching into the container must not turn
    // into formatting the whole of it.
    const root = makeRoot('<p>a</p><ul><li>b</li><li>c</li><li>d</li></ul>');
    const items = root.querySelectorAll('li');
    selectRange(root.querySelector('p')!.firstChild!, 0, items[1].firstChild!, 1);
    toggleInline('strong', ctxOf(root));

    expectNoStructureWrapped(root);
    expect(items[2].innerHTML).toBe('d');
  });

  it('formats the item text before a comment without wrapping the item', () => {
    // Reached through a <ul>: the text before the comment is flat inline
    // content of the <li>, so it belongs in a segment — but one bounded by the
    // <li>, not by the list.
    const root = makeRoot(
      `<p>a</p><ul><li>b<comment id="c1">tgt${CB}</comment></li></ul>`,
    );
    selectRange(
      root.querySelector('p')!.firstChild!,
      0,
      root.querySelector('comment')!.firstChild!,
      1,
    );
    toggleInline('strong', ctxOf(root));

    expectNoStructureWrapped(root);
    expect(root.innerHTML).toBe(
      '<p><strong>a</strong></p>'
      + `<ul><li><strong>b</strong><comment id="c1"><strong>t</strong>gt${CB}</comment></li></ul>`,
    );
  });

  it('keeps the table intact when the selection ends in a later cell', () => {
    const root = makeRoot(
      '<p>a</p><table><tbody><tr><td>b</td><td>c</td></tr></tbody></table>',
    );
    const cells = root.querySelectorAll('td');
    selectRange(root.querySelector('p')!.firstChild!, 0, cells[1].firstChild!, 1);
    toggleInline('strong', ctxOf(root));

    expectNoStructureWrapped(root);
    expect(root.innerHTML).toBe(
      '<p><strong>a</strong></p>'
      + '<table><tbody><tr><td><strong>b</strong></td><td><strong>c</strong></td></tr></tbody></table>',
    );
  });

  it('keeps the row structure intact when the selection ends in a later row', () => {
    // A deeper chain than the case above (table → tbody → tr → td), and the
    // one that used to split the <table> into two <tbody> elements.
    const root = makeRoot(
      '<p>a</p><table><tbody><tr><td>b</td></tr><tr><td>c</td></tr></tbody></table>',
    );
    const cells = root.querySelectorAll('td');
    selectRange(root.querySelector('p')!.firstChild!, 0, cells[1].firstChild!, 1);
    toggleInline('strong', ctxOf(root));

    expectNoStructureWrapped(root);
    expect(root.querySelectorAll('tbody')).toHaveLength(1);
    expect(root.innerHTML).toBe(
      '<p><strong>a</strong></p>'
      + '<table><tbody><tr><td><strong>b</strong></td></tr>'
      + '<tr><td><strong>c</strong></td></tr></tbody></table>',
    );
  });

  it('keeps the summary out of the wrapper when the selection ends in a details body', () => {
    // The summary's TEXT is inside the selection, so it is formatted — but in
    // its own segment: the <summary> element itself never enters the wrapper.
    const root = makeRoot(
      '<p>a</p><details open=""><summary>s</summary><p>y</p></details>',
    );
    selectRange(
      root.querySelector('p')!.firstChild!,
      0,
      root.querySelector('details p')!.firstChild!,
      1,
    );
    toggleInline('strong', ctxOf(root));

    expectNoStructureWrapped(root);
    expect(root.innerHTML).toBe(
      '<p><strong>a</strong></p>'
      + '<details open=""><summary><strong>s</strong></summary>'
      + '<p><strong>y</strong></p></details>',
    );
  });

  it('keeps a quote holding nested blocks intact', () => {
    const root = makeRoot('<p>a</p><blockquote><p>x</p><p>y</p></blockquote>');
    const quoted = root.querySelectorAll('blockquote p');
    selectRange(root.querySelector('p')!.firstChild!, 0, quoted[1].firstChild!, 1);
    toggleInline('strong', ctxOf(root));

    expectNoStructureWrapped(root);
    expect(root.innerHTML).toBe(
      '<p><strong>a</strong></p>'
      + '<blockquote><p><strong>x</strong></p><p><strong>y</strong></p></blockquote>',
    );
  });

  it('still formats a boundary-tagged container that holds only inline content', () => {
    // The lead must not be thrown away wholesale: a <div> whose content really
    // is flat inline text is the shape it was added for, one level up from the
    // <p> case, and its text before the comment still belongs in a segment.
    const root = makeRoot(
      `<p>a</p><div>b<comment id="c1">tgt${CB}</comment>c</div>`,
    );
    selectRange(
      root.querySelector('p')!.firstChild!,
      0,
      root.querySelector('comment')!.firstChild!,
      1,
    );
    toggleInline('strong', ctxOf(root));

    expectNoStructureWrapped(root);
    expect(root.innerHTML).toBe(
      '<p><strong>a</strong></p>'
      + `<div><strong>b</strong><comment id="c1"><strong>t</strong>gt${CB}</comment>c</div>`,
    );
  });

  it('does not wrap the pretty-printing before the end boundary', () => {
    const root = makeRoot('<p>a</p><div>\n  <comment id="c1">tgt' + CB + '</comment></div>');
    selectRange(
      root.querySelector('p')!.firstChild!,
      0,
      root.querySelector('comment')!.firstChild!,
      1,
    );
    toggleInline('strong', ctxOf(root));

    expectNoStructureWrapped(root);
    expect(root.innerHTML).toBe(
      '<p><strong>a</strong></p>'
      + `<div>\n  <comment id="c1"><strong>t</strong>gt${CB}</comment></div>`,
    );
  });
});

describe('toggleInline — the block the selection starts in HOLDS the comment it ends in', () => {
  // Dragging from a paragraph's start into a commented phrase inside that SAME
  // paragraph. Neither of the two branches above reaches it: the first segment
  // ended at commentContentEnd(startBoundary), which answers childNodes.length
  // for anything that is not a <comment> — so it covered the whole block, the
  // comment and its contenteditable=false body included — and the sibling walk's
  // stop condition resolved to the start block itself, which a walk beginning at
  // that block's nextSibling can never meet, so it ran to the end of the sibling
  // list and formatted every block after the selection.
  const CB = '<comment-body contenteditable="false">note</comment-body>';
  const commented = (id: string, text = 'tgt'): string =>
    `<comment id="${id}">${text}${CB}</comment>`;

  /** Nothing structural may end up inside an inline wrapper, ever. */
  function expectNoStructureWrapped(root: HTMLElement): void {
    for (const selector of [
      'strong comment', 'strong comment-body',
      'strong p', 'strong div', 'strong li', 'strong ul',
    ]) {
      expect(root.querySelector(selector), selector).toBeNull();
    }
  }

  it('formats only up to the comment, and leaves the blocks after it alone', () => {
    const root = makeRoot(`<p>a${commented('c1')}b</p><p>z</p><h2>h</h2>`);
    selectRange(
      root.querySelector('p')!.firstChild!,
      0,
      root.querySelector('comment')!.firstChild!,
      1,
    );
    toggleInline('strong', ctxOf(root));

    expectNoStructureWrapped(root);
    expect(root.innerHTML).toBe(
      `<p><strong>a</strong><comment id="c1"><strong>t</strong>gt${CB}</comment>b</p>`
      + '<p>z</p><h2>h</h2>',
    );
  });

  it('round-trips that selection back to the original document', () => {
    const html = `<p>a${commented('c1')}b</p>`;
    const root = makeRoot(html);
    selectRange(
      root.querySelector('p')!.firstChild!,
      0,
      root.querySelector('comment')!.firstChild!,
      1,
    );
    toggleInline('strong', ctxOf(root));

    selectRange(
      root.querySelector('strong')!.firstChild!,
      0,
      root.querySelector('comment strong')!.firstChild!,
      1,
    );
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(html);
  });

  it('keeps an EARLIER comment in the same block out of the wrapper too', () => {
    // The head is not one flat stretch: a block may hold several comments, and
    // the one the selection merely passes over must be split at as well.
    const root = makeRoot(`<p>a${commented('c0', 'one')}m${commented('c1')}b</p>`);
    selectRange(
      root.querySelector('p')!.firstChild!,
      0,
      root.querySelector('comment[id="c1"]')!.firstChild!,
      1,
    );
    toggleInline('strong', ctxOf(root));

    expectNoStructureWrapped(root);
    expect(root.innerHTML).toBe(
      '<p><strong>a</strong>'
      + `<comment id="c0"><strong>one</strong>${CB}</comment>`
      + `<strong>m</strong><comment id="c1"><strong>t</strong>gt${CB}</comment>b</p>`,
    );
  });

  it('works the same when the holding block is a div', () => {
    const root = makeRoot(`<div>a${commented('c1')}b</div>`);
    selectRange(
      root.querySelector('div')!.firstChild!,
      0,
      root.querySelector('comment')!.firstChild!,
      1,
    );
    toggleInline('strong', ctxOf(root));

    expectNoStructureWrapped(root);
    expect(root.innerHTML).toBe(
      `<div><strong>a</strong><comment id="c1"><strong>t</strong>gt${CB}</comment>b</div>`,
    );
  });

  it('works the same when the holding block is a list item', () => {
    // The item is a segment boundary INSIDE a container, so the head must stay
    // in the item and the following item must not be touched.
    const root = makeRoot(`<ul><li>a${commented('c1')}b</li><li>k</li></ul>`);
    selectRange(
      root.querySelector('li')!.firstChild!,
      0,
      root.querySelector('comment')!.firstChild!,
      1,
    );
    toggleInline('strong', ctxOf(root));

    expectNoStructureWrapped(root);
    expect(root.innerHTML).toBe(
      `<ul><li><strong>a</strong><comment id="c1"><strong>t</strong>gt${CB}</comment>b</li>`
      + '<li>k</li></ul>',
    );
  });

  it('never puts a comment-body inside the wrapper, wherever the selection ends', () => {
    // The invariant behind all of the above, swept over every caret position in
    // the comment's target text so a future segmentation change cannot regress
    // it quietly.
    for (let end = 1; end <= 3; end++) {
      const root = makeRoot(`<p>a${commented('c1')}b</p><p>z</p>`);
      selectRange(
        root.querySelector('p')!.firstChild!,
        0,
        root.querySelector('comment')!.firstChild!,
        end,
      );
      toggleInline('strong', ctxOf(root));
      expectNoStructureWrapped(root);
      expect(root.querySelectorAll('p')[1].innerHTML, `end=${end}`).toBe('z');
    }
  });

  it('reports the same selection as covered once it is formatted', () => {
    // The toolbar reads these very segments, so the head and the comment part
    // have to agree on the verdict — otherwise the button could never turn off.
    const root = makeRoot(`<p>a${commented('c1')}b</p>`);
    selectRange(
      root.querySelector('p')!.firstChild!,
      0,
      root.querySelector('comment')!.firstChild!,
      1,
    );
    toggleInline('strong', ctxOf(root));

    selectRange(
      root.querySelector('strong')!.firstChild!,
      0,
      root.querySelector('comment strong')!.firstChild!,
      1,
    );
    const range = window.getSelection()!.getRangeAt(0);
    expect(covered(range, 'STRONG', root)).toBe(true);
    expect(covered(range, 'EM', root)).toBe(false);
  });
});

describe('toggleInline — a <comment> the selection passes straight OVER', () => {
  // Not the comment the selection ends in — the one it merely spans, in a block
  // it covers whole. The block is a segment boundary, so it used to contribute
  // ONE flat segment over all its children, and surroundContents wrapped the
  // <comment> and its contenteditable=false body along with the text. A plain
  // Ctrl+A then Ctrl+B was enough, and the broken HTML reached the saved file.
  const CB = '<comment-body contenteditable="false">note</comment-body>';
  const commented = (id: string, text = 'tgt'): string =>
    `<comment id="${id}">${text}${CB}</comment>`;

  /** Nothing structural may end up inside an inline wrapper, ever. */
  function expectNoStructureWrapped(root: HTMLElement): void {
    for (const selector of ['strong comment', 'strong comment-body', 'strong p']) {
      expect(root.querySelector(selector), selector).toBeNull();
    }
  }

  it('splits a fully covered middle block at the comment it holds', () => {
    const root = makeRoot(`<p>a</p><p>b${commented('c1')}c</p><p>d</p>`);
    selectRange(root, 0, root, 3); // Ctrl+A shape
    toggleInline('strong', ctxOf(root));

    expectNoStructureWrapped(root);
    expect(root.innerHTML).toBe(
      '<p><strong>a</strong></p>'
      + `<p><strong>b</strong><comment id="c1"><strong>tgt</strong>${CB}</comment>`
      + '<strong>c</strong></p>'
      + '<p><strong>d</strong></p>',
    );
  });

  it('splits the START block at the comment when the selection ends elsewhere', () => {
    // The other entry point into the same flat segment: the first segment ran
    // from the selection start to the end of the start block's children.
    const root = makeRoot(`<p>a${commented('c1')}b</p><p>d</p>`);
    selectRange(
      root.querySelector('p')!.firstChild!,
      0,
      root.querySelectorAll('p')[1].firstChild!,
      1,
    );
    toggleInline('strong', ctxOf(root));

    expectNoStructureWrapped(root);
    expect(root.innerHTML).toBe(
      `<p><strong>a</strong><comment id="c1"><strong>tgt</strong>${CB}</comment>`
      + '<strong>b</strong></p>'
      + '<p><strong>d</strong></p>',
    );
  });

  it('splits the END block at a comment that sits after the selection end', () => {
    // The mirror: the last segment ran from the end block's first child to the
    // selection end, so a comment BEFORE that point was swallowed the same way.
    const root = makeRoot(`<p>a</p><p>b${commented('c1')}cd</p>`);
    const tail = root.querySelectorAll('p')[1].lastChild!;
    selectRange(root.querySelector('p')!.firstChild!, 0, tail, 1);
    toggleInline('strong', ctxOf(root));

    expectNoStructureWrapped(root);
    expect(root.innerHTML).toBe(
      '<p><strong>a</strong></p>'
      + `<p><strong>b</strong><comment id="c1"><strong>tgt</strong>${CB}</comment>`
      + '<strong>c</strong>d</p>',
    );
  });

  it('round-trips the whole-document toggle', () => {
    const html = `<p>a</p><p>b${commented('c1')}c</p><p>d</p>`;
    const root = makeRoot(html);
    selectRange(root, 0, root, 3);
    toggleInline('strong', ctxOf(root));
    selectRange(root, 0, root, 3);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(html);
  });

  it('never puts a comment-body inside the wrapper, over every span of blocks', () => {
    // Swept so a future segmentation change cannot regress it quietly.
    const html = `<p>a</p><p>b${commented('c1')}c</p><p>d${commented('c2')}e</p><p>f</p>`;
    for (let start = 0; start <= 3; start++) {
      for (let end = start + 1; end <= 4; end++) {
        const root = makeRoot(html);
        selectRange(root, start, root, end);
        toggleInline('strong', ctxOf(root));
        expect(root.querySelector('strong comment-body'), `${start}..${end}`).toBeNull();
        expect(root.querySelector('strong comment'), `${start}..${end}`).toBeNull();
        expect(root.querySelectorAll('comment-body')).toHaveLength(2);
      }
    }
  });
});

describe('toggleInline — a <figure> at the root', () => {
  // FIGURE delimits bare root-level runs, so a selection inside it resolves its
  // segment boundary through the figure rather than through a block the walk
  // knows. Both shapes have to keep working: the caption alone, and a
  // whole-document selection that merely spans the figure.
  it('formats a selection inside a figcaption', () => {
    const root = makeRoot('<figure><img src="x"><figcaption>caption</figcaption></figure>');
    const text = root.querySelector('figcaption')!.firstChild!;
    selectTextRange(text, 0, 7);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<figure><img src="x"><figcaption><strong>caption</strong></figcaption></figure>',
    );
  });

  it('formats the caption from a whole-document selection without wrapping the figure', () => {
    const root = makeRoot(
      '<p>a</p><figure><img src="x"><figcaption>cap</figcaption></figure>',
    );
    selectRange(root, 0, root, 2);
    toggleInline('strong', ctxOf(root));
    expect(root.querySelector('strong figure')).toBeNull();
    expect(root.querySelector('strong figcaption')).toBeNull();
    expect(root.innerHTML).toBe(
      '<p><strong>a</strong></p>'
      + '<figure><img src="x"><figcaption><strong>cap</strong></figcaption></figure>',
    );
  });
});

describe('toggleInline — a <comment> nested inside an INLINE wrapper', () => {
  // The shape every other comment case above misses: the comment is not a
  // direct child of the block or the run, it sits inside an <em>/<a>/<span>.
  // The walk only descended into STRUCTURAL children, so the wrapper was
  // absorbed whole into a run and surroundContents took the <comment> and its
  // contenteditable=false body into the new inline tag — the exact corruption
  // the segmentation exists to prevent, and it reached the saved file.
  const CB = '<comment-body contenteditable="false">note</comment-body>';
  const COMMENT = `<comment id="c1">tgt${CB}</comment>`;

  /**
   * The invariant, asserted the same way for every wrapper. `bodyText` is what
   * the fixture's body carries — a comment this test creates through
   * {@link addComment} starts with an empty one, and "still empty" is just as
   * much a statement that nothing moved through it.
   */
  function expectCommentIntact(root: HTMLElement, tag: string, bodyText = 'note'): void {
    expect(root.querySelector(`${tag} comment-body`)).toBeNull();
    expect(root.querySelector(`${tag} comment`)).toBeNull();
    expect(root.querySelectorAll('comment')).toHaveLength(1);
    expect(root.querySelectorAll('comment > comment-body')).toHaveLength(1);
    expect(root.querySelector('comment > comment-body')!.textContent).toBe(bodyText);
  }

  it('splits inside an <em> the selection spans whole', () => {
    const root = makeRoot(`<p><em>a${COMMENT}b</em></p>`);
    selectRange(root, 0, root, 1); // Ctrl+A shape
    toggleInline('strong', ctxOf(root));

    expectCommentIntact(root, 'strong');
    // The wrapper is entered, not wrapped: each run is formatted where it
    // lives, which is the shape a drag inside the <em> already produced.
    expect(root.innerHTML).toBe(
      `<p><em><strong>a</strong><comment id="c1"><strong>tgt</strong>${CB}</comment>`
      + '<strong>b</strong></em></p>',
    );
  });

  it('does the same for an <a>, whose href must survive', () => {
    const root = makeRoot(`<p><a href="https://x/">a${COMMENT}b</a></p>`);
    selectRange(root, 0, root, 1);
    toggleInline('strong', ctxOf(root));

    expectCommentIntact(root, 'strong');
    expect(root.innerHTML).toBe(
      '<p><a href="https://x/"><strong>a</strong>'
      + `<comment id="c1"><strong>tgt</strong>${CB}</comment><strong>b</strong></a></p>`,
    );
  });

  it('does the same for a <span>', () => {
    const root = makeRoot(`<p><span>a${COMMENT}b</span></p>`);
    selectRange(root, 0, root, 1);
    toggleInline('strong', ctxOf(root));
    expectCommentIntact(root, 'strong');
  });

  it('descends through NESTED inline wrappers', () => {
    // One level is not the rule — the descent has to reach the comment however
    // deep the wrapping goes.
    const root = makeRoot(`<p><em><span>a${COMMENT}b</span></em></p>`);
    selectRange(root, 0, root, 1);
    toggleInline('strong', ctxOf(root));

    expectCommentIntact(root, 'strong');
    expect(root.innerHTML).toBe(
      `<p><em><span><strong>a</strong><comment id="c1"><strong>tgt</strong>${CB}</comment>`
      + '<strong>b</strong></span></em></p>',
    );
  });

  it('does the same for a wrapper in a bare root-level run', () => {
    const root = makeRoot(`<em>a${COMMENT}b</em>`);
    selectRange(root, 0, root, 1);
    toggleInline('strong', ctxOf(root));
    expectCommentIntact(root, 'strong');
  });

  it('does the same for a wrapper inside a list item', () => {
    const root = makeRoot(`<ul><li><em>a${COMMENT}b</em></li></ul>`);
    selectRange(root, 0, root, 1);
    toggleInline('strong', ctxOf(root));
    expectCommentIntact(root, 'strong');
  });

  it('round-trips the wrapped-comment toggle', () => {
    const html = `<p><em>a${COMMENT}b</em></p>`;
    const root = makeRoot(html);
    selectRange(root, 0, root, 1);
    toggleInline('strong', ctxOf(root));
    selectRange(root, 0, root, 1);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(html);
  });

  it('keeps the body out for the shape the real commands produce', () => {
    // Not a hand-written fixture: bold a phrase, comment a word inside it,
    // then press Ctrl+A Ctrl+I. addComment surroundContents the raw range, so
    // step 2 really does put the <comment> inside the <strong>.
    const root = makeRoot('<p>alpha beta gamma</p>');
    const text = root.querySelector('p')!.firstChild!;
    selectTextRange(text, 0, 16);
    toggleInline('strong', ctxOf(root));

    const bold = root.querySelector('strong')!.firstChild!;
    selectTextRange(bold, 6, 10); // "beta", inside the bold run
    expect(addComment(ctxOf(root))).not.toBeNull();
    expect(root.querySelector('strong > comment')).not.toBeNull();

    selectRange(root, 0, root, 1);
    toggleInline('em', ctxOf(root));

    expectCommentIntact(root, 'em', '');
    expect(root.querySelector('comment > em')!.textContent).toBe('beta');
  });

  it('never lets an inline wrapper hide a block from the walk either', () => {
    // The same descent rule, on a boundary element rather than a comment: an
    // <a> may legally wrap block content, and wrapping it whole would put a
    // <p> inside the inline tag.
    const root = makeRoot('<div><a href="https://x/"><p>x</p></a></div>');
    selectRange(root, 0, root, 1);
    toggleInline('strong', ctxOf(root));

    expect(root.querySelector('strong p')).toBeNull();
    expect(root.innerHTML).toBe(
      '<div><a href="https://x/"><p><strong>x</strong></p></a></div>',
    );
  });
});

describe('toggleInline — a code block the selection merely spans', () => {
  // <code> is an inline format this command toggles, so it is no segment
  // boundary in general — but under a <pre> it is the element holding the
  // block's content. Wrapping it whole wrote `pre > strong > code` into the
  // file for a whole-document toggle, while a selection made inside the block
  // produced `pre > code > strong`. Two shapes for one operation.
  it('formats inside the <code>, not around it', () => {
    const root = makeRoot('<p>a</p><pre><code>x</code></pre><p>b</p>');
    selectRange(root, 0, root, 3); // Ctrl+A shape
    toggleInline('strong', ctxOf(root));

    expect(root.querySelector('pre > strong')).toBeNull();
    expect(root.innerHTML).toBe(
      '<p><strong>a</strong></p><pre><code><strong>x</strong></code></pre>'
      + '<p><strong>b</strong></p>',
    );
  });

  it('agrees with a selection made inside the code block', () => {
    const root = makeRoot('<pre><code>x</code></pre>');
    selectTextRange(root.querySelector('code')!.firstChild!, 0, 1);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<pre><code><strong>x</strong></code></pre>');
  });

  it('round-trips the whole-document toggle', () => {
    const html = '<p>a</p><pre><code>x</code></pre><p>b</p>';
    const root = makeRoot(html);
    selectRange(root, 0, root, 3);
    toggleInline('strong', ctxOf(root));
    selectRange(root, 0, root, 3);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe(html);
  });

  it('leaves inline <code> outside a <pre> in its run', () => {
    // The other half: only a <pre>'s own <code> is structural. Inline code in
    // running text stays part of the run, so one wrapper still covers it.
    const root = makeRoot('<p>a <code>c</code> b</p>');
    selectRange(root, 0, root, 1);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p><strong>a <code>c</code> b</strong></p>');
  });
});

describe('toggleInline — a range that reaches into comment metadata', () => {
  // Both ends resolve to the same <comment> (findSegmentBoundary reports it for
  // anything inside, comment-body included), so the range used to take the
  // verbatim fast path and the body was pulled into the wrapper — leaving a
  // duplicated, empty <comment-body> behind. Not reachable by pointer or
  // keyboard (the metadata is display:none), but the segmentation must not
  // depend on a stylesheet for that guarantee.
  const CB = '<comment-body contenteditable="false">note</comment-body>';

  it('never wraps the body, and never duplicates it', () => {
    const root = makeRoot(`<p>b<comment id="c1">tgt${CB}</comment></p>`);
    const target = root.querySelector('comment')!.firstChild!;
    const body = root.querySelector('comment-body')!.firstChild!;
    selectRange(target, 0, body, 4);
    toggleInline('strong', ctxOf(root));

    expect(root.querySelector('strong comment-body')).toBeNull();
    expect(root.querySelectorAll('comment-body')).toHaveLength(1);
    expect(root.innerHTML).toBe(
      `<p>b<comment id="c1"><strong>tgt</strong>${CB}</comment></p>`,
    );
  });

  it('does the same when a reply is in range', () => {
    const reply = '<comment-reply contenteditable="false">re</comment-reply>';
    const root = makeRoot(`<p>b<comment id="c1">tgt${CB}${reply}</comment></p>`);
    const target = root.querySelector('comment')!.firstChild!;
    const replyText = root.querySelector('comment-reply')!.firstChild!;
    selectRange(target, 0, replyText, 2);
    toggleInline('strong', ctxOf(root));

    expect(root.querySelector('strong comment-body')).toBeNull();
    expect(root.querySelector('strong comment-reply')).toBeNull();
    expect(root.querySelectorAll('comment-reply')).toHaveLength(1);
  });
});

describe('toggleInline — REMOVING a tag that already encloses structure', () => {
  // The mirror of every case above, and the one an apply-then-remove round trip
  // can never reach: a round trip removes the wrappers the first pass built, and
  // those sit inside a single segment each. Here the wrapper is in the document
  // BEFORE the toggle and spans several segments — the shape a .html file
  // carries, and the one two ordinary commands produce (bold a phrase, comment a
  // word inside it).
  //
  // Removal then reached splitAtStart/splitAtEnd with a boundary INSIDE the
  // structural child while their extraction ran to the WRAPPER's end, across
  // that child's edge. extractContents clones a partially contained element, so
  // the <comment> came out duplicated — two elements with the same id, one left
  // empty and the other holding the contenteditable=false body — and a <ul> came
  // out as two lists. Both reached the saved file.
  const CB = '<comment-body contenteditable="false">note</comment-body>';
  const COMMENT = `<comment id="c1">beta${CB}</comment>`;

  /** The invariant behind every case here: nothing was split or duplicated. */
  function expectCommentIntact(root: HTMLElement): void {
    expect(root.querySelectorAll('comment')).toHaveLength(1);
    expect(root.querySelectorAll('comment-body')).toHaveLength(1);
    expect(root.querySelector('comment > comment-body')!.textContent).toBe('note');
    expect(root.querySelector('comment')!.getAttribute('id')).toBe('c1');
    expect(root.querySelector('comment')!.textContent).toBe('betanote');
  }

  it('unwraps a <strong> holding a comment without duplicating the comment', () => {
    const root = makeRoot(`<p><strong>alpha ${COMMENT} gamma</strong></p>`);
    selectRange(root, 0, root, 1); // Ctrl+A shape
    toggleInline('strong', ctxOf(root));

    expectCommentIntact(root);
    expect(root.querySelector('strong')).toBeNull();
    expect(root.innerHTML).toBe(`<p>alpha ${COMMENT} gamma</p>`);
  });

  it('does the same for a drag that stays inside the block', () => {
    // Not only the whole-document shape: an ordinary drag over the paragraph
    // resolves both ends to the same block and reaches the same removal.
    const root = makeRoot(`<p><strong>alpha ${COMMENT} gamma</strong></p>`);
    const p = root.querySelector('p')!;
    selectRange(p, 0, p, p.childNodes.length);
    toggleInline('strong', ctxOf(root));

    expectCommentIntact(root);
    expect(root.innerHTML).toBe(`<p>alpha ${COMMENT} gamma</p>`);
  });

  it('does the same for a wrapper in a bare root-level run', () => {
    const root = makeRoot(`<em>alpha ${COMMENT} gamma</em>`);
    selectRange(root, 0, root, 1);
    toggleInline('em', ctxOf(root));

    expectCommentIntact(root);
    expect(root.innerHTML).toBe(`alpha ${COMMENT} gamma`);
  });

  it('does the same through a NESTED inline wrapper', () => {
    const root = makeRoot(`<p><strong>a<em>b${COMMENT}c</em>d</strong></p>`);
    selectRange(root, 0, root, 1);
    toggleInline('strong', ctxOf(root));

    expectCommentIntact(root);
    expect(root.querySelector('strong')).toBeNull();
    expect(root.innerHTML).toBe(`<p>a<em>b${COMMENT}c</em>d</p>`);
  });

  it('keeps the text OUTSIDE the selection styled', () => {
    // The partial case, and what the rewrite is really for: only the comment's
    // own target is selected, so the surrounding run must stay bold — which is
    // only expressible once the wrapper has been split at the comment.
    const root = makeRoot(`<p><strong>alpha ${COMMENT} gamma</strong></p>`);
    const target = root.querySelector('comment')!.firstChild!;
    selectRange(target, 0, target, 4);
    toggleInline('strong', ctxOf(root));

    expectCommentIntact(root);
    expect(root.innerHTML).toBe(
      `<p><strong>alpha </strong><comment id="c1">beta${CB}</comment><strong> gamma</strong></p>`,
    );
  });

  it('leaves a list whole instead of splitting it in two', () => {
    // The same mechanism on a structural child that is not a comment: the
    // partially contained <ul> was cloned, so the document gained a second,
    // empty list beside the real one.
    const root = makeRoot('<div><strong>a<ul><li>x</li></ul>b</strong></div>');
    selectRange(root, 0, root, 1);
    toggleInline('strong', ctxOf(root));

    expect(root.querySelectorAll('ul')).toHaveLength(1);
    expect(root.querySelectorAll('li')).toHaveLength(1);
    expect(root.querySelector('strong')).toBeNull();
    expect(root.innerHTML).toBe('<div>a<ul><li>x</li></ul>b</div>');
  });

  it('leaves a table whole', () => {
    const table = '<table><tbody><tr><td>x</td></tr></tbody></table>';
    const root = makeRoot(`<div><strong>a${table}b</strong></div>`);
    selectRange(root, 0, root, 1);
    toggleInline('strong', ctxOf(root));

    expect(root.querySelectorAll('table')).toHaveLength(1);
    expect(root.querySelectorAll('tbody')).toHaveLength(1);
    expect(root.innerHTML).toBe(`<div>a${table}b</div>`);
  });

  it('never duplicates the comment, wherever the selection ends', () => {
    // Swept over every caret position in the comment's target text, the way the
    // apply-direction cases are, so a future change cannot regress it quietly.
    for (let end = 1; end <= 4; end++) {
      const root = makeRoot(`<p><strong>alpha ${COMMENT} gamma</strong></p>`);
      const target = root.querySelector('comment')!.firstChild!;
      selectRange(root.querySelector('strong')!.firstChild!, 0, target, end);
      toggleInline('strong', ctxOf(root));

      expect(root.querySelectorAll('comment'), `end=${end}`).toHaveLength(1);
      expect(root.querySelectorAll('comment-body'), `end=${end}`).toHaveLength(1);
      expect(root.querySelector('strong comment'), `end=${end}`).toBeNull();
      expect(root.textContent, `end=${end}`).toBe('alpha betanote gamma');
    }
  });

  it('removes the tag for the shape the real commands produce', () => {
    // Not a hand-written fixture: bold a phrase, comment a word inside it, then
    // press Ctrl+A Ctrl+B to take the bold off again.
    const root = makeRoot('<p>alpha beta gamma</p>');
    selectTextRange(root.querySelector('p')!.firstChild!, 0, 16);
    toggleInline('strong', ctxOf(root));

    const bold = root.querySelector('strong')!.firstChild!;
    selectTextRange(bold, 6, 10); // "beta", inside the bold run
    expect(addComment(ctxOf(root))).not.toBeNull();
    expect(root.querySelector('strong > comment')).not.toBeNull();

    selectRange(root, 0, root, 1);
    toggleInline('strong', ctxOf(root));

    expect(root.querySelectorAll('comment')).toHaveLength(1);
    expect(root.querySelectorAll('comment-body')).toHaveLength(1);
    expect(root.querySelector('strong')).toBeNull();
    expect(root.querySelector('comment')!.textContent).toBe('beta');
    expect(root.textContent).toBe('alpha beta gamma');
  });

  it('leaves pretty-printing bare rather than wrapping it', () => {
    // The rewrite follows the segment walk's own rule: a run carrying no text
    // is dropped, so wrapping it would leave a wrapper no segment can ever come
    // back for — a <strong> holding nothing but a newline, kept forever.
    const root = makeRoot(`<div><strong>\n  ${COMMENT}\n</strong></div>`);
    selectRange(root, 0, root, 1);
    toggleInline('strong', ctxOf(root));

    expectCommentIntact(root);
    expect(root.querySelector('strong')).toBeNull();
    expect(root.innerHTML).toBe(`<div>\n  ${COMMENT}\n</div>`);
  });

  it('leaves a run of nothing but an <img> bare for the same reason', () => {
    // Whitespace is not the only run that carries no text. Range.toString()
    // reads text-node data, so an <img> (or a <br>) run is dropped by the
    // segment walk too — and re-wrapping one here left a <strong> the removal
    // could never come back for: it appears in no segment, so no later toggle
    // can take it off. Reachable by bolding a paragraph that holds an image,
    // then commenting a word in it.
    const root = makeRoot(
      `<p><strong>${COMMENT} <img src="a.png" alt="a"> </strong></p>`,
    );
    selectRange(root, 0, root, 1);
    toggleInline('strong', ctxOf(root));

    expectCommentIntact(root);
    expect(root.querySelector('strong')).toBeNull();
    expect(root.querySelectorAll('img')).toHaveLength(1);
    expect(root.innerHTML).toBe(`<p>${COMMENT} <img src="a.png" alt="a"> </p>`);
  });

  it('still reports the selection as covered before the removal', () => {
    // The verdict is what routes the toggle into the removal branch at all, so
    // it has to see the enclosing wrapper as covering every segment.
    const root = makeRoot(`<p><strong>alpha ${COMMENT} gamma</strong></p>`);
    selectRange(root, 0, root, 1);
    const range = window.getSelection()!.getRangeAt(0);
    expect(covered(range, 'STRONG', root)).toBe(true);
    expect(covered(range, 'EM', root)).toBe(false);
  });

  it('leaves a wrapper holding nothing structural on the ordinary path', () => {
    // The rewrite must not fire for the overwhelmingly common case: a plain
    // mid-word removal still splits exactly where the user selected.
    const root = makeRoot('<p><strong>hello world</strong></p>');
    selectTextRange(root.querySelector('strong')!.firstChild!, 0, 5);
    toggleInline('strong', ctxOf(root));
    expect(root.innerHTML).toBe('<p>hello<strong> world</strong></p>');
  });

  it('hands the wrapper id to ONE run rather than cloning it onto every run', () => {
    // Distributing the wrapper means cloning it once per run, and cloneNode
    // copies every attribute — id included. An id has to stay unique in the
    // document (createListTail in commands/block-format drops it for exactly
    // this reason), so three bold runs must not come out as three id="w1".
    // The remaining attributes DO belong on each run: they are what makes the
    // text look the way it did.
    const root = makeRoot(`<p><strong id="w1" class="k">alpha ${COMMENT} gamma</strong></p>`);
    const target = root.querySelector('comment')!.firstChild!;
    selectRange(target, 0, target, 2); // inside the comment only

    toggleInline('strong', ctxOf(root));

    expectCommentIntact(root);
    expect(root.querySelectorAll('[id="w1"]')).toHaveLength(1);
    // The id survives — dropping it from every run would delete an anchor
    // target the file may depend on.
    expect(root.querySelector('[id="w1"]')!.textContent).toBe('alpha ');
    for (const el of Array.from(root.querySelectorAll('strong'))) {
      expect(el.getAttribute('class')).toBe('k');
    }
  });

  it('rewrites the whole wrapper, not only the part the selection covers', () => {
    // The distribution is not clipped to the selection: an intersecting wrapper
    // is rewritten end to end, so text the user never touched comes back in a
    // wrapper of its own. Nothing renders differently, but the saved HTML does,
    // so the shape is pinned here rather than left for the next reader of the
    // three-way diff to discover.
    const root = makeRoot(`<p><strong>alpha ${COMMENT} gamma</strong></p>`);
    const lead = root.querySelector('strong')!.firstChild!;
    selectRange(lead, 0, lead, 5); // "alpha" — entirely before the comment

    toggleInline('strong', ctxOf(root));

    expectCommentIntact(root);
    expect(root.innerHTML).toBe(
      '<p>alpha<strong> </strong>'
      + `<comment id="c1"><strong>beta</strong>${CB}</comment>`
      + '<strong> gamma</strong></p>',
    );
  });

  it('removes the tag when the selection starts at an element-level boundary', () => {
    // The boundary no text position can stand for: (p, 2) is the END of the
    // first paragraph's child list, so there is nothing after it to resolve
    // down to and the snapshot keeps an element boundary. Remembered as a child
    // INDEX it does not survive the distribution below — wrapping that
    // paragraph's run regroups its children — and the removal then ran on
    // segments the DOM had already collapsed: the document came back
    // restructured with the bold still on, which is the one failure shape a
    // toggle must never have.
    const root = makeRoot('<strong><p>a<em>b</em></p><p>c</p></strong>');
    const [first, second] = Array.from(root.querySelectorAll('p'));
    selectRange(first, first.childNodes.length, second.firstChild!, 1);

    toggleInline('strong', ctxOf(root));

    // Only the second paragraph was selected, so only it loses the tag.
    expect(root.innerHTML).toBe('<p><strong>a<em>b</em></strong></p><p>c</p>');
  });
});
