// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { MESSAGE_KEYS } from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import japaneseMessages from '../../messages/messages.ja.json';
import englishDeclarations from '../../package.nls.json';
import japaneseDeclarations from '../../package.nls.ja.json';

/**
 * Returns the `{name}` placeholders in a message, sorted.
 *
 * @param message The message to inspect. A non-string value is treated as having no placeholders.
 */
function readPlaceholders(message: unknown): string[] {
  return typeof message === 'string' ? (message.match(/\{[^{}]+\}/g) ?? []).sort() : [];
}

describe('Japanese message resource', () => {
  it('has a non-empty Japanese message for every message key', () => {
    const missingKeys = MESSAGE_KEYS.filter((key) => {
      const message: unknown = Reflect.get(japaneseMessages, key);
      return typeof message !== 'string' || message.length === 0;
    });

    expect(missingKeys).toEqual([]);
  });

  it('has no extra keys that are not defined message keys', () => {
    const definedKeys = new Set<string>(MESSAGE_KEYS);
    const extraKeys = Object.keys(japaneseMessages).filter((key) => !definedKeys.has(key));

    expect(extraKeys).toEqual([]);
  });

  it('gives every message the same placeholders as the English message', () => {
    const mismatchedKeys = MESSAGE_KEYS.filter(
      (key) => readPlaceholders(Reflect.get(japaneseMessages, key)).join()
        !== readPlaceholders(Reflect.get(englishMessages, key)).join(),
    );

    expect(mismatchedKeys).toEqual([]);
  });
});

describe('Japanese declaration resource', () => {
  it('has the same keys as the English declaration resource', () => {
    expect(Object.keys(japaneseDeclarations).sort()).toEqual(Object.keys(englishDeclarations).sort());
  });
});
