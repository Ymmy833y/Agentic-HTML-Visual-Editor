export type MessageCatalog = Readonly<Record<string, string>>;

export type MessageParams = Readonly<Record<string, string | number>>;

export const MESSAGE_CATALOG_ELEMENT_ID = 'ahve-message-catalog';

/**
 * Parses JSON text into a message catalog.
 *
 * @param text The JSON text to parse.
 * @returns The parsed catalog, or an empty catalog if the text is invalid.
 */
export function parseMessageCatalog(text: string): MessageCatalog {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }

    const entries: Array<readonly [string, string]> = [];
    for (const key of Object.keys(parsed)) {
      const value: unknown = Object.getOwnPropertyDescriptor(parsed, key)?.value;
      if (typeof value === 'string') {
        entries.push([key, value]);
      }
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}
