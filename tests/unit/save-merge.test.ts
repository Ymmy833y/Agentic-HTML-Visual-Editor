// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { mergeSaveCandidate } from '../../src/save/save-merge';

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
