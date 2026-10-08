import { diffLines } from './line-diff';
import type { LineRange } from './line-diff';
import { joinLines } from './lines';

/** A region containing lines that go directly into the result. */
export interface StableRegion {
  readonly kind: 'stable';
  readonly lines: readonly string[];
}

/**
 * A region where changes from both sides overlap in the base, or touch where one of them is an insertion
 * point, leaving no single result.
 */
export interface ConflictRegion {
  readonly kind: 'conflict';
  readonly base: readonly string[];
  readonly source: readonly string[];
  readonly view: readonly string[];
}

/** A single region in a merge result. */
export type MergeRegion = StableRegion | ConflictRegion;

/**
 * Which lines of a conflict region go into the result.
 *
 * The spellings are carried between the host and the view, so they must remain stable.
 */
export const CONFLICT_CHOICE = {
  /** The source lines only. */
  source: 'source',
  /** The view lines only. */
  view: 'view',
  /** The source lines followed by the view lines. */
  both: 'both',
} as const;

/** Which lines of a conflict region go into the result. */
export type ConflictChoice = (typeof CONFLICT_CHOICE)[keyof typeof CONFLICT_CHOICE];

/** The result of a three-way merge. */
export interface MergeResult {
  readonly regions: readonly MergeRegion[];
  readonly hasConflict: boolean;
}

/**
 * A region under construction.
 *
 * A stable region keeps its lines in a mutable array so that lines can be appended to the last stable
 * region. It becomes read-only as a MergeRegion when returned.
 */
type BuildingRegion = { readonly kind: 'stable'; readonly lines: string[] } | ConflictRegion;

/** A single difference between the base and one side, with the line range from each. */
interface Hunk {
  readonly base: LineRange;
  readonly side: LineRange;
}

/**
 * The first and last hunks from one side that intersect a hunk group.
 *
 * Bias correction only inspects the two ends of the group, so intermediate hunks are not retained. This
 * type cannot represent a side that does not intersect the group, which means line extraction does not
 * need to handle empty input.
 */
interface SideHunks {
  readonly first: Hunk;
  readonly last: Hunk;
}

/**
 * A group of hunks that overlap, or that touch where one of them is an insertion point, and the positions of
 * the next hunks to inspect.
 */
interface HunkGroup {
  readonly base: LineRange;
  readonly source: SideHunks | undefined;
  readonly view: SideHunks | undefined;
  readonly nextSourceIndex: number;
  readonly nextViewIndex: number;
}

/**
 * Combines source-side and view-side changes line by line, using the sync base as their common ancestor.
 *
 * This function does not resolve conflicts. It returns overlapping changes as a conflict region with all
 * three versions, leaving the caller to choose which side to use.
 *
 * Inputs are assumed to have LF-normalized line endings; stray CR characters are not detected. The caller
 * performs normalization and restoration through the same mechanism used by the line diff.
 *
 * @param baseLines The lines of the sync base.
 * @param sourceLines The lines of the text buffer's current value.
 * @param viewLines The lines of the view's unsaved content.
 * @returns The regions in document order and whether any conflict exists.
 */
export function mergeThreeWay(
  baseLines: readonly string[],
  sourceLines: readonly string[],
  viewLines: readonly string[],
): MergeResult {
  const sourceHunks = collectHunks(baseLines, sourceLines);
  const viewHunks = collectHunks(baseLines, viewLines);
  const regions = buildRegions(baseLines, sourceLines, viewLines, sourceHunks, viewHunks);

  return {
    regions,
    hasConflict: regions.some((region) => region.kind === 'conflict'),
  };
}

/**
 * Concatenates merge regions into one full document text.
 *
 * A conflict region drops the base side and places the lines of the chosen side. Without choices, every
 * conflict region places all source lines followed by all view lines: only a save asks the user to choose,
 * and the other paths keep both sides so that neither is dropped without the user knowing. Git-style
 * markers are not inserted because they would break the HTML. Every path shares this function so the same
 * conflict is never ordered differently depending on the path.
 *
 * @param regions Merge regions returned by the three-way merge.
 * @param choices The choice for each conflict region, counting conflict regions only, in document order.
 * @returns Concatenated full document text.
 * @throws {RangeError} When choices are given and their number differs from the number of conflict regions.
 */
export function flattenMergeRegions(
  regions: readonly MergeRegion[],
  choices?: readonly ConflictChoice[],
): string {
  if (choices !== undefined) {
    const conflictCount = regions.filter((region) => region.kind === 'conflict').length;
    if (choices.length !== conflictCount) {
      throw new RangeError(
        `Received ${choices.length} conflict choices for ${conflictCount} conflict regions`,
      );
    }
  }

  const lines: string[] = [];
  let conflictIndex = 0;
  for (const region of regions) {
    let sides: readonly (readonly string[])[];
    if (region.kind === 'stable') {
      sides = [region.lines];
    } else {
      sides = selectConflictSides(region, choices?.[conflictIndex] ?? CONFLICT_CHOICE.both);
      conflictIndex += 1;
    }
    // Spreading a large document into a single call can fail, so append one line at a time.
    for (const side of sides) {
      for (const line of side) {
        lines.push(line);
      }
    }
  }

  return joinLines(lines);
}

/**
 * Returns the sides of a conflict region that go into the result, in order.
 *
 * @param region The conflict region.
 * @param choice Which lines to keep.
 * @returns The line arrays to place, source first when both are kept.
 */
function selectConflictSides(
  region: ConflictRegion,
  choice: ConflictChoice,
): readonly (readonly string[])[] {
  if (choice === CONFLICT_CHOICE.source) {
    return [region.source];
  }
  if (choice === CONFLICT_CHOICE.view) {
    return [region.view];
  }
  return [region.source, region.view];
}

/**
 * Diffs the base against one side and produces hunks ordered by their base coordinates.
 *
 * The line diff removes the common prefix and suffix before comparison, but maps the returned coordinates
 * back to the original line numbers. Keeping the base as the first sequence and diffing each side
 * separately prevents edits on one side from interfering with trimming on the other, while keeping both
 * hunk sequences in the same coordinate system.
 *
 * @param baseLines The lines of the sync base.
 * @param sideLines The lines from one side.
 * @returns Hunks ordered by their starting line in the base.
 */
function collectHunks(
  baseLines: readonly string[],
  sideLines: readonly string[],
): readonly Hunk[] {
  return diffLines(baseLines, sideLines).map((segment) => ({
    base: segment.first,
    side: segment.second,
  }));
}

/**
 * Arranges the two hunk sequences by their base coordinates and divides them into regions.
 *
 * @param baseLines The lines of the sync base.
 * @param sourceLines The lines of the text buffer's current value.
 * @param viewLines The lines of the view's unsaved content.
 * @param sourceHunks The source-side hunks.
 * @param viewHunks The view-side hunks.
 * @returns Contiguous regions ordered from the beginning to the end of the document.
 */
function buildRegions(
  baseLines: readonly string[],
  sourceLines: readonly string[],
  viewLines: readonly string[],
  sourceHunks: readonly Hunk[],
  viewHunks: readonly Hunk[],
): readonly MergeRegion[] {
  const regions: BuildingRegion[] = [];
  let baseIndex = 0;
  let sourceIndex = 0;
  let viewIndex = 0;

  while (sourceIndex < sourceHunks.length || viewIndex < viewHunks.length) {
    const group = groupConflictingHunks(sourceHunks, viewHunks, sourceIndex, viewIndex);
    const groupEnd = group.base.start + group.base.count;

    // Neither side changed the lines before the group, so use the base lines unchanged.
    appendRegion(regions, { kind: 'stable', lines: baseLines.slice(baseIndex, group.base.start) });

    const baseRegionLines = baseLines.slice(group.base.start, groupEnd);
    // A side that does not intersect the group left this range unchanged, so its content is the base lines.
    const sourceRegionLines = group.source === undefined
      ? baseRegionLines
      : extractSideLines(group.source, group.base, sourceLines);
    const viewRegionLines = group.view === undefined
      ? baseRegionLines
      : extractSideLines(group.view, group.base, viewLines);

    if (group.source !== undefined && group.view !== undefined) {
      appendRegion(regions, {
        kind: 'conflict',
        base: baseRegionLines,
        source: sourceRegionLines,
        view: viewRegionLines,
      });
    } else {
      // When only one side changed a region, the changed side is the sole result.
      appendRegion(regions, {
        kind: 'stable',
        lines: group.source === undefined ? viewRegionLines : sourceRegionLines,
      });
    }

    baseIndex = groupEnd;
    sourceIndex = group.nextSourceIndex;
    viewIndex = group.nextViewIndex;
  }

  appendRegion(regions, { kind: 'stable', lines: baseLines.slice(baseIndex) });

  return regions;
}

/**
 * Extracts one group of overlapping hunks starting at the scan positions.
 *
 * Hunks that merely touch at their boundaries stay apart when both have lines: each side's lines then fall
 * into place in base order, and neither side's change is duplicated. An insertion point (a hunk with no base
 * lines) that touches another hunk joins the group instead, because the diff cannot say whether the inserted
 * lines belong before or after the touching change.
 *
 * @param sourceHunks The source-side hunks.
 * @param viewHunks The view-side hunks.
 * @param sourceIndex The source-side scan position.
 * @param viewIndex The view-side scan position.
 * @returns The group's base range, the hunks at each side's boundaries, and the next scan positions.
 */
function groupConflictingHunks(
  sourceHunks: readonly Hunk[],
  viewHunks: readonly Hunk[],
  sourceIndex: number,
  viewIndex: number,
): HunkGroup {
  const sourceStart = sourceIndex < sourceHunks.length
    ? sourceHunks[sourceIndex].base.start
    : Number.POSITIVE_INFINITY;
  const viewStart = viewIndex < viewHunks.length
    ? viewHunks[viewIndex].base.start
    : Number.POSITIVE_INFINITY;

  const start = Math.min(sourceStart, viewStart);
  let end = start;
  let source: SideHunks | undefined;
  let view: SideHunks | undefined;
  let nextSourceIndex = sourceIndex;
  let nextViewIndex = viewIndex;

  // Extending the end with a hunk from one side may bring the other side's next hunk within reach.
  // Inspect both sides alternately until the group stops extending, following the entire chain.
  let extended = true;
  while (extended) {
    extended = false;

    while (
      nextSourceIndex < sourceHunks.length
      && joinsGroup(sourceHunks[nextSourceIndex], start, end)
    ) {
      const hunk = sourceHunks[nextSourceIndex];
      end = Math.max(end, hunk.base.start + hunk.base.count);
      source = { first: source?.first ?? hunk, last: hunk };
      nextSourceIndex += 1;
      extended = true;
    }

    while (nextViewIndex < viewHunks.length && joinsGroup(viewHunks[nextViewIndex], start, end)) {
      const hunk = viewHunks[nextViewIndex];
      end = Math.max(end, hunk.base.start + hunk.base.count);
      view = { first: view?.first ?? hunk, last: hunk };
      nextViewIndex += 1;
      extended = true;
    }
  }

  return {
    base: { start, count: end - start },
    source,
    view,
    nextSourceIndex,
    nextViewIndex,
  };
}

/**
 * Reports whether a hunk belongs to the group that spans the given base range.
 *
 * @param hunk The next hunk of one side, in base order.
 * @param start The group's first base line.
 * @param end The base line after the group's last one.
 * @returns `true` when the hunk overlaps the group, or touches it with an insertion point on either side.
 */
function joinsGroup(hunk: Hunk, start: number, end: number): boolean {
  if (hunk.base.start < end) {
    return true;
  }
  // A group that holds no base lines yet is itself an insertion point, which also admits the first hunk.
  return hunk.base.start === end && (hunk.base.count === 0 || end === start);
}

/**
 * Extracts the lines from one side that correspond to the base range enclosed by the group.
 *
 * @param hunks The hunks at that side's boundaries within the group.
 * @param baseRange The base range enclosed by the group.
 * @param sideLines The lines from that side.
 * @returns The lines from that side corresponding to the base range.
 */
function extractSideLines(
  hunks: SideHunks,
  baseRange: LineRange,
  sideLines: readonly string[],
): readonly string[] {
  const baseEnd = baseRange.start + baseRange.count;
  const { first, last } = hunks;
  // A group encloses hunks from both sides and may therefore be wider than this side's hunks. The excess
  // lines are unchanged on this side, so map both ends using only the offset from the hunk's base range.
  const start = first.side.start - (first.base.start - baseRange.start);
  const end = last.side.start + last.side.count + (baseEnd - (last.base.start + last.base.count));

  return sideLines.slice(start, end);
}

/**
 * Appends a constructed region while absorbing false conflicts and joining stable regions.
 *
 * @param regions The regions under construction. Lines may be appended to the last stable region.
 * @param region The region to append.
 */
function appendRegion(regions: BuildingRegion[], region: MergeRegion): void {
  let settled = region;
  if (
    region.kind === 'conflict'
    && region.source.length === region.view.length
    && region.source.every((line, index) => line === region.view[index])
  ) {
    // Identical changes from both sides have one deterministic result. Use it once without a conflict.
    settled = { kind: 'stable', lines: region.source };
  }

  if (settled.kind === 'conflict') {
    regions.push(settled);
    return;
  }

  // A stable region without lines adds nothing to the result. This occurs when one side deletes every line.
  if (settled.lines.length === 0) {
    return;
  }

  const previous = regions[regions.length - 1];
  // Joining adjacent stable regions avoids making callers repeatedly traverse regions handled identically.
  // Rebuilding the array for every join would repeatedly copy accumulated lines, making the cost grow with
  // the number of edited locations, so append directly. Spreading the lines into a call can fail for large
  // documents, so append them one at a time.
  if (previous !== undefined && previous.kind === 'stable') {
    for (const line of settled.lines) {
      previous.lines.push(line);
    }
    return;
  }

  regions.push({ kind: 'stable', lines: [...settled.lines] });
}
