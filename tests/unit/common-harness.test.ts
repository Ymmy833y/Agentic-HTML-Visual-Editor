// @vitest-environment node
// A representative test that only confirms the unit layer can load common straight from source.
// Case coverage for each piece of logic in common is written by the feature unit that implements it.
import { describe, expect, it } from 'vitest';

describe('unit layer startup path (common)', () => {
  it('imports the common entry point with no runtime environment', async () => {
    await expect(import('../../common/index')).resolves.toBeDefined();
  });

  it('has no document in the node environment, showing that common needs no DOM', () => {
    expect('document' in globalThis).toBe(false);
  });
});
