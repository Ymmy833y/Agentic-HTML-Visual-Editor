// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  detectLineEnding,
  normalizeLineEndings,
  restoreLineEndings,
} from '../../common/index';

describe('normalizing and restoring line endings', () => {
  it('restores CRLF-only text after normalizing and restoring it', () => {
    const text = 'a\r\nb\r\n';
    const lineEnding = detectLineEnding(text);

    expect(restoreLineEndings(normalizeLineEndings(text), lineEnding)).toBe(text);
  });

  it('leaves LF-only text unchanged by both normalizing and restoring', () => {
    const text = 'a\nb\n';

    expect(restoreLineEndings(normalizeLineEndings(text), detectLineEnding(text))).toBe(text);
  });

  it('unifies a lone CR to LF', () => {
    expect(normalizeLineEndings('a\rb\r')).toBe('a\nb\n');
  });

  it('chooses CRLF in mixed text when it occurs more often', () => {
    expect(detectLineEnding('a\r\nb\r\nc\nd')).toBe('crlf');
  });

  it('chooses LF in mixed text when lone LF and lone CR together occur more often', () => {
    expect(detectLineEnding('a\r\nb\nc\rd')).toBe('lf');
  });

  it('chooses LF when both occur the same number of times', () => {
    expect(detectLineEnding('a\r\nb\nc')).toBe('lf');
  });

  it('detects text without line breaks as LF', () => {
    expect(detectLineEnding('a')).toBe('lf');
  });

  it('keeps the BOM in text that has one', () => {
    expect(normalizeLineEndings('\uFEFFa\r\n')).toBe('\uFEFFa\n');
  });

  it('leaves text without a line break on the last line without one after restoring', () => {
    expect(restoreLineEndings('a\nb', 'crlf')).toBe('a\r\nb');
  });
});
