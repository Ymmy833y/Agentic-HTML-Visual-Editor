// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { detectEncodingMismatch } from '../../src/editor/encoding-mismatch';

// Three Japanese characters in Shift_JIS. These bytes are not valid UTF-8.
const SHIFT_JIS_BYTES = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);
// What VS Code shows for those bytes when it reads them as UTF-8.
const MISDECODED_TEXT = '<p>\uFFFD\uFFFD{\uFFFD\uFFFD</p>';

describe('detecting an encoding mismatch', () => {
  it('reports a mismatch when the text has a replacement character and the bytes are not valid UTF-8', async () => {
    await expect(detectEncodingMismatch(MISDECODED_TEXT, () => Promise.resolve(SHIFT_JIS_BYTES)))
      .resolves.toBe(true);
  });

  it('reports no mismatch when the text has a replacement character but the bytes are valid UTF-8', async () => {
    const text = '<p>\uFFFD</p>';

    await expect(detectEncodingMismatch(text, () => Promise.resolve(new TextEncoder().encode(text))))
      .resolves.toBe(false);
  });

  it('reports no mismatch without reading the bytes when the text has no replacement character', async () => {
    const readBytes = vi.fn(() => Promise.resolve(SHIFT_JIS_BYTES));

    const detected = await detectEncodingMismatch('<p>日本語</p>', readBytes);

    expect([detected, readBytes.mock.calls.length]).toEqual([false, 0]);
  });

  it('reports no mismatch when the bytes cannot be read', async () => {
    await expect(detectEncodingMismatch(MISDECODED_TEXT, () => Promise.reject(new Error('The file could not be read'))))
      .resolves.toBe(false);
  });
});
