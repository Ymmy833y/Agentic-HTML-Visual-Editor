// Editor core: enables contenteditable on the WYSIWYG root, intercepts
// browser default behaviors that misbehave with our HTML structure, applies
// lightweight markdown-style shortcuts, and dispatches debounced change
// notifications so callers can serialize and push edits back.

import {
  BLOCK_TAGS,
  INLINE_FORMAT_TAGS,
  QUOTE_PLACEHOLDER_ATTR,
} from '../shared/constants';
import type { DeleteDirection, DeleteGranularity } from '../shared/constants';
import {
  blockOrBareCell,
  findAncestor,
  findBlockAncestor,
  isBlockEmptyOrStubBr,
  isCaretAtBlockEnd,
  isCaretAtBlockStart,
  isInsignificantTail,
} from '../shared/dom-utils';
import {
  ensureBlockAtRoot,
  ensureBlockInCell,
  ensureBlockquoteLineBlock,
  findBareBlockquoteLine,
  findBareBlockquoteRun,
  findBareRootRun,
  toggleList,
} from '../commands/block-format';
import { alertTypeFromShortcut } from '../shared/alert-types';
import { findTrailingEmptyCodeLine } from '../commands/code-block';
import {
  handleEmptyBlockAtStructuralBoundary,
  isProtectedStructuralBoundary,
} from '../commands/structural-boundary';
// The only core → features dependency in the webview, and a deliberate one:
// beforeinput and keydown arrive here and nowhere else, so the routing below
// has to name every handler that stands in front of a browser default —
// including the comment ones, which live under features/comment because that is
// where the <comment> DOM shape is owned (comment-dom, comment-popup,
// comment-commands). Moving them into commands/ would only turn this into
// commands → features.
//
// It is NOT a pattern to follow: every other feature (table, link, details,
// clipboard) is wired by webview/main.ts, the composition root, and should stay
// that way. If a second feature ever needs to be named here, inject the
// handlers through setupEditor's arguments instead of adding another import.
//
// What this file must NOT do is keep a second copy of the boundary rules: every
// handler that reasons about the visible edge of a <comment> lives in
// features/comment, so a fix to one cannot land while its counterpart in the
// other direction is missed. Only the routing stays here.
import type { BoundaryState } from '../features/comment/comment-boundary';
import {
  handleBoundaryInsert,
  handleCommentArrowLeft,
  handleCommentArrowRight,
  keepCommentWholeOnEnter,
  syncCaretMarkers,
} from '../features/comment/comment-boundary';
import {
  commentInCaretBlock,
  facesCommentAcrossBlockBoundary,
  handleCommentBackspace,
  handleCommentDelete,
} from '../features/comment/comment-deletion';

const DEBOUNCE_MS = 250;

interface DeleteIntent {
  direction: DeleteDirection;
  granularity: DeleteGranularity;
}

// Collapsed-caret deletions we inspect before the browser runs. Both axes
// matter: the direction picks the handler chain, the granularity tells the
// comment handlers how much the browser would have removed.
//
// The word rows are backed by native probes in
// tests/e2e/comment-delete-sweep.spec.ts, which measure what Chromium really
// does at these positions. The line rows are not, and cannot be: Chromium binds
// the line-deletion commands only on macOS (Cmd+Backspace / Cmd+Delete), so on
// the platforms the e2e suite runs on no keystroke produces them — a probe in
// that same file measures exactly this and fails if it ever changes. Their
// coverage is the synthetic beforeinput dispatch in
// tests/unit/editor-core.test.ts.
//
// Soft and hard line deletion are separate granularities because they cannot be
// answered the same way: a hard line is the block (so the handlers may clip a
// deletion to the caret's text node), a soft line is a visual line whose extent
// this code cannot see (so it is blocked, never reproduced). See
// DeleteGranularity in shared/constants.
const DELETE_INPUT_TYPES = new Map<string, DeleteIntent>([
  ['deleteContentBackward', { direction: 'backward', granularity: 'character' }],
  ['deleteWordBackward', { direction: 'backward', granularity: 'word' }],
  ['deleteSoftLineBackward', { direction: 'backward', granularity: 'soft-line' }],
  ['deleteHardLineBackward', { direction: 'backward', granularity: 'hard-line' }],
  ['deleteContentForward', { direction: 'forward', granularity: 'character' }],
  ['deleteWordForward', { direction: 'forward', granularity: 'word' }],
  ['deleteSoftLineForward', { direction: 'forward', granularity: 'soft-line' }],
  ['deleteHardLineForward', { direction: 'forward', granularity: 'hard-line' }],
]);

// The one deletion input type with no row above it. `deleteEntireSoftLine`
// removes the whole visual line in a single keystroke — both directions at once
// — so it fits neither: routing it through the backward handlers would silently
// reproduce half of what the user asked for. Chromium binds no chord to it on
// the platforms this editor runs on (the probe in
// tests/e2e/comment-delete-sweep.spec.ts measures that for the line commands),
// but an input type absent from the map skips every guard below, and the line it
// deletes is exactly where a <comment>'s contenteditable=false body sits. So it
// is consumed wherever a hazard is present and left to the browser everywhere
// else — see {@link entireLineDeletionIsUnsafe}.
const ENTIRE_LINE_INPUT_TYPE = 'deleteEntireSoftLine';

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
  notifyChanged(label?: string): void;
}

export function setupEditor(
  root: HTMLElement,
  onChange: () => void,
  onDirty?: () => void,
  onNativeEdit?: (inputType: string) => void,
  onCommandEdit?: (label: string) => void,
): EditorHandle {
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
  const boundary: BoundaryState = { pendingInside: null };

  const scheduleChange = (): void => {
    // Dirty state must flip synchronously: a document remount arriving inside
    // the debounce window would otherwise wipe a change that has not been
    // marked as unsaved yet.
    onDirty?.();
    if (pending !== null) {
      window.clearTimeout(pending);
    }
    pending = window.setTimeout(() => {
      pending = null;
      onChange();
    }, DEBOUNCE_MS);
  };

  const recordHandledEdit = (label: string): void => {
    scheduleChange();
    onCommandEdit?.(label);
  };

  root.addEventListener('beforeinput', (e: InputEvent) => {
    // VS Code owns undo/redo through CustomDocumentEditEvent. Chromium must
    // never traverse its separate contenteditable stack if a shortcut event
    // is forwarded into the webview.
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault();
      return;
    }
    // Any input other than typing a character cancels a pending leading-edge
    // "type inside" intent (it is meaningful only for the immediate next char).
    if (e.inputType !== 'insertText') boundary.pendingInside = null;
    if (e.inputType === 'insertParagraph') {
      // A blank trailing line is the escape hatch from a code block. Chromium
      // represents code-block line breaks with <br> nodes while existing HTML
      // may contain literal newlines, so the handler supports both forms.
      if (handleCodeBlockExit(root)) {
        e.preventDefault();
        recordHandledEdit('Insert paragraph');
        return;
      }
      // Enter inside a <summary> must not split it into two summaries; move the
      // caret into the details body instead.
      if (handleSummaryEnter(root)) {
        e.preventDefault();
        recordHandledEdit('Insert paragraph');
        return;
      }
      // Enter in an empty list item exits the list as a fresh paragraph instead
      // of inserting another empty item.
      if (handleEmptyListItemEnter(root)) {
        e.preventDefault();
        recordHandledEdit('Insert paragraph');
        return;
      }
      if (handleEnter(root)) {
        e.preventDefault();
        recordHandledEdit('Insert paragraph');
        return;
      }
      // Resolve code markers before the quote-specific Enter handler turns
      // the keystroke into a soft line break.
      if (handleCodeBlockShortcut(root)) {
        e.preventDefault();
        recordHandledEdit('Insert code block');
        return;
      }
      // Keep an inline <comment> whole: split the block at the boundary just
      // after the comment so the browser default never cuts through it (which
      // corrupts the contenteditable=false body and duplicates the id).
      if (keepCommentWholeOnEnter(root, insertBareBlockquoteBreak)) {
        e.preventDefault();
        recordHandledEdit('Insert paragraph');
        return;
      }
      // A bare blockquote is one flow container, not a sequence of sibling
      // quotes. Enter inserts a direct <br>; Enter again on the trailing empty
      // line exits to a normal paragraph.
      if (handleBareBlockquoteEnter(root)) {
        e.preventDefault();
        recordHandledEdit('Insert paragraph');
        return;
      }
      // Continue inline formatting onto the new line when the caret sits at the
      // end of a formatted block (e.g. Enter after fully-bold text stays bold).
      if (handleFormattedEnter(root)) {
        e.preventDefault();
        recordHandledEdit('Insert paragraph');
        return;
      }
      // Even if we don't handle Enter here, fold "--- + Enter" into <hr>.
      if (handleThematicBreakShortcut(root)) {
        e.preventDefault();
        recordHandledEdit('Insert horizontal rule');
        return;
      }
    }
    if (e.inputType === 'insertText' && e.data === ' ') {
      if (handleHeadingShortcut(root)) {
        e.preventDefault();
        recordHandledEdit('Format block');
        return;
      }
      // "- " / "* " / "1. " start a list; "> " and ">note " start quotes.
      if (handleListShortcut(root)) {
        e.preventDefault();
        recordHandledEdit('Format list');
        return;
      }
      if (handleBlockquoteShortcut(root)) {
        e.preventDefault();
        recordHandledEdit('Format blockquote');
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
        recordHandledEdit('Type text');
        return;
      }
    }
    if (e.inputType === ENTIRE_LINE_INPUT_TYPE) {
      if (entireLineDeletionIsUnsafe(root)) e.preventDefault();
      return;
    }
    const deletion = DELETE_INPUT_TYPES.get(e.inputType);
    // A soft line is a VISUAL line, and the comment handlers below reproduce a
    // deletion by clipping it to the caret's own text node — which in a wrapped
    // paragraph spans several visual lines, so the clip would remove lines the
    // user never asked for. Where a comment is in range, consume the keystroke
    // and edit nothing instead: the same trade ENTIRE_LINE_INPUT_TYPE makes, for
    // the same reason (the line boxes are not visible to this code, and getting
    // the extent wrong deletes text rather than merely refusing to).
    if (deletion?.granularity === 'soft-line' && commentInCaretBlock(root)) {
      e.preventDefault();
      return;
    }
    if (deletion?.direction === 'backward') {
      // A backward deletion that reaches a comment must not let the browser
      // cross its contenteditable=false metadata. Word and line deletion keep
      // their native granularity only where the browser provably stops short of
      // the comment; everywhere else in the danger zone we perform the deletion
      // ourselves, clipped to the caret's own text node.
      const comment = handleCommentBackspace(root, deletion.granularity);
      if (comment) {
        e.preventDefault();
        // 'blocked' consumed the keystroke without editing anything, so it must
        // not mark the document dirty or push an undo step.
        if (comment === 'edited') recordHandledEdit('Delete content');
        return;
      }
      // Backspace at the very start of a block merges it into the previous
      // block. The browser default merge cuts through comments and may wrap
      // moved heading text in a presentational span. Word and line deletion go
      // through the same safe merge: at a block edge Chromium deletes no word
      // either way, it only performs that same destructive merge.
      if (handleBlockMergeBackspace(root)) {
        e.preventDefault();
        recordHandledEdit('Delete content');
        return;
      }
      if (handleEmptyBlockAtStructuralBoundary(root, deletion.direction)) {
        e.preventDefault();
        recordHandledEdit('Delete content');
        return;
      }
      // Chromium does not safely no-op at semantic block boundaries. In
      // particular, crossing a details/summary boundary can discard the
      // details body, and crossing a pre boundary can move text outside its
      // code wrapper. There is no unambiguous merge for these structures, so
      // keep both sides intact and consume the key without recording an edit.
      if (isProtectedStructuralBoundary(root, deletion.direction)) {
        e.preventDefault();
        return;
      }
      // The safe merge above only covers two mergeable leaf blocks. When it
      // declines — a list, a table, a quote holding nested blocks — the
      // deletion still crosses the boundary, and Chromium's range there takes a
      // comment's contenteditable=false body with it. Keep both blocks intact
      // instead, the same trade the structural guard makes.
      //
      // Every granularity, character included. A plain Delete at such a join was
      // measured destroying the metadata (see "Delete at a join with a commented
      // list keeps the comment" in tests/e2e/comment-delete-sweep.spec.ts), so
      // "a character deletion only touches what is beside the caret" does not
      // hold once the thing beside the caret is a block boundary.
      if (facesCommentAcrossBlockBoundary(root, deletion.direction)) {
        e.preventDefault();
        return;
      }
    }
    if (deletion?.direction === 'forward') {
      // Forward deletion applies the same rule mirrored: character Delete
      // always skips the hidden metadata, while word/line Delete is left to the
      // browser only when its range cannot reach the comment.
      const comment = handleCommentDelete(root, deletion.granularity);
      if (comment) {
        e.preventDefault();
        // See the backward branch: a 'blocked' keystroke records no edit.
        if (comment === 'edited') recordHandledEdit('Delete content');
        return;
      }
      // Delete at the very end of a block is the mirror of the Backspace merge,
      // and covers word/line input for the same reason.
      if (handleBlockMergeForward(root)) {
        e.preventDefault();
        recordHandledEdit('Delete content');
        return;
      }
      if (handleEmptyBlockAtStructuralBoundary(root, deletion.direction)) {
        e.preventDefault();
        recordHandledEdit('Delete content');
        return;
      }
      if (isProtectedStructuralBoundary(root, deletion.direction)) {
        e.preventDefault();
        return;
      }
      // Mirror of the backward guard above. This is the measured direction:
      // plain Delete at such a join strips the comment's body.
      if (facesCommentAcrossBlockBoundary(root, deletion.direction)) {
        e.preventDefault();
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

  root.addEventListener('input', (event: Event) => {
    const e = event as InputEvent;
    if (!composing) normalizePresentationalTags(root);
    removeQuotePlaceholders(root);
    scheduleChange();
    onNativeEdit?.(e.inputType);
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
    notifyChanged(label = 'Edit WYSIWYG content'): void {
      scheduleChange();
      onCommandEdit?.(label);
    },
  };
}

/**
 * Enter on the trailing empty line of a <pre> exits to a fresh paragraph. The
 * first Enter still falls through to Chromium and creates that empty line; the
 * second one removes it, preserving any <code> wrapper and the code before it.
 * Indentation-only lines count as empty and their whitespace is removed.
 * Whitespace-only blocks are removed after exit. For wrapper safety, this
 * cleanup unwraps no structure: only bare stubs or a sole <code> stub qualify,
 * while empty syntax-highlighting wrappers remain in their <pre>.
 */
function handleCodeBlockExit(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.startContainer)) return false;

  const pre = findAncestor(range.startContainer, 'PRE', root);
  if (!pre) return false;
  const lineBreak = findTrailingEmptyCodeLine(range, pre);
  if (!lineBreak) return false;

  const trailingLine = document.createRange();
  trailingLine.setStart(lineBreak.container, lineBreak.offset);
  trailingLine.setEnd(pre, pre.childNodes.length);
  trailingLine.deleteContents();

  const paragraph = document.createElement('p');
  paragraph.appendChild(document.createElement('br'));
  pre.after(paragraph);
  const code = pre.childNodes.length === 1 && pre.firstElementChild?.tagName === 'CODE'
    ? pre.firstElementChild
    : null;
  if (isBlockEmptyOrStubBr(pre) || (code && isBlockEmptyOrStubBr(code))) pre.remove();

  const caret = document.createRange();
  caret.setStart(paragraph, 0);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
  return true;
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
 * Enter in text stored directly under a blockquote is a soft line break inside
 * that same quote. Chromium's native contenteditable behavior clones the
 * blockquote as a sibling instead, which changes one quotation into two.
 * A second Enter on the trailing empty line exits to a normal paragraph.
 */
function handleBareBlockquoteEnter(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return false;

  const line = findBareBlockquoteLine(range.startContainer, root, range.startOffset);
  if (!line) return false;

  const lineEmpty = !line.first || !line.last || bareQuoteLineIsEmpty(line.first, line.last);
  if (lineEmpty && !line.nextBreak && line.previousBreak) {
    line.previousBreak.remove();
    removeQuotePlaceholders(line.blockquote);
    removeEmptyInlineEdge(line.blockquote.lastChild);

    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    line.blockquote.after(p);
    if (isBlockEmptyOrStubBr(line.blockquote)) line.blockquote.remove();

    const caret = document.createRange();
    caret.setStart(p, 0);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
    return true;
  }

  return insertBareBlockquoteBreak(range, root, selection);
}

function bareQuoteLineIsEmpty(first: Node, last: Node): boolean {
  let current: Node | null = first;
  while (current) {
    if (!isInsignificantTail(current)) return false;
    if (current === last) return true;
    current = current.nextSibling;
  }
  return true;
}

/** Split inline wrappers at range and insert a direct-child <br> in the quote. */
function insertBareBlockquoteBreak(
  range: Range,
  root: HTMLElement,
  selection: Selection,
): boolean {
  const run = findBareBlockquoteRun(range.startContainer, root, range.startOffset);
  if (!run) return false;

  const reference = run.last.nextSibling;
  const tailRange = document.createRange();
  tailRange.setStart(range.startContainer, range.startOffset);
  tailRange.setEndAfter(run.last);
  const tail = tailRange.extractContents();
  const tailHasContent = Array.from(tail.childNodes).some(
    (child) => !isInsignificantTail(child),
  );

  const br = document.createElement('br');
  run.blockquote.insertBefore(br, reference);
  if (tailHasContent) {
    run.blockquote.insertBefore(tail, reference);
  } else {
    const placeholder = document.createElement('br');
    placeholder.setAttribute(QUOTE_PLACEHOLDER_ATTR, '');
    run.blockquote.insertBefore(placeholder, reference);
  }
  removeEmptyInlineEdge(br.previousSibling);

  const caret = document.createRange();
  caret.setStartAfter(br);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
  return true;
}

function removeEmptyInlineEdge(node: Node | null): void {
  if (!node || node instanceof HTMLBRElement) return;
  if (isInsignificantTail(node)) node.parentNode?.removeChild(node);
}

function removeQuotePlaceholders(root: HTMLElement): void {
  for (const placeholder of Array.from(
    root.querySelectorAll(`br[${QUOTE_PLACEHOLDER_ATTR}]`),
  )) {
    placeholder.remove();
  }
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

// Blocks whose Backspace-at-start / Delete-at-end merge we take over from the
// browser. They carry inline content only: LI keeps the browser's list
// behavior, while PRE / SUMMARY / DETAILS are owned by
// commands/structural-boundary, which blocks the merge instead of performing it.
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
 * mergeable block (the inverse of keepCommentWholeOnEnter in
 * features/comment/comment-boundary). Returns whether it handled the deletion;
 * otherwise the browser default runs.
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
 * Whether a whole-line deletion at the caret would run over something the
 * browser default destroys (see {@link ENTIRE_LINE_INPUT_TYPE}).
 *
 * Deliberately a guard rather than a reimplementation: the keystroke is
 * consumed and nothing is edited, the same trade
 * {@link isProtectedStructuralBoundary} makes. Reproducing a whole-line
 * deletion ourselves would need the line boxes, which this code cannot see —
 * and getting it wrong deletes the user's text rather than merely refusing to.
 *
 * A whole-line deletion covers the caret's line in both directions at once, so
 * any comment in that line is inside its range — which is what
 * {@link commentInCaretBlock} answers. The structural pair is asked in both
 * directions for the same reason.
 */
function entireLineDeletionIsUnsafe(root: HTMLElement): boolean {
  return (
    commentInCaretBlock(root) ||
    isProtectedStructuralBoundary(root, 'backward') ||
    isProtectedStructuralBoundary(root, 'forward')
  );
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
  bareRoot: boolean;
  bareBlockquote: boolean;
  runStart: Node | null;
  runEnd: Node | null;
}

/**
 * The container a markdown block shortcut may transform: the caret's nearest
 * block (only when it is a plain <p>/<div>), or a bare table cell whose inline
 * content will be wrapped on commit (see {@link materializeShortcutBlock}).
 * Returns null when the caret is in a non-plain block (heading/list/pre/etc.) or
 * outside any block/cell. Read-only — it never mutates, so a plain space that
 * fails the per-shortcut marker test leaves the cell untouched.
 */
function shortcutTarget(
  range: Range,
  root: HTMLElement,
  allowBareBlockquote = false,
): ShortcutTarget | null {
  if (allowBareBlockquote) {
    const line = findBareBlockquoteLine(range.startContainer, root, range.startOffset);
    if (line) {
      return {
        el: line.blockquote,
        bareCell: false,
        bareRoot: false,
        bareBlockquote: true,
        runStart: line.first,
        runEnd: line.last,
      };
    }
  }
  const found = blockOrBareCell(range.startContainer, root);
  if (found) {
    if (!found.bareCell && !isPlainTextBlock(found.el)) return null;
    return {
      ...found,
      bareRoot: false,
      bareBlockquote: false,
      runStart: null,
      runEnd: null,
    };
  }
  const run = findBareRootRun(range.startContainer, root, range.startOffset);
  return run
    ? {
        el: root,
        bareCell: false,
        bareRoot: true,
        bareBlockquote: false,
        runStart: run.first,
        runEnd: run.last,
      }
    : null;
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
  if (!found.bareCell && !found.bareRoot && !found.bareBlockquote) {
    return { block: found.el, range };
  }
  if (found.bareBlockquote) {
    const block = ensureBlockquoteLineBlock(range.startContainer, root, range.startOffset);
    if (!block) return null;
    return { block, range: selection.getRangeAt(0) };
  }
  if (found.bareRoot) {
    const block = ensureBlockAtRoot(range.startContainer, root, range.startOffset);
    if (!block) return null;
    return { block, range: selection.getRangeAt(0) };
  }
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

  const match = /^(#{1,6})$/.exec(shortcutTextBeforeCursor(range, found));
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

  const before = shortcutTextBeforeCursor(range, found);
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
 * "> " typed at the start of a paragraph turns it into a blockquote.
 * GitHub-style markers such as ">note " create a typed alert blockquote.
 * The marker is removed; an empty quote keeps a <br> placeholder.
 */
function handleBlockquoteShortcut(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return false;

  const found = shortcutTarget(range, root);
  if (!found) return false;

  const marker = shortcutTextBeforeCursor(range, found);
  const match = /^>([a-z]+)$/i.exec(marker);
  const alertType = match ? alertTypeFromShortcut(match[1]) : null;
  if (marker !== '>' && !alertType) return false;

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
  if (alertType) quote.setAttribute('data-alert', alertType);
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

  const found = shortcutTarget(range, root, true);
  if (!found) return false;

  if (shortcutTargetText(found).trim() !== '```') return false;

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

function shortcutTextBeforeCursor(range: Range, target: ShortcutTarget): string {
  if ((!target.bareRoot && !target.bareBlockquote) || !target.runStart) {
    return textBeforeCursor(range, target.el);
  }
  const r = document.createRange();
  r.setStartBefore(target.runStart);
  r.setEnd(range.startContainer, range.startOffset);
  return r.toString();
}

function shortcutTargetText(target: ShortcutTarget): string {
  if ((!target.bareRoot && !target.bareBlockquote) || !target.runStart || !target.runEnd) {
    return target.el.textContent ?? '';
  }
  const r = document.createRange();
  r.setStartBefore(target.runStart);
  r.setEndAfter(target.runEnd);
  return r.toString();
}
