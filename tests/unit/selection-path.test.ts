import { afterEach, describe, expect, it } from 'vitest';
import { captureSelection, restoreSelection } from '../../webview/selection-path';
import { caretAtStart, clearDom, makeRoot, selectTextRange } from './helpers/selection';

afterEach(() => {
  clearDom();
});

function getCaret(): { node: Node | null; offset: number } {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return { node: null, offset: 0 };
  return { node: sel.anchorNode, offset: sel.anchorOffset };
}

/** Walk to the first text node inside the n-th child (depth-first). */
function firstText(parent: Node): Text {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) return child as Text;
    if (child.nodeType === Node.ELEMENT_NODE) {
      const inner = firstText(child);
      if (inner) return inner;
    }
  }
  throw new Error('no text node found');
}

describe('captureSelection / restoreSelection', () => {
  it('round-trips a collapsed caret deep inside a text node after re-mount', () => {
    const html = '<p>alpha</p><p>beta <strong>bold</strong> gamma</p>';
    const root = makeRoot(html);
    const target = firstText(root.children[1].children[0]); // text node inside <strong>
    selectTextRange(target, 2, 2);

    const saved = captureSelection(root);
    expect(saved).not.toBeNull();

    // Simulate the re-mount: replace the entire DOM with identical content.
    root.innerHTML = html;

    const ok = restoreSelection(root, saved!);
    expect(ok).toBe(true);

    const caret = getCaret();
    const newTarget = firstText(root.children[1].children[0]);
    expect(caret.node).toBe(newTarget);
    expect(caret.offset).toBe(2);
  });

  it('preserves a non-collapsed range whose endpoints live in different blocks', () => {
    const html = '<p>hello world</p><p>second paragraph</p>';
    const root = makeRoot(html);
    const firstP = firstText(root.children[0]);
    const secondP = firstText(root.children[1]);
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.setStart(firstP, 6); // before "world"
    range.setEnd(secondP, 6);  // before "paragraph"
    sel.removeAllRanges();
    sel.addRange(range);

    const saved = captureSelection(root);
    expect(saved).not.toBeNull();

    root.innerHTML = html;
    expect(restoreSelection(root, saved!)).toBe(true);

    const restored = window.getSelection()!;
    const newFirst = firstText(root.children[0]);
    const newSecond = firstText(root.children[1]);
    expect(restored.anchorNode).toBe(newFirst);
    expect(restored.anchorOffset).toBe(6);
    expect(restored.focusNode).toBe(newSecond);
    expect(restored.focusOffset).toBe(6);
  });

  it('returns null when the selection is outside the root', () => {
    const root = makeRoot('<p>inside</p>');
    const outside = document.createElement('p');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    caretAtStart(outside);

    expect(captureSelection(root)).toBeNull();
  });

  it('returns null when there is no selection at all', () => {
    const root = makeRoot('<p>nothing selected</p>');
    window.getSelection()?.removeAllRanges();
    expect(captureSelection(root)).toBeNull();
  });

  it('returns false from restoreSelection when the path no longer resolves', () => {
    const root = makeRoot('<p>first</p><p><em>nested</em></p>');
    const target = firstText(root.children[1].children[0]);
    selectTextRange(target, 1, 1);
    const saved = captureSelection(root);
    expect(saved).not.toBeNull();

    // Re-mount with the nested structure gone.
    root.innerHTML = '<p>only one</p>';
    expect(() => restoreSelection(root, saved!)).not.toThrow();
    expect(restoreSelection(root, saved!)).toBe(false);
  });

  it('clamps the offset when the target text shrinks after re-mount', () => {
    const root = makeRoot('<p>abcdef</p>');
    const target = firstText(root.children[0]);
    selectTextRange(target, 5, 5);
    const saved = captureSelection(root);
    expect(saved).not.toBeNull();

    root.innerHTML = '<p>ab</p>';
    expect(restoreSelection(root, saved!)).toBe(true);

    const caret = getCaret();
    expect(caret.node).toBe(firstText(root.children[0]));
    expect(caret.offset).toBe(2);
  });

  it('handles selections anchored on an element node (not a text node)', () => {
    const root = makeRoot('<p>x</p><p>y</p><p>z</p>');
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.setStart(root, 1); // between first and second <p>
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);

    const saved = captureSelection(root);
    expect(saved).not.toBeNull();

    root.innerHTML = '<p>x</p><p>y</p><p>z</p>';
    expect(restoreSelection(root, saved!)).toBe(true);

    const caret = getCaret();
    expect(caret.node).toBe(root);
    expect(caret.offset).toBe(1);
  });
});
