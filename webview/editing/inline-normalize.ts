import { FORMAT_ELEMENT_TAG_NAMES, isFormattingExcluded } from './inline-format';

/**
 * Removes, within the touched blocks, empty format elements, adjacent siblings with the same spelling,
 * and direct nesting of the same spelling.
 *
 * Only the inside of the given blocks is looked at. Spellings are never changed, so `b` and `strong` are
 * not merged. The inside of a `pre` and of a comment annotation's body and replies is left alone, since
 * formats are not applied there.
 *
 * @param blocks The touched blocks. The same block may appear more than once.
 */
export function normalizeFormatElements(blocks: readonly Element[]): void {
  for (const block of new Set(blocks)) {
    // What one pass fixes can create a new violation (merging two elements can make their children
    // adjacent, for instance). Each fix removes one format element, so the loop is bound to stop.
    while (normalizeOnce(block)) {
      continue;
    }
  }
}

/**
 * Walks the inside of a block once and fixes the violations it finds.
 *
 * @param block The block to walk.
 * @returns `true` when at least one violation was fixed.
 */
function normalizeOnce(block: Element): boolean {
  let changed = false;
  // Reverse document order puts the inner elements first. Clearing the inside before looking at the
  // outside lets the same pass pick up an outer element left empty by what was removed inside it.
  for (const element of [...block.querySelectorAll('*')].reverse()) {
    if (!FORMAT_ELEMENT_TAG_NAMES.has(element.localName) || element.parentNode === null) {
      continue;
    }
    // The inside of a pre and a comment annotation's body and replies are not places where formats are
    // added or removed in the first place. Normalizing them would rewrite the contents of a code
    // container or an annotation that was never touched.
    if (isFormattingExcluded(element, block)) {
      continue;
    }

    const parent = element.parentElement;
    if (parent !== null && parent.localName === element.localName) {
      element.replaceWith(...element.childNodes);
      changed = true;
      continue;
    }

    // An empty element with attributes is kept. Dropping the attributes would lose a destination or a mark.
    if (element.attributes.length === 0 && element.childNodes.length === 0) {
      element.remove();
      changed = true;
      continue;
    }

    const previous = element.previousSibling;
    if (
      previous instanceof Element
      && previous.localName === element.localName
      && hasSameAttributes(previous, element)
    ) {
      previous.append(...element.childNodes);
      element.remove();
      changed = true;
    }
  }
  return changed;
}

/**
 * Determines whether two elements have the same attributes.
 *
 * @param first One of the elements.
 * @param second The other element.
 * @returns `true` when every name and value pair matches.
 */
function hasSameAttributes(first: Element, second: Element): boolean {
  if (first.attributes.length !== second.attributes.length) {
    return false;
  }
  for (const attribute of first.attributes) {
    if (second.getAttribute(attribute.name) !== attribute.value) {
      return false;
    }
  }
  return true;
}
