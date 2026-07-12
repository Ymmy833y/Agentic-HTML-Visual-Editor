import { describe, expect, it } from 'vitest';
import { mergeHistoryTransition } from '../../src/editor/history';

describe('mergeHistoryTransition', () => {
  it('undoes only the WYSIWYG edit while preserving later HTML changes', () => {
    const before = '<p>one</p>\n';
    const after = '<p>one</p>\n<p>visual</p>\n';
    const current = '<p>external</p>\n<p>one</p>\n<p>visual</p>\n';

    expect(mergeHistoryTransition(after, before, current)).toBe(
      '<p>external</p>\n<p>one</p>\n',
    );
  });

  it('redoes the WYSIWYG edit on top of a later HTML change', () => {
    const before = '<p>one</p>\n';
    const after = '<p>one</p>\n<p>visual</p>\n';
    const current = '<p>external</p>\n<p>one</p>\n';

    expect(mergeHistoryTransition(before, after, current)).toBe(
      '<p>external</p>\n<p>one</p>\n<p>visual</p>\n',
    );
  });

  it('undoes one repeated paste after save normalized LF snapshots to CRLF', () => {
    const afterTwoPastes =
      '  <h2>Level 2 heading</h2>\n' +
      '  <p>This is sample.</p>\n' +
      '  <p>This is sample.</p>\n' +
      '  <p>This is sample.</p>\n';
    const afterOnePaste =
      '  <h2>Level 2 heading</h2>\n' +
      '  <p>This is sample.</p>\n' +
      '  <p>This is sample.</p>\n';
    const savedCurrent = afterTwoPastes.replace(/\n/g, '\r\n');

    expect(mergeHistoryTransition(afterTwoPastes, afterOnePaste, savedCurrent)).toBe(
      afterOnePaste.replace(/\n/g, '\r\n'),
    );
  });
});
