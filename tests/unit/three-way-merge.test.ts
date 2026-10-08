// @vitest-environment node
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { CONFLICT_CHOICE, flattenMergeRegions, mergeThreeWay } from '../../common/index';
import type { MergeResult } from '../../common/index';

/**
 * Concatenates the selected side of each region.
 *
 * Reconstructing the body is the first invariant to fail if the coordinate calculation that extracts each
 * side of a conflict region breaks, so complex region cases verify it as well.
 */
const concatenate = (result: MergeResult, side: 'source' | 'view'): readonly string[] =>
  result.regions.flatMap((region) => (region.kind === 'stable' ? region.lines : region[side]));

describe('three-way merge', () => {
  it('returns one stable region when all three inputs match', () => {
    const lines = ['<p>a</p>', '<p>b</p>', ''];

    const result = mergeThreeWay(lines, lines, lines);

    expect(result).toEqual({ regions: [{ kind: 'stable', lines }], hasConflict: false });
  });

  it('returns the single empty line as a stable region when all three documents are empty', () => {
    const result = mergeThreeWay([''], [''], ['']);

    expect(result).toEqual({ regions: [{ kind: 'stable', lines: [''] }], hasConflict: false });
  });

  it('treats a line containing CR as one line and preserves the CR', () => {
    const result = mergeThreeWay(['<p>a</p>\r'], ['<p>a</p>\r'], ['<p>A</p>\r']);

    expect(result.regions).toEqual([{ kind: 'stable', lines: ['<p>A</p>\r'] }]);
  });

  it('keeps only the other side when one side matches the base', () => {
    const base = ['<p>a</p>', '<p>b</p>', ''];
    const view = ['<p>a</p>', '<p>B</p>', ''];

    const result = mergeThreeWay(base, base, view);

    expect(result.regions).toEqual([{ kind: 'stable', lines: view }]);
  });

  it('keeps only the post-deletion content when one side deletes every line', () => {
    const base = ['<p>a</p>', '<p>b</p>', ''];

    const result = mergeThreeWay(base, [''], base);

    expect(result.regions).toEqual([{ kind: 'stable', lines: [''] }]);
  });

  it('does not mutate the input arrays', () => {
    const base = ['<p>a</p>', '<p>b</p>', '<p>c</p>'];
    const source = ['<p>A</p>', '<p>b</p>', '<p>c</p>'];
    const view = ['<p>a</p>', '<p>b</p>', '<p>C</p>'];

    mergeThreeWay(base, source, view);

    expect(base).toEqual(['<p>a</p>', '<p>b</p>', '<p>c</p>']);
    expect(source).toEqual(['<p>A</p>', '<p>b</p>', '<p>c</p>']);
    expect(view).toEqual(['<p>a</p>', '<p>b</p>', '<p>C</p>']);
  });

  it('merges distant concurrent edits in 5,000 duplicate lines within one second', () => {
    const base = Array.from({ length: 5_000 }, () => '<tr></tr>');
    const source = [...base];
    source[0] = '<tr><td>source</td></tr>';
    const view = [...base];
    view[4_999] = '<tr><td>view</td></tr>';

    const startedAt = performance.now();
    const result = mergeThreeWay(base, source, view);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(result.hasConflict).toBe(false);
  });

  it('preserves both changes when the sides edit two separate locations', () => {
    const base = ['<h1>T</h1>', '<p>a</p>', '<p>b</p>', '<p>c</p>', ''];
    const source = ['<h1>Title</h1>', '<p>a</p>', '<p>b</p>', '<p>c</p>', ''];
    const view = ['<h1>T</h1>', '<p>a</p>', '<p>b</p>', '<p>c!</p>', ''];

    const result = mergeThreeWay(base, source, view);

    expect(result.regions).toEqual([
      { kind: 'stable', lines: ['<h1>Title</h1>', '<p>a</p>', '<p>b</p>', '<p>c!</p>', ''] },
    ]);
  });

  it('returns a conflict region with three line arrays when both sides change the same line differently', () => {
    const base = ['<p>a</p>', '<p>b</p>', '<p>c</p>'];
    const source = ['<p>a</p>', '<p>B1</p>', '<p>c</p>'];
    const view = ['<p>a</p>', '<p>B2</p>', '<p>c</p>'];

    const result = mergeThreeWay(base, source, view);

    expect(result.regions).toEqual([
      { kind: 'stable', lines: ['<p>a</p>'] },
      {
        kind: 'conflict',
        base: ['<p>b</p>'],
        source: ['<p>B1</p>'],
        view: ['<p>B2</p>'],
      },
      { kind: 'stable', lines: ['<p>c</p>'] },
    ]);
  });

  it('reconstructs one side\'s complete body by selecting that side from each region', () => {
    const base = ['<p>a</p>', '<p>b</p>', '<p>c</p>'];
    const source = ['<p>a</p>', '<p>B1</p>', '<p>c</p>'];
    const view = ['<p>a</p>', '<p>B2</p>', '<p>c</p>'];

    const result = mergeThreeWay(base, source, view);

    expect(concatenate(result, 'source')).toEqual(source);
    expect(concatenate(result, 'view')).toEqual(view);
  });

  it('keeps changes that only touch at their base boundaries apart as one stable region', () => {
    const base = ['<p>a</p>', '<p>b</p>'];
    const source = ['<p>A</p>', '<p>b</p>'];
    const view = ['<p>a</p>', '<p>B</p>'];

    const result = mergeThreeWay(base, source, view);

    expect(result).toEqual({
      regions: [{ kind: 'stable', lines: ['<p>A</p>', '<p>B</p>'] }],
      hasConflict: false,
    });
  });

  it('returns a conflict region when one side changes a line and the other inserts right after it', () => {
    const base = ['<p>a</p>', '<p>b</p>'];
    const source = ['<p>A</p>', '<p>b</p>'];
    const view = ['<p>a</p>', '<p>v</p>', '<p>b</p>'];

    const result = mergeThreeWay(base, source, view);

    expect(result.regions[0]).toEqual({
      kind: 'conflict',
      base: ['<p>a</p>'],
      source: ['<p>A</p>'],
      view: ['<p>a</p>', '<p>v</p>'],
    });
    expect(concatenate(result, 'source')).toEqual(source);
    expect(concatenate(result, 'view')).toEqual(view);
  });

  it('returns a conflict region when one side changes a line and the other inserts right before it', () => {
    // The source side inserts: its hunks join a group first, so the changed line has to join a group that holds
    // only the insertion point.
    const base = ['<p>a</p>', '<p>b</p>'];
    const source = ['<p>a</p>', '<p>s</p>', '<p>b</p>'];
    const view = ['<p>a</p>', '<p>B</p>'];

    const result = mergeThreeWay(base, source, view);

    expect(result.regions[1]).toEqual({
      kind: 'conflict',
      base: ['<p>b</p>'],
      source: ['<p>s</p>', '<p>b</p>'],
      view: ['<p>B</p>'],
    });
    expect(concatenate(result, 'source')).toEqual(source);
    expect(concatenate(result, 'view')).toEqual(view);
  });

  it('keeps both changes when one side deletes a line and the other changes the line next to it', () => {
    const base = ['<p>a</p>', '<p>b</p>', '<p>c</p>'];
    const source = ['<p>b</p>', '<p>c</p>'];
    const view = ['<p>a</p>', '<p>B</p>', '<p>c</p>'];

    const result = mergeThreeWay(base, source, view);

    expect(result).toEqual({
      regions: [{ kind: 'stable', lines: ['<p>B</p>', '<p>c</p>'] }],
      hasConflict: false,
    });
  });

  it('leaves the deleting side empty when one side deletes a line that the other changes', () => {
    const base = ['<p>a</p>', '<p>b</p>', '<p>c</p>'];
    const source = ['<p>a</p>', '<p>c</p>'];
    const view = ['<p>a</p>', '<p>B</p>', '<p>c</p>'];

    const result = mergeThreeWay(base, source, view);

    expect(result.regions[1]).toEqual({
      kind: 'conflict',
      base: ['<p>b</p>'],
      source: [],
      view: ['<p>B</p>'],
    });
  });

  it('groups multiple hunks with chained overlaps into one conflict region', () => {
    // The source changes a,b and d; the view changes b,c,d into one line. Each view hunk overlaps a source hunk, so
    // the chain closes over the first four lines.
    const base = ['<p>a</p>', '<p>b</p>', '<p>c</p>', '<p>d</p>', '<p>e</p>'];
    const source = ['<p>A</p>', '<p>B</p>', '<p>c</p>', '<p>D</p>', '<p>e</p>'];
    const view = ['<p>a</p>', '<p>X</p>', '<p>e</p>'];

    const result = mergeThreeWay(base, source, view);

    expect(result.regions).toEqual([
      {
        kind: 'conflict',
        base: ['<p>a</p>', '<p>b</p>', '<p>c</p>', '<p>d</p>'],
        source: ['<p>A</p>', '<p>B</p>', '<p>c</p>', '<p>D</p>'],
        view: ['<p>a</p>', '<p>X</p>'],
      },
      { kind: 'stable', lines: ['<p>e</p>'] },
    ]);
    expect(concatenate(result, 'source')).toEqual(source);
    expect(concatenate(result, 'view')).toEqual(view);
  });

  it('returns a conflict region with an empty base when both sides insert at the same position', () => {
    const base = ['<p>a</p>', '<p>b</p>'];
    const source = ['<p>a</p>', '<p>s</p>', '<p>b</p>'];
    const view = ['<p>a</p>', '<p>v</p>', '<p>b</p>'];

    const result = mergeThreeWay(base, source, view);

    expect(result.regions[1]).toEqual({
      kind: 'conflict',
      base: [],
      source: ['<p>s</p>'],
      view: ['<p>v</p>'],
    });
    expect(concatenate(result, 'source')).toEqual(source);
    expect(concatenate(result, 'view')).toEqual(view);
  });

  it('expands a conflict region through unchanged lines when the sides have different hunk ranges', () => {
    const base = ['<h1>T</h1>', '<p>a</p>', '<p>b</p>', '<p>c</p>', ''];
    const source = ['<h1>Title</h1>', '<p>a</p>', '<p>b</p>', '<p>C</p>', ''];
    const view = ['<h1>T</h1>', '<p>a</p>', '<p>B</p>', '<p>c!</p>', ''];

    const result = mergeThreeWay(base, source, view);

    expect(result.regions[1]).toEqual({
      kind: 'conflict',
      base: ['<p>b</p>', '<p>c</p>'],
      source: ['<p>b</p>', '<p>C</p>'],
      view: ['<p>B</p>', '<p>c!</p>'],
    });
    expect(concatenate(result, 'source')).toEqual(source);
    // The source-side <h1> change is outside the conflict, so it remains when the view side is selected.
    expect(concatenate(result, 'view')).toEqual([
      '<h1>Title</h1>',
      '<p>a</p>',
      '<p>B</p>',
      '<p>c!</p>',
      '',
    ]);
  });

  it('returns one stable region without a conflict when both sides make the same change', () => {
    const base = ['<p>a</p>', '<p>b</p>', '<p>c</p>'];
    const edited = ['<p>a</p>', '<p>B</p>', '<p>c</p>'];

    const result = mergeThreeWay(base, edited, edited);

    expect(result).toEqual({ regions: [{ kind: 'stable', lines: edited }], hasConflict: false });
  });

  it('sets hasConflict when the result contains a conflict region', () => {
    const result = mergeThreeWay(
      ['<p>a</p>', '<p>b</p>', '<p>c</p>'],
      ['<p>a</p>', '<p>B1</p>', '<p>c</p>'],
      ['<p>a</p>', '<p>B2</p>', '<p>c</p>'],
    );

    expect(result.hasConflict).toBe(true);
  });

  it('does not return adjacent stable regions', () => {
    const base = ['<h1>T</h1>', '<p>a</p>', '<p>b</p>', '<p>c</p>', ''];
    const source = ['<h1>Title</h1>', '<p>a</p>', '<p>b</p>', '<p>C</p>', ''];
    const view = ['<h1>T</h1>', '<p>a</p>', '<p>B</p>', '<p>c!</p>', ''];

    const result = mergeThreeWay(base, source, view);

    expect(result.regions.map((region) => region.kind)).toEqual(['stable', 'conflict', 'stable']);
  });

  it('lists all source lines followed by all view lines exactly once for a conflict region', () => {
    const flattened = flattenMergeRegions([
      { kind: 'stable', lines: ['<body>'] },
      { kind: 'conflict', base: ['<p>b</p>'], source: ['<p>s1</p>', '<p>s2</p>'], view: ['<p>v</p>'] },
      { kind: 'stable', lines: ['</body>', ''] },
    ]);

    // The base side is dropped. Git-style markers are not inserted because they would break the HTML.
    expect(flattened).toBe(
      ['<body>', '<p>s1</p>', '<p>s2</p>', '<p>v</p>', '</body>', ''].join('\n'),
    );
  });

  it('places the source lines of a region chosen as source and the view lines of a region chosen as view', () => {
    const flattened = flattenMergeRegions(
      [
        { kind: 'stable', lines: ['<body>'] },
        { kind: 'conflict', base: ['<p>a</p>'], source: ['<p>s1</p>'], view: ['<p>v1</p>'] },
        { kind: 'stable', lines: ['<hr>'] },
        { kind: 'conflict', base: ['<p>b</p>'], source: ['<p>s2</p>'], view: ['<p>v2</p>'] },
        { kind: 'stable', lines: ['</body>', ''] },
      ],
      [CONFLICT_CHOICE.source, CONFLICT_CHOICE.view],
    );

    expect(flattened).toBe(['<body>', '<p>s1</p>', '<hr>', '<p>v2</p>', '</body>', ''].join('\n'));
  });

  it('places the source lines followed by the view lines for a region chosen as both', () => {
    const flattened = flattenMergeRegions(
      [
        { kind: 'stable', lines: ['<body>'] },
        { kind: 'conflict', base: [], source: ['<p>s</p>'], view: ['<p>v1</p>', '<p>v2</p>'] },
        { kind: 'stable', lines: ['</body>', ''] },
      ],
      [CONFLICT_CHOICE.both],
    );

    expect(flattened).toBe(['<body>', '<p>s</p>', '<p>v1</p>', '<p>v2</p>', '</body>', ''].join('\n'));
  });

  it('throws when the number of choices differs from the number of conflict regions', () => {
    const regions = [
      { kind: 'stable', lines: ['<body>'] },
      { kind: 'conflict', base: ['<p>a</p>'], source: ['<p>s</p>'], view: ['<p>v</p>'] },
      { kind: 'stable', lines: ['</body>', ''] },
    ] as const;

    expect(() => flattenMergeRegions(regions, [CONFLICT_CHOICE.source, CONFLICT_CHOICE.view])).toThrow(RangeError);
  });
});
