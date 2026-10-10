// Only images may use external sources. This allows HTML containing diagrams or icons embedded by
// an agent to be displayed as is; the data scheme is allowed for the same purpose. Only src uses
// this list.
const IMAGE_SOURCES = ['http:', 'https:', 'data:'];

/**
 * Builds the CSP directives included in a document.
 *
 * This function does not validate its arguments. The caller is responsible for passing valid values.
 *
 * @param webviewSource The string representing the webview source.
 * @param nonce The script nonce regenerated for each document written.
 * @returns A single-line string containing the CSP directives.
 */
export function buildContentSecurityPolicy(webviewSource: string, nonce: string): string {
  const directives = [
    // Start by denying everything, then allow only what is required instead of trying to enumerate
    // dangerous capabilities. This prevents an omitted restriction from becoming a vulnerability.
    `default-src 'none'`,
    // Authorizing by source or broadly allowing inline scripts would also authorize scripts in the
    // HTML being opened. Requiring a matching nonce is the only way to limit execution to scripts
    // written by the extension.
    `script-src 'nonce-${nonce}'`,
    `style-src ${webviewSource}`,
    // Allow only style attributes written directly on elements to preserve the appearance of the
    // user's HTML. Attribute values contain declarative styles and do not execute code, so this does
    // not add a script execution path. <style> elements remain disallowed by style-src.
    `style-src-attr 'unsafe-inline'`,
    `font-src ${webviewSource}`,
    `img-src ${webviewSource} ${IMAGE_SOURCES.join(' ')}`,
    // Form destinations and relative URL bases do not fall back to default-src, so block them
    // explicitly. Embedding and outbound communication directives do fall back to it and remain
    // blocked because they are not opened here.
    `form-action 'none'`,
    `base-uri 'none'`,
  ];

  return directives.join('; ');
}
