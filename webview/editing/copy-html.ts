import { COMMENT_TAG_NAME } from '../../common/index';
import { serializeBody } from '../document/body-serializer';
import { removeEditingArtifacts } from '../document/editing-artifact';
import { restoreImageSources } from '../document/image-source-resolver';
import { removeInternalAttributes } from '../document/internal-attribute';
import { INLINE_RUN_TAG_NAMES, isHtmlWhitespaceOnly } from './block';
import { findTrailingPreBreak } from './caret';
import { collectClosedBodyKeep } from './details-body-guard';
import { findDetailsTitle } from './details-section';
import type { DiagnosticReporter } from './input-dispatcher';
import { cloneRangeFragment, wrapRangeFragment } from './range-fragment';
import type { RangeFragment } from './range-fragment';

/**
 * Contentless visible elements. At the edges of a copy, they count as visible content along with non-whitespace text.
 *
 * `br` does not count. It only gives an empty line its height, so counting it would leave an empty paragraph at the
 * edge of a range selected from the end of a paragraph.
 */
export const CONTENTLESS_VISIBLE_TAG_NAMES: ReadonlySet<string> = new Set([
  'img',
  'hr',
  'input',
  'select',
  'textarea',
  'video',
  'audio',
  'canvas',
  'svg',
  'math',
  'meter',
  'progress',
]);

// Cells kept even when empty inside a row with visible content. Dropping them shifts the columns at the paste
// destination. The text form puts a tab after them.
const CELL_TAG_NAMES: ReadonlySet<string> = new Set(['td', 'th']);

// Column definitions kept even when empty inside a table with visible content. Dropping them loses the column widths
// at the paste destination.
const COLUMN_DEFINITION_TAG_NAMES: ReadonlySet<string> = new Set(['colgroup', 'col']);

// Elements the text form surrounds with line breaks. An inert fragment has no rendering, so this lists the element
// names whose default display is block.
const TEXT_BLOCK_TAG_NAMES: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'caption',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'legend',
  'li',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'ul',
]);

// A run of HTML whitespace, collapsed into a single space outside pre. NBSP is displayed without collapsing, so it is
// not included.
const HTML_WHITESPACE_RUN_PATTERN = /[\t\n\f\r ]+/gu;

/** The copy content. The two forms written to the clipboard, both created from the same fragment. */
export interface CopyContent {
  /** The HTML form (`text/html`). */
  readonly html: string;
  /** The text form (`text/plain`). */
  readonly text: string;
}

/** One piece in the middle of building the text form. */
type TextPiece =
  // Text outside pre. Runs of whitespace are already collapsed into a single space.
  | { readonly kind: 'text'; readonly value: string }
  // Text inside pre. Copied as is.
  | { readonly kind: 'preformatted'; readonly value: string }
  // A line break or tab placed by a br, row, or cell. The line ends there.
  | { readonly kind: 'lineEnd'; readonly value: string }
  // A request for line breaks before or after a block. The count is the number of line breaks requested.
  | { readonly kind: 'break'; readonly count: number };

/**
 * Creates the copy content from a range. The single entry point that lets copy and cut copy by the same rules.
 *
 * Clones the range into an inert document, then applies rewrapping, annotations, closed bodies, boundary empty blocks,
 * and finishing, in that order. Visible content is counted after the annotations are removed, so a paragraph holding
 * only a comment with nothing but entries is dropped at the edge. Changes neither the live tree, the selection, nor the
 * range.
 *
 * @param range The range of the target selection.
 * @param root The editor root.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 * @returns The copy content. If an exception occurs along the way, records one diagnostic line and returns
 *   `undefined`.
 */
export function createCopyContent(
  range: Range,
  root: Element,
  reportDiagnostic: DiagnosticReporter,
): CopyContent | undefined {
  try {
    const copied = cloneRangeFragment(range);
    wrapRangeFragment(copied, range, root);
    removeCommentAnnotations(copied.fragment);
    removeClosedDetailsBodies(copied, range, root, reportDiagnostic);
    removeBoundaryEmptyBlocks(copied.fragment);
    return serializeCopyFragment(copied.fragment);
  } catch (error) {
    reportDiagnostic(`Could not create the copy content: ${String(error)}`);
    return undefined;
  }
}

/**
 * Removes comment annotations from the fragment, leaving only the contents of the annotated text in place.
 *
 * The copy content also leaves this extension, so the text of entries is not mixed into the body. Entries are removed
 * even when they sit outside a comment, and hand-written nested comments are unwrapped at every level. The formatting
 * and links of the annotated text remain.
 *
 * @param fragment The fragment.
 */
export function removeCommentAnnotations(fragment: DocumentFragment): void {
  for (const entry of fragment.querySelectorAll(`${COMMENT_TAG_NAME.body}, ${COMMENT_TAG_NAME.reply}`)) {
    entry.remove();
  }
  // The unwrapping order does not matter. Even if the outer comment is unwrapped first, the inner comment moved along
  // as its contents is the same element, so it can be unwrapped as is.
  for (const comment of fragment.querySelectorAll(COMMENT_TAG_NAME.comment)) {
    comment.replaceWith(...comment.childNodes);
  }
}

/**
 * Removes from the fragment the bodies of closed collapsible sections that the range does not wholly contain. The
 * title part remains.
 *
 * A closed body is not visible, so range deletion keeps it as unselected. Copying it on a cut would duplicate the body
 * on paste. The same check as range deletion runs on the live tree, and the copies of the nodes it returns as kept
 * whole are looked up in the mapping and removed.
 *
 * @param copied The fragment and its mapping.
 * @param range The cloned range.
 * @param root The editor root.
 * @param reportDiagnostic The diagnostic reporter for maintainers. If the check fails, the check records a diagnostic
 *   and nothing is removed.
 */
export function removeClosedDetailsBodies(
  copied: RangeFragment,
  range: Range,
  root: Element,
  reportDiagnostic: DiagnosticReporter,
): void {
  for (const node of collectClosedBodyKeep(range, root, reportDiagnostic).keptNodes) {
    removeCopy(node, copied.liveToCopy);
  }
}

/**
 * Removes edge elements without visible content from the fragment, along with the line breaks between blocks.
 *
 * When an edge of the range is at the end or start of a block, a block that does not look selected enters as an empty
 * clone. Only what lies before the first visible content and after the last visible content is removed; empty blocks
 * between them remain. Cells in a row with visible content, column definitions in a table with visible content, and
 * the title of a collapsible section with visible content are kept for the structure even when empty.
 *
 * @param fragment The fragment. Becomes empty if it has no visible content.
 */
export function removeBoundaryEmptyBlocks(fragment: DocumentFragment): void {
  const first = findVisibleContent(fragment, 'first');
  const last = findVisibleContent(fragment, 'last');
  if (first === undefined || last === undefined) {
    fragment.replaceChildren();
    return;
  }
  trimOutside(fragment, first, last);
}

/**
 * Applies the same inverse transform and editing artifact removal as saving to the fragment, creates the text form
 * from that same fragment, and then serializes it into the HTML form. The HTML form is not formatted.
 *
 * Quarantined attributes are not written back. The copy content leaves this extension, so on* attributes and URLs with
 * dangerous schemes that the view disabled are not carried out. Their quarantined names live in the internal
 * namespace, so they drop together with internal attributes such as marks.
 *
 * @param fragment The fragment. Its children move into the serialization container, leaving the fragment empty.
 * @returns The copy content. For an empty fragment, both forms are empty strings.
 */
export function serializeCopyFragment(fragment: DocumentFragment): CopyContent {
  restoreImageSources(fragment);
  removeInternalAttributes(fragment);
  removeEditingArtifacts(fragment);
  // Serialization moves the fragment's children into its container and empties the fragment, so create the text form
  // first.
  const text = serializeCopyText(fragment);
  return { html: serializeBody(fragment), text };
}

/**
 * Creates the text form of the copy content from the fragment. Does not change the fragment.
 *
 * Once the selection has been rendered, the text the browser creates from a selection includes the bodies of closed
 * collapsible sections. Creating it from the same fragment as the HTML form removes entries, closed bodies, and
 * boundary empty blocks the same way, and it does not overlap the body that a cut leaves behind. Line breaks and tabs
 * follow the same rules as innerText: a blank line around paragraphs, a line break around other blocks, a tab after a
 * cell that is not the last in its row, and a line break after a row that is not the last in its table and for `br`.
 *
 * @param fragment The fragment.
 * @returns The text form.
 */
export function serializeCopyText(fragment: DocumentFragment): string {
  const pieces: TextPiece[] = [];
  for (const child of fragment.childNodes) {
    collectTextPieces(child, false, pieces);
  }
  return joinTextPieces(pieces);
}

/**
 * Removes the copy of a live tree node from the fragment.
 *
 * A comment directly under the body has been unwrapped by the annotation removal, so its copy is detached from the
 * tree and only the copies of the annotated text have moved to the parent. When the copy is not in the tree, the
 * copies of its children are looked up and removed.
 *
 * @param live The live tree node.
 * @param liveToCopy The mapping from live tree nodes to their copies.
 */
function removeCopy(live: Node, liveToCopy: ReadonlyMap<Node, Node>): void {
  const copy = liveToCopy.get(live);
  if (copy !== undefined && copy.parentNode !== null) {
    copy.parentNode.removeChild(copy);
    return;
  }
  for (const child of live.childNodes) {
    removeCopy(child, liveToCopy);
  }
}

/**
 * Finds the first or last visible content in the fragment. A contentless visible element counts as one without
 * descending into it.
 *
 * The paste rule also uses this check to decide whether a fragment has visible content. If copy and paste drew the
 * line differently, pasting copied content could fail to be taken.
 *
 * @param parent The parent of the part to search.
 * @param side First or last.
 * @returns The visible content node, or `undefined` if there is none.
 */
export function findVisibleContent(parent: Node, side: 'first' | 'last'): Node | undefined {
  const children = [...parent.childNodes];
  if (side === 'last') {
    children.reverse();
  }
  for (const child of children) {
    if (isVisibleContent(child)) {
      return child;
    }
    const found = child instanceof Element ? findVisibleContent(child, side) : undefined;
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * Returns whether a node is visible content.
 *
 * @param node The node to check.
 * @returns `true` for non-whitespace text or a contentless visible element.
 */
function isVisibleContent(node: Node): boolean {
  if (node instanceof Element) {
    return CONTENTLESS_VISIBLE_TAG_NAMES.has(node.localName);
  }
  if (!(node instanceof Text)) {
    return false;
  }
  const pre = node.parentElement?.closest('pre') ?? null;
  if (pre === null) {
    return !isHtmlWhitespaceOnly(node.data);
  }
  // Inside pre, whitespace and line breaks also form lines and indentation, so every character counts except the
  // trailing line break that is not displayed.
  const trailing = findTrailingPreBreak(pre);
  return node.data.length > (trailing?.text === node ? 1 : 0);
}

/**
 * Removes the parent's children that lie before the first visible content or after the last visible content. Repeats
 * the same for children that contain visible content.
 *
 * @param parent The parent. Contains the first or last visible content.
 * @param first The first visible content.
 * @param last The last visible content.
 */
function trimOutside(parent: Node, first: Node, last: Node): void {
  for (const child of [...parent.childNodes]) {
    if (child === first || child === last) {
      continue;
    }
    if (child.contains(first) || child.contains(last)) {
      // Whitespace and line breaks inside pre are visible content, so do not descend into it.
      if (child instanceof Element && child.localName !== 'pre') {
        trimOutside(child, first, last);
      }
      continue;
    }
    const before = (child.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const after = (child.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
    if ((!before && !after) || isKeptEmpty(child, parent)) {
      continue;
    }
    if (child instanceof Element || (child instanceof Text && isBlockSeparator(child))) {
      parent.removeChild(child);
    }
  }
}

/**
 * Returns whether an element is kept at the edge for the structure even without visible content.
 *
 * The parent contains the first or last visible content, so it has visible content.
 *
 * @param node The node at the edge.
 * @param parent Its parent.
 * @returns `true` for a cell in a row, a column definition in a table, or the title of a collapsible section.
 */
function isKeptEmpty(node: Node, parent: Node): boolean {
  if (!(node instanceof Element) || !(parent instanceof Element)) {
    return false;
  }
  if (CELL_TAG_NAMES.has(node.localName)) {
    return parent.localName === 'tr';
  }
  if (COLUMN_DEFINITION_TAG_NAMES.has(node.localName)) {
    return parent.localName === 'table' || parent.localName === 'colgroup';
  }
  return parent.localName === 'details' && findDetailsTitle(parent) === node;
}

/**
 * Returns whether whitespace-only text is a line break between blocks.
 *
 * Whitespace touching a run element or characters is displayed as a space between words, so it is not removed.
 *
 * @param text Text that may be whitespace only.
 * @returns `true` if it is whitespace only and neither sibling (skipping whitespace-only text) is a run element or
 *   non-whitespace text.
 */
function isBlockSeparator(text: Text): boolean {
  return isHtmlWhitespaceOnly(text.data)
    && !isRunNeighbor(readNeighbor(text, 'previous'))
    && !isRunNeighbor(readNeighbor(text, 'next'));
}

/**
 * Returns the adjacent sibling, skipping whitespace-only text.
 *
 * @param node The node to start from.
 * @param side Previous or next.
 * @returns The adjacent sibling, or `null` if there is none.
 */
function readNeighbor(node: Node, side: 'previous' | 'next'): Node | null {
  let current = side === 'previous' ? node.previousSibling : node.nextSibling;
  while (current instanceof Text && isHtmlWhitespaceOnly(current.data)) {
    current = side === 'previous' ? current.previousSibling : current.nextSibling;
  }
  return current;
}

/**
 * Returns whether the adjacent sibling makes whitespace a space between words.
 *
 * @param node The adjacent sibling. Whitespace-only text has been skipped.
 * @returns `true` for text or a run element.
 */
function isRunNeighbor(node: Node | null): boolean {
  if (node instanceof Text) {
    return true;
  }
  return node instanceof Element && INLINE_RUN_TAG_NAMES.has(node.localName);
}

/**
 * Collects the pieces of the text form from a node and its descendants in document order. After the children's pieces
 * come a cell's tab and a row's line break, and around all of them the block's line break requests (the same order as
 * innerText).
 *
 * @param node The node to collect from.
 * @param insidePre Whether the node is inside `pre`.
 * @param pieces The list the pieces are appended to.
 */
function collectTextPieces(node: Node, insidePre: boolean, pieces: TextPiece[]): void {
  if (node instanceof Text) {
    pieces.push(insidePre
      ? { kind: 'preformatted', value: readPreformattedText(node) }
      : { kind: 'text', value: node.data.replace(HTML_WHITESPACE_RUN_PATTERN, ' ') });
    return;
  }
  if (!(node instanceof Element)) {
    return;
  }
  const name = node.localName;
  if (name === 'br') {
    pieces.push({ kind: 'lineEnd', value: '\n' });
    return;
  }

  const count = name === 'p' ? 2 : TEXT_BLOCK_TAG_NAMES.has(name) ? 1 : 0;
  if (count > 0) {
    pieces.push({ kind: 'break', count });
  }
  for (const child of node.childNodes) {
    collectTextPieces(child, insidePre || name === 'pre', pieces);
  }
  if (CELL_TAG_NAMES.has(name) && hasFollowingCell(node)) {
    pieces.push({ kind: 'lineEnd', value: '\t' });
  }
  if (name === 'tr' && hasFollowingRow(node)) {
    pieces.push({ kind: 'lineEnd', value: '\n' });
  }
  if (count > 0) {
    pieces.push({ kind: 'break', count });
  }
}

/**
 * Reads text inside `pre` as displayed.
 *
 * @param text Text inside `pre`.
 * @returns The text, without the trailing line break if the text holds the one that is not displayed.
 */
function readPreformattedText(text: Text): string {
  const pre = text.parentElement?.closest('pre') ?? null;
  const trailing = pre === null ? undefined : findTrailingPreBreak(pre);
  return trailing?.text === text ? text.data.slice(0, trailing.offset) : text.data;
}

/**
 * Returns whether another cell in the same row follows a cell.
 *
 * @param cell The cell.
 * @returns `true` if a following sibling is a cell.
 */
function hasFollowingCell(cell: Element): boolean {
  for (let sibling = cell.nextElementSibling; sibling !== null; sibling = sibling.nextElementSibling) {
    if (CELL_TAG_NAMES.has(sibling.localName)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns whether another row of the same table follows a row. Rows are counted across table sections, and rows of
 * nested tables are not counted.
 *
 * @param row The row.
 * @returns `true` if a later row exists in the same table.
 */
function hasFollowingRow(row: Element): boolean {
  const table = row.closest('table');
  if (table === null) {
    return false;
  }
  const rows: Element[] = [...table.querySelectorAll('tr')].filter((candidate) => candidate.closest('table') === table);
  return rows.indexOf(row) < rows.length - 1;
}

/**
 * Joins the pieces into the text form.
 *
 * A collapsed space is dropped at the start of a line, and dropped rather than carried over at the end of a line,
 * since spaces at the start and end of a line are not displayed. Block line break requests are dropped at the start
 * and end, and consecutive ones merge into the largest count among them.
 *
 * @param pieces The pieces in document order.
 * @returns The text form.
 */
function joinTextPieces(pieces: readonly TextPiece[]): string {
  let text = '';
  let breaks = 0;
  let lineStart = true;
  let space = false;
  const append = (value: string): void => {
    if (text !== '') {
      text += '\n'.repeat(breaks);
    }
    breaks = 0;
    text += value;
  };

  for (const piece of pieces) {
    if (piece.kind === 'break') {
      breaks = Math.max(breaks, piece.count);
      lineStart = true;
      space = false;
    } else if (piece.kind === 'lineEnd') {
      append(piece.value);
      lineStart = true;
      space = false;
    } else if (piece.kind === 'preformatted') {
      if (piece.value !== '') {
        append(piece.value);
        lineStart = piece.value.endsWith('\n');
        space = false;
      }
    } else {
      // Runs of whitespace are already collapsed, so there is at most one space at the start and one at the end.
      let value = piece.value;
      if (value.startsWith(' ')) {
        space ||= !lineStart;
        value = value.slice(1);
      }
      if (value !== '') {
        const trailing = value.endsWith(' ');
        append(`${space ? ' ' : ''}${trailing ? value.slice(0, -1) : value}`);
        space = trailing;
        lineStart = false;
      }
    }
  }
  return text;
}
