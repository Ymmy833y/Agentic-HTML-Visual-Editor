import { afterEach, describe, expect, it } from 'vitest';

import { COMMENT_POPUP_MIN_WIDTH, COMMENT_POPUP_WIDTH_META_NAME } from '../../common/index';
import { clampCommentPopupWidth, readEmbeddedCommentPopupWidth } from '../../webview/ui/comment-popup-resize';

describe('The comment popup width bounds', () => {
  it('keeps a width between the narrowest width and the widest the view allows, rounded to whole pixels', () => {
    expect([
      clampCommentPopupWidth(320.4, 1000),
      clampCommentPopupWidth(COMMENT_POPUP_MIN_WIDTH - 50, 1000),
      clampCommentPopupWidth(1200, 987),
    ]).toEqual([320, COMMENT_POPUP_MIN_WIDTH, 987]);
  });

  it('gives the narrowest width in a view too narrow for both bounds', () => {
    expect(clampCommentPopupWidth(300, 200)).toBe(COMMENT_POPUP_MIN_WIDTH);
  });
});

describe('The embedded comment popup width', () => {
  afterEach(() => {
    document.head.replaceChildren();
  });

  /**
   * Writes the width meta element into the head, as the host does.
   *
   * @param content The content of the meta, or `undefined` to leave it out.
   */
  function embed(content: string | undefined): void {
    document.head.replaceChildren();
    if (content !== undefined) {
      const meta = document.createElement('meta');
      meta.name = COMMENT_POPUP_WIDTH_META_NAME;
      meta.content = content;
      document.head.append(meta);
    }
  }

  it('reads the width', () => {
    embed('360');

    expect(readEmbeddedCommentPopupWidth(document)).toBe(360);
  });

  it('reads no width when the document carries none, or one that is empty or not a number', () => {
    const results: (number | undefined)[] = [];
    for (const content of [undefined, '', '  ', 'wide']) {
      embed(content);
      results.push(readEmbeddedCommentPopupWidth(document));
    }

    expect(results).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('raises a width below the narrowest width to it', () => {
    embed('20');

    expect(readEmbeddedCommentPopupWidth(document)).toBe(COMMENT_POPUP_MIN_WIDTH);
  });
});
