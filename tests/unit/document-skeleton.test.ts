// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { buildDocumentSkeleton } from '../../src/editor/document-skeleton';

describe('document skeleton', () => {
  it('declares UTF-8 and takes the title from the file name without its extension', () => {
    expect(buildDocumentSkeleton('notes.html')).toBe(
      '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>notes</title>\n</head>\n<body>\n</body>\n</html>\n',
    );
  });

  it('removes only the last extension', () => {
    expect(buildDocumentSkeleton('design.v2.html')).toContain('<title>design.v2</title>');
  });

  it('replaces & and < in the file name with character references', () => {
    expect(buildDocumentSkeleton('a&b<c.html')).toContain('<title>a&amp;b&lt;c</title>');
  });
});
