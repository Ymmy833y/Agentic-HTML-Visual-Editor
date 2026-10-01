import { isHtmlWhitespaceOnly, isSplittableBlock } from './block';
import type { BlockCommandPorts } from './block-command';
import type { BlockRewriteProgress } from './block-format';
import { splitBlock } from './block-split';
import { placeCaret, placeCaretAtStart } from './caret';
import { findDirectCell, wrapCellRuns } from './cell-wrap';
import type { EditingSession } from './editing-session';
import type { InputRule } from './input-dispatcher';
import { INLINE_RUN_TAG_NAMES } from './target-block';

/**
 * Adds the rule for inserting a paragraph directly inside a cell to the end of the editing session's paragraph
 * insertion list.
 *
 * Recreating the editing session on replacement loses the rule, so this is called on every mount. The built-in Enter
 * is in the fallback queue, so this rule is tried first. Its condition for taking over (the start is directly inside
 * a cell) does not overlap with the Enter rules inside code blocks, blockquotes, details titles and list items, so
 * registration order is not relied on.
 *
 * @param session The editing session. Also received for calling the split preprocessors.
 * @param ports The block command ports. Only the diagnostic is used.
 */
export function registerCellEnterRule(
  session: Pick<EditingSession, 'registerRule' | 'deleteRange' | 'prepareSplit'>,
  ports: Pick<BlockCommandPorts, 'reportDiagnostic'>,
): void {
  session.registerRule('insertParagraph', createCellEnterRule(session, ports));
}

/**
 * Creates a rule that takes over paragraph insertion directly inside a cell, with or without a range selection.
 *
 * The cell's content is wrapped in paragraphs and then split. The built-in Enter cannot split a cell and inserts a
 * line break within a block instead, but Enter creates a new block, and a line break within a block is the job of
 * Shift+Enter. The rule is called inside the edit attempt the input dispatcher opened and does not open an attempt
 * itself.
 *
 * @param session The editing session. Its range delete and split preprocessors are used.
 * @param ports The block command ports. Only the diagnostic is used.
 * @returns The paragraph insertion rule.
 */
export function createCellEnterRule(
  session: Pick<EditingSession, 'deleteRange' | 'prepareSplit'>,
  ports: Pick<BlockCommandPorts, 'reportDiagnostic'>,
): InputRule {
  return ({ root, range }) => {
    if (findDirectCell(root, range.startContainer) === undefined) {
      // Inside a paragraph or list among the cell's children, and outside cells, it is left to their own rules and
      // the built-in Enter.
      return 'pass';
    }

    const progress: BlockRewriteProgress = { changed: false };
    try {
      splitInCell(session, root, range, progress);
    } catch (error) {
      // Throwing out would make the input dispatcher close the attempt as aborted, and the changed tree would not
      // reach the change tracker.
      ports.reportDiagnostic(`Could not handle Enter inside a cell: ${String(error)}`);
    }
    return progress.changed ? 'edited' : 'consumed';
  };
}

/**
 * Wraps the runs directly inside a cell, deletes the range if there is one, and then splits at the caret.
 *
 * The order of wrapping, deleting the range and splitting is the same as the built-in Enter's ensuring, range
 * deletion and splitting. Deleting the range first would drop the caret directly into the cell, where no target
 * could be decided.
 *
 * @param session The editing session.
 * @param root The editor root.
 * @param range The selection range.
 * @param progress Records whether the tree was changed.
 */
function splitInCell(
  session: Pick<EditingSession, 'deleteRange' | 'prepareSplit'>,
  root: Element,
  range: Range,
  progress: BlockRewriteProgress,
): void {
  const collapsed = range.collapsed;
  const wrap = wrapCellRuns(root, range, progress);
  if (wrap === undefined) {
    return;
  }

  let target = wrap.startParagraph;
  if (!collapsed) {
    // Range deletion goes through the registered guards, and when the wrapped paragraph and the paragraph at the end
    // of the range are siblings, they become one again.
    progress.changed = true;
    target = session.deleteRange(range);
  }
  if (target === undefined) {
    return;
  }

  if (collapsed && wrap.insertedEmpty && isBesideNonPhrasing(target)) {
    // Right after moving by Tab into a cell that starts with a list or table, the caret visually sits at its start.
    // Splitting the inserted empty paragraph again would make two empty paragraphs, so a single Enter would appear to
    // add two lines; the inserted paragraph is taken as the new line instead.
    placeCaretAtStart(target);
    return;
  }

  if (isSplittableBlock(target)) {
    // As with the built-in Enter, apply the split preprocessors before the start, end and middle checks. On a takeover
    // (a line break inserted in the middle of a comment), the wrapping paragraph is not split.
    const preparation = session.prepareSplit(target, range);
    if (preparation.kind === 'takenOver') {
      if (preparation.changed) {
        progress.changed = true;
      }
      placeCaret(range.startContainer, range.startOffset);
      return;
    }
    progress.changed = true;
    placeCaretAtStart(splitBlock(target, range));
    return;
  }
  progress.changed = true;
  // When a block that cannot be split becomes the target, a line break within the block is inserted, as the built-in
  // Enter does, to keep the shape.
  const lineBreak = root.ownerDocument.createElement('br');
  range.insertNode(lineBreak);
  range.setStartAfter(lineBreak);
  range.collapse(true);
  placeCaret(range.startContainer, range.startOffset);
}

/**
 * Returns whether there is an element that is not phrasing content before or after the paragraph (skipping
 * whitespace).
 *
 * @param paragraph The paragraph.
 * @returns `true` when there is one on either side.
 */
function isBesideNonPhrasing(paragraph: Element): boolean {
  return [readNeighbor(paragraph, 'previous'), readNeighbor(paragraph, 'next')].some(
    (neighbor) => neighbor instanceof Element && !INLINE_RUN_TAG_NAMES.has(neighbor.localName),
  );
}

/**
 * Returns the adjacent sibling, skipping whitespace-only text.
 *
 * @param node The starting node.
 * @param direction Before or after.
 * @returns The adjacent sibling, or `null` when there is none.
 */
function readNeighbor(node: Node, direction: 'previous' | 'next'): Node | null {
  let current = direction === 'previous' ? node.previousSibling : node.nextSibling;
  while (current instanceof Text && isHtmlWhitespaceOnly(current.data)) {
    current = direction === 'previous' ? current.previousSibling : current.nextSibling;
  }
  return current;
}
