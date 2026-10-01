import { COMMENT_TAG_NAME } from '../../common/index';
import { isConvertibleBlock } from './block-format';
import { readSelectionRange } from './caret';
import { OWNING_ITEM_STOP_TAG_NAMES, findOwningItem, readListKind } from './list-structure';
import type { ListKind } from './list-structure';

/**
 * A list operation. One of 4: toggle, create (each with a list kind), indent, and outdent.
 *
 * Every trigger (buttons, keys, markers, and the Enter and backward delete rules) calls this same operation.
 * Making a separate operation per trigger would let an operation that looks the same give different results
 * depending on the path.
 */
export type ListOperation =
  | { readonly kind: 'toggleList'; readonly to: ListKind }
  | { readonly kind: 'createList'; readonly to: ListKind }
  | { readonly kind: 'indentList' }
  | { readonly kind: 'outdentList' };

/** The decided mode and its targets. A value for a single operation only; it is not held across calls. */
export type ListRewrite =
  | { readonly mode: 'create'; readonly blocks: readonly Element[]; readonly to: ListKind }
  | { readonly mode: 'switch'; readonly lists: readonly Element[]; readonly to: ListKind }
  | { readonly mode: 'unwrap'; readonly items: readonly Element[] }
  | { readonly mode: 'indent'; readonly items: readonly Element[] }
  | { readonly mode: 'outdent'; readonly items: readonly Element[] }
  | { readonly mode: 'none' };

// Listable blocks. Turning a code block into an item would lose the `pre` and break the newlines in its content.
const LISTABLE_TAG_NAMES: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'div',
  'blockquote',
]);

// Blocks turned into items when the range spans several blocks. A blockquote that the range merely passes
// through is left in place as structure.
const SPANNED_LISTABLE_TAG_NAMES: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'div',
]);

// Element names of entries (body and replies). They are shown only in the popup, not in the document flow, so a
// range over a comment never visibly covers a list inside them.
const ENTRY_TAG_NAMES: ReadonlySet<string> = new Set([COMMENT_TAG_NAME.body, COMMENT_TAG_NAME.reply]);

/**
 * Decides the mode and its targets from the operation and the selection. Changes neither the tree nor the
 * selection.
 *
 * The direction of a toggle is decided only by the owning item at the start of the selection. The pressed state
 * is decided by the same item, so the pressed state and the result of pressing never disagree in direction.
 *
 * @param operation The list operation.
 * @param targets The target blocks. Bare runs are already wrapped, and an effectively empty root is already
 *   materialized.
 * @param range The selection range.
 * @param root The editor root.
 * @returns The mode and its targets, or no target when there is not a single target.
 */
export function decideListRewrite(
  operation: ListOperation,
  targets: readonly Element[],
  range: Range,
  root: Element,
): ListRewrite {
  // Create is called from markers. It creates without looking at the owning item, so the result never disagrees
  // with the marker typed.
  if (operation.kind === 'createList') {
    return decideCreation(targets, range, operation.to);
  }

  const owning = findOwningItem(range.startContainer, root);
  if (operation.kind === 'toggleList') {
    const list = owning?.parentElement;
    if (owning === undefined || list === null || list === undefined) {
      return decideCreation(targets, range, operation.to);
    }
    if (readListKind(list) === operation.to) {
      return { mode: 'unwrap', items: collectTargetItems(owning, range) };
    }
    return { mode: 'switch', lists: collectListsToSwitch(list, range), to: operation.to };
  }

  if (owning === undefined) {
    return { mode: 'none' };
  }
  const items = collectTargetItems(owning, range);
  return operation.kind === 'indentList' ? { mode: 'indent', items } : { mode: 'outdent', items };
}

/**
 * Returns the consecutive items directly under the same list, from the owning item to the end point.
 *
 * The items the range covers are moved together, so the result never disagrees with how the range looks.
 *
 * @param owning The owning item.
 * @param range The selection range.
 * @returns The target items: only the owning item when the end point is inside it, up to the last item when the
 *   end point is after the list, and up to a later item when the end point is inside that item's nested list.
 */
export function collectTargetItems(owning: Element, range: Range): Element[] {
  const items = [owning];
  if (owning.contains(range.endContainer)) {
    return items;
  }

  for (let node = owning.nextSibling; node !== null; node = node.nextSibling) {
    if (!(node instanceof Element) || node.localName !== 'li') {
      continue;
    }
    // When the start of the item is after the end point, the range does not reach that item.
    if (range.comparePoint(node, 0) > 0) {
      break;
    }
    items.push(node);
  }
  return items;
}

/**
 * Returns the lists to switch: the owning item's list, followed by the lists inside it that the range overlaps.
 *
 * Switching over a selection would otherwise leave the selected nested lists in their old kind, so the result
 * would not match what was selected. A caret alone switches only the owning item's list, which keeps a nested
 * list of another kind as it is. Lists beyond a cell or collapsible section are left alone, since those are
 * edited on their own; the owning item is not looked for beyond them either. Lists inside the entries of a comment
 * are left alone too.
 *
 * @param list The owning item's list.
 * @param range The selection range.
 * @returns The lists to switch: the owning item's list first, then the overlapping lists in document order.
 */
export function collectListsToSwitch(list: Element, range: Range): Element[] {
  const lists = [list];
  if (range.collapsed) {
    return lists;
  }

  // Overlap is judged the same way as for the target blocks of a block operation. A subtree the range does not
  // overlap holds no list it overlaps, so the walk skips it just like a cell, collapsible section or entry.
  const walker = list.ownerDocument.createTreeWalker(list, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => (
      node instanceof Element
        && !OWNING_ITEM_STOP_TAG_NAMES.has(node.localName)
        && !ENTRY_TAG_NAMES.has(node.localName)
        && range.intersectsNode(node)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT
    ),
  });
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Element && readListKind(node) !== undefined) {
      lists.push(node);
    }
  }
  return lists;
}

/**
 * Picks the creation blocks from the target blocks.
 *
 * A table, blockquote or collapsible section that the range merely passes through is left in place with its
 * content. Turning the inside of a spanned structure into items would change that structure's content.
 *
 * @param targets The target blocks.
 * @param range The selection range.
 * @returns The creation blocks, in document order. With a single target block, that block only when it is a
 *   listable block. With two or more, only the convertible paragraphs, headings and `div` elements directly under
 *   the range parent.
 */
export function collectCreationBlocks(targets: readonly Element[], range: Range): Element[] {
  if (targets.length <= 1) {
    return targets.filter((target) => isListableBlock(target));
  }

  const ancestor = range.commonAncestorContainer;
  const parent = ancestor instanceof Element ? ancestor : ancestor.parentElement;
  return targets.filter((target) => target.parentElement === parent
    && SPANNED_LISTABLE_TAG_NAMES.has(target.localName)
    && isConvertibleBlock(target));
}

/**
 * Returns the list kind of the owning item at the start, without wrapping or ensuring anything. Changes neither
 * the tree nor the selection.
 *
 * @param root The editor root.
 * @returns The list kind, or `undefined` when there is no selection, the selection is outside the editor root,
 *   or there is no owning item.
 */
export function readListKindAt(root: Element): ListKind | undefined {
  const range = readSelectionRange(root);
  if (range === undefined) {
    return undefined;
  }
  const list = findOwningItem(range.startContainer, root)?.parentElement;
  return list === null || list === undefined ? undefined : readListKind(list);
}

/**
 * Determines whether a block is a listable block.
 *
 * @param block The block to check.
 * @returns `true` only for a convertible block that is a paragraph, heading, `div` or blockquote.
 */
export function isListableBlock(block: Element): boolean {
  return LISTABLE_TAG_NAMES.has(block.localName) && isConvertibleBlock(block);
}

/**
 * Decides the create mode.
 *
 * @param targets The target blocks.
 * @param range The selection range.
 * @param to The target list kind.
 * @returns The create mode, or no target when there are no creation blocks.
 */
function decideCreation(targets: readonly Element[], range: Range, to: ListKind): ListRewrite {
  const blocks = collectCreationBlocks(targets, range);
  return blocks.length === 0 ? { mode: 'none' } : { mode: 'create', blocks, to };
}
