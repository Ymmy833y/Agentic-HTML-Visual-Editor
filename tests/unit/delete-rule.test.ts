import { describe, expect, it } from 'vitest';

import { readDeleteKind } from '../../webview/editing/delete-rule';

describe('reading the delete kind', () => {
  it('maps each of the eight delete input types to its direction, line-wise flag and granularity', () => {
    const inputTypes = [
      'deleteContentBackward',
      'deleteContentForward',
      'deleteWordBackward',
      'deleteWordForward',
      'deleteSoftLineBackward',
      'deleteSoftLineForward',
      'deleteHardLineBackward',
      'deleteHardLineForward',
    ];

    expect(inputTypes.map((inputType) => readDeleteKind(inputType))).toEqual([
      { backward: true, line: false, granularity: 'character' },
      { backward: false, line: false, granularity: 'character' },
      { backward: true, line: false, granularity: 'word' },
      { backward: false, line: false, granularity: 'word' },
      { backward: true, line: true, granularity: 'lineboundary' },
      { backward: false, line: true, granularity: 'lineboundary' },
      { backward: true, line: true, granularity: 'paragraphboundary' },
      { backward: false, line: true, granularity: 'paragraphboundary' },
    ]);
  });

  it('returns undefined for input types that are not deletes', () => {
    expect([readDeleteKind('insertText'), readDeleteKind('deleteByCut')]).toEqual([undefined, undefined]);
  });
});
