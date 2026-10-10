import { OPAQUE_TAG_NAMES } from './opaque-subtree';

/** Inline format elements that can be removed when they are empty. */
export const INLINE_FORMAT_TAG_NAMES: ReadonlySet<string> = new Set([
  'strong',
  'em',
  'code',
  's',
  'a',
  'span',
]);

const HTML_WHITESPACE_ONLY_PATTERN = /^[\t\n\f\r ]*$/u;

/**
 * Determines whether a node may be ignored when deciding what comes last.
 *
 * Text made only of HTML whitespace collapses and produces no line, and a comment
 * renders nothing. Neither appears on screen, so neither counts as "content
 * displayed after this point". NBSP does not collapse and is displayed, so it is
 * not included.
 *
 * @param node The node to inspect.
 * @returns `true` when the node does not appear on screen.
 */
function isInvisibleNode(node: Node): boolean {
  return node instanceof Comment
    || (node instanceof Text && HTML_WHITESPACE_ONLY_PATTERN.test(node.data));
}

/**
 * Finds the first preceding sibling that appears on screen.
 *
 * @param node The node to search from.
 * @returns The displayed node, or `null` when there is none before it.
 */
function previousVisibleSibling(node: Node): Node | null {
  let current = node.previousSibling;
  while (current !== null && isInvisibleNode(current)) {
    current = current.previousSibling;
  }
  return current;
}

/**
 * Finds the first following sibling that appears on screen.
 *
 * @param node The node to search from.
 * @returns The displayed node, or `null` when there is none after it.
 */
function nextVisibleSibling(node: Node): Node | null {
  let current = node.nextSibling;
  while (current !== null && isInvisibleNode(current)) {
    current = current.nextSibling;
  }
  return current;
}

function visitEditableElements(parent: ParentNode, visitor: (element: Element) => void): void {
  for (const child of [...parent.children]) {
    if (OPAQUE_TAG_NAMES.has(child.localName)) {
      continue;
    }
    visitEditableElements(child, visitor);
    visitor(child);
  }
}

/**
 * Removes, from the copy, the empty inline elements and the lone trailing `br`
 * that do not change the display.
 *
 * @param root The inverse-transformed copy whose editing artifacts are removed.
 */
export function removeEditingArtifacts(root: ParentNode): void {
  visitEditableElements(root, (element) => {
    if (
      INLINE_FORMAT_TAG_NAMES.has(element.localName)
      && element.attributes.length === 0
      && element.childNodes.length === 0
    ) {
      element.remove();
    }
  });

  visitEditableElements(root, (element) => {
    if (element.localName !== 'br') {
      return;
    }

    const previous = previousVisibleSibling(element);
    const next = nextVisibleSibling(element);
    const followsInlineContent = previous instanceof Text
      || (
        previous instanceof Element
        && (
          INLINE_FORMAT_TAG_NAMES.has(previous.localName)
          || previous.localName === 'img'
          || previous.localName === 'comment'
        )
      );

    // A br with no displayed content before it is what gives an empty block its
    // height, so dropping it would make the empty line disappear. The same holds
    // when a br comes right before it: this br is what closes the line that one
    // opened. Only a trailing br that follows text or a known inline element can be
    // dropped without losing a line. After a block or an unknown element it is kept,
    // because it cannot be established that the display is unchanged.
    if (followsInlineContent && next === null) {
      element.remove();
    }
  });
}
