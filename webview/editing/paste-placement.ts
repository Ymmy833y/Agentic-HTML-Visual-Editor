import { findBlock, hasBlockChild, isHtmlWhitespaceOnly, isInsidePre } from './block';
import { findTrailingPreBreak } from './caret';
import { readCommentSplit } from './comment-split';
import type { NodeBoundary } from '../selection/selection-position';

/**
 * The placement of a paste fragment.
 *
 * Between deciding the placement and inserting, the range deletion and split preprocessors move positions, so the
 * placement holds no position and carries only elements.
 */
export type PastePlacement =
  // Insert at the caret, keeping it inline.
  | { readonly kind: 'caret' }
  // Turn a fragment that is only a single-line code block into inline code and insert it at the caret.
  | { readonly kind: 'inlineCode' }
  // Insert next to the current block (paragraph, heading, or div).
  | { readonly kind: 'adjacent'; readonly block: Element }
  // Insert at the caret inside a container that can have block children.
  | { readonly kind: 'container'; readonly container: Element }
  // Insert the fragment's list items as items of the same list as the current item.
  | { readonly kind: 'listItem'; readonly item: Element }
  // Insert the text form without using the HTML form.
  | { readonly kind: 'text' };

// Elements whose start tag makes the parser close an open paragraph. Even if inserted into a paragraph, they end up
// outside it after saving and reopening.
const PARAGRAPH_CLOSING_TAG_NAMES: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'center',
  'dd',
  'details',
  'dialog',
  'dir',
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
  'li',
  'listing',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'plaintext',
  'pre',
  'search',
  'section',
  'summary',
  'table',
  'ul',
  'xmp',
]);

// Table skeleton elements. Apart from table they do not close a paragraph, but they count as blocks so that table rows
// are written one per line.
const TABLE_SKELETON_TAG_NAMES: ReadonlySet<string> = new Set([
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'colgroup',
  'col',
  'caption',
]);

// Elements whose content is not HTML. Descendants with block names inside them are not HTML blocks.
const FOREIGN_CONTENT_TAG_NAMES: ReadonlySet<string> = new Set(['svg', 'math']);

// Current blocks that cannot have block children, so the fragment goes next to them.
const ADJACENT_BLOCK_TAG_NAMES: ReadonlySet<string> = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div']);

const LIST_TAG_NAMES: ReadonlySet<string> = new Set(['ul', 'ol']);

/**
 * Returns whether a fragment node is a block. Paragraph-closing elements, table skeleton elements, and elements with
 * either among their descendants are blocks.
 *
 * Inserting a paragraph-closing element into a paragraph as inline content makes the parser close the paragraph after
 * saving and reopening, which changes the shape of the tree. A link wrapping blocks counts as a block for the same
 * reason. Conversely, counting elements that do not close a paragraph (the `font` Gmail writes, ruby `rb`, custom
 * elements, and so on) as blocks would split the paragraph on a single-line paste and put the element directly under
 * the editor root. The phrasing content list used to ensure a target block lacks such elements, so it is not used.
 *
 * @param node A fragment node. Also accepts `null` from looking up a sibling.
 * @returns `true` for a block. `false` for text and `null`.
 */
export function isPasteBlock(node: Node | null): boolean {
  if (!(node instanceof Element)) {
    return false;
  }
  return isBlockTagName(node.localName) || hasBlockDescendant(node);
}

/**
 * Decides a single placement for the fragment from the position and the fragment. Does not change the tree or the
 * selection.
 *
 * @param fragment The fragment.
 * @param root The editor root.
 * @param position The position to decide at (the start of the range, or the caret after deleting the range).
 * @returns The placement.
 */
export function decidePastePlacement(fragment: DocumentFragment, root: Element, position: NodeBoundary): PastePlacement {
  // A code block has no formatting, so insert the text form regardless of the fragment.
  if (isInsidePre(position.container, root)) {
    return { kind: 'text' };
  }
  const children = [...fragment.childNodes];
  if (!children.some((child) => isPasteBlock(child))) {
    return { kind: 'caret' };
  }
  const contents = children.filter((child) => !(child instanceof Text && isHtmlWhitespaceOnly(child.data)));
  if (isSingleLineCodeBlock(contents)) {
    return { kind: 'inlineCode' };
  }

  const block = findBlock(position.container, root);
  // Titles and annotated text cannot hold blocks or be split, so insert the text form. A comment edge does not count as
  // the middle.
  if (isInsideSummary(position.container, root) || readCommentSplit(block ?? root, position).kind === 'middle') {
    return { kind: 'text' };
  }
  if (
    block !== undefined
    && block.localName === 'li'
    && !hasBlockChild(block)
    && contents.every((child) => isItemOnlyList(child))
  ) {
    // Inserting into the item would make a nested list, so split the item and line the new items up in the same list.
    // An item with block children cannot be split, so it is treated as a container. A list with children other than
    // items would lose the rest if only its items were lined up, so it is also treated as a container.
    return { kind: 'listItem', item: block };
  }
  if (block !== undefined && ADJACENT_BLOCK_TAG_NAMES.has(block.localName)) {
    return { kind: 'adjacent', block };
  }
  // A position with no current block (inside a hand-written element not in the list) is treated like a container too.
  return { kind: 'container', container: block ?? root };
}

/**
 * Returns whether the element has a block element among its descendants.
 *
 * @param element The element.
 * @returns `true` if a paragraph-closing element or a table skeleton element is among its descendants.
 */
function hasBlockDescendant(element: Element): boolean {
  if (FOREIGN_CONTENT_TAG_NAMES.has(element.localName)) {
    return false;
  }
  for (const child of element.children) {
    if (isBlockTagName(child.localName) || hasBlockDescendant(child)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns whether the tag name is that of a block element.
 *
 * @param tagName The tag name.
 * @returns `true` for a paragraph-closing element or a table skeleton element.
 */
function isBlockTagName(tagName: string): boolean {
  return PARAGRAPH_CLOSING_TAG_NAMES.has(tagName) || TABLE_SKELETON_TAG_NAMES.has(tagName);
}

/**
 * Returns whether the top level, excluding whitespace text, is a single `pre` with no line breaks or blocks inside. A
 * trailing pre break is not counted.
 *
 * A `pre` that draws its lines with blocks such as `div` spans multiple lines even without newline characters. Turning
 * it into inline `code` would put blocks inside a paragraph, and the parser would close the paragraph after saving
 * and reopening, changing the shape of the tree, so it does not count as a single line.
 *
 * @param contents The top level of the fragment, excluding whitespace text.
 * @returns `true` if it is only a single-line code block.
 */
function isSingleLineCodeBlock(contents: readonly ChildNode[]): boolean {
  const [pre] = contents;
  if (
    contents.length !== 1
    || !(pre instanceof Element)
    || pre.localName !== 'pre'
    || pre.querySelector('br') !== null
    || hasBlockDescendant(pre)
  ) {
    return false;
  }
  const lineBreaks = (pre.textContent ?? '').split('\n').length - 1;
  return lineBreaks - (findTrailingPreBreak(pre) === undefined ? 0 : 1) === 0;
}

/**
 * Returns whether the node is a list whose children are only items (`li`) and whitespace text.
 *
 * Evernote and others put nested lists directly under the list instead of inside an item.
 *
 * @param node A top-level node of the fragment.
 * @returns `true` for a `ul` or `ol` with only items as children.
 */
function isItemOnlyList(node: ChildNode): boolean {
  if (!(node instanceof Element) || !LIST_TAG_NAMES.has(node.localName)) {
    return false;
  }
  return [...node.childNodes].every((child) => (
    (child instanceof Element && child.localName === 'li') || (child instanceof Text && isHtmlWhitespaceOnly(child.data))
  ));
}

/**
 * Returns whether the position is inside a title (`summary`).
 *
 * @param node The node of the position.
 * @param root The editor root.
 * @returns `true` if it has a `summary` ancestor inside the editor root.
 */
function isInsideSummary(node: Node, root: Element): boolean {
  const summary = (node instanceof Element ? node : node.parentElement)?.closest('summary') ?? null;
  return summary !== null && summary !== root && root.contains(summary);
}
