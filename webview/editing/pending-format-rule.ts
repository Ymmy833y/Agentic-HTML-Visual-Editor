import { findBlock, isEmptyBlock, removePlaceholderBreak } from './block';
import { placeCaret, readSelectionRange } from './caret';
import { COMPOSITION_PLACEHOLDER_TEXT } from './code-composition';
import { toVisibleSpaces } from './comment-input';
import type { EditingSession } from './editing-session';
import { readTextSelection, restoreTextSelection } from './format-command';
import type { FormatCommandPorts, TextSelection } from './format-command';
import { collectFormatSegments } from './format-segment';
import { readFormatState } from './format-state';
import { applyFormat, removeFormat } from './format-toggle';
import { isFormattingExcluded } from './inline-format';
import type { ToggleFormat } from './inline-format';
import { normalizeFormatElements } from './inline-normalize';
import type { DiagnosticReporter, InputRule } from './input-dispatcher';
import type { PendingFormat } from './pending-format';

/** What a composition that started under a pending format left behind, kept until the composition ends. */
interface PendingComposition {
  /** The block the placeholder was wrapped in. */
  readonly block: Element;
  /** The selection before the placeholder went in, to return to when nothing is committed. */
  readonly captured: TextSelection | undefined;
}

/**
 * Registers, with the editing session, the character insertion rule and the composition hooks that give the
 * pending format to the next typed text.
 *
 * An editing session is replaced whenever the tree is replaced, so this must be called again each time one is
 * rebuilt. It is registered after the structural rules, so that a rule which turns the typed character into a
 * structure (a code block, an autoformat, a details title) keeps winning; the edit it makes then cancels the
 * pending format.
 *
 * @param session The editing session.
 * @param pending The pending format of the view.
 * @param ports The format command ports.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 */
export function registerPendingFormatRules(
  session: Pick<EditingSession, 'registerRule' | 'registerCompositionStartHook' | 'registerCompositionEndHook'>,
  pending: PendingFormat,
  ports: FormatCommandPorts,
  reportDiagnostic: DiagnosticReporter,
): void {
  session.registerRule('insertText', createPendingFormatRule(pending, ports, reportDiagnostic));

  let composition: PendingComposition | undefined;
  session.registerCompositionStartHook((root, keepPlaceholder) => {
    composition = preparePendingComposition(root, pending, keepPlaceholder, reportDiagnostic);
  });
  session.registerCompositionEndHook((root, committed) => {
    const started = composition;
    composition = undefined;
    if (started !== undefined) {
      finishPendingComposition(root, started, committed, reportDiagnostic);
    }
  });
}

/**
 * Creates the rule that inserts the typed text with the pending formats applied.
 *
 * The text is inserted exactly at the caret, which is also where the default insertion at a comment edge is
 * steered to, so the chosen side of the edge is kept. The formats are decided from the ancestors of the inserted
 * text, the same way a toggle over a range is: a held format already on the ancestors is removed, any other is
 * applied. The characters typed afterwards follow the ancestors of this one, so the pending format is consumed.
 *
 * @param pending The pending format of the view.
 * @param ports The format command ports.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 * @returns The rule to register for text insertion.
 */
export function createPendingFormatRule(
  pending: PendingFormat,
  ports: FormatCommandPorts,
  reportDiagnostic: DiagnosticReporter,
): InputRule {
  return ({ event, root, range }) => {
    // The selection change that follows a caret move is a queued task, so the key typed right after the move
    // can arrive first. Checking the anchor here keeps a moved caret from getting the format either way.
    pending.handleSelectionChange(root);
    if (pending.isEmpty) {
      return 'pass';
    }
    const formats = [...pending.read()];
    // Whatever happens next, the formats are spent: either this rule gives them to the text, or an input
    // they cannot be given to goes through and must not carry them over to a later one.
    pending.clear();

    const text = event.data ?? '';
    if (text.length === 0 || !range.collapsed || isFormattingExcluded(range.startContainer, root)) {
      return 'pass';
    }

    let changed = false;
    try {
      // A format element directly under the editor root would leave a bare run with no settled block to
      // normalize, so the run is wrapped in a paragraph first. Ensuring moves the selection, so it is read again.
      if (findBlock(range.startContainer, root) === undefined && ports.ensureTargetBlock() !== undefined) {
        changed = true;
      }
      const caret = readSelectionRange(root) ?? range;
      const block = findBlock(caret.startContainer, root);
      const wasEmpty = block !== undefined && isEmptyBlock(block);

      const typed = toVisibleSpaces(root, { container: caret.startContainer, offset: caret.startOffset }, text);
      const inserted = insertTextAt(caret, typed);
      changed = true;
      if (wasEmpty && block !== undefined) {
        // The height placeholder of an empty block is not needed once a character is in it.
        removePlaceholderBreak(block);
      }
      flipFormatsAround(root, inserted, formats);
      placeCaret(inserted, inserted.data.length);
      return 'edited';
    } catch (error) {
      reportDiagnostic(`Could not give the pending format to the typed text: ${String(error)}`);
      return changed ? 'edited' : 'consumed';
    }
  };
}

/**
 * As a composition start hook, places a composition placeholder with the pending formats applied, so that the
 * composed characters land inside the format elements.
 *
 * Composed characters cannot be stopped, so the elements are built before the composition rather than around
 * the text afterwards. A caret with no block-level ancestor is left alone: materializing a paragraph here would
 * not be rolled back by the composition guard when nothing is committed.
 *
 * @param root The editor root.
 * @param pending The pending format of the view.
 * @param keepPlaceholder The port that records the placed placeholder as part of the pre-composition state.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 * @returns What was left behind for the end of the composition, or `undefined` when nothing was placed.
 */
function preparePendingComposition(
  root: Element,
  pending: PendingFormat,
  keepPlaceholder: (text: Text) => void,
  reportDiagnostic: DiagnosticReporter,
): PendingComposition | undefined {
  // As for the typed character: the selection change of a caret move may not have been handled yet.
  pending.handleSelectionChange(root);
  if (pending.isEmpty) {
    return undefined;
  }
  const formats = [...pending.read()];
  pending.clear();

  let placeholder: Text | undefined;
  try {
    const range = readSelectionRange(root);
    if (range === undefined || !range.collapsed || isFormattingExcluded(range.startContainer, root)) {
      return undefined;
    }
    const block = findBlock(range.startContainer, root);
    if (block === undefined) {
      return undefined;
    }

    const captured = readTextSelection(root);
    placeholder = insertTextAt(range, COMPOSITION_PLACEHOLDER_TEXT);
    flipFormatsAround(root, placeholder, formats);
    placeCaret(placeholder, placeholder.data.length);
    keepPlaceholder(placeholder);
    return { block, captured };
  } catch (error) {
    // The composition cannot be stopped, so do not throw; take the placeholder back out and let the
    // composition go on at the default position.
    placeholder?.remove();
    reportDiagnostic(`Could not place the pending format before the composition: ${String(error)}`);
    return undefined;
  }
}

/**
 * As a composition end hook, tidies up what the start hook built.
 *
 * The composition guard has already taken the placeholder character out. Normalizing the block removes the
 * format element left empty by an uncommitted composition and joins the elements that were split to put the
 * placeholder outside, so the block is as it was before; the selection is then put back too. A committed
 * composition leaves the composed text inside the elements, and normalizing changes nothing.
 *
 * @param root The editor root.
 * @param composition What the start hook left behind.
 * @param committed Whether the composition committed text.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 */
function finishPendingComposition(
  root: Element,
  composition: PendingComposition,
  committed: boolean,
  reportDiagnostic: DiagnosticReporter,
): void {
  try {
    if (composition.block.isConnected) {
      normalizeFormatElements([composition.block]);
    }
    if (!committed && composition.captured !== undefined) {
      restoreTextSelection(root, composition.captured);
    }
  } catch (error) {
    reportDiagnostic(`Could not tidy up the pending format after the composition: ${String(error)}`);
  }
}

/**
 * Inserts a new text at the start of a range.
 *
 * At the edge of a text the new node is placed beside it without splitting. `Range.insertNode` splits even at
 * the edge and leaves an empty text behind, which would keep a format element that is otherwise empty from
 * being normalized away.
 *
 * @param range The range whose start is the position to insert at.
 * @param text The text to insert. Not empty.
 * @returns The inserted text node.
 */
function insertTextAt(range: Range, text: string): Text {
  const { startContainer: container, startOffset: offset } = range;
  const inserted = container.ownerDocument?.createTextNode(text) ?? new Text(text);
  if (container instanceof Text) {
    if (offset === 0) {
      container.before(inserted);
    } else {
      if (offset < container.length) {
        container.splitText(offset);
      }
      container.after(inserted);
    }
    return inserted;
  }
  container.insertBefore(inserted, container.childNodes[offset] ?? null);
  return inserted;
}

/**
 * Applies or removes each pending format around one inserted node, then normalizes the touched blocks.
 *
 * Each format is decided from the node's ancestors as they are at that point, so that two held formats stack
 * and a held format already on the ancestors is taken off, the same as a toggle over a range would do.
 *
 * @param root The editor root.
 * @param node The inserted text. It is moved into or out of format elements, never replaced.
 * @param formats The pending formats, in the order they were toggled.
 */
function flipFormatsAround(root: Element, node: Node, formats: readonly ToggleFormat[]): void {
  const touched: Element[] = [];
  for (const format of formats) {
    const range = root.ownerDocument.createRange();
    range.selectNode(node);
    const segments = collectFormatSegments(root, range);
    if (segments.length === 0) {
      break;
    }
    touched.push(...(readFormatState({ kind: 'segments', segments })[format]
      ? removeFormat(format, segments)
      : applyFormat(format, segments)));
  }
  normalizeFormatElements(touched);
}
