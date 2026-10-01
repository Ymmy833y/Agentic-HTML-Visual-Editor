import { describe, expect, it } from 'vitest';

import { COMMENT_ID_ATTEMPT_LIMIT, createCommentId } from '../../webview/editing/comment-id';
import type { RandomFill } from '../../webview/editing/comment-id';
import { mountRoot } from './helpers/format-dom';

/** A random fill that returns fixed sequences, and how many times it was called. */
interface FixedSource {
  readonly fill: RandomFill;
  readonly calls: () => number;
}

/**
 * Creates a random fill that fills the bytes with the next sequence on each call. Once the sequences run out, it keeps returning the last one.
 *
 * @param draws The values to fill on each call.
 * @returns The random fill and how many times it was called.
 */
function createFixedSource(draws: readonly (readonly number[])[]): FixedSource {
  let calls = 0;
  return {
    fill: (bytes) => {
      bytes.set(draws[Math.min(calls, draws.length - 1)]);
      calls += 1;
    },
    calls: () => calls,
  };
}

/** A sequence of 16 copies of the same value (the number of bytes taken for one candidate). */
function repeat(value: number): number[] {
  return Array.from({ length: 16 }, () => value);
}

describe('Creating comment IDs', () => {
  it('the returned ID consists of c- and 8 lowercase letters and digits', () => {
    const root = mountRoot('<p>a</p>');

    const id = createCommentId(root, [], (bytes) => crypto.getRandomValues(bytes));

    expect(id).toMatch(/^c-[a-z0-9]{8}$/u);
  });

  it('when the first candidate equals the id of an element in the editor root, a redrawn candidate is returned', () => {
    const root = mountRoot('<p><span id="c-aaaaaaaa">a</span></p>');

    const id = createCommentId(root, [], createFixedSource([repeat(0), repeat(1)]).fill);

    expect(id).toBe('c-bbbbbbbb');
  });

  it('when the first candidate appears in the prologue text, a redrawn candidate is returned', () => {
    const root = mountRoot('<p>a</p>');
    const prologue = '<!DOCTYPE html>\n<html><head><meta name="x" content="c-aaaaaaaa"></head><body>';

    const id = createCommentId(root, [prologue, '</body></html>'], createFixedSource([repeat(0), repeat(1)]).fill);

    expect(id).toBe('c-bbbbbbbb');
  });

  it('with random values that overlap all 16 times, it draws 16 times and returns nothing', () => {
    const root = mountRoot('<p><span id="c-aaaaaaaa">a</span></p>');
    const source = createFixedSource([repeat(0)]);

    const id = createCommentId(root, [], source.fill);

    expect([id, source.calls(), COMMENT_ID_ATTEMPT_LIMIT]).toEqual([undefined, 16, 16]);
  });

  it('when the random fill throws, nothing is returned and the exception does not escape', () => {
    const root = mountRoot('<p>a</p>');

    const id = createCommentId(root, [], () => {
      throw new Error('No random values');
    });

    expect(id).toBeUndefined();
  });

  it('bytes of 252 or more are not used, and the next byte selects the character', () => {
    const root = mountRoot('<p>a</p>');

    const id = createCommentId(root, [], createFixedSource([[252, 255, 0, 1, 2, 3, 4, 5, 6, 7]]).fill);

    expect(id).toBe('c-abcdefgh');
  });
});
