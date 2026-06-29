// Editor core: enables contenteditable on the WYSIWYG root, intercepts
// browser default behaviors that misbehave with our HTML structure, applies
// lightweight markdown-style shortcuts, and dispatches debounced change
// notifications so callers can serialize and push edits back.

import { BLOCK_TAGS, CARET_INSIDE_ATTR, CARET_OUTSIDE_ATTR, INLINE_FORMAT_TAGS } from '../shared/constants';
import { blockOrBareCell, findAncestor, findBlockAncestor, isBlockEmptyOrStubBr, isInCommentMeta } from '../shared/dom-utils';
import { ensureBlockInCell, toggleList } from '../commands/block-format';

const DEBOUNCE_MS = 250;

// Presentational tags the browser emits for built-in bold/italic, mapped to
// the semantic tags the editor uses everywhere else.
const PRESENTATIONAL_TAG_MAP: Record<string, string> = {
  B: 'strong',
  I: 'em',
};

export interface EditorHandle {
  setEditable(enabled: boolean): void;
  flush(): void;
  /** Schedule a debounced change notification (for programmatic edits). */
  notifyChanged(): void;
}

export function setupEditor(root: HTMLElement, onChange: () => void): EditorHandle {
  root.contentEditable = 'true';
  root.spellcheck = false;
  root.setAttribute('role', 'textbox');
  root.setAttribute('aria-multiline', 'true');

  // Make Enter insert <p> rather than the browser default <div>. Without this,
  // a fresh line after a heading/list becomes a <div>, which keeps the output
  // inconsistent and previously made the markdown block shortcuts (which run in
  // plain text blocks) skip those lines.
  try {
    document.execCommand('defaultParagraphSeparator', false, 'p');
  } catch {
    // Not all environments expose execCommand; the shortcuts also accept <div>.
  }

  let pending: number | null = null;
  // True while an IME composition is active. Rewriting the DOM then would cancel
  // it, so the presentational-tag normalizer and the comment-boundary insertText
  // handler both stand down until compositionend.
  let composing = false;

  // Comment leading-edge state. The browser normalises the inside-start caret to
  // the outside, so the caret position alone cannot say "type inside". ArrowRight
  // there arms this one-shot intent; the next typed character is routed into the
  // comment's target start and the flag is cleared. Per-editor (closure) so it
  // never leaks across instances or tests.
  const boundary: { pendingInside: Element | null } = { pendingInside: null };

  const scheduleChange = (): void => {
    if (pending !== null) {
      window.clearTimeout(pending);
    }
    pending = window.setTimeout(() => {
      pending = null;
      onChange();
    }, DEBOUNCE_MS);
  };

  root.addEventListener('beforeinput', (e: InputEvent) => {
    // Any input other than typing a character cancels a pending leading-edge
    // "type inside" intent (it is meaningful only for the immediate next char).
    if (e.inputType !== 'insertText') boundary.pendingInside = null;
    if (e.inputType === 'insertParagraph') {
      // Enter inside a <summary> must not split it into two summaries; move the
      // caret into the details body instead.
      if (handleSummaryEnter(root)) {
        e.preventDefault();
        scheduleChange();
        return;
      }
      // Enter in an empty list item exits the list as a fresh paragraph instead
      // of inserting another empty item.
      if (handleEmptyListItemEnter(root)) {
        e.preventDefault();
        scheduleChange();
        return;
      }
      if (handleEnter(root)) {
        e.preventDefault();
        scheduleChange();
        return;
      }
      // Keep an inline <comment> whole: split the block at the boundary just
      // after the comment so the browser default never cuts through it (which
      // corrupts the contenteditable=false body and duplicates the id).
      if (keepCommentWholeOnEnter(root)) {
        e.preventDefault();
        scheduleChange();
        return;
      }
      // Continue inline formatting onto the new line when the caret sits at the
      // end of a formatted block (e.g. Enter after fully-bold text stays bold).
      if (handleFormattedEnter(root)) {
        e.preventDefault();
        scheduleChange();
        return;
      }
      // Even if we don't handle Enter here, fold "--- + Enter" into <hr>.
      if (handleThematicBreakShortcut(root)) {
        e.preventDefault();
        scheduleChange();
        return;
      }
      // "``` + Enter" opens a code block.
      if (handleCodeBlockShortcut(root)) {
        e.preventDefault();
        scheduleChange();
        return;
      }
    }
    if (e.inputType === 'insertText' && e.data === ' ') {
      if (handleHeadingShortcut(root)) {
        e.preventDefault();
        scheduleChange();
        return;
      }
      // "- " / "* " / "1. " start a list; "> " starts a blockquote.
      if (handleListShortcut(root)) {
        e.preventDefault();
        scheduleChange();
        return;
      }
      if (handleBlockquoteShortcut(root)) {
        e.preventDefault();
        scheduleChange();
        return;
      }
    }
    // Typing near a comment boundary must land where the user intends, not where
    // the browser absorbs it: into the target start when ArrowRight armed the
    // leading edge, after </comment> on the trailing edge, before <comment> on
    // the leading edge. Skipped during IME composition (compositionend covers it).
    if (
      e.inputType === 'insertText' &&
      !composing &&
      typeof e.data === 'string' &&
      e.data.length > 0
    ) {
      if (handleBoundaryInsert(root, boundary, e.data)) {
        e.preventDefault();
        scheduleChange();
        return;
      }
    }
    if (e.inputType === 'deleteContentBackward') {
      // Backspace with the caret right after a comment must not let the browser
      // delete across the comment boundary (which destroys the
      // contenteditable=false body). Shrink the comment's target text instead.
      if (handleCommentBackspace(root)) {
        e.preventDefault();
        scheduleChange();
        return;
      }
      // Backspace at the very start of a block merges it into the previous
      // block. The browser default merge cuts through a trailing comment and
      // wraps moved heading text in a presentational span; do it ourselves so
      // the comment stays whole and no style wrapper is injected.
      if (handleBlockMergeBackspace(root)) {
        e.preventDefault();
        scheduleChange();
        return;
      }
    }
    if (e.inputType === 'deleteContentForward') {
      // Delete near a comment must skip its (display:none, contenteditable=false)
      // metadata and remove only the next visible character; the browser default
      // mistakes the metadata for the next deletable node and wipes the body.
      if (handleCommentDelete(root)) {
        e.preventDefault();
        scheduleChange();
        return;
      }
      // Delete at the very end of a block pulls the next block into it — the
      // mirror of the Backspace merge, with the same comment/style hazards.
      if (handleBlockMergeForward(root)) {
        e.preventDefault();
        scheduleChange();
        return;
      }
    }
  });

  // ArrowRight/ArrowLeft cross the boundaries of an inline <comment>. A target
  // edge (inside the comment) and the matching just-outside position render
  // identically, so these keys deterministically choose which side the next
  // character is typed on: ArrowRight steps out at the trailing edge / in at the
  // leading edge, ArrowLeft does the mirror. Plain horizontal arrows only;
  // modified arrows, vertical arrows, and Shift selection fall through.
  root.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.key === 'ArrowRight') {
      if (handleCommentArrowRight(root, boundary)) e.preventDefault();
    } else if (e.key === 'ArrowLeft') {
      if (handleCommentArrowLeft(root, boundary)) e.preventDefault();
    }
  });

  // Colour the caret by which side of a comment boundary it sits on. The browser
  // paints the boundary caret with the adjacent comment's caret-color (caret
  // affinity), so: CARET_OUTSIDE_ATTR resets a just-outside caret to the default;
  // CARET_INSIDE_ATTR (armed by ArrowRight at a leading edge) tints the comment's
  // parent with the author colour even though the caret is physically outside.
  // selectionchange only fires on document; the markers are transient UI state
  // (stripped on serialize), never schedule a change, and change no layout.
  document.addEventListener('selectionchange', () => syncCaretMarkers(root, boundary));

  // The browser's contenteditable inserts presentational tags (<b>, <i>) for
  // its built-in bold/italic — e.g. after the only character in a <strong> is
  // deleted, the leftover bold state makes the next keystroke a <b>. Rewrite
  // those to the semantic tags the editor uses so formatting stays consistent.
  // Skip while an IME composition is active; rewriting then would cancel it.
  root.addEventListener('compositionstart', () => {
    composing = true;
    // IME composes at the (normalised, outside) caret, so a leading-edge inside
    // intent cannot be honoured for it; drop it rather than mis-route the commit.
    boundary.pendingInside = null;
  });
  root.addEventListener('compositionend', () => {
    composing = false;
    normalizePresentationalTags(root);
    scheduleChange();
  });

  root.addEventListener('input', () => {
    if (!composing) normalizePresentationalTags(root);
    scheduleChange();
  });

  return {
    setEditable(enabled: boolean): void {
      root.contentEditable = enabled ? 'true' : 'false';
    },
    flush(): void {
      if (pending !== null) {
        window.clearTimeout(pending);
        pending = null;
        onChange();
      }
    },
    notifyChanged(): void {
      scheduleChange();
    },
  };
}

/**
 * Enter inside a <summary>: rather than letting the browser split the summary
 * (which produces an invalid second <summary>), drop the caret into the
 * details body. The first block after the summary is reused if present;
 * otherwise an empty <p> is created. A collapsed details is opened first so the
 * caret's destination is visible.
 */
function handleSummaryEnter(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return false;

  const summary = findAncestor(range.startContainer, 'SUMMARY', root);
  if (!summary) return false;

  const details = summary.parentElement;
  if (details && details.tagName === 'DETAILS' && !details.hasAttribute('open')) {
    details.setAttribute('open', '');
  }

  let body = summary.nextElementSibling as HTMLElement | null;
  if (!body || !BLOCK_TAGS.has(body.tagName)) {
    body = document.createElement('p');
    body.appendChild(document.createElement('br'));
    summary.after(body);
  }

  const newRange = document.createRange();
  newRange.setStart(body, 0);
  newRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(newRange);
  return true;
}

/**
 * Enter inside an empty <li> exits the list: a fresh paragraph is inserted
 * after the outermost enclosing list and the empty item is removed. Only the
 * last item of its list is handled here; an empty item in the middle falls
 * through to the browser default (returns false).
 */
function handleEmptyListItemEnter(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return false;

  const li = findAncestor(range.startContainer, 'LI', root);
  if (!li) return false;
  if (!isBlockEmptyOrStubBr(li)) return false;
  if (li.nextElementSibling) return false; // not the last item

  const list = li.parentElement;
  if (!list || (list.tagName !== 'UL' && list.tagName !== 'OL')) return false;

  // Walk up to the outermost list so the caret leaves every nesting level.
  let topList: HTMLElement = list;
  let ancestor = list.parentElement;
  while (ancestor && ancestor !== root) {
    if (ancestor.tagName === 'UL' || ancestor.tagName === 'OL') topList = ancestor;
    ancestor = ancestor.parentElement;
  }

  const p = document.createElement('p');
  p.appendChild(document.createElement('br'));
  topList.after(p);
  li.remove();
  if (!Array.from(list.children).some((c) => c.tagName === 'LI')) list.remove();

  const newRange = document.createRange();
  newRange.setStart(p, 0);
  newRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(newRange);
  return true;
}

/**
 * Custom Enter handling for <li> that contains a nested <ul>/<ol>:
 * insert an empty <li> at the start of the nested list instead of letting
 * the browser split the current <li> mid-structure.
 */
function handleEnter(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return false;

  const li = findAncestor(range.startContainer, 'LI', root);
  if (!li) return false;

  const nestedList = Array.from(li.children).find(
    (c) => c.tagName === 'UL' || c.tagName === 'OL',
  ) as HTMLElement | undefined;
  if (!nestedList) return false;

  if (!isCursorBeforeOnlyTrailingListContent(range, li)) {
    return false;
  }

  const newLi = document.createElement('li');
  newLi.appendChild(document.createElement('br'));
  nestedList.insertBefore(newLi, nestedList.firstChild);

  const newRange = document.createRange();
  newRange.setStart(newLi, 0);
  newRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(newRange);

  return true;
}

/**
 * Enter at the end of a block whose trailing content is wrapped in inline
 * formatting (strong/em/code/s) creates a new sibling block of the same tag
 * that reproduces the inline-wrapper chain around a `<br>` placeholder, with
 * the caret inside the innermost wrapper. This lets continued typing inherit
 * the formatting (e.g. Enter after fully-bold text stays bold). The empty
 * wrapper is preserved through serialization only while the caret is in it
 * (see serialize.ts), so it does not bloat the saved file once abandoned.
 */
function handleFormattedEnter(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return false;

  const block = findBlockAncestor(range.startContainer, root);
  if (!block) return false;
  // <li> has its own Enter handler; <pre> never carries inline formatting.
  if (block.tagName === 'LI' || block.tagName === 'PRE') return false;

  if (!isCaretAtBlockEnd(range, block)) return false;

  const chain = inlineChainBeforeCaret(range, block);
  if (chain.length === 0) return false;

  const newBlock = document.createElement(block.tagName.toLowerCase());
  let host: HTMLElement = newBlock;
  for (const tag of chain) {
    const wrapper = document.createElement(tag.toLowerCase());
    host.appendChild(wrapper);
    host = wrapper;
  }
  host.appendChild(document.createElement('br'));
  block.after(newBlock);

  const newRange = document.createRange();
  newRange.setStart(host, 0);
  newRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(newRange);
  return true;
}

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
function keepCommentWholeOnEnter(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return false;

  const comment = findAncestor(range.startContainer, 'COMMENT', root);
  if (!comment) return false;
  const block = findBlockAncestor(comment, root);
  if (!block) return false;

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
interface BoundaryState {
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
function handleCommentArrowRight(root: HTMLElement, boundary: BoundaryState): boolean {
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
function handleCommentArrowLeft(root: HTMLElement, boundary: BoundaryState): boolean {
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
function handleBoundaryInsert(root: HTMLElement, boundary: BoundaryState, data: string): boolean {
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
function syncCaretMarkers(root: HTMLElement, boundary: BoundaryState): void {
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

/**
 * A comment's body/replies are display:none and contenteditable=false, so the
 * browser default deletion repeatedly mistakes them for "the next thing to
 * delete" and wipes the body as collateral. Both of these handlers enforce one
 * rule: deletions act only on *visible* characters (target text + surrounding
 * text) in the key direction, never on the invisible metadata. When the caret
 * sits inside or next to a comment, we perform the single-character deletion
 * ourselves; far from comments we defer to the browser (return false).
 *
 * Spot to delete: one character at {text}[{index}], or — when {text} is null —
 * remove the whole (now anchorless) {comment}.
 */
interface DeletionSpot {
  text: Text | null;
  index: number;
  comment: Element | null;
}

function handleCommentBackspace(root: HTMLElement): boolean {
  return handleCommentDeletion(root, backwardDeletionSpot);
}

function handleCommentDelete(root: HTMLElement): boolean {
  return handleCommentDeletion(root, forwardDeletionSpot);
}

function handleCommentDeletion(
  root: HTMLElement,
  findSpot: (range: Range, root: HTMLElement) => DeletionSpot | null,
): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.startContainer)) return false;

  const spot = findSpot(range, root);
  if (!spot) return false;

  if (spot.text) {
    spot.text.deleteData(spot.index, 1);
    return true;
  }
  if (spot.comment) removeAnchorlessComment(spot.comment, selection);
  return true;
}

/** Backspace: the previous visible character, skipping comment metadata. */
function backwardDeletionSpot(range: Range, root: HTMLElement): DeletionSpot | null {
  const { startContainer: sc, startOffset: so } = range;

  // A character within the current text node, only inside the comment danger
  // zone (in a comment's target text, or in text adjacent to a comment).
  if (sc.nodeType === Node.TEXT_NODE && so > 0) {
    if (!isCommentDangerText(sc as Text, root)) return null;
    return { text: sc as Text, index: so - 1, comment: findAncestor(sc, 'COMMENT', root) };
  }

  // Otherwise resolve the node immediately before the caret.
  const before = nodeImmediatelyBeforeCaret(range);
  if (!before) return null;
  if (before.nodeType === Node.TEXT_NODE) {
    const t = before as Text;
    if (t.data.length === 0 || !isCommentDangerText(t, root)) return null;
    return { text: t, index: t.data.length - 1, comment: findAncestor(t, 'COMMENT', root) };
  }
  if (before.nodeType !== Node.ELEMENT_NODE) return null;
  const comment = ownerCommentForMeta(before as Element);
  if (!comment) return null;
  // Shrink the comment's target from its end; remove it once nothing is left.
  const text = lastNonEmptyTargetText(comment);
  return { text, index: text ? text.data.length - 1 : -1, comment };
}

/** Delete: the next visible character, skipping comment metadata. */
function forwardDeletionSpot(range: Range, root: HTMLElement): DeletionSpot | null {
  const { startContainer: sc, startOffset: so } = range;

  if (sc.nodeType === Node.TEXT_NODE && so < (sc as Text).data.length) {
    if (!isCommentDangerText(sc as Text, root)) return null;
    return { text: sc as Text, index: so, comment: findAncestor(sc, 'COMMENT', root) };
  }

  const after = nodeImmediatelyAfterCaret(range);
  if (after) {
    if (after.nodeType === Node.TEXT_NODE) {
      const t = after as Text;
      if (t.data.length === 0 || !isCommentDangerText(t, root)) return null;
      return { text: t, index: 0, comment: findAncestor(t, 'COMMENT', root) };
    }
    if (after.nodeType === Node.ELEMENT_NODE) {
      const el = after as Element;
      if (el.tagName === 'COMMENT') {
        // Just before a comment: delete its first target character.
        return { text: firstNonEmptyTargetText(el), index: 0, comment: el };
      }
      const meta = ownerCommentForMeta(el);
      if (meta) {
        // At a comment's trailing edge (next node is its metadata): skip the
        // metadata and delete the first character of the following text.
        const text = firstVisibleTextAfter(meta);
        return text ? { text, index: 0, comment: null } : null;
      }
    }
    return null;
  }

  // Caret at the trailing edge inside a comment (after the metadata / its end):
  // the next visible character is the first one of the text following it.
  const host = findAncestor(sc, 'COMMENT', root);
  if (host) {
    const text = firstVisibleTextAfter(host);
    if (text) return { text, index: 0, comment: null };
  }
  return null;
}

/** True when a text node is in the comment danger zone: inside a comment's
 *  target text, or directly adjacent (prev/next sibling) to a comment. */
function isCommentDangerText(text: Text, root: HTMLElement): boolean {
  if (findAncestor(text, 'COMMENT', root) && !isInCommentMeta(text, root)) return true;
  const prev = text.previousSibling;
  if (prev && prev.nodeType === Node.ELEMENT_NODE && (prev as Element).tagName === 'COMMENT') return true;
  const next = text.nextSibling;
  if (next && next.nodeType === Node.ELEMENT_NODE && (next as Element).tagName === 'COMMENT') return true;
  return false;
}

/** The comment owning a node that is a comment element or a comment's metadata,
 *  else null. */
function ownerCommentForMeta(el: Element): Element | null {
  if (el.tagName === 'COMMENT') return el;
  if (el.tagName === 'COMMENT-BODY' || el.tagName === 'COMMENT-REPLY') {
    const p = el.parentElement;
    if (p && p.tagName === 'COMMENT') return p;
  }
  return null;
}

/** Remove an anchorless comment and drop the caret where it stood. */
function removeAnchorlessComment(comment: Element, selection: Selection): void {
  const parent = comment.parentNode;
  if (!parent) return;
  const index = Array.prototype.indexOf.call(parent.childNodes, comment);
  comment.remove();
  const r = document.createRange();
  r.setStart(parent, index);
  r.collapse(true);
  selection.removeAllRanges();
  selection.addRange(r);
}

/** First non-empty text node after a comment within its block, or null. */
function firstVisibleTextAfter(comment: Element): Text | null {
  let n: Node | null = comment.nextSibling;
  while (n) {
    const t = deepestFirstNonEmptyText(n);
    if (t) return t;
    n = n.nextSibling;
  }
  return null;
}

/** The node directly before a collapsed caret, or null when the caret sits
 *  mid-text (a normal in-place deletion the caller should leave to the browser). */
function nodeImmediatelyBeforeCaret(range: Range): Node | null {
  const { startContainer, startOffset } = range;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    return startOffset === 0 ? startContainer.previousSibling : null;
  }
  return startOffset > 0 ? startContainer.childNodes[startOffset - 1] : null;
}

/** Deepest, last non-empty text node within a comment's editable target region
 *  (the content before the first <comment-body>/<comment-reply>), or null. */
function lastNonEmptyTargetText(comment: Element): Text | null {
  const kids = comment.childNodes;
  let end = kids.length;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n.nodeType === Node.ELEMENT_NODE) {
      const tag = (n as Element).tagName;
      if (tag === 'COMMENT-BODY' || tag === 'COMMENT-REPLY') {
        end = i;
        break;
      }
    }
  }
  for (let i = end - 1; i >= 0; i--) {
    const found = deepestLastNonEmptyText(kids[i]);
    if (found) return found;
  }
  return null;
}

function deepestLastNonEmptyText(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node as Text).data.length > 0 ? (node as Text) : null;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const found = deepestLastNonEmptyText(node.childNodes[i]);
    if (found) return found;
  }
  return null;
}

/** The node directly after a collapsed caret, or null when the caret sits
 *  mid-text (a normal in-place forward deletion the caller should not redirect). */
function nodeImmediatelyAfterCaret(range: Range): Node | null {
  const { startContainer, startOffset } = range;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    return startOffset === (startContainer as Text).data.length
      ? startContainer.nextSibling
      : null;
  }
  return startOffset < startContainer.childNodes.length
    ? startContainer.childNodes[startOffset]
    : null;
}

/** Deepest, first non-empty text node within a comment's editable target region
 *  (the content before the first <comment-body>/<comment-reply>), or null. */
function firstNonEmptyTargetText(comment: Element): Text | null {
  const kids = comment.childNodes;
  let end = kids.length;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n.nodeType === Node.ELEMENT_NODE) {
      const tag = (n as Element).tagName;
      if (tag === 'COMMENT-BODY' || tag === 'COMMENT-REPLY') {
        end = i;
        break;
      }
    }
  }
  for (let i = 0; i < end; i++) {
    const found = deepestFirstNonEmptyText(kids[i]);
    if (found) return found;
  }
  return null;
}

function deepestFirstNonEmptyText(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node as Text).data.length > 0 ? (node as Text) : null;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  for (let i = 0; i < node.childNodes.length; i++) {
    const found = deepestFirstNonEmptyText(node.childNodes[i]);
    if (found) return found;
  }
  return null;
}

// Blocks whose Backspace-at-start / Delete-at-end merge we take over from the
// browser. They carry inline content only: LI keeps the browser's list
// behavior, and PRE / SUMMARY / DETAILS have structural semantics we leave be.
const MERGEABLE_BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'DIV',
]);

/**
 * A block we are willing to merge: a mergeable tag whose element children are
 * all inline. A nested block/list/table would make a flat content move
 * ambiguous, so such blocks are deferred to the browser default. (A
 * `<comment>` is inline and does not disqualify the block.)
 */
function isMergeableLeafBlock(el: Element | null): el is HTMLElement {
  if (!el || !MERGEABLE_BLOCK_TAGS.has(el.tagName)) return false;
  for (const child of Array.from(el.children)) {
    const tag = child.tagName;
    if (BLOCK_TAGS.has(tag) || tag === 'UL' || tag === 'OL' || tag === 'TABLE') {
      return false;
    }
  }
  return true;
}

/** Mirror of {@link isCaretAtBlockEnd}: nothing significant precedes the caret
 *  within the block (only whitespace / <br> / empty inline wrappers). */
function isCaretAtBlockStart(range: Range, block: Element): boolean {
  const head = document.createRange();
  head.setStart(block, 0);
  head.setEnd(range.startContainer, range.startOffset);
  const fragment = head.cloneContents();
  return Array.from(fragment.childNodes).every(isInsignificantTail);
}

/**
 * Merge two adjacent blocks by relocating `next`'s children to the end of
 * `prev`, then removing `next`. Nodes are moved by reference (never deleted
 * across a boundary), so a trailing/leading <comment> keeps its
 * contenteditable=false body intact and no presentational wrapper is injected.
 * When one side is an empty placeholder, the empty block is dropped and the
 * other kept verbatim so an adjacent blank line never swallows a heading's
 * block type. The caret lands at the join.
 */
function mergeBlocks(prev: HTMLElement, next: HTMLElement, selection: Selection): void {
  const prevEmpty = isBlockEmptyOrStubBr(prev);
  const nextEmpty = isBlockEmptyOrStubBr(next);

  const r = document.createRange();
  if (prevEmpty || nextEmpty) {
    // Drop the empty block; keep the other untouched. Keeping `next` puts the
    // caret at its start; keeping `prev` puts it at prev's end.
    const kept = prevEmpty ? next : prev;
    (prevEmpty ? prev : next).remove();
    r.setStart(kept, prevEmpty ? 0 : kept.childNodes.length);
  } else {
    const boundary = prev.lastChild; // non-null: prev is non-empty
    while (next.firstChild) prev.appendChild(next.firstChild);
    next.remove();
    if (boundary) r.setStartAfter(boundary);
    else r.setStart(prev, 0);
  }
  r.collapse(true);
  selection.removeAllRanges();
  selection.addRange(r);
}

/**
 * Backspace at the very start of a mergeable block folds it into the previous
 * mergeable block (the inverse of {@link keepCommentWholeOnEnter}). Returns
 * whether it handled the deletion; otherwise the browser default runs.
 */
function handleBlockMergeBackspace(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.startContainer)) return false;

  const block = findBlockAncestor(range.startContainer, root);
  if (!isMergeableLeafBlock(block)) return false;
  if (!isCaretAtBlockStart(range, block)) return false;

  const prev = block.previousElementSibling;
  if (!isMergeableLeafBlock(prev)) return false;

  mergeBlocks(prev, block, selection);
  return true;
}

/**
 * Delete at the very end of a mergeable block pulls the next mergeable block
 * into it — the mirror of {@link handleBlockMergeBackspace}.
 */
function handleBlockMergeForward(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.startContainer)) return false;

  const block = findBlockAncestor(range.startContainer, root);
  if (!isMergeableLeafBlock(block)) return false;
  if (!isCaretAtBlockEnd(range, block)) return false;

  const next = block.nextElementSibling;
  if (!isMergeableLeafBlock(next)) return false;

  mergeBlocks(block, next, selection);
  return true;
}

/**
 * Inline-format ancestor chain (outermost first) of the content immediately
 * before the caret. Resolving from the node before the caret — rather than the
 * caret's literal ancestors — handles a block-level caret that sits just after
 * the trailing inline wrapper as well as a caret inside it.
 */
function inlineChainBeforeCaret(range: Range, block: Element): string[] {
  const { startContainer, startOffset } = range;
  let node: Node | null;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    node = startOffset > 0 ? startContainer : startContainer.previousSibling;
  } else {
    node = startOffset > 0 ? startContainer.childNodes[startOffset - 1] : null;
  }
  // Descend to the deepest trailing descendant adjacent to the caret.
  while (node && node.nodeType === Node.ELEMENT_NODE && node.lastChild) {
    node = node.lastChild;
  }
  if (!node) return [];

  const tags: string[] = [];
  let cur: Node | null = node;
  while (cur && cur !== block) {
    if (cur.nodeType === Node.ELEMENT_NODE && INLINE_FORMAT_TAGS.has((cur as Element).tagName)) {
      tags.push((cur as Element).tagName);
    }
    cur = cur.parentNode;
  }
  return tags.reverse();
}

function isCaretAtBlockEnd(range: Range, block: Element): boolean {
  const tail = document.createRange();
  tail.setStart(range.endContainer, range.endOffset);
  tail.setEnd(block, block.childNodes.length);
  const fragment = tail.cloneContents();
  return Array.from(fragment.childNodes).every(isInsignificantTail);
}

// Rewrite <b>/<i> to <strong>/<em>, preserving attributes. Moving the children
// reparents them but keeps their node identity, so we snapshot the selection
// boundaries and restore them afterwards to keep the caret where the user is
// typing (the DOM spec collapses ranges onto the parent when a node is moved).
// Returns whether anything changed.
function normalizePresentationalTags(root: HTMLElement): boolean {
  const selector = Object.keys(PRESENTATIONAL_TAG_MAP).map((t) => t.toLowerCase()).join(',');
  const stale = Array.from(root.querySelectorAll(selector));
  if (stale.length === 0) return false;

  const sel = window.getSelection();
  const saved = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  const snap = saved
    ? {
        sc: saved.startContainer,
        so: saved.startOffset,
        ec: saved.endContainer,
        eo: saved.endOffset,
      }
    : null;

  for (const el of stale) {
    const replacement = PRESENTATIONAL_TAG_MAP[el.tagName];
    if (!replacement) continue;
    const newEl = el.ownerDocument.createElement(replacement);
    for (const attr of Array.from(el.attributes)) newEl.setAttribute(attr.name, attr.value);
    while (el.firstChild) newEl.appendChild(el.firstChild);
    el.replaceWith(newEl);
  }

  if (snap && sel && root.contains(snap.sc) && root.contains(snap.ec)) {
    try {
      const r = document.createRange();
      r.setStart(snap.sc, snap.so);
      r.setEnd(snap.ec, snap.eo);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch {
      /* boundaries no longer valid after the rewrite — leave selection as-is */
    }
  }
  return true;
}

// A trailing node is insignificant if it is whitespace-only text, a <br>, or
// an inline wrapper whose own children are all insignificant.
function isInsignificantTail(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return /^\s*$/.test((node as Text).data);
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  if (el.tagName === 'BR') return true;
  if (BLOCK_TAGS.has(el.tagName)) return false;
  return Array.from(el.childNodes).every(isInsignificantTail);
}

/**
 * The markdown block shortcuts fire only in a "plain" text block. Both <p> and
 * <div> qualify: contenteditable's default Enter can still yield a <div> (and
 * existing documents / AI output may use them), so restricting to <p> would make
 * the shortcuts silently do nothing on those lines.
 */
function isPlainTextBlock(block: Element): boolean {
  return block.tagName === 'P' || block.tagName === 'DIV';
}

interface ShortcutTarget {
  el: HTMLElement;
  bareCell: boolean;
}

/**
 * The container a markdown block shortcut may transform: the caret's nearest
 * block (only when it is a plain <p>/<div>), or a bare table cell whose inline
 * content will be wrapped on commit (see {@link materializeShortcutBlock}).
 * Returns null when the caret is in a non-plain block (heading/list/pre/etc.) or
 * outside any block/cell. Read-only — it never mutates, so a plain space that
 * fails the per-shortcut marker test leaves the cell untouched.
 */
function shortcutTarget(range: Range, root: HTMLElement): ShortcutTarget | null {
  const found = blockOrBareCell(range.startContainer, root);
  if (!found) return null;
  if (!found.bareCell && !isPlainTextBlock(found.el)) return null;
  return found;
}

/**
 * Materialize the block a shortcut will mutate. A bare cell is wrapped in a <p>
 * now (only after the caller confirmed the marker), which re-anchors the
 * selection — so the live range is re-read and returned alongside it. A real
 * block is used as-is with the original range. Returns null when the wrap is
 * declined (a cell already holding block-level children), so the caller bails.
 */
function materializeShortcutBlock(
  found: ShortcutTarget,
  range: Range,
  root: HTMLElement,
  selection: Selection,
): { block: HTMLElement; range: Range } | null {
  if (!found.bareCell) return { block: found.el, range };
  const block = ensureBlockInCell(range.startContainer, root);
  if (!block) return null;
  return { block, range: selection.getRangeAt(0) };
}

/**
 * "# ", "## ", ..., "###### " typed at the start of a paragraph converts the
 * paragraph into the corresponding heading level. The leading "#" markers
 * are removed.
 */
function handleHeadingShortcut(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return false;

  const found = shortcutTarget(range, root);
  if (!found) return false;

  const match = /^(#{1,6})$/.exec(textBeforeCursor(range, found.el));
  if (!match) return false;
  const level = match[1].length;

  const target = materializeShortcutBlock(found, range, root, selection);
  if (!target) return false;
  const { block, range: r } = target;

  // Remove the "#"s from the block, then convert to heading.
  const deleteRange = document.createRange();
  deleteRange.setStart(block, 0);
  deleteRange.setEnd(r.startContainer, r.startOffset);
  deleteRange.deleteContents();
  // Drop any empty text node left by deleteContents so an emptied heading keeps
  // its <br> placeholder instead of an invisible empty text node.
  block.normalize();

  const heading = document.createElement('h' + level);
  while (block.firstChild) heading.appendChild(block.firstChild);
  if (heading.childNodes.length === 0) {
    heading.appendChild(document.createElement('br'));
  }
  block.replaceWith(heading);

  const newRange = document.createRange();
  newRange.setStart(heading, 0);
  newRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(newRange);
  return true;
}

/**
 * "- " / "* " (unordered) or "1. " (ordered) typed at the start of a paragraph
 * turns it into a list. The marker is removed and the paragraph is converted
 * via {@link toggleList}, reusing the same conversion the toolbar buttons use.
 */
function handleListShortcut(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return false;

  const found = shortcutTarget(range, root);
  if (!found) return false;

  const before = textBeforeCursor(range, found.el);
  let type: 'ul' | 'ol' | null = null;
  if (before === '-' || before === '*') type = 'ul';
  else if (before === '1.') type = 'ol';
  if (!type) return false;

  const target = materializeShortcutBlock(found, range, root, selection);
  if (!target) return false;
  const { block, range: r } = target;

  // Remove the marker, collapse the caret to the block start, then convert.
  const deleteRange = document.createRange();
  deleteRange.setStart(block, 0);
  deleteRange.setEnd(r.startContainer, r.startOffset);
  deleteRange.deleteContents();
  // deleteContents can leave an empty text node behind. Drop it so an emptied
  // block reports zero children and toggleList inserts a <br> placeholder;
  // otherwise the resulting <li> holds an invisible empty text node.
  block.normalize();

  const caret = document.createRange();
  caret.setStart(block, 0);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);

  toggleList(type, { root });
  return true;
}

/**
 * "> " typed at the start of a paragraph turns it into a blockquote. The marker
 * is removed; an empty quote keeps a <br> placeholder so it stays selectable.
 */
function handleBlockquoteShortcut(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return false;

  const found = shortcutTarget(range, root);
  if (!found) return false;

  if (textBeforeCursor(range, found.el) !== '>') return false;

  const target = materializeShortcutBlock(found, range, root, selection);
  if (!target) return false;
  const { block, range: r } = target;

  const deleteRange = document.createRange();
  deleteRange.setStart(block, 0);
  deleteRange.setEnd(r.startContainer, r.startOffset);
  deleteRange.deleteContents();
  // Drop any empty text node left by deleteContents so an emptied quote keeps
  // its <br> placeholder instead of an invisible empty text node.
  block.normalize();

  const quote = document.createElement('blockquote');
  while (block.firstChild) quote.appendChild(block.firstChild);
  if (quote.childNodes.length === 0) {
    quote.appendChild(document.createElement('br'));
  }
  block.replaceWith(quote);

  const newRange = document.createRange();
  newRange.setStart(quote, 0);
  newRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(newRange);
  return true;
}

/**
 * "```" alone in a paragraph + Enter opens an (empty) code block for continued
 * typing, mirroring the "---" thematic-break shortcut.
 */
function handleCodeBlockShortcut(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return false;

  const found = shortcutTarget(range, root);
  if (!found) return false;

  if ((found.el.textContent ?? '').trim() !== '```') return false;

  const target = materializeShortcutBlock(found, range, root, selection);
  if (!target) return false;
  const { block } = target;

  const pre = document.createElement('pre');
  pre.appendChild(document.createElement('br'));
  block.replaceWith(pre);

  const newRange = document.createRange();
  newRange.setStart(pre, 0);
  newRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(newRange);
  return true;
}

/**
 * "---" alone in a paragraph + Enter becomes an <hr> followed by a fresh
 * paragraph for continued typing.
 */
function handleThematicBreakShortcut(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return false;

  const found = shortcutTarget(range, root);
  if (!found) return false;

  if ((found.el.textContent ?? '').trim() !== '---') return false;

  const target = materializeShortcutBlock(found, range, root, selection);
  if (!target) return false;
  const { block } = target;

  const hr = document.createElement('hr');
  const p = document.createElement('p');
  p.appendChild(document.createElement('br'));
  block.replaceWith(hr);
  hr.parentNode!.insertBefore(p, hr.nextSibling);

  const newRange = document.createRange();
  newRange.setStart(p, 0);
  newRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(newRange);
  return true;
}

function isCursorBeforeOnlyTrailingListContent(range: Range, li: HTMLElement): boolean {
  const tail = document.createRange();
  tail.setStart(range.endContainer, range.endOffset);
  tail.setEnd(li, li.childNodes.length);
  const fragment = tail.cloneContents();

  for (const node of Array.from(fragment.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!/^\s*$/.test(node.textContent ?? '')) return false;
      continue;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = (node as Element).tagName;
      if (tag !== 'UL' && tag !== 'OL') return false;
      continue;
    }
    return false;
  }
  return true;
}

function textBeforeCursor(range: Range, block: Element): string {
  const r = document.createRange();
  r.setStart(block, 0);
  r.setEnd(range.startContainer, range.startOffset);
  return r.toString();
}
