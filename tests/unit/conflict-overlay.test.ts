import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { ConflictSides } from '../../common/index';
import { buildConflictOverlay } from '../../webview/ui/conflict-overlay';

const localizer = createLocalizer({});

const CONTEXT = { documentUri: '', resourceRootUri: '' };

const ignore = (): void => undefined;

/**
 * Builds the overlay for one conflict region and returns whether its HTML toggle starts pressed.
 *
 * @param sides The region's two sides.
 */
function readStartsAsHtml(sides: ConflictSides): string | null | undefined {
  const content = buildConflictOverlay(
    document,
    localizer,
    { presentationId: 1, conflicts: [sides], repeated: false },
    CONTEXT,
    { submit: ignore, cancel: ignore },
  );
  return content.body?.querySelector('.conflict-show-html')?.getAttribute('aria-pressed');
}

describe('how a conflict region starts', () => {
  it('starts with both sides as HTML text when the rendered text of the two sides is the same', () => {
    expect(readStartsAsHtml({
      source: ['<p class="a">same</p>'],
      view: ['<p class="b">same</p>'],
    })).toBe('true');
  });

  it('starts with both sides as HTML text when a side with lines shows no text in the rendering', () => {
    expect(readStartsAsHtml({
      source: ['<body>'],
      view: ['<body>', '<p>text</p>'],
    })).toBe('true');
  });

  it('starts with both sides as HTML text when the two sides differ only in the body of a comment', () => {
    expect(readStartsAsHtml({
      source: ['<p><comment id="c-1">same<comment-body data-author="ai">from the file</comment-body></comment></p>'],
      view: ['<p><comment id="c-1">same<comment-body data-author="ai">from the editor</comment-body></comment></p>'],
    })).toBe('true');
  });

  it('starts rendered when the rendered text of the two sides differs', () => {
    expect(readStartsAsHtml({
      source: ['<p>from the file</p>'],
      view: ['<p>from the editor</p>'],
    })).toBe('false');
  });
});
