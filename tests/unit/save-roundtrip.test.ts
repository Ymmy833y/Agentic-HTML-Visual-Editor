// Regression tests for "cursor jumps to the top of the document after save"
// and "blank lines / custom indentation get eaten on save".
//
// The repro for the cursor bug: the user creates a new block via Enter (so
// the live DOM has two block siblings with no whitespace between them), the
// serializer adds `\n` between them, and the resulting file is echoed back
// via `documentChanged`. After the remount, the live DOM has one more text
// node than it did at capture time. The selection-path module must skip
// whitespace-only siblings when counting indices so the path still lines up.
//
// The repro for the formatting bug: a source file with a blank line between
// two sections (`<h1>...</h1>\n\n    <h2>...</h2>`) must not have that
// blank line collapsed by the round-trip — the serializer leaves existing
// whitespace alone.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureSelection, restoreSelection } from '../../webview/selection-path';
import { injectEmptyBlockPlaceholders } from '../../webview/placeholder';
import { formatForSerialize } from '../../webview/serialize';
import { parseBodyContent } from '../../webview/renderer';
import { clearDom, makeRoot } from './helpers/selection';

afterEach(() => {
  clearDom();
});

function mount(root: HTMLElement, bodyInner: string): void {
  const fragment = parseBodyContent(bodyInner);
  injectEmptyBlockPlaceholders(fragment);
  root.replaceChildren(fragment);
}

function simulateSaveEcho(root: HTMLElement): {
  serialized: string;
  restored: boolean;
} {
  const saved = captureSelection(root);
  const serialized = formatForSerialize(root);
  mount(root, serialized);
  const restored = saved ? restoreSelection(root, saved) : false;
  return { serialized, restored };
}

describe('save-echo round-trip: cursor preservation', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = makeRoot('');
  });

  it('keeps the caret inside a newly-created empty <p> after a save echo', () => {
    mount(root, '<p>This is sample.</p>');
    expect(root.children.length).toBe(1);

    // Simulate Enter at the end: a new <p><br></p> is inserted directly
    // adjacent to the existing block, with the caret at the start of it.
    const existing = root.children[0] as HTMLElement;
    const fresh = document.createElement('p');
    fresh.appendChild(document.createElement('br'));
    existing.after(fresh);

    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(fresh, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);

    const { serialized, restored } = simulateSaveEcho(root);

    expect(serialized).toBe('<p>This is sample.</p>\n<p></p>');
    expect(restored).toBe(true);

    const sel2 = window.getSelection()!;
    const blocks = Array.from(root.children) as HTMLElement[];
    expect(blocks).toHaveLength(2);
    expect(blocks[1].tagName).toBe('P');
    expect(sel2.anchorNode).toBe(blocks[1]);
    expect(sel2.anchorOffset).toBe(0);
  });

  it('keeps a formatted empty <p> (and its formatting) after a save echo', () => {
    mount(root, '<p><strong>bold</strong></p>');

    // Simulate Enter after fully-bold text: a new <p><strong><br></strong></p>
    // with the caret inside the fresh <strong>.
    const existing = root.children[0] as HTMLElement;
    const fresh = document.createElement('p');
    const strong = document.createElement('strong');
    strong.appendChild(document.createElement('br'));
    fresh.appendChild(strong);
    existing.after(fresh);

    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(strong, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);

    const { serialized, restored } = simulateSaveEcho(root);

    expect(serialized).toBe('<p><strong>bold</strong></p>\n<p><strong></strong></p>');
    expect(restored).toBe(true);

    const blocks = Array.from(root.children) as HTMLElement[];
    expect(blocks).toHaveLength(2);
    expect(blocks[1].innerHTML).toBe('<strong><br></strong>');
  });

  it('keeps the caret in the middle of an existing paragraph through a save echo', () => {
    mount(root, '<p>hello world</p><p>second</p>');
    const firstP = root.children[0] as HTMLElement;
    const textNode = firstP.firstChild as Text;

    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(textNode, 6);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);

    const { restored } = simulateSaveEcho(root);
    expect(restored).toBe(true);

    const restoredSel = window.getSelection()!;
    const newText = (root.children[0] as HTMLElement).firstChild as Text;
    expect(restoredSel.anchorNode).toBe(newText);
    expect(restoredSel.anchorOffset).toBe(6);
  });

  it('keeps the caret inside a fresh <p> appended to an indented document', () => {
    mount(root, '\n  <p>existing</p>\n');
    expect(root.childNodes.length).toBe(3);

    const fresh = document.createElement('p');
    fresh.appendChild(document.createElement('br'));
    root.children[0].after(fresh);

    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(fresh, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);

    const { serialized, restored } = simulateSaveEcho(root);
    expect(serialized).toBe('\n  <p>existing</p>\n  <p></p>\n');
    expect(restored).toBe(true);

    const sel2 = window.getSelection()!;
    const blocks = Array.from(root.children) as HTMLElement[];
    expect(blocks).toHaveLength(2);
    expect(sel2.anchorNode).toBe(blocks[1]);
  });
});

describe('save-echo round-trip: whitespace preservation', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = makeRoot('');
  });

  it('preserves a blank line between two sibling blocks (no edits)', () => {
    const source = '\n    <h1>Title</h1>\n\n    <h2>Section</h2>\n';
    mount(root, source);
    const { serialized } = simulateSaveEcho(root);
    expect(serialized).toBe(source);
  });

  it('preserves a blank line when adding a new block after one of the section heads', () => {
    const source = '\n    <h1>Title</h1>\n\n    <h2>Section</h2>\n';
    mount(root, source);
    // Insert a new <p><br></p> directly after <h1> (between h1 and the
    // existing blank-line whitespace).
    const h1 = root.querySelector('h1')!;
    const fresh = document.createElement('p');
    fresh.appendChild(document.createElement('br'));
    h1.after(fresh);

    const { serialized } = simulateSaveEcho(root);
    // The new gap between <h1> and <p></p> gets the document's indent
    // pattern ("\n    "); the blank line between <p></p> and <h2> survives.
    expect(serialized).toBe(
      '\n    <h1>Title</h1>\n    <p></p>\n\n    <h2>Section</h2>\n',
    );
  });

  it('is idempotent: re-saving an already-saved document yields the same string', () => {
    const source = '\n    <h1>Title</h1>\n\n    <h2>Section</h2>\n';
    mount(root, source);
    const first = formatForSerialize(root);
    // Re-mount with the serialized output and serialize again.
    mount(root, first);
    const second = formatForSerialize(root);
    expect(second).toBe(first);
    expect(first).toBe(source);
  });
});
