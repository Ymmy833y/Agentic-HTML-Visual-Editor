import { ALERT_STATE, readAlertState } from './alert-state';
import type { AlertState } from './alert-state';
import { readCurrentBlock } from './block-collect';
import { isConvertibleBlock, readBlockKind } from './block-format';
import type { BlockKind } from './block-format';
import { collectFormatTarget } from './format-segment';
import { readFormatState } from './format-state';
import type { FormatState } from './format-state';
import type { ListKind } from './list-structure';
import { readListKindAt } from './list-target';

/** The caret state for the current selection: the return values of each query gathered into one set as-is. */
export interface CaretState {
  /** Block kind of the block at the start. Undefined when it has no kind. */
  readonly blockKind: BlockKind | undefined;
  /** Whether the block at the start is a convertible block. */
  readonly convertible: boolean;
  /** Alert state of the block at the start. */
  readonly alert: AlertState;
  /** Whether each of the 5 formats is formatted. */
  readonly formats: FormatState;
  /** List kind of the owning item at the start. Undefined (none) when there is no owning item. */
  readonly listKind: ListKind | undefined;
}

/**
 * The caret state when there is no target. Also the initial state.
 *
 * The formats are taken from the query. Keeping a copy of the default spelling here as well
 * would leave one side stale when a format is added.
 */
export const NO_CARET_STATE: CaretState = {
  blockKind: undefined,
  convertible: false,
  alert: ALERT_STATE.none,
  formats: readFormatState({ kind: 'none' }),
  listKind: undefined,
};

/**
 * Calls the 4 queries for the current selection and gathers the results into one set.
 * Changes neither the tree nor the selection.
 *
 * The list kind is also taken from a query instead of inspecting the tree here. The pressed state then comes
 * from the same decision as the result of pressing the button, so the two never disagree.
 *
 * @param root The editor root.
 * @returns The caret state.
 */
export function readCaretState(root: Element): CaretState {
  const block = readCurrentBlock(root);
  return {
    blockKind: readBlockKind(block),
    convertible: block !== undefined && isConvertibleBlock(block),
    alert: readAlertState(block),
    // Images are counted too, so that the link item's pressed state matches the check for opening the link dialog in
    // the edit state. The four other formats are decided by the target text alone, so this option does not change them.
    formats: readFormatState(collectFormatTarget(root, true)),
    listKind: readListKindAt(root),
  };
}
