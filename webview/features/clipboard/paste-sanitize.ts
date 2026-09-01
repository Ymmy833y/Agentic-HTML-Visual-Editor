// Cleanup pass for HTML fragments coming from the clipboard. Runs *after*
// the security-focused sanitizer in renderer.ts has already removed scripts
// and on* handlers. This pass is concerned with noise reduction:
// CF_HTML markers, computed-style inlining from the source browser,
// Office/Google Docs/Confluence boilerplate, and empty wrappers.
//
// Style attributes are pruned via a property allowlist scoped per tag.
// Anything outside the allowlist (font-*, letter-spacing, white-space,
// text-decoration, vendor extensions, etc.) is dropped so AI-generated and
// human-edited HTML stays compact, while user-meaningful properties
// (color, background-color, text-align, structural width/height) survive.

import { unwrap } from '../../shared/dom-utils';

// Lowercase block tags used here for the text-align style allowance. Distinct
// from shared/constants BLOCK_TAGS (uppercase, no td/th) on purpose.
const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'div', 'li', 'td', 'th',
]);

const TABLE_SIZING_TAGS = new Set(['table', 'col', 'colgroup', 'th', 'td']);

// Inline elements that exist purely to carry styling — when stripping
// removes all of their attributes, the wrapper has no remaining role and is
// unwrapped so only its children survive.
const UNWRAPPABLE_IF_BARE = new Set(['span', 'font']);

/**
 * Strip clipboard noise from an in-memory fragment in place.
 * Safe to call on an already-cleaned fragment (idempotent).
 */
export function cleanupPastedFragment(root: ParentNode): void {
  removeCfHtmlComments(root);
  removeOfficeWrappers(root);
  stripStyleAndClass(root);
  unwrapBareStyleWrappers(root);
}

/**
 * Remove every Comment node. CF_HTML (`<!--StartFragment-->` /
 * `<!--EndFragment-->`) is the most common offender but comments in general
 * carry no value in pasted content and only consume context.
 *
 * StartFragment / EndFragment markers are typically wrapped by the OS
 * clipboard layer with `\r\n`, so after the comment is removed the adjacent
 * text nodes still carry that whitespace. We trim the whitespace next to
 * any CF_HTML marker so a copy-paste round-trip of "sample" does not become
 * "\n\nsample\n\n" on the receiving side.
 */
function removeCfHtmlComments(root: ParentNode): void {
  const ownerDoc = (root as Node).ownerDocument ?? document;
  const walker = ownerDoc.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const toRemove: Comment[] = [];
  let node = walker.nextNode() as Comment | null;
  while (node) {
    toRemove.push(node);
    node = walker.nextNode() as Comment | null;
  }
  for (const c of toRemove) {
    const data = c.data.trim();
    const isFragmentMarker = /^(?:Start|End)Fragment$/i.test(data);
    if (isFragmentMarker) {
      trimAdjacentWhitespace(c);
    }
    c.remove();
  }
}

function trimAdjacentWhitespace(node: Node): void {
  // Remove whitespace-only text siblings flanking the marker, then strip
  // whitespace from the inside edge of any remaining adjacent text node.
  for (const dir of ['previous', 'next'] as const) {
    let sib = dir === 'previous' ? node.previousSibling : node.nextSibling;
    while (sib && sib.nodeType === Node.TEXT_NODE && /^\s*$/.test((sib as Text).data)) {
      const next = dir === 'previous' ? sib.previousSibling : sib.nextSibling;
      sib.remove();
      sib = next;
    }
    if (sib && sib.nodeType === Node.TEXT_NODE) {
      const t = sib as Text;
      t.data = dir === 'previous' ? t.data.replace(/\s+$/, '') : t.data.replace(/^\s+/, '');
      if (t.data === '') t.remove();
    }
  }
}

/**
 * Office and other XML-namespaced wrappers (e.g. `<o:p>`, `<w:sdt>`) survive
 * the renderer sanitizer because they are not in its forbidden tag list,
 * but they have no meaning in plain HTML. Unwrap them so their content
 * stays while the empty shells disappear.
 */
function removeOfficeWrappers(root: ParentNode): void {
  // localName matches the part after the `:` for namespaced tags in HTML
  // parsing; querySelector with a namespace prefix is not portable.
  const all = (root as Element).querySelectorAll
    ? (root as Element).querySelectorAll('*')
    : null;
  if (!all) return;
  const toUnwrap: Element[] = [];
  for (const el of Array.from(all)) {
    if (el.tagName.includes(':')) toUnwrap.push(el);
  }
  for (const el of toUnwrap) unwrap(el);
}

function stripStyleAndClass(root: ParentNode): void {
  const all = (root as Element).querySelectorAll?.('*');
  if (!all) return;
  for (const el of Array.from(all)) {
    preserveMermaidClassOnly(el);
    if (el.hasAttribute('style')) pruneStyle(el as HTMLElement);
  }
}

// Class names from rich clipboard HTML are normally presentation noise. The
// two exact Mermaid tokens are public document semantics, so retain only those
// tokens on the elements where the editor recognizes them.
function preserveMermaidClassOnly(el: Element): void {
  if (!el.hasAttribute('class')) return;
  const kept: string[] = [];
  if (el.tagName === 'PRE' && el.classList.contains('mermaid')) kept.push('mermaid');
  if (
    el.tagName === 'CODE' &&
    el.parentElement?.tagName === 'PRE' &&
    el.classList.contains('language-mermaid')
  ) {
    kept.push('language-mermaid');
  }
  if (kept.length > 0) el.setAttribute('class', kept.join(' '));
  else el.removeAttribute('class');
}

function pruneStyle(el: HTMLElement): void {
  const tag = el.tagName.toLowerCase();
  const style = el.style;
  // Iterate over a snapshot because removeProperty shifts the live list.
  const props: string[] = [];
  for (let i = 0; i < style.length; i++) {
    const p = style.item(i);
    if (p) props.push(p);
  }
  for (const prop of props) {
    if (!isAllowedStyle(tag, prop)) {
      style.removeProperty(prop);
    }
  }
  if (style.length === 0) {
    el.removeAttribute('style');
  }
}

function isAllowedStyle(tag: string, property: string): boolean {
  if (property === 'color' || property === 'background-color') return true;
  if (property === 'text-align' && BLOCK_TAGS.has(tag)) return true;
  if (
    (property === 'width' || property === 'min-width' || property === 'max-width') &&
    TABLE_SIZING_TAGS.has(tag)
  ) return true;
  if ((property === 'width' || property === 'height') && tag === 'img') return true;
  return false;
}

/**
 * After style stripping, `<span>` / `<font>` wrappers that no longer carry
 * any attribute are pure noise. Unwrap them so the children flow into the
 * parent context. Repeat until stable: unwrapping can expose another bare
 * wrapper that became eligible.
 */
function unwrapBareStyleWrappers(root: ParentNode): void {
  let changed = true;
  while (changed) {
    changed = false;
    const all = (root as Element).querySelectorAll?.('*');
    if (!all) return;
    for (const el of Array.from(all)) {
      if (UNWRAPPABLE_IF_BARE.has(el.tagName.toLowerCase()) && el.attributes.length === 0) {
        unwrap(el);
        changed = true;
        break; // restart — the live list is now stale
      }
    }
  }
}

