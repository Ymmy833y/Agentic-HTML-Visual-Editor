// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createLocalizer, resolveMessage } from '../../common/index';

describe('message resolution', () => {
  it('returns the message for a key in the catalog', () => {
    expect(resolveMessage({ greeting: 'Hello' }, 'greeting')).toBe('Hello');
  });

  it('returns the key itself when it is missing from the catalog', () => {
    expect(resolveMessage({}, 'missing')).toBe('missing');
  });

  it('substitutes strings and numbers into placeholders', () => {
    expect(resolveMessage(
      { summary: '{name} has {count} entries' },
      'summary',
      { name: 'Item', count: 3 },
    )).toBe('Item has 3 entries');
  });

  it('leaves a placeholder unchanged when no value is provided', () => {
    expect(resolveMessage({ greeting: 'Hello, {name}' }, 'greeting')).toBe('Hello, {name}');
  });

  it('returns an empty message without falling back to the key', () => {
    expect(resolveMessage({ empty: '' }, 'empty')).toBe('');
  });

  it('resolves from the bound catalog using the same rules', () => {
    const localizer = createLocalizer({ greeting: 'Hello, {name}' });

    // The public key set is still empty, so verify runtime delegation independently of
    // the type constraint.
    expect(Reflect.apply(localizer.getMessage, localizer, ['greeting', { name: 'User' }]))
      .toBe('Hello, User');
  });
});
