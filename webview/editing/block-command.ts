import { applyAlert } from './alert-apply';
import type { AlertSelection } from './alert-apply';
import { BLOCK_TAG_NAMES, findBlock, isEmptyBlock } from './block';
import { convertBlock } from './block-convert';
import { BLOCK_KIND, isConvertibleBlock, readBlockKind } from './block-format';
import type { BlockKind, BlockRewriteProgress } from './block-format';
import { collectBareRunHeads, collectTargetBlocks } from './block-collect';
import { placeCaret, placeCaretAtStart, readSelectionRange } from './caret';
import { wrapCellRuns } from './cell-wrap';
import { countCharacters, findCountedPosition } from './character-count';
import type { CountRule, SelectionPoint } from './character-count';
import { insertDetailsSection } from './details-insert';
import { insertDiagramSource } from './diagram-insert';
import { insertHorizontalRule } from './horizontal-rule';
import { isListOperation, runListOperation } from './list-command';
import { insertAfterListItem } from './list-split';
import { isItemLineParagraph, isListItem } from './list-structure';
import type { ListOperation } from './list-target';
import { isBetweenBlocksPosition, isEffectivelyEmpty } from './materialization';
import { convertQuoteLines, isBareBlockquote, planQuoteLines } from './quote-code-block';
import type { QuoteLinePlan, QuoteLinePoints } from './quote-code-block';
import { insertTable, insertTableIntoListItem } from './table-insert';
import type { EditEndpointSelections } from '../history/edit-transaction-controller';

/**
 * A block operation: conversion to a given kind, the code block toggle, a horizontal rule, an alert selection, or
 * inserting a collapsible section.
 *
 * An alert operation carries the selection alone. No separate operation is made per trigger because markdown-style
 * input calls the same operation.
 *
 * Inserting a collapsible section carries no value. No separate operation is made per trigger, and
 * later feature units call this same operation too.
 *
 * The 4 list operations are only pulled in by their shape, so they are not defined in two places. Checking the
 * preconditions, the edit attempt, and recording and restoring the selection are shared here; the list side
 * holds only the body of the rewrite.
 *
 * Inserting a diagram source block carries no value, like inserting a collapsible section.
 *
 * Inserting a table carries the number of rows and columns. The same operation is used whether it is called
 * from the grid or from the input fields of the table picker.
 */
export type BlockOperation =
  | { readonly kind: 'convert'; readonly to: BlockKind }
  | { readonly kind: 'toggleCodeBlock' }
  | { readonly kind: 'horizontalRule' }
  | { readonly kind: 'alert'; readonly to: AlertSelection }
  | { readonly kind: 'insertDetails' }
  | { readonly kind: 'insertDiagram' }
  | { readonly kind: 'insertTable'; readonly rows: number; readonly columns: number }
  | ListOperation;

/** A block trigger: whether the operation arrived from a command or from an input dispatcher rule. */
export type BlockTrigger = 'command' | 'rule';

/**
 * The block command ports.
 *
 * None of them hold a value; each reads afresh on every call, because replacing the document replaces the
 * editing session. The editor root is received as a type that can take focus from a state with no caret.
 */
export interface BlockCommandPorts {
  /** Returns the editor root, or `undefined` before the document is mounted. */
  readEditorRoot(): HTMLElement | undefined;

  /** Returns whether an IME composition is in progress at the time of the call. */
  isComposing(): boolean;

  /** Returns whether even one input stop reason remains. */
  isInputStopped(): boolean;

  /**
   * The command path. Closes the edit attempt as complete only when the tree was changed.
   *
   * @param endpoints The selections to record at the endpoints of the standalone edit. If omitted, the selections
   *   captured at the endpoints are recorded.
   */
  runCommandEdit(kind: string, command: () => boolean, endpoints?: EditEndpointSelections): boolean;

  /** Ensures a target block at the start point of the current selection. */
  ensureTargetBlock(): Element | undefined;

  /** Leaves a single diagnostic line for maintainers. Not used to notify the user. */
  reportDiagnostic(detail: string): void;
}

/**
 * A recorded selection that points at the same characters before and after an operation.
 *
 * It is held as a position counted over the contents of the editor root alone, rather than as a line and column
 * of the serialized body. That way it points at the same characters even when replacing an element changes the
 * spelling of a line, and it counts a `br` and a newline character as the same single character.
 */
export interface BlockSelection {
  /** The number of characters counted up to the start point. */
  readonly start: number;
  /** The number of characters counted up to the end point. */
  readonly end: number;
  /**
   * The ordinal, in document order, of the empty block holding the caret, together with that element.
   *
   * Present only when there is no range and that block is empty. A character count alone cannot tell an empty
   * block from the edge of its neighbour, so restoring would land in the neighbour. Removing an item reduces the
   * blocks before it and shifts the ordinal, so the element is recorded alongside it.
   */
  readonly emptyBlock?: { readonly index: number; readonly element: Element };
}

/** How a recorded selection counts the contents of the editor root. */
const BLOCK_SELECTION_COUNT: CountRule = { skipsWhitespaceBetweenBlocks: true, skipsCommentText: false };

/** A bare blockquote whose lines were turned into blocks, with what restoring the selection needs from it. */
interface QuoteLineConversion {
  /** The plan the conversion followed. */
  readonly plan: QuoteLinePlan;
  /** Where the ends of the selection that were inside the blockquote go. */
  readonly points: QuoteLinePoints;
  /** How many counted characters the blockquote lost. The `br` elements that separated lines leave the tree. */
  readonly lost: number;
}

/**
 * Runs a single operation, from checking the preconditions to closing the edit attempt.
 *
 * @param ports The block command ports.
 * @param operation The block operation.
 * @param trigger The block trigger.
 * @returns `true` when the tree was changed.
 */
export function runBlockOperation(
  ports: BlockCommandPorts,
  operation: BlockOperation,
  trigger: BlockTrigger,
): boolean {
  const root = ports.readEditorRoot();
  if (root === undefined || ports.isComposing() || ports.isInputStopped()) {
    return false;
  }

  if (readSelectionRange(root) === undefined) {
    // Right after an empty file is opened there is no selection until the body is clicked, and pressing a
    // toolbar item does not move focus. A single target is determined only when the editor root is effectively
    // empty, so the caret is placed only in that case.
    if (!isEffectivelyEmpty(root)) {
      return false;
    }
    root.focus();
    placeCaret(root, 0);
    if (readSelectionRange(root) === undefined) {
      return false;
    }
  }

  const command = (): boolean => rewrite(ports, root, operation);
  if (trigger === 'rule') {
    // The input dispatcher has already opened an edit attempt. Opening another would have the start rejected and
    // silently turn the operation into a no-op.
    return command();
  }
  return ports.runCommandEdit(readEditKind(operation), command);
}

/**
 * Records the selection as it stands before an operation.
 *
 * @param root The editor root.
 * @returns The recorded selection, or `undefined` when the selection lies outside the editor root.
 */
export function readBlockSelection(root: Element): BlockSelection | undefined {
  const range = readSelectionRange(root);
  if (range === undefined) {
    return undefined;
  }

  const start = countContentBefore(root, range.startContainer, range.startOffset);
  const end = range.collapsed
    ? start
    : countContentBefore(root, range.endContainer, range.endOffset);

  const block = range.collapsed ? findBlock(range.startContainer, root) : undefined;
  if (block === undefined || !isEmptyBlock(block)) {
    return { start, end };
  }
  return { start, end, emptyBlock: { index: collectBlocks(root).indexOf(block), element: block } };
}

/**
 * Restores the selection to the recorded position.
 *
 * Because block formatting does not change the text of the body, a position at the same character count covers
 * the same string as it did before the operation.
 *
 * @param root The editor root.
 * @param selection The recorded selection.
 */
export function restoreBlockSelection(root: Element, selection: BlockSelection): void {
  const view = root.ownerDocument.defaultView;
  const domSelection = view?.getSelection();
  if (domSelection === null || domSelection === undefined) {
    return;
  }

  if (selection.emptyBlock !== undefined) {
    // Restore into the recorded element if it is still there. If a replacement took it out, restore into the
    // replacement at the same ordinal.
    const { index, element } = selection.emptyBlock;
    const block: Element | undefined = root.contains(element) ? element : collectBlocks(root)[index];
    if (block !== undefined) {
      placeCaretAtStart(block);
      return;
    }
  }

  const start = findContentPosition(root, selection.start, 'start');
  const end = selection.end === selection.start
    ? start
    : findContentPosition(root, selection.end, 'end');
  const range = root.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  domSelection.removeAllRanges();
  domSelection.addRange(range);
}

/**
 * Runs the body of a single operation, from recording the selection through restoring it.
 *
 * It returns whether the tree was changed instead of letting an exception escape so that, even when the rewrite
 * fails partway through, whatever was changed can still be closed as an edit. Aborting would leave the display
 * and the saved content out of step.
 *
 * @param ports The block command ports.
 * @param root The editor root.
 * @param operation The block operation.
 * @returns `true` when the tree was changed.
 */
function rewrite(ports: BlockCommandPorts, root: HTMLElement, operation: BlockOperation): boolean {
  const progress: BlockRewriteProgress = { changed: false };
  let captured = readBlockSelection(root);
  const conversions: QuoteLineConversion[] = [];

  try {
    // Ensuring a target materializes the editor root, and the return value does not say whether it did, so this
    // is read beforehand.
    // A collapsed caret at a between-blocks position also has no target block until ensuring a target block creates a
    // paragraph at that position, so the same branch creates the paragraph before operating.
    if (isEffectivelyEmpty(root) || isCaretBetweenBlocks(root)) {
      const paragraph = ports.ensureTargetBlock();
      if (paragraph !== undefined) {
        progress.changed = true;
        // The selection from before materialization points directly beneath the editor root. Restoring it would
        // put the caret outside the paragraph, so it is recorded again.
        captured = readBlockSelection(root);
        runOperation(operation, [paragraph], root, progress, conversions);
      }
    } else {
      // The bare runs directly inside the cell of the start are wrapped in paragraphs before the targets are decided. If
      // the cell itself were the target, neither conversion nor list creation could act on it and nothing would happen.
      // Wrapping moves nodes and shifts the character counts of the captured selection, so the selection is captured
      // again on the wrapped tree and used both for the restore after wrapping runs directly inside the editor root and
      // for the restore after the operation.
      const range = readSelectionRange(root);
      if (range !== undefined && wrapCellRuns(root, range, progress) !== undefined) {
        captured = readBlockSelection(root);
      }
      runOperation(operation, collectTargets(ports, root, captured, progress), root, progress, conversions);
    }
  } catch (error) {
    ports.reportDiagnostic(`Could not finish the block operation: ${String(error)}`);
  }

  // A horizontal rule has already put the caret in the paragraph it inserted; restoring must not overwrite it.
  // Inserting a collapsible section is the same way: the caret it placed in the title is left alone.
  // Inserting a table likewise leaves the caret it placed in the first cell alone, and inserting a diagram source
  // block the caret it placed inside the block.
  if (
    progress.changed
    && captured !== undefined
    && operation.kind !== 'horizontalRule'
    && operation.kind !== 'insertDetails'
    && operation.kind !== 'insertDiagram'
    && operation.kind !== 'insertTable'
  ) {
    if (conversions.length > 0) {
      restoreQuoteLineSelection(root, captured, conversions);
    } else {
      restoreBlockSelection(root, captured);
    }
  }
  return progress.changed;
}

/**
 * Restores the selection after the lines of bare blockquotes were turned into blocks.
 *
 * The `br` elements that separated the lines counted as characters and left the tree, so a recorded count no longer
 * points at the same characters. An end that was inside such a blockquote goes to the position the conversion
 * returned, and an end outside goes to its recorded count less what the blockquotes before it lost.
 *
 * @param root The editor root.
 * @param captured The selection recorded before the operation.
 * @param conversions The conversions made by the operation.
 */
function restoreQuoteLineSelection(
  root: Element,
  captured: BlockSelection,
  conversions: readonly QuoteLineConversion[],
): void {
  const domSelection = root.ownerDocument.defaultView?.getSelection();
  if (domSelection === null || domSelection === undefined) {
    return;
  }

  const start = conversions.find((conversion) => conversion.points.start !== undefined)?.points.start
    ?? findContentPosition(root, captured.start - countLostBefore(conversions, 'start'), 'start');
  const end = conversions.find((conversion) => conversion.points.end !== undefined)?.points.end
    ?? (captured.end === captured.start
      ? start
      : findContentPosition(root, captured.end - countLostBefore(conversions, 'end'), 'end'));
  const range = root.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  domSelection.removeAllRanges();
  domSelection.addRange(range);
}

/**
 * Returns how many counted characters the converted blockquotes before one end of the selection lost.
 *
 * @param conversions The conversions made by the operation.
 * @param side The end of the selection.
 * @returns The number of characters.
 */
function countLostBefore(conversions: readonly QuoteLineConversion[], side: 'start' | 'end'): number {
  let lost = 0;
  for (const conversion of conversions) {
    if (conversion.plan[side].place === 'after') {
      lost += conversion.lost;
    }
  }
  return lost;
}

/**
 * Determines whether a collapsed caret is at a between-blocks position.
 *
 * @param root The editor root.
 * @returns `true` if a collapsed caret is at a between-blocks position.
 */
function isCaretBetweenBlocks(root: Element): boolean {
  const range = readSelectionRange(root);
  return range !== undefined
    && range.collapsed
    && isBetweenBlocksPosition(root, range.startContainer, range.startOffset);
}

/**
 * Decides the target blocks of an operation.
 *
 * @param ports The block command ports.
 * @param root The editor root.
 * @param captured The selection recorded before the operation.
 * @param progress The holder of whether the tree was changed. Set to true each time a bare run is wrapped.
 * @returns The target blocks.
 */
function collectTargets(
  ports: BlockCommandPorts,
  root: Element,
  captured: BlockSelection | undefined,
  progress: BlockRewriteProgress,
): readonly Element[] {
  const range = readSelectionRange(root);
  if (range === undefined) {
    return [];
  }

  let wrapped = false;
  for (const head of collectBareRunHeads(root, range)) {
    // Ensuring a target acts only on the single start point of the range it is given, so it is called once per
    // run with the caret at that run's first node.
    placeCaret(head, 0);
    if (ports.ensureTargetBlock() !== undefined) {
      // Recorded per run, so that an exception on a later run still leaves everything wrapped so far closable
      // as a change.
      progress.changed = true;
      wrapped = true;
    }
  }

  if (!wrapped) {
    return collectTargetBlocks(root, range);
  }

  // Wrapping moves nodes and pushes the selection outside. Restore the recorded position before taking the
  // targets again.
  if (captured !== undefined) {
    restoreBlockSelection(root, captured);
  }
  const restored = readSelectionRange(root);
  return restored === undefined ? [] : collectTargetBlocks(root, restored);
}

/**
 * Rewrites the tree according to the operation.
 *
 * @param operation The block operation.
 * @param targets The target blocks.
 * @param root The editor root. List operations use it to read the selection and the owning item.
 * @param progress The holder of whether the tree was changed.
 * @param conversions Receives the bare blockquotes whose lines were turned into blocks.
 */
function runOperation(
  operation: BlockOperation,
  targets: readonly Element[],
  root: Element,
  progress: BlockRewriteProgress,
  conversions: QuoteLineConversion[],
): void {
  if (isListOperation(operation)) {
    runListOperation(operation, targets, root, progress);
    return;
  }

  if (operation.kind === 'horizontalRule') {
    const reference = targets.at(0);
    if (reference === undefined) {
      return;
    }
    // Inserting inside an item would produce invalid nesting, so before checking convertibility, hand it to the
    // branch that splits the list and inserts in the gap.
    if (insertAfterListItem(reference, insertHorizontalRule, progress) || !isConvertibleBlock(reference)) {
      return;
    }
    if (insertHorizontalRule(reference)) {
      progress.changed = true;
    }
    return;
  }

  if (operation.kind === 'insertDetails') {
    // Shaped as the same kind of branch as the horizontal rule. From a list item it is inserted into the gap where the
    // list is split. The content of a bare cell has already been wrapped in a paragraph before the targets were
    // decided, and that paragraph becomes the reference.
    const reference = targets.at(0);
    if (reference === undefined) {
      return;
    }
    if (insertAfterListItem(reference, insertDetailsSection, progress) || !isConvertibleBlock(reference)) {
      return;
    }
    if (insertDetailsSection(reference)) {
      progress.changed = true;
    }
    return;
  }

  if (operation.kind === 'insertDiagram') {
    // The same branch as the collapsible section, so a diagram lands in the same places.
    const reference = targets.at(0);
    if (reference === undefined) {
      return;
    }
    if (insertAfterListItem(reference, insertDiagramSource, progress) || !isConvertibleBlock(reference)) {
      return;
    }
    if (insertDiagramSource(reference)) {
      progress.changed = true;
    }
    return;
  }

  if (operation.kind === 'insertTable') {
    const reference = targets.at(0);
    if (reference === undefined) {
      return;
    }
    // The list item branch comes before the convertibility check. A paragraph that is an item line is not
    // convertible, so checking first would end without doing anything. The list is not split; the table goes
    // inside the item.
    const intoItem = isListItem(reference) || isItemLineParagraph(reference);
    if (!intoItem && !isConvertibleBlock(reference)) {
      return;
    }
    // Inserting a table starts changing the tree as soon as it is called. The progress is set before the call,
    // so that even if an exception occurs partway, what was inserted is closed as completed and the display
    // and the saved content do not disagree.
    const changedBefore = progress.changed;
    progress.changed = true;
    const inserted = intoItem
      ? insertTableIntoListItem(reference, operation.rows, operation.columns)
      : insertTable(reference, operation.rows, operation.columns);
    progress.changed = inserted || changedBefore;
    return;
  }

  if (operation.kind === 'alert') {
    applyAlert(targets, operation.to, progress);
    return;
  }

  const to = readTargetKind(operation, targets);
  if (to === undefined) {
    return;
  }
  // A bare blockquote is not replaced by a code block; the lines the selection covers become one inside it. Every
  // blockquote is planned before anything is rewritten, because rewriting moves the nodes the selection points into.
  const plans = to === BLOCK_KIND.codeBlock ? planQuoteTargets(root, targets) : new Map<Element, QuoteLinePlan>();
  for (const target of targets) {
    const plan = plans.get(target);
    if (plan !== undefined) {
      conversions.push(convertQuote(plan, progress));
      continue;
    }
    if (convertBlock(target, to) !== undefined) {
      progress.changed = true;
    }
  }
}

/**
 * Plans the lines of every bare blockquote among the targets.
 *
 * @param root The editor root.
 * @param targets The target blocks.
 * @returns The plans keyed by blockquote. Empty when there is no selection.
 */
function planQuoteTargets(root: Element, targets: readonly Element[]): Map<Element, QuoteLinePlan> {
  const plans = new Map<Element, QuoteLinePlan>();
  const range = readSelectionRange(root);
  if (range === undefined) {
    return plans;
  }
  for (const target of targets) {
    if (isBareBlockquote(target)) {
      plans.set(target, planQuoteLines(target, range));
    }
  }
  return plans;
}

/**
 * Turns the covered lines of a bare blockquote into a code block and measures what the blockquote lost.
 *
 * @param plan The plan of the blockquote.
 * @param progress The holder of whether the tree was changed.
 * @returns The conversion.
 */
function convertQuote(plan: QuoteLinePlan, progress: BlockRewriteProgress): QuoteLineConversion {
  const before = countContent(plan.quote);
  // The rewrite changes the tree as soon as it starts. Setting the progress first closes whatever changed as an
  // edit even if it fails partway.
  progress.changed = true;
  const points = convertQuoteLines(plan);
  return { plan, points, lost: before - countContent(plan.quote) };
}

/**
 * Returns the target kind of a conversion.
 *
 * The code block toggle decides its direction from the kind of the first target alone. Deciding it from a kind
 * partway through the list would disagree with the direction the button's pressed state shows.
 *
 * @param operation A block operation that converts the kind of its targets.
 * @param targets The target blocks.
 * @returns The target kind, or `undefined` when there is no target.
 */
function readTargetKind(
  operation: Exclude<
    BlockOperation,
    | { kind: 'horizontalRule' }
    | { kind: 'alert' }
    | { kind: 'insertDetails' }
    | { kind: 'insertDiagram' }
    | { kind: 'insertTable' }
    | ListOperation
  >,
  targets: readonly Element[],
): BlockKind | undefined {
  if (operation.kind === 'convert') {
    return operation.to;
  }
  const first = targets.at(0);
  if (first === undefined) {
    return undefined;
  }
  return readBlockKind(first) === BLOCK_KIND.codeBlock ? BLOCK_KIND.paragraph : BLOCK_KIND.codeBlock;
}

/**
 * Returns the edit kind used when sending a single operation as one standalone edit.
 *
 * History groups only typing and deletion, so the spelling merely has to differ from both of theirs.
 * Alert operations share a single spelling rather than one per selection. Standalone edits are never grouped, so
 * there is nothing to tell apart.
 *
 * @param operation The block operation.
 * @returns The edit kind.
 */
function readEditKind(operation: BlockOperation): string {
  return `block:${operation.kind === 'convert' ? operation.to : operation.kind}`;
}

/**
 * Returns the blocks in document order.
 *
 * @param root The editor root.
 * @returns The blocks.
 */
function collectBlocks(root: Element): Element[] {
  const blocks: Element[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Element && BLOCK_TAG_NAMES.has(node.localName)) {
      blocks.push(node);
    }
  }
  return blocks;
}

/**
 * Returns the number of characters counted up to a boundary.
 *
 * @param root The editor root.
 * @param container The container of the boundary.
 * @param offset The position of the boundary.
 * @returns The number of characters.
 */
function countContentBefore(root: Element, container: Node, offset: number): number {
  return countCharacters(root, { node: root, offset: 0 }, { node: container, offset }, BLOCK_SELECTION_COUNT);
}

/**
 * Returns the number of characters counted inside an element, the same way a recorded selection counts them.
 *
 * @param element The element.
 * @returns The number of characters.
 */
function countContent(element: Element): number {
  return countContentBefore(element, element, element.childNodes.length);
}

/**
 * Finds the position corresponding to a character count.
 *
 * @param root The editor root.
 * @param target The number of characters counted from the beginning.
 * @param side Whether the position being searched for is the start or the end.
 * @returns The container and the position, collapsed to the very end when the counted nodes run out.
 */
function findContentPosition(root: Element, target: number, side: 'start' | 'end'): SelectionPoint {
  return findCountedPosition(root, target, side, BLOCK_SELECTION_COUNT) ?? { node: root, offset: 0 };
}
