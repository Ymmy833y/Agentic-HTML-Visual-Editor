/**
 * Return whether an href is an ordinary relative filesystem reference.
 *
 * Shared by the Webview (which decides whether to intercept a click) and the
 * extension host (which re-validates the received href before resolving it), so
 * both sides of the trust boundary classify links identically. Keep this
 * environment-agnostic: no DOM, Node, or VSCode API.
 */
export function isRelativeFileHref(href: string): boolean {
  const value = href.trim();
  if (value === '') return false;
  if (value.startsWith('#') || value.startsWith('?')) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  return !/^[a-z][a-z\d+.-]*:/i.test(value);
}
