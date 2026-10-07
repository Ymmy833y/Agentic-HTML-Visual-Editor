import { CHANGE_ATTRIBUTE, CHANGE_AUTHOR, CHANGE_KIND, COMMENT_TAG_NAME } from '../../common/index';
import type { ChangeKind, CommentAuthor } from '../../common/index';
import { isHtmlWhitespaceOnly } from './block';

// Element names of comment entries. A mark inside one is not shown in the document flow, so it is neither listed nor
// opened.
const ENTRY_TAG_NAMES: ReadonlySet<string> = new Set([COMMENT_TAG_NAME.body, COMMENT_TAG_NAME.reply]);

// The kinds, which are also the element names of the inline marks.
const KIND_VALUES: ReadonlySet<string> = new Set(Object.values(CHANGE_KIND));

// Element names of the comment annotation. The author and the time of an entry are the entry's own, and the annotated
// text of a comment is not what an agent added, so none of them is read as a mark whatever attribute it carries.
const COMMENT_ELEMENT_NAMES: ReadonlySet<string> = new Set(Object.values(COMMENT_TAG_NAME));

// Selects every mark: the inline elements, and the elements that carry a kind in the attribute.
const CHANGE_SELECTOR = Object.values(CHANGE_KIND)
  .flatMap((kind) => [kind, `[${CHANGE_ATTRIBUTE.kind}="${kind}"]`])
  .join(', ');

/** The kind under which a replacement pair is listed and shown. It is never written to the document. */
export const REPLACEMENT_KIND = 'replacement';

/** The kind of one entry of the list or the popup: a mark's own kind, or a replacement pair. */
export type ChangeUnitKind = ChangeKind | typeof REPLACEMENT_KIND;

/**
 * Returns the kind of a change mark.
 *
 * An inline mark is decided by its element name, every other element but the comment annotation by the kind
 * attribute. Any other value of the attribute does not make a mark, so that a document is not resolved by a spelling
 * the editor does not write.
 *
 * @param node The node to check.
 * @returns The kind. `undefined` when the node is not a change mark.
 */
export function readChangeKind(node: Node): ChangeKind | undefined {
  if (!(node instanceof Element)) {
    return undefined;
  }
  const name = node.localName;
  if (name === CHANGE_KIND.insertion || name === CHANGE_KIND.deletion) {
    return name;
  }
  if (COMMENT_ELEMENT_NAMES.has(name)) {
    return undefined;
  }
  const value = node.getAttribute(CHANGE_ATTRIBUTE.kind);
  return value === CHANGE_KIND.insertion || value === CHANGE_KIND.deletion ? value : undefined;
}

/**
 * Returns whether a change mark is an inline one (`ins` or `del`), as opposed to an element that carries the kind
 * attribute.
 *
 * @param change The change mark.
 */
export function isInlineChange(change: Element): boolean {
  return KIND_VALUES.has(change.localName);
}

/**
 * Finds the nearest change mark around a position. Changes neither the tree nor the selection.
 *
 * The climb stops at an entry: a position reached through one is not over the mark in the document flow.
 *
 * @param node The node of the position. If it is a mark itself, it is the one found.
 * @param root The editor root. The root itself and marks outside it are not counted.
 * @returns The mark. `undefined` for a node outside the root or a position outside any mark.
 */
export function findChangeAt(node: Node, root: Element): Element | undefined {
  if (node === root || !root.contains(node)) {
    return undefined;
  }
  for (
    let current: Element | null = node instanceof Element ? node : node.parentElement;
    current !== null && current !== root;
    current = current.parentElement
  ) {
    if (ENTRY_TAG_NAMES.has(current.localName)) {
      return undefined;
    }
    if (readChangeKind(current) !== undefined) {
      return current;
    }
  }
  return undefined;
}

/**
 * Returns every change mark of the editor root in the document order of their start tags. Does not change the tree.
 *
 * Nested marks count one each. Marks inside entries are left out, as are the elements the selector matches that are
 * not marks.
 *
 * @param root The editor root.
 * @returns The marks.
 */
export function readChanges(root: Element): Element[] {
  return [...root.querySelectorAll(CHANGE_SELECTOR)].filter(
    (element) => readChangeKind(element) !== undefined && !isInsideEntry(element, root),
  );
}

/**
 * Returns whether the mark is in the tree of the editor root.
 *
 * @param root The editor root.
 * @param change The change mark.
 * @returns `true` only when it is connected to the document and contained in the editor root.
 */
export function isChangeInTree(root: Element, change: Element): boolean {
  return change.isConnected && root.contains(change);
}

/**
 * Returns the side of the author of a change mark.
 *
 * Only an author exactly equal to `ai` counts as the AI side, as for comment entries; other values and a missing author
 * count as the human side.
 *
 * @param change The change mark.
 */
export function readChangeAuthor(change: Element): CommentAuthor {
  return change.getAttribute(CHANGE_ATTRIBUTE.author) === CHANGE_AUTHOR.ai ? CHANGE_AUTHOR.ai : CHANGE_AUTHOR.human;
}

/**
 * Returns whether an element sits inside an entry.
 *
 * @param element The element to check.
 * @param root The editor root. Ancestors outside it are not looked at.
 * @returns `true` when an ancestor below the editor root is a body or a reply.
 */
export function isInsideEntry(element: Element, root: Element): boolean {
  for (let current = element.parentElement; current !== null && current !== root; current = current.parentElement) {
    if (ENTRY_TAG_NAMES.has(current.localName)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns the other mark of the replacement pair that a mark belongs to.
 *
 * A deletion followed at once by an insertion from the same author side is one replacement: the reader takes in "this
 * for that" and decides it once, where deciding the halves apart would either lose the text or keep both. Only HTML
 * whitespace may lie between the two, such as the line breaks and indentation an agent writes between two block-level
 * marks; an NBSP has width, so it keeps them apart like any other text. An inline mark pairs with an inline mark, an
 * element with an element, so that a phrase and a block never become one decision.
 *
 * @param change The change mark.
 * @returns The insertion after a deletion, or the deletion before an insertion. `undefined` when there is no pair.
 */
export function readReplacementPartner(change: Element): Element | undefined {
  const kind = readChangeKind(change);
  if (kind === undefined) {
    return undefined;
  }
  const forward = kind === CHANGE_KIND.deletion;
  const partner = readAdjacentElement(change, forward);
  if (partner === undefined || readChangeKind(partner) !== (forward ? CHANGE_KIND.insertion : CHANGE_KIND.deletion)) {
    return undefined;
  }
  if (isInlineChange(partner) !== isInlineChange(change) || readChangeAuthor(partner) !== readChangeAuthor(change)) {
    return undefined;
  }
  return partner;
}

/**
 * Returns the mark that stands for a change in the popup, the list and a decision: the deletion of a replacement pair,
 * or the mark itself when it belongs to none.
 *
 * @param change The change mark.
 */
export function readChangeHead(change: Element): Element {
  const partner = readReplacementPartner(change);
  return partner !== undefined && readChangeKind(change) === CHANGE_KIND.insertion ? partner : change;
}

/**
 * Returns the element next to a node in one direction, passing over text of HTML whitespace alone and nothing else.
 *
 * @param node The node to start from.
 * @param forward Whether to look after the node rather than before it.
 */
function readAdjacentElement(node: Node, forward: boolean): Element | undefined {
  for (
    let sibling = forward ? node.nextSibling : node.previousSibling;
    sibling !== null;
    sibling = forward ? sibling.nextSibling : sibling.previousSibling
  ) {
    if (sibling instanceof Element) {
      return sibling;
    }
    if (!(sibling instanceof Text) || !isHtmlWhitespaceOnly(sibling.data)) {
      return undefined;
    }
  }
  return undefined;
}
