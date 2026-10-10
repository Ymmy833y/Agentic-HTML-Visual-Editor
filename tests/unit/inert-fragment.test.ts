import { describe, expect, it } from 'vitest';

import { parseInertFragment } from '../../webview/document/inert-fragment';

describe('parsing body text as an inert fragment', () => {
  it('keeps leading meta, link, and style elements directly under the fragment', () => {
    const fragment = parseInertFragment(
      '<meta name="a" content="b"><link rel="stylesheet" href="a.css"><style>p{color:red}</style><p>a</p>',
      document,
    );

    expect([...fragment.children].map((child) => child.tagName.toLowerCase()))
      .toEqual(['meta', 'link', 'style', 'p']);
  });

  it('returns a fragment without children for empty text', () => {
    expect(parseInertFragment('', document).childNodes.length).toBe(0);
  });

  it('returns a fragment without throwing when body text has missing closing tags', () => {
    expect(parseInertFragment('<div><p>a', document).children.length).toBe(1);
  });

  it('does not include a frameset from the body because the parser discards it', () => {
    // This captures why frame and frameset are not included in the forbidden tag list. A tag that
    // never enters the tree cannot be found by traversal; this is not an omission in the scanner.
    const fragment = parseInertFragment('<p>a</p><frameset><frame src="x.html"></frameset>', document);

    expect([...fragment.children].map((child) => child.tagName.toLowerCase())).toEqual(['p']);
  });
});
