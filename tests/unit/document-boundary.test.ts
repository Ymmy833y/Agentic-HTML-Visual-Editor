import { describe, expect, it } from 'vitest';

import { isBlankDocument, joinDocument, splitDocument } from '../../common/index';
import type { DocumentBoundary } from '../../common/index';

const PLAIN_DOCUMENT = '<!DOCTYPE html>\n<html>\n<head>\n<title>t</title>\n</head>\n<body>\n<p>a</p>\n</body>\n</html>\n';

const BYTE_ORDER_MARK = '﻿';

// Fail immediately if the boundary cannot be determined in cases that inspect a successfully split value.
function split(text: string): DocumentBoundary {
  const boundary = splitDocument(text);
  if (boundary === undefined) {
    throw new Error(`The document boundary could not be determined: ${text}`);
  }
  return boundary;
}

describe('document boundary', () => {
  it('joins the three parts of a regular split document back into the original text', () => {
    const boundary = split(PLAIN_DOCUMENT);

    expect(joinDocument(boundary, boundary.body)).toBe(PLAIN_DOCUMENT);
  });

  it('includes an opening tag and its attributes in the prologue', () => {
    expect(split('<html><body class="doc"><p>a</p></body></html>').prologue).toBe('<html><body class="doc">');
  });

  it('includes the entire opening tag in the prologue when an attribute value contains >', () => {
    expect(split('<html><body data-note="a > b"><p>a</p></body></html>').prologue).toBe('<html><body data-note="a > b">');
  });

  it('splits uppercase tag names and joins the parts back into the original text', () => {
    const text = '<HTML><BODY><P>a</P></BODY></HTML>';

    const boundary = split(text);

    expect(joinDocument(boundary, boundary.body)).toBe(text);
  });

  it('preserves every line-ending character when splitting and joining a CRLF document', () => {
    const text = '<html>\r\n<body>\r\n<p>a</p>\r\n</body>\r\n</html>\r\n';

    const boundary = split(text);

    expect(joinDocument(boundary, boundary.body)).toBe(text);
  });

  it('keeps the BOM in the prologue and joins a BOM-prefixed document back into the original text', () => {
    const text = `${BYTE_ORDER_MARK}${PLAIN_DOCUMENT}`;

    const boundary = split(text);

    expect(boundary.prologue.startsWith(BYTE_ORDER_MARK)).toBe(true);
    expect(joinDocument(boundary, boundary.body)).toBe(text);
  });

  it('preserves the prologue and epilogue when joining with a replacement body', () => {
    expect(joinDocument(split(PLAIN_DOCUMENT), '<p>b</p>')).toBe(
      '<!DOCTYPE html>\n<html>\n<head>\n<title>t</title>\n</head>\n<body><p>b</p></body>\n</html>\n',
    );
  });

  it('does not treat <body> inside an HTML comment as a boundary', () => {
    expect(split('<html><!-- <body> --><body><p>a</p></body></html>').body).toBe('<p>a</p>');
  });

  it('does not treat </body> inside an attribute value as a boundary', () => {
    expect(split('<html><body><p data-note="</body>">a</p></body></html>').body).toBe('<p data-note="</body>">a</p>');
  });

  it('does not treat </body> inside <script> as a boundary', () => {
    expect(split('<html><head><script>var s = "</body>";</script></head><body><p>a</p></body></html>').body).toBe('<p>a</p>');
  });

  it('does not treat <body> inside <textarea> as a boundary', () => {
    expect(split('<html><body><textarea><body></textarea></body></html>').body).toBe('<textarea><body></textarea>');
  });

  it('does not treat <body> inside <style> as a boundary', () => {
    expect(split('<html><head><style>/* <body> */</style></head><body><p>a</p></body></html>').body).toBe('<p>a</p>');
  });

  it('does not treat <body> inside <title> as a boundary', () => {
    expect(split('<html><head><title><body></title></head><body><p>a</p></body></html>').body).toBe('<p>a</p>');
  });

  it('does not treat </scriptx> inside <script> as a closing tag', () => {
    expect(split('<html><head><script>var s = "</scriptx><body>";</script></head><body><p>a</p></body></html>').body).toBe('<p>a</p>');
  });

  it('ends <script> content at </script> even when it appears inside a script comment', () => {
    expect(split('<html><head><script>/* </script></head><body><p>a</p></body></html>').body).toBe('<p>a</p>');
  });

  it('does not split a document with an unclosed <script> because all following text is its content', () => {
    expect(splitDocument('<html><head><script>a</head><body><p>a</p></body></html>')).toBeUndefined();
  });

  it('does not split a document without an opening tag', () => {
    expect(splitDocument('<html><p>a</p></body></html>')).toBeUndefined();
  });

  it('does not split a document without a closing tag', () => {
    expect(splitDocument('<html><body><p>a</p></html>')).toBeUndefined();
  });

  it('does not split a document with two opening tags', () => {
    expect(splitDocument('<html><body><body><p>a</p></body></html>')).toBeUndefined();
  });

  it('does not split a document with two closing tags', () => {
    expect(splitDocument('<html><body><p>a</p></body></body></html>')).toBeUndefined();
  });

  it('does not split a document whose closing tag precedes its opening tag', () => {
    expect(splitDocument('<html></body><p>a</p><body></html>')).toBeUndefined();
  });

  it('does not split an empty string', () => {
    expect(splitDocument('')).toBeUndefined();
  });
});

describe('blank document', () => {
  it.each([
    ['an empty string', ''],
    ['spaces and tabs', ' \t '],
    ['line breaks', '\n\r\n'],
    ['a byte order mark followed by a line break', `${BYTE_ORDER_MARK}\n`],
  ])('treats %s as blank', (_label, text) => {
    expect(isBlankDocument(text)).toBe(true);
  });

  it('does not treat text with one non-whitespace character as blank', () => {
    expect(isBlankDocument('\n a \n')).toBe(false);
  });
});
