/**
 * The list of tags whose descendants are treated as opaque.
 *
 * Under these two tags, whitespace itself is user-authored content. In `pre`, line breaks and
 * indentation directly affect rendering; in `table`, whitespace between rows and cells determines
 * the serialized form.
 */
export const OPAQUE_TAG_NAMES: ReadonlySet<string> = new Set(['pre', 'table']);

/**
 * Finds the root of the opaque subtree containing a node.
 *
 * @param node A node in the tree.
 * @param boundary The upper boundary where the search stops. This element itself is not opaque.
 * @returns The nearest `pre` or `table` element, or `undefined` if the node belongs to neither.
 */
export function findOpaqueRoot(node: Node, boundary: Element): Element | undefined {
  let current: Element | null = node instanceof Element ? node : node.parentElement;

  while (current !== null && current !== boundary) {
    if (OPAQUE_TAG_NAMES.has(current.tagName.toLowerCase())) {
      return current;
    }
    current = current.parentElement;
  }

  return undefined;
}
