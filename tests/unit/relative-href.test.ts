import { describe, expect, it } from 'vitest';
import { isRelativeFileHref } from '../../src/shared/relative-href';

describe('isRelativeFileHref', () => {
  it.each([
    'test.txt',
    './files/test.txt',
    '../test.txt',
    'folder/file.txt?raw=1#part',
    '  spaced.txt  ',
  ])('accepts %s', (href) => expect(isRelativeFileHref(href)).toBe(true));

  it.each([
    '',
    '   ',
    '#section',
    '?query=1',
    '/absolute/path',
    '\\absolute\\path',
    'https://example.com/file.txt',
    'mailto:user@example.com',
    '//example.com/file.txt',
    'C:\\files\\test.txt',
  ])('rejects %s', (href) => expect(isRelativeFileHref(href)).toBe(false));
});
