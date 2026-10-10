import { COMMENT_TAG_NAME } from '../../common/index';
import { findBlock, isEmptyBlock, isHtmlWhitespaceOnly, isInsidePre } from './block';
import type { BlockRewriteProgress } from './block-format';
import { insertTextAtRange, placeCaret, readSelectionRange } from './caret';
import { COMPOSITION_PLACEHOLDER_TEXT } from './code-composition';
import { isCommentCrossingRange, isCommentTouchingRange, readCommentEdge, readLineContext } from './comment-edge';
import type { CommentEdge } from './comment-edge';
import { insertTypedText } from './crossing-input';
import type { EditingHooks } from './editing-hooks';
import type { DiagnosticReporter, InputRule } from './input-dispatcher';
import { prepareTargetBlock } from './target-block';
import type { NodeBoundary } from '../selection/selection-position';

// A space that does not collapse on display. If a typed space collapsed, the caret would not advance and the input would be invisible.
const NO_BREAK_SPACE = ' ';

// Elements counted as visible content after a line break. Entries are not displayed, so they are not counted.
const LINE_BREAK_CONTENT_SELECTOR = 'img, br';

/**
 * Creates the rule for text input and in-line line breaks at comment edges and in comment-crossing ranges.
 *
 * At a comment edge, the default input goes outside on the start side and inside on the end side, regardless of the selection position. The caret position
 * represents which side is chosen, so where the two disagree, the text is inserted right there without moving the position. The default replacement of a comment-crossing
 * or comment-touching range removes entries, so the range is deleted by range deletion first and then the text is inserted. Paste is not handled
 * (paste inserts at the caret position, so it lands on the chosen side as is).
 *
 * @param hooks The editing hooks. Passed to range deletion so the registered guards apply.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 * @returns The rule to register at the end of the fallback queues for text input and line break insertion.
 */
export function createCommentInputRule(hooks: EditingHooks, reportDiagnostic: DiagnosticReporter): InputRule {
  return ({ event, root, range }) => {
    const text = event.data ?? '';
    if (event.inputType === 'insertText' && text.length === 0) {
      return 'pass';
    }
    const progress: BlockRewriteProgress = { changed: false };
    try {
      // Whether only a placeholder br remained in the target block after deleting the range. Happens when deleting a range that fully contains a comment.
      let emptied = false;
      if (range.collapsed) {
        // Read backward: inside a comment without visible content counts as inside at the start, and between adjacent comments counts as the outside end of the preceding comment.
        // Both are positions where the default input does not land on the chosen side.
        const edge = readCommentEdge(root, readCaret(range), 'backward');
        if (edge === undefined || (event.inputType === 'insertText' && entersChosenSideByDefault(edge))) {
          return 'pass';
        }
      } else {
        if (!isCommentCrossingRange(range, root) && !isCommentTouchingRange(range, root)) {
          return 'pass';
        }
        // Range deletion has changed the tree even if it throws midway. Set progress to true before calling it so the display and the saved content do not diverge.
        progress.changed = true;
        const block = prepareTargetBlock(root, range, hooks);
        if (block === undefined) {
          progress.changed = false;
          return 'consumed';
        }
        emptied = isEmptyBlock(block);
      }

      if (event.inputType !== 'insertText') {
        insertCommentLineBreak(range, root, progress);
        return 'edited';
      }
      const typed = toVisibleSpaces(root, readCaret(range), text);
      if (emptied) {
        // The placeholder br of the emptied block is no longer needed once text is inserted, so remove it.
        insertTypedText(range, root, typed, progress);
      } else {
        // The text input procedure after deleting a range removes the trailing br of the target element even when it is not empty. Here the trailing br is
        // a line break the user entered (such as an empty line at the end), so insert only the text without removing it.
        insertTextAtRange(range, typed);
        progress.changed = true;
        placeCaret(range.startContainer, range.startOffset);
      }
      return 'edited';
    } catch (error) {
      reportDiagnostic(`Could not handle the input at the comment edge: ${String(error)}`);
      return progress.changed ? 'edited' : 'consumed';
    }
  };
}

/**
 * Turns the spaces of the text to insert that would fall where they collapse on display into U+00A0.
 *
 * The default input also turns spaces at collapsing positions into non-collapsing spaces. Unless this feature does the same when inserting on its own, the caret does not advance on typing.
 *
 * @param root The editor root.
 * @param position The position to insert at.
 * @param text The text to insert.
 * @returns The text with spaces replaced. Unchanged inside `pre`.
 */
export function toVisibleSpaces(root: Element, position: NodeBoundary, text: string): string {
  if (isInsidePre(position.container, root) || !text.includes(' ')) {
    return text;
  }
  const context = readLineContext(root, position);
  let result = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== ' ') {
      result += character;
      continue;
    }
    const before = index === 0 ? context.before : !isHtmlWhitespaceOnly(result[result.length - 1]);
    const after = context.after || !isHtmlWhitespaceOnly(text.slice(index + 1));
    result += before && after ? ' ' : NO_BREAK_SPACE;
  }
  return result;
}

/**
 * Inserts an in-line line break (`br`) and places the range and the caret just after it.
 *
 * A single `br` at the end of a line does not create a new line. When the comment is at the end of the block, only undisplayed entries follow the line break,
 * so check for visible content after it without counting entries, and add one more `br` if there is none.
 *
 * @param range The collapsed selection range. Moves to just after the line break.
 * @param root The editor root.
 * @param progress The progress that holds whether the tree was changed.
 */
export function insertCommentLineBreak(range: Range, root: Element, progress: BlockRewriteProgress): void {
  const document = root.ownerDocument;
  const lineBreak = document.createElement('br');
  range.insertNode(lineBreak);
  progress.changed = true;
  range.setStartAfter(lineBreak);
  range.collapse(true);

  if (!hasVisibleContentAfter(lineBreak, root)) {
    lineBreak.after(document.createElement('br'));
  }
  placeCaret(range.startContainer, range.startOffset);
}

/**
 * As a composition start preprocessor, collapses a comment-crossing range to its start and places a composition placeholder at a caret on a comment edge.
 *
 * Composed characters cannot be stopped. Replacing a crossing range with a composition removes entries, and deleting from the tree at composition start would disagree with
 * the rollback when nothing is committed, so the range is collapsed rather than deleted. The default composition does not land on the chosen side at a comment edge,
 * so place a zero-width composition placeholder on the chosen side and let the composed characters go there.
 *
 * @param root The editor root.
 * @param keepPlaceholder The port that records a placed composition placeholder as part of the pre-composition state. It is removed when composition ends.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 */
export function prepareCommentComposition(
  root: Element,
  keepPlaceholder: (text: Text) => void,
  reportDiagnostic: DiagnosticReporter,
): void {
  let inserted: Text | undefined;
  try {
    const range = readSelectionRange(root);
    if (range === undefined) {
      return;
    }
    // A comment-touching range is not collapsed, because the default replacement keeps the entries and lands on the correct side.
    if (!range.collapsed) {
      if (!isCommentCrossingRange(range, root)) {
        return;
      }
      placeCaret(range.startContainer, range.startOffset);
    }
    const caret = readCaret(range);
    if (readCommentEdge(root, caret, 'backward') === undefined) {
      return;
    }
    inserted = root.ownerDocument.createTextNode(COMPOSITION_PLACEHOLDER_TEXT);
    insertAtBoundary(caret, inserted);
    placeCaret(inserted, inserted.data.length);
    keepPlaceholder(inserted);
  } catch (error) {
    // Composition cannot be stopped, so do not throw even on an exception; remove any placed composition placeholder and let composition continue at the default position.
    inserted?.remove();
    reportDiagnostic(`Could not place a composition placeholder at the comment edge before composition: ${String(error)}`);
  }
}

/**
 * Returns whether the default text input lands on the side the comment edge represents.
 *
 * Inside at the end and outside at the start, the default input lands on the same side, so leave it to the default there. If this feature kept inserting on its own,
 * each typed space would become a U+00A0 at the line end and stay U+00A0, where the default would turn it back into a normal space on the next character.
 *
 * @param edge The comment edge.
 * @returns `true` for inside at the end or outside at the start.
 */
function entersChosenSideByDefault(edge: CommentEdge): boolean {
  return (edge.place === 'inside') !== (edge.side === 'start');
}

/**
 * Reads the range start as the caret position.
 *
 * @param range The selection range.
 * @returns The position.
 */
function readCaret(range: Range): NodeBoundary {
  return { container: range.startContainer, offset: range.startOffset };
}

/**
 * Returns whether visible content of the block follows the element.
 *
 * @param element The element.
 * @param root The editor root.
 * @returns `true` if, excluding entries, there is non-whitespace text, `img`, or `br`.
 */
function hasVisibleContentAfter(element: Element, root: Element): boolean {
  const block = findBlock(element, root) ?? root;
  const probe = root.ownerDocument.createRange();
  probe.setStartAfter(element);
  probe.setEnd(block, block.childNodes.length);
  const rest = probe.cloneContents();
  for (const entry of rest.querySelectorAll(`${COMMENT_TAG_NAME.body}, ${COMMENT_TAG_NAME.reply}`)) {
    entry.remove();
  }
  return !isHtmlWhitespaceOnly(rest.textContent ?? '') || rest.querySelector(LINE_BREAK_CONTENT_SELECTOR) !== null;
}

/**
 * Inserts a node at a position.
 *
 * At the edge of a text, places the node next to it without splitting. `Range.insertNode` splits the text even at its edge and leaves an empty text.
 *
 * @param position The position to insert at.
 * @param node The node to insert.
 */
function insertAtBoundary(position: NodeBoundary, node: Node): void {
  const { container, offset } = position;
  if (container instanceof Text) {
    if (offset === 0) {
      container.before(node);
      return;
    }
    if (offset < container.length) {
      container.splitText(offset);
    }
    container.after(node);
    return;
  }
  container.insertBefore(node, container.childNodes[offset] ?? null);
}
