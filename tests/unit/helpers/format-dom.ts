/**
 * Builds the element that stands in for the editor root.
 *
 * @param html The contents of the editor root.
 * @returns The editor root holding the contents.
 */
export function createRoot(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

/**
 * Puts the editor root into the document. Needed whenever the selection is used.
 *
 * @param html The contents of the editor root.
 * @returns The editor root placed in the document.
 */
export function mountRoot(html: string): HTMLElement {
  const root = createRoot(html);
  document.body.replaceChildren(root);
  return root;
}

/**
 * Looks up an element.
 *
 * @param root Where to search from.
 * @param selector A CSS selector.
 * @returns The element that was found.
 */
export function readElement(root: Element, selector: string): Element {
  const element = root.querySelector(selector);
  if (element === null) {
    throw new Error(`element not found: ${selector}`);
  }
  return element;
}

/**
 * Takes a text node out of a node's children.
 *
 * @param parent The parent node.
 * @param index The child index.
 * @returns The text node that was taken out.
 */
export function readChildText(parent: Node, index: number): Text {
  const node = parent.childNodes[index];
  if (!(node instanceof Text)) {
    throw new Error(`text not found: ${index}`);
  }
  return node;
}

/**
 * Builds a range whose ends are the two given positions.
 *
 * @param startNode The start's container.
 * @param startOffset The start's offset.
 * @param endNode The end's container.
 * @param endOffset The end's offset.
 * @returns The range that was built.
 */
export function createRange(
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number,
): Range {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

/**
 * Makes a range the current selection.
 *
 * @param range The range to select.
 */
export function select(range: Range): void {
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
