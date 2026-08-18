import { describe, expect, it } from 'vitest';
import { stripCommentsFromHtml } from '../../webview/features/clipboard/strip-comments';

describe('stripCommentsFromHtml', () => {
  it('drops body/reply and unwraps the comment, keeping target text', () => {
    expect(
      stripCommentsFromHtml(
        '<p>a<comment id="c1" data-resolved="">target<comment-body>b</comment-body>' +
          '<comment-reply>r</comment-reply></comment>z</p>',
      ),
    ).toBe('<p>atargetz</p>');
  });

  it('preserves inline markup inside the comment target', () => {
    expect(
      stripCommentsFromHtml(
        '<comment id="c1"><strong>bold</strong><comment-body>b</comment-body></comment>',
      ),
    ).toBe('<strong>bold</strong>');
  });

  // A partial selection can clone <comment-body>/<comment-reply> without their parent
  // <comment>. Matching by tag name removes those orphans too.
  it('removes orphaned comment-body/comment-reply left by a partial selection', () => {
    expect(
      stripCommentsFromHtml(
        '<p>text<comment-body>b</comment-body><comment-reply>r</comment-reply></p>',
      ),
    ).toBe('<p>text</p>');
  });

  it('strips multiple comments in document order', () => {
    expect(
      stripCommentsFromHtml(
        '<p><comment id="a">one<comment-body>x</comment-body></comment> and ' +
          '<comment id="b">two<comment-body>y</comment-body></comment></p>',
      ),
    ).toBe('<p>one and two</p>');
  });

  it('unwraps nested comments defensively', () => {
    expect(
      stripCommentsFromHtml('<comment id="a">x<comment id="b">y</comment>z</comment>'),
    ).toBe('xyz');
  });

  it('leaves html without comments unchanged', () => {
    expect(stripCommentsFromHtml('<p>plain <strong>text</strong></p>')).toBe(
      '<p>plain <strong>text</strong></p>',
    );
  });
});
