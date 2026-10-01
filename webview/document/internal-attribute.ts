/** The namespace prefix of the attributes the view attaches temporarily. */
export const INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX = 'urn:ahve:';

function removeFromElement(element: Element): void {
  for (const attribute of [...element.attributes]) {
    if (attribute.namespaceURI?.startsWith(INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX) === true) {
      element.removeAttributeNode(attribute);
    }
  }

  const children = element instanceof HTMLTemplateElement ? element.content.children : element.children;
  for (const child of [...children]) {
    removeFromElement(child);
  }
}

/**
 * Removes only the attributes in the internal namespace from the tree.
 *
 * @param root The copy for serialization whose internal attributes are removed.
 */
export function removeInternalAttributes(root: ParentNode): void {
  if (root instanceof Element) {
    removeFromElement(root);
    return;
  }
  for (const child of [...root.children]) {
    removeFromElement(child);
  }
}
