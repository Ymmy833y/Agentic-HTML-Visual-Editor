import {
  DEFAULT_SIDEBAR_LAYOUT,
  EDITOR_ROOT_ELEMENT_ID,
  MESSAGE_CATALOG_ELEMENT_ID,
  SIDEBAR_LAYOUT_META_NAME,
  TEST_MODE_META_NAME,
} from '../../common/index';
import type { MessageCatalog, SidebarLayout } from '../../common/index';
import type { ResolvedMessages } from '../i18n/message-resource-loader';
import { buildContentSecurityPolicy } from '../security/content-security-policy';

/**
 * Converts a catalog to text that cannot close its element when embedded in a document.
 *
 * @param catalog The resolved message catalog, which may be empty.
 * @returns JSON text suitable for embedding.
 */
export function serializeCatalogForEmbedding(catalog: MessageCatalog): string {
  // A </script> in a message would close the element and cause the remainder to be interpreted as
  // document content. Escaping < in JSON prevents this without changing the value when read back.
  return JSON.stringify(catalog).replace(/</g, '\\u003c');
}

/**
 * Builds the HTML document written to the webview panel.
 *
 * @param webviewSource The string representing the webview source.
 * @param nonce The script nonce regenerated for each document written.
 * @param bundleUri The webview URI of the webview bundle.
 * @param styleUri The webview URI of the stylesheet for the extension's own UI.
 * @param messages The resolved messages, whose locale is declared on the root element.
 * @param testMode True only when launched in Test mode. Makes the view accept test-only controls.
 * @param sidebarLayout The sidebar layout the view starts with: the last one stored for every file.
 * @returns A string containing the complete HTML document.
 */
export function buildWebviewContent(
  webviewSource: string,
  nonce: string,
  bundleUri: string,
  styleUri: string,
  messages: ResolvedMessages,
  testMode = false,
  sidebarLayout: SidebarLayout = DEFAULT_SIDEBAR_LAYOUT,
): string {
  // The test mode meta is decided only from the extension mode. If it could be read from the document or
  // settings, an opened HTML file could trigger unresponsiveness or unsent edits.
  const testModeDeclaration = testMode ? `\n<meta name="${TEST_MODE_META_NAME}" content="true">` : '';
  // Both values are written as numbers and booleans only, so nothing read from the stored state can break out of the
  // attribute. The width is left out until the user first resizes, so that the stylesheet's default applies.
  const sidebarDeclaration = `\n<meta name="${SIDEBAR_LAYOUT_META_NAME.open}" content="${String(sidebarLayout.open)}">`
    + (sidebarLayout.width === undefined
      ? ''
      : `\n<meta name="${SIDEBAR_LAYOUT_META_NAME.width}" content="${String(Math.round(sidebarLayout.width))}">`);
  // The root declaration carries the UI locale, not the language of the file being edited: the text
  // read at this level is the toolbar and dialog wording. The language of the opened file is
  // declared on the element the body content is mounted into, overriding this one for that subtree.
  //
  // The catalog element carries a nonce as well, because CSP does not distinguish script elements
  // by the kind of content they hold; without one the element holding the JSON is rejected too. The
  // bundle is loaded after the catalog and deferred until the document is parsed, because the view
  // reads the catalog on startup and would otherwise find it missing.
  //
  // Leave the editor root empty and non-editable. Exposing the editing area first would send its
  // empty state to the host as unsaved content, creating a path that overwrites the file with an
  // empty document. The view makes it editable only after receiving the initialize message and
  // determining the document boundary.
  //
  // A stylesheet defines the appearance of the extension's own UI. The CSP style-src permits only
  // the webview source, so bundled extension styles can load while stylesheets from the opened HTML
  // cannot.
  return `<!DOCTYPE html>
<html lang="${messages.locale}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${buildContentSecurityPolicy(webviewSource, nonce)}">${testModeDeclaration}${sidebarDeclaration}
<link rel="stylesheet" href="${styleUri}">
<script type="application/json" id="${MESSAGE_CATALOG_ELEMENT_ID}" nonce="${nonce}">${serializeCatalogForEmbedding(messages.catalog)}</script>
<script nonce="${nonce}" src="${bundleUri}" defer></script>
</head>
<body>
<div id="${EDITOR_ROOT_ELEMENT_ID}"></div>
</body>
</html>
`;
}
