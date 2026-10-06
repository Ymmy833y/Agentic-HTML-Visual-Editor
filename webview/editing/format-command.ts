import { findBlock, isHtmlWhitespaceOnly } from './block';
import { placeCaret, readSelectionRange } from './caret';
import { clearFormats } from './format-clear';
import { applyLink, findEnclosingLink, removeLink } from './format-link';
import { collectFormatTarget } from './format-segment';
import type { FormatTarget } from './format-segment';
import { readFormatState } from './format-state';
import { applyFormat, removeFormat } from './format-toggle';
import { isBlockLevelElement, isFormattingExcluded } from './inline-format';
import type { ToggleFormat } from './inline-format';
import { normalizeFormatElements } from './inline-normalize';

/** A format operation: one of toggle, link, unlink, and clear. */
export type FormatOperation =
  | { readonly kind: 'toggle'; readonly format: ToggleFormat }
  | { readonly kind: 'link'; readonly url: string }
  | { readonly kind: 'unlink' }
  | { readonly kind: 'clear' };

/** The format trigger: whether the operation came from a command or from an input rule of the dispatcher. */
export type FormatTrigger = 'command' | 'rule';

/**
 * The format command ports.
 *
 * None of them holds a value; each is read on every call, because replacing the tree replaces the
 * editing session.
 */
export interface FormatCommandPorts {
  /** Returns the editor root, or `undefined` before it is mounted. */
  readEditorRoot(): Element | undefined;

  /** Returns whether an IME composition is in progress, as of the moment of the call. */
  isComposing(): boolean;

  /** Returns whether even one input stop reason remains. */
  isInputStopped(): boolean;

  /** The command route. Completes the edit attempt only when the tree was changed. */
  runCommandEdit(kind: string, command: () => boolean): boolean;

  /** Ensures a target block at the start of the current selection. */
  ensureTargetBlock(): Element | undefined;

  /**
   * Flips whether a format is held for the next typed character, at the current bare caret.
   *
   * @param format The format to toggle.
   */
  togglePendingFormat(format: ToggleFormat): void;

  /** Leaves one diagnostic line for maintainers. Not used to notify the user. */
  reportDiagnostic(detail: string): void;
}

/**
 * Holds, stage by stage, whether the tree was changed.
 *
 * It lets the attempt be closed with what had been changed so far even if an exception is thrown partway.
 */
interface RewriteProgress {
  changed: boolean;
}

/** A text selection counted over the editor root's text alone, not the line and column of the serialized content. */
export interface TextSelection {
  /** The number of characters up to the start. */
  readonly start: number;
  /** The number of characters up to the end. */
  readonly end: number;
}

/**
 * Runs one operation, from checking the preconditions through to closing the attempt.
 *
 * @param ports The format command ports.
 * @param operation The format operation.
 * @param trigger The format trigger.
 * @returns Whether the tree was changed.
 */
export function runFormatOperation(
  ports: FormatCommandPorts,
  operation: FormatOperation,
  trigger: FormatTrigger,
): boolean {
  const root = ports.readEditorRoot();
  if (root === undefined || ports.isComposing() || ports.isInputStopped()) {
    return false;
  }
  const range = readSelectionRange(root);
  if (range === undefined) {
    return false;
  }
  if (operation.kind === 'toggle' && range.collapsed) {
    // A toggle without a range has no text to rewrite. The format is held for the next typed character
    // instead, so no attempt is opened. Where no format is ever applied, there is nothing to hold either.
    if (!isFormattingExcluded(range.startContainer, root)) {
      ports.togglePendingFormat(operation.format);
    }
    return false;
  }

  const command = (): boolean => rewrite(ports, root, operation);
  if (trigger === 'rule') {
    // The input dispatcher has already opened an attempt. Opening one here would nest the attempts.
    return command();
  }
  return ports.runCommandEdit(readEditKind(operation), command);
}

/**
 * Captures the selection before the operation as a position counted over the editor root's text alone.
 *
 * @param root The editor root.
 * @returns The text selection, or `undefined` when the selection is outside the editor root.
 */
export function readTextSelection(root: Element): TextSelection | undefined {
  const range = readSelectionRange(root);
  if (range === undefined) {
    return undefined;
  }
  const start = countTextBefore(root, range.startContainer, range.startOffset);
  return {
    start,
    end: range.collapsed ? start : countTextBefore(root, range.endContainer, range.endOffset),
  };
}

/**
 * Puts the selection back at the captured position.
 *
 * This feature never changes the text itself, so a position at the same character count covers the same
 * string as before the operation.
 *
 * @param root The editor root.
 * @param selection The captured text selection.
 */
export function restoreTextSelection(root: Element, selection: TextSelection): void {
  const view = root.ownerDocument.defaultView;
  const domSelection = view?.getSelection();
  if (domSelection === null || domSelection === undefined) {
    return;
  }

  const start = findTextPosition(root, selection.start, 'start');
  const end = selection.end === selection.start
    ? start
    : findTextPosition(root, selection.end, 'end');
  const range = root.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  domSelection.removeAllRanges();
  domSelection.addRange(range);
}

/**
 * Runs the body of one operation, from capturing the selection through to restoring it.
 *
 * Returning whether the tree changed instead of letting an exception escape lets a failure partway
 * through the rewrite still close what was changed as an edit. Aborting instead would leave the display
 * and the saved content out of step.
 *
 * @param ports The format command ports.
 * @param root The editor root.
 * @param operation The format operation.
 * @returns Whether the tree was changed.
 */
function rewrite(ports: FormatCommandPorts, root: Element, operation: FormatOperation): boolean {
  const captured = readTextSelection(root);
  const progress: RewriteProgress = { changed: false };
  // Only link and unlink count images, so that a range of only images can be wrapped in a link and unwrapped too.
  // The second collection after ensuring blocks must use the same option, or a run of only images would be a format
  // segment on one side of the ensuring and not on the other.
  const countImages = operation.kind === 'link' || operation.kind === 'unlink';

  try {
    let target = collectFormatTarget(root, countImages);
    if (ensureBlocks(ports, root, target, operation, progress)) {
      if (captured !== undefined) {
        restoreTextSelection(root, captured);
      }
      target = collectFormatTarget(root, countImages);
    }

    const touched = runOperation(operation, target, root);
    if (touched.length > 0) {
      progress.changed = true;
      normalizeFormatElements(touched);
    }
  } catch (error) {
    ports.reportDiagnostic(`Could not finish the format operation: ${String(error)}`);
  }

  if (progress.changed && captured !== undefined) {
    // Restore before closing the attempt, so that the selection captured as the end state is the
    // restored one.
    restoreTextSelection(root, captured);
  }
  return progress.changed;
}

/**
 * Rewrites the tree according to the operation.
 *
 * @param operation The format operation.
 * @param target The format target.
 * @param root The editor root.
 * @returns The touched blocks.
 */
function runOperation(operation: FormatOperation, target: FormatTarget, root: Element): Element[] {
  switch (operation.kind) {
    case 'toggle': {
      // A bare caret never reaches here; it is held as a pending format before the attempt is opened. A
      // range with no target text has nothing to rewrite.
      if (target.kind !== 'segments' || target.segments.length === 0) {
        return [];
      }
      // Read the state and rewrite over the same format segments. Looking at a different set would stop
      // two invocations from returning to the original.
      return readFormatState(target)[operation.format]
        ? removeFormat(operation.format, target.segments)
        : applyFormat(operation.format, target.segments);
    }
    case 'link':
      return applyLink(operation.url, target, root);
    case 'unlink':
      return removeLink(target, root);
    case 'clear':
      return target.kind === 'segments' ? clearFormats(target.segments) : [];
  }
}

/**
 * Wraps a format segment that has no block-level ancestor in a paragraph before the rewrite.
 *
 * Without a settled touched block, neither the reach of normalization nor how much of the tree is left
 * unchanged is decided. Ensuring a target block takes no argument and acts on the start of the current
 * selection, so the selection is moved to the head of each run before it is called.
 *
 * @param ports The format command ports.
 * @param root The editor root.
 * @param target The format target.
 * @param operation The format operation.
 * @param progress Where it is held whether the tree was changed. Set to true on each wrap.
 * @returns `true` when something was wrapped in a paragraph.
 */
function ensureBlocks(
  ports: FormatCommandPorts,
  root: Element,
  target: FormatTarget,
  operation: FormatOperation,
  progress: RewriteProgress,
): boolean {
  if (target.kind === 'caret') {
    // The only operations that go on with a bare caret are changing and removing a link, and that link
    // is what they act on.
    if (operation.kind !== 'link' && operation.kind !== 'unlink') {
      return false;
    }
    const link = findEnclosingLink(target, root);
    if (link === undefined || findBlock(link, root) !== undefined) {
      return false;
    }
    if (ports.ensureTargetBlock() === undefined) {
      return false;
    }
    progress.changed = true;
    return true;
  }

  if (target.kind !== 'segments') {
    return false;
  }

  let wrapped = false;
  for (const segment of target.segments) {
    if (segment.block !== undefined) {
      continue;
    }
    placeCaret(segment.range.startContainer, segment.range.startOffset);
    if (ports.ensureTargetBlock() !== undefined) {
      // Record it per run. If an exception is thrown on a later run, what was wrapped can still be
      // closed as a change.
      progress.changed = true;
      wrapped = true;
    }
  }
  return wrapped;
}

/**
 * Returns the edit kind used when sending one operation as a single standalone edit.
 *
 * History only groups typing and deletion, so the spelling only has to differ from both of those.
 *
 * @param operation The format operation.
 * @returns The edit kind.
 */
function readEditKind(operation: FormatOperation): string {
  return `format:${operation.kind === 'toggle' ? operation.format : operation.kind}`;
}

/**
 * Returns the number of countable text characters up to a boundary.
 *
 * @param root The editor root.
 * @param container The boundary's container.
 * @param offset The boundary's offset.
 * @returns The number of characters.
 */
function countTextBefore(root: Element, container: Node, offset: number): number {
  const document = root.ownerDocument;
  const boundary = document.createRange();
  boundary.setStart(root, 0);
  boundary.setEnd(container, offset);

  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(node instanceof Text)) {
      continue;
    }
    // comparePoint returns -1 before the range, 0 inside it, and 1 after it.
    if (boundary.comparePoint(node, 0) > 0) {
      break;
    }
    if (!isCountableText(node)) {
      continue;
    }
    count += boundary.comparePoint(node, node.data.length) > 0 ? offset : node.data.length;
  }
  return count;
}

/**
 * Finds the position that corresponds to a character count.
 *
 * At a count that falls on the seam between two texts, the start takes the head of the following text and
 * the end takes the tail of the preceding one. Taking the other side would let the selection cross a
 * block separator and stop covering the same string as before the operation.
 *
 * @param root The editor root.
 * @param target The number of characters counted from the head.
 * @param side Whether the position being looked for is the start or the end.
 * @returns The container and the offset. Collapsed to the tail when the corresponding text runs out.
 */
function findTextPosition(
  root: Element,
  target: number,
  side: 'start' | 'end',
): { node: Node; offset: number } {
  let remaining = target;
  let last: Text | undefined;

  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(node instanceof Text) || !isCountableText(node)) {
      continue;
    }
    const inside = side === 'end' ? remaining <= node.data.length : remaining < node.data.length;
    if (inside) {
      return { node, offset: remaining };
    }
    remaining -= node.data.length;
    last = node;
  }
  return last === undefined ? { node: root, offset: 0 } : { node: last, offset: last.data.length };
}

/**
 * Determines whether a text counts as content.
 *
 * A whitespace-only text between blocks is a line separator, not content. Wrapping a bare run in a
 * paragraph adds one more separator, so counting them would stop a position from pointing at the same
 * character before and after the operation.
 *
 * @param text The text to inspect.
 * @returns `true` when it counts.
 */
function isCountableText(text: Text): boolean {
  if (!isHtmlWhitespaceOnly(text.data)) {
    return true;
  }
  const parent = text.parentElement;
  if (parent === null) {
    return false;
  }
  for (const child of parent.children) {
    if (isBlockLevelElement(child)) {
      return false;
    }
  }
  return true;
}
