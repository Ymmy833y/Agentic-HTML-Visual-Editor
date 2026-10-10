// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { buildBodyOutput, createLineMapping, splitLines } from '../../common/index';

function output(disk: string, baseline: string, current: string): string {
  return buildBodyOutput(
    disk,
    baseline,
    current,
    createLineMapping(splitLines(disk), splitLines(baseline)),
  );
}

describe('building the body output', () => {
  it('leaves the disk body unchanged down to the character when there is no edit', () => {
    const disk = '<img src="a.png"/>\n<p>a</p>';
    const baseline = '<img src="a.png">\n<p>a</p>';

    expect(output(disk, baseline, baseline)).toBe(disk);
  });

  it('keeps the other lines in their disk spelling when one line is edited', () => {
    const disk = '<img src="a.png"/>\n<p>a</p>';
    const baseline = '<img src="a.png">\n<p>a</p>';

    expect(output(disk, baseline, '<img src="a.png">\n<p>b</p>')).toBe(
      '<img src="a.png"/>\n<p>b</p>',
    );
  });

  it('loses no body content when one line is edited in a document whose line counts differ', () => {
    const disk = '<pre>\nnpm test\n</pre>\n<p>a</p>';
    const baseline = '<pre>npm test\n</pre>\n<p>a</p>';

    expect(output(disk, baseline, '<pre>npm test\n</pre>\n<p>b</p>')).toBe(
      '<pre>\nnpm test\n</pre>\n<p>b</p>',
    );
  });

  it('keeps the matching disk line when the line right before a zero-baseline-line segment is edited', () => {
    const disk = 'a\nx\nb';
    const baseline = 'a\nb';

    expect(output(disk, baseline, 'A\nb')).toBe('A\nx\nb');
  });

  it('keeps the matching disk line when the line right after a zero-baseline-line segment is edited', () => {
    const disk = 'a\nx\nb';
    const baseline = 'a\nb';

    expect(output(disk, baseline, 'a\nB')).toBe('a\nx\nB');
  });

  it('puts two edits far apart at their matching positions', () => {
    const disk = '<p>a</p>\n<img src="a.png"/>\n<p>c</p>';
    const baseline = '<p>a</p>\n<img src="a.png">\n<p>c</p>';
    const current = '<p>A</p>\n<img src="a.png">\n<p>C</p>';

    expect(output(disk, baseline, current)).toBe(
      '<p>A</p>\n<img src="a.png"/>\n<p>C</p>',
    );
  });

  it('does not duplicate the unedited line right after a replacement and a deletion in the same mapping segment', () => {
    const disk = '<IMG src="a.png"/>\n<P>B2</P>\n<BR/>\n<p>tail</p>';
    const baseline = '<img src="a.png">\n<p>B2</p>\n<br>\n<p>tail</p>';
    const current = '<img alt="c" src="a.png">\n<p>B2</p>\n<p>tail</p>';

    expect(output(disk, baseline, current)).toBe(current);
  });

  it.each([
    {
      name: 'a replacement in front and a deletion behind',
      current: 'C0\nB1\ntail',
    },
    {
      name: 'a deletion in front and a replacement behind',
      current: 'B1\nC2\ntail',
    },
    {
      name: 'deletions in front and behind',
      current: 'B1\ntail',
    },
    {
      name: 'an increase in line count in front and a deletion behind',
      current: 'C0a\nC0b\nB1\ntail',
    },
    {
      name: 'a deletion in front and an increase in line count behind',
      current: 'B1\nC2a\nC2b\ntail',
    },
    {
      name: 'an insertion inside the segment and a deletion behind',
      current: 'B0\ninserted\nB1\ntail',
    },
    {
      name: 'a replacement in front and an insertion inside the segment',
      current: 'C0\nB1\ninserted\nB2\ntail',
    },
  ])('applies several edits in the same mapping segment as a single replacement: $name', ({ current }) => {
    const disk = 'D0\nD1\nD2\ntail';
    const baseline = 'B0\nB1\nB2\ntail';

    expect(output(disk, baseline, current)).toBe(current);
  });

  it('applies three hunks in the same mapping segment as a single replacement', () => {
    const disk = 'D0\nD1\nD2\nD3\nD4\ntail';
    const baseline = 'B0\nB1\nB2\nB3\nB4\ntail';
    const current = 'C0\nB1\nC2\nB3\ntail';

    expect(output(disk, baseline, current)).toBe(current);
  });

  it('outputs the current form as it is when the disk body is empty', () => {
    expect(output('', '', '<p>a</p>')).toBe('<p>a</p>');
  });

  it('puts a line appended at the end of the baseline at the end of the disk body', () => {
    const disk = '<img src="a.png"/>\n<p>a</p>';
    const baseline = '<img src="a.png">\n<p>a</p>';
    const current = '<img src="a.png">\n<p>a</p>\n<p>b</p>';

    expect(output(disk, baseline, current)).toBe(
      '<img src="a.png"/>\n<p>a</p>\n<p>b</p>',
    );
  });

  it('produces the same output when rebuilt with that output as the new disk body', () => {
    const first = output('<p>a</p>', '<p>a</p>', '<p>b</p>');

    expect(output(first, '<p>b</p>', '<p>b</p>')).toBe(first);
  });
});
