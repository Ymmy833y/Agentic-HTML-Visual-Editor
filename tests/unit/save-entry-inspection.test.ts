// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { SaveEntryRecorder } from '../../src/testing/save-entry-inspection';

describe('save entry inspection recording', () => {
  it('does not record save entry point calls when constructed as disabled', () => {
    const recorder = new SaveEntryRecorder(false);

    recorder.record('save', 'file:///document.html');

    expect(recorder.read()).toEqual({ calls: [] });
  });

  it('exposes the calls in the order they were received when constructed as enabled', () => {
    const recorder = new SaveEntryRecorder(true);

    recorder.record('save', 'file:///first.html');
    recorder.record('revert', 'file:///second.html');

    expect(recorder.read().calls.map(({ kind, documentUri }) => ({ kind, documentUri }))).toEqual([
      { kind: 'save', documentUri: 'file:///first.html' },
      { kind: 'revert', documentUri: 'file:///second.html' },
    ]);
  });
});
