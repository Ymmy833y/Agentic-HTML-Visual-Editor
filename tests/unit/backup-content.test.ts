// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  BACKUP_CONTENT_VERSION,
  assembleBackupContent,
  decodeBackupContent,
  encodeBackupContent,
} from '../../src/backup/backup-content';

const DOCUMENT_URI = 'file:///workspace/a.html';
const RETAINED_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>ab</p>\n</body>\n</html>\n';
const SYNC_BASE = '<!DOCTYPE html>\n<html>\n<body>\n<p>a</p>\n</body>\n</html>\n';
const STALE_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>stale</p>\n</body>\n</html>\n';

/**
 * Converts a string to UTF-8 bytes.
 *
 * @param text The string to encode.
 */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('assembling backup content', () => {
  it('returns backup content with that merge base and the target URI once the retained copy and retry base are both present', () => {
    const retryBase = '<!DOCTYPE html>\n<html>\n<body>\n<p>retry</p>\n</body>\n</html>\n';

    expect(assembleBackupContent({
      documentUri: DOCUMENT_URI,
      retainedCopy: RETAINED_TEXT,
      mergeBase: retryBase,
    })).toEqual({
      version: BACKUP_CONTENT_VERSION,
      documentUri: DOCUMENT_URI,
      fullText: RETAINED_TEXT,
      mergeBase: retryBase,
    });
  });

  it('returns no backup content when the full text or the merge base has not been obtained', () => {
    expect([
      assembleBackupContent({ documentUri: DOCUMENT_URI, retainedCopy: undefined, mergeBase: SYNC_BASE }),
      assembleBackupContent({ documentUri: DOCUMENT_URI, retainedCopy: RETAINED_TEXT, mergeBase: undefined }),
    ]).toEqual([undefined, undefined]);
  });

  it('keeps an empty full text and merge base as obtained values', () => {
    expect(assembleBackupContent({ documentUri: DOCUMENT_URI, retainedCopy: '', mergeBase: '' }))
      .toEqual({ version: BACKUP_CONTENT_VERSION, documentUri: DOCUMENT_URI, fullText: '', mergeBase: '' });
  });

  it('uses the old full text over the retained copy under protection and does not fill a missing old full text with the retained copy', () => {
    const input = { documentUri: DOCUMENT_URI, retainedCopy: RETAINED_TEXT, mergeBase: SYNC_BASE };

    expect([
      assembleBackupContent(input, { staleText: STALE_TEXT })?.fullText,
      assembleBackupContent(input, { staleText: undefined }),
    ]).toEqual([STALE_TEXT, undefined]);
  });
});

describe('encoding and reading back backup content', () => {
  it('keeps a full text with multibyte characters and HTML prologue and epilogue verbatim through a UTF-8 JSON round trip', () => {
    const content = {
      version: BACKUP_CONTENT_VERSION,
      documentUri: DOCUMENT_URI,
      fullText: '<!DOCTYPE html>\r\n<html lang="ja">\n<body>\n<p>\u65e5\u672c\u8a9e "\u5f15\u7528" \\ </p>\n</body>\n</html>',
      mergeBase: '<html><body>\n\t<p>\u57fa\u6e96</p>\n</body></html>',
    } as const;

    expect(decodeBackupContent(encodeBackupContent(content))).toEqual(content);
  });

  it('rejects invalid UTF-8 bytes', () => {
    const valid = encodeBackupContent({
      version: BACKUP_CONTENT_VERSION,
      documentUri: DOCUMENT_URI,
      fullText: '\u3042',
      mergeBase: '',
    });
    // Corrupt only the middle of a 3-byte character, keeping the JSON delimiters intact.
    const broken = Uint8Array.from(valid, (byte, index) => (index === valid.indexOf(0xe3) + 1 ? 0x20 : byte));

    expect(decodeBackupContent(broken)).toBeUndefined();
  });

  it('rejects truncated JSON', () => {
    const bytes = encodeBackupContent({
      version: BACKUP_CONTENT_VERSION,
      documentUri: DOCUMENT_URI,
      fullText: RETAINED_TEXT,
      mergeBase: SYNC_BASE,
    });

    expect(decodeBackupContent(bytes.slice(0, bytes.length - 5))).toBeUndefined();
  });

  it('rejects an unknown format version', () => {
    const bytes = utf8(JSON.stringify({
      version: BACKUP_CONTENT_VERSION + 1,
      documentUri: DOCUMENT_URI,
      fullText: RETAINED_TEXT,
      mergeBase: SYNC_BASE,
    }));

    expect(decodeBackupContent(bytes)).toBeUndefined();
  });

  it('rejects JSON whose full text is not a string', () => {
    const bytes = utf8(JSON.stringify({
      version: BACKUP_CONTENT_VERSION,
      documentUri: DOCUMENT_URI,
      fullText: null,
      mergeBase: SYNC_BASE,
    }));

    expect(decodeBackupContent(bytes)).toBeUndefined();
  });
});
