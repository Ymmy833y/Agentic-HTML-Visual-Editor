import { COMMENT_TAG_NAME } from '../../common/index';

/** The class token that marks a `pre` as the source of a Mermaid diagram. */
export const MERMAID_CLASS_NAME = 'mermaid';

/** The class token that marks the `code` inside a `pre` as the source of a Mermaid diagram. */
export const MERMAID_LANGUAGE_CLASS_NAME = 'language-mermaid';

/**
 * Determines whether an element is a diagram source block.
 *
 * Two spellings are accepted: a `pre` carrying the `mermaid` class token, and a `pre` whose only child element is a
 * `code` carrying the `language-mermaid` class token. Both are how agents write Mermaid in HTML, and the one the
 * author chose is kept as written.
 *
 * @param element The element to check.
 * @returns `true` for a diagram source block.
 */
export function isDiagramSource(element: Element): boolean {
  if (element.localName !== 'pre') {
    return false;
  }
  if (element.classList.contains(MERMAID_CLASS_NAME)) {
    return true;
  }
  const children = element.children;
  return children.length === 1
    && children[0].localName === 'code'
    && children[0].classList.contains(MERMAID_LANGUAGE_CLASS_NAME);
}

/**
 * Returns the diagram source blocks under a root, in document order.
 *
 * @param root The editor root.
 * @returns The diagram source blocks.
 */
export function findDiagramSources(root: Element): Element[] {
  return [...root.querySelectorAll('pre')].filter(isDiagramSource);
}

/**
 * Returns the closest diagram source block that contains a node, stopping at the root.
 *
 * @param node The node.
 * @param root The editor root, which is never returned.
 * @returns The diagram source block, or `undefined` when the node is not inside one.
 */
export function findContainingDiagramSource(node: Node, root: Element): Element | undefined {
  let current: Element | null = node instanceof Element ? node : node.parentElement;
  while (current !== null && current !== root) {
    if (isDiagramSource(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return undefined;
}

/**
 * Reads the Mermaid source of a diagram source block.
 *
 * The text of comment entries is not part of the source: entries are not shown in the document flow. A `br` stands
 * for a line break, the same as a newline character inside `pre`.
 *
 * @param block The diagram source block.
 * @returns The source text.
 */
export function readDiagramSource(block: Element): string {
  let source = '';
  const visit = (node: Node): void => {
    if (node instanceof Text) {
      source += node.data;
      return;
    }
    if (!(node instanceof Element)) {
      return;
    }
    if (node.localName === COMMENT_TAG_NAME.body || node.localName === COMMENT_TAG_NAME.reply) {
      return;
    }
    if (node.localName === 'br') {
      source += '\n';
      return;
    }
    for (const child of node.childNodes) {
      visit(child);
    }
  };
  for (const child of block.childNodes) {
    visit(child);
  }
  return source;
}
