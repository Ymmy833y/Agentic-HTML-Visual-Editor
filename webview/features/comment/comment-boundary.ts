// Caret behavior at the boundaries of an inline <comment>: Enter, the
// horizontal arrows, typed characters, and the transient caret-colour markers.
//
// A comment's target text is editable while its <comment-body>/<comment-reply>
// are display:none and contenteditable=false, so the inside-edge and the
// just-outside positions render at the same spot and the browser resolves them
// however it likes. Every handler here exists to make that choice explicit
// instead: which side of the boundary the next keystroke lands on.
//
// This is the same feature as comment-deletion (deletion at those boundaries)
// and shares its DOM vocabulary through comment-dom, so a rule about what
// counts as "the visible edge of a comment" is stated once, in one directory.
// editor-core owns the beforeinput/keydown routing and calls in here.

import { CARET_INSIDE_ATTR, CARET_OUTSIDE_ATTR } from '../../shared/constants';
import {
  findAncestor,
  findBlockAncestor,
  isInsignificantTail,
  nodeImmediatelyAfterCaret,
  nodeImmediatelyBeforeCaret,
} from '../../shared/dom-utils';
import { firstNonEmptyTargetText, lastNonEmptyTargetText } from './comment-dom';

/**
 * Insert a soft line break in a bare blockquote. Passed in by editor-core
 * rather than imported, because it belongs to the blockquote Enter behavior
 * that lives there — naming it here would make this feature module import the
 * core that imports it.
 */
export type InsertQuoteBreak = (
  range: Range,
  root: HTMLElement,
  selection: Selection,
) => boolean;

/**
 * Keep an inline <comment> whole when Enter splits its block. The comment's
 * target text is editable, but its `contenteditable="false"` <comment-body>
 * makes the browser's default paragraph split cut through the comment when the
 * caret sits inside it — corrupting the body and duplicating the comment id.
 * (Relocating the caret and deferring to the default does not help: Chromium
 * splits using the selection as it was before the event, ignoring the change.)
 *
 * So we split the block ourselves at the boundary just AFTER the whole comment:
 * the comment (and everything before it) stays on the current line, and only
 * the content after the comment moves into a fresh sibling block. Returns
 * whether the split was performed (i.e. the caret was inside a comment).
 */
export function keepCommentWholeOnEnter(
  root: HTMLElement,
  insertQuoteBreak: InsertQuoteBreak,
): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return false;

  const comment = findAncestor(range.startContainer, 'COMMENT', root);
  if (!comment) return false;
  const block = findBlockAncestor(comment, root);
  if (!block) return false;

  if (block.tagName === 'BLOCKQUOTE') {
    const safeRange = document.createRange();
    safeRange.setStartAfter(comment);
    safeRange.collapse(true);
    return insertQuoteBreak(safeRange, root, selection);
  }

  // Extract everything after the comment up to the block end. extractContents
  // splits any inline-format wrappers between the comment and the block, so a
  // nested comment (e.g. inside <strong>) is handled correctly.
  const tailRange = document.createRange();
  tailRange.setStartAfter(comment);
  tailRange.setEnd(block, block.childNodes.length);
  const tail = tailRange.extractContents();

  const newBlock = document.createElement(block.tagName.toLowerCase());
  newBlock.appendChild(tail);
  if (newBlock.childNodes.length === 0) {
    newBlock.appendChild(document.createElement('br'));
  }
  block.after(newBlock);

  const newRange = document.createRange();
  newRange.setStart(newBlock, 0);
  newRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(newRange);
  return true;
}

/** Per-editor comment-boundary state (see the `boundary` closure var). */
export interface BoundaryState {
  pendingInside: Element | null;
}

/**
 * ArrowRight near an inline comment: at the visible trailing edge (inside) it
 * steps the caret just past </comment> so the next character lands outside; when
 * the caret sits just before a comment (outside) it arms a "type inside" intent
 * for that comment's leading edge. The leading inside-start caret cannot be kept
 * (the browser normalises it back outside), so we do NOT move the caret there;
 * instead the next typed character is routed into the target start (see
 * {@link handleBoundaryInsert}) and the caret colour flips via the marker.
 * Returns whether the key was handled.
 */
export function handleCommentArrowRight(root: HTMLElement, boundary: BoundaryState): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.startContainer)) return false;

  // Inside the trailing edge -> step out, just past the comment.
  const trailing = caretAtCommentTrailingEdge(range, root);
  if (trailing) {
    boundary.pendingInside = null;
    placeCaret(selection, (r) => r.setStartAfter(trailing));
    syncCaretMarkers(root, boundary);
    return true;
  }
  // Just before a comment (outside) -> arm "type inside" for its leading edge.
  const ahead = commentJustAfterCaret(root);
  if (ahead) {
    boundary.pendingInside = ahead;
    syncCaretMarkers(root, boundary); // tint the caret author-colour immediately
    return true; // caret stays put (the inside position cannot be represented)
  }
  return false;
}

/**
 * ArrowLeft near an inline comment: cancels a pending leading-edge inside intent
 * (stay outside); else when the caret sits just after a comment (outside) it
 * re-enters at the target end; else at the visible leading edge (inside) it steps
 * the caret just before <comment>. The mirror of {@link handleCommentArrowRight}.
 * Returns whether the key was handled.
 */
export function handleCommentArrowLeft(root: HTMLElement, boundary: BoundaryState): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.startContainer)) return false;

  // Cancel a pending "type inside" intent: step back out (caret stays put).
  if (boundary.pendingInside && commentJustAfterCaret(root) === boundary.pendingInside) {
    boundary.pendingInside = null;
    syncCaretMarkers(root, boundary);
    return true;
  }
  // Just after a comment (outside) -> step in, to the target end.
  const behind = commentJustBeforeCaret(root);
  if (behind) {
    const target = lastNonEmptyTargetText(behind);
    placeCaret(selection, (r) =>
      target ? r.setStart(target, target.data.length) : r.setStart(behind, 0),
    );
    syncCaretMarkers(root, boundary);
    return true;
  }
  // Inside the leading edge -> step out, just before the comment.
  const leading = caretAtCommentLeadingEdge(range, root);
  if (leading) {
    placeCaret(selection, (r) => r.setStartBefore(leading));
    syncCaretMarkers(root, boundary);
    return true;
  }
  return false;
}

/** Collapse a fresh range configured by `place` and make it the selection. */
function placeCaret(selection: Selection, place: (r: Range) => void): void {
  const r = document.createRange();
  place(r);
  r.collapse(true);
  selection.removeAllRanges();
  selection.addRange(r);
}

/**
 * Route a typed character at a comment boundary. First honours a pending
 * leading-edge "type inside" intent (ArrowRight) by inserting at the target
 * start; otherwise inserts just after (trailing) or just before (leading) the
 * comment when the caret sits immediately outside it. Returns whether it handled
 * the insertion.
 */
export function handleBoundaryInsert(root: HTMLElement, boundary: BoundaryState, data: string): boolean {
  const pending = boundary.pendingInside;
  if (pending && commentJustAfterCaret(root) === pending) {
    boundary.pendingInside = null;
    insertAtTargetStart(pending, data);
    return true;
  }
  return handleInsertAfterComment(root, data) || handleInsertBeforeComment(root, data);
}

/**
 * Insert text at the very start of a comment's editable target (prepending to
 * its first target text node, or creating one before the metadata), then place
 * the caret just after it — a position genuinely inside the comment that the
 * browser keeps. Used to honour the leading-edge "type inside" intent.
 */
function insertAtTargetStart(comment: Element, data: string): void {
  const selection = window.getSelection()!;
  const target = firstNonEmptyTargetText(comment);
  if (target) {
    target.insertData(0, data);
    placeCaret(selection, (r) => r.setStart(target, data.length));
  } else {
    const textNode = document.createTextNode(data);
    comment.insertBefore(textNode, comment.firstChild);
    placeCaret(selection, (r) => r.setStart(textNode, data.length));
  }
}

/**
 * Insert typed text just after a comment (outside it) when the caret sits
 * immediately past the comment's close. Reaching that position requires
 * ArrowRight (see {@link handleCommentArrowRight}); the browser would otherwise
 * absorb the keystroke back into the comment's target. The text is prepended to
 * an existing following text node, or a fresh text node is created after the
 * comment. Returns whether it inserted the text.
 */
function handleInsertAfterComment(root: HTMLElement, data: string): boolean {
  const comment = commentJustBeforeCaret(root);
  if (!comment) return false;
  const selection = window.getSelection()!;
  const next = comment.nextSibling;
  if (next && next.nodeType === Node.TEXT_NODE) {
    (next as Text).insertData(0, data);
    placeCaret(selection, (r) => r.setStart(next, data.length));
  } else {
    const textNode = document.createTextNode(data);
    comment.after(textNode);
    placeCaret(selection, (r) => r.setStart(textNode, data.length));
  }
  return true;
}

/**
 * Mirror of {@link handleInsertAfterComment} for the leading edge: insert typed
 * text just before a comment (outside it) when the caret sits immediately before
 * <comment>. The text is appended to an existing preceding text node, or a fresh
 * text node is created before the comment. Returns whether it inserted the text.
 */
function handleInsertBeforeComment(root: HTMLElement, data: string): boolean {
  const comment = commentJustAfterCaret(root);
  if (!comment) return false;
  const selection = window.getSelection()!;
  const prev = comment.previousSibling;
  if (prev && prev.nodeType === Node.TEXT_NODE) {
    const at = (prev as Text).data.length;
    (prev as Text).insertData(at, data);
    placeCaret(selection, (r) => r.setStart(prev, at + data.length));
  } else {
    const textNode = document.createTextNode(data);
    comment.before(textNode);
    placeCaret(selection, (r) => r.setStart(textNode, data.length));
  }
  return true;
}

/**
 * The <comment> a collapsed caret sits immediately after (just past its close),
 * or null — "the node immediately before the caret is a comment". Shared by the
 * after-insertion handler, the ArrowLeft re-entry, and the caret-outside marker.
 */
function commentJustBeforeCaret(root: HTMLElement): Element | null {
  const range = collapsedCaretRange(root);
  if (!range) return null;
  const before = nodeImmediatelyBeforeCaret(range);
  if (!before || before.nodeType !== Node.ELEMENT_NODE) return null;
  return (before as Element).tagName === 'COMMENT' ? (before as Element) : null;
}

/**
 * The <comment> a collapsed caret sits immediately before (just outside its
 * open), or null — "the node immediately after the caret is a comment". Shared
 * by the before-insertion handler, the ArrowRight step-in, and the marker.
 */
function commentJustAfterCaret(root: HTMLElement): Element | null {
  const range = collapsedCaretRange(root);
  if (!range) return null;
  const after = nodeImmediatelyAfterCaret(range);
  if (!after || after.nodeType !== Node.ELEMENT_NODE) return null;
  return (after as Element).tagName === 'COMMENT' ? (after as Element) : null;
}

/** The current collapsed caret range inside root, or null. */
function collapsedCaretRange(root: HTMLElement): Range | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.startContainer)) return null;
  return range;
}

/**
 * Reconcile the transient caret-colour markers with the caret position and the
 * leading-edge intent. At most one comment is marked: CARET_INSIDE_ATTR when a
 * "type inside" intent is armed and the caret still sits at that comment's
 * leading edge (parent tinted author-colour); otherwise CARET_OUTSIDE_ATTR on a
 * comment the caret sits just outside of (its own caret reset to default). A
 * caret that has moved off the armed leading edge clears the intent.
 */
export function syncCaretMarkers(root: HTMLElement, boundary: BoundaryState): void {
  for (const c of Array.from(
    root.querySelectorAll(`comment[${CARET_INSIDE_ATTR}], comment[${CARET_OUTSIDE_ATTR}]`),
  )) {
    c.removeAttribute(CARET_INSIDE_ATTR);
    c.removeAttribute(CARET_OUTSIDE_ATTR);
  }

  const ahead = commentJustAfterCaret(root);
  if (boundary.pendingInside) {
    if (boundary.pendingInside === ahead) {
      ahead.setAttribute(CARET_INSIDE_ATTR, '');
      return;
    }
    boundary.pendingInside = null; // caret left the armed leading edge
  }
  const outside = ahead ?? commentJustBeforeCaret(root);
  if (outside) outside.setAttribute(CARET_OUTSIDE_ATTR, '');
}

/**
 * The comment whose visible trailing edge the collapsed caret sits at, or null.
 * "Visible trailing edge" means no visible (non-metadata) text remains between
 * the caret and the comment's end, which covers the target-text end, the
 * element offset before the body, and the position after the (display:none)
 * body. A caret mid-target (visible text still follows) returns null.
 */
function caretAtCommentTrailingEdge(range: Range, root: HTMLElement): Element | null {
  return caretAtCommentEdge(range, root, 'trailing');
}

/**
 * Mirror of {@link caretAtCommentTrailingEdge} for the leading edge: the comment
 * whose visible start the caret sits at (no visible text between the comment's
 * start and the caret), or null.
 */
function caretAtCommentLeadingEdge(range: Range, root: HTMLElement): Element | null {
  return caretAtCommentEdge(range, root, 'leading');
}

/**
 * The comment the caret sits at the visible edge of, on the given side, or null.
 * Clones the span between the caret and the comment's matching boundary and
 * checks it carries no visible (non-metadata) text.
 */
function caretAtCommentEdge(
  range: Range,
  root: HTMLElement,
  side: 'leading' | 'trailing',
): Element | null {
  const comment = findAncestor(range.startContainer, 'COMMENT', root);
  if (!comment) return null;
  const span = document.createRange();
  if (side === 'trailing') {
    span.setStart(range.startContainer, range.startOffset);
    span.setEnd(comment, comment.childNodes.length);
  } else {
    span.setStart(comment, 0);
    span.setEnd(range.startContainer, range.startOffset);
  }
  const fragment = span.cloneContents();
  return Array.from(fragment.childNodes).every(isInsignificantOrMeta) ? comment : null;
}

/**
 * Like {@link isInsignificantTail} but also treats a comment's metadata
 * (<comment-body>/<comment-reply>) as insignificant, so a caret sitting before
 * that metadata still counts as the comment's trailing edge.
 */
function isInsignificantOrMeta(node: Node): boolean {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const tag = (node as Element).tagName;
    if (tag === 'COMMENT-BODY' || tag === 'COMMENT-REPLY') return true;
  }
  return isInsignificantTail(node);
}
