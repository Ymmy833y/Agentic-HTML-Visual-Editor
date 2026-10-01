// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { isRelativeFileHref, trimHref } from '../../common/index';

describe('relative file href detection', () => {
  it('recognizes values that point to files through paths relative to the document', () => {
    const hrefs = ['notes.html', './a/b.html', '../x.md', 'a.html?q#s'];

    expect(hrefs.map((href) => isRelativeFileHref(href))).toEqual([true, true, true, true]);
  });

  it('does not recognize values with a scheme as relative file hrefs', () => {
    const hrefs = ['https://example.com/a.html', 'mailto:someone@example.com', 'javascript:void(0)', 'C:/ws/a.html'];

    expect(hrefs.map((href) => isRelativeFileHref(href))).toEqual([false, false, false, false]);
  });

  it('does not recognize values that navigate within the same document as relative file hrefs', () => {
    const hrefs = ['#sec', '?q=1'];

    expect(hrefs.map((href) => isRelativeFileHref(href))).toEqual([false, false]);
  });

  it('does not recognize root-relative or UNC values as relative file hrefs', () => {
    const hrefs = ['/abs.html', '//host/a', '\\host\\a'];

    expect(hrefs.map((href) => isRelativeFileHref(href))).toEqual([false, false, false]);
  });

  it('recognizes values with colons that do not form a scheme as relative file hrefs', () => {
    const hrefs = ['a/b:c.html', './a:b'];

    expect(hrefs.map((href) => isRelativeFileHref(href))).toEqual([true, true]);
  });

  it('does not recognize empty or whitespace-only values as relative file hrefs', () => {
    const hrefs = ['', '   ', '\n\t'];

    expect(hrefs.map((href) => isRelativeFileHref(href))).toEqual([false, false, false]);
  });

  it('returns the same result for values with leading and trailing whitespace or newlines', () => {
    const hrefs = ['notes.html', './a/b.html', 'https://example.com/a.html', '#sec', '/abs.html'];

    expect(hrefs.map((href) => isRelativeFileHref(`\n  ${href}\t `)))
      .toEqual(hrefs.map((href) => isRelativeFileHref(href)));
  });
});

describe('href trimming', () => {
  it('removes leading and trailing whitespace and is idempotent', () => {
    const once = trimHref(' \n\t notes.html \t\n ');

    expect([once, trimHref(once)]).toEqual(['notes.html', 'notes.html']);
  });
});
