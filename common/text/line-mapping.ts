import { diffLines } from './line-diff';
import type { LineRange } from './line-diff';

/** A single mapping segment between the disk body and the baseline. */
export interface LineMappingSegment {
  readonly disk: LineRange;
  readonly baseline: LineRange;
}

/** The line mapping between the disk body and the baseline. */
export type LineMapping = readonly LineMappingSegment[];

/**
 * Builds the line mapping from the differing segments between the disk body
 * and the baseline.
 *
 * @param diskLines The line array of the disk body.
 * @param baselineLines The line array of the serialization baseline.
 * @returns The line mapping between the disk body and the baseline.
 */
export function createLineMapping(
  diskLines: readonly string[],
  baselineLines: readonly string[],
): LineMapping {
  return diffLines(diskLines, baselineLines).map((segment) => ({
    disk: segment.first,
    baseline: segment.second,
  }));
}

/**
 * Widens a baseline-side line range until it wholly contains every differing
 * segment it touches.
 *
 * A differing segment is a chunk whose lines correspond as a whole on both
 * sides; cutting it in the middle would replace only part of the disk-side
 * lines and corrupt the body. The range is only ever widened, never narrowed.
 *
 * @param mapping The line mapping between the disk body and the baseline.
 * @param baselineRange The baseline-side line range.
 * @returns The baseline-side line range widened to the boundaries of every
 *   differing segment it touches.
 */
export function expandToSegments(mapping: LineMapping, baselineRange: LineRange): LineRange {
  let start = baselineRange.start;
  let end = baselineRange.start + baselineRange.count;

  for (const segment of mapping) {
    // A segment with zero baseline lines has no width on the baseline side, so no
    // range can overlap it.
    if (segment.baseline.count === 0) {
      continue;
    }

    const segmentEnd = segment.baseline.start + segment.baseline.count;
    // A range of zero lines is an insertion point rather than a line of its own, so
    // treat it as touching the segment only when it falls strictly inside. Widening
    // on a mere boundary contact would pull unedited lines into the replacement.
    const overlaps = baselineRange.count === 0
      ? segment.baseline.start < baselineRange.start && baselineRange.start < segmentEnd
      : segment.baseline.start < end && start < segmentEnd;

    if (overlaps) {
      start = Math.min(start, segment.baseline.start);
      end = Math.max(end, segmentEnd);
    }
  }

  return { start, count: end - start };
}

/**
 * Which side of a differing segment a position landing on its edge is pulled
 * toward: before the segment or after it.
 */
type PositionBias = 'start' | 'end';

/**
 * Maps a single baseline-side position onto the disk body.
 *
 * @param mapping The line mapping between the disk body and the baseline.
 * @param position The baseline-side line number.
 * @param bias Which way to pull a position that lands on the edge of a
 *   differing segment.
 * @returns The disk-side line number.
 */
function mapPosition(mapping: LineMapping, position: number, bias: PositionBias): number {
  let offset = 0;

  for (const segment of mapping) {
    const baselineStart = segment.baseline.start;
    const baselineEnd = segment.baseline.start + segment.baseline.count;
    if (position < baselineStart) {
      break;
    }
    if (segment.baseline.count === 0 && position === baselineStart) {
      // A segment with lines on the disk side but none on the baseline side. It
      // collapses to a single point on the baseline side, so the position alone
      // cannot say whether it means before or after those lines. Pulling a start
      // after them and an end before them leaves the disk-side lines outside the
      // replaced range.
      if (bias === 'end') {
        break;
      }
      offset += segment.disk.count;
      continue;
    }
    if (position < baselineEnd) {
      return segment.disk.start;
    }
    // Every segment passed shifts the following positions by its difference in line
    // count.
    offset += segment.disk.count - segment.baseline.count;
  }

  return position + offset;
}

/**
 * Maps a baseline-side range onto the disk body without narrowing any
 * differing segment.
 *
 * @param mapping The line mapping between the disk body and the baseline.
 * @param baselineRange The baseline-side line range to map.
 * @returns The line range mapped onto the disk body.
 */
export function mapToDisk(mapping: LineMapping, baselineRange: LineRange): LineRange {
  const expanded = expandToSegments(mapping, baselineRange);

  const diskStart = mapPosition(mapping, expanded.start, 'start');
  if (expanded.count === 0) {
    return { start: diskStart, count: 0 };
  }

  const diskEnd = mapPosition(mapping, expanded.start + expanded.count, 'end');
  return { start: diskStart, count: diskEnd - diskStart };
}
