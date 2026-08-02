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

describe('setupEditor: Enter exits a code block from its trailing empty line', () => {
  function placeCodeCaret(node: Node, offset: number): void {
    const selection = window.getSelection();
    if (!selection) throw new Error('no selection');
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  it('removes the trailing browser line break and inserts a paragraph', () => {
    const root = makeRoot('<pre>const x = 1;<br><br></pre>');
    const onCommandEdit = vi.fn();
    setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
    const pre = root.querySelector('pre')!;
    // Chromium leaves the caret before the final placeholder <br> after Enter.
    placeCodeCaret(pre, 2);

    const evt = dispatchBeforeInput(root, 'insertParagraph');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<pre>const x = 1;</pre><p><br></p>');
    expect(onCommandEdit).toHaveBeenCalledWith('Insert paragraph');
    const selection = window.getSelection()!;
    expect(selection.anchorNode).toBe(root.querySelector('p'));
    expect(selection.anchorOffset).toBe(0);
  });

  it('preserves a <code> wrapper', () => {
    const root = makeRoot('<pre><code>line<br><br></code></pre>');
    setupEditor(root, () => {});
    const code = root.querySelector('code')!;
    placeCodeCaret(code, 2);

    const evt = dispatchBeforeInput(root, 'insertParagraph');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<pre><code>line</code></pre><p><br></p>');
  });

  it('removes an effectively empty code block when exiting', () => {
    const root = makeRoot('<pre><br><br></pre>');
    setupEditor(root, () => {});
    const pre = root.querySelector('pre')!;
    placeCodeCaret(pre, pre.childNodes.length);

    const evt = dispatchBeforeInput(root, 'insertParagraph');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<p><br></p>');
  });

  it('does not exit an empty code block whose only child is a placeholder', () => {
    const root = makeRoot('<pre><br></pre>');
    setupEditor(root, () => {});
    const pre = root.querySelector('pre')!;
    placeCodeCaret(pre, 1);

    const evt = dispatchBeforeInput(root, 'insertParagraph');

    expect(evt.defaultPrevented).toBe(false);
    expect(root.innerHTML).toBe('<pre><br></pre>');
  });

  it('removes an effectively empty code block with a <code> wrapper', () => {
    const root = makeRoot('<pre><code><br><br></code></pre>');
    setupEditor(root, () => {});
    const code = root.querySelector('code')!;
    placeCodeCaret(code, code.childNodes.length);

    const evt = dispatchBeforeInput(root, 'insertParagraph');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<p><br></p>');
  });

  it('preserves direct <pre> text beside an emptied <code> wrapper', () => {
    const root = makeRoot('<pre>abc<code><br><br></code></pre>');
    setupEditor(root, () => {});
    const code = root.querySelector('code')!;
    // Match Chromium's caret before the final placeholder <br>.
    placeCodeCaret(code, 1);

    const evt = dispatchBeforeInput(root, 'insertParagraph');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<pre>abc<code></code></pre><p><br></p>');
  });

  it('keeps an emptied syntax-highlighted code block for wrapper safety', () => {
    const root = makeRoot('<pre><code><span><br><br></span></code></pre>');
    setupEditor(root, () => {});
    const span = root.querySelector('span')!;
    placeCodeCaret(span, span.childNodes.length);

    const evt = dispatchBeforeInput(root, 'insertParagraph');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(
      '<pre><code><span><br></span></code></pre><p><br></p>',
    );
  });

  it('removes a whitespace-only code block after its empty trailing line', () => {
    const root = makeRoot('<pre>\t\t<br><br></pre>');
    setupEditor(root, () => {});
    const pre = root.querySelector('pre')!;
    placeCodeCaret(pre, pre.childNodes.length);

    const evt = dispatchBeforeInput(root, 'insertParagraph');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<p><br></p>');
  });

  it('does not treat a source trailing newline as a user-created empty line', () => {
    const root = makeRoot('<pre>line\n</pre>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('pre')!);

    const evt = dispatchBeforeInput(root, 'insertParagraph');

    expect(evt.defaultPrevented).toBe(false);
    expect(root.innerHTML).toBe('<pre>line\n</pre>');
  });

  for (const {
    name,
    html,
    expected,
  } of [
    {
      name: 'alert',
      html: '<blockquote data-alert="tip"><pre>line<br><br></pre></blockquote>',
      expected: '<blockquote data-alert="tip"><pre>line</pre><p><br></p></blockquote>',
    },
    {
      name: 'table cell',
      html: '<table><tbody><tr><td><pre>line<br><br></pre></td></tr></tbody></table>',
      expected: '<table><tbody><tr><td><pre>line</pre><p><br></p></td></tr></tbody></table>',
    },
  ]) {
    it(`inserts the paragraph beside the code block inside its ${name}`, () => {
      const root = makeRoot(html);
      setupEditor(root, () => {});
      const pre = root.querySelector('pre')!;
      placeCodeCaret(pre, 2);

      dispatchBeforeInput(root, 'insertParagraph');

      expect(root.innerHTML).toBe(expected);
    });
  }

  it('does not exit from a non-empty trailing line', () => {
    const root = makeRoot('<pre>line</pre>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('pre')!);

    const evt = dispatchBeforeInput(root, 'insertParagraph');

    expect(evt.defaultPrevented).toBe(false);
    expect(root.innerHTML).toBe('<pre>line</pre>');
  });

  it('does not exit from an empty line in the middle of the code block', () => {
    const root = makeRoot('<pre>before<br><br>after</pre>');
    setupEditor(root, () => {});
    const pre = root.querySelector('pre')!;
    placeCodeCaret(pre, 2);

    const evt = dispatchBeforeInput(root, 'insertParagraph');

    expect(evt.defaultPrevented).toBe(false);
    expect(root.innerHTML).toBe('<pre>before<br><br>after</pre>');
  });

  it('does not discard later blank lines when the caret is on an earlier one', () => {
    const root = makeRoot('<pre>line<br><br><br></pre>');
    setupEditor(root, () => {});
    const pre = root.querySelector('pre')!;
    placeCodeCaret(pre, 2);

    const evt = dispatchBeforeInput(root, 'insertParagraph');

    expect(evt.defaultPrevented).toBe(false);
    expect(root.innerHTML).toBe('<pre>line<br><br><br></pre>');
  });

  it('does not delete comment metadata after the caret', () => {
    const html =
      '<pre>line<br><comment id="c-12345678">target' +
      '<comment-body contenteditable="false">note</comment-body></comment><br></pre>';
    const root = makeRoot(html);
    setupEditor(root, () => {});
    const pre = root.querySelector('pre')!;
    placeCodeCaret(pre, 2);

    const evt = dispatchBeforeInput(root, 'insertParagraph');

    expect(evt.defaultPrevented).toBe(false);
    expect(root.innerHTML).toBe(html);
  });

  it('exits through nested syntax-highlighting spans', () => {
    const root = makeRoot(
      '<pre><code><span><span>line</span><br><br></span></code></pre>',
    );
    setupEditor(root, () => {});
    const span = root.querySelector('span span')!.parentElement!;
    placeCodeCaret(span, 2);

    const evt = dispatchBeforeInput(root, 'insertParagraph');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(
      '<pre><code><span><span>line</span></span></code></pre><p><br></p>',
    );
  });

  it('leaves Shift+Enter to the browser', () => {
    const root = makeRoot('<pre>line<br><br></pre>');
    setupEditor(root, () => {});
    const pre = root.querySelector('pre')!;
    placeCodeCaret(pre, 2);

    const evt = dispatchBeforeInput(root, 'insertLineBreak');

    expect(evt.defaultPrevented).toBe(false);
    expect(root.innerHTML).toBe('<pre>line<br><br></pre>');
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

  // Inside a comment's target the deletion is clipped to that text node, so it
  // keeps its word/hard-line granularity without the metadata ever being in
  // range. Clipping is only ever a reduction against what the browser would
  // remove, which is what makes it safe — and a hard line IS the block this text
  // node lives in, so the reduction holds. (The soft-line mirror is below.)
  it.each([
    'deleteWordBackward',
    'deleteHardLineBackward',
  ])('%s inside a comment target stays within the target', (inputType) => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    caret(comment.firstChild!, 2);

    const evt = dispatchBeforeInput(root, inputType);

    expect(evt.defaultPrevented).toBe(true);
    expect(comment.firstChild!.textContent).toBe(''); // whole word "di" removed
    expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
    expect(comment.nextSibling!.textContent).toBe('ng'); // never crosses out
  });

  // Regression: a SOFT line is a visual line, and its extent comes from layout
  // this code cannot see. Clipping it to the caret's text node the way the hard
  // line above is clipped would stop being a reduction the moment that node
  // wraps — in a long paragraph it would wipe several visual lines the user
  // never asked for. So the keystroke is consumed and NOTHING is edited, the
  // same trade deleteEntireSoftLine makes. jsdom has no line boxes, so the
  // over-deletion itself is not observable here; what this pins down is that we
  // no longer reproduce the deletion at all.
  it.each([
    'deleteSoftLineBackward',
    'deleteSoftLineForward',
  ])('%s inside a comment target is blocked, not reproduced', (inputType) => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    caret(comment.firstChild!, 1); // "d|i" — a hazard in both directions

    const evt = dispatchBeforeInput(root, inputType);

    expect(evt.defaultPrevented).toBe(true);
    expect(comment.firstChild!.textContent).toBe('di'); // untouched
    expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
    expect(root.innerHTML).toBe(SAMPLE); // nothing at all was edited
  });

  it('deleteWordBackward inside a target removes only the last word', () => {
    const root = makeRoot(
      '<p><comment id="c1">two words<comment-body>note</comment-body></comment>x</p>',
    );
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    caret(comment.firstChild!, 9);

    const evt = dispatchBeforeInput(root, 'deleteWordBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(comment.firstChild!.textContent).toBe('two ');
    expect(comment.querySelector('comment-body')!.textContent).toBe('note');
  });

  it('leaves deleteWordBackward far from an adjacent comment to the browser', () => {
    const root = makeRoot(
      '<p>See <comment id="c1">this<comment-body>note</comment-body></comment>' +
        ' for a longer explanation</p>',
    );
    setupEditor(root, () => {});
    const text = root.querySelector('comment')!.nextSibling!;
    caret(text, text.textContent!.length);

    const evt = dispatchBeforeInput(root, 'deleteWordBackward');

    expect(evt.defaultPrevented).toBe(false);
    expect(text.textContent).toBe(' for a longer explanation');
  });

  // Regression: Chromium treats "Hea" + <comment>di</comment> + "ng" as ONE
  // word, so an unguarded Ctrl+Backspace anywhere in "ng" deletes the whole run
  // — comment element and contenteditable=false body included. There is no word
  // boundary between the caret and the comment, so we must handle it ourselves.
  it.each([1, 2])(
    'handles deleteWordBackward at offset %i of the text right after a comment',
    (offset) => {
      const root = makeRoot(SAMPLE);
      setupEditor(root, () => {});
      const comment = root.querySelector('comment')!;
      const ng = comment.nextSibling as Text;
      caret(ng, offset);

      const evt = dispatchBeforeInput(root, 'deleteWordBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelectorAll('comment')).toHaveLength(1);
      expect(comment.firstChild!.textContent).toBe('di');
      expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
      expect(ng.data).toBe('ng'.slice(offset));
    },
  );

  // The same hazard one inline wrapper out: bolding "ng" leaves the caret's
  // text node without a comment sibling at all, yet Chromium still reads
  // "Hea"+"di"+"ng" as one word and cuts through the comment. The danger zone
  // therefore has to be resolved through inline wrappers, not by siblings.
  it.each([1, 2])(
    'handles deleteWordBackward at offset %i of wrapped text right after a comment',
    (offset) => {
      const root = makeRoot(
        '<h2>Hea<comment id="c1">di<comment-body>Comment</comment-body></comment>' +
          '<strong>ng</strong></h2>',
      );
      setupEditor(root, () => {});
      const comment = root.querySelector('comment')!;
      const ng = root.querySelector('strong')!.firstChild as Text;
      caret(ng, offset);

      const evt = dispatchBeforeInput(root, 'deleteWordBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelectorAll('comment')).toHaveLength(1);
      expect(comment.firstChild!.textContent).toBe('di');
      expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
      expect(ng.data).toBe('ng'.slice(offset));
    },
  );

  // A caret at an element boundary (what selectNodeContents + collapse and a
  // click at the edge of a styled run both produce) resolves onto the adjacent
  // text node, so the word guard has to reach it there too.
  it('handles deleteWordBackward from an element-level caret after a comment', () => {
    const root = makeRoot(
      '<h2>Hea<comment id="c1">di<comment-body>Comment</comment-body></comment>' +
        '<strong>ng</strong></h2>',
    );
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    const strong = root.querySelector('strong')!;
    caretAtEnd(strong);

    const evt = dispatchBeforeInput(root, 'deleteWordBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(strong.textContent).toBe('');
    expect(comment.firstChild!.textContent).toBe('di');
    expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
  });

  it('handles deleteWordForward from an element-level caret before a comment', () => {
    const root = makeRoot(
      '<h2><em>Hea</em><comment id="c1">di<comment-body>Comment</comment-body>' +
        '</comment>ng</h2>',
    );
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    const em = root.querySelector('em')!;
    caretAtStart(em);

    const evt = dispatchBeforeInput(root, 'deleteWordForward');

    expect(evt.defaultPrevented).toBe(true);
    expect(em.textContent).toBe('');
    expect(comment.firstChild!.textContent).toBe('di');
    expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
  });

  // The mirror of the two cases above: the caret sits at the wrapper's INNER
  // edge, so the wrapper's own child list has nothing beside it and the comment
  // is only reachable by stepping OUT of the wrapper. Measured on a native
  // probe, an unguarded Ctrl+Backspace here leaves `<p><strong>ng</strong></p>`
  // — "Hea", the <comment> and its contenteditable=false body all gone.
  //
  // Once the caret resolves through the wrapper it lands on the same path as
  // the unwrapped `Hea<comment>di</comment>|ng`: the caret is OUTSIDE the
  // comment, so the keystroke shrinks the target by exactly one visible
  // character whatever the granularity, rather than swallowing a whole word of
  // annotated text. Wrapping the neighbouring text must not change that.
  it.each(['text', 'element'])(
    'handles deleteWordBackward from a %s caret at the inner start of a wrapper',
    (level) => {
      const root = makeRoot(
        '<h2>Hea<comment id="c1">di<comment-body>Comment</comment-body></comment>' +
          '<strong>ng</strong></h2>',
      );
      setupEditor(root, () => {});
      const comment = root.querySelector('comment')!;
      const strong = root.querySelector('strong')!;
      if (level === 'text') caret(strong.firstChild as Text, 0);
      else caretAtStart(strong);

      const evt = dispatchBeforeInput(root, 'deleteWordBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelectorAll('comment')).toHaveLength(1);
      expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
      expect(comment.firstChild!.textContent).toBe('d'); // one visible char only
      expect(strong.textContent).toBe('ng'); // deletion travels away from "ng"
    },
  );

  it.each(['text', 'element'])(
    'handles deleteWordForward from a %s caret at the inner end of a wrapper',
    (level) => {
      const root = makeRoot(
        '<h2><em>Hea</em><comment id="c1">di<comment-body>Comment</comment-body>' +
          '</comment>ng</h2>',
      );
      setupEditor(root, () => {});
      const comment = root.querySelector('comment')!;
      const em = root.querySelector('em')!;
      if (level === 'text') caret(em.firstChild as Text, 3);
      else caretAtEnd(em);

      const evt = dispatchBeforeInput(root, 'deleteWordForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelectorAll('comment')).toHaveLength(1);
      expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
      expect(comment.firstChild!.textContent).toBe('i'); // one visible char only
      expect(em.textContent).toBe('Hea'); // deletion travels away from "Hea"
    },
  );

  // The wrapped result must match the unwrapped one exactly — that equality is
  // the property the guard is for, and it is what a native probe shows the
  // browser default breaking.
  it('gives a wrapped caret the same outcome as the unwrapped equivalent', () => {
    const run = (html: string, select: (root: HTMLElement) => void): string => {
      const root = makeRoot(html);
      setupEditor(root, () => {});
      select(root);
      dispatchBeforeInput(root, 'deleteWordBackward');
      return root.querySelector('comment')!.firstChild!.textContent!;
    };

    const plain = run(
      '<h2>Hea<comment id="c1">di<comment-body>Comment</comment-body></comment>ng</h2>',
      (root) => caret(root.querySelector('comment')!.nextSibling as Text, 0),
    );
    const wrapped = run(
      '<h2>Hea<comment id="c1">di<comment-body>Comment</comment-body></comment>' +
        '<strong>ng</strong></h2>',
      (root) => caret(root.querySelector('strong')!.firstChild as Text, 0),
    );

    expect(wrapped).toBe(plain);
  });

  // Documents opened from disk (and pasted HTML) carry inline tags this editor's
  // own toolbar never emits — paste-sanitize keeps them and copy.ts preserves
  // them explicitly. Chromium reads through every one of them, so the wrapper
  // set must not be limited to the toolbar's own formats.
  //
  // renderer.ts sanitizes with a DENY list (FORBIDDEN_TAGS), so the set of
  // inline tags that can reach the editor is open-ended: <font> and <abbr> are
  // never produced here, <font> is named explicitly by paste-sanitize's
  // UNWRAPPABLE_IF_BARE (and survives whenever it still carries an attribute),
  // and neither appears in any toolbar format list. An allow list of known
  // wrappers silently hands these back to Chromium, which eats the comment.
  it.each(['u', 'mark', 'sup', 'del', 'b', 'font', 'abbr', 'q', 'cite', 'kbd', 'ins'])(
    'handles deleteWordBackward through an imported <%s> wrapper',
    (tag) => {
      const root = makeRoot(
        `<h2>Hea<comment id="c1">di<comment-body>Comment</comment-body></comment><${tag}>ng</${tag}></h2>`,
      );
      setupEditor(root, () => {});
      const comment = root.querySelector('comment')!;
      const ng = root.querySelector(tag)!.firstChild as Text;
      caret(ng, 1);

      const evt = dispatchBeforeInput(root, 'deleteWordBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelectorAll('comment')).toHaveLength(1);
      expect(comment.firstChild!.textContent).toBe('di');
      expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
      expect(ng.data).toBe('g');
    },
  );

  // The other side of the deny list: it must keep everything a deletion really
  // does stop at. A replaced element renders, so it ends the word the same way
  // a character does and the comment beyond it is out of reach — treating it
  // as a transparent wrapper would take deletions away from the browser for no
  // reason.
  it.each(['img', 'br'])(
    'leaves deleteWordBackward stopped by a <%s> to the browser',
    (tag) => {
      const root = makeRoot(
        '<p><comment id="c1">x<comment-body>note</comment-body></comment>' +
          `<${tag}>ng</p>`,
      );
      setupEditor(root, () => {});
      const ng = root.querySelector('p')!.lastChild as Text;
      caret(ng, 1);

      const evt = dispatchBeforeInput(root, 'deleteWordBackward');

      expect(evt.defaultPrevented).toBe(false);
      expect(ng.data).toBe('ng');
    },
  );

  // Stepping out of a wrapper must stop at the block: a caret at the start of a
  // block has no inline predecessor, and reaching into the previous block would
  // let a deletion act across a boundary the merge handlers own.
  it('does not step out of the block when resolving a caret at block start', () => {
    const root = makeRoot(
      '<p><comment id="c1">x<comment-body>note</comment-body></comment></p>' +
        '<p><strong>second</strong></p>',
    );
    setupEditor(root, () => {});
    const strong = root.querySelectorAll('p')[1].querySelector('strong')!;
    caret(strong.firstChild as Text, 0);

    const evt = dispatchBeforeInput(root, 'deleteWordBackward');

    // The block-merge handler owns this position, not the comment guard: the
    // blocks are joined and the comment travels along by reference, intact.
    expect(evt.defaultPrevented).toBe(true);
    expect(root.querySelectorAll(':scope > p')).toHaveLength(1);
    expect(root.querySelector('comment-body')!.textContent).toBe('note');
    expect(root.querySelector('strong')!.textContent).toBe('second');
  });

  // Widening the danger zone must not swallow deletions the browser performs
  // safely: a word boundary inside the wrapped text still stops the native
  // range short of the comment.
  it('leaves a wrapped deleteWordBackward with a word boundary to the browser', () => {
    const root = makeRoot(
      '<p><comment id="c1">x<comment-body>note</comment-body></comment>' +
        '<strong> for a longer explanation</strong></p>',
    );
    setupEditor(root, () => {});
    const text = root.querySelector('strong')!.firstChild as Text;
    caret(text, text.data.length);

    const evt = dispatchBeforeInput(root, 'deleteWordBackward');

    expect(evt.defaultPrevented).toBe(false);
    expect(text.data).toBe(' for a longer explanation');
  });

  // Regression: the wrapper may sit BETWEEN the caret and the comment, not only
  // around the caret. "Hea" + "di" + "n" + "g" is still one word to Chromium, so
  // stopping the search at the first non-comment sibling handed the keystroke
  // back to the browser and lost the body.
  it('handles deleteWordBackward when a wrapper separates the caret from the comment', () => {
    const root = makeRoot(
      '<h2>Hea<comment id="c1">di<comment-body>Comment</comment-body></comment>' +
        '<strong>n</strong>g</h2>',
    );
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    const g = root.querySelector('h2')!.lastChild as Text;
    caret(g, 1);

    const evt = dispatchBeforeInput(root, 'deleteWordBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.querySelectorAll('comment')).toHaveLength(1);
    expect(comment.firstChild!.textContent).toBe('di');
    expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
    expect(g.data).toBe('');
  });

  // Deleting the last character inside a <strong> leaves the wrapper behind as
  // an empty shell, and handleFormattedEnter deliberately builds the same shape.
  // Such a shell paints nothing, so Chromium's deletion reads straight past it
  // to the comment — the caret resolution has to do the same, or the keystroke
  // falls through to the browser default that destroys the annotation.
  describe('an empty inline wrapper is not a barrier', () => {
    it('handles Backspace when an empty wrapper separates the caret from the comment', () => {
      const root = makeRoot(
        '<p><comment id="c1">ab<comment-body>Comment</comment-body></comment>' +
          '<strong></strong>c</p>',
      );
      setupEditor(root, () => {});
      const comment = root.querySelector('comment')!;
      caret(root.querySelector('p')!.lastChild!, 0);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelectorAll('comment')).toHaveLength(1);
      expect(comment.firstChild!.textContent).toBe('a');
      expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
    });

    it('handles deleteWordBackward when an empty wrapper separates the caret from the comment', () => {
      const root = makeRoot(
        '<p><comment id="c1">ab<comment-body>Comment</comment-body></comment>' +
          '<strong></strong>c</p>',
      );
      setupEditor(root, () => {});
      const comment = root.querySelector('comment')!;
      caret(root.querySelector('p')!.lastChild!, 0);

      const evt = dispatchBeforeInput(root, 'deleteWordBackward');

      expect(evt.defaultPrevented).toBe(true);
      // One character at a time even at word granularity: the caret is outside
      // the comment, so a keystroke must not swallow the whole annotated word.
      expect(comment.firstChild!.textContent).toBe('a');
      expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
    });

    it('handles deleteWordForward when an empty wrapper separates the caret from the comment', () => {
      const root = makeRoot(
        '<p>c<strong></strong><comment id="c1">ab' +
          '<comment-body>Comment</comment-body></comment></p>',
      );
      setupEditor(root, () => {});
      const comment = root.querySelector('comment')!;
      caret(root.querySelector('p')!.firstChild!, 1);

      const evt = dispatchBeforeInput(root, 'deleteWordForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(comment.firstChild!.textContent).toBe('b');
      expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
    });

    it('reads through a nested empty wrapper chain', () => {
      const root = makeRoot(
        '<p><comment id="c1">ab<comment-body>Comment</comment-body></comment>' +
          '<strong><em></em></strong>c</p>',
      );
      setupEditor(root, () => {});
      const comment = root.querySelector('comment')!;
      caret(root.querySelector('p')!.lastChild!, 0);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(comment.firstChild!.textContent).toBe('a');
      expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
    });

    // A wrapper that still holds text is a barrier, and the character before the
    // caret is that text — not the comment's target.
    it('still stops at a wrapper that holds text', () => {
      const root = makeRoot(
        '<p><comment id="c1">ab<comment-body>Comment</comment-body></comment>' +
          '<strong>x</strong>c</p>',
      );
      setupEditor(root, () => {});
      const comment = root.querySelector('comment')!;
      caret(root.querySelector('p')!.lastChild!, 0);

      dispatchBeforeInput(root, 'deleteContentBackward');

      expect(comment.firstChild!.textContent).toBe('ab');
      expect(root.querySelector('strong')!.textContent).toBe('');
    });

    // Editing leaves zero-length text nodes behind too, and they paint nothing
    // for exactly the same reason. Built by hand: a parser never emits one.
    it('reads through an empty text node beside the comment', () => {
      const root = makeRoot(
        '<p><comment id="c1">ab<comment-body>Comment</comment-body></comment>c</p>',
      );
      setupEditor(root, () => {});
      const paragraph = root.querySelector('p')!;
      const comment = root.querySelector('comment')!;
      const tail = paragraph.lastChild!;
      paragraph.insertBefore(document.createTextNode(''), tail);
      caret(tail, 0);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(comment.firstChild!.textContent).toBe('a');
      expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
    });

    // The empty wrapper may also be the comment's own emptied target, with the
    // caret left in the empty text node beside it. Reported as "the node the
    // caret faces", the wrapper owns no comment and the keystroke goes to the
    // browser default — with the caret pressed against the contenteditable=false
    // metadata. Skipping it reaches the emptied-from-inside handler instead, so
    // the annotation is dropped rather than left invisible and unremovable
    // (serialize.ts deliberately never prunes an empty comment).
    it('drops a comment emptied down to a wrapper beside the caret', () => {
      const root = makeRoot(
        '<p>x<comment id="c1"><em></em><comment-body>Comment</comment-body></comment>y</p>',
      );
      setupEditor(root, () => {});
      const comment = root.querySelector('comment')!;
      const emptied = document.createTextNode('');
      comment.insertBefore(emptied, comment.querySelector('comment-body'));
      caret(emptied, 0);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelectorAll('comment')).toHaveLength(0);
      expect(root.querySelector('p')!.textContent).toBe('xy');
    });
  });

  it('handles deleteWordForward when a wrapper separates the caret from the comment', () => {
    const root = makeRoot(
      '<h2>H<em>ea</em><comment id="c1">di<comment-body>Comment</comment-body>' +
        '</comment>ng</h2>',
    );
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    const h = root.querySelector('h2')!.firstChild as Text;
    caret(h, 0);

    const evt = dispatchBeforeInput(root, 'deleteWordForward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.querySelectorAll('comment')).toHaveLength(1);
    expect(comment.firstChild!.textContent).toBe('di');
    expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
    expect(h.data).toBe('');
  });

  // Reaching through wrappers must still stop at a real word boundary: the
  // whitespace in " and " ends the native deletion well before the comment.
  it('leaves a wrapper-separated deleteWordBackward with a word boundary to the browser', () => {
    const root = makeRoot(
      '<p><comment id="c1">x<comment-body>note</comment-body></comment>' +
        ' and <strong>more</strong></p>',
    );
    setupEditor(root, () => {});
    const text = root.querySelector('strong')!.firstChild as Text;
    caret(text, text.data.length);

    const evt = dispatchBeforeInput(root, 'deleteWordBackward');

    expect(evt.defaultPrevented).toBe(false);
    expect(text.data).toBe('more');
  });

  // A line deletion spans the whole line, so a comment sitting in that line is
  // always inside the native range however far away it is.
  it('deleteHardLineBackward next to a comment is clipped to the caret text node', () => {
    const root = makeRoot(
      '<p>See <comment id="c1">this<comment-body>note</comment-body></comment>' +
        ' for a longer explanation</p>',
    );
    setupEditor(root, () => {});
    const text = root.querySelector('comment')!.nextSibling as Text;
    caret(text, text.data.length);

    const evt = dispatchBeforeInput(root, 'deleteHardLineBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(text.data).toBe('');
    expect(root.querySelector('comment-body')!.textContent).toBe('note');
  });

  // The soft-line mirror: this is exactly the text node that would wrap across
  // several visual lines in a real editor, so clipping it would delete far more
  // than the keystroke asked for. Blocked instead.
  it('deleteSoftLineBackward next to a comment leaves the text alone', () => {
    const root = makeRoot(
      '<p>See <comment id="c1">this<comment-body>note</comment-body></comment>' +
        ' for a longer explanation</p>',
    );
    setupEditor(root, () => {});
    const text = root.querySelector('comment')!.nextSibling as Text;
    caret(text, text.data.length);

    const evt = dispatchBeforeInput(root, 'deleteSoftLineBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(text.data).toBe(' for a longer explanation');
    expect(root.querySelector('comment-body')!.textContent).toBe('note');
  });

  // The block-level rule, not a text-node one: a comment anywhere in the
  // caret's block puts it in reach of a line deletion, so the caret need not be
  // beside it. Far from any comment the browser still owns the keystroke —
  // covered by the last case here.
  it.each([
    'deleteSoftLineBackward',
    'deleteSoftLineForward',
  ])('%s is blocked anywhere in a block that carries a comment', (inputType) => {
    const root = makeRoot(
      '<p>plain words here<comment id="c1">x<comment-body>note</comment-body></comment></p>',
    );
    setupEditor(root, () => {});
    const text = root.querySelector('p')!.firstChild as Text;
    caret(text, 6); // "plain |words here" — a word boundary away from the comment

    const evt = dispatchBeforeInput(root, inputType);

    expect(evt.defaultPrevented).toBe(true);
    expect(text.data).toBe('plain words here');
  });

  it.each([
    'deleteSoftLineBackward',
    'deleteSoftLineForward',
  ])('%s in a comment-free block is left to the browser', (inputType) => {
    const root = makeRoot(
      '<p>no annotation here</p>' +
        '<p><comment id="c1">x<comment-body>note</comment-body></comment></p>',
    );
    setupEditor(root, () => {});
    const text = root.querySelector('p')!.firstChild as Text;
    caret(text, 5);

    const evt = dispatchBeforeInput(root, inputType);

    expect(evt.defaultPrevented).toBe(false);
    expect(text.data).toBe('no annotation here');
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

  it.each([
    'deleteWordForward',
    'deleteHardLineForward',
  ])('%s at a comment boundary deletes one visible character safely', (inputType) => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    const hea = root.querySelector('h2')!.firstChild!;
    caret(hea, hea.textContent!.length);

    const evt = dispatchBeforeInput(root, inputType);

    expect(evt.defaultPrevented).toBe(true);
    expect(comment.firstChild!.textContent).toBe('i');
    expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
  });

  it('leaves deleteWordForward far from an adjacent comment to the browser', () => {
    const root = makeRoot(
      '<p>explanation before <comment id="c1">this' +
        '<comment-body>note</comment-body></comment></p>',
    );
    setupEditor(root, () => {});
    const text = root.querySelector('p')!.firstChild!;
    caret(text, 0);

    const evt = dispatchBeforeInput(root, 'deleteWordForward');

    expect(evt.defaultPrevented).toBe(false);
    expect(text.textContent).toBe('explanation before ');
  });

  // Mirror of the backward regression: no word boundary between the caret and
  // the comment ahead of it, so the native range would swallow the metadata.
  it('handles deleteWordForward in text pinned against the comment ahead', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    const hea = root.querySelector('h2')!.firstChild as Text;
    caret(hea, 0);

    const evt = dispatchBeforeInput(root, 'deleteWordForward');

    expect(evt.defaultPrevented).toBe(true);
    expect(hea.data).toBe(''); // "Hea" removed, nothing beyond it
    expect(comment.firstChild!.textContent).toBe('di');
    expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
  });

  // Wrapped mirror: italicising "Hea" hides the comment behind an <em>, and the
  // forward word deletion would run through it into the metadata.
  it('handles deleteWordForward in wrapped text pinned against the comment ahead', () => {
    const root = makeRoot(
      '<h2><em>Hea</em><comment id="c1">di<comment-body>Comment</comment-body>' +
        '</comment>ng</h2>',
    );
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    const hea = root.querySelector('em')!.firstChild as Text;
    caret(hea, 0);

    const evt = dispatchBeforeInput(root, 'deleteWordForward');

    expect(evt.defaultPrevented).toBe(true);
    expect(hea.data).toBe(''); // "Hea" removed, nothing beyond it
    expect(comment.firstChild!.textContent).toBe('di');
    expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
  });

  // The caret at offset 0 renders at the same spot as the comment's trailing
  // edge, so the browser resolves its range on the comment's side even though
  // the deletion travels away from it.
  it('handles deleteWordForward at offset 0 of the text right after a comment', () => {
    const root = makeRoot(SAMPLE);
    setupEditor(root, () => {});
    const comment = root.querySelector('comment')!;
    const ng = comment.nextSibling as Text;
    caret(ng, 0);

    const evt = dispatchBeforeInput(root, 'deleteWordForward');

    expect(evt.defaultPrevented).toBe(true);
    expect(ng.data).toBe('');
    expect(comment.querySelector('comment-body')!.textContent).toBe('Comment');
  });

  it('deleteHardLineForward next to a comment is clipped to the caret text node', () => {
    const root = makeRoot(
      '<p>explanation before <comment id="c1">this' +
        '<comment-body>note</comment-body></comment></p>',
    );
    setupEditor(root, () => {});
    const text = root.querySelector('p')!.firstChild as Text;
    caret(text, 0);

    const evt = dispatchBeforeInput(root, 'deleteHardLineForward');

    expect(evt.defaultPrevented).toBe(true);
    expect(text.data).toBe('');
    expect(root.querySelector('comment-body')!.textContent).toBe('note');
  });

  /** Mirror of the backward soft-line case: blocked rather than clipped. */
  it('deleteSoftLineForward next to a comment leaves the text alone', () => {
    const root = makeRoot(
      '<p>explanation before <comment id="c1">this' +
        '<comment-body>note</comment-body></comment></p>',
    );
    setupEditor(root, () => {});
    const text = root.querySelector('p')!.firstChild as Text;
    caret(text, 0);

    const evt = dispatchBeforeInput(root, 'deleteSoftLineForward');

    expect(evt.defaultPrevented).toBe(true);
    expect(text.data).toBe('explanation before ');
    expect(root.querySelector('comment-body')!.textContent).toBe('note');
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

  // The mirror of "a wrapper sits between the caret and the comment": here the
  // wrapper is AROUND the comment, so the text the deletion reaches is outside
  // it. Commenting the tail of a bold run produces exactly this — inline-format
  // segments at comment boundaries, so <strong> ends up holding the <comment> —
  // which makes it reachable from the toolbar, not only from imported HTML. A
  // lookup that only walks the comment's own sibling list answers "nothing
  // after it" and hands the keystroke to the browser default, pressed against
  // the display:none, contenteditable=false metadata.
  describe('a comment at an inline wrapper edge', () => {
    const NOTE =
      '<comment id="c1">ng<comment-body contenteditable="false">note</comment-body></comment>';

    it('Delete at the target end of a wrapped comment removes the text after the wrapper', () => {
      const root = makeRoot(`<p><strong>Hea${NOTE}</strong> more</p>`);
      setupEditor(root, () => {});
      const target = root.querySelector('comment')!.firstChild as Text;
      caret(target, target.data.length);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelector('p')!.lastChild!.textContent).toBe('more');
      expect(root.querySelector('comment-body')!.textContent).toBe('note');
      expect(target.data).toBe('ng');
    });

    it('Delete at the trailing edge of a wrapped comment removes the text after the wrapper', () => {
      const root = makeRoot(`<p><strong>Hea${NOTE}</strong> more</p>`);
      setupEditor(root, () => {});
      const comment = root.querySelector('comment')!;
      caret(comment, comment.childNodes.length);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelector('p')!.lastChild!.textContent).toBe('more');
      expect(root.querySelector('comment-body')!.textContent).toBe('note');
    });

    it('reads out through a nested wrapper chain', () => {
      const root = makeRoot(`<p><em><strong>Hea${NOTE}</strong></em>tail</p>`);
      setupEditor(root, () => {});
      const target = root.querySelector('comment')!.firstChild as Text;
      caret(target, target.data.length);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelector('p')!.lastChild!.textContent).toBe('ail');
      expect(root.querySelector('comment-body')!.textContent).toBe('note');
    });

    // The climb stops at the block. Text in the NEXT block is not the character
    // this keystroke removes — that is a block merge the merge handlers own —
    // so the lookup must return null here rather than reaching across and
    // deleting a character out of the following paragraph.
    it('does not reach into the next block for the character to delete', () => {
      const root = makeRoot(`<p><strong>Hea${NOTE}</strong></p><p>tail</p>`);
      setupEditor(root, () => {});
      const target = root.querySelector('comment')!.firstChild as Text;
      caret(target, target.data.length);

      dispatchBeforeInput(root, 'deleteContentForward');

      expect(root.querySelectorAll('p')[1].textContent).toBe('tail');
      expect(root.querySelector('comment-body')!.textContent).toBe('note');
    });

    // The backward mirror already worked (facingLeaf descends into the
    // wrapper); it is asserted here so a change to one direction cannot quietly
    // regress the other.
    it('Backspace after the wrapper shrinks the wrapped comment target', () => {
      const root = makeRoot(`<p><strong>Hea${NOTE}</strong>tail</p>`);
      setupEditor(root, () => {});
      caret(root.querySelector('p')!.lastChild!, 0);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelector('comment')!.firstChild!.textContent).toBe('n');
      expect(root.querySelector('comment-body')!.textContent).toBe('note');
    });
  });

  // The other way out of the caret's block. Above, the lookup runs off the END
  // of the block and a merge handler may still own the keystroke; here a BLOCK
  // sits in the comment's own container, so the caret's line ends at it while
  // the container goes on. Reading through it deletes a character out of a
  // paragraph the caret was never in, and declining hands the keystroke to the
  // browser default with the caret pressed against the contenteditable=false
  // metadata — so the keystroke is consumed instead, and (like the structural
  // guards) records no edit.
  //
  // Every shape below is a <comment> with a block sibling. renderer.ts installs
  // body content verbatim, so a .html file from disk carries these straight
  // into the view.
  describe('a comment whose own container holds a block', () => {
    const NOTE =
      '<comment id="c1">note' +
      '<comment-body contenteditable="false">body</comment-body></comment>';

    it.each([
      ['at the root', `${NOTE}<p>tail</p>`, ':scope > p'],
      ['in a quote', `<blockquote>${NOTE}<p>tail</p></blockquote>`, 'blockquote > p'],
      ['in a div', `<div>${NOTE}<p>tail</p></div>`, 'div > p'],
      ['before a list', `<div>${NOTE}<ul><li>tail</li></ul></div>`, 'li'],
    ])('Delete at the target end %s consumes the key and leaves the next block alone',
      (_name, html, tailSelector) => {
        const root = makeRoot(html);
        const onCommandEdit = vi.fn();
        setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
        const target = root.querySelector('comment')!.firstChild as Text;
        caret(target, target.data.length);

        const evt = dispatchBeforeInput(root, 'deleteContentForward');

        expect(evt.defaultPrevented).toBe(true);
        expect(root.innerHTML).toBe(html);
        expect(root.querySelector(tailSelector)!.textContent).toBe('tail');
        expect(onCommandEdit).not.toHaveBeenCalled();
      });

    // The same position reached from the comment's trailing edge (past the
    // display:none metadata), which resolves the spot through the other
    // visibleTextBeyondComment call site.
    it('Delete at the trailing edge consumes the key too', () => {
      const html = `<blockquote>${NOTE}<p>tail</p></blockquote>`;
      const root = makeRoot(html);
      const onCommandEdit = vi.fn();
      setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
      const comment = root.querySelector('comment')!;
      caret(comment, comment.childNodes.length);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
      expect(onCommandEdit).not.toHaveBeenCalled();
    });

    // The leading-edge mirror. The block sits BEFORE the comment in the same
    // container, so the caret's line begins at the comment while the container
    // goes on. The inline-flow walk stops at the <comment> and never sees the
    // comment's own siblings, the enclosing container is not at its own start,
    // and a <comment> is not a block any merge handler will take — so every
    // guard used to decline and the keystroke reached the browser default with
    // the annotation inside its range.
    it.each([
      ['at the root', `<p>tail</p>${NOTE}`, ':scope > p'],
      ['in a quote', `<blockquote><p>tail</p>${NOTE}</blockquote>`, 'blockquote > p'],
      ['in a div', `<div><p>tail</p>${NOTE}</div>`, 'div > p'],
      ['after a list', `<div><ul><li>tail</li></ul>${NOTE}</div>`, 'li'],
    ])('Backspace at the target start %s consumes the key and leaves the previous block alone',
      (_name, html, tailSelector) => {
        const root = makeRoot(html);
        const onCommandEdit = vi.fn();
        setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
        const target = root.querySelector('comment')!.firstChild as Text;
        caret(target, 0);

        const evt = dispatchBeforeInput(root, 'deleteContentBackward');

        expect(evt.defaultPrevented).toBe(true);
        expect(root.innerHTML).toBe(html);
        expect(root.querySelector(tailSelector)!.textContent).toBe('tail');
        expect(onCommandEdit).not.toHaveBeenCalled();
      });

    // Word granularity reaches further than a character, so the leading-edge
    // guard must no more depend on it than its trailing-edge twin does.
    it.each([
      'deleteWordBackward',
      'deleteHardLineBackward',
    ])('%s at the target start is consumed too', (inputType) => {
      const html = `<blockquote><p>a long tail</p>${NOTE}</blockquote>`;
      const root = makeRoot(html);
      setupEditor(root, () => {});
      const target = root.querySelector('comment')!.firstChild as Text;
      caret(target, 0);

      const evt = dispatchBeforeInput(root, inputType);

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
    });

    // The same leading edge reached through an inline wrapper: the walk has to
    // climb out of the <em> before the sibling block comes into view.
    it('Backspace at a target start inside an inline wrapper is consumed too', () => {
      const html = `<blockquote><p>tail</p><em>${NOTE}</em></blockquote>`;
      const root = makeRoot(html);
      setupEditor(root, () => {});
      const target = root.querySelector('comment')!.firstChild as Text;
      caret(target, 0);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
    });

    // An element-level caret at the comment's own offset 0 renders at the same
    // spot and has to answer the same way; it is where ArrowLeft and a click on
    // the comment's left edge can both leave the caret.
    it('Backspace at an element-level caret inside the comment is consumed too', () => {
      const html = `<blockquote><p>tail</p>${NOTE}</blockquote>`;
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtStart(root.querySelector('comment')!);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
    });

    // Non-regression for the leading edge: with ordinary inline text before the
    // comment the browser default is safe (the e2e sweep measures every such
    // position), so the keystroke must still be handed back. Consuming it here
    // would make Backspace do nothing in the commonest shape there is.
    it('declines when visible text precedes the comment inline', () => {
      const html = `<p>Hea${NOTE}ng</p>`;
      const root = makeRoot(html);
      setupEditor(root, () => {});
      const target = root.querySelector('comment')!.firstChild as Text;
      caret(target, 0);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(false);
      expect(root.innerHTML).toBe(html);
    });

    // The other exit must NOT be consumed either: when the comment simply
    // begins its own block, the keystroke is a block-boundary deletion the
    // merge handler owns and performs safely by moving nodes.
    it('leaves a comment at the start of its own block to the block merge', () => {
      const root = makeRoot(`<p>tail</p><p>${NOTE}x</p>`);
      const onCommandEdit = vi.fn();
      setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
      const target = root.querySelector('comment')!.firstChild as Text;
      caret(target, 0);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(`<p>tail${NOTE}x</p>`);
      expect(root.querySelector('comment-body')!.textContent).toBe('body');
      expect(onCommandEdit).toHaveBeenCalledWith('Delete content');
    });

    // The other exit must NOT be consumed: when the block simply ends after the
    // comment, the keystroke is a block-boundary deletion that the rest of the
    // chain owns, so this handler declines exactly as it did before. Consuming
    // it here would take the keystroke away from the merge handlers.
    it('declines instead when the block simply ends after the comment', () => {
      const html = `<p>Hea${NOTE}</p><p>tail</p>`;
      const root = makeRoot(html);
      setupEditor(root, () => {});
      const target = root.querySelector('comment')!.firstChild as Text;
      caret(target, target.data.length);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      expect(evt.defaultPrevented).toBe(false);
      expect(root.innerHTML).toBe(html);
    });

    // A <br> renders no text of its own, so it is stepped over exactly as
    // before: the character after it is still the one this keystroke removes.
    it('still reads through a br to the text after it', () => {
      const root = makeRoot(`<p>Hea${NOTE}<br>tail</p>`);
      setupEditor(root, () => {});
      const target = root.querySelector('comment')!.firstChild as Text;
      caret(target, target.data.length);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelector('p')!.lastChild!.textContent).toBe('ail');
      expect(root.querySelector('comment-body')!.textContent).toBe('body');
    });

    // A following <comment> is the one non-wrapper still worth descending into:
    // its target text really is the next visible character.
    it('still deletes into a following comment target', () => {
      const second =
        '<comment id="c2">xy<comment-body contenteditable="false">two</comment-body></comment>';
      const root = makeRoot(`<p>Hea${NOTE}${second}</p>`);
      setupEditor(root, () => {});
      const target = root.querySelector('comment')!.firstChild as Text;
      caret(target, target.data.length);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelector('#c2')!.firstChild!.textContent).toBe('y');
      expect(root.querySelectorAll('comment-body')).toHaveLength(2);
    });
  });

  // Foreign content is where an uppercase deny list silently fails: tagName is
  // only uppercased for HTML-namespace elements, so <svg> reports 'svg' (and
  // its children 'text'/'title'/'desc'). Read as an inline wrapper, the scan
  // walks INTO the graphic, finds the comment on the far side of it, and then
  // deletes a character out of the SVG's own text — content the user never put
  // a caret in and cannot see change. renderer.ts keeps <svg> (its deny list is
  // script/iframe/style/…), so an imported .html carries this shape straight in.
  describe('an inline <svg> stops the deletion scan', () => {
    const NOTE = '<comment id="c1">x<comment-body>note</comment-body></comment>';
    const GRAPHIC = '<svg><text>abc</text></svg>';

    it.each([
      'deleteContentBackward',
      'deleteWordBackward',
    ])('%s after an svg separating the caret from a comment is left alone', (inputType) => {
      const root = makeRoot(`<p>${NOTE}${GRAPHIC}d</p>`);
      setupEditor(root, () => {});
      caret(root.querySelector('p')!.lastChild!, 0); // "|d"

      const evt = dispatchBeforeInput(root, inputType);

      expect(evt.defaultPrevented).toBe(false);
      expect(root.querySelector('svg')!.textContent).toBe('abc');
      expect(root.querySelector('comment-body')!.textContent).toBe('note');
    });

    it.each([
      'deleteContentForward',
      'deleteWordForward',
    ])('%s before an svg separating the caret from a comment is left alone', (inputType) => {
      const root = makeRoot(`<p>d${GRAPHIC}${NOTE}</p>`);
      setupEditor(root, () => {});
      caret(root.querySelector('p')!.firstChild!, 1); // "d|"

      const evt = dispatchBeforeInput(root, inputType);

      expect(evt.defaultPrevented).toBe(false);
      expect(root.querySelector('svg')!.textContent).toBe('abc');
      expect(root.querySelector('comment-body')!.textContent).toBe('note');
    });

    // The guard must not overshoot: a caret inside the graphic's own text is
    // still the browser's business, and must not reach out to the comment.
    it('leaves a deletion inside the svg text to the browser', () => {
      const root = makeRoot(`<p>${NOTE}${GRAPHIC}d</p>`);
      setupEditor(root, () => {});
      caret(root.querySelector('svg')!.firstChild!.firstChild!, 2); // "ab|c"

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(false);
      expect(root.querySelector('svg')!.textContent).toBe('abc');
    });
  });

  // Regression: character deletion removes a fixed amount, and deleteData counts
  // UTF-16 code units. Taking exactly 1 splits an emoji into a lone surrogate,
  // which is then serialized and saved; a code-point rule instead splits a
  // combining sequence or a ZWJ emoji. Every shape below is inside the comment
  // danger zone, so the browser default never gets to do it correctly for us.
  describe('character deletion keeps grapheme clusters whole', () => {
    const WAVE = '\u{1F44B}'; // U+1F44B, a surrogate pair in UTF-16

    it('Backspace removes a whole emoji next to a comment', () => {
      const root = makeRoot(
        `<p>Hi ${WAVE}<comment id="c1">x<comment-body>note</comment-body></comment></p>`,
      );
      setupEditor(root, () => {});
      const text = root.querySelector('p')!.firstChild as Text;
      caret(text, text.data.length);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(text.data).toBe('Hi ');
      expect(root.querySelector('comment-body')!.textContent).toBe('note');
    });

    // The wrapper is what makes this reachable at all: before the inline-flow
    // scan, a <strong> hid the comment and the browser handled the keystroke.
    it('Backspace removes a whole emoji when a wrapper separates it from the comment', () => {
      const root = makeRoot(
        `<p><strong>Hi ${WAVE}</strong>` +
          '<comment id="c1">x<comment-body>note</comment-body></comment></p>',
      );
      setupEditor(root, () => {});
      const text = root.querySelector('strong')!.firstChild as Text;
      caret(text, text.data.length);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(text.data).toBe('Hi ');
    });

    it('Delete removes a whole emoji next to a comment', () => {
      const root = makeRoot(
        `<p><comment id="c1">x<comment-body>note</comment-body></comment>${WAVE} hi</p>`,
      );
      setupEditor(root, () => {});
      const text = root.querySelector('comment')!.nextSibling as Text;
      caret(text, 0);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(text.data).toBe(' hi');
      expect(root.querySelector('comment-body')!.textContent).toBe('note');
    });

    // The fixed-length paths that shrink a comment's target from outside it run
    // through the same clamp.
    it('Backspace from outside removes a whole emoji at the target end', () => {
      const root = makeRoot(
        `<p>a<comment id="c1">t${WAVE}<comment-body>note</comment-body></comment>b</p>`,
      );
      setupEditor(root, () => {});
      const after = root.querySelector('comment')!.nextSibling as Text;
      caret(after, 0);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelector('comment')!.firstChild!.textContent).toBe('t');
    });

    it('Delete from outside removes a whole emoji at the target start', () => {
      const root = makeRoot(
        `<p>a<comment id="c1">${WAVE}t<comment-body>note</comment-body></comment>b</p>`,
      );
      setupEditor(root, () => {});
      const before = root.querySelector('p')!.firstChild as Text;
      caret(before, 1);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelector('comment')!.firstChild!.textContent).toBe('t');
    });

    it('still removes one plain character at a time', () => {
      const root = makeRoot(
        '<p>Hi<comment id="c1">x<comment-body>note</comment-body></comment></p>',
      );
      setupEditor(root, () => {});
      const text = root.querySelector('p')!.firstChild as Text;
      caret(text, 2);

      dispatchBeforeInput(root, 'deleteContentBackward');

      expect(text.data).toBe('H');
    });

    // A code-point rule is not enough either: these render as ONE character
    // each, and the browser's own Backspace removes the whole cluster. Taking
    // it apart leaves a dangling accent or a joiner the user never typed.
    // Written with explicit escapes: a combining mark and a joiner are
    // invisible in an editor, and a source file that silently normalised them
    // away would turn these into single code points and pass for free.
    const ACUTE_E = '\u0065\u0301'; // 'e' + COMBINING ACUTE ACCENT
    const ACCENTED = `caf${ACUTE_E}`;
    const FAMILY = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}'; // ZWJ sequence

    it('Backspace removes a whole combining sequence next to a comment', () => {
      const root = makeRoot(
        `<p>${ACCENTED}<comment id="c1">x<comment-body>note</comment-body></comment></p>`,
      );
      setupEditor(root, () => {});
      const text = root.querySelector('p')!.firstChild as Text;
      caret(text, text.data.length);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(text.data).toBe('caf');
      expect(root.querySelector('comment-body')!.textContent).toBe('note');
    });

    it('Delete removes a whole combining sequence next to a comment', () => {
      const root = makeRoot(
        `<p><comment id="c1">x<comment-body>note</comment-body></comment>${ACUTE_E}b</p>`,
      );
      setupEditor(root, () => {});
      const text = root.querySelector('comment')!.nextSibling as Text;
      caret(text, 0);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(text.data).toBe('b');
    });

    it('Backspace removes a whole ZWJ emoji sequence next to a comment', () => {
      const root = makeRoot(
        `<p>Hi ${FAMILY}<comment id="c1">x<comment-body>note</comment-body></comment></p>`,
      );
      setupEditor(root, () => {});
      const text = root.querySelector('p')!.firstChild as Text;
      caret(text, text.data.length);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(text.data).toBe('Hi ');
    });

    it('Delete removes a whole ZWJ emoji sequence next to a comment', () => {
      const root = makeRoot(
        `<p><comment id="c1">x<comment-body>note</comment-body></comment>${FAMILY} hi</p>`,
      );
      setupEditor(root, () => {});
      const text = root.querySelector('comment')!.nextSibling as Text;
      caret(text, 0);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(text.data).toBe(' hi');
    });

    // The fixed-length paths that shrink a comment's target from outside it run
    // through the same clamp, so they get the cluster rule too.
    it('Backspace from outside removes a whole cluster at the target end', () => {
      const root = makeRoot(
        `<p>a<comment id="c1">t${FAMILY}<comment-body>note</comment-body></comment>b</p>`,
      );
      setupEditor(root, () => {});
      caret(root.querySelector('comment')!.nextSibling!, 0);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelector('comment')!.firstChild!.textContent).toBe('t');
    });
  });

  // A word or hard-line deletion inside a comment's target can empty it in a
  // single keystroke, leaving a comment that renders as nothing. The caret then
  // has no inline neighbour to resolve from, so the browser default would run
  // pressed against the contenteditable=false metadata. The next Backspace must
  // remove the comment instead — the same second step the outside-in path takes.
  // (Soft line cannot get here: it is blocked before any edit happens.)
  describe('a comment emptied from the inside', () => {
    function emptyTargetFromInside(root: HTMLElement): void {
      const target = root.querySelector('comment')!.firstChild as Text;
      caret(target, target.data.length);
      dispatchBeforeInput(root, 'deleteHardLineBackward');
      expect(target.data).toBe('');
    }

    it('survives the keystroke that empties it, then goes on the next one', () => {
      const root = makeRoot(
        '<p>a <comment id="c1">xy<comment-body>note</comment-body></comment> b</p>',
      );
      setupEditor(root, () => {});

      emptyTargetFromInside(root);
      // One keystroke never destroys an annotation: the comment is still there.
      expect(root.querySelectorAll('comment')).toHaveLength(1);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelectorAll('comment')).toHaveLength(0);
      expect(root.querySelector('p')!.textContent).toBe('a  b');
    });

    it('is not removed while its target still holds text', () => {
      const root = makeRoot(
        '<p>a <comment id="c1">xy<comment-body>note</comment-body></comment> b</p>',
      );
      setupEditor(root, () => {});
      const target = root.querySelector('comment')!.firstChild as Text;
      caret(target, 0);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(false);
      expect(root.querySelectorAll('comment')).toHaveLength(1);
      expect(target.data).toBe('xy');
    });

    // Forward is the exact mirror. Without it the next Delete eats the
    // character AFTER the comment instead, leaving an element that renders as
    // nothing, cannot be reached again, and is never pruned on serialize
    // (serialize.ts keeps every <comment> on purpose) — so it survives the
    // save as an invisible annotation in the file.
    function emptyTargetForward(root: HTMLElement): void {
      const target = root.querySelector('comment')!.firstChild as Text;
      caret(target, 0);
      dispatchBeforeInput(root, 'deleteHardLineForward');
      expect(target.data).toBe('');
    }

    it('survives the keystroke that empties it forward, then goes on the next one', () => {
      const root = makeRoot(
        '<p>a <comment id="c1">xy<comment-body>note</comment-body></comment> b</p>',
      );
      setupEditor(root, () => {});

      emptyTargetForward(root);
      expect(root.querySelectorAll('comment')).toHaveLength(1);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelectorAll('comment')).toHaveLength(0);
      // The following text is untouched: the keystroke spent itself on the
      // comment, exactly as the backward mirror spends it.
      expect(root.querySelector('p')!.textContent).toBe('a  b');
    });

    // The dangerous variant: with nothing visible after the comment there is no
    // character to fall back on, so before the mirror existed the keystroke
    // reached the browser default with the caret pressed against the
    // contenteditable=false metadata.
    it('is removed by a forward Delete even with no visible text after it', () => {
      const root = makeRoot(
        '<h2>Hea<comment id="c1">di<comment-body>note</comment-body></comment></h2>',
      );
      setupEditor(root, () => {});

      emptyTargetForward(root);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelectorAll('comment')).toHaveLength(0);
      expect(root.querySelector('h2')!.textContent).toBe('Hea');
    });

    it('is not removed forward while its target still holds text', () => {
      const root = makeRoot(
        '<p>a <comment id="c1">xy<comment-body>note</comment-body></comment> b</p>',
      );
      setupEditor(root, () => {});
      const comment = root.querySelector('comment')!;
      caret(comment.firstChild as Text, 2); // target end, still holding "xy"

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      // The trailing-edge rule still applies: skip the metadata, eat the first
      // visible character after the comment.
      expect(evt.defaultPrevented).toBe(true);
      expect(root.querySelectorAll('comment')).toHaveLength(1);
      expect(comment.firstChild!.textContent).toBe('xy');
      expect(root.querySelector('p')!.lastChild!.textContent).toBe('b');
    });
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

  it('safely merges comment blocks for deleteWordBackward at a block boundary', () => {
    const root = makeRoot(
      '<p>a<comment id="c1">t<comment-body>note</comment-body></comment></p>' +
        '<p>second</p>',
    );
    setupEditor(root, () => {});
    caretAtStart(root.querySelectorAll('p')[1]);

    const evt = dispatchBeforeInput(root, 'deleteWordBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.querySelectorAll(':scope > p')).toHaveLength(1);
    expect(root.querySelector('comment-body')!.textContent).toBe('note');
    expect(root.querySelector('p')!.textContent).toBe('atnotesecond');
  });

  it('safely merges comment blocks for deleteWordForward at a block boundary', () => {
    const root = makeRoot(
      '<p>first</p><p><comment id="c1">t' +
        '<comment-body>note</comment-body></comment>b</p>',
    );
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'deleteWordForward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.querySelectorAll(':scope > p')).toHaveLength(1);
    expect(root.querySelector('comment-body')!.textContent).toBe('note');
    expect(root.querySelector('p')!.textContent).toBe('firsttnoteb');
  });

  // Word/line deletion at a block edge takes the same safe merge as character
  // deletion. Chromium deletes no word there — it only performs the destructive
  // default merge — so there is no native granularity to preserve, and a comment
  // anywhere in either block would lose its metadata if we handed it back.
  it('safely merges for deleteWordBackward when the comment is away from the join', () => {
    const root = makeRoot(
      '<p>Note <comment id="c1">x<comment-body>b</comment-body></comment>' +
        ' and a long tail of words</p><p>second</p>',
    );
    setupEditor(root, () => {});
    caretAtStart(root.querySelectorAll('p')[1]);

    const evt = dispatchBeforeInput(root, 'deleteWordBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.querySelectorAll(':scope > p')).toHaveLength(1);
    expect(root.querySelector('comment')!.getAttribute('id')).toBe('c1');
    expect(root.querySelector('comment-body')!.textContent).toBe('b');
  });

  it('safely merges for deleteWordForward when the comment is away from the join', () => {
    const root = makeRoot(
      '<p>first</p><p>words before <comment id="c1">x' +
        '<comment-body>b</comment-body></comment> and a long tail</p>',
    );
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'deleteWordForward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.querySelectorAll(':scope > p')).toHaveLength(1);
    expect(root.querySelector('comment')!.getAttribute('id')).toBe('c1');
    expect(root.querySelector('comment-body')!.textContent).toBe('b');
  });

  // The safe merge above needs BOTH sides to be mergeable leaf blocks. A list,
  // a table, or a quote holding nested blocks is neither, so the keystroke used
  // to fall through to Chromium — whose word range crosses the block boundary
  // and strips the contenteditable=false <comment-body> it finds there. These
  // pin down that such a join is blocked instead of handed over.
  describe('a block join the safe merge cannot take over', () => {
    const listNeighbour =
      '<ul><li>Note <comment id="c1">x<comment-body>b</comment-body></comment>' +
      ' and a long tail of words</li></ul>';
    const quoteNeighbour =
      '<blockquote><p><comment id="c1">x<comment-body>b</comment-body></comment>' +
      ' quoted words</p></blockquote>';

    function expectIntact(root: HTMLElement, html: string, evt: InputEvent): void {
      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
      expect(root.querySelector('comment-body')!.textContent).toBe('b');
    }

    it.each(['deleteWordBackward', 'deleteSoftLineBackward'])(
      '%s blocks a join into a list carrying a comment',
      (inputType) => {
        const html = `${listNeighbour}<p>second</p>`;
        const root = makeRoot(html);
        setupEditor(root, () => {});
        caretAtStart(root.querySelector(':scope > p')!);

        expectIntact(root, html, dispatchBeforeInput(root, inputType));
      },
    );

    it.each(['deleteWordForward', 'deleteSoftLineForward'])(
      '%s blocks a join into a list carrying a comment',
      (inputType) => {
        const html = `<p>first</p>${listNeighbour}`;
        const root = makeRoot(html);
        setupEditor(root, () => {});
        caretAtEnd(root.querySelector(':scope > p')!);

        expectIntact(root, html, dispatchBeforeInput(root, inputType));
      },
    );

    // The caret's OWN block is the one the merge declines here: an <li> is
    // never mergeable, so the climb out of the list is what finds the join.
    it('blocks deleteWordBackward from a first list item into a commented paragraph', () => {
      const html =
        '<p>Note <comment id="c1">x<comment-body>b</comment-body></comment> tail</p>' +
        '<ul><li>item</li></ul>';
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtStart(root.querySelector('li')!);

      expectIntact(root, html, dispatchBeforeInput(root, 'deleteWordBackward'));
    });

    it('blocks deleteWordBackward into a quote whose nested block carries a comment', () => {
      const html = `${quoteNeighbour}<p>second</p>`;
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtStart(root.querySelector(':scope > p')!);

      expectIntact(root, html, dispatchBeforeInput(root, 'deleteWordBackward'));
    });

    // Character granularity is blocked here too. It was once exempt, on the
    // reasoning that a character deletion only acts on what is immediately
    // beside the caret — but that stops being true at a block boundary, where
    // the browser resolves its range from layout and reaches the metadata in the
    // next block. Measured: plain Delete at this join strips the comment's body
    // (tests/e2e/comment-delete-sweep.spec.ts, "Delete at a join with a
    // commented list keeps the comment").
    it('blocks deleteContentBackward at the same join', () => {
      const html = `${listNeighbour}<p>second</p>`;
      const root = makeRoot(html);
      const onCommandEdit = vi.fn();
      setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
      caretAtStart(root.querySelector(':scope > p')!);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
      expect(onCommandEdit).not.toHaveBeenCalled();
    });

    // The mirror that keeps the guard from over-blocking: no comment in the
    // neighbour means no reason to withhold the native word deletion.
    it('leaves deleteWordBackward before a comment-free list to the browser', () => {
      const html = '<ul><li>a long tail of words</li></ul><p>second</p>';
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtStart(root.querySelector(':scope > p')!);

      const evt = dispatchBeforeInput(root, 'deleteWordBackward');

      expect(evt.defaultPrevented).toBe(false);
      expect(root.innerHTML).toBe(html);
    });

    it('leaves deleteWordBackward in mid-block text to the browser', () => {
      const html = `${listNeighbour}<p>second words</p>`;
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtEnd(root.querySelector(':scope > p')!);

      const evt = dispatchBeforeInput(root, 'deleteWordBackward');

      expect(evt.defaultPrevented).toBe(false);
      expect(root.innerHTML).toBe(html);
    });

    // The same joins, with the caret in a bare inline run instead of a block.
    // renderer.ts installs body content verbatim, so a .html file from disk can
    // put text straight beside a list — and then there is no block ancestor for
    // the edge test to ask about, which made this guard answer "no join here"
    // and hand the keystroke to the browser. The structural guard grew a bare-
    // run reading for exactly this shape (see the "bare inline runs have no
    // block to ask" describe below); these are its comment-side mirror.
    describe('the join a bare inline run faces', () => {
      it('blocks deleteWordForward from bare root text into a commented list', () => {
        const html = `text${listNeighbour}`;
        const root = makeRoot(html);
        setupEditor(root, () => {});
        caretAtEnd(root.firstChild!);

        expectIntact(root, html, dispatchBeforeInput(root, 'deleteWordForward'));
      });

      it('blocks deleteWordBackward from bare root text after a commented list', () => {
        const html = `${listNeighbour}text`;
        const root = makeRoot(html);
        setupEditor(root, () => {});
        caretAtStart(root.lastChild!);

        expectIntact(root, html, dispatchBeforeInput(root, 'deleteWordBackward'));
      });

      // The block ancestor exists here but reaches straight past the list: the
      // <div> IS the container, so its own start sits before the <ul> and the
      // block-level test reports "not at a boundary" while the run sits
      // directly against it.
      it('blocks deleteWordBackward from a bare run beside a commented list in a div', () => {
        const html = `<div>${listNeighbour}text</div>`;
        const root = makeRoot(html);
        setupEditor(root, () => {});
        caretAtStart(root.querySelector('div')!.lastChild!);

        expectIntact(root, html, dispatchBeforeInput(root, 'deleteWordBackward'));
      });

      // Hard line rather than soft: a soft-line deletion in a bare run never
      // reaches this guard at all, because commentInCaretBlock() has no block
      // to scan and blocks the keystroke on the whole root first.
      it('blocks deleteHardLineForward from bare root text into a commented list', () => {
        const html = `text${listNeighbour}`;
        const root = makeRoot(html);
        setupEditor(root, () => {});
        caretAtEnd(root.firstChild!);

        expectIntact(root, html, dispatchBeforeInput(root, 'deleteHardLineForward'));
      });

      // Character granularity keeps its native behavior at a bare-run join too:
      // it only ever acts on what is immediately beside the caret, which the
      // comment handlers already own.
      // Character granularity gets the same treatment as the block-level join
      // above: no granularity is exempt once the deletion faces a boundary.
      it('blocks deleteContentForward at the same bare-run join', () => {
        const html = `text${listNeighbour}`;
        const root = makeRoot(html);
        const onCommandEdit = vi.fn();
        setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
        caretAtEnd(root.firstChild!);

        const evt = dispatchBeforeInput(root, 'deleteContentForward');

        expect(evt.defaultPrevented).toBe(true);
        expect(root.innerHTML).toBe(html);
        expect(onCommandEdit).not.toHaveBeenCalled();
      });

      it('leaves a bare run facing a comment-free list to the browser', () => {
        const html = 'text<ul><li>a long tail of words</li></ul>';
        const root = makeRoot(html);
        setupEditor(root, () => {});
        caretAtEnd(root.firstChild!);

        const evt = dispatchBeforeInput(root, 'deleteWordForward');

        expect(evt.defaultPrevented).toBe(false);
        expect(root.innerHTML).toBe(html);
      });

      // Only the run's EDGE faces the join. Mid-run the deletion stays inside
      // the run, so withholding it would cost the user a word for nothing.
      it('leaves a mid-run caret to the browser', () => {
        const html = `some text${listNeighbour}`;
        const root = makeRoot(html);
        setupEditor(root, () => {});
        const text = root.firstChild as Text;
        const range = document.createRange();
        range.setStart(text, 2);
        range.collapse(true);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);

        const evt = dispatchBeforeInput(root, 'deleteWordForward');

        expect(evt.defaultPrevented).toBe(false);
        expect(root.innerHTML).toBe(html);
      });
    });
  });

  it.each([
    'deleteWordBackward',
    'deleteSoftLineBackward',
    'deleteHardLineBackward',
  ])('%s at a comment-free block join takes the safe merge', (inputType) => {
    const root = makeRoot('<p>a long tail of words</p><p>second</p>');
    setupEditor(root, () => {});
    caretAtStart(root.querySelectorAll('p')[1]);

    const evt = dispatchBeforeInput(root, inputType);

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<p>a long tail of wordssecond</p>');
  });

  it.each([
    'deleteWordForward',
    'deleteSoftLineForward',
    'deleteHardLineForward',
  ])('%s at a comment-free block join takes the safe merge', (inputType) => {
    const root = makeRoot('<p>first</p><p>words before a long tail</p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, inputType);

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<p>firstwords before a long tail</p>');
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

describe('setupEditor: protects structural block boundaries', () => {
  const detailsHtml =
    '<p>lead</p><details><summary>Title</summary>' +
    '<p>Hidden body</p></details><p>tail</p>';

  it('prevents Backspace at the start of a summary without recording an edit', () => {
    const root = makeRoot(detailsHtml);
    const onCommandEdit = vi.fn();
    setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
    caretAtStart(root.querySelector('summary')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(detailsHtml);
    expect(onCommandEdit).not.toHaveBeenCalled();
  });

  it('prevents Delete at the end of a summary without recording an edit', () => {
    const root = makeRoot(detailsHtml);
    const onCommandEdit = vi.fn();
    setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
    caretAtEnd(root.querySelector('summary')!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(detailsHtml);
    expect(onCommandEdit).not.toHaveBeenCalled();
  });

  it('prevents Backspace immediately after details without recording an edit', () => {
    const root = makeRoot(detailsHtml);
    const onCommandEdit = vi.fn();
    setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
    caretAtStart(root.querySelector(':scope > p:last-child')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(detailsHtml);
    expect(onCommandEdit).not.toHaveBeenCalled();
  });

  it('prevents Delete immediately before details without recording an edit', () => {
    const root = makeRoot(detailsHtml);
    const onCommandEdit = vi.fn();
    setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
    caretAtEnd(root.querySelector(':scope > p:first-child')!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(detailsHtml);
    expect(onCommandEdit).not.toHaveBeenCalled();
  });

  it('prevents Delete before details when an HTML comment separates the blocks', () => {
    const html =
      '<p>lead</p><!-- section --><details open=""><summary>Title</summary>' +
      '<p>Hidden body</p></details>';
    const root = makeRoot(html);
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(html);
  });

  it('prevents Backspace after details when an HTML comment separates the blocks', () => {
    const html =
      '<details open=""><summary>Title</summary><p>body</p></details>' +
      '<!-- section --><p>tail</p>';
    const root = makeRoot(html);
    setupEditor(root, () => {});
    caretAtStart(root.querySelector(':scope > p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(html);
  });

  it('prevents Backspace immediately after a pre block', () => {
    const html = '<pre><code>code</code></pre><p>para</p>';
    const root = makeRoot(html);
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(html);
  });

  it('leaves Delete before hr next to pre to the browser', () => {
    const html = '<p>lead</p><hr><pre><code>code</code></pre>';
    const root = makeRoot(html);
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');

    expect(evt.defaultPrevented).toBe(false);
    expect(root.innerHTML).toBe(html);
  });

  it('leaves Backspace after hr next to pre to the browser', () => {
    const html = '<pre><code>code</code></pre><hr><p>tail</p>';
    const root = makeRoot(html);
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(false);
    expect(root.innerHTML).toBe(html);
  });

  it('leaves list-item Backspace inside details to the browser', () => {
    const root = makeRoot(
      '<details open=""><summary>Title</summary>' +
        '<ul><li>a</li><li>b</li></ul></details>',
    );
    setupEditor(root, () => {});
    caretAtStart(root.querySelectorAll('li')[1]);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(false);
  });

  it('leaves nested list-item Backspace inside details to the browser', () => {
    const root = makeRoot(
      '<details open=""><summary>Title</summary>' +
        '<ul><li>a<ul><li>b</li></ul></li></ul></details>',
    );
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('ul ul li')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(false);
  });

  it('protects the first list-item Backspace from crossing into summary', () => {
    const root = makeRoot(
      '<details open=""><summary>Title</summary><ul><li>a</li></ul></details>',
    );
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('li')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(true);
  });

  it('protects Delete at the end of the details body', () => {
    const root = makeRoot(
      '<details open=""><summary>Title</summary><p>body</p></details><p>tail</p>',
    );
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('details > p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');

    expect(evt.defaultPrevented).toBe(true);
  });

  it('protects Delete at the end of a list at the details closing boundary', () => {
    const root = makeRoot(
      '<details open=""><summary>Title</summary><ul><li>a</li></ul></details>' +
        '<p>tail</p>',
    );
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('li')!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');

    expect(evt.defaultPrevented).toBe(true);
  });

  it('removes an empty paragraph after pre and records an edit', () => {
    const root = makeRoot('<pre><code>code</code></pre><p><br></p>');
    const onCommandEdit = vi.fn();
    setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
    caretAtStart(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<pre><code>code</code></pre>');
    expect(onCommandEdit).toHaveBeenCalledWith('Delete content');
  });

  it('Delete at pre end removes an adjacent empty paragraph', () => {
    const root = makeRoot('<pre><code>code</code></pre><p><br></p>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('pre')!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<pre><code>code</code></pre>');
  });

  it('Delete in an empty paragraph before pre removes it and places the caret at code start', () => {
    const root = makeRoot('<p><br></p><pre><code>code</code></pre>');
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');

    const selection = window.getSelection()!;
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<pre><code>code</code></pre>');
    expect(selection.anchorNode).toBe(root.querySelector('code')!.firstChild);
    expect(selection.anchorOffset).toBe(0);
  });

  it('Backspace at pre start removes a preceding empty paragraph and keeps the caret at code start', () => {
    const root = makeRoot('<p><br></p><pre><code>code</code></pre>');
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('code')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    const selection = window.getSelection()!;
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<pre><code>code</code></pre>');
    expect(selection.anchorNode).toBe(root.querySelector('code')!.firstChild);
    expect(selection.anchorOffset).toBe(0);
  });

  it('removes an empty pre placeholder and records an edit', () => {
    const root = makeRoot('<p>lead</p><pre><code><br></code></pre>');
    const onCommandEdit = vi.fn();
    setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
    caretAtEnd(root.querySelector('code')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<p>lead</p>');
    expect(onCommandEdit).toHaveBeenCalledWith('Delete content');
  });

  it.each(['<br>', ''])(
    'keeps a trailing empty pre for forward Delete with code content %j',
    (codeContent) => {
      const html = `<p>lead</p><pre><code>${codeContent}</code></pre>`;
      const root = makeRoot(html);
      const onCommandEdit = vi.fn();
      setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
      caretAtEnd(root.querySelector('code')!);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
      expect(onCommandEdit).not.toHaveBeenCalled();
    },
  );

  // The caret BEFORE the placeholder <br> is the shape Chromium leaves behind
  // when a code block's last character is deleted, and isCaretAtPreEdge counts
  // that <br> as content — so the forward edge test reports "not at a boundary"
  // there. Where the empty-pre drop can still act it does (the tests above and
  // below); where it declines, the placeholder rule has to keep the keystroke
  // away from the default that merges the neighbour INTO the pre.
  it.each([
    ['whose neighbour takes no caret', '<pre><code><br></code></pre><hr>'],
    ['with nothing after it', '<p>lead</p><pre><code><br></code></pre>'],
    ['that is the only details body',
      '<details open=""><summary>Title</summary><pre><code><br></code></pre></details>'],
  ])('consumes forward Delete in an empty pre %s', (_name, html) => {
    const root = makeRoot(html);
    const onCommandEdit = vi.fn();
    setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
    caretAtStart(root.querySelector('code')!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(html);
    expect(onCommandEdit).not.toHaveBeenCalled();
  });

  // The placeholder rule must not swallow the drop itself: with a neighbour the
  // caret can land in, the empty pre still goes and the caret moves on.
  it('still removes an empty pre whose neighbour can hold the caret', () => {
    const root = makeRoot('<pre><code><br></code></pre><p>text</p>');
    const onCommandEdit = vi.fn();
    setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
    caretAtStart(root.querySelector('code')!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');

    const selection = window.getSelection()!;
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<p>text</p>');
    expect(selection.anchorNode).toBe(root.querySelector('p')!.firstChild);
    expect(onCommandEdit).toHaveBeenCalledWith('Delete content');
  });

  it('creates an editable paragraph after a void element when removing an empty pre', () => {
    const root = makeRoot('<hr><pre><code><br></code></pre>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('code')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    const selection = window.getSelection()!;
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<hr><p><br></p>');
    expect(selection.anchorNode).toBe(root.querySelector('p'));
    expect(selection.anchorOffset).toBe(0);
  });

  it('replaces an empty pre in place instead of merging across significant root text', () => {
    const root = makeRoot('<p>lead</p>text<pre><code><br></code></pre>');
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('code')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    const selection = window.getSelection()!;
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<p>lead</p>text<p><br></p>');
    expect(selection.anchorNode).toBe(root.querySelector(':scope > p:last-child'));
    expect(selection.anchorOffset).toBe(0);
  });

  it('does not treat an HTML comment inside pre as an empty placeholder', () => {
    const html = '<pre><code><!-- TODO: fill in --></code></pre>';
    const root = makeRoot(html);
    setupEditor(root, () => {});
    const code = root.querySelector('code')!;
    const range = document.createRange();
    range.setStart(code, code.childNodes.length);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(html);
  });

  it('protects Backspace before code text preceded by an HTML comment', () => {
    const html =
      '<p>lead</p><pre><code><!-- prettier-ignore -->const x = 1;</code></pre>';
    const root = makeRoot(html);
    setupEditor(root, () => {});
    const text = root.querySelector('code')!.lastChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(html);
  });

  it('allows Backspace to delete a leading newline inside pre', () => {
    const root = makeRoot('<pre><code>\nabc</code></pre>');
    setupEditor(root, () => {});
    const text = root.querySelector('code')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 1);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(false);
  });

  it('allows Backspace to delete indentation inside pre', () => {
    const root = makeRoot('<pre><code>  abc</code></pre>');
    setupEditor(root, () => {});
    const text = root.querySelector('code')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 2);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(false);
  });

  it('removes an empty paragraph after details and records an edit', () => {
    const root = makeRoot(
      '<details open=""><summary>Title</summary><p>body</p></details><p><br></p>',
    );
    const onCommandEdit = vi.fn();
    setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
    caretAtStart(root.querySelector(':scope > p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(
      '<details open=""><summary>Title</summary><p>body</p></details>',
    );
    expect(onCommandEdit).toHaveBeenCalledWith('Delete content');
  });

  // A closed details renders only its summary, so the caret must land there
  // rather than in the (display:none) body it would be invisible in.
  it('places the caret in the summary when the details is closed', () => {
    const root = makeRoot(
      '<details><summary>Title</summary><p>body</p></details><p><br></p>',
    );
    setupEditor(root, () => {});
    caretAtStart(root.querySelector(':scope > p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    const selection = window.getSelection()!;
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<details><summary>Title</summary><p>body</p></details>');
    expect(selection.anchorNode).toBe(root.querySelector('summary')!.firstChild);
    expect(selection.anchorOffset).toBe('Title'.length);
  });

  // Resolving only one level would stop at the outer details' body — which is
  // itself a collapsed details — and drop the caret in ITS hidden body. The
  // hand-over rule has to be applied repeatedly, not once.
  it('places the caret in a nested closed details summary, not its hidden body', () => {
    const root = makeRoot(
      '<details open=""><summary>Outer</summary>' +
        '<details><summary>Inner</summary><p>hidden</p></details>' +
        '</details><p><br></p>',
    );
    setupEditor(root, () => {});
    caretAtStart(root.querySelector(':scope > p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    const selection = window.getSelection()!;
    const innerSummary = root.querySelectorAll('summary')[1];
    expect(evt.defaultPrevented).toBe(true);
    expect(selection.anchorNode).toBe(innerSummary.firstChild);
    expect(selection.anchorOffset).toBe('Inner'.length);
  });

  // An open nested details is visible, so the walk keeps descending into it.
  it('places the caret in a nested open details body', () => {
    const root = makeRoot(
      '<details open=""><summary>Outer</summary>' +
        '<details open=""><summary>Inner</summary><p>shown</p></details>' +
        '</details><p><br></p>',
    );
    setupEditor(root, () => {});
    caretAtStart(root.querySelector(':scope > p')!);

    dispatchBeforeInput(root, 'deleteContentBackward');

    const selection = window.getSelection()!;
    expect(selection.anchorNode).toBe(root.querySelector('details details p')!.firstChild);
    expect(selection.anchorOffset).toBe('shown'.length);
  });

  // structuralCaretTarget's descent stops at the first target that is neither
  // <pre> nor <details>, so ONE ordinary container between the body and a
  // nested collapsed details puts the hidden text back within reach of the text
  // walk — which knows nothing about `open`. Same failure as the nested case
  // above, one wrapper out, and the reason the rule is applied at placement.
  it.each([
    ['a div', '<div><details><summary>Inner</summary><p>hidden</p></details></div>'],
    ['a list', '<ul><li><details><summary>Inner</summary><p>hidden</p></details></li></ul>'],
    [
      'a quote',
      '<blockquote><details><summary>Inner</summary><p>hidden</p></details></blockquote>',
    ],
  ])('places the caret in a closed details summary behind %s', (_name, body) => {
    const root = makeRoot(
      `<details open=""><summary>Outer</summary>${body}</details><p><br></p>`,
    );
    setupEditor(root, () => {});
    caretAtStart(root.querySelector(':scope > p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    const selection = window.getSelection()!;
    const innerSummary = root.querySelectorAll('summary')[1];
    expect(evt.defaultPrevented).toBe(true);
    expect(selection.anchorNode).toBe(innerSummary.firstChild);
    expect(selection.anchorOffset).toBe('Inner'.length);
  });

  // The empty-host branch of the same placement. With no text anywhere the
  // choice falls to querySelectorAll, which is flat and so reaches into the
  // collapsed details on its own — the recursion that covers the text walk does
  // nothing here, hence the separate ancestor test.
  it('skips a hidden host when the details body behind a wrapper holds no text', () => {
    const root = makeRoot(
      '<details open=""><summary>Outer</summary>' +
        '<div><details><summary></summary><p><br></p></details></div>' +
        '</details><p><br></p>',
    );
    setupEditor(root, () => {});
    caretAtStart(root.querySelector(':scope > p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    const selection = window.getSelection()!;
    const innerSummary = root.querySelectorAll('summary')[1];
    expect(evt.defaultPrevented).toBe(true);
    expect(innerSummary.contains(selection.anchorNode)).toBe(true);
  });

  // A details body need not be wrapped in a block: renderer.ts installs body
  // content verbatim, so a .html file from disk can put bare text straight
  // after the </summary>. An element-only lookup cannot see that text, and
  // reading "no element body" as "no body" handed the caret back to the
  // summary — backwards, past content the reader can see, with the next typed
  // character landing in the title.
  it('places the caret at the end of a bare-text details body', () => {
    const root = makeRoot(
      '<details open=""><summary>Title</summary>body</details><p><br></p>',
    );
    setupEditor(root, () => {});
    caretAtStart(root.querySelector(':scope > p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    const selection = window.getSelection()!;
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<details open=""><summary>Title</summary>body</details>');
    expect(selection.anchorNode).toBe(root.querySelector('details')!.lastChild);
    expect(selection.anchorOffset).toBe('body'.length);
  });

  // The mirror: the caret is already in the bare body, and the empty block it
  // drops sits AFTER the details. Same placement, reached through the other
  // branch of handleEmptyBlockAtStructuralBoundary.
  it('keeps the caret in a bare-text details body when Delete drops the block after it', () => {
    const root = makeRoot(
      '<details open=""><summary>Title</summary>body</details><p><br></p>',
    );
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('details')!.lastChild!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');

    const selection = window.getSelection()!;
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<details open=""><summary>Title</summary>body</details>');
    expect(selection.anchorNode).toBe(root.querySelector('details')!.lastChild);
    expect(selection.anchorOffset).toBe('body'.length);
  });

  // Bare text AFTER the last body block is still the visible end of the body,
  // so the element-only lookup was wrong even when an element body exists.
  it('places the caret in the trailing bare text of a mixed details body', () => {
    const root = makeRoot(
      '<details open=""><summary>Title</summary><p>first</p>tail</details><p><br></p>',
    );
    setupEditor(root, () => {});
    caretAtStart(root.querySelector(':scope > p:last-child')!);

    dispatchBeforeInput(root, 'deleteContentBackward');

    const selection = window.getSelection()!;
    expect(selection.anchorNode).toBe(root.querySelector('details')!.lastChild);
    expect(selection.anchorOffset).toBe('tail'.length);
  });

  // A CLOSED details renders only its summary, so the bare body is exactly as
  // invisible as a wrapped one. The new childNodes lookup must not reach it.
  it('still hands over to the summary when a bare-text details body is collapsed', () => {
    const root = makeRoot('<details><summary>Title</summary>body</details><p><br></p>');
    setupEditor(root, () => {});
    caretAtStart(root.querySelector(':scope > p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    const selection = window.getSelection()!;
    expect(evt.defaultPrevented).toBe(true);
    expect(selection.anchorNode).toBe(root.querySelector('summary')!.firstChild);
    expect(selection.anchorOffset).toBe('Title'.length);
  });

  // Whitespace between tags is formatting noise, not a body. Reading it as one
  // would stop the descent at the details and leave the caret before the
  // summary rather than at its end.
  it('ignores whitespace after the summary when choosing the details body', () => {
    const root = makeRoot(
      '<details open=""><summary>Title</summary>\n</details><p><br></p>',
    );
    setupEditor(root, () => {});
    caretAtStart(root.querySelector(':scope > p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    const selection = window.getSelection()!;
    expect(evt.defaultPrevented).toBe(true);
    expect(selection.anchorNode).toBe(root.querySelector('summary')!.firstChild);
    expect(selection.anchorOffset).toBe('Title'.length);
  });

  // The body's last child holds no editable text and is no editable host
  // either, so placement falls back to the summary instead of giving up.
  it('falls back to the summary when the details body ends in a void element', () => {
    const root = makeRoot(
      '<details open=""><summary>Title</summary><hr></details><p><br></p>',
    );
    setupEditor(root, () => {});
    caretAtStart(root.querySelector(':scope > p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    const selection = window.getSelection()!;
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<details open=""><summary>Title</summary><hr></details>');
    expect(root.querySelector('summary')!.contains(selection.anchorNode)).toBe(true);
  });

  // A locked body is a place the caret can be *put* but not typed in, so it is
  // no better a landing spot than the void element above. renderer.ts keeps
  // both the <div> and its contenteditable attribute, so a .html file opened
  // from disk can hold exactly this shape.
  //
  // This case is the reason the lock is read from the ATTRIBUTE: jsdom does not
  // implement the `contentEditable` property (it answers undefined), so a
  // property test would pass this file while doing nothing, and the assertions
  // below would be a false green.
  it('falls back to the summary when the details body is contenteditable=false', () => {
    const html =
      '<details open=""><summary>Title</summary>' +
      '<div contenteditable="false">locked</div></details>';
    const root = makeRoot(`${html}<p><br></p>`);
    setupEditor(root, () => {});
    caretAtStart(root.querySelector(':scope > p:last-child')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    const selection = window.getSelection()!;
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(html);
    expect(root.querySelector('summary')!.contains(selection.anchorNode)).toBe(true);
    // Never inside the locked subtree, where typing would go nowhere.
    expect(root.querySelector('div[contenteditable]')!.contains(selection.anchorNode))
      .toBe(false);
  });

  // The lock is inherited: a block inside a locked container is no more
  // typeable than the container itself, so the descendant scan has to look at
  // each candidate's ancestors and not only at the candidate. Here the only
  // host inside the body is an unlocked <p> under a locked <div>.
  it('falls back to the summary when the only body host sits under a lock', () => {
    const html =
      '<details open=""><summary>Title</summary>' +
      '<div contenteditable="false"><p><br></p></div></details>';
    const root = makeRoot(`${html}<p><br></p>`);
    setupEditor(root, () => {});
    caretAtStart(root.querySelector(':scope > p:last-child')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    const selection = window.getSelection()!;
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(html);
    expect(root.querySelector('summary')!.contains(selection.anchorNode)).toBe(true);
  });

  it('keeps an empty details body when Backspace follows summary', () => {
    const html = '<details open=""><summary>Title</summary><p><br></p></details>';
    const root = makeRoot(html);
    const onCommandEdit = vi.fn();
    setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
    caretAtStart(root.querySelector('details > p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(html);
    expect(onCommandEdit).not.toHaveBeenCalled();
  });

  it('removes an empty paragraph after pre inside details', () => {
    const root = makeRoot(
      '<details open=""><summary>Title</summary>' +
        '<pre><code>code</code></pre><p><br></p></details>',
    );
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('details > p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(
      '<details open=""><summary>Title</summary><pre><code>code</code></pre></details>',
    );
  });

  // The protection climbs out of a container to reach its structural
  // neighbour, so the empty-block drop has to climb too. Without it the
  // keystroke is consumed and nothing happens at all, while the identical bare
  // <p><br></p> in the same position is removed.
  describe('an empty block at the edge of a container', () => {
    it('removes an empty list item and the list it emptied after pre', () => {
      const root = makeRoot('<pre><code>code</code></pre><ul><li><br></li></ul>');
      const onCommandEdit = vi.fn();
      setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
      caretAtStart(root.querySelector('li')!);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      const selection = window.getSelection()!;
      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe('<pre><code>code</code></pre>');
      expect(selection.anchorNode).toBe(root.querySelector('code')!.firstChild);
      expect(selection.anchorOffset).toBe('code'.length);
      expect(onCommandEdit).toHaveBeenCalledWith('Delete content');
    });

    // The unwind stops at the first container that still holds something, so
    // the rest of the list survives the same keystroke.
    it('removes only the empty first item of a list after pre', () => {
      const root = makeRoot(
        '<pre><code>code</code></pre><ul><li><br></li><li>b</li></ul>',
      );
      setupEditor(root, () => {});
      caretAtStart(root.querySelector('li')!);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe('<pre><code>code</code></pre><ul><li>b</li></ul>');
    });

    it('removes an empty quoted paragraph and its blockquote before pre', () => {
      const root = makeRoot(
        '<blockquote><p><br></p></blockquote><pre><code>code</code></pre>',
      );
      setupEditor(root, () => {});
      caretAtStart(root.querySelector('blockquote p')!);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      const selection = window.getSelection()!;
      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe('<pre><code>code</code></pre>');
      expect(selection.anchorNode).toBe(root.querySelector('code')!.firstChild);
      expect(selection.anchorOffset).toBe(0);
    });

    // A container the drop may NOT unwind: removing the empty paragraph would
    // take the cell, the row, and the whole table with it. The drop declines
    // and the keystroke falls back to the structural protection.
    it('leaves a table alone when the empty paragraph is its only cell content', () => {
      const html =
        '<pre><code>code</code></pre>' +
        '<table><tbody><tr><td><p><br></p></td></tr></tbody></table>';
      const root = makeRoot(html);
      const onCommandEdit = vi.fn();
      setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
      caretAtStart(root.querySelector('td > p')!);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
      expect(onCommandEdit).not.toHaveBeenCalled();
    });

    // The climb reaches the summary through the list, so the details-body rule
    // has to reach through it as well: dropping the item would leave the
    // details with no body, exactly as dropping a bare empty <p> there would.
    it('keeps an empty list item that is the whole details body', () => {
      const html =
        '<details open=""><summary>Title</summary><ul><li><br></li></ul></details>';
      const root = makeRoot(html);
      const onCommandEdit = vi.fn();
      setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
      caretAtStart(root.querySelector('li')!);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
      expect(onCommandEdit).not.toHaveBeenCalled();
    });

    // The mirror branch stays sibling-only: the block that would go here sits
    // BEYOND the climb, so unwinding to it would delete a block outside the
    // structure the caret is in — Delete at the end of a bodyless details'
    // summary must not reach the paragraph after the details.
    it('does not reach past a details to drop the empty paragraph after it', () => {
      const html = '<details open=""><summary>Title</summary></details><p><br></p>';
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtEnd(root.querySelector('summary')!);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
    });
  });

  it('does not remove an empty paragraph across significant root text', () => {
    const html = '<pre><code>code</code></pre>text<p><br></p>';
    const root = makeRoot(html);
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(false);
    expect(root.innerHTML).toBe(html);
  });

  it('protects the forward boundary immediately before pre', () => {
    const html = '<p>para</p><pre><code>code</code></pre>';
    const root = makeRoot(html);
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(html);
  });

  it('protects Backspace at the start of pre', () => {
    const html = '<p>para</p><pre><code>code</code></pre>';
    const root = makeRoot(html);
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('pre')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(html);
  });

  it.each([
    'deleteWordBackward',
    'deleteSoftLineBackward',
    'deleteHardLineBackward',
  ])('protects a summary boundary for %s', (inputType) => {
    const root = makeRoot(detailsHtml);
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('summary')!);

    const evt = dispatchBeforeInput(root, inputType);

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(detailsHtml);
  });

  it.each([
    'deleteWordForward',
    'deleteSoftLineForward',
    'deleteHardLineForward',
  ])('protects a details boundary for %s', (inputType) => {
    const root = makeRoot(detailsHtml);
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector(':scope > p:first-child')!);

    const evt = dispatchBeforeInput(root, inputType);

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(detailsHtml);
  });

  // An empty pre may not merge across the summary either: dropping it would
  // leave a details with no body at all. It degrades to an empty paragraph in
  // place, which is the same shape the empty-body case already guarantees.
  it.each([
    ['<pre><code><br></code></pre>', 'code'],
    ['<pre><br></pre>', 'pre'],
  ])(
    'degrades %s to a paragraph when it is the only details body',
    (preHtml, caretSelector) => {
      const root = makeRoot(
        `<details open=""><summary>Title</summary>${preHtml}</details>`,
      );
      const onCommandEdit = vi.fn();
      setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
      caretAtStart(root.querySelector(caretSelector)!);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(
        '<details open=""><summary>Title</summary><p><br></p></details>',
      );
      expect(onCommandEdit).toHaveBeenCalledWith('Delete content');
    },
  );

  it('keeps an empty pre that is the only details body on forward Delete', () => {
    const html =
      '<details open=""><summary>Title</summary><pre><code><br></code></pre></details>';
    const root = makeRoot(html);
    const onCommandEdit = vi.fn();
    setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
    caretAtEnd(root.querySelector('code')!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(html);
    expect(onCommandEdit).not.toHaveBeenCalled();
  });

  // A <br> between blocks is content, not formatting noise: skipping it would
  // stretch the pre's protection over the <br> and make it undeletable from
  // both sides.
  it('leaves Backspace after a br next to pre to the browser', () => {
    const html = '<pre><code>code</code></pre><br><p>tail</p>';
    const root = makeRoot(html);
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(false);
    expect(root.innerHTML).toBe(html);
  });

  it('leaves Delete before a br next to pre to the browser', () => {
    const html = '<p>lead</p><br><pre><code>code</code></pre>';
    const root = makeRoot(html);
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');

    expect(evt.defaultPrevented).toBe(false);
    expect(root.innerHTML).toBe(html);
  });

  // The protection reaches a structural neighbour of the LIST/QUOTE, not only
  // of the caret's own block. Chromium does not break the item out of its
  // container there — it merges it into the pre/details (see the matching
  // native probes in tests/e2e/structural-boundaries.spec.ts).
  it('protects the first list-item Backspace from crossing into a root-level pre', () => {
    const html = '<pre><code>code</code></pre><ul><li>a</li></ul>';
    const root = makeRoot(html);
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('li')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(html);
  });

  it('protects the first quoted paragraph Backspace from crossing into details', () => {
    const html =
      '<details open=""><summary>Title</summary><p>body</p></details>' +
      '<blockquote><p>x</p></blockquote>';
    const root = makeRoot(html);
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('blockquote > p')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(html);
  });

  it('protects the last list-item Delete from crossing into a root-level pre', () => {
    const html = '<ul><li>a</li></ul><pre><code>code</code></pre>';
    const root = makeRoot(html);
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector('li')!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(html);
  });

  // Inline content with no wrapping block. findBlockAncestor answers null under
  // the root, the cell itself in a table, and the CONTAINER inside details —
  // whose own start sits before the summary — so a boundary test that only asks
  // the caret's block walks past all three. Existing HTML puts text there (see
  // findBareRootRun in commands/block-format), and Chromium's merge across the
  // boundary is the same destructive one probed in
  // tests/e2e/structural-boundaries.spec.ts.
  describe('bare inline runs have no block to ask', () => {
    it('protects Backspace in bare root text after pre', () => {
      const html = '<pre><code>code</code></pre>text';
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtStart(root.lastChild!);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
    });

    it('protects Delete in bare root text before details', () => {
      const html = 'text<details open=""><summary>Title</summary><p>body</p></details>';
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtEnd(root.firstChild!);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
    });

    it('protects a bare root run reached through an inline wrapper', () => {
      const html = '<pre><code>code</code></pre><em>text</em>';
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtStart(root.querySelector('em')!);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
    });

    it('leaves Backspace in the middle of bare root text to the browser', () => {
      const html = '<pre><code>code</code></pre>text';
      const root = makeRoot(html);
      setupEditor(root, () => {});
      const text = root.lastChild as Text;
      const range = document.createRange();
      range.setStart(text, 2);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(false);
      expect(root.innerHTML).toBe(html);
    });

    // A <br> stays deletable from either side: skipping it would extend the
    // pre's protection over the rule and leave it stranded.
    it('leaves Backspace in bare root text after a br next to pre to the browser', () => {
      const html = '<pre><code>code</code></pre><br>text';
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtStart(root.lastChild!);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(false);
      expect(root.innerHTML).toBe(html);
    });

    it('leaves bare root text after an ordinary paragraph to the browser', () => {
      const html = '<p>lead</p>text';
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtStart(root.lastChild!);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(false);
      expect(root.innerHTML).toBe(html);
    });

    it('protects a bare details body from merging into its summary', () => {
      const html = '<details open=""><summary>Title</summary>body</details>';
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtStart(root.querySelector('details')!.lastChild!);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
    });

    it('protects Delete at the end of a bare details body', () => {
      const html =
        '<details open=""><summary>Title</summary>body</details><p>tail</p>';
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtEnd(root.querySelector('details')!.lastChild!);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
    });

    it('leaves the middle of a bare details body to the browser', () => {
      const html = '<details open=""><summary>Title</summary>body</details>';
      const root = makeRoot(html);
      setupEditor(root, () => {});
      const text = root.querySelector('details')!.lastChild as Text;
      const range = document.createRange();
      range.setStart(text, 2);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(false);
      expect(root.innerHTML).toBe(html);
    });

    // TD/TH are deliberately not block tags, so a fresh cell's inline content
    // has no block ancestor either.
    it('protects bare cell text after a pre in the same cell', () => {
      const html =
        '<table><tbody><tr><td><pre><code>code</code></pre>text</td></tr></tbody></table>';
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtStart(root.querySelector('td')!.lastChild!);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
    });

    // An ordinary block can host a bare run too, and then it has the very
    // problem the root/cell/details cases have: the block IS the container, so
    // its own start sits before the <pre> and the block-level edge test reports
    // "not at a boundary" while the run sits directly against it. Wrapping the
    // same text in a <p> is protected, so leaving these out made the guard
    // depend on whether the imported file happened to use a paragraph.
    it('protects Backspace in bare text after a pre inside a div', () => {
      const html = '<div><pre><code>code</code></pre>text</div>';
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtStart(root.querySelector('div')!.lastChild!);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
    });

    it('protects Delete in bare text before details inside a blockquote', () => {
      const html =
        '<blockquote>text<details open=""><summary>Title</summary>' +
        '<p>body</p></details></blockquote>';
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtEnd(root.querySelector('blockquote')!.firstChild!);

      const evt = dispatchBeforeInput(root, 'deleteContentForward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
    });

    it('protects Backspace in bare text after a pre inside a list item', () => {
      const html = '<ul><li><pre><code>code</code></pre>text</li></ul>';
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtStart(root.querySelector('li')!.lastChild!);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
    });

    it('leaves bare text after an ordinary paragraph inside a div to the browser', () => {
      const html = '<div><p>lead</p>text</div>';
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtStart(root.querySelector('div')!.lastChild!);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(false);
      expect(root.innerHTML).toBe(html);
    });

    // The bare-run answer is a second, narrower reading of the same keystroke,
    // so it may only ADD protection. Here the run faces a <br> (deliberately
    // significant, never skipped) while the caret's block still faces the pre:
    // if a "no" from the run lookup short-circuited the block test, this
    // keystroke would hand the destructive default straight back.
    it('still protects a block-level boundary the run lookup answers no for', () => {
      const html = '<pre><code>code</code></pre><p><br>text</p>';
      const root = makeRoot(html);
      setupEditor(root, () => {});
      caretAtStart(root.querySelector('p')!.lastChild!);

      const evt = dispatchBeforeInput(root, 'deleteContentBackward');

      expect(evt.defaultPrevented).toBe(true);
      expect(root.innerHTML).toBe(html);
    });

    // An ELEMENT-level caret in the run's host — the caret sitting between the
    // host's children rather than inside a text node. Every case above places a
    // text-node caret, and the run-node lookup cannot resolve this one (asked
    // for the host itself it climbs past it), so without an explicit branch the
    // whole guard is skipped here and the destructive default runs. This is not
    // a hypothetical position: removeAnchorlessComment() parks the caret at
    // exactly `(parent, index)` after dropping an anchorless comment.
    describe('an element-level caret in the host', () => {
      function caretAt(container: Node, offset: number): void {
        const range = document.createRange();
        range.setStart(container, offset);
        range.collapse(true);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      }

      it('protects Backspace at the root offset right after a pre', () => {
        const html = '<pre><code>code</code></pre>text';
        const root = makeRoot(html);
        setupEditor(root, () => {});
        caretAt(root, 1);

        const evt = dispatchBeforeInput(root, 'deleteContentBackward');

        expect(evt.defaultPrevented).toBe(true);
        expect(root.innerHTML).toBe(html);
      });

      it('protects Delete at the root offset right before details', () => {
        const html = 'text<details open=""><summary>Title</summary><p>body</p></details>';
        const root = makeRoot(html);
        setupEditor(root, () => {});
        caretAt(root, 1);

        const evt = dispatchBeforeInput(root, 'deleteContentForward');

        expect(evt.defaultPrevented).toBe(true);
        expect(root.innerHTML).toBe(html);
      });

      it('protects Backspace at the details offset right after its summary', () => {
        const html = '<details open=""><summary>Title</summary>body</details>';
        const root = makeRoot(html);
        setupEditor(root, () => {});
        caretAt(root.querySelector('details')!, 1);

        const evt = dispatchBeforeInput(root, 'deleteContentBackward');

        expect(evt.defaultPrevented).toBe(true);
        expect(root.innerHTML).toBe(html);
      });

      it('protects Backspace at the cell offset right after a pre', () => {
        const html =
          '<table><tbody><tr><td><pre><code>code</code></pre>text</td></tr></tbody></table>';
        const root = makeRoot(html);
        setupEditor(root, () => {});
        caretAt(root.querySelector('td')!, 1);

        const evt = dispatchBeforeInput(root, 'deleteContentBackward');

        expect(evt.defaultPrevented).toBe(true);
        expect(root.innerHTML).toBe(html);
      });

      // The mirror that keeps the new branch from over-blocking: with the text
      // run between the caret and the pre, the deletion never reaches it.
      it('leaves a root offset with text before it to the browser', () => {
        const html = '<pre><code>code</code></pre>text';
        const root = makeRoot(html);
        setupEditor(root, () => {});
        caretAt(root, 2);

        const evt = dispatchBeforeInput(root, 'deleteContentBackward');

        expect(evt.defaultPrevented).toBe(false);
        expect(root.innerHTML).toBe(html);
      });

      it('leaves a root offset after an ordinary paragraph to the browser', () => {
        const html = '<p>lead</p>text';
        const root = makeRoot(html);
        setupEditor(root, () => {});
        caretAt(root, 1);

        const evt = dispatchBeforeInput(root, 'deleteContentBackward');

        expect(evt.defaultPrevented).toBe(false);
        expect(root.innerHTML).toBe(html);
      });
    });
  });

  // An <hr> answers "empty" to isBlockEmptyOrStubBr (no children, no text), so
  // without a block-tag check the empty-block cleanup deleted a visible rule.
  it('keeps an hr before pre instead of dropping it as an empty block', () => {
    const html = '<hr><pre><code>code</code></pre>';
    const root = makeRoot(html);
    const onCommandEdit = vi.fn();
    setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
    caretAtStart(root.querySelector('code')!);

    const evt = dispatchBeforeInput(root, 'deleteContentBackward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(html);
    expect(onCommandEdit).not.toHaveBeenCalled();
  });

  it('keeps an hr after pre instead of dropping it as an empty block', () => {
    const html = '<pre><code>code</code></pre><hr>';
    const root = makeRoot(html);
    const onCommandEdit = vi.fn();
    setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
    caretAtEnd(root.querySelector('code')!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(html);
    expect(onCommandEdit).not.toHaveBeenCalled();
  });

  // Chromium empties a code block down to a bare <pre><br></pre>. The placeholder
  // check must run ahead of the edge test for that shape: isCaretAtPreEdge counts
  // the <br> as content, so an edge-gated handler would defer to the browser,
  // which merges the following block INTO the pre and drops its <code>.
  it('removes a br-only pre on forward Delete and lands on the next block', () => {
    const root = makeRoot('<pre><br></pre><p>text</p>');
    const onCommandEdit = vi.fn();
    setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
    caretAtStart(root.querySelector('pre')!);

    const evt = dispatchBeforeInput(root, 'deleteContentForward');

    const selection = window.getSelection()!;
    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe('<p>text</p>');
    expect(selection.anchorNode).toBe(root.querySelector('p')!.firstChild);
    expect(selection.anchorOffset).toBe(0);
    expect(onCommandEdit).toHaveBeenCalledWith('Delete content');
  });
});

// The end of a comment's target text (inside the comment) and the position just
// after </comment> (outside it) render at the same spot because the
// <comment-body> is display:none. ArrowRight steps the caret outside so the next
// character is typed after the comment; ArrowLeft steps back inside. A dedicated
// insertText handler guarantees outside typing lands after </comment> rather
// than being absorbed back into the comment.
// `deleteEntireSoftLine` removes the whole visual line in one keystroke, in
// both directions at once, so it has no row in DELETE_INPUT_TYPES: reproducing
// it with the backward handlers would delete half of what the user asked for.
// It still has to be consumed where the browser default would destroy an
// annotation or a structure, because an unmapped inputType skips every guard.
// No chord produces it on the platforms the e2e suite runs on (a probe in
// tests/e2e/comment-delete-sweep.spec.ts measures that), so this synthetic
// dispatch is its only coverage.
describe('setupEditor: whole-line deletion', () => {
  const commentHtml =
    '<p>Hea<comment id="c-line001">di' +
    '<comment-body contenteditable="false">note</comment-body></comment>ng</p>';

  it('consumes a whole-line deletion on a line carrying a comment', () => {
    const root = makeRoot(commentHtml);
    const onCommandEdit = vi.fn();
    setupEditor(root, () => {}, undefined, undefined, onCommandEdit);
    caretAtEnd(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'deleteEntireSoftLine');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(commentHtml);
    expect(onCommandEdit).not.toHaveBeenCalled();
  });

  it('consumes a whole-line deletion at a protected structural boundary', () => {
    const html = '<pre><code>code</code></pre><p>para</p>';
    const root = makeRoot(html);
    setupEditor(root, () => {});
    caretAtStart(root.querySelector('p')!);

    const evt = dispatchBeforeInput(root, 'deleteEntireSoftLine');

    expect(evt.defaultPrevented).toBe(true);
    expect(root.innerHTML).toBe(html);
  });

  // Away from both hazards the browser keeps its own line handling, which this
  // code cannot reproduce without the line boxes.
  it('leaves a whole-line deletion on an ordinary line to the browser', () => {
    const html = '<p>first</p><p>a long tail of words</p>';
    const root = makeRoot(html);
    setupEditor(root, () => {});
    caretAtEnd(root.querySelector(':scope > p:last-child')!);

    const evt = dispatchBeforeInput(root, 'deleteEntireSoftLine');

    expect(evt.defaultPrevented).toBe(false);
    expect(root.innerHTML).toBe(html);
  });
});

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
