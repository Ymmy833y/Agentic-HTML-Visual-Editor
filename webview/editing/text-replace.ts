import { fillPlaceholder, findBlock, isEmptyBlock, isInsidePre } from './block';
import { isLineBlock } from './block-merge';
import { FORMAT_ELEMENT_TAG_NAMES } from './inline-format';
import type { EditEndpointSelections } from '../history/edit-transaction-controller';

/**
 * The edit kind of a replacement.
 *
 * History groups only typing and deletes, so this spelling differs from both and one replacement (one match, or all
 * matches at once) becomes one standalone edit.
 */
export const TEXT_REPLACE_EDIT_KIND = 'search:replace';

/** A part of one text node: the characters from the start offset up to, but not including, the end offset. */
export interface TextSpan {
  readonly node: Text;
  readonly start: number;
  readonly end: number;
}

/**
 * The text to replace: a range and the parts of text nodes that hold its characters.
 *
 * The range may also cover nodes that are not part of the text (hidden elements, comment entries, images). Only the
 * characters in the spans are removed.
 */
export interface ReplaceTarget {
  /** The range from the first character to the last. */
  readonly range: Range;
  /** The spans in document order. At least one. */
  readonly spans: readonly TextSpan[];
}

/** Whether a replacement has changed the tree so far. */
interface ReplaceProgress {
  changed: boolean;
}

/** Ports of replacement. */
export interface TextReplacePorts {
  /** Whether IME composition is in progress at the time of the call. */
  isComposing(): boolean;

  /** Whether any reason for stopping input remains. */
  isInputStopped(): boolean;

  /**
   * Runs a command that changes the tree as one edit attempt.
   *
   * @param kind The edit kind.
   * @param command A command that returns true only when it changed the tree.
   * @param endpoints The selections to record at the endpoints of the edit.
   * @returns Whether the tree changed. False if the attempt could not be opened.
   */
  runCommandEdit(kind: string, command: () => boolean, endpoints: EditEndpointSelections): boolean;

  /** Leaves one diagnostic line for maintainers. Not used to notify users. */
  reportDiagnostic(detail: string): void;
}

/**
 * Replaces the characters of each target with the same text, as one edit.
 *
 * Only text changes. The replacement goes where the first character was, so it takes the formatting and the
 * annotation of that character, and no element is created. An element is removed only when it is a format element
 * without attributes that the removed characters left empty, the same rule the tidying of format elements follows.
 * Comments are never removed. The selection is not touched, so typing in a field outside the editor root goes on.
 *
 * The endpoints of the edit record the first target before the edit and its replacement after it, so undo and redo
 * return the caret there.
 *
 * @param root The editor root.
 * @param ports The ports.
 * @param targets The targets in document order. They must not overlap.
 * @param text The replacement. Empty removes the characters.
 * @returns The range the replacement of the first target occupies (collapsed when the replacement is empty).
 *   `undefined` if nothing was replaced: no targets, during composition, while input is stopped, or when the edit
 *   attempt could not be opened.
 */
export function replaceTexts(
  root: Element,
  ports: TextReplacePorts,
  targets: readonly ReplaceTarget[],
  text: string,
): Range | undefined {
  const first = targets.at(0);
  if (first === undefined || ports.isComposing() || ports.isInputStopped()) {
    return undefined;
  }
  const end = root.ownerDocument.createRange();
  let placed: Range | undefined;
  const changed = ports.runCommandEdit(TEXT_REPLACE_EDIT_KIND, () => {
    const progress: ReplaceProgress = { changed: false };
    try {
      // From the last target back, so that the offsets of earlier targets in the same text node stay valid.
      for (let index = targets.length - 1; index >= 0; index -= 1) {
        placed = replaceSpans(root, targets[index].spans, text, progress);
      }
      if (placed !== undefined) {
        end.setStart(placed.startContainer, placed.startOffset);
        end.setEnd(placed.endContainer, placed.endOffset);
      }
    } catch (error) {
      // Close whatever changed before the exception as one edit too. Closing it as aborted would make the display and
      // the saved content disagree.
      ports.reportDiagnostic(`Could not replace the text: ${String(error)}`);
    }
    return progress.changed;
  }, { start: first.range, end });
  return changed ? placed : undefined;
}

/**
 * Removes the characters of the spans and puts the replacement where the first one was.
 *
 * @param root The editor root.
 * @param spans The spans in document order. At least one.
 * @param text The replacement.
 * @param progress Set to changed as soon as the tree changes, so that an exception thrown later still closes the edit.
 * @returns The range the replacement occupies.
 */
function replaceSpans(root: Element, spans: readonly TextSpan[], text: string, progress: ReplaceProgress): Range {
  const head = spans[0];
  const block = findBlock(head.node, root);
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index];
    span.node.deleteData(span.start, span.end - span.start);
    progress.changed = true;
  }
  head.node.insertData(head.start, text);
  const range = root.ownerDocument.createRange();
  range.setStart(head.node, head.start);
  range.setEnd(head.node, head.start + text.length);

  for (const span of spans) {
    if (span.node.length === 0 && span.node.parentNode !== null) {
      removeEmptied(span.node, root);
    }
  }
  // A line emptied of all its text loses its height and the caret could not stay in it, so it keeps one br, as it
  // does when a range delete empties it.
  if (block !== undefined && block.isConnected && isLineBlock(block) && isEmptyBlock(block)) {
    fillPlaceholder(block);
  }
  return range;
}

/**
 * Removes an emptied text node, and then each format element around it that has become empty.
 *
 * Elements with attributes are kept, because dropping them would lose a destination or a mark. The inside of a `pre`
 * is left alone, because its `code` is the container of the code block, not a format.
 *
 * @param node The emptied text node.
 * @param root The editor root.
 */
function removeEmptied(node: Text, root: Element): void {
  let parent: Element | null = node.parentElement;
  node.remove();
  while (
    parent !== null
    && parent !== root
    && FORMAT_ELEMENT_TAG_NAMES.has(parent.localName)
    && parent.attributes.length === 0
    && parent.childNodes.length === 0
    && !isInsidePre(parent, root)
  ) {
    const next = parent.parentElement;
    parent.remove();
    parent = next;
  }
}
