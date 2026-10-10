// Matches text made up only of HTML whitespace. It is not counted as content because it is not visible.
const HTML_WHITESPACE_ONLY_PATTERN = /^[\t\n\f\r ]*$/u;

/**
 * Determines whether text consists only of invisible whitespace.
 *
 * An NBSP is treated as content rather than whitespace because it does not collapse and has width.
 *
 * @param text The text to inspect.
 * @returns `true` when the text contains only whitespace.
 */
export function isHtmlWhitespaceOnly(text: string): boolean {
  return HTML_WHITESPACE_ONLY_PATTERN.test(text);
}

/** Elements that may directly contain the caret. */
export const BLOCK_TAG_NAMES: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'div',
  'li',
  'blockquote',
  'pre',
  'details',
  'summary',
  'td',
  'th',
]);

/**
 * The elements that belong in a bare run: the HTML phrasing content elements minus the forbidden tags, plus the
 * `comment` of comment annotations. Decided by name alone; the contents are not inspected.
 *
 * Elements that are not phrasing content (tables, details sections, `section`, `dl` and so on) end a run, because
 * putting them in a paragraph makes the parser close the paragraph when the document is saved and reopened, changing
 * the shape of the tree. Conversely, ending a run at `b`, `i`, `u` and the like would wrap only part of a sentence in
 * a paragraph, and conversion to a heading or similar would stop in the middle of the sentence.
 *
 * This is the only set that defines what a run is. If the side that counts runs used a different set, it would
 * diverge from the range that ensuring a target wraps and leave nodes unwrapped.
 *
 * Read not only by ensuring a target block but also by the between-blocks position check (materialization), so it lives here, depending on no other module.
 */
export const INLINE_RUN_TAG_NAMES: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'area',
  'audio',
  'b',
  'bdi',
  'bdo',
  'br',
  'button',
  'canvas',
  'cite',
  'code',
  'data',
  'datalist',
  'del',
  'dfn',
  'em',
  'i',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'map',
  'mark',
  'math',
  'meter',
  'output',
  'picture',
  'progress',
  'q',
  'ruby',
  's',
  'samp',
  'select',
  'slot',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'svg',
  'template',
  'textarea',
  'time',
  'u',
  'var',
  'video',
  'wbr',
  'comment',
]);

/** Elements that Enter can split in two. */
export const SPLITTABLE_BLOCK_TAG_NAMES: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'div',
  'li',
]);

/** Headings that switch to a paragraph when Enter is pressed at the end. */
export const HEADING_TAG_NAMES: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * Text inserted immediately before a new block.
 *
 * Because line mapping operates by line, omitting the line break would put the new block on the same
 * line as the preceding block and normalize even the spelling of untouched blocks. No indentation is added.
 */
export const BLOCK_SEPARATOR_TEXT = '\n';

/**
 * Element names counted as block children. A block containing one of these does not have inline-only children.
 *
 * The end of a list item's item line and the end of a merge target are decided by this same set. With a
 * separate set, the check for block children and the check for the end of the line would disagree, and a
 * position that is not on the line would be treated as if it were.
 */
export const NESTED_BLOCK_TAG_NAMES: ReadonlySet<string> = new Set([
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
  'ul',
  'ol',
  'table',
]);

/**
 * Determines whether an element has a block child.
 *
 * @param element The element to inspect.
 * @returns `true` when the element has a block child.
 */
export function hasBlockChild(element: Element): boolean {
  for (const child of element.children) {
    if (NESTED_BLOCK_TAG_NAMES.has(child.localName)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns the nearest block containing the caret.
 *
 * @param node The starting node.
 * @param root The editor root.
 * @returns The nearest block, or `undefined` when only the editor root is found or the node is outside it.
 */
export function findBlock(node: Node, root: Element): Element | undefined {
  if (!root.contains(node)) {
    return undefined;
  }

  let current: Element | null = node instanceof Element ? node : node.parentElement;
  while (current !== null && current !== root) {
    if (BLOCK_TAG_NAMES.has(current.localName)) {
      return current;
    }
    current = current.parentElement;
  }
  return undefined;
}

/**
 * Determines whether an element is a splittable block with inline-only children.
 *
 * @param element The element to inspect.
 * @returns `true` when the element is splittable.
 */
export function isSplittableBlock(element: Element): boolean {
  return SPLITTABLE_BLOCK_TAG_NAMES.has(element.localName) && !hasBlockChild(element);
}

/**
 * Determines whether an element can be merged with an adjacent element.
 *
 * @param element The element to inspect.
 * @returns `true` when the element is mergeable.
 */
export function isMergeableBlock(element: Element): boolean {
  if (isSplittableBlock(element)) {
    return true;
  }
  return element.localName === 'blockquote' && !hasBlockChild(element);
}

/**
 * Determines whether a block contains only a placeholder.
 *
 * @param element The element to inspect.
 * @returns `true` when it contains only whitespace text and at most one `br`. An NBSP counts as content.
 */
export function isEmptyBlock(element: Element): boolean {
  let breakCount = 0;
  for (const child of element.childNodes) {
    if (child instanceof Text) {
      if (!HTML_WHITESPACE_ONLY_PATTERN.test(child.data)) {
        return false;
      }
      continue;
    }
    if (child instanceof Element && child.localName === 'br') {
      breakCount += 1;
      if (breakCount > 1) {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Creates an empty block containing only a placeholder `br`.
 *
 * No attributes are added because copying them would also duplicate IDs and internal attributes.
 *
 * @param document The document in which to create the element.
 * @param tagName The tag name of the element to create.
 * @returns An empty block containing a placeholder.
 */
export function createEmptyBlock(document: Document, tagName: string): Element {
  const block = document.createElement(tagName);
  block.append(document.createElement('br'));
  return block;
}

/**
 * Adds a placeholder to an empty block.
 *
 * An empty block has no height and makes the line appear to disappear, so a single `br` provides empty-line height.
 *
 * @param block The target block.
 */
export function fillPlaceholder(block: Element): void {
  if (!isEmptyBlock(block)) {
    return;
  }
  block.replaceChildren(block.ownerDocument.createElement('br'));
}

/**
 * Removes a trailing placeholder after text makes it unnecessary.
 *
 * A `br` in a block without non-whitespace text provides empty-line height, so removing it would hide the line.
 *
 * @param block The target block.
 */
export function removePlaceholderBreak(block: Element): void {
  const last = block.lastChild;
  if (!(last instanceof Element) || last.localName !== 'br') {
    return;
  }
  if (HTML_WHITESPACE_ONLY_PATTERN.test(block.textContent ?? '')) {
    return;
  }
  last.remove();
}

/** The side of the reference element on which to insert a new block. */
export type BlockInsertPosition = 'before' | 'after';

/**
 * Inserts a new block with a single line break.
 *
 * Exactly one line break is always inserted immediately before the block without changing existing whitespace
 * around the reference element.
 *
 * @param block The block to insert.
 * @param reference The element that anchors the insertion position.
 * @param position Whether to insert before or after the reference element.
 */
export function insertBlock(
  block: Element,
  reference: Element,
  position: BlockInsertPosition,
): void {
  const document = reference.ownerDocument;
  const separator = document.createTextNode(BLOCK_SEPARATOR_TEXT);
  if (position === 'before') {
    // Also insert a line break on the reference element's side. Existing whitespace moves before the new block;
    // without this break, the reference element would share its line and even untouched spelling would normalize.
    reference.before(separator, block, document.createTextNode(BLOCK_SEPARATOR_TEXT));
    return;
  }
  reference.after(separator, block);
}

/**
 * Appends a block to the end of a parent, preceded by a single newline.
 *
 * @param block The block to append (or an HTML comment between blocks).
 * @param parent The parent to append to.
 */
export function appendBlock(block: ChildNode, parent: Element): void {
  parent.append(parent.ownerDocument.createTextNode(BLOCK_SEPARATOR_TEXT), block);
}

/**
 * Returns whether content follows a given block within the same parent.
 *
 * Line breaks and indentation between blocks are skipped, since they are not content. Bare text is
 * not a place to land the caret but still counts as content, and adding an empty paragraph before it
 * would leave a blank line in the middle of the document.
 *
 * Inserting a collapsible section and inserting a table both decide whether to add an empty
 * paragraph through this single check. With the check in two places, fixing only one of them would
 * make whether a blank line appears at the same position depend on the kind of insertion.
 *
 * @param block The block to start from.
 * @returns `true` if an element or non-whitespace text follows.
 */
export function hasFollowingContent(block: Element): boolean {
  for (let node = block.nextSibling; node !== null; node = node.nextSibling) {
    if (node instanceof Element) {
      return true;
    }
    if (node instanceof Text && !isHtmlWhitespaceOnly(node.data)) {
      return true;
    }
  }
  return false;
}

/**
 * Lays out a sequence of children in document order: block children as they are, and the inline runs between
 * and around them wrapped in paragraphs.
 *
 * A run of only whitespace and HTML comments is invisible, so it is not wrapped in a paragraph; only its
 * comments are output as they are. Wrapping it would add a line with no content, and dropping it would remove
 * the author's comments from the saved file. Whitespace-only text at the edges of a run separates lines, so it
 * is removed from the tree.
 *
 * @param nodes A sequence of children of the same parent, in document order.
 * @param document The document used to create the paragraphs that wrap runs.
 * @returns What to output (block children, new paragraphs wrapping runs, and comments), in document order.
 */
export function wrapInlineRuns(nodes: readonly ChildNode[], document: Document): ChildNode[] {
  const outputs: ChildNode[] = [];
  let run: ChildNode[] = [];
  for (const node of nodes) {
    if (node instanceof Element && NESTED_BLOCK_TAG_NAMES.has(node.localName)) {
      outputs.push(...wrapRun(run, document), node);
      run = [];
      continue;
    }
    run.push(node);
  }
  outputs.push(...wrapRun(run, document));
  return outputs;
}

/**
 * Wraps a single inline run in a paragraph if it is visible, or reduces it to its comments if it is not.
 *
 * @param run The inline run.
 * @param document The document used to create the paragraph.
 * @returns The paragraph wrapping the run, or the list of comments.
 */
function wrapRun(run: readonly ChildNode[], document: Document): ChildNode[] {
  const trimmed = trimSeparators(run);
  const visible = trimmed.some(
    (node) => node instanceof Element || (node instanceof Text && !isHtmlWhitespaceOnly(node.data)),
  );
  const kept = new Set(visible ? trimmed : trimmed.filter((node) => node instanceof Comment));
  // Whitespace that is not carried would otherwise stay in the original parent, leaving a row of bare line
  // separators behind after the move.
  for (const node of run) {
    if (!kept.has(node)) {
      node.remove();
    }
  }
  if (!visible) {
    return [...kept];
  }
  const paragraph = document.createElement('p');
  paragraph.append(...kept);
  return [paragraph];
}

/**
 * Drops the whitespace-only text at both ends of a run. It is the newline between lines and does not count as
 * paragraph content.
 *
 * @param run The inline run.
 * @returns The run without whitespace at either end.
 */
function trimSeparators(run: readonly ChildNode[]): ChildNode[] {
  const isContent = (node: Node): boolean => !(node instanceof Text && isHtmlWhitespaceOnly(node.data));
  const start = run.findIndex(isContent);
  if (start === -1) {
    return [];
  }
  let end = run.length;
  while (end > start && !isContent(run[end - 1])) {
    end -= 1;
  }
  return run.slice(start, end);
}

/**
 * Determines whether this location accepts a line-break character as text.
 *
 * @param node The starting node.
 * @param root The editor root.
 * @returns `true` when the node is a descendant of `pre`.
 */
export function isInsidePre(node: Node, root: Element): boolean {
  let current: Element | null = node instanceof Element ? node : node.parentElement;
  while (current !== null && current !== root) {
    if (current.localName === 'pre') {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

/**
 * Determines whether a range contains a whole node.
 *
 * The range delete, its guards and the code block guard decide "fully contained in the range" by the same line, so it is defined in one place.
 *
 * @param range The range to inspect.
 * @param node The node to inspect.
 * @returns `true` if the borders before and after the node are both within the range. `false` for a node detached from the tree.
 */
export function containsNode(range: Range, node: Node): boolean {
  const document = node.ownerDocument;
  if (document === null || node.parentNode === null) {
    return false;
  }
  const bounds = document.createRange();
  bounds.selectNode(node);
  return range.compareBoundaryPoints(Range.START_TO_START, bounds) <= 0
    && range.compareBoundaryPoints(Range.END_TO_END, bounds) >= 0;
}
