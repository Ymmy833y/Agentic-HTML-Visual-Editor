import { VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import type { CopyHtmlResponseMessage, RequestId } from '../../common/index';
import { readSelectionRange } from './caret';
import { createCopyContent } from './copy-html';
import type { DiagnosticReporter } from './input-dispatcher';

/**
 * Returns the range that "Copy as HTML" copies. Does not change the tree or the selection.
 *
 * Returns the target selection if there is one, otherwise a new range that selects the whole contents of the editor
 * root. When the selection extends outside the editor root, or lies inside the comment popup or an action dialog, it
 * is not a target selection, so the whole body is used. While a cell range exists, the DOM selection is a caret at
 * the anchor, so the whole body is used as well. The whole body also goes through the same generation as in-editor
 * copy, so annotations and internal attributes are removed by the same rules.
 *
 * @param root The editor root.
 * @returns The range to copy.
 */
export function readCopyHtmlRange(root: Element): Range {
  const selected = readSelectionRange(root);
  if (selected !== undefined && !selected.collapsed) {
    return selected;
  }
  const whole = root.ownerDocument.createRange();
  whole.selectNodeContents(root);
  return whole;
}

/**
 * Creates the response to a request copy HTML message. Never throws.
 *
 * It is created by the same rules during an input stop and during IME composition. Copying changes neither the tree
 * nor the selection, so it does not touch the stopped editing and does not interrupt the composition.
 *
 * @param requestId The request id to put on the response, the same as the request's.
 * @param root The editor root. `undefined` if no body is displayed.
 * @param reportDiagnostic Diagnostic reporter for maintainers.
 * @returns A response carrying the HTML form, or that it could not be created (`null`).
 */
export function createCopyHtmlResponse(
  requestId: RequestId,
  root: Element | undefined,
  reportDiagnostic: DiagnosticReporter,
): CopyHtmlResponseMessage {
  return {
    type: VIEW_TO_HOST_MESSAGE_TYPE.copyHtmlResponse,
    requestId,
    html: root === undefined ? null : createCopyHtml(root, reportDiagnostic),
  };
}

/**
 * Creates the HTML form of the range to copy.
 *
 * The text form is not used. The clipboard API the host uses can only write strings, so the markup is passed as a
 * string as is.
 *
 * @param root The editor root.
 * @param reportDiagnostic Diagnostic reporter for maintainers.
 * @returns The HTML form, or `null` if it could not be created.
 */
function createCopyHtml(root: Element, reportDiagnostic: DiagnosticReporter): string | null {
  try {
    return createCopyContent(readCopyHtmlRange(root), root, reportDiagnostic)?.html ?? null;
  } catch (error) {
    reportDiagnostic(`Could not read the range to copy as HTML: ${String(error)}`);
    return null;
  }
}
