import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupEditor } from '../../webview/core/editor-core';
import { caretAtEnd, caretAtStart, clearDom, makeRoot } from './helpers/selection';

afterEach(() => {
  vi.useRealTimers();
  clearDom();
});

function dispatchBeforeInput(target: HTMLElement, inputType: string, data: string | null = null): InputEvent {
  const evt = new InputEvent('beforeinput', { inputType, data: data ?? undefined, cancelable: true, bubbles: true });
  target.dispatchEvent(evt);
  return evt;
}

describe('setupEditor: basics', () => {
  it('makes the root contenteditable and aria-friendly', () => {
    const root = makeRoot('');
    setupEditor(root, () => {});
    expect(root.contentEditable).toBe('true');
    expect(root.getAttribute('role')).toBe('textbox');
    expect(root.getAttribute('aria-multiline')).toBe('true');
    expect(root.spellcheck).toBe(false);
  });

  it('setEditable toggles contenteditable', () => {
    const root = makeRoot('');
    const handle = setupEditor(root, () => {});
    handle.setEditable(false);
    expect(root.contentEditable).toBe('false');
    handle.setEditable(true);
    expect(root.contentEditable).toBe('true');
  });
});

describe('setupEditor: change debounce', () => {
  it('debounces input events and fires onChange once after 250ms', () => {
    vi.useFakeTimers();
    const root = makeRoot('<p>hi</p>');
    const onChange = vi.fn();
    setupEditor(root, onChange);

    root.dispatchEvent(new Event('input', { bubbles: true }));
    root.dispatchEvent(new Event('input', { bubbles: true }));
    root.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('flush() fires the pending change immediately and clears the timer', () => {
    vi.useFakeTimers();
    const root = makeRoot('<p>hi</p>');
    const onChange = vi.fn();
    const handle = setupEditor(root, onChange);

    root.dispatchEvent(new Event('input', { bubbles: true }));
    handle.flush();
    expect(onChange).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('flush() is a no-op when no change is pending', () => {
    vi.useFakeTimers();
    const root = makeRoot('');
    const onChange = vi.fn();
    const handle = setupEditor(root, onChange);
    handle.flush();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('notifyChanged schedules a debounced change', () => {
    vi.useFakeTimers();
    const root = makeRoot('');
    const onChange = vi.fn();
    const handle = setupEditor(root, onChange);
    handle.notifyChanged();
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('setupEditor: heading shortcut', () => {
  it('converts "# " typed at the start of a P into an H1', () => {
    const root = makeRoot('<p>#</p>');
    setupEditor(root, () => {});
    const p = root.querySelector('p')!;
    caretAtEnd(p);

    const evt = dispatchBeforeInput(root, 'insertText', ' ');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<h1><br></h1>');
  });

  it('converts "###### " into an H6', () => {
    const root = makeRoot('<p>######</p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);
    dispatchBeforeInput(root, 'insertText', ' ');
    expect(root.querySelector('h6')).not.toBeNull();
  });

  it('does not convert when the caret is not at end of "#" marker only', () => {
    const root = makeRoot('<p>hello#</p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);
    const evt = dispatchBeforeInput(root, 'insertText', ' ');
    expect(evt.defaultPrevented).toBe(false);
    expect(root.innerHTML).toBe('<p>hello#</p>');
  });

  it('does not fire for non-space insertText', () => {
    const root = makeRoot('<p>#</p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);
    const evt = dispatchBeforeInput(root, 'insertText', 'x');
    expect(evt.defaultPrevented).toBe(false);
  });
});

describe('setupEditor: thematic break shortcut', () => {
  it('converts "---" + Enter into <hr> followed by a fresh paragraph', () => {
    const root = makeRoot('<p>---</p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);
    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<hr><p><br></p>');
  });

  it('does not fire when the paragraph text is not exactly "---"', () => {
    const root = makeRoot('<p>hello</p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);
    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(false);
  });
});

describe('setupEditor: Enter inside list with nested children', () => {
  it('inserts an empty <li> at the start of the nested list', () => {
    const root = makeRoot(
      '<ul><li>parent<ul><li>nested</li></ul></li></ul>',
    );
    setupEditor(root, () => {});

    // Place caret at the end of "parent" (just before the nested <ul>).
    const parentLi = root.querySelector('li')!;
    const parentText = parentLi.firstChild!; // "parent"
    const r = document.createRange();
    r.setStart(parentText, (parentText.textContent ?? '').length);
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);

    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(true);
    // The first child of the nested <ul> should now be an empty <li>.
    const nestedUl = parentLi.querySelector('ul')!;
    expect(nestedUl.children[0].tagName).toBe('LI');
    expect(nestedUl.children[0].innerHTML).toBe('<br>');
    expect(nestedUl.children).toHaveLength(2);
  });

  it('leaves Enter alone when the LI has no nested list', () => {
    const root = makeRoot('<ul><li>plain</li></ul>');
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('li')!);
    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(false);
  });
});

describe('setupEditor: normalizes browser presentational tags', () => {
  it('rewrites a <b> the browser inserted into <strong> on input', () => {
    const root = makeRoot('<p><b>S</b></p>');
    setupEditor(root, () => {});
    root.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.innerHTML).toBe('<p><strong>S</strong></p>');
  });

  it('rewrites <i> into <em> on input', () => {
    const root = makeRoot('<p><i>S</i></p>');
    setupEditor(root, () => {});
    root.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.innerHTML).toBe('<p><em>S</em></p>');
  });

  it('keeps the caret inside the rewritten element', () => {
    const root = makeRoot('<p><b>S</b></p>');
    setupEditor(root, () => {});
    const text = root.querySelector('b')!.firstChild as Text;
    const r = document.createRange();
    r.setStart(text, 1);
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);

    root.dispatchEvent(new Event('input', { bubbles: true }));

    expect(root.innerHTML).toBe('<p><strong>S</strong></p>');
    const sel2 = window.getSelection()!;
    expect(sel2.anchorNode).toBe(text);
    expect(sel2.anchorOffset).toBe(1);
    expect((root.querySelector('strong')!.firstChild)).toBe(text);
  });
});

describe('setupEditor: Enter inherits inline formatting at the end of a block', () => {
  it('continues bold onto a fresh paragraph', () => {
    const root = makeRoot('<p><strong>Sample text.</strong></p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(
      '<p><strong>Sample text.</strong></p><p><strong><br></strong></p>',
    );

    const sel = window.getSelection()!;
    const newStrong = (root.children[1] as HTMLElement).querySelector('strong')!;
    expect(sel.anchorNode).toBe(newStrong);
    expect(sel.anchorOffset).toBe(0);
  });

  it('keeps the heading level when continuing formatting', () => {
    const root = makeRoot('<h2><strong>Title</strong></h2>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('h2')!);

    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(
      '<h2><strong>Title</strong></h2><h2><strong><br></strong></h2>',
    );
  });

  it('reproduces a nested inline chain (outermost first)', () => {
    const root = makeRoot('<p><strong><em>x</em></strong></p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(
      '<p><strong><em>x</em></strong></p><p><strong><em><br></em></strong></p>',
    );
  });

  it('leaves plain paragraphs to the browser default', () => {
    const root = makeRoot('<p>hello</p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(false);
  });

  it('does not inherit links', () => {
    const root = makeRoot('<p><a href="https://example.com">x</a></p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(false);
  });

  it('does nothing when the caret is mid-text (not at the block end)', () => {
    const root = makeRoot('<p><strong>abcd</strong></p>');
    setupEditor(root, () => {});
    const text = root.querySelector('strong')!.firstChild as Text;
    const r = document.createRange();
    r.setStart(text, 2);
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);

    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(false);
  });
});
