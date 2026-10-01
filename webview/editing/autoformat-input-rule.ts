import { applyAutoformat } from './autoformat';
import type { AutoformatTable } from './autoformat';
import type { EditingSession } from './editing-session';
import type { DiagnosticReporter } from './input-dispatcher';

/**
 * Registers the markdown-style autoformat rules, one for text input and one for paragraph insertion.
 *
 * The rules use the edit attempt the input dispatcher opened; they neither open nor close one themselves, and do not
 * change its grouping. Replacing the document replaces the editing session, so call this again every time it is
 * recreated.
 *
 * @param session The editing session.
 * @param table The autoformat table.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 */
export function registerAutoformatRules(
  session: EditingSession,
  table: AutoformatTable,
  reportDiagnostic: DiagnosticReporter,
): void {
  session.registerRule('insertText', ({ event, root, range }) => {
    if (event.data !== ' ') {
      // The only autoformat commit is a single half-width space. Other text input is not matched and proceeds to the
      // default insertion.
      return 'pass';
    }
    const match = table.findMatch('space', root, range);
    // A space that does not match proceeds to the default insertion.
    return match === undefined ? 'pass' : applyAutoformat(match, reportDiagnostic);
  });

  session.registerRule('insertParagraph', ({ root, range }) => {
    const match = table.findMatch('enter', root, range);
    // An Enter that does not match proceeds to the later rules and the built-in replacement.
    return match === undefined ? 'pass' : applyAutoformat(match, reportDiagnostic);
  });
}
