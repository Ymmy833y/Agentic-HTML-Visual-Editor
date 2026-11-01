// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { COMMENT_POPUP_MIN_WIDTH, parseCommentPopupWidth } from '../../common/index';

describe('reading a comment popup width', () => {
  it('reads a width at or above the narrowest width as it is', () => {
    expect([parseCommentPopupWidth(COMMENT_POPUP_MIN_WIDTH), parseCommentPopupWidth(480)]).toEqual([
      COMMENT_POPUP_MIN_WIDTH,
      480,
    ]);
  });

  it('rounds the width to whole pixels and raises a width below the narrowest width to it', () => {
    expect([
      parseCommentPopupWidth(320.6),
      parseCommentPopupWidth(COMMENT_POPUP_MIN_WIDTH - 1),
      parseCommentPopupWidth(-50),
    ]).toEqual([321, COMMENT_POPUP_MIN_WIDTH, COMMENT_POPUP_MIN_WIDTH]);
  });

  it('rejects a value that is not a finite number', () => {
    expect([
      parseCommentPopupWidth(undefined),
      parseCommentPopupWidth(null),
      parseCommentPopupWidth('320'),
      parseCommentPopupWidth({ width: 320 }),
      parseCommentPopupWidth(Number.NaN),
      parseCommentPopupWidth(Number.POSITIVE_INFINITY),
    ]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });
});
