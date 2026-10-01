import type { MessageCatalog, MessageParams } from './message-catalog';
import type { MessageKey } from './message-key';

/** Resolves messages. */
export interface Localizer {
  /**
   * Resolves the message for a key.
   *
   * @param key The message key.
   * @param params Values to substitute for placeholders.
   * @returns The resolved message.
   */
  getMessage(key: MessageKey, params?: MessageParams): string;
}

/**
 * Resolves a message from a catalog.
 *
 * @param catalog The message catalog.
 * @param key The message key.
 * @param params Values to substitute for placeholders.
 * @returns The resolved message, or the key if no message is registered.
 */
export function resolveMessage(
  catalog: MessageCatalog,
  key: string,
  params?: MessageParams,
): string {
  const template = Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : key;

  return template.replace(/\{([^{}]+)\}/g, (placeholder, name: string) => {
    if (params === undefined || !Object.prototype.hasOwnProperty.call(params, name)) {
      return placeholder;
    }
    return String(params[name]);
  });
}

/**
 * Creates a localizer bound to the specified catalog.
 *
 * @param catalog The message catalog.
 * @returns The localizer.
 */
export function createLocalizer(catalog: MessageCatalog): Localizer {
  return {
    getMessage(key, params) {
      return resolveMessage(catalog, key, params);
    },
  };
}
