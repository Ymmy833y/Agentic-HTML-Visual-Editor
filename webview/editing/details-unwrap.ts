import { BLOCK_SEPARATOR_TEXT, INLINE_RUN_TAG_NAMES, fillPlaceholder, wrapInlineRuns } from './block';
import type { BlockRewriteProgress } from './block-format';
import { placeCaret } from './caret';

/**
 * Unwraps the details section of a title, leaving the title as a paragraph and the body blocks in its place.
 *
 * Every other delete at the borders of a details section does nothing, and selecting the whole section is impossible when it starts the document, so this is
 * the way to remove one from the caret. The body is kept even when the section is closed: deleting content that is not displayed would go unnoticed until
 * someone opens it.
 *
 * @param title The title of the details section to unwrap.
 * @param range The range carried by the input dispatcher. Placed at the start of the first block made from the title, like the caret.
 * @param progress The progress recording whether the tree changed.
 */
export function unwrapDetailsSection(title: Element, range: Range, progress: BlockRewriteProgress): void {
  const section = title.parentElement;
  if (section === null) {
    return;
  }
  const document = section.ownerDocument;
  const children = [...section.childNodes];
  const index = children.indexOf(title);
  // Set the progress before changing the tree, so that what changed can be closed as an edit even if an exception occurs partway.
  progress.changed = true;

  const fromTitle = unwrapTitle(title);
  const outputs = [
    ...layOutBlocks(children.slice(0, index), document),
    ...fromTitle,
    ...layOutBlocks(children.slice(index + 1), document),
  ];
  // One line break goes between the outputs, as when a block is inserted. The indentation and blank lines inside the section belonged to its own layout.
  const separated = outputs.flatMap((output, position) => (
    position === 0 ? [output] : [document.createTextNode(BLOCK_SEPARATOR_TEXT), output]
  ));
  section.replaceWith(...separated);

  const first = fromTitle.find((node): node is Element => node instanceof Element);
  if (first !== undefined) {
    placeAtStart(first, range);
  }
}

/**
 * Makes what stands in for the title.
 *
 * An inline-only title becomes one paragraph that takes over all of its attributes: `id`, `style` and the like are the author's information and cannot be recovered
 * once dropped. The blocks of a title with blocks inside stay as they are, and only the inline run in front of them becomes the paragraph with the attributes.
 *
 * @param title The title.
 * @returns The blocks, paragraphs and HTML comments to output, in document order. Always contains at least one element.
 */
function unwrapTitle(title: Element): ChildNode[] {
  const document = title.ownerDocument;
  const children = [...title.childNodes];
  const boundary = children.findIndex(endsRun);
  if (boundary === -1) {
    const paragraph = document.createElement('p');
    moveAttributes(title, paragraph);
    paragraph.append(...children);
    // A paragraph with no content has no height, and the line would look as if it disappeared.
    fillPlaceholder(paragraph);
    return [paragraph];
  }

  const leading = wrapInlineRuns(children.slice(0, boundary), document);
  const paragraph = leading.find((node): node is Element => node instanceof Element);
  if (paragraph !== undefined) {
    moveAttributes(title, paragraph);
  }
  return [...leading, ...layOutBlocks(children.slice(boundary), document)];
}

/**
 * Lays out children in document order: elements that do not belong in a bare run as they are, and the runs between them wrapped in paragraphs.
 *
 * Runs end at the same elements as when a target block wraps a bare run. Putting a table, a details section, a `summary` or a `section` into a paragraph would make
 * the parser close the paragraph when the document is saved and reopened, changing the shape of the tree.
 *
 * @param nodes Children of the same parent, in document order.
 * @param document The document used to create the paragraphs.
 * @returns What to output (elements, paragraphs wrapping runs and HTML comments), in document order.
 */
function layOutBlocks(nodes: readonly ChildNode[], document: Document): ChildNode[] {
  const outputs: ChildNode[] = [];
  let run: ChildNode[] = [];
  for (const node of nodes) {
    if (endsRun(node)) {
      outputs.push(...wrapInlineRuns(run, document), node);
      run = [];
      continue;
    }
    run.push(node);
  }
  outputs.push(...wrapInlineRuns(run, document));
  return outputs;
}

/**
 * Determines whether a node ends a run and is output as it is.
 *
 * @param node The node to inspect.
 * @returns `true` for an element that does not belong in a bare run.
 */
function endsRun(node: Node): boolean {
  return node instanceof Element && !INLINE_RUN_TAG_NAMES.has(node.localName);
}

/**
 * Moves attributes along with their namespace and spelling.
 *
 * @param source The element to move from.
 * @param target The element to move to.
 */
function moveAttributes(source: Element, target: Element): void {
  for (const attribute of [...source.attributes]) {
    source.removeAttributeNode(attribute);
    target.setAttributeNodeNS(attribute);
  }
}

/**
 * Places the caret and the range at the start of a block.
 *
 * Unless the block starts with text, element offset 0 is used, so the caret lands before a placeholder `br`, and outside a comment annotation the block starts with.
 *
 * @param block The block.
 * @param range The range to move along with the caret.
 */
function placeAtStart(block: Element, range: Range): void {
  const first = block.firstChild;
  const container = first instanceof Text ? first : block;
  placeCaret(container, 0);
  range.setStart(container, 0);
  range.collapse(true);
}
