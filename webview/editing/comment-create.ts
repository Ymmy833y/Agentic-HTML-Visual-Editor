import { COMMENT_ATTRIBUTE, COMMENT_TAG_NAME } from '../../common/index';
import { INLINE_RUN_TAG_NAMES, findBlock, isHtmlWhitespaceOnly } from './block';
import type { BlockRewriteProgress } from './block-format';
import { readSelectionRange } from './caret';
import { createCommentId } from './comment-id';
import type { RandomFill } from './comment-id';
import { findCommentAt, findCommentsInRange } from './comment-read';
import { FORMAT_ELEMENT_TAG_NAMES } from './inline-format';
import { liftNodeBoundary, splitNodeAt } from './inline-wrap';

/**
 * The edit kind of comment creation.
 *
 * Spelled differently from typing and deletion, so history does not group it with the surrounding input and settles it on its own.
 */
export const COMMENT_EDIT_KIND = 'comment:create';

/**
 * Ports of the comment button.
 *
 * None of them holds a value; each is read on every call, because the editing session and the document boundary change
 * on document replacement.
 */
export interface CommentItemPorts {
  /** Returns the editor root. `undefined` before mounting. */
  readEditorRoot(): Element | undefined;

  /** Returns the comment the popup has open. `undefined` if none is open. */
  readOpenComment(): Element | undefined;

  /**
   * Opens the comment popup and moves focus into it.
   *
   * @param comment The comment to open.
   */
  openComment(comment: Element): void;

  /** The command path. Closes the edit attempt as completed only when the tree changed. */
  runCommandEdit(kind: string, command: () => boolean): boolean;

  /** Ensures a target block at the start of the current selection. */
  ensureTargetBlock(): Element | undefined;

  /** Returns the texts outside the body (the prologue and the epilogue). */
  readOutsideBodyTexts(): readonly string[];

  /**
   * Fills the given bytes with random values.
   *
   * @param bytes The bytes to fill.
   */
  fillRandom(bytes: Uint8Array<ArrayBuffer>): void;

  /** Leaves one diagnostic line for maintainers. Not used to notify users. */
  reportDiagnostic(detail: string): void;
}

/**
 * Where a comment is created.
 *
 * Inside a block, or in a bare run directly under the editor root. A bare run is first wrapped in a paragraph: for an
 * annotation not wrapped in a block, the shape of the tree after saving and reopening is not determined.
 */
export type CommentCreation = 'inBlock' | 'inBareRun';

/** How a range edge is lifted. Expresses the edge as just before or just after some node. */
interface LiftPoint {
  readonly node: Node;
  readonly side: 'before' | 'after';
}

/** The selection-dependent action, shared by activation and the disabled-state query. */
type CommentItemTarget =
  | { readonly kind: 'open'; readonly comment: Element }
  | { readonly kind: 'create'; readonly creation: CommentCreation };

/**
 * Returns whether the comment button can open a thread or create an annotation. Does not generate an ID or start an edit.
 *
 * @param ports The current editor root and open comment.
 * @returns Whether an action is available for the current selection.
 */
export function canRunCommentItem(ports: Pick<CommentItemPorts, 'readEditorRoot' | 'readOpenComment'>): boolean {
  const root = ports.readEditorRoot();
  return root !== undefined && readCommentItemTarget(root, ports.readOpenComment()) !== undefined;
}

/** Resolves the action in the same priority order for display and activation, without changing the tree or selection. */
function readCommentItemTarget(root: Element, open: Element | undefined): CommentItemTarget | undefined {
  if (open !== undefined) {
    return { kind: 'open', comment: open };
  }
  const range = readSelectionRange(root);
  if (range === undefined) {
    return undefined;
  }
  const existing = findCommentAt(range.startContainer, root, 'innermost');
  if (existing !== undefined) {
    return { kind: 'open', comment: existing };
  }
  const creation = readCommentCreation(root, range);
  return creation === undefined ? undefined : { kind: 'create', creation };
}

/**
 * The operation of the comment button. Opens an existing comment, or wraps the range in a new comment and then opens it.
 *
 * Creating inside a comment would nest it, so if the popup is open or the selection start is inside a comment, that
 * comment is opened instead of creating one. This also lets the keyboard reach an existing thread through the comment
 * button. Does nothing for a range where no comment can be created.
 * The input stop and composition checks are already done by the toolbar activation that calls this operation.
 *
 * @param ports The ports of the comment button.
 */
export function runCommentItem(ports: CommentItemPorts): void {
  const root = ports.readEditorRoot();
  if (root === undefined) {
    return;
  }

  const target = readCommentItemTarget(root, ports.readOpenComment());
  if (target === undefined) {
    return;
  }
  if (target.kind === 'open') {
    ports.openComment(target.comment);
    return;
  }

  // Create the ID before opening the attempt. Created later, a failure would open and close an attempt that changes nothing.
  const id = createCommentId(root, ports.readOutsideBodyTexts(), (bytes) => ports.fillRandom(bytes));
  if (id === undefined) {
    ports.reportDiagnostic('Did not create the comment because no non-overlapping comment ID could be created');
    return;
  }

  let created: Element | undefined;
  ports.runCommandEdit(COMMENT_EDIT_KIND, () => {
    const progress: BlockRewriteProgress = { changed: false };
    try {
      created = rewrite(ports, root, target.creation, id, progress);
    } catch (error) {
      // Throwing would close the attempt as aborted, and the changed tree would not reach the change tracker. Close what changed as completed.
      ports.reportDiagnostic(`Could not finish creating the comment: ${String(error)}`);
      created = undefined;
    }
    return progress.changed;
  });

  // Opening does not change the tree, so it happens outside the attempt after the creation edit is settled. Opening inside
  // the attempt would mix rendering failures and focus moves into whether the creation edit succeeded. If it ended with an
  // exception, the half-made comment is not opened.
  if (created !== undefined) {
    ports.openComment(created);
  }
}

/**
 * Checks whether a comment can be created over the range and returns where. Changes neither the tree nor the selection.
 *
 * The created comment is not nested, does not wrap blocks, and has visible content. Elements on the edges are limited, as
 * for formats, to those that can be split (format elements and `span`). Splitting elements the extension does not know
 * would break the writer's intent.
 *
 * @param root The editor root.
 * @param range The range.
 * @returns Where it is created. `undefined` if it cannot be created.
 */
export function readCommentCreation(root: Element, range: Range): CommentCreation | undefined {
  if (range.collapsed) {
    return undefined;
  }
  const creation = readCreationPlace(root, range);
  if (creation === undefined) {
    return undefined;
  }

  const parent = readCommonParent(range);
  // Ancestors are outside the common parent's subtree. Check them separately so a small selection does not scan
  // every comment in the document, while still rejecting ranges inside an existing annotation.
  if (parent === undefined) {
    return undefined;
  }
  for (let ancestor: Element | null = parent; ancestor !== null && ancestor !== root; ancestor = ancestor.parentElement) {
    if (ancestor.localName === COMMENT_TAG_NAME.comment) {
      return undefined;
    }
  }
  if (!hasOnlyPhrasingContent(range, parent)
    || findCommentsInRange(parent, range).length > 0) {
    return undefined;
  }

  const contents = range.cloneContents();
  if (isHtmlWhitespaceOnly(contents.textContent ?? '') && contents.querySelector('img') === null) {
    return undefined;
  }

  if (!hasSplittableEdge(range.startContainer, parent) || !hasSplittableEdge(range.endContainer, parent)) {
    return undefined;
  }
  return creation;
}

/**
 * Wraps the contents of the range in a new comment and selects those contents.
 *
 * Lifts both range edges to directly under the common parent, splitting the format elements in between at the edges.
 * Wrapping the edge elements whole would make the annotated text wider than the selection. Attributes of a split element
 * other than `id` are copied to both sides. The children in between are moved by reference, not copied. Exceptions are not
 * caught; they are left to the caller.
 *
 * @param range The range.
 * @param id The ID of the new comment.
 * @param progress Holder for whether the tree changed. Set to true when splitting of the edges begins.
 * @returns The new comment. It has only the `id` attribute and no entries.
 */
export function wrapRangeInComment(range: Range, id: string, progress: BlockRewriteProgress): Element {
  const parent = readCommonParent(range);
  if (parent === undefined) {
    throw new Error('The common parent of the range is not an element');
  }
  const comment = parent.ownerDocument.createElement(COMMENT_TAG_NAME.comment);
  comment.setAttribute(COMMENT_ATTRIBUTE.id, id);

  const { startContainer, startOffset, endContainer, endOffset } = range;
  progress.changed = true;
  // Split the end first. Splitting the start first would shift the end position within the same text.
  const end = resolveEndPoint(endContainer, endOffset);
  const endReference = parent.childNodes.item(liftNodeBoundary(parent, end.node, end.side));
  const start = resolveStartPoint(startContainer, startOffset);
  const startReference = parent.childNodes.item(liftNodeBoundary(parent, start.node, start.side));

  parent.insertBefore(comment, startReference);
  for (let node = comment.nextSibling; node !== null && node !== endReference; node = comment.nextSibling) {
    comment.append(node);
  }

  const selection = parent.ownerDocument.defaultView?.getSelection();
  if (selection !== null && selection !== undefined) {
    const contents = parent.ownerDocument.createRange();
    contents.selectNodeContents(comment);
    selection.removeAllRanges();
    selection.addRange(contents);
  }
  return comment;
}

/**
 * The rewrite inside the attempt. For a bare run, wraps it in a paragraph first, then wraps the range in a comment.
 *
 * @param ports The ports of the comment button.
 * @param root The editor root.
 * @param creation Where the comment is created.
 * @param id The ID of the new comment.
 * @param progress Holder for whether the tree changed.
 * @returns The new comment. `undefined` if the range cannot be read again.
 */
function rewrite(
  ports: CommentItemPorts,
  root: Element,
  creation: CommentCreation,
  id: string,
  progress: BlockRewriteProgress,
): Element | undefined {
  if (creation === 'inBareRun') {
    if (ports.ensureTargetBlock() === undefined) {
      return undefined;
    }
    progress.changed = true;
  }
  // Wrapping in a paragraph moves nodes, which can shift the positions the original range points at. Read the range again
  // after ensuring the block has restored the selection.
  const range = readSelectionRange(root);
  if (range === undefined || range.collapsed) {
    return undefined;
  }
  return wrapRangeInComment(range, id, progress);
}

/**
 * Returns where the comment is created, from where the two range edges are.
 *
 * @param root The editor root.
 * @param range The range.
 * @returns `inBlock` if both edges are in the same block, `inBareRun` if they are in the same bare run directly under the editor root, otherwise `undefined`.
 */
function readCreationPlace(root: Element, range: Range): CommentCreation | undefined {
  const startBlock = findBlock(range.startContainer, root);
  const endBlock = findBlock(range.endContainer, root);
  if (startBlock !== undefined || endBlock !== undefined) {
    return startBlock === endBlock ? 'inBlock' : undefined;
  }

  const first = readRootChild(root, range.startContainer, range.startOffset, 'start');
  const last = readRootChild(root, range.endContainer, range.endOffset, 'end');
  for (let node: Node | null = first; node !== null && isRunMember(node); node = node.nextSibling) {
    if (node === last) {
      return 'inBareRun';
    }
  }
  return undefined;
}

/**
 * Returns the child directly under the editor root that contains the edge.
 *
 * @param root The editor root.
 * @param container The container of the edge.
 * @param offset The offset of the edge.
 * @param side Whether it is the start or the end. If the container is the editor root itself, the start returns the child just after the offset and the end the child just before it.
 * @returns The child directly under the editor root. `null` if there is none.
 */
function readRootChild(root: Element, container: Node, offset: number, side: 'start' | 'end'): Node | null {
  if (container === root) {
    return root.childNodes.item(side === 'start' ? offset : offset - 1);
  }
  let child: Node = container;
  for (let parent = child.parentNode; parent !== null && parent !== root; parent = parent.parentNode) {
    child = parent;
  }
  return child.parentNode === root ? child : null;
}

/**
 * Returns whether the node belongs in a bare run.
 *
 * @param node The node to check.
 * @returns `true` for text or a phrasing content element.
 */
function isRunMember(node: Node): boolean {
  return node instanceof Text || (node instanceof Element && INLINE_RUN_TAG_NAMES.has(node.localName));
}

/**
 * Returns the common parent element of the range. If the common ancestor is text, its parent.
 *
 * @param range The range.
 * @returns The common parent. `undefined` if it is not an element.
 */
function readCommonParent(range: Range): Element | undefined {
  const container = range.commonAncestorContainer;
  if (container instanceof Element) {
    return container;
  }
  return container.parentElement ?? undefined;
}

/**
 * Returns whether the elements intersecting the range are all phrasing content elements other than comments.
 *
 * Wrapping a range containing a block element would make the comment contain a block. Wrapping a range containing a comment would nest it.
 *
 * @param range The range.
 * @param parent The common parent of the range. Only elements below it are checked.
 * @returns `true` if they are all phrasing content elements other than comments.
 */
function hasOnlyPhrasingContent(range: Range, parent: Element): boolean {
  for (const element of parent.querySelectorAll('*')) {
    if (!range.intersectsNode(element)) {
      continue;
    }
    if (element.localName === COMMENT_TAG_NAME.comment || !INLINE_RUN_TAG_NAMES.has(element.localName)) {
      return false;
    }
  }
  return true;
}

/**
 * Returns whether every element from the edge up to the common parent may be split at the edge.
 *
 * @param container The container of the edge.
 * @param parent The common parent of the range.
 * @returns `true` if they are only format elements or `span`. A `code` directly under `pre` is the container of the contents and is not split.
 */
function hasSplittableEdge(container: Node, parent: Element): boolean {
  for (
    let current: Element | null = container instanceof Element ? container : container.parentElement;
    current !== null && current !== parent;
    current = current.parentElement
  ) {
    const splittable = (FORMAT_ELEMENT_TAG_NAMES.has(current.localName) || current.localName === 'span')
      && !(current.localName === 'code' && current.parentElement?.localName === 'pre');
    if (!splittable) {
      return false;
    }
  }
  return true;
}

/**
 * Expresses the end as just after (or just before) some node. Text in the middle is split at the end.
 *
 * @param container The container of the end.
 * @param offset The offset of the end.
 * @returns How the end is lifted.
 */
function resolveEndPoint(container: Node, offset: number): LiftPoint {
  if (container instanceof Text) {
    if (offset <= 0) {
      return { node: container, side: 'before' };
    }
    splitNodeAt(container, offset);
    return { node: container, side: 'after' };
  }
  const previous = offset > 0 ? container.childNodes.item(offset - 1) : null;
  if (previous !== null) {
    return { node: previous, side: 'after' };
  }
  const first = container.firstChild;
  if (first !== null) {
    return { node: first, side: 'before' };
  }
  // An end inside an empty element counts as just before that element. It has no contents, so the selected text is the same without wrapping it.
  return { node: container, side: 'before' };
}

/**
 * Expresses the start as just before (or just after) some node. Text in the middle is split at the start.
 *
 * @param container The container of the start.
 * @param offset The offset of the start.
 * @returns How the start is lifted.
 */
function resolveStartPoint(container: Node, offset: number): LiftPoint {
  if (container instanceof Text) {
    if (offset >= container.data.length) {
      return { node: container, side: 'after' };
    }
    return { node: splitNodeAt(container, offset) ?? container, side: 'before' };
  }
  const next = container.childNodes.item(offset);
  if (next !== null) {
    return { node: next, side: 'before' };
  }
  const last = container.lastChild;
  if (last !== null) {
    return { node: last, side: 'after' };
  }
  // A start inside an empty element counts as just after that element. It has no contents, so the selected text is the same without wrapping it.
  return { node: container, side: 'after' };
}
