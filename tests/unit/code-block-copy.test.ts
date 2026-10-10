import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLocalizer } from '../../common/index';
import {
  CODE_BLOCK_COPY_ELEMENT_ID,
  attachCodeBlockCopy,
  findCodeBlock,
  readCodeBlockCopyPlacement,
  readCodeBlockText,
  requestCodeBlockCopy,
} from '../../webview/ui/code-block-copy';
import { COPIED_ICON_PATH, COPIED_ICON_TIMEOUT_MS, COPY_ICON_PATH } from '../../webview/ui/copy-button';
import { mountRoot, readElement } from './helpers/format-dom';

// The size of the button in the placement cases.
const BUTTON_SIZE = { width: 24, height: 24 };

// The bottom of the toolbar's strip in the placement cases.
const STRIP_BOTTOM = 40;

/**
 * Mounts the editor root and reads the code text of its first code block.
 *
 * @param html The contents of the editor root.
 * @returns The code text.
 */
function readFirstCodeText(html: string): string | undefined {
  const root = mountRoot(html);
  return readCodeBlockText(readElement(root, 'pre'), root, () => undefined);
}

/** Returns the path the copy button's icon is drawn with. */
function readIconPath(): string | null | undefined {
  return document.getElementById(CODE_BLOCK_COPY_ELEMENT_ID)?.querySelector('svg path')?.getAttribute('d');
}

describe('reading the code text', () => {
  it('keeps the indentation and leaves out the trailing line break that is not displayed', () => {
    expect(readFirstCodeText('<pre><code>a\n  b\n</code></pre>')).toBe('a\n  b');
  });

  it('keeps the annotated text of a comment and leaves out the text of its entries', () => {
    expect(readFirstCodeText('<pre><code>a<comment id="c">b<comment-body>note</comment-body></comment>c</code></pre>'))
      .toBe('abc');
  });

  it('turns each br of a pre without code into a line break', () => {
    expect(readFirstCodeText('<pre>a<br>b</pre>')).toBe('a\nb');
  });

  it('is empty for a code block without contents', () => {
    expect(readFirstCodeText('<pre><code></code></pre>')).toBe('');
  });
});

describe('finding the code block', () => {
  it('returns the pre when pointing at a format element inside its code', () => {
    const root = mountRoot('<pre><code>a<strong>b</strong></code></pre>');

    expect(findCodeBlock(readElement(root, 'strong'), root)).toBe(readElement(root, 'pre'));
  });

  it('returns no code block when pointing inside a pre outside the editor root', () => {
    const root = mountRoot('<p>a</p>');
    const outside = document.createElement('pre');
    outside.innerHTML = '<code>b</code>';
    document.body.append(outside);

    expect(findCodeBlock(readElement(outside, 'code'), root)).toBeUndefined();
  });

  it('returns no code block when pointing at a diagram source block in either form', () => {
    const root = mountRoot('<pre class="mermaid">graph TD</pre><pre><code class="language-mermaid">graph TD</code></pre>');
    const [plain, wrapped] = root.querySelectorAll('pre');

    expect([findCodeBlock(plain, root), findCodeBlock(readElement(wrapped, 'code'), root)]).toEqual([undefined, undefined]);
  });
});

describe('placing the button', () => {
  it('puts it 4px inside the top and right edges of a code block whose top edge is below the strip', () => {
    expect(readCodeBlockCopyPlacement({ top: 100, right: 500, bottom: 300 }, BUTTON_SIZE, STRIP_BOTTOM))
      .toEqual({ left: 472, top: 104 });
  });

  it('puts it 4px below the bottom of the strip for a tall code block whose top edge is hidden under the strip', () => {
    expect(readCodeBlockCopyPlacement({ top: -200, right: 500, bottom: 600 }, BUTTON_SIZE, STRIP_BOTTOM))
      .toEqual({ left: 472, top: 44 });
  });

  it('lines its bottom up 4px above the bottom of a code block whose visible part is shorter than the button', () => {
    expect(readCodeBlockCopyPlacement({ top: -200, right: 500, bottom: 60 }, BUTTON_SIZE, STRIP_BOTTOM))
      .toEqual({ left: 472, top: 32 });
  });
});

describe('sending the code block copy request', () => {
  it('does not rethrow when posting throws, and passes one line to the diagnostic port', () => {
    const diagnostics: string[] = [];
    const channel = {
      post: (): void => {
        throw new Error('cannot send to the host');
      },
    };

    expect(() => requestCodeBlockCopy(channel, 'a', (detail) => diagnostics.push(detail))).not.toThrow();
    expect(diagnostics).toHaveLength(1);
  });
});

describe('showing the check mark on the copy button', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('showing it again while the check mark is shown keeps the mark until 2 seconds after the latest show', () => {
    const root = mountRoot('<pre><code>a</code></pre>');
    const copy = attachCodeBlockCopy(window, root, {
      localizer: createLocalizer({}),
      registerTooltip: () => undefined,
      readAreaTop: () => 0,
      requestCopy: () => undefined,
      reportDiagnostic: () => undefined,
    });
    copy.showCopied();
    vi.advanceTimersByTime(1500);

    copy.showCopied();
    vi.advanceTimersByTime(COPIED_ICON_TIMEOUT_MS - 1);
    const justBefore = readIconPath();
    vi.advanceTimersByTime(1);

    expect([justBefore, readIconPath()]).toEqual([COPIED_ICON_PATH, COPY_ICON_PATH]);
  });
});
