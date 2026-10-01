import { diffIndices } from 'node-diff3';

/** A zero-based line range. */
export interface LineRange {
  readonly start: number;
  readonly count: number;
}

/** A differing segment between the two sequences. */
export interface LineDiffSegment {
  readonly first: LineRange;
  readonly second: LineRange;
}

/**
 * Strips the common head and tail, then finds the differing segments between
 * the two line arrays.
 *
 * @param first The line array to compare from.
 * @param second The line array to compare to.
 * @returns The differing segments, expressed in both line arrays.
 */
export function diffLines(
  first: readonly string[],
  second: readonly string[],
): readonly LineDiffSegment[] {
  let headCount = 0;
  const shorterLength = Math.min(first.length, second.length);
  while (headCount < shorterLength && first[headCount] === second[headCount]) {
    headCount += 1;
  }

  let tailCount = 0;
  while (
    tailCount < shorterLength - headCount
    && first[first.length - tailCount - 1] === second[second.length - tailCount - 1]
  ) {
    tailCount += 1;
  }

  const firstEnd = first.length - tailCount;
  const secondEnd = second.length - tailCount;
  const differences = diffIndices(
    first.slice(headCount, firstEnd),
    second.slice(headCount, secondEnd),
  );

  return differences.map((difference) => ({
    first: {
      start: difference.buffer1[0] + headCount,
      count: difference.buffer1[1],
    },
    second: {
      start: difference.buffer2[0] + headCount,
      count: difference.buffer2[1],
    },
  }));
}
