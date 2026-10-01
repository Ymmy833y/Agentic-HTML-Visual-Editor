// @vitest-environment node
import { performance } from 'node:perf_hooks';
import { diffIndices } from 'node-diff3';
import { describe, expect, it } from 'vitest';

import { diffLines } from '../../common/index';

describe('line diff', () => {
  it('returns the same segments as the plain diff even after stripping the common head and tail', () => {
    const first = ['head', 'before', 'tail'];
    const second = ['head', 'after', 'tail'];

    expect(diffLines(first, second)).toEqual(
      diffIndices(first, second).map((segment) => ({
        first: { start: segment.buffer1[0], count: segment.buffer1[1] },
        second: { start: segment.buffer2[0], count: segment.buffer2[1] },
      })),
    );
  });

  it('returns an empty segment list when every line matches', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('makes the whole input a single segment when no line matches', () => {
    expect(diffLines(['a', 'b'], ['c', 'd'])).toEqual([
      { first: { start: 0, count: 2 }, second: { start: 0, count: 2 } },
    ]);
  });

  it('makes the whole input a single segment when one side is empty', () => {
    expect(diffLines([], ['a', 'b'])).toEqual([
      { first: { start: 0, count: 0 }, second: { start: 0, count: 2 } },
    ]);
  });

  it('makes only the tail a segment when one side is a prefix of the other', () => {
    expect(diffLines(['a'], ['a', 'b'])).toEqual([
      { first: { start: 1, count: 0 }, second: { start: 1, count: 1 } },
    ]);
  });

  it('returns positions as line numbers of the input before the trimming', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      { first: { start: 1, count: 1 }, second: { start: 1, count: 1 } },
    ]);
  });

  it('diffs a one-line edit in 5000 duplicate lines within one second', () => {
    const first = Array.from({ length: 5_000 }, () => '<tr></tr>');
    const second = [...first];
    second[2_500] = '<tr><td>edited</td></tr>';

    const startedAt = performance.now();
    const segments = diffLines(first, second);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(segments).toEqual([
      { first: { start: 2_500, count: 1 }, second: { start: 2_500, count: 1 } },
    ]);
  });
});
