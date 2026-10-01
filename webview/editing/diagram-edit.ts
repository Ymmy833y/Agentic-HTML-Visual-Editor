import { isDiagramSource, readDiagramSource } from '../diagram/diagram-source';
import { createEmptyBlock, findBlock, insertBlock, isHtmlWhitespaceOnly } from './block';
import type { BlockRewriteProgress } from './block-format';
import { findMergeCandidate, removeWithSeparator } from './block-merge';
import type { MergeDirection } from './block-merge';
import { findVisibleEdge } from './boundary-placement';
import { isAtBlockEnd, isAtBlockStart, placeCaret, readSelectionRange } from './caret';

/**
 * The edit kind of rewriting a diagram's source.
 *
 * History groups only typing and deletes, so it is spelled differently from both to keep it from being grouped with
 * the input before and after it.
 */
export const DIAGRAM_UPDATE_EDIT_KIND = 'diagram:update';

/** The edit kind of deleting a diagram from its dialog. Spelled apart from typing and deletes for the same reason. */
export const DIAGRAM_DELETE_EDIT_KIND = 'diagram:delete';

/** The edit kind of adding a line before a leading diagram. Spelled apart from typing and deletes for the same reason. */
export const DIAGRAM_LEAD_PARAGRAPH_EDIT_KIND = 'diagram:insertParagraphBefore';

/**
 * The ports of the diagram edits.
 *
 * They hold no values and are read on every call. The editing session changes with a document replacement, and the
 * input stop changes from moment to moment.
 */
export interface DiagramEditPorts {
  /** Returns the editor root. `undefined` before the mount. */
  readEditorRoot(): Element | undefined;

  /** Whether an IME composition is in progress at the time of the call. */
  isComposing(): boolean;

  /** Whether any input stop reason remains. */
  isInputStopped(): boolean;

  /**
   * Runs a command that changes the tree as one edit attempt spanning the states before and after.
   *
   * @param kind The edit kind.
   * @param command A command that returns true only when it changed the tree.
   * @returns Whether the tree was changed. False if the attempt could not be started.
   */
  runCommandEdit(kind: string, command: () => boolean): boolean;

  /** Leaves one diagnostic line for maintainers. Not used to notify the user. */
  reportDiagnostic(detail: string): void;
}

/**
 * Rewrites the source of a diagram as one edit.
 *
 * Nothing happens when the source is unchanged, so that saving an untouched dialog adds no step to the history. The
 * selection is left as the dialog returned it; it is never inside a diagram.
 *
 * @param ports The ports of the diagram edits.
 * @param block The diagram source block.
 * @param source The new source.
 * @returns Whether the tree was changed.
 */
export function updateDiagramSource(ports: DiagramEditPorts, block: Element, source: string): boolean {
  if (!canEdit(ports, block) || readDiagramSource(block) === source) {
    return false;
  }
  return ports.runCommandEdit(DIAGRAM_UPDATE_EDIT_KIND, () => {
    try {
      writeDiagramSource(block, source);
      return true;
    } catch (error) {
      // Returning that nothing changed would leave a half-written tree out of the history.
      ports.reportDiagnostic(`Could not rewrite the diagram source: ${String(error)}`);
      return true;
    }
  });
}

/**
 * Removes a diagram as one edit and puts the caret next to where it was.
 *
 * The caret goes to the start of the block after it, or else to the end of the block before it. When neither has a
 * place for the caret, an empty paragraph takes the diagram's place, so that there is still somewhere to type.
 *
 * @param ports The ports of the diagram edits.
 * @param block The diagram source block.
 * @returns Whether the tree was changed.
 */
export function removeDiagram(ports: DiagramEditPorts, block: Element): boolean {
  if (!canEdit(ports, block)) {
    return false;
  }
  return ports.runCommandEdit(DIAGRAM_DELETE_EDIT_KIND, () => {
    try {
      removeDiagramBlock(block);
      return true;
    } catch (error) {
      ports.reportDiagnostic(`Could not delete the diagram: ${String(error)}`);
      return !block.isConnected;
    }
  });
}

/**
 * Returns the diagram a collapsed caret at the edge of a block touches in the delete direction. Changes nothing.
 *
 * Backward, it is the diagram right before the block whose start holds the caret; forward, the diagram right after
 * the block whose end holds it. Whitespace-only text between them is line breaks and indentation, not content.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @param direction The direction of deletion.
 * @returns The diagram source block, or `undefined` when there is none.
 */
export function findAdjacentDiagram(root: Element, range: Range, direction: MergeDirection): Element | undefined {
  if (!range.collapsed) {
    return undefined;
  }
  const block = findBlock(range.startContainer, root);
  if (block === undefined || isDiagramSource(block)) {
    return undefined;
  }
  const atEdge = direction === 'backward' ? isAtBlockStart(range, block) : isAtBlockEnd(range, block);
  if (!atEdge) {
    return undefined;
  }
  const candidate = findMergeCandidate(block, direction);
  return candidate !== undefined && isDiagramSource(candidate) ? candidate : undefined;
}

/**
 * Removes a diagram next to the caret. The caret and the neighboring blocks are left as they are.
 *
 * @param block The diagram source block.
 * @param progress The holder of whether the tree was changed.
 */
export function removeAdjacentDiagram(block: Element, progress: BlockRewriteProgress): void {
  removeWithSeparator(block);
  progress.changed = true;
}

/**
 * Returns the diagram a collapsed caret leaves no line before. Changes nothing.
 *
 * The block right after the diagram may be a container such as a list, a table or a collapsible section, so the
 * caret climbs its ancestors while it is at the first visible position of each. When the element reached this way
 * follows a diagram, the first of the diagrams in that run is the leading one, provided nothing but whitespace comes
 * before it in its parent. The caret never enters a diagram, so without a line before such a diagram there is no place
 * to type there.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @returns The leading diagram source block, or `undefined` when the caret can already reach a line before it.
 */
export function findLeadingDiagram(root: Element, range: Range): Element | undefined {
  if (!range.collapsed) {
    return undefined;
  }
  const start = range.startContainer;
  let current: Element | null = start instanceof Element ? start : start.parentElement;
  while (current !== null && current !== root && root.contains(current)) {
    if (isDiagramSource(current) || !isAtFirstVisiblePosition(root, range, current)) {
      return undefined;
    }
    const previous = findMergeCandidate(current, 'backward');
    if (previous !== undefined && isDiagramSource(previous)) {
      return findFirstOfDiagramRun(previous);
    }
    // Whether anything visible comes before this element is left to the parent's own start check on the next step.
    // Counting every element here would stop at the column group or the caption a table starts with, which shows no
    // line the caret could move up to.
    current = current.parentElement;
  }
  return undefined;
}

/**
 * Determines whether a collapsed caret is at the first visible position of an element.
 *
 * Having nothing visible before the caret is not enough: an empty cell or an empty item above the caret shows
 * nothing, yet the caret can move up into it. So the first visible position of the element must also lie in the
 * block that holds the caret.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @param element The element.
 * @returns `true` when nothing visible and no other block comes between the start of the element and the caret.
 */
function isAtFirstVisiblePosition(root: Element, range: Range, element: Element): boolean {
  if (!isAtBlockStart(range, element)) {
    return false;
  }
  const edge = findVisibleEdge(element, 'first');
  // An element with no visible position of its own, such as an empty inline element, leaves the check to the start
  // check alone.
  return edge === undefined || findBlock(edge.container, root) === findBlock(range.startContainer, root);
}

/**
 * Returns the first diagram of a run of diagrams, when nothing but whitespace comes before it in its parent.
 *
 * @param last The last diagram of the run.
 * @returns The first diagram, or `undefined` when content comes before the run.
 */
function findFirstOfDiagramRun(last: Element): Element | undefined {
  let first = last;
  let previous = findMergeCandidate(first, 'backward');
  while (previous !== undefined && isDiagramSource(previous)) {
    first = previous;
    previous = findMergeCandidate(first, 'backward');
  }
  return hasContentBefore(first) ? undefined : first;
}

/**
 * Adds an empty paragraph before a leading diagram as one edit and puts the caret in it.
 *
 * @param ports The ports of the diagram edits.
 * @param diagram The leading diagram source block.
 * @returns Whether the tree was changed.
 */
export function insertParagraphBeforeDiagram(ports: DiagramEditPorts, diagram: Element): boolean {
  if (!canEdit(ports, diagram)) {
    return false;
  }
  return ports.runCommandEdit(DIAGRAM_LEAD_PARAGRAPH_EDIT_KIND, () => {
    const paragraph = createEmptyBlock(diagram.ownerDocument, 'p');
    insertBlock(paragraph, diagram, 'before');
    placeCaret(paragraph, 0);
    return true;
  });
}

/**
 * Attaches the ArrowUp that adds a line before a leading diagram.
 *
 * ArrowUp at the start of the block right after such a diagram has nowhere to go, since the caret never enters a
 * diagram, so it adds an empty paragraph before the diagram instead. Anywhere else the key keeps its default.
 *
 * @param root The editor root. It stays the same element across document replacements, so call this only once, on
 *   the first mount.
 * @param ports The ports of the diagram edits.
 */
export function attachLeadingDiagramKey(root: HTMLElement, ports: DiagramEditPorts): void {
  root.addEventListener('keydown', (event) => {
    if (
      event.key !== 'ArrowUp'
      || event.isComposing
      || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
      || event.defaultPrevented
    ) {
      return;
    }
    try {
      const range = readSelectionRange(root);
      const diagram = range === undefined ? undefined : findLeadingDiagram(root, range);
      if (diagram !== undefined && insertParagraphBeforeDiagram(ports, diagram)) {
        event.preventDefault();
      }
    } catch (error) {
      ports.reportDiagnostic(`Could not add a line before the diagram: ${String(error)}`);
    }
  });
}

/**
 * Writes a source into a diagram source block, replacing what it held.
 *
 * In the form with a `code` child the source goes inside the `code`, so that the block keeps its form.
 *
 * @param block The diagram source block.
 * @param source The source.
 */
export function writeDiagramSource(block: Element, source: string): void {
  const code = block.firstElementChild;
  const container = code !== null && code.localName === 'code' && block.children.length === 1 ? code : block;
  container.replaceChildren(block.ownerDocument.createTextNode(source));
}

/**
 * Removes a diagram source block and places the caret next to where it was.
 *
 * @param block The diagram source block.
 */
function removeDiagramBlock(block: Element): void {
  const next = findMergeCandidate(block, 'forward');
  const previous = findMergeCandidate(block, 'backward');
  const placement = (next === undefined ? undefined : findVisibleEdge(next, 'first'))
    ?? (previous === undefined ? undefined : findVisibleEdge(previous, 'last'));
  if (placement === undefined) {
    const paragraph = createEmptyBlock(block.ownerDocument, 'p');
    block.replaceWith(paragraph);
    placeCaret(paragraph, 0);
    return;
  }
  removeWithSeparator(block);
  placeCaret(placement.container, placement.offset);
}

/**
 * Determines whether anything but whitespace and HTML comments comes before a node in its parent.
 *
 * @param node The node.
 * @returns `true` when an element or visible text comes before it.
 */
function hasContentBefore(node: Node): boolean {
  for (let current = node.previousSibling; current !== null; current = current.previousSibling) {
    if (current instanceof Element) {
      return true;
    }
    if (current instanceof Text && !isHtmlWhitespaceOnly(current.data)) {
      return true;
    }
  }
  return false;
}

/**
 * Determines whether a diagram can be edited now.
 *
 * @param ports The ports of the diagram edits.
 * @param block The diagram source block.
 * @returns `true` when the view takes edits and the block is a diagram in the editor root.
 */
function canEdit(ports: DiagramEditPorts, block: Element): boolean {
  const root = ports.readEditorRoot();
  return root !== undefined
    && !ports.isComposing()
    && !ports.isInputStopped()
    && root !== block
    && root.contains(block)
    && isDiagramSource(block);
}
