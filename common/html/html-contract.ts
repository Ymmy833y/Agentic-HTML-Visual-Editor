/** Tags retained when the extension generates or prunes HTML. */
export const ALLOWED_TAG_NAMES: ReadonlySet<string> = new Set([
  'strong',
  'em',
  'code',
  's',
  'a',
  'span',
  'ins',
  'del',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'blockquote',
  'pre',
  'hr',
  'div',
  'details',
  'summary',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'colgroup',
  'col',
  'img',
  'comment',
  'comment-body',
  'comment-reply',
]);

/**
 * Tags that make a document unopenable when found in the body.
 *
 * This is limited to tags that execute scripts (script, noscript), embed content (iframe, object,
 * embed), load external resources, or alter the page (link, style, base, meta). The document is
 * rejected rather than opened after removing these tags because removal also affects saved content:
 * merely opening and saving the document would delete user-authored content from disk. Rejecting
 * the document also prevents new data-loss paths when tags are added to this list later.
 */
export const FORBIDDEN_TAG_NAMES: ReadonlySet<string> = new Set([
  'script',
  'noscript',
  'iframe',
  'object',
  'embed',
  'link',
  'style',
  'base',
  'meta',
]);

/** Prefix used to identify event handler attributes. */
export const EVENT_HANDLER_ATTRIBUTE_PREFIX = 'on';

/**
 * The only URL attribute whose candidates are separated by commas.
 *
 * The sanitizer checks each candidate only for this attribute. Treating commas as separators in
 * other attributes would misinterpret a single URL such as `/a,javascript:b` as two candidates.
 */
export const SRCSET_ATTRIBUTE_NAME = 'srcset';

/** Attribute names whose values are checked for URL schemes. */
export const URL_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set([
  'href',
  'src',
  'xlink:href',
  SRCSET_ATTRIBUTE_NAME,
  'action',
  'formaction',
]);

/** Schemes removed from URL attributes, compared by prefix. */
export const DANGEROUS_URL_SCHEMES: readonly string[] = [
  'javascript:',
  'vbscript:',
  'data:text/html',
];

// Elements that carry table column widths. Sizes are allowed so a pasted table keeps its column widths.
const TABLE_WIDTH_TAG_NAMES: readonly string[] = ['table', 'colgroup', 'col', 'th', 'td'];

/**
 * Maps each property kept in `style` on paste to the tag names that allow it. `*` means every element.
 *
 * Computed styles written by external apps (fonts, margins, line height, and so on) only break the look of the
 * target document, so they are not kept. Only properties that express the author's intent are kept: text and
 * background colors, alignment, and table and image sizes.
 * Pruning looks up the allowed tags per property, so the map is keyed by property.
 */
export const PASTE_STYLE_ALLOWLIST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['color', new Set(['*'])],
  ['background-color', new Set(['*'])],
  ['text-align', new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'div', 'li', 'td', 'th'])],
  ['width', new Set([...TABLE_WIDTH_TAG_NAMES, 'img'])],
  ['min-width', new Set(TABLE_WIDTH_TAG_NAMES)],
  ['max-width', new Set(TABLE_WIDTH_TAG_NAMES)],
  ['height', new Set(['img'])],
]);
