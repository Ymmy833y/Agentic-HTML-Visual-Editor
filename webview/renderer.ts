// Parses an HTML body fragment into a sanitized DocumentFragment ready to
// mount into the WYSIWYG root. Only body-level content is touched; the
// surrounding document (doctype/<html>/<head>/<body> opening + closing tags)
// is preserved verbatim by the caller through a prefix/suffix splice.

// Tags that may execute scripts, load external resources, or otherwise alter
// the page beyond what the WYSIWYG is meant to render. These are dropped
// from the DOM before mounting.
const FORBIDDEN_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'frame',
  'frameset',
  'noscript',
  'link',
  'style',
  'base',
  'meta',
]);

// Any attribute whose name starts with one of these prefixes is dropped.
const FORBIDDEN_ATTR_PREFIXES = ['on'];

// Attributes that may carry executable or navigable URLs. Their values are
// validated against the URL allowlist below.
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'srcset', 'action', 'formaction']);

// URL schemes that are never allowed in user content.
const UNSAFE_URL_PREFIXES = ['javascript:', 'vbscript:', 'data:text/html'];

export interface BodySplit {
  prefix: string;
  bodyInner: string;
  suffix: string;
}

export function splitAroundBody(source: string): BodySplit | null {
  const openMatch = /<body\b[^>]*>/i.exec(source);
  if (!openMatch) return null;
  const bodyStart = openMatch.index + openMatch[0].length;
  const closeMatch = /<\/body\s*>/i.exec(source.slice(bodyStart));
  if (!closeMatch) return null;
  const bodyEnd = bodyStart + closeMatch.index;
  return {
    prefix: source.slice(0, bodyStart),
    bodyInner: source.slice(bodyStart, bodyEnd),
    suffix: source.slice(bodyEnd),
  };
}

/**
 * Parse a body-content HTML string into a sanitized DocumentFragment.
 * Uses a <template> element so the browser parses the content in body
 * context without executing scripts or fetching external resources.
 */
export function parseBodyContent(bodyInner: string): DocumentFragment {
  const tpl = document.createElement('template');
  tpl.innerHTML = bodyInner;
  sanitizeFragment(tpl.content);
  return tpl.content;
}

/**
 * Walk an in-memory tree and remove disallowed elements and attributes.
 * Exported so other entry points (paste handler, etc.) can sanitize their
 * own fragments before they reach the live DOM.
 */
export function sanitizeFragment(root: ParentNode): void {
  const toRemove: Element[] = [];
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.currentNode;
  while (node) {
    if (node instanceof Element) {
      const tag = node.tagName.toLowerCase();
      if (FORBIDDEN_TAGS.has(tag)) {
        toRemove.push(node);
      } else {
        sanitizeAttributes(node);
      }
    }
    node = walker.nextNode();
  }
  for (const el of toRemove) {
    el.remove();
  }
}

function sanitizeAttributes(el: Element): void {
  const attrs = Array.from(el.attributes);
  for (const attr of attrs) {
    const name = attr.name.toLowerCase();
    if (FORBIDDEN_ATTR_PREFIXES.some((p) => name.startsWith(p))) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (URL_ATTRS.has(name) && isUnsafeUrl(attr.value)) {
      el.removeAttribute(attr.name);
    }
  }
}

function isUnsafeUrl(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return UNSAFE_URL_PREFIXES.some((p) => trimmed.startsWith(p));
}
