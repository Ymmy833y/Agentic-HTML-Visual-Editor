// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { rewriteCharsetDeclaration } from '../../common/index';

/**
 * Builds a document whose head holds the given lines.
 *
 * @param head The lines placed inside the head.
 * @param body The body placed between the body tags.
 * @returns The complete document text.
 */
function documentWith(head: string, body = '\n<p>a</p>\n'): string {
  return `<!DOCTYPE html>\n<html>\n<head>\n${head}\n<title>t</title>\n</head>\n<body>${body}</body>\n</html>\n`;
}

describe('rewriting the declared encoding to UTF-8', () => {
  it('rewrites a meta charset that names another encoding and leaves every other character unchanged', () => {
    expect(rewriteCharsetDeclaration(documentWith('<meta charset="shift_jis">')))
      .toBe(documentWith('<meta charset="utf-8">'));
  });

  it('rewrites only the encoding name inside a Content-Type http-equiv declaration', () => {
    const declared = '<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">';

    expect(rewriteCharsetDeclaration(documentWith(declared)))
      .toBe(documentWith('<meta http-equiv="Content-Type" content="text/html; charset=utf-8">'));
  });

  it('keeps an unquoted or single-quoted value in its own quoting', () => {
    const declared = "<meta charset=shift_jis>\n<meta http-equiv=content-type content='text/html; charset=EUC-JP'>";

    expect(rewriteCharsetDeclaration(documentWith(declared)))
      .toBe(documentWith("<meta charset=utf-8>\n<meta http-equiv=content-type content='text/html; charset=utf-8'>"));
  });

  it('leaves declarations that already name UTF-8 under another label unchanged', () => {
    const text = documentWith('<meta charset="UTF-8">\n<meta http-equiv="Content-Type" content="text/html; charset=utf8">');

    expect(rewriteCharsetDeclaration(text)).toBe(text);
  });

  it('leaves a document without a declaration unchanged', () => {
    const text = documentWith('<meta name="viewport" content="width=device-width">');

    expect(rewriteCharsetDeclaration(text)).toBe(text);
  });

  it('leaves declarations in the body and inside a comment in the head unchanged', () => {
    const text = documentWith('<!-- <meta charset="shift_jis"> -->', '\n<p><meta charset="shift_jis"></p>\n');

    expect(rewriteCharsetDeclaration(text)).toBe(text);
  });

  it('leaves a document whose body boundary cannot be determined unchanged', () => {
    const text = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="shift_jis">\n</head>\n</html>\n';

    expect(rewriteCharsetDeclaration(text)).toBe(text);
  });
});
