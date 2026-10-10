import { diffLines } from './line-diff';
import type { LineRange } from './line-diff';
import { expandToSegments, mapToDisk } from './line-mapping';
import type { LineMapping } from './line-mapping';
import { joinLines, splitLines } from './lines';

interface BodyPatch {
  readonly disk: LineRange;
  readonly currentStart: number;
  readonly currentEnd: number;
  readonly baselineStart: number;
  readonly baselineEnd: number;
}

/**
 * Applies only the changes from the baseline to the current form onto the disk
 * body.
 *
 * @param diskBody The body as it stands on disk.
 * @param baseline The body of the serialization baseline.
 * @param current The body obtained by serializing the current tree.
 * @param mapping The line mapping between the disk body and the baseline.
 * @returns The body with the changes applied, preserving the spelling of the
 *   unedited lines.
 */
export function buildBodyOutput(
  diskBody: string,
  baseline: string,
  current: string,
  mapping: LineMapping,
): string {
  const diskLines = splitLines(diskBody);
  const baselineLines = splitLines(baseline);
  const currentLines = splitLines(current);
  const patches: BodyPatch[] = [];

  for (const difference of diffLines(baselineLines, currentLines)) {
    // Once a hunk touches a differing segment, the range widens until it replaces
    // that segment as a whole.
    const expanded = expandToSegments(mapping, difference.first);
    const baselineStart = expanded.start;
    const baselineEnd = expanded.start + expanded.count;

    // The lines added by the widening were not edited. The baseline and the current
    // form still hold the same content in the same order there, so taking that many
    // extra lines from the current form as well puts the content back unchanged
    // after the replacement.
    const prefixCount = difference.first.start - baselineStart;
    const suffixCount = baselineEnd - difference.first.start - difference.first.count;
    const patch: BodyPatch = {
      disk: mapToDisk(mapping, expanded),
      currentStart: difference.second.start - prefixCount,
      currentEnd: difference.second.start + difference.second.count + suffixCount,
      baselineStart,
      baselineEnd,
    };

    // Adjacent hunks widened onto the same differing segment overlap on the disk
    // side. Merge them into a single hunk so that applying the patches from the end
    // does not replace the same lines twice. The later hunk's end in the current
    // form already accounts for the line-count changes that precede it, so the
    // merge keeps the later position.
    const previous = patches.at(-1);
    if (previous !== undefined && patch.baselineStart <= previous.baselineEnd) {
      patches[patches.length - 1] = {
        disk: {
          start: previous.disk.start,
          count: patch.disk.start + patch.disk.count - previous.disk.start,
        },
        currentStart: previous.currentStart,
        currentEnd: patch.currentEnd,
        baselineStart: previous.baselineStart,
        baselineEnd: patch.baselineEnd,
      };
    } else {
      patches.push(patch);
    }
  }

  // Apply from the end. Applying from the start would shift the following positions
  // by the line-count change of each patch already applied.
  for (let index = patches.length - 1; index >= 0; index -= 1) {
    const patch = patches[index];
    diskLines.splice(
      patch.disk.start,
      patch.disk.count,
      ...currentLines.slice(patch.currentStart, patch.currentEnd),
    );
  }

  return joinLines(diskLines);
}
