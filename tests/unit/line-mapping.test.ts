// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createLineMapping, mapToDisk } from '../../common/index';
import type { LineMapping } from '../../common/index';

describe('line mapping', () => {
  it('is empty and maps positions unchanged when there is no difference', () => {
    const mapping = createLineMapping(['a', 'b'], ['a', 'b']);

    expect(mapping).toEqual([]);
    expect(mapToDisk(mapping, { start: 1, count: 1 })).toEqual({ start: 1, count: 1 });
  });

  it('shifts the following lines by the line-count difference when the line break right after pre is dropped', () => {
    const mapping = createLineMapping(
      ['<pre>', 'npm test', '</pre>', '<p>a</p>'],
      ['<pre>npm test', '</pre>', '<p>a</p>'],
    );

    expect(mapToDisk(mapping, { start: 2, count: 1 })).toEqual({ start: 3, count: 1 });
  });

  it('widens a partially overlapping range to the whole differing segment', () => {
    const mapping = createLineMapping(
      ['head', 'disk-a', 'disk-b', 'tail'],
      ['head', 'base-a', 'base-b', 'tail'],
    );

    expect(mapToDisk(mapping, { start: 2, count: 1 })).toEqual({ start: 1, count: 2 });
  });

  it('widens a range overlapping several segments from the first to the last of them', () => {
    const mapping: LineMapping = [
      { disk: { start: 1, count: 2 }, baseline: { start: 1, count: 1 } },
      { disk: { start: 5, count: 1 }, baseline: { start: 4, count: 2 } },
    ];

    expect(mapToDisk(mapping, { start: 1, count: 5 })).toEqual({ start: 1, count: 5 });
  });

  it('maps an append at the end of the baseline to a zero-line range at the end of the disk body', () => {
    const mapping = createLineMapping(['disk-a', 'disk-b', 'tail'], ['base', 'tail']);

    expect(mapToDisk(mapping, { start: 2, count: 0 })).toEqual({ start: 3, count: 0 });
  });

  it('maps the start of a range to right after a line that exists only on the disk side', () => {
    const mapping = createLineMapping(['a', 'disk-only', 'b'], ['a', 'b']);

    expect(mapToDisk(mapping, { start: 1, count: 1 })).toEqual({ start: 2, count: 1 });
  });
});
