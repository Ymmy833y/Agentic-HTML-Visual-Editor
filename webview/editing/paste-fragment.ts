import { FORBIDDEN_TAG_NAMES, PASTE_STYLE_ALLOWLIST } from '../../common/index';
import { isUnsafeAttribute } from '../document/attribute-sanitizer';
import { MERMAID_CLASS_NAME, MERMAID_LANGUAGE_CLASS_NAME } from '../diagram/diagram-source';
import { isHtmlWhitespaceOnly } from './block';
import { removeCommentAnnotations } from './copy-html';
import { CREATED_FORMAT_TAG_NAME, FORMAT_TAG_NAMES } from './inline-format';
import { isPasteBlock } from './paste-placement';

// The mark in the allowlist that means every element.
const ANY_TAG_NAME = '*';

// The start of the conditional comment Word wraps around bullets and numbers, and the end of the condition.
const OFFICE_LIST_CONDITION = '[if !supportLists]';
const OFFICE_CONDITION_END = '[endif]';

// Comments that HTML on the Windows clipboard places to mark the extent of the fragment.
const FRAGMENT_MARKER_COMMENTS: ReadonlySet<string> = new Set(['StartFragment', 'EndFragment']);

// The id prefix of the element Google Docs wraps around the whole pasted content.
const GOOGLE_DOCS_WRAPPER_ID_PREFIX = 'docs-internal-guid-';

// The element Google Sheets wraps around the whole copy content.
const GOOGLE_SHEETS_WRAPPER_TAG_NAME = 'google-sheets-html-origin';

// The width Google Sheets writes in a table's style. It is written together with the declaration that sizes the table
// by its column widths (table-layout: fixed).
const GOOGLE_SHEETS_TABLE_WIDTH = '0px';

// The prefix of namespace declaration values on the root element of HTML exported by Office.
const OFFICE_NAMESPACE_PREFIX = 'urn:schemas-microsoft-com:office:';

// The line break mark Chromium adds to the end of copy content when an end of the selection is a paragraph break.
const INTERCHANGE_NEWLINE_SELECTOR = 'br.Apple-interchange-newline';

// Elements removed once they have no attributes. They are wrappers that only carry computed styles, and keeping them
// would leave meaningless wrappers in the document.
const STYLE_WRAPPER_SELECTOR = 'span';

// Obsolete elements that only set the look of their content (font face, size, color, centering). They are unwrapped
// with their attributes, because the look they set is lost in the target document or fights its theme.
const LEGACY_PRESENTATIONAL_SELECTOR = 'font, basefont, big, tt, center';

// The obsolete spelling of strikethrough. It is renamed to the element the editor reads as strikethrough.
const OBSOLETE_STRIKETHROUGH_TAG_NAME = 'strike';

// Formats a declaration in style can carry, in the order their elements nest from the outside.
const DECLARED_FORMATS = ['bold', 'italic', 'strikethrough'] as const;

/** A format that a declaration in `style` can carry. */
type DeclaredFormat = (typeof DECLARED_FORMATS)[number];

// Elements that already show each format, by their own spelling or by default. Headings and header cells are bold by
// default, so a bold declaration on them or inside them is not turned into an element.
const FORMAT_CARRIER_SELECTORS: Readonly<Record<DeclaredFormat, string>> = {
  bold: [...FORMAT_TAG_NAMES.bold, 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'th'].join(', '),
  italic: [...FORMAT_TAG_NAMES.italic].join(', '),
  strikethrough: [...FORMAT_TAG_NAMES.strikethrough].join(', '),
};

// The lowest numeric font weight that is bold. 600 is the semibold face, the first weight browsers draw as bold.
const BOLD_FONT_WEIGHT = 600;

// Keyword font weights that are bold.
const BOLD_FONT_WEIGHT_KEYWORDS: ReadonlySet<string> = new Set(['bold', 'bolder']);

// Font styles that slant the text.
const ITALIC_FONT_STYLES: ReadonlySet<string> = new Set(['italic', 'oblique']);

// The text decoration line that strikes the text through.
const LINE_THROUGH = 'line-through';

// Elements whose content is not HTML, and elements whose content has no formatting. Format elements are not added
// inside them: an HTML element inside SVG or MathML is not drawn, and reopening the saved document moves it out.
// Elements whose content the parser reads as text would show the added tags as text after reopening. A picture holds
// only its sources and its image, which must both stay directly under it.
const FORMAT_DECLARATION_STOP_TAG_NAMES: ReadonlySet<string> = new Set([
  'pre',
  'svg',
  'math',
  'textarea',
  'title',
  'xmp',
  'picture',
]);

// Elements that only work as direct children of their parent, so they are never wrapped in format elements. Wrapped,
// a ruby annotation is drawn on the base line and a media source is no longer read.
const DIRECT_CHILD_TAG_NAMES: ReadonlySet<string> = new Set(['rt', 'rp', 'source', 'track', 'option', 'optgroup']);

// Spellings of opaque black, compared without whitespace. External apps write it as the default text color, and
// keeping it makes the text unreadable on a dark theme.
const BLACK_COLORS: ReadonlySet<string> = new Set([
  'black',
  '#000',
  '#000f',
  '#000000',
  '#000000ff',
  'rgb(0,0,0)',
  'rgba(0,0,0,1)',
]);

// A color whose alpha is zero, compared without whitespace. External apps write it as the default background color.
// Only the alpha is looked at, the fourth comma-separated component or the one after a slash, because an opaque color
// such as rgb(255, 255, 0) also ends in 0.
const TRANSPARENT_COLOR_PATTERN = /^(?:transparent|(?:rgb|hsl)a?\((?:(?:[^,/()]*,){3}|[^,/()]*\/)0(?:\.0*)?%?\))$/u;

// Line breaks at the ends of text. CF_HTML uses CRLF, but parsing normalizes it to LF.
const LEADING_LINE_BREAKS_PATTERN = /^[\r\n]+/u;
const TRAILING_LINE_BREAKS_PATTERN = /[\r\n]+$/u;

/**
 * Builds the fragment to insert into the editor root from the HTML form of a paste.
 *
 * Parsing, sanitizing, and attribute pruning are all done, in that order, on an inert document, because moving the
 * content into the live document can trigger image fetches and on* attributes.
 *
 * @param html The HTML form.
 * @returns The sanitized and pruned fragment. It belongs to a document other than the live one.
 */
export function buildPasteFragment(html: string): DocumentFragment {
  const fragment = parsePasteHtml(html);
  sanitizePasteFragment(fragment);
  prunePasteAttributes(fragment);
  return fragment;
}

/**
 * Parses the HTML form as a whole document, takes the body contents out as a fragment, and removes external app
 * markers.
 *
 * It is parsed as a whole document to keep the `meta` external apps put at the start, and the `style` in the `head`
 * Office exports, out of the body. The document `DOMParser` creates neither runs scripts nor loads images.
 *
 * @param html The HTML form.
 * @returns A fragment of the body contents. It belongs to the document used for parsing.
 */
export function parsePasteHtml(html: string): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const fragment = parsed.createDocumentFragment();
  fragment.append(...parsed.body.childNodes);

  removeOfficeListMarkers(fragment);
  removeHtmlComments(fragment);
  unwrapMarkerElements(fragment);
  // The line break mark is recognized by its class, so remove it before pruning drops the class. If kept, pasting
  // paragraphs adds an empty paragraph, and pasting text selected to the end of a line splits the line.
  for (const lineBreak of fragment.querySelectorAll(INTERCHANGE_NEWLINE_SELECTOR)) {
    lineBreak.remove();
  }
  if (isOfficeDocument(parsed)) {
    // Word documents in Japanese attach a span with lang to each English part. Removing lang lets pruning remove the
    // spans that no longer have attributes.
    for (const element of fragment.querySelectorAll('[lang]')) {
      element.removeAttribute('lang');
    }
  }
  return fragment;
}

/**
 * Removes from the fragment forbidden tag elements together with their content, on* attributes, and URL attributes
 * with dangerous schemes, and unwraps comment annotations, keeping only the annotated text.
 *
 * In an opened document the same attributes are quarantined into the internal namespace and written back on save.
 * Pasted content is not on disk yet, so it is removed instead of quarantined. Quarantining would write on* attributes
 * from the clipboard back on save.
 * Elements are not dropped by the allowed tag list. Copying within the editor copies the document's elements as they
 * are, so dropping them would make elements that were in the document disappear on paste.
 *
 * @param fragment The fragment.
 */
export function sanitizePasteFragment(fragment: DocumentFragment): void {
  const elements = listElements(fragment);
  for (const element of elements) {
    if (FORBIDDEN_TAG_NAMES.has(element.localName)) {
      element.remove();
    }
  }
  for (const element of elements) {
    for (const attribute of [...element.attributes]) {
      if (isUnsafeAttribute(attribute.name, attribute.value)) {
        element.removeAttributeNode(attribute);
      }
    }
  }
  removeCommentAnnotations(fragment);
}

/**
 * Removes `class` from the fragment's elements, prunes `style` with the allowlist, and unwraps legacy presentational
 * elements and `span` that no longer have attributes.
 *
 * The class tokens that mark a diagram source block are the one exception: without them a copied diagram would be
 * pasted back as a plain code block. Only the marking token is kept, on the element it marks.
 *
 * Bold, italic, and strikethrough declarations are turned into elements before pruning drops them, because Google
 * Docs and web pages write these formats only as declarations.
 *
 * `style` is looked up from the declarations the browser parsed, so shorthands are also judged per property (only the
 * background color inside `background` is kept). Kept declarations are rewritten with the values the browser parsed,
 * without priority. Of the values, only opaque black text and transparent backgrounds are dropped.
 *
 * @param fragment The fragment.
 */
export function prunePasteAttributes(fragment: DocumentFragment): void {
  for (const strike of fragment.querySelectorAll(OBSOLETE_STRIKETHROUGH_TAG_NAME)) {
    renameElement(strike, CREATED_FORMAT_TAG_NAME.strikethrough);
  }
  for (const child of [...fragment.children]) {
    convertFormatDeclarations(child, new Set());
  }
  for (const element of fragment.querySelectorAll('*')) {
    const kept = readDiagramClassName(element);
    if (kept === undefined) {
      element.removeAttribute('class');
    } else {
      element.setAttribute('class', kept);
    }
    pruneStyle(element);
  }
  for (const legacy of fragment.querySelectorAll(LEGACY_PRESENTATIONAL_SELECTOR)) {
    legacy.replaceWith(...legacy.childNodes);
  }
  for (const wrapper of fragment.querySelectorAll(STYLE_WRAPPER_SELECTOR)) {
    if (wrapper.attributes.length === 0) {
      wrapper.replaceWith(...wrapper.childNodes);
    }
  }
}

/**
 * Replaces the element with an element of another name that has the same attributes and children.
 *
 * @param element The element.
 * @param tagName The name of the new element.
 */
function renameElement(element: Element, tagName: string): void {
  const renamed = element.ownerDocument.createElement(tagName);
  for (const attribute of element.attributes) {
    renamed.setAttribute(attribute.name, attribute.value);
  }
  renamed.append(...element.childNodes);
  element.replaceWith(renamed);
}

/**
 * Wraps the content of the element and its descendants in the format elements their bold, italic, and strikethrough
 * declarations ask for.
 *
 * Formats an element already shows (its own spelling or an ancestor's) are not added again. Blocks and children that
 * must stay directly under their parent split the content into runs: each run is wrapped, and the formats are handed
 * down to the splitting children, so none of them goes into a format element. Nothing inside an element of
 * `FORMAT_DECLARATION_STOP_TAG_NAMES` is converted.
 *
 * @param element The element.
 * @param inherited Formats an ancestor declared that are not yet shown by any element.
 */
function convertFormatDeclarations(element: Element, inherited: ReadonlySet<DeclaredFormat>): void {
  if (FORMAT_DECLARATION_STOP_TAG_NAMES.has(element.localName)) {
    return;
  }
  const declared = readDeclaredFormats(element);
  const formats = DECLARED_FORMATS.filter(
    (format) => (inherited.has(format) || declared.has(format)) && element.closest(FORMAT_CARRIER_SELECTORS[format]) === null,
  );
  const handedDown = new Set(formats);
  const inlineElements: Element[] = [];
  let run: ChildNode[] = [];
  for (const child of [...element.childNodes]) {
    if (!isRunSplitter(child)) {
      run.push(child);
      if (child instanceof Element) {
        inlineElements.push(child);
      }
      continue;
    }
    wrapInFormats(element, run, formats);
    run = [];
    if (child instanceof Element) {
      convertFormatDeclarations(child, handedDown);
    }
  }
  wrapInFormats(element, run, formats);
  // Inline children are now inside the new format elements, so the formats wrapped here are not added to them again.
  for (const child of inlineElements) {
    convertFormatDeclarations(child, new Set());
  }
}

/**
 * Tells whether a child splits its parent's content into separately wrapped runs.
 *
 * @param node The child.
 * @returns `true` for a block and for an element that must stay directly under its parent.
 */
function isRunSplitter(node: ChildNode): boolean {
  return isPasteBlock(node) || (node instanceof Element && DIRECT_CHILD_TAG_NAMES.has(node.localName));
}

/**
 * Wraps consecutive sibling nodes in nested format elements, outermost first. Does nothing for an empty list, for
 * whitespace-only text, or when there is no format.
 *
 * @param parent The parent of the nodes.
 * @param nodes Consecutive children of the parent in document order.
 * @param formats The formats, in the order of `DECLARED_FORMATS`.
 */
function wrapInFormats(parent: Element, nodes: readonly ChildNode[], formats: readonly DeclaredFormat[]): void {
  const first = nodes[0];
  if (first === undefined || nodes.every((node) => node instanceof Text && isHtmlWhitespaceOnly(node.data))) {
    return;
  }
  const [outermost, ...inner] = formats.map((format) => parent.ownerDocument.createElement(CREATED_FORMAT_TAG_NAME[format]));
  if (outermost === undefined) {
    return;
  }
  first.before(outermost);
  let innermost = outermost;
  for (const wrapper of inner) {
    innermost.append(wrapper);
    innermost = wrapper;
  }
  innermost.append(...nodes);
}

/**
 * Returns the formats the element's `style` declares.
 *
 * @param element The element.
 * @returns Bold for a font weight of 600 or more, italic for a slanted font style, and strikethrough for a text
 *   decoration that includes a line through.
 */
function readDeclaredFormats(element: Element): ReadonlySet<DeclaredFormat> {
  const formats = new Set<DeclaredFormat>();
  if (!element.hasAttribute('style')) {
    return formats;
  }
  const style = readInlineStyle(element);
  if (style === undefined) {
    return formats;
  }
  const weight = style.getPropertyValue('font-weight').trim().toLowerCase();
  if (BOLD_FONT_WEIGHT_KEYWORDS.has(weight) || Number(weight) >= BOLD_FONT_WEIGHT) {
    formats.add('bold');
  }
  const [slant = ''] = style.getPropertyValue('font-style').trim().toLowerCase().split(/\s+/u);
  if (ITALIC_FONT_STYLES.has(slant)) {
    formats.add('italic');
  }
  // Read both the shorthand and the longhand, because which of them a browser expands the other into varies.
  const decoration = `${style.getPropertyValue('text-decoration')} ${style.getPropertyValue('text-decoration-line')}`;
  if (decoration.toLowerCase().split(/\s+/u).includes(LINE_THROUGH)) {
    formats.add('strikethrough');
  }
  return formats;
}

/**
 * Tells whether a declared value is a default color external apps write, which is dropped instead of kept.
 *
 * @param name The property name.
 * @param value The value the browser parsed.
 * @returns `true` for opaque black text and for a transparent background.
 */
function isDefaultColor(name: string, value: string): boolean {
  const compact = value.toLowerCase().replace(/\s+/gu, '');
  if (name === 'color') {
    return BLACK_COLORS.has(compact);
  }
  return name === 'background-color' && TRANSPARENT_COLOR_PATTERN.test(compact);
}

/**
 * Returns the class token that marks the element as part of a diagram source block.
 *
 * @param element The element.
 * @returns `mermaid` for a `pre` carrying it, `language-mermaid` for a `code` carrying it directly under a `pre`, or
 *   `undefined` otherwise.
 */
function readDiagramClassName(element: Element): string | undefined {
  if (element.localName === 'pre' && element.classList.contains(MERMAID_CLASS_NAME)) {
    return MERMAID_CLASS_NAME;
  }
  if (
    element.localName === 'code'
    && element.parentElement?.localName === 'pre'
    && element.classList.contains(MERMAID_LANGUAGE_CLASS_NAME)
  ) {
    return MERMAID_LANGUAGE_CLASS_NAME;
  }
  return undefined;
}

/**
 * Rewrites the element's `style` to only the declarations of properties allowed for its tag. Removes `style` if none
 * remain.
 *
 * @param element The element.
 */
function pruneStyle(element: Element): void {
  if (!element.hasAttribute('style')) {
    return;
  }
  const style = readInlineStyle(element);
  const kept: string[] = [];
  for (const [name, tagNames] of PASTE_STYLE_ALLOWLIST) {
    if (!tagNames.has(ANY_TAG_NAME) && !tagNames.has(element.localName)) {
      continue;
    }
    // Look up each property's value from the parsed declarations. Values written as shorthands can also be looked up
    // as individual property values.
    const value = style?.getPropertyValue(name) ?? '';
    if (value !== '' && !isDefaultColor(name, value)) {
      kept.push(`${name}: ${value};`);
    }
  }
  if (kept.length === 0) {
    element.removeAttribute('style');
    return;
  }
  element.setAttribute('style', kept.join(' '));
}

/**
 * Returns the declarations parsed from the element's `style`.
 *
 * @param element The element.
 * @returns The declarations, or `undefined` for an element whose `style` cannot be read.
 */
function readInlineStyle(element: Element): CSSStyleDeclaration | undefined {
  const style: unknown = Reflect.get(element, 'style');
  return style instanceof CSSStyleDeclaration ? style : undefined;
}

/**
 * Collects the fragment's elements, including those in the content trees of `template` elements.
 *
 * The content of a `template` is in a separate tree, not among its children, so skipping it would miss forbidden tags
 * and attributes. A missed forbidden tag, once saved, would make the reopened document unopenable.
 *
 * @param root The root of the range to collect from.
 * @returns The elements.
 */
function listElements(root: ParentNode): Element[] {
  const elements: Element[] = [];
  for (const element of root.querySelectorAll('*')) {
    elements.push(element);
    if (element instanceof HTMLTemplateElement) {
      elements.push(...listElements(element.content));
    }
  }
  return elements;
}

/**
 * Removes Word's bullets and numbers together with the conditional comments around them.
 *
 * Parsing turns only the two ends of the condition into comments, and the marker `span` between them remains. If kept,
 * a bullet or number and a space appear at the start of each paragraph. Word also uses conditions of the same shape
 * for things like image fallbacks, whose content is displayed, so only list conditions are removed. A condition with
 * no matching end keeps its content (all comments are removed later).
 *
 * @param fragment The fragment.
 */
function removeOfficeListMarkers(fragment: DocumentFragment): void {
  const comments = collectComments(fragment);
  for (const [index, comment] of comments.entries()) {
    if (comment.data.trim() !== OFFICE_LIST_CONDITION || comment.parentNode === null) {
      continue;
    }
    const end = comments
      .slice(index + 1)
      .find((candidate) => candidate.data.trim() === OFFICE_CONDITION_END && candidate.parentNode !== null);
    if (end === undefined) {
      continue;
    }
    const marker = fragment.ownerDocument.createRange();
    marker.setStartBefore(comment);
    marker.setEndAfter(end);
    marker.deleteContents();
  }
}

/**
 * Removes all HTML comments. For comments marking the extent of the fragment, the adjacent line breaks are removed too.
 *
 * HTML on the Windows clipboard surrounds the fragment with comments, with line breaks before and after it. Keeping
 * the line breaks adds whitespace before and after the pasted content.
 *
 * @param fragment The fragment.
 */
function removeHtmlComments(fragment: DocumentFragment): void {
  for (const comment of collectComments(fragment)) {
    if (FRAGMENT_MARKER_COMMENTS.has(comment.data.trim())) {
      trimLineBreaks(comment.previousSibling, TRAILING_LINE_BREAKS_PATTERN);
      trimLineBreaks(comment.nextSibling, LEADING_LINE_BREAKS_PATTERN);
    }
  }
  for (const comment of collectComments(fragment)) {
    comment.remove();
  }
}

/**
 * Removes the line breaks at the comment-side end of text adjacent to a comment marking the extent of the fragment.
 * Whitespace-only text is removed entirely.
 *
 * @param node The node adjacent to the comment.
 * @param lineBreaks A pattern matching the line breaks at the comment-side end.
 */
function trimLineBreaks(node: Node | null, lineBreaks: RegExp): void {
  if (!(node instanceof Text)) {
    return;
  }
  if (isHtmlWhitespaceOnly(node.data)) {
    node.remove();
    return;
  }
  node.data = node.data.replace(lineBreaks, '');
}

/**
 * Unwraps Office namespaced elements and the Google Docs and Google Sheets wrappers, keeping their content.
 *
 * Namespaced elements (such as `o:p`) are placed by Office for paragraph formatting and have no content. Google Docs
 * wraps the whole pasted content in `b` and cancels the bold with `style`. `style` is dropped by pruning, so keeping
 * the wrapper would make everything bold. Keeping the Google Sheets wrapper would put it into the document still
 * wrapping the table.
 *
 * @param fragment The fragment.
 */
function unwrapMarkerElements(fragment: DocumentFragment): void {
  for (const element of fragment.querySelectorAll('*')) {
    if (element.localName === GOOGLE_SHEETS_WRAPPER_TAG_NAME) {
      removeGoogleSheetsTableWidths(element);
      element.replaceWith(...element.childNodes);
    } else if (element.localName.includes(':') || element.id.startsWith(GOOGLE_DOCS_WRAPPER_ID_PREFIX)) {
      element.replaceWith(...element.childNodes);
    }
  }
}

/**
 * Removes the zero width from Google Sheets tables.
 *
 * Sheets sets the table width to 0 and pairs it with the declaration that sizes the table by its column widths. That
 * declaration is dropped by pruning, so if only the zero width remained, the table would ignore its column widths and
 * shrink to its minimum width.
 *
 * @param wrapper The Google Sheets wrapper.
 */
function removeGoogleSheetsTableWidths(wrapper: Element): void {
  for (const table of wrapper.querySelectorAll('table')) {
    const style = readInlineStyle(table);
    if (style?.getPropertyValue('width') === GOOGLE_SHEETS_TABLE_WIDTH) {
      style.removeProperty('width');
    }
  }
}

/**
 * Tells whether the HTML was exported by Office from the namespace declarations on the root element.
 *
 * @param document The parsed document.
 * @returns `true` if the root element declares an Office namespace.
 */
function isOfficeDocument(document: Document): boolean {
  return [...document.documentElement.attributes].some((attribute) => attribute.value.startsWith(OFFICE_NAMESPACE_PREFIX));
}

/**
 * Collects the fragment's HTML comments in document order.
 *
 * @param fragment The fragment.
 * @returns The comments.
 */
function collectComments(fragment: DocumentFragment): Comment[] {
  const comments: Comment[] = [];
  const walker = fragment.ownerDocument.createTreeWalker(fragment, NodeFilter.SHOW_COMMENT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Comment) {
      comments.push(node);
    }
  }
  return comments;
}
