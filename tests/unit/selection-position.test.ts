import { describe, expect, it } from 'vitest';

import {
  toCharacterOffset,
  toEncodedPosition,
} from '../../webview/selection/selection-position';

const THREE_LINES = '<p>a</p>\n<p>bcdef</p>\n<p>g</p>';

describe('encoding character offsets', () => {
  it('encodes a character offset within the third line as line 2 and column 4', () => {
    // The third line starts after the first line's 8 characters and newline and the second line's
    // 12 characters and newline.
    const offset = '<p>a</p>\n<p>bcdef</p>\n'.length + 4;

    expect(toEncodedPosition(THREE_LINES, offset)).toEqual({ line: 2, column: 4 });
  });

  it('encodes the start as line 0 and column 0', () => {
    expect(toEncodedPosition(THREE_LINES, 0)).toEqual({ line: 0, column: 0 });
  });

  it('encodes the end as the end of the last line', () => {
    expect(toEncodedPosition(THREE_LINES, THREE_LINES.length)).toEqual({ line: 2, column: 8 });
  });
});

describe('restoring character offsets from encoded positions', () => {
  it('round-trips without changing the character offset for the same string', () => {
    const offset = '<p>a</p>\n<p>bc'.length;

    expect(toCharacterOffset(THREE_LINES, toEncodedPosition(THREE_LINES, offset))).toBe(offset);
  });

  it('does not restore a line number beyond the line count', () => {
    expect(toCharacterOffset(THREE_LINES, { line: 3, column: 0 })).toBeUndefined();
  });

  it('clamps a column beyond the line length to the line end', () => {
    // The second line, `<p>bcdef</p>`, is 12 characters long and starts at character 9.
    expect(toCharacterOffset(THREE_LINES, { line: 1, column: 99 })).toBe(9 + 12);
  });
});
