import { describe, expect, it } from 'vitest';

import { serializeBody } from '../../webview/document/body-serializer';

function parse(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

describe('serializing the body', () => {
  it('serializes the loaded body without changing a single character', () => {
    const body = '<p>a</p>\n<img src="a.png">';

    expect(serializeBody(parse(body))).toBe(body);
  });

  it('turns a copy without children into an empty string', () => {
    expect(serializeBody(parse(''))).toBe('');
  });

  it('keeps the whitespace inside pre and table verbatim', () => {
    const body = '<pre>  a\n b</pre>\n<table>\n <tbody><tr><td>a</td></tr></tbody>\n</table>';

    expect(serializeBody(parse(body))).toBe(body);
  });
});
