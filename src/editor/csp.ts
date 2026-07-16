// Content-Security-Policy for the WYSIWYG webview. Kept as a standalone,
// vscode-free pure function so the policy can be unit-tested directly (the
// enclosing AhveEditorProvider imports the vscode API and is not unit-testable).

/**
 * Build the CSP header value for the editor webview.
 *
 * Defaults to 'none' for every directive and opts back in only for the bundle's
 * own script, the stylesheet, and rendered <img>/font assets. `connect-src`,
 * `frame-src`, and `form-action` are listed explicitly even though
 * `default-src 'none'` already blocks them, so the policy is easy to audit at a
 * glance.
 *
 * `img-src` intentionally allows `http:` alongside `https:` and `data:`: the
 * image-insertion UI (`validateImageSource` in webview/commands/image.ts)
 * accepts user-entered HTTP/HTTPS image URLs, and existing documents may already
 * reference plain-HTTP images. This is a deliberate, product-level relaxation.
 * Executable/navigable schemes (`javascript:`, `vbscript:`, `data:text/html`)
 * are still stripped from content by the renderer's sanitizer, independent of
 * this transport-level allowlist.
 *
 * @param cspSource the webview's `cspSource` (its own resource origin).
 * @param nonce the per-render script nonce.
 */
export function buildContentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    `default-src 'none'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource} http: https: data:`,
    `font-src ${cspSource}`,
    `connect-src 'none'`,
    `frame-src 'none'`,
    `form-action 'none'`,
  ].join('; ');
}
