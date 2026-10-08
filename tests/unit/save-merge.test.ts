// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { CONFLICT_CHOICE } from '../../common/index';
import { flattenSaveCandidate, mergeSaveCandidate, mergeSaveRegions, mergeViewSide } from '../../src/save/save-merge';

const BASE = ['<body>', '<p>first</p>', '<p>second</p>', '</body>', ''].join('\n');

// Place a line between the two changes so that this case stays about changes that are apart. Adjacent changes have
// cases of their own below.
const SPACED_BASE = ['<body>', '<p>first</p>', '<hr>', '<p>second</p>', '</body>', ''].join('\n');

describe('non-overlapping changes', () => {
  it('preserves both source and view changes in the candidate', () => {
    const source = ['<body>', '<p>FIRST</p>', '<hr>', '<p>second</p>', '</body>', ''].join('\n');
    const view = ['<body>', '<p>first</p>', '<hr>', '<p>SECOND</p>', '</body>', ''].join('\n');

    const candidate = mergeSaveCandidate(SPACED_BASE, source, view);

    expect(candidate).toEqual({
      text: ['<body>', '<p>FIRST</p>', '<hr>', '<p>SECOND</p>', '</body>', ''].join('\n'),
      hasConflict: false,
    });
  });
});

describe('changes to adjacent lines', () => {
  it('replaces each paragraph in place without duplicating or breaking a line', () => {
    // The source edits the first paragraph and the view edits the paragraph right after it.
    const source = ['<body>', '<p>FIRST</p>', '<p>second</p>', '</body>', ''].join('\n');
    const view = ['<body>', '<p>first</p>', '<p>SECOND</p>', '</body>', ''].join('\n');

    const candidate = mergeSaveCandidate(BASE, source, view);

    expect(candidate).toEqual({
      text: ['<body>', '<p>FIRST</p>', '<p>SECOND</p>', '</body>', ''].join('\n'),
      hasConflict: false,
    });
  });
});

describe('changes to the same location', () => {
  it('places view lines immediately after source lines', () => {
    const source = ['<body>', '<p>from source</p>', '<p>second</p>', '</body>', ''].join('\n');
    const view = ['<body>', '<p>from view</p>', '<p>second</p>', '</body>', ''].join('\n');

    const candidate = mergeSaveCandidate(BASE, source, view);

    expect(candidate).toEqual({
      text: [
        '<body>',
        '<p>from source</p>',
        '<p>from view</p>',
        '<p>second</p>',
        '</body>',
        '',
      ].join('\n'),
      hasConflict: true,
    });
  });

  it('keeps every line of both sides intact when the same line conflicts', () => {
    const source = ['<body>', '<p>from source</p>', '<p>second</p>', '</body>', ''].join('\n');
    const view = ['<body>', '<p>from view</p>', '<p>second</p>', '</body>', ''].join('\n');

    const candidate = mergeSaveCandidate(BASE, source, view);

    // Every candidate line is a line of one of the two sides as written: nothing is split, joined or prefixed.
    const sideLines = new Set([...source.split('\n'), ...view.split('\n')]);
    expect(candidate.text.split('\n').filter((line) => !sideLines.has(line))).toEqual([]);
  });

  it('includes identical changes from both sides once without reporting a conflict', () => {
    const both = ['<body>', '<p>same</p>', '<p>second</p>', '</body>', ''].join('\n');

    const candidate = mergeSaveCandidate(BASE, both, both);

    expect(candidate).toEqual({ text: both, hasConflict: false });
  });

  it('places only the non-empty side when the other side empties a conflict region', () => {
    const source = ['<body>', '<p>second</p>', '</body>', ''].join('\n');
    const view = ['<body>', '<p>from view</p>', '<p>second</p>', '</body>', ''].join('\n');

    const candidate = mergeSaveCandidate(BASE, source, view);

    expect(candidate.text).toBe(
      ['<body>', '<p>from view</p>', '<p>second</p>', '</body>', ''].join('\n'),
    );
  });
});

describe('region concatenation', () => {
  it('includes all three inputs once in document order without duplication or omission', () => {
    // Only one side changes the start, both change the middle, and the other side changes the end.
    const base = [
      '<body>', '<p>first</p>', '<hr>', '<p>second</p>', '<hr>', '<p>third</p>', '</body>', '',
    ].join('\n');
    const source = [
      '<body>', '<p>FIRST</p>', '<hr>', '<p>s</p>', '<hr>', '<p>third</p>', '</body>', '',
    ].join('\n');
    const view = [
      '<body>', '<p>first</p>', '<hr>', '<p>v</p>', '<hr>', '<p>THIRD</p>', '</body>', '',
    ].join('\n');

    const candidate = mergeSaveCandidate(base, source, view);

    expect(candidate.text).toBe(
      [
        '<body>',
        '<p>FIRST</p>',
        '<hr>',
        '<p>s</p>',
        '<p>v</p>',
        '<hr>',
        '<p>THIRD</p>',
        '</body>',
        '',
      ].join('\n'),
    );
  });

  it('returns the identical full text without a conflict when all three inputs match', () => {
    const candidate = mergeSaveCandidate(BASE, BASE, BASE);

    expect(candidate).toEqual({ text: BASE, hasConflict: false });
  });

  it('places the view side after the source side for both conflicts when there are two', () => {
    const base = [
      '<body>', '<p>first</p>', '<hr>', '<p>second</p>', '</body>', '',
    ].join('\n');
    const source = [
      '<body>', '<p>s1</p>', '<hr>', '<p>s2</p>', '</body>', '',
    ].join('\n');
    const view = [
      '<body>', '<p>v1</p>', '<hr>', '<p>v2</p>', '</body>', '',
    ].join('\n');

    const candidate = mergeSaveCandidate(base, source, view);

    // Moving flattening into the common layer does not change the save candidate's full text.
    expect(candidate).toEqual({
      text: [
        '<body>', '<p>s1</p>', '<p>v1</p>', '<hr>', '<p>s2</p>', '<p>v2</p>', '</body>', '',
      ].join('\n'),
      hasConflict: true,
    });
  });
});

describe('choosing a side for each conflict region', () => {
  it('keeps the changes outside the conflicts and places the chosen lines in each conflict region', () => {
    const base = ['<h1>T</h1>', '<hr>', '<p>first</p>', '<hr>', '<p>second</p>', ''].join('\n');
    const source = ['<h1>Title</h1>', '<hr>', '<p>s1</p>', '<hr>', '<p>s2</p>', ''].join('\n');
    const view = ['<h1>T</h1>', '<hr>', '<p>v1</p>', '<hr>', '<p>v2</p>', ''].join('\n');

    const merged = mergeSaveRegions(base, source, view);
    const text = flattenSaveCandidate(merged.regions, [CONFLICT_CHOICE.view, CONFLICT_CHOICE.source]);

    expect(text).toBe(['<h1>Title</h1>', '<hr>', '<p>v1</p>', '<hr>', '<p>s2</p>', ''].join('\n'));
  });

  it('places only the chosen side, change marks included, when both sides carry change marks', () => {
    const marked = '<p>A <del data-author="ai" data-updated="2026-01-15T09:30:00.000Z">x</del>'
      + '<ins data-author="ai" data-updated="2026-01-15T09:30:00.000Z">y</ins></p>';
    const edited = '<p>A <ins data-author="human" data-updated="2026-01-15T10:00:00.000Z">z</ins></p>';
    const base = ['<body>', '<p>A x</p>', '</body>', ''].join('\n');
    const source = ['<body>', marked, '</body>', ''].join('\n');
    const view = ['<body>', edited, '</body>', ''].join('\n');

    const merged = mergeSaveRegions(base, source, view);
    const text = flattenSaveCandidate(merged.regions, [CONFLICT_CHOICE.source]);

    expect(text).toBe(['<body>', marked, '</body>', ''].join('\n'));
  });
});

describe('keeping the view side of every conflict region', () => {
  it('keeps the source changes outside the conflicts and the view lines in each conflict region', () => {
    const base = ['<h1>T</h1>', '<hr>', '<p>first</p>', '<hr>', '<p>second</p>', ''].join('\n');
    const source = ['<h1>Title</h1>', '<hr>', '<p>s1</p>', '<hr>', '<p>s2</p>', ''].join('\n');
    const view = ['<h1>T</h1>', '<hr>', '<p>v1</p>', '<hr>', '<p>v2</p>', ''].join('\n');

    expect(mergeViewSide(base, source, view)).toBe(
      ['<h1>Title</h1>', '<hr>', '<p>v1</p>', '<hr>', '<p>v2</p>', ''].join('\n'),
    );
  });

  it('returns the merge as is when nothing conflicts', () => {
    const source = ['<body>', '<p>FIRST</p>', '<hr>', '<p>second</p>', '</body>', ''].join('\n');
    const view = ['<body>', '<p>first</p>', '<hr>', '<p>SECOND</p>', '</body>', ''].join('\n');

    expect(mergeViewSide(SPACED_BASE, source, view)).toBe(mergeSaveCandidate(SPACED_BASE, source, view).text);
  });
});
