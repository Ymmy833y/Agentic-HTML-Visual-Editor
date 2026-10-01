import { containsNode } from './block';
import { findDetailsTitle, isDetailsOpen } from './details-section';
import type { RangeDeleteKeep } from './editing-hooks';
import type { DiagnosticReporter } from './input-dispatcher';

const NO_KEEP: RangeDeleteKeep = { emptiedElements: [], keptNodes: [] };

/**
 * For a range delete, finds the range delete keep for closed details bodies. Changes neither the tree nor the selection.
 *
 * A closed body is not displayed and gets no selection highlight, so it is treated as not selected. Deleting it would lose body content the user
 * does not notice until opening it. For each closed details section the range does not fully contain, the children other than the title that the range
 * fully contains are kept whole. The body of an open details section is visible, so it is not kept, and a details section fully contained in the range is deleted body and all.
 *
 * A failure does not stop the range delete. Stopping it would make the same range delete always a noop, leaving no way to delete it.
 *
 * @param range The range to delete.
 * @param root The editor root.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 * @returns The range delete keep, or an empty keep if there is none.
 */
export function collectClosedBodyKeep(
  range: Range,
  root: Element,
  reportDiagnostic: DiagnosticReporter,
): RangeDeleteKeep {
  try {
    const keptNodes: Node[] = [];
    for (const section of root.querySelectorAll('details')) {
      if (isDetailsOpen(section) || !range.intersectsNode(section) || containsNode(range, section)) {
        continue;
      }
      const title = findDetailsTitle(section);
      for (const child of section.childNodes) {
        if (child !== title && containsNode(range, child)) {
          keptNodes.push(child);
        }
      }
    }
    return { emptiedElements: [], keptNodes };
  } catch (error) {
    reportDiagnostic(`Could not find what to keep in closed details bodies: ${String(error)}`);
    return NO_KEEP;
  }
}

/**
 * Determines whether a node is inside a closed details body.
 *
 * A closed body is not displayed, so it is excluded from formatting and block kind targets. Even if an inner details section is open, or the node is in its title,
 * it is treated the same because it is invisible while an outer one is closed.
 *
 * @param node The node to inspect.
 * @param boundary The element at which to stop climbing. The element itself is not inspected.
 * @returns `true` if an ancestor up to the boundary is a closed `details` that contains the node outside its title.
 */
export function isInsideClosedDetailsBody(node: Node, boundary: Element): boolean {
  let current: Element | null = node instanceof Element ? node : node.parentElement;
  while (current !== null && current !== boundary) {
    if (current !== node && current.localName === 'details' && !isDetailsOpen(current)) {
      const title = findDetailsTitle(current);
      if (title === undefined || !title.contains(node)) {
        return true;
      }
    }
    current = current.parentElement;
  }
  return false;
}
