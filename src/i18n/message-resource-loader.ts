import * as vscode from 'vscode';

import { parseMessageCatalog } from '../../common/index';
import type { MessageCatalog } from '../../common/index';

declare const TextDecoder: {
  new (): {
    decode(input: Uint8Array): string;
  };
};

const ENGLISH_LOCALE = 'en';

/** A message catalog together with the locale it was actually resolved from. */
export interface ResolvedMessages {
  readonly locale: string;
  readonly catalog: MessageCatalog;
}

/**
 * Builds the resource file name for a locale.
 *
 * @param locale The locale to read messages for.
 * @returns The resource file name.
 */
function resourceFileName(locale: string): string {
  return `messages.${locale}.json`;
}

/**
 * Builds candidate locales from the display language.
 *
 * @param language The VS Code display language.
 * @returns Candidate locales ordered by exact match, base language, then English.
 */
function buildCandidateLocales(language: string): readonly string[] {
  const parts = language.trim().toLowerCase().split('-').filter((part) => part.length > 0);
  const candidates = new Set<string>();

  if (parts.length > 0) {
    candidates.add(parts.join('-'));
    candidates.add(parts[0]);
  }

  candidates.delete(ENGLISH_LOCALE);
  candidates.add(ENGLISH_LOCALE);
  return [...candidates];
}

/**
 * Reads a resource file as a message catalog.
 *
 * @param extensionUri The URI of the extension installation directory.
 * @param fileName The resource file name.
 * @returns The parsed catalog, or `undefined` if it is unavailable.
 */
async function readCatalogFile(
  extensionUri: vscode.Uri,
  fileName: string,
): Promise<MessageCatalog | undefined> {
  try {
    const resourceUri = vscode.Uri.joinPath(extensionUri, 'messages', fileName);
    const bytes = await vscode.workspace.fs.readFile(resourceUri);
    const catalog = parseMessageCatalog(new TextDecoder().decode(bytes));
    return Object.keys(catalog).length > 0 ? catalog : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the messages for the display language.
 *
 * The locale is taken from the resource that was actually read, not from the display language, so
 * that it still describes the wording after a fallback.
 *
 * @param extensionUri The URI of the extension installation directory.
 * @param language The VS Code display language.
 * @returns The resolved locale and its catalog, backed by the English messages.
 */
export async function loadMessages(
  extensionUri: vscode.Uri,
  language: string,
): Promise<ResolvedMessages> {
  let primaryLocale: string | undefined;
  let primaryCatalog: MessageCatalog | undefined;

  for (const locale of buildCandidateLocales(language)) {
    const catalog = await readCatalogFile(extensionUri, resourceFileName(locale));
    if (catalog !== undefined) {
      primaryLocale = locale;
      primaryCatalog = catalog;
      break;
    }
  }

  if (primaryCatalog === undefined || primaryLocale === undefined) {
    // Every key falls back to its identifier, which reads as English, so declare English.
    return { locale: ENGLISH_LOCALE, catalog: {} };
  }
  if (primaryLocale === ENGLISH_LOCALE) {
    return { locale: primaryLocale, catalog: primaryCatalog };
  }

  const englishCatalog = await readCatalogFile(extensionUri, resourceFileName(ENGLISH_LOCALE));
  return {
    locale: primaryLocale,
    catalog: {
      ...englishCatalog,
      ...primaryCatalog,
    },
  };
}
