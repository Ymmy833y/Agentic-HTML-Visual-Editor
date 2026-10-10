// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseMessageCatalog } from '../../common/index';

describe('parsing a message catalog', () => {
  it('parses entries with string values', () => {
    expect(parseMessageCatalog('{"greeting":"Hello","count":"3"}')).toEqual({
      greeting: 'Hello',
      count: '3',
    });
  });

  it('filters out entries with non-string values', () => {
    expect(parseMessageCatalog('{"kept":"Message","number":1,"null":null,"boolean":false,"object":{},"array":[]}'))
      .toEqual({ kept: 'Message' });
  });

  it('returns an empty catalog without throwing for invalid JSON', () => {
    expect(parseMessageCatalog('{')).toEqual({});
  });

  it('returns an empty catalog for an empty string', () => {
    expect(parseMessageCatalog('')).toEqual({});
  });

  it.each(['[]', 'null'])('returns an empty catalog when top-level value %s is not an object', (text) => {
    expect(parseMessageCatalog(text)).toEqual({});
  });
});
