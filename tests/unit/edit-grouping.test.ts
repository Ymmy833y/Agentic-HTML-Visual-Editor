import { describe, expect, it } from 'vitest';

import {
  TRANSACTION_IDLE_MS,
  classifyEditKind,
  decideEditBoundary,
} from '../../webview/history/edit-grouping';

describe('edit kind classification', () => {
  it.each(['insertText', 'insertCompositionText'])('classifies %s as typing', (editKind) => {
    expect(classifyEditKind(editKind)).toBe('typing');
  });

  it('classifies single-character backward and forward deletion as different grouping kinds', () => {
    expect([
      classifyEditKind('deleteContentBackward'),
      classifyEditKind('deleteContentForward'),
    ]).toEqual(['deleteBackward', 'deleteForward']);
  });

  it.each([
    'deleteWordBackward',
    'deleteWordForward',
    'deleteSoftLineBackward',
    'deleteSoftLineForward',
    'deleteHardLineBackward',
    'deleteHardLineForward',
    'insertParagraph',
    'insertFromPaste',
    'applyBlockFormat',
  ])('classifies %s as a standalone edit', (editKind) => {
    expect(classifyEditKind(editKind)).toBe('single');
  });
});

describe('edit transaction boundary decisions', () => {
  const pending = { kind: 'typing' as const, deadline: TRANSACTION_IDLE_MS };

  it('continues when the same grouping kind occurs immediately before the timeout', () => {
    expect(decideEditBoundary(pending, 'typing', TRANSACTION_IDLE_MS - 1)).toBe('continue');
  });

  it('returns a timeout boundary for the same grouping kind exactly at the timeout', () => {
    expect(decideEditBoundary(pending, 'typing', TRANSACTION_IDLE_MS)).toBe('idleBoundary');
  });

  it('returns a kind boundary when the grouping kind changes before the timeout', () => {
    expect(decideEditBoundary(pending, 'deleteBackward', 1)).toBe('kindBoundary');
  });
});
