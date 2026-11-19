import { describe, expect, it } from 'vitest';

import { readHistoryKey } from '../../webview/ui/history-key';

describe('reading undo and redo keys', () => {
  it('reads Ctrl+Z and Cmd+Z as undo, Ctrl+Shift+Z and Ctrl+Y as redo, and the rest as neither', () => {
    const keys = [
      new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true }),
      new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', metaKey: true }),
      new KeyboardEvent('keydown', { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }),
      new KeyboardEvent('keydown', { key: 'y', code: 'KeyY', ctrlKey: true }),
      new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, altKey: true }),
      new KeyboardEvent('keydown', { key: 'Y', code: 'KeyY', ctrlKey: true, shiftKey: true }),
      new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ' }),
    ];

    expect(keys.map((event) => readHistoryKey(event))).toEqual([
      'undo',
      'undo',
      'redo',
      'redo',
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('reads the physical Z key as undo and the physical Y key as redo when the layout types no Latin letter on them', () => {
    const keys = [
      // Russian layout: я sits on the physical Z key, and н on the physical Y key.
      new KeyboardEvent('keydown', { key: 'я', code: 'KeyZ', ctrlKey: true }),
      new KeyboardEvent('keydown', { key: 'н', code: 'KeyY', ctrlKey: true }),
    ];

    expect(keys.map((event) => readHistoryKey(event))).toEqual(['undo', 'redo']);
  });

  it('reads a Latin letter from the character, whichever physical key types it', () => {
    const keys = [
      // German layout: Y sits on the physical Z key, and Z on the physical Y key.
      new KeyboardEvent('keydown', { key: 'y', code: 'KeyZ', ctrlKey: true }),
      new KeyboardEvent('keydown', { key: 'z', code: 'KeyY', ctrlKey: true }),
      // French layout: W sits on the physical Z key.
      new KeyboardEvent('keydown', { key: 'w', code: 'KeyZ', ctrlKey: true }),
    ];

    expect(keys.map((event) => readHistoryKey(event))).toEqual(['redo', 'undo', undefined]);
  });
});
