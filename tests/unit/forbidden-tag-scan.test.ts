import { describe, expect, it } from 'vitest';

import { findForbiddenTag } from '../../webview/document/forbidden-tag-scan';
import { parseInertFragment } from '../../webview/document/inert-fragment';

// Tags that make a document unopenable in the body position. Each one enters the tree as an element.
const FORBIDDEN_TAGS_THAT_REACH_THE_TREE = [
  'script',
  'noscript',
  'iframe',
  'object',
  'embed',
  'link',
  'style',
  'base',
  'meta',
];

function scan(bodyText: string): string | undefined {
  return findForbiddenTag(parseInertFragment(bodyText, document));
}

describe('forbidden tag scanning', () => {
  it.each(FORBIDDEN_TAGS_THAT_REACH_THE_TREE)('finds %s directly under the body', (tagName) => {
    expect(scan(`<p>a</p><${tagName}></${tagName}>`)).toBe(tagName);
  });

  it('finds a forbidden tag nested inside other elements', () => {
    expect(scan('<div><blockquote><p><script></script></p></blockquote></div>')).toBe('script');
  });

  it('finds a forbidden tag inside template content', () => {
    expect(scan('<template><script></script></template>')).toBe('script');
  });

  it('finds a script inside an svg element', () => {
    expect(scan('<p>a</p><svg><script>alert(1)</script></svg>')).toBe('script');
  });

  it('finds SCRIPT written in uppercase', () => {
    expect(scan('<SCRIPT></SCRIPT>')).toBe('script');
  });

  it('returns nothing when a forbidden tag name appears only in text or an HTML comment', () => {
    expect(scan('<p>&lt;script&gt;</p><!-- <script></script> -->')).toBeUndefined();
  });

  it('returns nothing when the body contains only tags absent from the list', () => {
    expect(scan('<section><article><video></video></article></section>')).toBeUndefined();
  });
});
