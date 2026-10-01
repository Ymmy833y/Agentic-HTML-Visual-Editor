import { isEmptyBlock } from './block';

/**
 * Returns a collapsible section's title.
 *
 * Looks only at direct children. Picking up a descendant `summary`, or a nested collapsible section's
 * title, would treat another collapsible section's heading as this one's own title.
 *
 * @param section The collapsible section.
 * @returns The first `summary` child. `undefined` if it has none.
 */
export function findDetailsTitle(section: Element): Element | undefined {
  for (const child of section.children) {
    if (child.localName === 'summary') {
      return child;
    }
  }
  return undefined;
}

/**
 * Creates a collapsed range at the end of a collapsible section's title.
 *
 * An empty title holds only a `br` for its height, so the range is placed before it. Placing it after would put
 * subsequently typed characters after the empty line.
 *
 * @param section The collapsible section.
 * @returns The end of the title. `null` if there is no title, because there is then no place that is visible while
 *   the section is closed.
 */
export function readTitleEnd(section: Element): Range | null {
  const title = findDetailsTitle(section);
  if (title === undefined) {
    return null;
  }
  const range = section.ownerDocument.createRange();
  range.setStart(title, isEmptyBlock(title) ? 0 : title.childNodes.length);
  return range;
}

/**
 * Determines whether an element is a collapsible section's title.
 *
 * A second or later `summary`, and a `summary` outside a collapsible section, are ordinary blocks;
 * they do not act as a toggle heading.
 *
 * @param element The element to check.
 * @returns `true` if it is a title.
 */
export function isDetailsTitle(element: Element): boolean {
  const section = element.parentElement;
  if (section === null || section.localName !== 'details') {
    return false;
  }
  return findDetailsTitle(section) === element;
}

/**
 * Returns whether a collapsible section is open.
 *
 * Decided purely by the attribute's presence. Even written as `open="false"`, it is open under HTML
 * semantics; reading the value's spelling would disagree with the display.
 *
 * @param section The collapsible section.
 * @returns `true` if open.
 */
export function isDetailsOpen(section: Element): boolean {
  return section.hasAttribute('open');
}

/**
 * Returns the open collapsible section whose body contains a given position.
 *
 * Decided only by the innermost collapsible section; ancestors are not walked further up. Returning
 * an outer one while the inner one is closed would treat a position that is not displayed as being
 * inside the body.
 *
 * @param node The position to check.
 * @param root The editor root.
 * @returns The open collapsible section. `undefined` inside a title, inside a closed collapsible
 * section, or outside the editor root.
 */
export function findOpenBodySection(node: Node, root: Element): Element | undefined {
  if (!root.contains(node)) {
    return undefined;
  }

  let current: Element | null = node instanceof Element ? node : node.parentElement;
  while (current !== null && current !== root) {
    if (current.localName === 'details') {
      if (!isDetailsOpen(current)) {
        return undefined;
      }
      const title = findDetailsTitle(current);
      return title !== undefined && title.contains(node) ? undefined : current;
    }
    current = current.parentElement;
  }
  return undefined;
}
