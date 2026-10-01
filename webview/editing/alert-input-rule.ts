import type { BlockCommandPorts } from './block-command';
import type { BlockRewriteProgress } from './block-format';
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
