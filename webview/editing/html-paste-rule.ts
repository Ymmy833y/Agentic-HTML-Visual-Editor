import { readSelectionRange } from './caret';
import { findVisibleContent } from './copy-html';
import type { EditingSession } from './editing-session';
import type { DiagnosticReporter, InputRule, InputRuleResult } from './input-dispatcher';
import { buildPasteFragment } from './paste-fragment';
import { insertPasteFragment } from './paste-insert';
import type { PasteInsertPorts } from './paste-insert';
import { decidePastePlacement } from './paste-placement';

/**
 * Ports of the HTML paste rule: the fragment insertion ports plus range deletion, text form paste, and diagnostics.
 *
 * The rule is created every time the editing session is recreated, so the ports may be bound to the editing session
 * they were registered with.
 */
export interface HtmlPastePorts extends PasteInsertPorts {
  /**
   * Ensures a target block and deletes the range, if any. The registered range delete protections apply just as they
   * do for a normal delete.
   *
   * @param range The range to delete.
   * @returns The target block after deleting the range, or `undefined` if one cannot be ensured.
   */
  deleteRange(range: Range): Element | undefined;

  /**
   * Deletes the range, then inserts the text split into lines.
   *
   * @param text The text to paste.
   * @param range The range to insert into.
   * @returns Whether the tree changed.
   */
  pasteText(text: string, range: Range): boolean;

  /** Leaves one diagnostic line for maintainers. Not used to notify users. */
  reportDiagnostic(detail: string): void;
}

/**
 * Adds the HTML paste rule to the paste input type of the editing session.
 *
 * The rule is lost with the editing session on document replacement, so call this on every mount. The built-in paste
 * is in the fallback queue, so this rule is tried first.
 *
 * @param session The editing session.
 * @param documentUri The document URI used as the base for resolving relative paths. May be empty.
 * @param resourceRootUri The resource root URI. May be empty.
 * @param reportDiagnostic The receiver of diagnostics for maintainers.
 */
export function registerHtmlPasteRule(
  session: Pick<EditingSession, 'registerRule' | 'deleteRange' | 'pasteText' | 'prepareSplit' | 'insertBlock'>,
  documentUri: string,
  resourceRootUri: string,
  reportDiagnostic: DiagnosticReporter,
): void {
  session.registerRule('insertFromPaste', createHtmlPasteRule({
    deleteRange: (range) => session.deleteRange(range),
    pasteText: (text, range) => session.pasteText(text, range),
    prepareSplit: (block, range) => session.prepareSplit(block, range),
    insertBlock: (block, reference, position) => session.insertBlock(block, reference, position),
    documentUri,
    resourceRootUri,
    reportDiagnostic,
  }));
}

/**
 * Creates a rule for the paste input type. Takes the input only when the fragment built from the HTML form can be
 * inserted as HTML.
 *
 * If there is no HTML form, the fragment has no visible content, or the placement at the start of the range is the
 * text form, the rule does not take the input and lets the built-in paste in the fallback queue insert the text form.
 * Once it takes the input, it decides the placement again after deleting the range, because a protection triggered by
 * the range deletion can move the caret, for example into a title.
 *
 * @param ports The ports.
 * @returns The rule for the paste input type.
 */
export function createHtmlPasteRule(ports: HtmlPastePorts): InputRule {
  return ({ event, root, range }) => {
    const html = event.dataTransfer?.getData('text/html') ?? '';
    if (html === '') {
      return 'pass';
    }

    let fragment: DocumentFragment;
    try {
      fragment = buildPasteFragment(html);
      if (
        findVisibleContent(fragment, 'first') === undefined
        || decidePastePlacement(fragment, root, { container: range.startContainer, offset: range.startOffset }).kind === 'text'
      ) {
        return 'pass';
      }
    } catch (error) {
      // The live tree has not changed yet, so do not take the input and leave it to the text form paste.
      ports.reportDiagnostic(`Could not handle the pasted HTML, so pasting it as the text form: ${String(error)}`);
      return 'pass';
    }

    const before = root.innerHTML;
    try {
      return pasteFragment(fragment, event, root, range, ports, before);
    } catch (error) {
      // Close whatever changed before the exception as one edit too. Closing it as aborted would make the display and
      // the saved content disagree.
      ports.reportDiagnostic(`Stopped the HTML paste partway: ${String(error)}`);
      return root.innerHTML === before ? 'consumed' : 'edited';
    }
  };
}

/**
 * Ensures a target block, deletes the range, decides the placement again at the caret after the deletion, and inserts
 * the fragment or the text form.
 *
 * @param fragment The fragment.
 * @param event The paste event.
 * @param root The editor root.
 * @param range The selection range.
 * @param ports The ports.
 * @param before The editor root's `innerHTML` just before deleting the range.
 * @returns The input rule result.
 */
function pasteFragment(
  fragment: DocumentFragment,
  event: InputEvent,
  root: Element,
  range: Range,
  ports: HtmlPastePorts,
  before: string,
): InputRuleResult {
  if (ports.deleteRange(range) === undefined) {
    return 'consumed';
  }
  // The range deletion places the selection again, so read the selection again to decide the placement.
  const caret = readSelectionRange(root) ?? range;
  const placement = decidePastePlacement(fragment, root, { container: caret.startContainer, offset: caret.startOffset });
  if (placement.kind === 'text') {
    // For example, when a delete protection moved the caret into a title. Blocks cannot go there, so insert the text
    // form instead of the fragment.
    ports.pasteText(event.dataTransfer?.getData('text/plain') ?? '', caret);
    return root.innerHTML === before ? 'consumed' : 'edited';
  }
  insertPasteFragment(fragment, placement, caret, root, ports);
  return 'edited';
}
