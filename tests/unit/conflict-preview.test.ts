import { describe, expect, it } from 'vitest';

import {
  QUARANTINED_ATTRIBUTE_NAME,
  quarantinedNamespace,
} from '../../webview/document/attribute-sanitizer';
import {
  CONFLICT_SIDE_EMPTY_CLASS,
  CONFLICT_SIDE_RENDERED_CLASS,
  CONFLICT_SIDE_SOURCE_CLASS,
  buildConflictSidePreview,
} from '../../webview/ui/conflict-preview';
import type { ConflictPreviewContext } from '../../webview/ui/conflict-preview';

// Place the document one directory below the resource root, as the image resolver's own cases do.
const CONTEXT: ConflictPreviewContext = {
  documentUri: 'https://example.test/root/docs/page.html',
  resourceRootUri: 'https://example.test/root',
  emptyLabel: '(Empty)',
};

describe('the preview of one side of a conflict region', () => {
  it('renders the lines as a fragment and quarantines an event handler attribute', () => {
    const preview = buildConflictSidePreview(document, ['<p onclick="alert(1)">a</p>', '<p>b</p>'], CONTEXT);
    const paragraph = preview.rendered.querySelector('p');

    expect([
      preview.rendered.className,
      preview.rendered.querySelectorAll('p').length,
      paragraph?.hasAttribute('onclick'),
      paragraph?.getAttributeNS(quarantinedNamespace('onclick'), QUARANTINED_ATTRIBUTE_NAME),
    ]).toEqual([CONFLICT_SIDE_RENDERED_CLASS, 2, false, 'alert(1)']);
  });

  it('quarantines a URL attribute with a dangerous scheme', () => {
    const preview = buildConflictSidePreview(document, ['<p><a href="javascript:alert(1)">a</a></p>'], CONTEXT);
    const anchor = preview.rendered.querySelector('a');

    expect([
      anchor?.hasAttribute('href'),
      anchor?.getAttributeNS(quarantinedNamespace('href'), QUARANTINED_ATTRIBUTE_NAME),
    ]).toEqual([false, 'javascript:alert(1)']);
  });

  it('shows a side with a forbidden tag as HTML text instead of rendering it', () => {
    const lines = ['<p>a</p>', '<script>alert(1)</script>'];

    const preview = buildConflictSidePreview(document, lines, CONTEXT);

    expect([
      preview.rendered.className,
      preview.rendered.querySelector('script'),
      preview.rendered.textContent,
      preview.visibleText,
    ]).toEqual([CONFLICT_SIDE_SOURCE_CLASS, null, lines.join('\n'), '']);
  });

  it('shows the empty label for a side without lines', () => {
    const preview = buildConflictSidePreview(document, [], CONTEXT);

    expect([
      preview.rendered.className,
      preview.rendered.textContent,
      preview.source.textContent,
      preview.hasLines,
    ]).toEqual([CONFLICT_SIDE_EMPTY_CLASS, '(Empty)', '(Empty)', false]);
  });

  it('resolves the src of an image with a relative path by the same rule as the editor root', () => {
    const preview = buildConflictSidePreview(document, ['<p><img src="a.png" alt=""></p>'], CONTEXT);

    expect(preview.rendered.querySelector('img')?.getAttribute('src'))
      .toBe('https://example.test/root/docs/a.png');
  });

  it('keeps an element with contenteditable from becoming editable and from becoming a Tab stop', () => {
    const preview = buildConflictSidePreview(
      document,
      ['<div contenteditable="true">a</div>', '<p><a href="https://example.test/">b</a></p>'],
      CONTEXT,
    );

    expect([
      preview.rendered.querySelector('div')?.hasAttribute('contenteditable'),
      preview.rendered.querySelector('div')?.tabIndex,
      preview.rendered.querySelector('a')?.tabIndex,
    ]).toEqual([false, -1, -1]);
  });
});
