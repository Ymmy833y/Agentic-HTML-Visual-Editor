import { trimHref } from '../../common/index';
import type { Localizer } from '../../common/index';
import { hasDangerousScheme } from '../document/attribute-sanitizer';
import { readSelectionRange } from '../editing/caret';
import type { FormatOperation } from '../editing/format-command';
import { readLinkState } from '../editing/format-state';
import type { LinkState } from '../editing/format-state';
import { buildRequirementLabels } from './action-dialog';
import type { ActionDialogResult, ActionDialogSpec } from './action-dialog';

// The name of the URL input field. Also used to look up the input value in the result.
const URL_FIELD_NAME = 'url';

/**
 * The ports of the link dialog.
 *
 * They hold no values and are read on every call. The editing session changes with a document replacement,
 * and the input stop changes from moment to moment.
 */
export interface LinkDialogPorts {
  /** Returns the editor root. `undefined` before the mount. */
  readEditorRoot(): Element | undefined;

  /** Whether an IME composition is in progress at the time of the call. */
  isComposing(): boolean;

  /** Whether any input stop reason remains. */
  isInputStopped(): boolean;

  /**
   * Opens the action dialog and waits for the result.
   *
   * @param spec The action dialog spec.
   * @returns The result, resolved after the selection is returned.
   */
  openDialog(spec: ActionDialogSpec): Promise<ActionDialogResult>;

  /**
   * Runs a format operation with the command trigger. The callee owns the precondition checks and the edit attempt.
   *
   * @param operation The format operation.
   * @returns Whether the tree was changed.
   */
  runFormatCommand(operation: FormatOperation): boolean;

  /**
   * Inserts a link at a position without text.
   *
   * @param url The URL with surrounding whitespace removed.
   * @returns Whether the tree was changed.
   */
  insertLink(url: string): boolean;

  /** The localizer. */
  readonly localizer: Localizer;

  /** Leaves one diagnostic line for maintainers. Not used to notify the user. */
  reportDiagnostic(detail: string): void;
}

/**
 * Checks the preconditions for a link operation, opens the link dialog and applies the result.
 *
 * Whether the dialog opens in the edit state or the insert state is decided by the same query as the pressed state
 * (whether the link is formatted), so the remove action is there whenever the item looks pressed. Exceptions from
 * waiting for and applying the result are kept inside because the callers (the toolbar and the shortcut receiver)
 * call this without waiting for the result.
 *
 * @param ports The ports of the link dialog.
 * @returns Resolves once the result has been applied, or when nothing was done because a precondition was not
 *   met. An exception while waiting for or applying the result does not reject; it leaves one diagnostic line.
 */
export async function openLinkDialog(ports: LinkDialogPorts): Promise<void> {
  const root = ports.readEditorRoot();
  if (root === undefined || ports.isComposing() || ports.isInputStopped()) {
    return;
  }
  const range = readSelectionRange(root);
  // Nothing is inserted inside a pre, and existing links inside a pre are not changed from the dialog either.
  if (range === undefined || isInsideSamePre(range, root)) {
    return;
  }
  const state = readLinkState(root);
  if (!range.collapsed && !state.hasSegments) {
    // There is nothing to wrap, as in a range of only whitespace and line breaks.
    return;
  }

  try {
    const result = await ports.openDialog(buildLinkDialogSpec(state, ports.localizer));
    applyLinkDialogResult(ports, result);
  } catch (error) {
    ports.reportDiagnostic(`Could not apply the result of the link dialog: ${String(error)}`);
  }
}

/**
 * Builds the link dialog spec from the link state.
 *
 * The title and the confirm label differ between the insert state and the edit state. The initial value is the
 * href attribute value only when the selection fits inside one link. In a range that spans several links, which
 * link's value to use is undecided, so the value is empty.
 *
 * @param state The link state.
 * @param localizer The localizer.
 * @returns The action dialog spec.
 */
export function buildLinkDialogSpec(state: LinkState, localizer: Localizer): ActionDialogSpec {
  const editing = state.formatted;
  return {
    title: localizer.getMessage(editing ? 'linkDialog.editTitle' : 'linkDialog.insertTitle'),
    fields: [{
      name: URL_FIELD_NAME,
      label: localizer.getMessage('linkDialog.url'),
      initialValue: editing ? state.link?.getAttribute('href') ?? '' : '',
      required: true,
    }],
    requirementLabels: buildRequirementLabels(localizer),
    confirmLabel: localizer.getMessage(editing ? 'linkDialog.update' : 'linkDialog.insert'),
    cancelLabel: localizer.getMessage('linkDialog.cancel'),
    // A link can be removed only when it is formatted, so the action is not placed in the insert state.
    extraActionLabel: editing ? localizer.getMessage('linkDialog.remove') : undefined,
    validate: (values) => validateLinkUrl(values[URL_FIELD_NAME] ?? '', localizer),
  };
}

/**
 * Validates the input value of the dialog. Does not change the input value.
 *
 * What is judged is the very value that goes into the document (the value with surrounding whitespace removed).
 * Judging the value before removal would let `javascript:` preceded by a full-width space pass, and the dangerous
 * value after removal would go into the document. An href entered from the dialog does not go through rendering,
 * so the neutralization at render time does not apply to it either. The shape and encoding as a URL are not checked.
 *
 * @param value The input value.
 * @param localizer The localizer.
 * @returns The reason for rejection, or `undefined` if the value passes.
 */
export function validateLinkUrl(value: string, localizer: Localizer): string | undefined {
  const trimmed = trimHref(value);
  if (trimmed === '') {
    return localizer.getMessage('linkDialog.urlRequired');
  }
  if (hasDangerousScheme(trimmed)) {
    return localizer.getMessage('linkDialog.urlUnsafe');
  }
  return undefined;
}

/**
 * Applies the result of the dialog.
 *
 * A range, or a caret inside an existing link, passes the URL to the format command; a caret at a position without
 * text passes it to the insertion. Which one applies is decided by the selection at the time the result arrives.
 * The selection at the time of opening has already been returned when the dialog closed.
 *
 * @param ports The ports of the link dialog.
 * @param result The result of the dialog.
 */
export function applyLinkDialogResult(ports: LinkDialogPorts, result: ActionDialogResult): void {
  // Cancel (Esc, the cancel button, a replacement of the displayed tree) does nothing.
  if (!result.confirmed && !('extraAction' in result)) {
    return;
  }
  const root = ports.readEditorRoot();
  if (root === undefined) {
    return;
  }
  const range = readSelectionRange(root);
  if (range === undefined) {
    return;
  }

  if (!result.confirmed) {
    ports.runFormatCommand({ kind: 'unlink' });
    return;
  }
  // Insert the value trimmed by the same rule as the validation. Trimming differently would make the validated
  // value and the inserted value disagree.
  const url = trimHref(result.values[URL_FIELD_NAME] ?? '');
  if (!range.collapsed || readLinkState(root).link !== undefined) {
    ports.runFormatCommand({ kind: 'link', url });
    return;
  }
  ports.insertLink(url);
}

/**
 * Determines whether both ends of the selection are inside the same `pre`.
 *
 * @param range The selection range.
 * @param root The editor root.
 * @returns `true` if both ends are inside the same `pre`. For a caret, `true` if it is inside a `pre`.
 */
function isInsideSamePre(range: Range, root: Element): boolean {
  const start = findPre(range.startContainer, root);
  return start !== undefined && start === findPre(range.endContainer, root);
}

/**
 * Finds the innermost `pre` that contains the node.
 *
 * @param node The node to start searching from.
 * @param root The editor root. Nothing above it is searched.
 * @returns The `pre` found, or `undefined` if there is none.
 */
function findPre(node: Node, root: Element): Element | undefined {
  let current: Element | null = node instanceof Element ? node : node.parentElement;
  while (current !== null && current !== root) {
    if (current.localName === 'pre') {
      return current;
    }
    current = current.parentElement;
  }
  return undefined;
}
