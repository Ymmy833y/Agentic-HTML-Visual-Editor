// Defines the ports through which the editing core later receives registrations. Placed as a leaf
// with no dependency on any editing core module, to avoid a cycle between the registering side and the caller.

import type { NodeBoundary } from '../selection/selection-position';

/**
 * What a range delete keeps.
 *
 * Elements that keep themselves and lose only their content (titles, cells) cannot keep the whitespace between table skeleton elements, column definitions or closed
 * details bodies, so nodes that are kept whole and untouched are held separately. If both lists are empty, the range delete gives the same result as
 * when there is no guard.
 */
export interface RangeDeleteKeep {
  /** Elements that keep themselves and lose only their content. */
  readonly emptiedElements: readonly Element[];
  /** Nodes kept whole and untouched. */
  readonly keptNodes: readonly Node[];
}

/**
 * The guard a range delete calls.
 *
 * Returns what to keep from the range to delete. A returned list of elements is treated as a list of emptied elements (the guard protecting titles
 * can be used in that form as is). Called on the assumption that it changes neither the tree nor the selection and does not throw.
 *
 * @param range The range being deleted.
 * @param root The editor root.
 * @returns A list of emptied elements, or a range delete keep. Empty if there is nothing to protect.
 */
export type RangeDeleteGuard = (range: Range, root: Element) => readonly Element[] | RangeDeleteKeep;

/**
 * The hook a composition start calls.
 *
 * Besides adjusting the selection, it may place one text consisting of a single zero-width space (a composition placeholder) as the target for the composed characters.
 * Pass it to the port only after placing it and moving the caret there; it is then removed when composition ends, whether committed or not.
 * It is called on the assumption that it changes the tree in no other way and does not throw.
 *
 * @param root The editor root.
 * @param keepPlaceholder The port that records a placed composition placeholder as part of the pre-composition state. Preprocessors that place none need not accept it.
 */
export type CompositionStartHook = (root: Element, keepPlaceholder: (text: Text) => void) => void;

/**
 * The hook a composition end calls.
 *
 * Called after the composition placeholders have been removed and before the composition is reported as an edit or
 * abandoned, so that what a start hook built around a placeholder can be taken back out when nothing was committed.
 * It is called on the assumption that it does not throw.
 *
 * @param root The editor root.
 * @param committed Whether the composition committed text.
 */
export type CompositionEndHook = (root: Element, committed: boolean) => void;

/**
 * The result of a split preprocessor (split preparation).
 *
 * "Split" carries the boundary where the caller runs the start, end and middle checks and the split. "Taken over" means the
 * preprocessor already did the work instead of a split, and the caller does not split. A takeover carries whether the tree
 * changed and the boundary to continue the next input from. A takeover cut short by an exception has no boundary to continue from.
 */
export type SplitPreparation =
  | { readonly kind: 'split'; readonly boundary: NodeBoundary }
  | { readonly kind: 'takenOver'; readonly changed: boolean; readonly boundary: NodeBoundary | undefined };

/**
 * A preprocessor called before splitting a block.
 *
 * At a position where splitting would break an element inside the block (such as a comment annotation), it shifts the
 * position the checks run at, or takes over instead of the split. It is called on the assumption that any range selection
 * has already been deleted and the caret is inside the block being split and outside `pre`, and that it throws nothing.
 *
 * @param block The block to split.
 * @param caret The caret boundary.
 * @returns The boundary where the split happens, or that it took over.
 */
export type SplitPreprocessor = (block: Element, caret: NodeBoundary) => SplitPreparation;

/**
 * The container that carries the registered guards and hooks inside the editing core.
 *
 * Guards and hooks are registered separately by each structure feature, such as tables and details sections, so a later registration does not overwrite
 * an earlier one; they are held as lists in registration order. With empty lists, the editing core behaves as if there were no registration port.
 */
export interface EditingHooks {
  /** The guards the range delete calls in registration order. */
  readonly rangeDeleteGuards: RangeDeleteGuard[];
  /** The hooks a composition start calls in registration order. */
  readonly compositionStartHooks: CompositionStartHook[];
  /** The hooks a composition end calls in registration order. */
  readonly compositionEndHooks: CompositionEndHook[];
  /** Preprocessors called in registration order before a split. When empty, splitting behaves as if there were none. */
  readonly splitPreprocessors: SplitPreprocessor[];
}
