import type { Localizer } from '../../common/index';
import { findContainingDiagramSource, readDiagramSource } from '../diagram/diagram-source';
import { DIAGRAM_MARK_NAMESPACE, DIAGRAM_ZOOMED_MARK_NAME } from '../diagram/diagram-view';
import { buildRequirementLabels } from './action-dialog';
import type { ActionDialogResult, ActionDialogSpec } from './action-dialog';

// The name of the source field. Also used to look up the value in the result.
const SOURCE_FIELD_NAME = 'source';

// The mouse button a click on a diagram must use (the primary button).
const PRIMARY_BUTTON = 0;

/**
 * The ports of the diagram dialog.
 *
 * They hold no values and are read on every call. The editing session changes with a document replacement, and the
 * input stop changes from moment to moment.
 */
export interface DiagramDialogPorts {
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
   * Rewrites the source of a diagram. The callee owns the precondition checks and the edit attempt.
   *
   * @param block The diagram source block.
   * @param source The new source.
   * @returns Whether the tree was changed.
   */
  updateSource(block: Element, source: string): boolean;

  /**
   * Removes a diagram. The callee owns the precondition checks and the edit attempt.
   *
   * @param block The diagram source block.
   * @returns Whether the tree was changed.
   */
  removeDiagram(block: Element): boolean;

  /** The localizer. */
  readonly localizer: Localizer;

  /** Leaves one diagnostic line for maintainers. Not used to notify the user. */
  reportDiagnostic(detail: string): void;
}

/**
 * Opens the dialog of a diagram with its current source and applies the result: save rewrites the source, delete
 * removes the diagram, and cancel does nothing.
 *
 * Waiting for the result and exceptions from the edits are kept inside, because the callers (a click on the diagram
 * and the toolbar) call this and move on without waiting for the result.
 *
 * @param ports The ports of the diagram dialog.
 * @param block The diagram source block.
 * @returns Resolves once the result is applied, or once nothing is done because the preconditions are not met. It does
 *   not reject, and leaves one diagnostic line instead.
 */
export async function openDiagramDialog(ports: DiagramDialogPorts, block: Element): Promise<void> {
  const root = ports.readEditorRoot();
  if (root === undefined || ports.isComposing() || ports.isInputStopped() || !root.contains(block)) {
    return;
  }

  try {
    const current = readDiagramSource(block);
    const trailing = readTrailingWhitespace(current);
    const result = await ports.openDialog(
      buildDiagramDialogSpec(ports.localizer, current.slice(0, current.length - trailing.length)),
    );
    if (result.confirmed) {
      // The trailing whitespace the field does not show is put back, so that saving an untouched source leaves the
      // block as it was, line break before the closing tag included.
      ports.updateSource(block, `${readDialogSource(result.values)}${trailing}`);
    } else if ('extraAction' in result) {
      ports.removeDiagram(block);
    }
  } catch (error) {
    ports.reportDiagnostic(`Could not apply the result of the diagram dialog: ${String(error)}`);
  }
}

/**
 * Builds the spec of the diagram dialog: one multi-line source field, and the save, cancel and delete buttons.
 *
 * @param localizer The localizer.
 * @param source The current source, without its trailing whitespace.
 * @returns The action dialog spec.
 */
export function buildDiagramDialogSpec(localizer: Localizer, source: string): ActionDialogSpec {
  return {
    title: localizer.getMessage('diagramDialog.title'),
    fields: [
      {
        name: SOURCE_FIELD_NAME,
        label: localizer.getMessage('diagramDialog.source'),
        initialValue: source,
        multiline: true,
        required: true,
      },
    ],
    requirementLabels: buildRequirementLabels(localizer),
    confirmLabel: localizer.getMessage('diagramDialog.save'),
    cancelLabel: localizer.getMessage('diagramDialog.cancel'),
    extraActionLabel: localizer.getMessage('diagramDialog.delete'),
    // An empty diagram is not saved; the delete button is the way to remove it.
    validate: (values) =>
      readDialogSource(values) === '' ? localizer.getMessage('diagramDialog.sourceRequired') : undefined,
  };
}

/**
 * Reads the source from the dialog's values, without the trailing whitespace a text area tends to collect.
 *
 * Leading whitespace is kept, since the indentation of the first line can matter to Mermaid.
 *
 * @param values A map from field names to values. A missing field counts as empty.
 * @returns The source.
 */
export function readDialogSource(values: Readonly<Record<string, string>>): string {
  return (values[SOURCE_FIELD_NAME] ?? '').replace(/\s+$/u, '');
}

/**
 * Reads the whitespace at the end of a source, such as the line break before the closing tag.
 *
 * @param source The source.
 * @returns The trailing whitespace, or an empty string.
 */
function readTrailingWhitespace(source: string): string {
  return /\s*$/u.exec(source)?.[0] ?? '';
}

/**
 * Attaches to the editor root a click listener that calls an operation with the diagram clicked in it, and a press
 * listener that keeps the caret out of a zoomed diagram.
 *
 * Only a primary-button click without modifiers counts; a click with a modifier means something else, such as
 * extending the selection. Neither the default nor propagation is stopped, so the other listeners still see it. A press
 * on the scroll bar of a zoomed diagram fires no click, so it only scrolls.
 *
 * @param root The editor root. It stays the same element across document replacements, so call this only once, on
 *   the first mount.
 * @param open The operation to call with the clicked diagram source block.
 */
export function attachDiagramClick(root: HTMLElement, open: (block: Element) => void): void {
  root.addEventListener('click', (event) => {
    if (event.button !== PRIMARY_BUTTON || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      return;
    }
    const target = event.target;
    const block = target instanceof Node ? findContainingDiagramSource(target, root) : undefined;
    if (block !== undefined) {
      open(block);
    }
  });
  // A zoomed diagram is a visible block, so that it can scroll, and a press on it would put the caret into its source,
  // where typing does nothing. The press is kept from placing the caret; dragging its scroll bar still works.
  root.addEventListener('mousedown', (event) => {
    const target = event.target;
    const block = target instanceof Node ? findContainingDiagramSource(target, root) : undefined;
    if (block?.hasAttributeNS(DIAGRAM_MARK_NAMESPACE, DIAGRAM_ZOOMED_MARK_NAME) === true) {
      event.preventDefault();
    }
  });
}
