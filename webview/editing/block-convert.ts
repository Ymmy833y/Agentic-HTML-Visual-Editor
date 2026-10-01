import { fillPlaceholder } from './block';
import { BLOCK_KIND, BLOCK_KIND_TAG_NAME, isConvertibleBlock, readBlockKind } from './block-format';
import type { BlockKind } from './block-format';

// The body and replies of a comment annotation. Line breaks inside them belong to the annotation's formatting and
// are not exchanged with the line breaks of a code block.
const COMMENT_TEXT_TAG_NAMES: ReadonlySet<string> = new Set(['comment-body', 'comment-reply']);

/**
 * Converts a single target block to the target kind.
 *
 * This replaces the tag name rather than wrapping or unwrapping. Because the element is exchanged at the same
 * position in the tree, the surrounding whitespace and line breaks are left untouched and only the target's
 * opening and closing lines change. The content nodes are moved by reference, so neither comment annotations
 * nor format elements are split.
 *
 * @param target The target block.
 * @param kind The target kind.
 * @returns The replacement element, or `undefined` when nothing was rewritten.
 */
export function convertBlock(target: Element, kind: BlockKind): Element | undefined {
  if (!isConvertibleBlock(target) || readBlockKind(target) === kind) {
    return undefined;
  }

  const document = target.ownerDocument;
  const fromCodeBlock = readBlockKind(target) === BLOCK_KIND.codeBlock;
  const created = document.createElement(BLOCK_KIND_TAG_NAME[kind]);
  // `id`, `style`, and `data-alert` are the author's information and cannot be recovered once dropped. All
  // attributes are carried over regardless of the kind.
  for (const attribute of target.attributes) {
    created.setAttribute(attribute.name, attribute.value);
  }

  // A code block is built with a single `code` directly beneath the `pre`. That is the shape the authoring guide
  // and the default styles assume, and the contents go inside that `code`.
  const container = kind === BLOCK_KIND.codeBlock ? document.createElement('code') : created;
  container.append(...readSourceNodes(target));

  if (kind === BLOCK_KIND.codeBlock) {
    // Removal of editing artifacts on save does not reach beneath a `pre`. A trailing `br` is not a visible line
    // break, so turning it into a newline character would leave a blank line in the saved content forever. The
    // placeholder of an empty block disappears here as well.
    removeTrailingBreak(container);
    // Line breaks inside a `pre` are handled as newline characters both when Enter inserts one and when the
    // trailing blank line is detected. This settles on a single representation.
    replaceBreaksWithNewlines(container);
    created.append(container);
  } else if (fromCodeBlock) {
    replaceNewlinesWithBreaks(created);
  }

  target.replaceWith(created);
  if (kind !== BLOCK_KIND.codeBlock) {
    // A block with no contents has no height and makes the line appear to disappear. A code block keeps its
    // height through its background and padding, so no placeholder is added there (its text is left empty).
    fillPlaceholder(created);
  }
  return created;
}

/**
 * Returns the contents to move into the new element.
 *
 * @param target The target block.
 * @returns The nodes to move.
 */
function readSourceNodes(target: Element): Node[] {
  const only = target.childNodes.length === 1 ? target.firstChild : null;
  if (target.localName === 'pre' && only instanceof Element && only.localName === 'code') {
    // A `code` that is merely the container of the contents is unwrapped and its attributes are not carried
    // over. In a `pre` that also has content outside the `code`, every child is moved so that no text is lost,
    // and the `code` stays behind as an element.
    return [...only.childNodes];
  }
  return [...target.childNodes];
}

/**
 * Removes a single `br` at the end of the contents.
 *
 * The placeholder of an empty block and a `br` at the end of a line do not create a visible line break. A `br`
 * that precedes one does open the next line, so only the last one is removed.
 *
 * @param container The element the contents were moved into.
 */
export function removeTrailingBreak(container: Element): void {
  const last = container.lastChild;
  if (last instanceof Element && last.localName === 'br') {
    last.remove();
  }
}

/**
 * Replaces `br` elements with newline characters.
 *
 * @param container The element the contents were moved into.
 */
export function replaceBreaksWithNewlines(container: Element): void {
  for (const element of container.querySelectorAll('br')) {
    if (isInsideCommentText(element, container)) {
      continue;
    }
    element.replaceWith(container.ownerDocument.createTextNode('\n'));
  }
}

/**
 * Replaces newline characters with `br` elements.
 *
 * Raw newlines are included. A newline written only to wrap the source is visible as a line inside a code block,
 * and keeping the same number of lines after converting back to a paragraph keeps the display from shifting
 * across the conversion.
 *
 * @param container The element the contents were moved into.
 */
function replaceNewlinesWithBreaks(container: Element): void {
  const document = container.ownerDocument;
  const texts: Text[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  // Replacing disturbs the walk, so the nodes are collected first.
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text && node.data.includes('\n') && !isInsideCommentText(node, container)) {
      texts.push(node);
    }
  }

  for (const text of texts) {
    const replacement: Node[] = [];
    for (const [index, part] of text.data.split('\n').entries()) {
      if (index > 0) {
        replacement.push(document.createElement('br'));
      }
      if (part.length > 0) {
        replacement.push(document.createTextNode(part));
      }
    }
    text.replaceWith(...replacement);
  }
}

/**
 * Determines whether a node sits inside the body of a comment annotation.
 *
 * @param node The node to inspect.
 * @param container The element the contents were moved into. Ancestors are followed up to here.
 * @returns `true` when the node is inside a body or a reply.
 */
function isInsideCommentText(node: Node, container: Element): boolean {
  let current = node.parentElement;
  while (current !== null && current !== container) {
    if (COMMENT_TEXT_TAG_NAMES.has(current.localName)) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}
