/**
 * Moves the copy's children into a serialization container.
 *
 * Moving instead of copying the children preserves node identity, allowing repeated `innerHTML`
 * reads to serialize the same tree under the same rules. This is used to compare strings before and
 * after inserting markers.
 *
 * @param copy The copy whose children are moved.
 * @returns A container whose content contains the copy's children.
 */
export function createSerializationTemplate(copy: DocumentFragment): HTMLTemplateElement {
  const template = copy.ownerDocument.createElement('template');
  while (copy.firstChild !== null) {
    template.content.append(copy.firstChild);
  }
  return template;
}

/**
 * Serializes an inert copy with the browser's standard rules, without
 * reformatting it.
 *
 * @param copy The inert copy to serialize.
 * @returns The body HTML obtained by serializing the child nodes of the copy.
 */
export function serializeBody(copy: DocumentFragment): string {
  return createSerializationTemplate(copy).innerHTML;
}
