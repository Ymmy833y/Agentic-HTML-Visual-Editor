// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { joinLines, splitLines } from '../../common/index';

describe('splitting and joining lines', () => {
  it('restores text ending with a line break after splitting and joining it', () => {
    const text = 'a\nb\n';

    expect(joinLines(splitLines(text))).toBe(text);
  });

  it('restores an empty string after splitting and joining it', () => {
    expect(joinLines(splitLines(''))).toBe('');
  });

  it('splits text without line breaks into a single element', () => {
    expect(splitLines('a')).toEqual(['a']);
  });
});
