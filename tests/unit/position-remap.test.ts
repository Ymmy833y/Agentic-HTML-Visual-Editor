import { describe, expect, it } from 'vitest';

import { splitLines } from '../../common/index';
import { remapPosition, remapSelection } from '../../webview/selection/position-remap';

const OLD_TEXT = '<p>a</p>\n<p>bcdef</p>\n<p>g</p>';

describe('remapping one position', () => {
  it('increments the line while preserving the column when a preceding line is added', () => {
    const newText = `<p>x</p>\n${OLD_TEXT}`;

    const remapped = remapPosition(
      { line: 1, column: 5 },
      splitLines(OLD_TEXT),
      splitLines(newText),
    );

    expect(remapped).toEqual({ line: 2, column: 5 });
  });

  it('preserves both line and column when the text has no differences', () => {
    const lines = splitLines(OLD_TEXT);

    expect(remapPosition({ line: 1, column: 5 }, lines, lines)).toEqual({ line: 1, column: 5 });
  });

  it('clamps a position within a changed line segment to the segment start', () => {
    const newText = '<p>a</p>\n<p>CHANGED</p>\n<p>g</p>';

    const remapped = remapPosition(
      { line: 1, column: 5 },
      splitLines(OLD_TEXT),
      splitLines(newText),
    );

    expect(remapped).toEqual({ line: 1, column: 0 });
  });

  it('clamps to the end of the preceding line when the entire line is deleted', () => {
    const newText = '<p>a</p>\n<p>g</p>';

    const remapped = remapPosition(
      { line: 1, column: 5 },
      splitLines(OLD_TEXT),
      splitLines(newText),
    );

    expect(remapped).toEqual({ line: 0, column: '<p>a</p>'.length });
  });

  it('clamps to the new start when the first line is deleted with no preceding line', () => {
    const newText = '<p>bcdef</p>\n<p>g</p>';

    const remapped = remapPosition(
      { line: 0, column: 3 },
      splitLines(OLD_TEXT),
      splitLines(newText),
    );

    expect(remapped).toEqual({ line: 0, column: 0 });
  });

  it('clamps a position beyond the new line count to the end of the last line', () => {
    const newText = '<p>a</p>';

    const remapped = remapPosition(
      { line: 2, column: 3 },
      splitLines(OLD_TEXT),
      splitLines(newText),
    );

    expect(remapped).toEqual({ line: 0, column: '<p>a</p>'.length });
  });
});

describe('selection remapping', () => {
  it('does not remap when the new text is empty', () => {
    const selection = { start: { line: 0, column: 0 }, end: { line: 0, column: 3 } };

    expect(remapSelection(selection, OLD_TEXT, '')).toBeUndefined();
  });

  it('remaps range endpoints independently without reversing them through clamping', () => {
    // Only the line containing the start is deleted, while the end remains on an existing line.
    // The start is clamped to the end of the preceding line.
    const newText = '<p>a</p>\n<p>g</p>';
    const selection = { start: { line: 1, column: 5 }, end: { line: 2, column: 3 } };

    const remapped = remapSelection(selection, OLD_TEXT, newText);

    expect(remapped).toEqual({
      start: { line: 0, column: '<p>a</p>'.length },
      end: { line: 1, column: 3 },
    });
  });
});
