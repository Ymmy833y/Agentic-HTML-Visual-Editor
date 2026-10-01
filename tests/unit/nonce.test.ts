// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createNonce } from '../../src/security/nonce';

describe('nonce', () => {
  it('returns a different value on every consecutive call', () => {
    const values = new Set(Array.from({ length: 100 }, () => createNonce()));

    expect(values.size).toBe(100);
  });

  it('returns an alphanumeric value long enough to resist guessing', () => {
    expect(createNonce()).toMatch(/^[A-Za-z0-9]{32,}$/);
  });
});
