// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { discardUnhandledMessage } from '../../common/index';

describe('discarding unhandled messages', () => {
  it('does nothing and does not throw for a value with a type outside the contract', () => {
    // Messages from the view cross a trust boundary, so a value outside the contract can arrive at
    // runtime. The parameter is unreachable in the type system, so this test must explicitly bypass
    // type checking to create that situation.
    const outsideTheContract = { type: 'not-in-the-contract' } as unknown as never;

    expect(() => discardUnhandledMessage(outsideTheContract)).not.toThrow();
  });
});
