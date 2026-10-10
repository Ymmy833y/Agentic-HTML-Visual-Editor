import type { BlockCommandPorts } from './block-command';
import type { BlockRewriteProgress } from './block-format';
import { BLOCK_DELETE_INPUT_TYPES } from './block-input-rule';
import { findQuoteLift, liftQuoteLine } from './blockquote-delete';
import {
  exitBlockquote,
  exitQuoteParagraph,
  findBareBlockquote,
  findTrailingQuoteParagraph,
  insertBreakInBlockquote,
  isAtTrailingBlankLine,
} from './blockquote-enter';
import type { EditingSession } from './editing-session';
import type { InputRule } from './input-dispatcher';

/**
 * Registers the paragraph-insertion rule for blockquotes with the input dispatcher.
 *
 * The rule takes over Enter in a bare blockquote, and Enter in the trailing quote paragraph of a blockquote holding
 * blocks. The editing session is replaced whenever the document is replaced, so this is called again each time one
 * is rebuilt.
 *
 * @param session The editing session.
 * @param ports The block command ports.
 */
export function registerAlertRules(session: EditingSession, ports: BlockCommandPorts): void {
  const enterRule: InputRule = ({ root, range }) => {
    const quote = findBareBlockquote(root, range);
    // A bare blockquote holds no blocks, so a caret is never in both.
    const trailing = quote === undefined ? findTrailingQuoteParagraph(root, range) : undefined;
    if (quote === undefined && trailing === undefined) {
      // Elsewhere, and for Enter with a range selected, the rule does not take over. Both go on to the rules that
      // follow and to the built-in replacements.
      return 'pass';
    }

    // The edit attempt is the one the input dispatcher opened. Letting an exception escape would make it abort,
    // leaving the tree changed without reaching change tracking. Changing the tree returns 'edited', and leaving it
    // unchanged returns 'consumed'.
    const progress: BlockRewriteProgress = { changed: false };
    try {
      if (quote === undefined) {
        if (trailing !== undefined) {
          exitQuoteParagraph(trailing, range, progress);
        }
      } else if (isAtTrailingBlankLine(quote, range)) {
        exitBlockquote(quote, range, progress);
      } else {
        insertBreakInBlockquote(quote, range, progress);
      }
    } catch (error) {
      ports.reportDiagnostic(`Could not handle Enter in the blockquote: ${String(error)}`);
    }
    return progress.changed ? 'edited' : 'consumed';
  };
  session.registerRule('insertParagraph', enterRule);
}

/**
 * Registers the backward delete rule that takes the first line out of a blockquote with the input dispatcher.
 *
 * Call this before the block rules are registered. Rules are tried in the order they are registered, and the delete
 * next to a horizontal rule or a diagram would otherwise take a delete at the start of a blockquote that follows one,
 * leaving the blockquote in place on the first delete. The editing session is replaced whenever the document is
 * replaced, so this is called again each time one is rebuilt.
 *
 * @param session The editing session.
 * @param ports The block command ports.
 */
export function registerQuoteDeleteRules(session: EditingSession, ports: BlockCommandPorts): void {
  const deleteRule: InputRule = ({ root, range }) => {
    const lift = findQuoteLift(root, range);
    if (lift === undefined) {
      return 'pass';
    }
    // The same handling as the Enter rule: an exception is not let out of the attempt the input dispatcher opened.
    const progress: BlockRewriteProgress = { changed: false };
    try {
      liftQuoteLine(lift, progress);
    } catch (error) {
      ports.reportDiagnostic(`Could not take the line out of the blockquote: ${String(error)}`);
    }
    return progress.changed ? 'edited' : 'consumed';
  };
  for (const [inputType, direction] of Object.entries(BLOCK_DELETE_INPUT_TYPES)) {
    if (direction === 'backward') {
      session.registerRule(inputType, deleteRule);
    }
  }
}
