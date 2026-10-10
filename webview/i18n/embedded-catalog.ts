import {
  MESSAGE_CATALOG_ELEMENT_ID,
  parseMessageCatalog,
} from '../../common/index';
import type { MessageCatalog } from '../../common/index';

/**
 * Reads the catalog embedded in the webview document.
 *
 * @param document The webview document containing the catalog.
 * @returns The embedded catalog, or an empty catalog if it is missing or invalid.
 */
export function readEmbeddedCatalog(document: Document): MessageCatalog {
  const element = document.getElementById(MESSAGE_CATALOG_ELEMENT_ID);
  return parseMessageCatalog(element?.textContent ?? '');
}
