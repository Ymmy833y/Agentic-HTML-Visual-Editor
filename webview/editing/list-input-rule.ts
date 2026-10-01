import { runBlockOperation } from './block-command';
import type { BlockCommandPorts } from './block-command';
import type { BlockRewriteProgress } from './block-format';
import { BLOCK_DELETE_INPUT_TYPES } from './block-input-rule';
import { placeCaret } from './caret';
import type { EditingSession } from './editing-session';
import type { InputRule, InputRuleResult } from './input-dispatcher';
import { applyListMerge, findFirstItemAtLineStart, isAtBlockItemOwnContentEnd, readListMerge } from './list-delete';
import { exitTrailingParagraph, readListEnter, splitItemAtCaret } from './list-enter';
import { findItemLine } from './list-structure';

/**
 * Registers one list rule each for paragraph insertion and for character-wise and word-wise backward and
 * forward delete.
 *
 * Nothing is registered for line-wise delete: the extent of a line is decided by visual wrapping and cannot be
 * reproduced. The rules use the edit attempt the input dispatcher has opened and do not open their own. Call
 * this again whenever a document replacement changes the editing session.
 *
 * @param session The editing session.
 * @param ports The block command ports.
 */
export function registerListRules(session: EditingSession, ports: BlockCommandPorts): void {
  const enterRule: InputRule = ({ root, range }) => runRule(ports, 'Could not handle Enter in the list item', (progress) => {
    const enter = readListEnter(root, range);
    if (enter === undefined) {
      return 'pass';
    }
    if (enter.kind === 'outdent') {
      return runOutdent(ports);
    }
    if (enter.kind === 'exit') {
      exitTrailingParagraph(enter.paragraph, progress);
      return progress.changed ? 'edited' : 'consumed';
    }

    let line = enter.line;
    if (!range.collapsed) {
      session.deleteRange(range);
      progress.changed = true;
      // Deleting the range can change the content and shape of the line, so find it again from the position
      // left after the deletion.
      const remaining = findItemLine(range.startContainer, root, false);
      if (remaining === undefined) {
        return 'edited';
      }
      line = remaining;
    }
    // Apply the split preprocessors before the line start, end and middle checks; the checks run at the position they shifted to.
    // On a takeover (a line break inserted in the middle of a comment), the item is not split.
    const preparation = session.prepareSplit(line.block ?? line.item, range);
    if (preparation.kind === 'takenOver') {
      if (preparation.changed) {
        progress.changed = true;
      }
      placeCaret(range.startContainer, range.startOffset);
      return progress.changed ? 'edited' : 'consumed';
    }
    splitItemAtCaret(line, range, progress);
    return progress.changed ? 'edited' : 'consumed';
  });
  session.registerRule('insertParagraph', enterRule);

  const backwardRule: InputRule = ({ root, range }) => runRule(ports, 'Could not handle backward delete at the list boundary', (progress) => {
    // At the start of the first item, outdent before merging with the visually preceding line.
    if (findFirstItemAtLineStart(root, range) !== undefined) {
      return runOutdent(ports);
    }
    const merge = readListMerge(root, range);
    if (merge === undefined) {
      return 'pass';
    }
    applyListMerge(merge, progress);
    return progress.changed ? 'edited' : 'consumed';
  });

  // Stops the delete by doing nothing instead of passing it to the browser default.
  const forwardRule: InputRule = ({ root, range }) => runRule(
    ports,
    'Could not handle forward delete at the list boundary',
    () => (isAtBlockItemOwnContentEnd(root, range) ? 'consumed' : 'pass'),
  );

  for (const [inputType, direction] of Object.entries(BLOCK_DELETE_INPUT_TYPES)) {
    session.registerRule(inputType, direction === 'backward' ? backwardRule : forwardRule);
  }
}

/**
 * Calls outdent with the rule trigger.
 *
 * @param ports The block command ports.
 * @returns "Edited" when the tree was changed, "consumed" otherwise.
 */
function runOutdent(ports: BlockCommandPorts): InputRuleResult {
  return runBlockOperation(ports, { kind: 'outdentList' }, 'rule') ? 'edited' : 'consumed';
}

/**
 * Calls the body of a rule and turns exceptions into a rule result instead of throwing them.
 *
 * A thrown exception would make the input dispatcher abort the edit attempt, and the changed tree would never
 * reach the change tracker. Even when the tree was not changed, the input is closed as taken over rather than
 * falling back to the built-in replacement.
 *
 * @param ports The block command ports.
 * @param failure The opening of the single diagnostic line.
 * @param body The body of the rule.
 * @returns The rule result.
 */
function runRule(
  ports: BlockCommandPorts,
  failure: string,
  body: (progress: BlockRewriteProgress) => InputRuleResult,
): InputRuleResult {
  const progress: BlockRewriteProgress = { changed: false };
  try {
    return body(progress);
  } catch (error) {
    ports.reportDiagnostic(`${failure}: ${String(error)}`);
    return progress.changed ? 'edited' : 'consumed';
  }
}
