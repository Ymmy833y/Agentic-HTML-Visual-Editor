import { findDiagramSources } from '../diagram/diagram-source';
import type { NodeBoundary } from '../selection/selection-position';
import { isInsideClosedDetailsBody } from './details-body-guard';
import type { DiagnosticReporter } from './input-dispatcher';
import { isImeProcessKey, matchesShortcutKey } from './shortcut-receiver';
import type { ShortcutKey, ShortcutPlatform } from './shortcut-receiver';

/** The key that selects all: A with the primary modifier. */
export const SELECT_ALL_KEY: ShortcutKey = { character: 'a', primary: true, shift: false, alt: false };

/** The start and the end of a range. */
export interface SelectionBoundaries {
  /** The start. */
  readonly start: NodeBoundary;
  /** The end. */
  readonly end: NodeBoundary;
}

/**
 * Widens the boundaries of the browser's select-all over the diagrams outside them. Changes nothing.
 *
 * The browser's select-all runs from the first to the last position the caret can rest on, and the caret never rests
 * in a diagram, so a diagram before the first of those positions or after the last one is left out of the selection,
 * and deleting or copying the selection leaves it behind. A diagram inside a closed details body stays out, as the
 * body itself does.
 *
 * @param root The editing area: the editor root or a comment field.
 * @param boundaries The boundaries of the browser's select-all.
 * @returns The start moved before the first diagram that starts before it, and the end moved after the last diagram
 *   that ends after it. A side with no such diagram keeps its boundary.
 */
export function readSelectAllBoundaries(root: Element, boundaries: SelectionBoundaries): SelectionBoundaries {
  const document = root.ownerDocument;
  const range = document.createRange();
  range.setStart(boundaries.start.container, boundaries.start.offset);
  range.setEnd(boundaries.end.container, boundaries.end.offset);
  // One probe serves every diagram. Live ranges stay in the document until they are collected, and each one is updated
  // on every change to the tree.
  const whole = document.createRange();
  const compare = (block: Element, how: number): number => {
    whole.selectNode(block);
    return whole.compareBoundaryPoints(how, range);
  };
  const diagrams = findShownDiagrams(root);
  const first = diagrams.find((block) => compare(block, Range.START_TO_START) < 0);
  const last = [...diagrams].reverse().find((block) => compare(block, Range.END_TO_END) > 0);
  return {
    start: first === undefined ? boundaries.start : readPositionBefore(first),
    end: last === undefined ? boundaries.end : readPositionAfter(last),
  };
}

/**
 * Selects all of an editing area that shows a diagram, taking in the diagrams outside the browser's select-all.
 *
 * The browser's select-all itself is not used, because it runs only after the listeners of the key have returned. Its
 * boundaries are found instead by moving the caret from each end of the editing area to the boundary of the document,
 * as Ctrl+Home and Ctrl+End do. Moving the caret replaces the selection, so the widened range is selected even when no
 * diagram lies outside, which then equals the browser's select-all.
 *
 * @param root The editing area: the editor root or a comment field.
 * @returns Whether the selection was set. False when the editing area shows no diagram, which leaves select-all to the
 *   browser.
 */
export function selectAllWithDiagrams(root: Element): boolean {
  const selection = root.ownerDocument.defaultView?.getSelection();
  if (selection === null || selection === undefined || findShownDiagrams(root).length === 0) {
    return false;
  }
  const { start, end } = readSelectAllBoundaries(root, {
    start: readBrowserBoundary(selection, root, 'backward'),
    end: readBrowserBoundary(selection, root, 'forward'),
  });
  selection.setBaseAndExtent(start.container, start.offset, end.container, end.offset);
  return true;
}

/**
 * Attaches the key that selects all of an editing area with the diagrams at its edges.
 *
 * The key is taken over only where a diagram is shown, and keeps the browser's select-all anywhere else. It is not
 * registered with the shortcut receiver: the comment popup stops the default of every key the receiver knows, which
 * would take select-all away from a field with no diagram.
 *
 * @param root The editing area: the editor root or a comment field. It stays the same element across document
 *   replacements, so call this only once, on the first mount.
 * @param platform The shortcut platform.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 */
export function attachSelectAllKey(
  root: HTMLElement,
  platform: ShortcutPlatform,
  reportDiagnostic: DiagnosticReporter,
): void {
  root.addEventListener('keydown', (event) => {
    if (
      event.defaultPrevented
      || event.isComposing
      || isImeProcessKey(event)
      || !matchesShortcutKey(SELECT_ALL_KEY, event, platform)
    ) {
      return;
    }
    try {
      if (!selectAllWithDiagrams(root)) {
        return;
      }
    } catch (error) {
      // The browser's select-all still follows, so the key is not lost.
      reportDiagnostic(`Could not select all with the diagrams: ${String(error)}`);
      return;
    }
    event.preventDefault();
    // VS Code picks up keydown in the bubbling phase of the inner window and selects all once more with the browser's
    // select-all, which would leave the diagrams out again.
    event.stopPropagation();
  });
}

/**
 * Returns the diagrams of an editing area that are shown: those outside closed details bodies.
 *
 * @param root The editing area.
 * @returns The diagram source blocks, in document order.
 */
function findShownDiagrams(root: Element): Element[] {
  return findDiagramSources(root).filter((block) => !isInsideClosedDetailsBody(block, root));
}

/**
 * Moves the caret from an end of an editing area to the boundary of the document, and returns where it comes to rest.
 *
 * @param selection The selection of the view.
 * @param root The editing area.
 * @param direction Backward for the start, forward for the end.
 * @returns The position the caret came to rest at.
 */
function readBrowserBoundary(selection: Selection, root: Element, direction: 'backward' | 'forward'): NodeBoundary {
  const offset = direction === 'backward' ? 0 : root.childNodes.length;
  selection.collapse(root, offset);
  selection.modify('move', direction, 'documentboundary');
  const { focusNode, focusOffset } = selection;
  return focusNode === null ? { container: root, offset } : { container: focusNode, offset: focusOffset };
}

/**
 * Returns the position right before a node.
 *
 * @param node A node with a parent.
 * @returns The position in its parent.
 */
function readPositionBefore(node: ChildNode): NodeBoundary {
  const parent = node.parentNode;
  if (parent === null) {
    throw new Error('The diagram has no parent');
  }
  return { container: parent, offset: [...parent.childNodes].indexOf(node) };
}

/**
 * Returns the position right after a node.
 *
 * @param node A node with a parent.
 * @returns The position in its parent.
 */
function readPositionAfter(node: ChildNode): NodeBoundary {
  const before = readPositionBefore(node);
  return { container: before.container, offset: before.offset + 1 };
}
