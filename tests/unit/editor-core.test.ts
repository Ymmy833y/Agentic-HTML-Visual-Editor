import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupEditor } from '../../webview/core/editor-core';
import { formatForSerialize } from '../../webview/core/serialize';
import {
  caretAtEnd,
  caretAtStart,
  clearDom,
  makeRoot,
  selectTextRange,
} from './helpers/selection';

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

describe('setupEditor: list shortcut', () => {
  it('converts "- " at the start of a P into a bulleted list', () => {
    const root = makeRoot('<p>-</p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);
    const evt = dispatchBeforeInput(root, 'insertText', ' ');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<ul><li><br></li></ul>');
  });

  it('converts "* " into a bulleted list', () => {
    const root = makeRoot('<p>*</p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);
    dispatchBeforeInput(root, 'insertText', ' ');
    expect(root.innerHTML).toBe('<ul><li><br></li></ul>');
  });

  it('converts "1. " into a numbered list', () => {
    const root = makeRoot('<p>1.</p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);
    dispatchBeforeInput(root, 'insertText', ' ');
    expect(root.innerHTML).toBe('<ol><li><br></li></ol>');
  });

  it('keeps the text that follows the marker', () => {
    const root = makeRoot('<p>-hello</p>');
    setupEditor(root, () => {});
    const text = root.querySelector('p')!.firstChild!;
    const r = document.createRange();
    r.setStart(text, 1); // caret right after the "-"
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);

    const evt = dispatchBeforeInput(root, 'insertText', ' ');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<ul><li>hello</li></ul>');
  });

  it('does not fire when the marker is not at the start of the block', () => {
    const root = makeRoot('<p>a-</p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);
    const evt = dispatchBeforeInput(root, 'insertText', ' ');
    expect(evt.defaultPrevented).toBe(false);
    expect(root.innerHTML).toBe('<p>a-</p>');
  });
});

describe('setupEditor: blockquote shortcut', () => {
  it('converts "> " at the start of a P into a blockquote', () => {
    const root = makeRoot('<p>&gt;</p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);
    const evt = dispatchBeforeInput(root, 'insertText', ' ');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<blockquote><br></blockquote>');
  });

  it('keeps following text inside the blockquote', () => {
    const root = makeRoot('<p>&gt;quote</p>');
    setupEditor(root, () => {});
    const text = root.querySelector('p')!.firstChild!;
    const r = document.createRange();
    r.setStart(text, 1); // after the ">"
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);

    dispatchBeforeInput(root, 'insertText', ' ');
    expect(root.innerHTML).toBe('<blockquote>quote</blockquote>');
  });

  it('does not fire when ">" is not at the start of the block', () => {
    const root = makeRoot('<p>a&gt;</p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);
    const evt = dispatchBeforeInput(root, 'insertText', ' ');
    expect(evt.defaultPrevented).toBe(false);
  });

  for (const type of ['note', 'tip', 'important', 'warning', 'caution'] as const) {
    it(`converts ">${type} " into a ${type} alert`, () => {
      const root = makeRoot(`<p>&gt;${type}</p>`);
      setupEditor(root, () => {});
      caretAtEnd(root.querySelector('p')!);
      const evt = dispatchBeforeInput(root, 'insertText', ' ');
      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(
        `<blockquote data-alert="${type}"><br></blockquote>`,
      );
    });
  }

  it('does not treat ">info " as an alert shortcut', () => {
    const root = makeRoot('<p>&gt;info</p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);
    const evt = dispatchBeforeInput(root, 'insertText', ' ');
    expect(evt.defaultPrevented).toBe(false);
    expect(root.innerHTML).toBe('<p>&gt;info</p>');
  });

  it('matches alert markers case-insensitively', () => {
    const root = makeRoot('<p>&gt;WaRnInG</p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);
    dispatchBeforeInput(root, 'insertText', ' ');
    expect(root.innerHTML).toBe('<blockquote data-alert="warning"><br></blockquote>');
  });

  it('keeps text following an alert marker inside the alert', () => {
    const root = makeRoot('<p>&gt;tipHelpful</p>');
    setupEditor(root, () => {});
    const text = root.querySelector('p')!.firstChild!;
    const r = document.createRange();
    r.setStart(text, 4); // after ">tip"
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    dispatchBeforeInput(root, 'insertText', ' ');
    expect(root.innerHTML).toBe('<blockquote data-alert="tip">Helpful</blockquote>');
  });

  it('converts an alert shortcut in bare root text', () => {
    const root = makeRoot('&gt;important');
    setupEditor(root, () => {});
    caretAtEnd(root);
    const evt = dispatchBeforeInput(root, 'insertText', ' ');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(
      '<blockquote data-alert="important"><br></blockquote>',
    );
  });
});

describe('setupEditor: code block shortcut', () => {
  it('converts "```" + Enter into an empty code block', () => {
    const root = makeRoot('<p>```</p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);
    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<pre><br></pre>');
  });

  it('does not fire when the paragraph text is not exactly "```"', () => {
    const root = makeRoot('<p>``</p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);
    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(false);
  });

  for (const attribute of [
    '',
    ' data-alert="note"',
    ' data-alert="tip"',
    ' data-alert="important"',
    ' data-alert="warning"',
    ' data-alert="caution"',
  ]) {
    const kind = attribute ? attribute.match(/"([a-z]+)"/)![1] : 'normal';
    it(`creates a nested code block inside a ${kind} blockquote`, () => {
      const root = makeRoot(`<blockquote${attribute}>\`\`\`</blockquote>`);
      setupEditor(root, () => {});
      caretAtEnd(root.querySelector('blockquote')!);

      const evt = dispatchBeforeInput(root, 'insertParagraph');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(
        `<blockquote${attribute}><pre><br></pre></blockquote>`,
      );
    });
  }

  it('converts only the current quote line and preserves preceding text', () => {
    const root = makeRoot(
      '<blockquote data-alert="warning">aaa<br>```</blockquote>',
    );
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('blockquote')!);

    const evt = dispatchBeforeInput(root, 'insertParagraph');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(
      '<blockquote data-alert="warning"><p>aaa</p><pre><br></pre></blockquote>',
    );
  });
});

describe('setupEditor: Enter inside a bare blockquote', () => {
  for (const attribute of ['', ' data-alert="tip"']) {
    const kind = attribute ? 'alert' : 'blockquote';
    it(`inserts a soft line break without creating a sibling ${kind}`, () => {
      const root = makeRoot(`<blockquote${attribute}>aaa</blockquote>`);
      setupEditor(root, () => {});
      caretAtEnd(root.querySelector('blockquote')!);

      const evt = dispatchBeforeInput(root, 'insertParagraph');

      expect(evt.defaultPrevented).toBe(true);
      expect(formatForSerialize(root)).toBe(`<blockquote${attribute}>aaa<br></blockquote>`);
      expect(root.querySelector('br[data-ahve-quote-placeholder]')).not.toBeNull();
      expect(root.querySelectorAll('blockquote')).toHaveLength(1);
    });
  }

  it('splits inline formatting around a direct quote line break', () => {
    const root = makeRoot('<blockquote><strong>abcd</strong></blockquote>');
    setupEditor(root, () => {});
    const text = root.querySelector('strong')!.firstChild!;
    selectTextRange(text, 2, 2);

    const evt = dispatchBeforeInput(root, 'insertParagraph');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(
      '<blockquote><strong>ab</strong><br><strong>cd</strong></blockquote>',
    );
  });

  it('exits the quote when Enter is pressed on its trailing empty line', () => {
    const root = makeRoot('<blockquote>aaa</blockquote>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('blockquote')!);

    dispatchBeforeInput(root, 'insertParagraph');
    const evt = dispatchBeforeInput(root, 'insertParagraph');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<blockquote>aaa</blockquote><p><br></p>');
  });

  it('leaves Enter inside an existing nested paragraph to its block behavior', () => {
    const root = makeRoot('<blockquote><p>aaa</p></blockquote>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'insertParagraph');

    expect(evt.defaultPrevented).toBe(false);
    expect(root.innerHTML).toBe('<blockquote><p>aaa</p></blockquote>');
  });
});

// contenteditable's default Enter often yields a <div> (e.g. the line after a
// heading or list), so the markdown block shortcuts must fire in <div> blocks
// too — not only <p>. See isPlainTextBlock in editor-core.
describe('setupEditor: block shortcuts also fire inside <div>', () => {
  it('converts "- " inside a <div> into a bulleted list', () => {
    const root = makeRoot('<div>-</div>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('div')!);
    const evt = dispatchBeforeInput(root, 'insertText', ' ');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<ul><li><br></li></ul>');
  });

  it('converts "> " inside a <div> into a blockquote', () => {
    const root = makeRoot('<div>&gt;</div>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('div')!);
    const evt = dispatchBeforeInput(root, 'insertText', ' ');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<blockquote><br></blockquote>');
  });

  it('converts ">note " inside a <div> into an alert', () => {
    const root = makeRoot('<div>&gt;note</div>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('div')!);
    const evt = dispatchBeforeInput(root, 'insertText', ' ');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<blockquote data-alert="note"><br></blockquote>');
  });

  it('converts "## " inside a <div> into a heading', () => {
    const root = makeRoot('<div>##</div>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('div')!);
    const evt = dispatchBeforeInput(root, 'insertText', ' ');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<h2><br></h2>');
  });

  it('converts "```" + Enter inside a <div> into a code block', () => {
    const root = makeRoot('<div>```</div>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('div')!);
    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<pre><br></pre>');
  });
});

// Table cells hold bare inline content (no block wrapper), so the block
// shortcuts must wrap that content in a <p> on demand and act inside the cell.
describe('setupEditor: block shortcuts inside a bare table cell', () => {
  function cell(html: string): { root: HTMLElement; td: HTMLElement } {
    const root = makeRoot(`<table><tbody><tr><td>${html}</td></tr></tbody></table>`);
    setupEditor(root, () => {});
    return { root, td: root.querySelector('td')! };
  }

  it('converts "# " into a heading inside the cell', () => {
    const { td } = cell('#');
    caretAtEnd(td);
    const evt = dispatchBeforeInput(td, 'insertText', ' ');
    expect(evt.defaultPrevented).toBe(true);
    expect(td.innerHTML).toBe('<h1><br></h1>');
  });

  it('converts "- " into a bulleted list inside the cell', () => {
    const { td } = cell('-');
    caretAtEnd(td);
    const evt = dispatchBeforeInput(td, 'insertText', ' ');
    expect(evt.defaultPrevented).toBe(true);
    expect(td.innerHTML).toBe('<ul><li><br></li></ul>');
  });

  it('converts "> " into a blockquote inside the cell', () => {
    const { td } = cell('&gt;');
    caretAtEnd(td);
    const evt = dispatchBeforeInput(td, 'insertText', ' ');
    expect(evt.defaultPrevented).toBe(true);
    expect(td.innerHTML).toBe('<blockquote><br></blockquote>');
  });

  it('converts ">caution " into an alert inside the cell', () => {
    const { td } = cell('&gt;caution');
    caretAtEnd(td);
    const evt = dispatchBeforeInput(td, 'insertText', ' ');
    expect(evt.defaultPrevented).toBe(true);
    expect(td.innerHTML).toBe(
      '<blockquote data-alert="caution"><br></blockquote>',
    );
  });

  it('keeps the text that follows the marker', () => {
    const { td } = cell('-hello');
    const text = td.firstChild!;
    const r = document.createRange();
    r.setStart(text, 1); // caret right after the "-"
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    dispatchBeforeInput(td, 'insertText', ' ');
    expect(td.innerHTML).toBe('<ul><li>hello</li></ul>');
  });

  it('a plain space in a bare cell does not wrap the content in a <p>', () => {
    const { td } = cell('a');
    caretAtEnd(td);
    const evt = dispatchBeforeInput(td, 'insertText', ' ');
    expect(evt.defaultPrevented).toBe(false);
    expect(td.innerHTML).toBe('a');
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

describe('setupEditor: Enter inside an empty list item', () => {
  it('exits the list as a paragraph when the last item is empty', () => {
    const root = makeRoot('<ul><li>a</li><li><br></li></ul>');
    setupEditor(root, () => {});
    caretAtStart(root.querySelectorAll('li')[1]);

    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<ul><li>a</li></ul><p><br></p>');
  });

  it('removes the whole list when its only item is empty', () => {
    const root = makeRoot('<ul><li><br></li></ul>');
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('li')!);

    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<p><br></p>');
  });

  it('leaves a non-empty item to the browser default', () => {
    const root = makeRoot('<ul><li>ab</li></ul>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('li')!);

    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(false);
  });

  it('leaves an empty middle item to the browser default', () => {
    const root = makeRoot('<ul><li><br></li><li>b</li></ul>');
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('li')!);

    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(false);
  });
});

describe('setupEditor: Enter inside <summary>', () => {
  it('moves the caret to the existing body block instead of splitting', () => {
    const root = makeRoot('<details open=""><summary>title</summary><p>body</p></details>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('summary')!);

    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(true);
    // No second summary was created.
    expect(root.querySelectorAll('summary')).toHaveLength(1);
    const body = root.querySelector('p')!;
    const sel = window.getSelection()!;
    expect(sel.anchorNode).toBe(body);
    expect(sel.anchorOffset).toBe(0);
  });

  it('creates an empty <p> body when the summary has no following block', () => {
    const root = makeRoot('<details open=""><summary>title</summary></details>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('summary')!);

    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(
      '<details open=""><summary>title</summary><p><br></p></details>',
    );
  });

  it('opens a collapsed details so the caret destination is visible', () => {
    const root = makeRoot('<details><summary>title</summary><p>body</p></details>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('summary')!);

    dispatchBeforeInput(root, 'insertParagraph');
    expect(root.querySelector('details')!.hasAttribute('open')).toBe(true);
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

// Pressing Enter with the caret inside a comment's target text must not let the
// browser default split cut through the comment (which corrupts its
// contenteditable=false body and duplicates its id). The editor splits the
// block itself at the boundary just after the whole <comment>, so the comment
// stays whole on the current line and only the content after it moves down.
describe('setupEditor: Enter keeps an inline comment whole', () => {
  function placeCaret(node: Node, offset: number): void {
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  }

  it('splits after the whole comment, keeping its body intact (caret at target end)', () => {
    const root = makeRoot(
      '<p>This is sample <comment id="c1">text' +
        '<comment-body contenteditable="false" data-author="human">note</comment-body></comment>.</p>',
    );
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    placeCaret(comment.firstChild!, 'text'.length);

    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(true);

    const ps = root.querySelectorAll(':scope > p');
    expect(ps).toHaveLength(2);
    // The comment (with body) stays whole in the first paragraph.
    expect(ps[0].querySelectorAll('comment')).toHaveLength(1);
    expect(ps[0].querySelector('comment-body')!.textContent).toBe('note');
    expect(ps[0].querySelector('comment')!.firstChild!.textContent).toBe('text');
    // Only the trailing "." moved to the new paragraph.
    expect(ps[1].textContent).toBe('.');
    // Exactly one comment overall (no duplicate id).
    expect(root.querySelectorAll('comment')).toHaveLength(1);
    const sel = window.getSelection()!;
    expect(sel.anchorNode).toBe(ps[1]);
    expect(sel.anchorOffset).toBe(0);
  });

  it('does not cut the target text when the caret is mid-target', () => {
    const root = makeRoot('<p>x <comment id="c1">hello<comment-body>n</comment-body></comment> y</p>');
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    placeCaret(comment.firstChild!, 2); // "he|llo"

    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.querySelectorAll('comment')).toHaveLength(1);
    expect(root.querySelector('comment')!.firstChild!.textContent).toBe('hello'); // not cut
    const ps = root.querySelectorAll(':scope > p');
    expect(ps[1].textContent).toBe(' y');
  });

  it('creates an empty new block when the comment is at the block end', () => {
    const root = makeRoot('<p>x <comment id="c1">t<comment-body>n</comment-body></comment></p>');
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    placeCaret(comment.firstChild!, 1);

    dispatchBeforeInput(root, 'insertParagraph');
    const ps = root.querySelectorAll(':scope > p');
    expect(ps).toHaveLength(2);
    expect(ps[1].innerHTML).toBe('<br>');
    expect(root.querySelectorAll('comment')).toHaveLength(1);
  });

  it('leaves the caret alone when it is not inside a comment', () => {
    const root = makeRoot('<p>plain text here</p>');
    setupEditor(root, () => {});
    const p = root.querySelector('p')!;
    placeCaret(p.firstChild!, 5);

    const evt = dispatchBeforeInput(root, 'insertParagraph');
    expect(evt.defaultPrevented).toBe(false);
    const sel = window.getSelection()!;
    expect(sel.anchorNode).toBe(p.firstChild);
    expect(sel.anchorOffset).toBe(5);
  });
});

// Backspace with the caret right after a comment must not delete across the
// boundary into the contenteditable=false body. The editor shrinks the target
// text instead, and removes the whole comment only once it has no anchor text.
describe('setupEditor: Backspace just after a comment', () => {
  function caretAfterComment(root: HTMLElement): void {
    const comment = root.querySelector('comment')!;
    const r = document.createRange();
    r.setStart(comment.nextSibling!, 0);
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  }

  it('shrinks the target text instead of deleting the body', () => {
    const root = makeRoot(
      '<p>a <comment id="c1">text<comment-body data-author="human">note</comment-body></comment> b</p>',
    );
    setupEditor(root, () => {});
    caretAfterComment(root);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.querySelectorAll('comment')).toHaveLength(1);
    const comment = root.querySelector('comment')!;
    expect(comment.querySelector('comment-body')!.textContent).toBe('note');
    expect(comment.firstChild!.textContent).toBe('tex'); // one char shorter
  });

  it('removes the comment once its target text is exhausted', () => {
    const root = makeRoot('<p>a <comment id="c1">x<comment-body>n</comment-body></comment> b</p>');
    setupEditor(root, () => {});
    caretAfterComment(root);

    // First backspace: "x" -> "" (empty target text node remains, comment kept).
    dispatchBeforeInput(root, 'deleteContentBackward');
    expect(root.querySelector('comment')!.firstChild!.textContent).toBe('');
    // Second backspace: no anchor text left -> the comment is removed.
    caretAfterComment(root);
    dispatchBeforeInput(root, 'deleteContentBackward');
    expect(root.querySelectorAll('comment')).toHaveLength(0);
  });

  it('leaves a normal mid-text backspace to the browser', () => {
    const root = makeRoot('<p>hello</p>');
    setupEditor(root, () => {});
    const p = root.querySelector('p')!;
    const r = document.createRange();
    r.setStart(p.firstChild!, 3);
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');
    expect(evt.defaultPrevented).toBe(false);
  });
});

// A comment's <comment-body>/<comment-reply> are display:none and
// contenteditable=false; the browser default deletion mistakes them for the
// next deletable node and wipes the body. Deletions must act only on visible
// characters (target text + surrounding text), skipping the metadata.
describe('setupEditor: deletion skips comment metadata (visible chars only)', () => {
  function caret(node: Node, offset: number): void {
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  }
  const SAMPLE =
    '<h2>Hea<comment id="c1">di' +
    '<comment-body contenteditable="false" data-author="human">Comment</comment-body>' +
    '</comment>ng</h2>';

  it('Delete at the comment trailing edge removes the following "n", keeping body (reported bug)', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    caret(comment, comment.childNodes.length); // after the (display:none) body

    const evt = dispatchBeforeInput(root, 'deleteContentForward');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.querySelectorAll('comment')).toHaveLength(1);
    expect(comment.firstChild!.textContent).toBe('di'); // target untouched
    expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
    expect(comment.nextSibling!.textContent).toBe('g'); // "ng" -> "g"
  });

  it('Delete from the text-level target end also skips metadata and removes "n"', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    caret(comment.firstChild!, 2); // end of "di"

    dispatchBeforeInput(root, 'deleteContentForward');
    expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
    expect(comment.firstChild!.textContent).toBe('di');
    expect(comment.nextSibling!.textContent).toBe('g');
  });

  it('Backspace at the comment trailing edge shrinks the target "i", keeping body', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    caret(comment.firstChild!, 2); // end of "di"

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');
    expect(evt.defaultPrevented).toBe(true);
    expect(comment.firstChild!.textContent).toBe('d'); // "di" -> "d"
    expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
    expect(comment.nextSibling!.textContent).toBe('ng'); // following text untouched
  });

  it('Delete just before a comment shrinks its first target char, keeping body', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    const hea = root.querySelector('h2')!.firstChild!;
    caret(hea, hea.textContent!.length); // "Hea|", just before the comment

    dispatchBeforeInput(root, 'deleteContentForward');
    expect(comment.firstChild!.textContent).toBe('i'); // "di" -> "i"
    expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
  });

  it('Delete on text right after a comment removes its first char without harming the body', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    caret(comment.nextSibling!, 0); // start of "ng"

    const evt = dispatchBeforeInput(root, 'deleteContentForward');
    expect(evt.defaultPrevented).toBe(true);
    expect(comment.nextSibling!.textContent).toBe('g');
    expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
  });

  it('leaves a normal delete far from any comment to the browser', () => {
    const root = makeRoot('<p>hello</p>');
    setupEditor(root, () => {});
    caret(root.querySelector('p')!.firstChild!, 2);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');
    expect(evt.defaultPrevented).toBe(false);
  });
});

// Backspace at the start of a block (and the mirror, Delete at a block's end)
// merges adjacent blocks ourselves. The browser default merge cuts through a
// trailing comment's contenteditable=false body and wraps moved heading text in
// a presentational <span style="font-size">; relocating the nodes by reference
// keeps the comment whole and injects no style wrapper.
describe('setupEditor: Backspace/Delete merges adjacent blocks', () => {
  it('folds a heading into the previous heading, keeping a trailing comment whole (reported bug)', () => {
    const root = makeRoot(
      '<h2>Head<comment id="c-z8tsbr26">in' +
        '<comment-body contenteditable="false" data-author="human">ほげ</comment-body></comment></h2>' +
        '<h2>gs</h2>',
    );
    setupEditor(root, () => {});
    const second = root.querySelectorAll('h2')[1];
    caretAtStart(second);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');
    expect(evt.defaultPrevented).toBe(true);

    const headings = root.querySelectorAll(':scope > h2');
    expect(headings).toHaveLength(1);
    const h2 = headings[0];
    // The comment and its body survive intact, with no duplicate.
    expect(root.querySelectorAll('comment')).toHaveLength(1);
    expect(h2.querySelector('comment')!.getAttribute('id')).toBe('c-z8tsbr26');
    expect(h2.querySelector('comment')!.firstChild!.textContent).toBe('in');
    expect(h2.querySelector('comment-body')!.textContent).toBe('ほげ');
    // No presentational span / font-size wrapper was injected around "gs".
    expect(h2.querySelector('span')).toBeNull();
    expect(h2.innerHTML).not.toContain('font-size');
    expect(h2.lastChild!.textContent).toBe('gs');
    // Caret lands at the join, right after the comment.
    const sel = window.getSelection()!;
    expect(sel.anchorNode).toBe(h2);
  });

  it('merges two plain headings verbatim without a style wrapper', () => {
    const root = makeRoot('<h2>foo</h2><h2>bar</h2>');
    setupEditor(root, () => {});
    caretAtStart(root.querySelectorAll('h2')[1]);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');
    expect(evt.defaultPrevented).toBe(true);
    const headings = root.querySelectorAll(':scope > h2');
    expect(headings).toHaveLength(1);
    expect(headings[0].querySelector('span')).toBeNull();
    expect(headings[0].textContent).toBe('foobar');
  });

  it('merges paragraphs and leaves the caret at the join', () => {
    const root = makeRoot('<p>foo</p><p>bar</p>');
    setupEditor(root, () => {});
    caretAtStart(root.querySelectorAll('p')[1]);

    dispatchBeforeInput(root, 'deleteContentBackward');
    const ps = root.querySelectorAll(':scope > p');
    expect(ps).toHaveLength(1);
    expect(ps[0].textContent).toBe('foobar');
    const sel = window.getSelection()!;
    // Caret sits between the original "foo" and the moved "bar".
    expect(sel.anchorNode).toBe(ps[0]);
    expect(sel.anchorOffset).toBe(1);
  });

  it('drops an empty previous block and keeps the current block type', () => {
    const root = makeRoot('<p><br></p><h2>Title</h2>');
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('h2')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.querySelectorAll(':scope > p')).toHaveLength(0);
    const headings = root.querySelectorAll(':scope > h2');
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toBe('Title'); // heading not absorbed into a <p>
  });

  it('drops the current empty block and parks the caret at the previous end', () => {
    const root = makeRoot('<h2>Head</h2><p><br></p>');
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('p')!);

    dispatchBeforeInput(root, 'deleteContentBackward');
    expect(root.querySelectorAll(':scope > p')).toHaveLength(0);
    const h2 = root.querySelector('h2')!;
    expect(h2.textContent).toBe('Head');
    const sel = window.getSelection()!;
    expect(sel.anchorNode).toBe(h2);
    expect(sel.anchorOffset).toBe(h2.childNodes.length);
  });

  it('defers to the browser when there is no previous block', () => {
    const root = makeRoot('<h2>only</h2>');
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('h2')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');
    expect(evt.defaultPrevented).toBe(false);
  });

  it('defers to the browser when the previous sibling is a list', () => {
    const root = makeRoot('<ul><li>a</li></ul><p>b</p>');
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');
    expect(evt.defaultPrevented).toBe(false);
  });

  it('defers to the browser when an adjacent block nests another block', () => {
    const root = makeRoot('<div><p>x</p></div><p>y</p>');
    setupEditor(root, () => {});
    caretAtStart(root.querySelectorAll('p')[1]);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');
    expect(evt.defaultPrevented).toBe(false);
  });

  it('does not fire when the caret is not at the block start', () => {
    const root = makeRoot('<p>foo</p><p>bar</p>');
    setupEditor(root, () => {});
    const second = root.querySelectorAll('p')[1];
    const r = document.createRange();
    r.setStart(second.firstChild!, 1); // "b|ar"
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');
    expect(evt.defaultPrevented).toBe(false);
  });

  it('Delete at a block end pulls the next block in, keeping a trailing comment whole', () => {
    const root = makeRoot(
      '<h2>Head<comment id="c1">in' +
        '<comment-body contenteditable="false" data-author="human">note</comment-body></comment></h2>' +
        '<h2>gs</h2>',
    );
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('h2')!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');
    expect(evt.defaultPrevented).toBe(true);
    expect(root.querySelectorAll(':scope > h2')).toHaveLength(1);
    expect(root.querySelectorAll('comment')).toHaveLength(1);
    const h2 = root.querySelector('h2')!;
    expect(h2.querySelector('comment-body')!.textContent).toBe('note');
    expect(h2.querySelector('span')).toBeNull();
    expect(h2.lastChild!.textContent).toBe('gs');
  });

  it('Delete defers to the browser when there is no next block', () => {
    const root = makeRoot('<p>only</p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');
    expect(evt.defaultPrevented).toBe(false);
  });
});

// The end of a comment's target text (inside the comment) and the position just
// after </comment> (outside it) render at the same spot because the
// <comment-body> is display:none. ArrowRight steps the caret outside so the next
// character is typed after the comment; ArrowLeft steps back inside. A dedicated
// insertText handler guarantees outside typing lands after </comment> rather
// than being absorbed back into the comment.
describe('setupEditor: typing inside vs outside a comment', () => {
  const SAMPLE =
    '<p>Sample <comment id="c1">text' +
    '<comment-body contenteditable="false" data-author="human">Comment</comment-body>' +
    '</comment></p>';

  function placeCaret(node: Node, offset: number): void {
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function dispatchKeydown(target: HTMLElement, key: string): KeyboardEvent {
    const evt = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true });
    target.dispatchEvent(evt);
    return evt;
  }

  function commentOf(root: HTMLElement): HTMLElement {
    return root.querySelector('comment')!;
  }

  it('ArrowRight at the target end steps the caret just outside the comment', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = commentOf(root);
    placeCaret(comment.firstChild!, 'text'.length);

    const evt = dispatchKeydown(root, 'ArrowRight');
    expect(evt.defaultPrevented).toBe(true);

    const sel = window.getSelection()!;
    expect(sel.isCollapsed).toBe(true);
    // The caret now sits in the <p>, right after the comment element.
    const p = comment.parentElement!;
    expect(sel.anchorNode).toBe(p);
    expect(sel.anchorOffset).toBe(Array.prototype.indexOf.call(p.childNodes, comment) + 1);
  });

  it('ArrowRight mid-target is left to the browser (caret unchanged)', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = commentOf(root);
    placeCaret(comment.firstChild!, 2); // "te|xt"

    const evt = dispatchKeydown(root, 'ArrowRight');
    expect(evt.defaultPrevented).toBe(false);
    const sel = window.getSelection()!;
    expect(sel.anchorNode).toBe(comment.firstChild);
    expect(sel.anchorOffset).toBe(2);
  });

  it('ArrowRight from the comment-internal trailing edge also steps outside', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = commentOf(root);
    placeCaret(comment, comment.childNodes.length); // after the display:none body

    const evt = dispatchKeydown(root, 'ArrowRight');
    expect(evt.defaultPrevented).toBe(true);
    const p = comment.parentElement!;
    const sel = window.getSelection()!;
    expect(sel.anchorNode).toBe(p);
    expect(sel.anchorOffset).toBe(Array.prototype.indexOf.call(p.childNodes, comment) + 1);
  });

  it('ArrowLeft just outside a comment re-enters at the target end', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = commentOf(root);
    const r = document.createRange();
    r.setStartAfter(comment);
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);

    const evt = dispatchKeydown(root, 'ArrowLeft');
    expect(evt.defaultPrevented).toBe(true);
    const after = window.getSelection()!;
    expect(after.anchorNode).toBe(comment.firstChild);
    expect(after.anchorOffset).toBe('text'.length);
  });

  it('ArrowLeft elsewhere is left to the browser', () => {
    const root = makeRoot('<p>plain</p>');
    setupEditor(root, () => {});
    const p = root.querySelector('p')!;
    placeCaret(p.firstChild!, 3);

    const evt = dispatchKeydown(root, 'ArrowLeft');
    expect(evt.defaultPrevented).toBe(false);
  });

  it('Shift+ArrowRight (selection extension) is not hijacked', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = commentOf(root);
    placeCaret(comment.firstChild!, 'text'.length);

    const evt = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      shiftKey: true,
      cancelable: true,
      bubbles: true,
    });
    root.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
  });

  it('insertText just outside a comment lands after </comment> as a sibling text node', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = commentOf(root);
    const r = document.createRange();
    r.setStartAfter(comment); // caret just outside, no following text node yet
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);

    const evt = dispatchBeforeInput(root, 'insertText', 'a');
    expect(evt.defaultPrevented).toBe(true);

    // A new text node "a" now follows the comment, outside it.
    expect(comment.nextSibling!.nodeType).toBe(Node.TEXT_NODE);
    expect(comment.nextSibling!.textContent).toBe('a');
    // The comment is untouched: single element, id, target text, and body.
    expect(root.querySelectorAll('comment')).toHaveLength(1);
    expect(comment.getAttribute('id')).toBe('c1');
    expect(comment.firstChild!.textContent).toBe('text');
    expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
    // Caret sits after the inserted character.
    const after = window.getSelection()!;
    expect(after.anchorNode).toBe(comment.nextSibling);
    expect(after.anchorOffset).toBe(1);
  });

  it('insertText just outside prepends into an existing following text node', () => {
    const root = makeRoot(
      '<p>a <comment id="c1">text<comment-body>note</comment-body></comment> b</p>',
    );
    setupEditor(root, () => {});
    const comment = commentOf(root);
    placeCaret(comment.nextSibling!, 0); // start of the " b" text node, outside

    const evt = dispatchBeforeInput(root, 'insertText', 'X');
    expect(evt.defaultPrevented).toBe(true);
    expect(comment.nextSibling!.textContent).toBe('X b');
    expect(comment.querySelector('comment-body')!.textContent).toBe('note');
  });

  it('insertText at the inside target end is left to the browser (no outside node added)', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = commentOf(root);
    placeCaret(comment.firstChild!, 'text'.length); // inside, at the target end

    const evt = dispatchBeforeInput(root, 'insertText', 'a');
    expect(evt.defaultPrevented).toBe(false);
    // Nothing was inserted outside the comment.
    expect(comment.nextSibling).toBeNull();
  });

  it('marks the comment with the caret-outside attribute while the caret sits after it', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = commentOf(root);
    const sel = window.getSelection()!;

    // Caret just outside (after) the comment -> the marker appears (CSS resets
    // the caret colour to the default there).
    const out = document.createRange();
    out.setStartAfter(comment);
    out.collapse(true);
    sel.removeAllRanges();
    sel.addRange(out);
    document.dispatchEvent(new Event('selectionchange'));
    expect(comment.hasAttribute('data-ahve-caret-outside')).toBe(true);

    // Caret back inside (target end) -> the marker is cleared.
    placeCaret(comment.firstChild!, 'text'.length);
    document.dispatchEvent(new Event('selectionchange'));
    expect(comment.hasAttribute('data-ahve-caret-outside')).toBe(false);
  });

  // Leading edge — mirror of the trailing-edge cases above.

  it('ArrowLeft at the target start steps the caret just before the comment', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = commentOf(root);
    placeCaret(comment.firstChild!, 0); // inside, at the target start

    const evt = dispatchKeydown(root, 'ArrowLeft');
    expect(evt.defaultPrevented).toBe(true);

    const p = comment.parentElement!;
    const sel = window.getSelection()!;
    expect(sel.anchorNode).toBe(p);
    expect(sel.anchorOffset).toBe(Array.prototype.indexOf.call(p.childNodes, comment));
  });

  // NOTE: jsdom cannot model the browser's caret normalisation/affinity, so this
  // only verifies the routing logic (caret stays put, intent armed, next char
  // routed inside). The authoritative check is the real-keyboard e2e matrix.
  it('ArrowRight just before a comment arms type-inside: caret stays, marker flips, next char lands at the target start', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = commentOf(root);
    const p = comment.parentElement!;
    const idx = Array.prototype.indexOf.call(p.childNodes, comment);
    placeCaret(p, idx); // just before comment

    const evt = dispatchKeydown(root, 'ArrowRight');
    expect(evt.defaultPrevented).toBe(true);
    // The caret does not move (the inside-start position cannot be represented)...
    const sel = window.getSelection()!;
    expect(sel.anchorNode).toBe(p);
    expect(sel.anchorOffset).toBe(idx);
    // ...but the comment is marked so its parent tints the caret author-colour.
    expect(comment.hasAttribute('data-ahve-caret-inside')).toBe(true);

    // The next typed character lands INSIDE, at the target start.
    const ins = dispatchBeforeInput(root, 'insertText', 'X');
    expect(ins.defaultPrevented).toBe(true);
    expect(comment.firstChild!.textContent).toBe('Xtext'); // prepended inside the target
    expect(comment.previousSibling!.textContent).toBe('Sample '); // text before unchanged
    expect(root.querySelectorAll('comment')).toHaveLength(1);
    expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
  });

  it('insertText just before a comment appends to the preceding text node, outside it', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = commentOf(root);
    const p = comment.parentElement!;
    placeCaret(p, Array.prototype.indexOf.call(p.childNodes, comment)); // just before comment

    const evt = dispatchBeforeInput(root, 'insertText', 'X');
    expect(evt.defaultPrevented).toBe(true);
    // "Sample " grew by the typed char; the comment and its target are untouched.
    expect(comment.previousSibling!.textContent).toBe('Sample X');
    expect(root.querySelectorAll('comment')).toHaveLength(1);
    expect(comment.firstChild!.textContent).toBe('text');
    expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
  });

  it('marks the comment with the caret-outside attribute while the caret sits before it', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = commentOf(root);
    const p = comment.parentElement!;

    placeCaret(p, Array.prototype.indexOf.call(p.childNodes, comment)); // just before comment
    document.dispatchEvent(new Event('selectionchange'));
    expect(comment.hasAttribute('data-ahve-caret-outside')).toBe(true);

    placeCaret(comment.firstChild!, 1); // back inside the target
    document.dispatchEvent(new Event('selectionchange'));
    expect(comment.hasAttribute('data-ahve-caret-outside')).toBe(false);
  });
});
