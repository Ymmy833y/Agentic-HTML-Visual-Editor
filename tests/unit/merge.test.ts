import { describe, expect, it } from 'vitest';
import { mergeHtml } from '../../src/editor/merge';

// Changes on adjacent lines fold into a single diff3 region, so the fixtures
// keep independently-edited lines separated by untouched ones.
const BASE = [
  '<body>',
  '<p>alpha</p>',
  '<p>beta</p>',
  '<p>gamma</p>',
  '<p>delta</p>',
  '<p>epsilon</p>',
  '</body>',
].join('\n');

describe('mergeHtml: fast paths', () => {
  it('returns ours untouched when the document has not changed (plain save)', () => {
    const ours = BASE.replace('alpha', 'ALPHA');
    expect(mergeHtml(BASE, ours, BASE)).toBe(ours);
  });

  it('returns theirs when the view has no changes', () => {
    const theirs = BASE.replace('beta', 'BETA');
    expect(mergeHtml(BASE, BASE, theirs)).toBe(theirs);
  });

  it('returns the shared text when both sides are identical', () => {
    const same = BASE.replace('gamma', 'GAMMA');
    expect(mergeHtml(BASE, same, same)).toBe(same);
  });
});

describe('mergeHtml: three-way merge', () => {
  it('combines non-overlapping changes from both sides', () => {
    const ours = BASE.replace('<p>alpha</p>', '<p>alpha edited in view</p>');
    const theirs = BASE.replace('<p>delta</p>', '<p>delta edited in document</p>');
    const merged = mergeHtml(BASE, ours, theirs);
    expect(merged).toBe(
      [
        '<body>',
        '<p>alpha edited in view</p>',
        '<p>beta</p>',
        '<p>gamma</p>',
        '<p>delta edited in document</p>',
        '<p>epsilon</p>',
        '</body>',
      ].join('\n'),
    );
  });

  it('merges an external insertion with a view edit elsewhere', () => {
    const ours = BASE.replace('alpha', 'ALPHA');
    const theirs = BASE.replace('<p>delta</p>', '<p>delta</p>\n<p>zeta</p>');
    const merged = mergeHtml(BASE, ours, theirs);
    expect(merged).toContain('<p>ALPHA</p>');
    expect(merged).toContain('<p>zeta</p>');
  });

  it('keeps a view deletion while preserving an unrelated external edit', () => {
    const ours = BASE.replace('<p>gamma</p>\n', '');
    const theirs = BASE.replace('alpha', 'ALPHA');
    const merged = mergeHtml(BASE, ours, theirs);
    expect(merged).not.toContain('gamma');
    expect(merged).toContain('<p>ALPHA</p>');
  });

  it('keeps both versions on a conflict, document side first', () => {
    const ours = BASE.replace('<p>gamma</p>', '<p>gamma from view</p>');
    const theirs = BASE.replace('<p>gamma</p>', '<p>gamma from document</p>');
    const merged = mergeHtml(BASE, ours, theirs);
    expect(merged).toBe(
      [
        '<body>',
        '<p>alpha</p>',
        '<p>beta</p>',
        '<p>gamma from document</p>',
        '<p>gamma from view</p>',
        '<p>delta</p>',
        '<p>epsilon</p>',
        '</body>',
      ].join('\n'),
    );
  });

  it('never emits git-style conflict markers', () => {
    const ours = BASE.replace('<p>gamma</p>', '<p>view</p>');
    const theirs = BASE.replace('<p>gamma</p>', '<p>document</p>');
    const merged = mergeHtml(BASE, ours, theirs);
    expect(merged).not.toMatch(/<{7}|={7}|>{7}/);
  });

  it('does not duplicate a change both sides made identically (false conflict)', () => {
    const both = BASE.replace('<p>gamma</p>', '<p>same change</p>');
    const ours = both.replace('alpha', 'ALPHA');
    const merged = mergeHtml(BASE, ours, both);
    expect(merged.match(/same change/g)).toHaveLength(1);
    expect(merged).toContain('<p>ALPHA</p>');
  });
});

describe('mergeHtml: reported scenario — insertions on both sides of the same line', () => {
  // The view appends a paragraph AFTER the shared line while the document
  // gains one BEFORE it. The insertion points differ relative to the common
  // "pen" line, so this must merge cleanly with no conflict and no loss.
  const base = ['<body>', '  <p>This is a pen.</p>', '</body>'].join('\n');
  const ours = [
    '<body>',
    '  <p>This is a pen.</p>',
    '  <p>This is a apple.</p>',
    '</body>',
  ].join('\n');
  const theirs = [
    '<body>',
    '  <p>This is a banana.</p>',
    '  <p>This is a pen.</p>',
    '</body>',
  ].join('\n');

  it('keeps both insertions: document-side before, view-side after', () => {
    expect(mergeHtml(base, ours, theirs)).toBe(
      [
        '<body>',
        '  <p>This is a banana.</p>',
        '  <p>This is a pen.</p>',
        '  <p>This is a apple.</p>',
        '</body>',
      ].join('\n'),
    );
  });

  it('merges the same scenario on a CRLF document whose view serialization uses LF', () => {
    // The document (base/theirs) uses CRLF line endings; the HTML parser
    // normalizes body text to LF, so the view serialization comes back with
    // LF between blocks. Line endings must not count as content differences —
    // otherwise the whole body degenerates into one giant pseudo-conflict.
    const baseCrlf = base.replace(/\n/g, '\r\n');
    const theirsCrlf = theirs.replace(/\n/g, '\r\n');
    const oursLf = ours; // serializer output: LF only

    expect(mergeHtml(baseCrlf, oursLf, theirsCrlf)).toBe(
      [
        '<body>',
        '  <p>This is a banana.</p>',
        '  <p>This is a pen.</p>',
        '  <p>This is a apple.</p>',
        '</body>',
      ].join('\r\n'),
    );
  });
});
