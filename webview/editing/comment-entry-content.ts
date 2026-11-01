import { COMMENT_ENTRY_BLOCK_TAG_NAME, COMMENT_TAG_NAME } from '../../common/index';
import { quarantineUnsafeAttributes } from '../document/attribute-sanitizer';
import { removeEditingArtifacts } from '../document/editing-artifact';
import { createInverseTransformedCopy } from '../document/inverse-transform';
import { isDiagramSource } from '../diagram/diagram-source';
import { BLOCK_SEPARATOR_TEXT, INLINE_RUN_TAG_NAMES, isEmptyBlock, isHtmlWhitespaceOnly } from './block';

// The parts of a comment annotation. A hand-written comment inside an entry is read as its text, the same way the
// thread reads a document with nested comments.
const COMMENT_PART_SELECTOR = [COMMENT_TAG_NAME.comment, COMMENT_TAG_NAME.body, COMMENT_TAG_NAME.reply].join(', ');

// Elements that show something without text. An entry holding one of them is not blank.
const CONTENT_WITHOUT_TEXT_SELECTOR = 'img, hr, table';

// Elements that are drawn even without children. An empty element of any other name shows nothing.
const VOID_TAG_NAMES: ReadonlySet<string> = new Set(['area', 'br', 'hr', 'img', 'input', 'wbr']);

// HTML whitespace at the start and at the end of a text.
const LEADING_WHITESPACE_PATTERN = /^[\t\n\f\r ]+/u;
const TRAILING_WHITESPACE_PATTERN = /[\t\n\f\r ]+$/u;

/**
 * Returns the node whose children are the content of an entry.
 *
 * An entry that holds a block other than a paragraph keeps its content in one `template`, because the parser would
 * close the paragraph the comment sits in at the first block written directly inside it. Any other entry holds its
 * content as its own children.
 *
 * @param entry The entry (a body or a reply).
 * @returns The content of the `template` when the entry holds nothing else but whitespace, or else the entry.
 */
export function readEntrySource(entry: Element): ParentNode {
  let template: HTMLTemplateElement | undefined;
  for (const child of entry.childNodes) {
    if (child instanceof Text && isHtmlWhitespaceOnly(child.data)) {
      continue;
    }
    if (template !== undefined || !(child instanceof HTMLTemplateElement)) {
      return entry;
    }
    template = child;
  }
  return template?.content ?? entry;
}

/**
 * Copies the content of an entry into the shape a field holds and the popup shows: blocks, as in the document.
 *
 * Content in the line form becomes one paragraph per line, with the inline elements it holds; the HTML whitespace at
 * its two ends is left out, as it is the indentation the writer put between tags. Content in the block form keeps its
 * blocks, and an inline run between them becomes paragraphs. Nothing in the copy can act in the view: an `id` would
 * duplicate one of the document, and dangerous attributes are quarantined as when the document is opened.
 *
 * @param entry The entry.
 * @param document The document the copy is made in.
 * @returns The copy. Empty for an entry that holds nothing but whitespace.
 */
export function copyEntryContent(entry: Element, document: Document): DocumentFragment {
  const container = document.createElement('div');
  for (const child of readEntrySource(entry).childNodes) {
    container.append(document.importNode(child, true));
  }
  for (const part of [...container.querySelectorAll(COMMENT_PART_SELECTOR)].reverse()) {
    part.replaceWith(...part.childNodes);
  }
  if ([...container.children].some((child) => !INLINE_RUN_TAG_NAMES.has(child.localName))) {
    container.replaceChildren(...wrapRuns([...container.childNodes], document));
  } else {
    splitIntoParagraphs(container);
  }
  for (const element of container.querySelectorAll('[id]')) {
    element.removeAttribute('id');
  }
  quarantineUnsafeAttributes(container);
  const copy = document.createDocumentFragment();
  copy.append(...container.childNodes);
  return copy;
}

/**
 * Turns what a field holds into the content an entry is written with.
 *
 * The children go through the same inverse transform as a save, so that the entry keeps what the writer wrote rather
 * than what the view shows, and the editing artifacts are left out. When every block is a paragraph without
 * attributes, the content takes the line form: the paragraphs joined by line breaks in the text, which is what an
 * entry without blocks has always held. Otherwise it takes the block form: one `template` holding the blocks, each
 * after a line break.
 *
 * @param source The node whose children are the blocks of a field.
 * @param document The document the content is made in.
 * @returns The content. Empty when the field holds nothing.
 */
export function toEntryContent(source: Element | DocumentFragment, document: Document): DocumentFragment {
  const copy = createInverseTransformedCopy(source);
  removeEditingArtifacts(copy);
  const blocks = wrapRuns([...copy.childNodes], copy.ownerDocument);
  const content = document.createDocumentFragment();
  if (blocks.every(isPlainParagraph)) {
    blocks.forEach((block, index) => {
      if (index > 0) {
        content.append('\n');
      }
      if (block instanceof Element && !isEmptyBlock(block)) {
        content.append(document.importNode(block, true));
        unwrapLast(content);
      }
    });
    for (const lineBreak of [...content.querySelectorAll('br')]) {
      lineBreak.replaceWith('\n');
    }
    content.normalize();
    return content;
  }
  const template = document.createElement(COMMENT_ENTRY_BLOCK_TAG_NAME);
  if (!(template instanceof HTMLTemplateElement)) {
    throw new Error('The element that wraps the blocks of an entry is not a template');
  }
  for (const block of blocks) {
    template.content.append(BLOCK_SEPARATOR_TEXT, template.content.ownerDocument.importNode(block, true));
  }
  template.content.append(BLOCK_SEPARATOR_TEXT);
  content.append(template);
  return content;
}

/**
 * Returns the spelling two contents are compared by.
 *
 * Two contents with the same elements, attributes and text have the same spelling, however their text is split into
 * nodes. The blocks inside a `template` are part of the spelling.
 *
 * @param content The content, as `toEntryContent` returns it.
 * @returns The spelling. The empty string for an empty content.
 */
export function readEntryContentKey(content: DocumentFragment): string {
  const container = content.ownerDocument.createElement('div');
  container.append(content.cloneNode(true));
  return container.innerHTML;
}

/**
 * Returns whether a content shows nothing.
 *
 * Elements around whitespace do not make an entry worth writing, but an image, a horizontal rule, a table or a diagram
 * does, even without text.
 *
 * @param content The content, or the blocks of a field.
 * @returns `true` when the text is HTML whitespace only and there is no image, rule, table or diagram.
 */
export function isEntryContentBlank(content: ParentNode): boolean {
  const parts = readContentParts(content);
  return parts.every((part) => isHtmlWhitespaceOnly(readOwnText(part)))
    && !parts.some((part) => part.querySelector(CONTENT_WITHOUT_TEXT_SELECTOR) !== null
      || [...part.querySelectorAll('pre')].some(isDiagramSource));
}

/**
 * Lays out the children of a field or of an entry as blocks: elements that are not phrasing content as they are, and
 * each run of text and phrasing content between them in a paragraph.
 *
 * A run of only whitespace shows nothing, so it is dropped rather than wrapped; HTML comments are dropped too. The
 * nodes are moved, not copied.
 *
 * @param nodes The children, in document order.
 * @param document The document the paragraphs are made in.
 * @returns The blocks, in document order.
 */
function wrapRuns(nodes: readonly ChildNode[], document: Document): Element[] {
  const blocks: Element[] = [];
  let run: ChildNode[] = [];
  const isContent = (node: ChildNode): boolean => !(node instanceof Text && isHtmlWhitespaceOnly(node.data));
  const flush = (): void => {
    // The whitespace at the two ends of a run is the line break between blocks, not part of the paragraph.
    const start = run.findIndex(isContent);
    if (start !== -1) {
      const end = run.length - [...run].reverse().findIndex(isContent);
      const paragraph = document.createElement('p');
      paragraph.append(...run.slice(start, end));
      trimEdge(paragraph, 'start');
      trimEdge(paragraph, 'end');
      blocks.push(paragraph);
    }
    run = [];
  };
  for (const node of nodes) {
    if (node instanceof Element && !INLINE_RUN_TAG_NAMES.has(node.localName)) {
      flush();
      blocks.push(node);
    } else if (node instanceof Element || node instanceof Text) {
      run.push(node);
    }
  }
  flush();
  return blocks;
}

/**
 * Turns inline content into one paragraph per line, in place.
 *
 * A line ends at a line break in the text and at a `br`. A paragraph that holds nothing gets a placeholder `br`, as an
 * empty block of the document does, so that the empty line keeps its height.
 *
 * @param container The element whose children are the inline content.
 */
function splitIntoParagraphs(container: Element): void {
  const document = container.ownerDocument;
  for (const lineBreak of [...container.querySelectorAll('br')]) {
    lineBreak.replaceWith('\n');
  }
  trimEdge(container, 'start');
  trimEdge(container, 'end');
  if (container.childNodes.length === 0) {
    return;
  }
  const lines: DocumentFragment[] = [];
  for (let text = findLineBreak(container); text !== undefined; text = findLineBreak(container)) {
    const range = document.createRange();
    range.setStart(container, 0);
    range.setEnd(text, text.data.indexOf('\n'));
    // Extracting clones the elements the line ends inside of, so a format that spans lines is kept on both.
    lines.push(range.extractContents());
    text.deleteData(0, 1);
  }
  const rest = document.createRange();
  rest.selectNodeContents(container);
  lines.push(rest.extractContents());
  container.replaceChildren(...lines.map((line) => {
    const paragraph = document.createElement('p');
    paragraph.append(line);
    removeEmptyElements(paragraph);
    if (isEmptyBlock(paragraph)) {
      paragraph.replaceChildren(document.createElement('br'));
    }
    return paragraph;
  }));
}

/**
 * Finds the first text that holds a line break.
 *
 * @param container The element to look in.
 * @returns The text, or `undefined` when no line break is left.
 */
function findLineBreak(container: Element): Text | undefined {
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text && node.data.includes('\n')) {
      return node;
    }
  }
  return undefined;
}

/**
 * Drops the HTML whitespace at one end of inline content, walking in until visible text is found. Elements left empty
 * go too.
 *
 * @param container The element whose children are the content.
 * @param side The end to trim.
 */
function trimEdge(container: Element, side: 'start' | 'end'): void {
  for (let text = findEdgeText(container, side); text !== undefined; text = findEdgeText(container, side)) {
    text.data = text.data.replace(side === 'start' ? LEADING_WHITESPACE_PATTERN : TRAILING_WHITESPACE_PATTERN, '');
    if (text.data !== '' || hasContentBeside(text, container, side)) {
      return;
    }
    removeWithEmptyAncestors(text, container);
  }
}

/**
 * Returns whether something other than text, such as an image, lies between a text and an end of the content.
 *
 * @param text The text.
 * @param container The element whose children are the content.
 * @param side The end.
 * @returns `true` when an element that shows something comes before the text (for the start) or after it (for the end).
 */
function hasContentBeside(text: Text, container: Element, side: 'start' | 'end'): boolean {
  const range = container.ownerDocument.createRange();
  if (side === 'start') {
    range.setStart(container, 0);
    range.setEndBefore(text);
  } else {
    range.setStartAfter(text);
    range.setEnd(container, container.childNodes.length);
  }
  return [...range.cloneContents().querySelectorAll('*')].some((element) => VOID_TAG_NAMES.has(element.localName));
}

/**
 * Finds the first or the last text of a container.
 *
 * @param container The container.
 * @param side Which end.
 * @returns The text, or `undefined` when the container holds no text.
 */
function findEdgeText(container: Element, side: 'start' | 'end'): Text | undefined {
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let found: Text | undefined;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text) {
      found = node;
      if (side === 'start') {
        return found;
      }
    }
  }
  return found;
}

/**
 * Removes a node, and each ancestor inside the container that it leaves empty.
 *
 * @param node The node.
 * @param container The container. Never removed.
 */
function removeWithEmptyAncestors(node: Node, container: Element): void {
  let current: Node | null = node;
  while (current !== null && current !== container) {
    const parent: ParentNode | null = current.parentNode;
    current.parentNode?.removeChild(current);
    current = parent instanceof Element && parent !== container && parent.childNodes.length === 0 ? parent : null;
  }
}

/**
 * Removes the elements that splitting a line left without children, innermost first.
 *
 * @param block The paragraph of one line.
 */
function removeEmptyElements(block: Element): void {
  for (const element of [...block.querySelectorAll('*')].reverse()) {
    if (element.childNodes.length === 0 && !VOID_TAG_NAMES.has(element.localName)) {
      element.remove();
    }
  }
}

/**
 * Returns whether a block can be written as a line: a paragraph without attributes.
 *
 * @param node The block.
 * @returns `true` for a `p` that has no attribute.
 */
function isPlainParagraph(node: Node): boolean {
  return node instanceof Element && node.localName === 'p' && node.attributes.length === 0;
}

/**
 * Replaces the last child of a fragment, a copied paragraph, with its children.
 *
 * @param content The fragment.
 */
function unwrapLast(content: DocumentFragment): void {
  const last = content.lastChild;
  if (last instanceof Element) {
    last.replaceWith(...last.childNodes);
  }
}

/**
 * Returns a content and the contents of every `template` inside it.
 *
 * @param content The content.
 * @returns The parts. The content itself comes first.
 */
function readContentParts(content: ParentNode): ParentNode[] {
  const parts: ParentNode[] = [content];
  for (let index = 0; index < parts.length; index += 1) {
    for (const template of parts[index].querySelectorAll(COMMENT_ENTRY_BLOCK_TAG_NAME)) {
      if (template instanceof HTMLTemplateElement) {
        parts.push(template.content);
      }
    }
  }
  return parts;
}

/**
 * Returns the text of a part, without the text of the `template` elements inside it, which are read as parts of their
 * own.
 *
 * @param part The part.
 * @returns The text.
 */
function readOwnText(part: ParentNode): string {
  let text = '';
  for (const child of part.childNodes) {
    if (child instanceof Text) {
      text += child.data;
    } else if (child instanceof Element && !(child instanceof HTMLTemplateElement)) {
      text += readOwnText(child);
    }
  }
  return text;
}
