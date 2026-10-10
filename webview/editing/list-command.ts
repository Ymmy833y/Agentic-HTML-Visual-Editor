import type { BlockRewriteProgress } from './block-format';
import { readSelectionRange } from './caret';
import { createLists, switchListKind, unwrapItems } from './list-convert';
import { mergeCreatedLists } from './list-merge';
import { indentItems, outdentItems } from './list-nest';
import { decideListRewrite } from './list-target';
import type { ListOperation } from './list-target';

// The spellings of the operation kinds. Kept as a table so that forgetting one when a list operation is added
// fails type checking.
const LIST_OPERATION_KINDS: Readonly<Record<ListOperation['kind'], true>> = {
  toggleList: true,
  createList: true,
  indentList: true,
  outdentList: true,
};

/**
 * Tells the 4 list operations apart from the other block operations.
 *
 * @param operation The block operation.
 * @returns `true` when it is a list operation.
 */
export function isListOperation(operation: { readonly kind: string }): operation is ListOperation {
  return Object.hasOwn(LIST_OPERATION_KINDS, operation.kind);
}

/**
 * Calls the list rewrite that matches the decided mode.
 *
 * Exceptions from the rewrite are not caught here; they are left to the catch around the block operation.
 * Catching them here would keep a tree changed partway from being closed as an edit.
 *
 * @param operation The list operation.
 * @param targets The target blocks, as taken again after wrapping bare runs.
 * @param root The editor root.
 * @param progress The holder of whether the tree was changed.
 */
export function runListOperation(
  operation: ListOperation,
  targets: readonly Element[],
  root: Element,
  progress: BlockRewriteProgress,
): void {
  const range = readSelectionRange(root);
  if (range === undefined) {
    return;
  }

  const rewrite = decideListRewrite(operation, targets, range, root);
  switch (rewrite.mode) {
    case 'create':
      mergeCreatedLists(createLists(rewrite.blocks, rewrite.to, progress), progress);
      return;
    case 'switch':
      // No merging after switching the list kind. Merging would also change the kind of the neighbouring list
      // when the switch is reversed.
      // A switch moves the children by reference, so the lists collected inside stay in the tree after the list
      // around them is replaced.
      for (const list of rewrite.lists) {
        switchListKind(list, rewrite.to, progress);
      }
      return;
    case 'unwrap':
      unwrapItems(rewrite.items, progress);
      return;
    case 'indent':
      indentItems(rewrite.items, progress);
      return;
    case 'outdent':
      outdentItems(rewrite.items, progress);
      return;
    case 'none':
      return;
  }
}
