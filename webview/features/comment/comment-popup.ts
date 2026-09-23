// Comment popup: shows the body and replies for a single <comment> element,
// lets the user edit them inline, add or remove replies, navigate to the
// previous/next comment (header buttons or arrow keys), and delete the whole
// comment.

import * as cdom from './comment-dom';
import { removeComment } from './comment-commands';
import { hideTooltipFor, setupTooltip } from '../../ui/tooltip';
import { openConfirmDialog } from '../../ui/confirm-dialog';

export interface CommentPopupOptions {
  /** Called after any DOM mutation inside the comment so the editor can serialize. */
  onChange(): void;
}

export interface CommentPopupHandle {
  /** Show the popup for a comment; `editBody` opens the body editor focused. */
  open(comment: Element, options?: { editBody?: boolean }): void;
  close(): void;
  /** Re-render in place if the currently open comment is the given one (after external edits). */
  refreshIfOpen(comment: Element): void;
  /**
   * Commit any in-progress body/reply edit and pending reply-input text into
   * the DOM. Save flows call this before serializing so text still open in a
   * textarea reaches the file.
   */
  flushPending(): void;
  /**
   * Re-bind the popup after the editor DOM was remounted (save echo, undo/
   * redo, revert, external change): point at the same comment id in the
   * fresh DOM, or close when the comment is gone.
   */
  resyncAfterRemount(): void;
  /** Returns the popup root element so the page can ignore clicks targeting it. */
  element(): HTMLElement;
}

/**
 * Handle for the body/reply textarea currently being edited. Both methods are
 * exactly-once: the first commit/cancel wins and later calls (e.g. a stray
 * blur after a manual commit) are no-ops.
 */
interface ActiveInlineEdit {
  commit(): void;
  cancel(): void;
}

const MARGIN = 8;
const VIEWPORT_PADDING = 8;

/**
 * Displayed text the user may select natively. The empty-body placeholder
 * ("Add a comment") is UI chrome rather than comment content, so it stays
 * unselectable and any press on it means "start writing the body".
 */
const SELECTABLE_DISPLAY = '.ahve-cp-body-display:not(.ahve-cp-empty), .ahve-cp-reply-display';

/** Pointer travel (px) up to which a press/release still counts as a click. */
const CLICK_SLOP = 4;

/** Arrow keys that step to the previous (-1) or next (1) comment while the popup is shown. */
const ARROW_DIRECTION: Partial<Record<string, -1 | 1>> = {
  ArrowUp: -1,
  ArrowLeft: -1,
  ArrowDown: 1,
  ArrowRight: 1,
};

export function mountCommentPopup(
  root: HTMLElement,
  opts: CommentPopupOptions,
): CommentPopupHandle {
  let current: Element | null = null;
  let activeEdit: ActiveInlineEdit | null = null;

  const popup = document.createElement('div');
  popup.id = 'ahve-comment-popup';
  popup.hidden = true;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Comment');

  const header = document.createElement('div');
  header.className = 'ahve-cp-header';

  const prevBtn = headerBtn('↑', 'Previous comment (↑/←)', () => navigate(-1));
  prevBtn.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowLeft');
  const nextBtn = headerBtn('↓', 'Next comment (↓/→)', () => navigate(1));
  nextBtn.setAttribute('aria-keyshortcuts', 'ArrowDown ArrowRight');
  const spacer = document.createElement('span');
  spacer.className = 'ahve-cp-spacer';
  const resolveBtn = headerBtn('✓', 'Toggle resolved', () => toggleResolved());
  const trashBtn = headerBtn('🗑', 'Delete comment', () => {
    void deleteCurrent();
  });
  const closeBtn = headerBtn('×', 'Close', () => close());

  header.append(prevBtn, nextBtn, spacer, resolveBtn, trashBtn, closeBtn);

  const bodySection = document.createElement('div');
  bodySection.className = 'ahve-cp-body';

  const repliesSection = document.createElement('div');
  repliesSection.className = 'ahve-cp-replies';

  // The body + replies scroll together in this middle region so that, once the
  // thread outgrows the viewport, the header and reply form stay pinned while
  // only this area scrolls (see .ahve-cp-content in comment-popup.css).
  const content = document.createElement('div');
  content.className = 'ahve-cp-content';
  content.append(bodySection, repliesSection);

  const replyForm = document.createElement('div');
  replyForm.className = 'ahve-cp-reply-form';
  const replyInput = document.createElement('textarea');
  replyInput.className = 'ahve-cp-reply-input';
  replyInput.placeholder = 'Reply';
  replyInput.rows = 1;
  replyForm.appendChild(replyInput);

  popup.append(header, content, replyForm);
  document.body.appendChild(popup);

  // Prevent the editor from losing selection when the popup is clicked.
  // Displayed body/reply text is exempt so it stays natively selectable — but
  // only while no inline editor is open: letting a textarea blur mid-drag
  // would commit it and re-render, moving the text out from under the pointer.
  popup.addEventListener('mousedown', (e) => {
    if (e.target instanceof HTMLElement) {
      const tag = e.target.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (activeEdit === null && e.target.closest(SELECTABLE_DISPLAY)) return;
    }
    e.preventDefault();
  });

  replyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitReply();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (popup.hidden) return;
    if (e.key === 'Escape') {
      const target = e.target as Element | null;
      if (target && popup.contains(target) && target instanceof HTMLTextAreaElement) {
        // Let Escape blur the textarea first. Escape means "cancel this
        // field", so pending reply-input text is discarded, not submitted.
        if (target === replyInput) replyInput.value = '';
        target.blur();
        return;
      }
      e.preventDefault();
      close();
    }
  });

  // The plain arrow keys step between comments like the ↑/↓ buttons. Focus
  // stays in the editor while the popup is open, so the key is taken in the
  // capture phase and stopped there: the editor's own ArrowLeft/ArrowRight
  // handling at comment boundaries must not also move the caret under the popup.
  document.addEventListener(
    'keydown',
    (e) => {
      if (popup.hidden) return;
      const direction = arrowNavigation(e);
      if (direction === null) return;
      // Consumed even when there is no comment further in that direction, so
      // the caret never moves under the popup at either end of the list.
      e.preventDefault();
      e.stopPropagation();
      navigate(direction);
    },
    true,
  );

  document.addEventListener('mousedown', (e) => {
    if (popup.hidden || current === null) return;
    const target = e.target as Node | null;
    if (!target) return;
    if (popup.contains(target)) return;
    if (current.contains(target)) return;
    // A modal confirm dialog (e.g. the counterpart-edit guard) renders above the
    // popup; clicking it must not be treated as an outside click that closes us.
    if (target instanceof Element && target.closest('.ahve-dialog-overlay')) return;
    // The search widget opens this popup when the query hits a comment thread
    // id. Pressing its buttons (next/previous, the toggles) would otherwise
    // close the very comment it just revealed, and the re-open that follows
    // would commit whatever edit was in progress.
    if (target instanceof Element && target.closest('#ahve-search')) return;
    close();
  });

  window.addEventListener('scroll', () => reposition(), { passive: true });
  window.addEventListener('resize', () => reposition());

  function open(comment: Element, options?: { editBody?: boolean }): void {
    // Leaving the previously shown comment (navigate / switch): persist its
    // pending edits before `current` is reassigned.
    commitPending();
    current = comment;
    render();
    popup.hidden = false;
    // Anchor the popup to the comment BEFORE focusing the body editor: until
    // the first reposition() the popup has no top/left and lays out at the
    // end of <body>, so focusing it first scrolls the page to the bottom.
    reposition();
    if (options?.editBody) void editBody();
  }

  function close(): void {
    // Commit while `current` is still set and the popup is still visible, so
    // the settle re-render detaches the textarea before the popup hides.
    commitPending();
    current = null;
    popup.hidden = true;
    // A tooltip anchored to a popup button would linger otherwise:
    // mouseleave never fires on an element hidden under the pointer.
    hideTooltipFor(popup);
  }

  function refreshIfOpen(comment: Element): void {
    if (current !== comment) return;
    activeEdit?.commit();
    render();
  }

  function render(): void {
    if (!current) return;
    renderBody();
    renderReplies();
    updateNavButtons();
    updateResolveButton();
  }

  function updateResolveButton(): void {
    if (!current) return;
    resolveBtn.classList.toggle('ahve-cp-resolved-on', cdom.isResolved(current));
  }

  function toggleResolved(): void {
    if (!current) return;
    cdom.setResolved(current, !cdom.isResolved(current));
    opts.onChange();
    updateResolveButton();
  }

  function renderBody(): void {
    bodySection.replaceChildren();
    if (!current) return;
    const body = bodyEl(current);
    const text = cdom.getBody(current);
    if (text !== '' && body) {
      const meta = metaLine(body);
      if (meta) bodySection.appendChild(meta);
    }
    const display = document.createElement('div');
    display.className = 'ahve-cp-body-display';
    if (text === '') {
      // Placeholder: nothing to select, so every press opens the editor.
      display.classList.add('ahve-cp-empty');
      display.textContent = 'Add a comment';
      display.addEventListener('click', () => {
        void editBody();
      });
    } else {
      display.textContent = text;
      onDisplayClick(display, () => {
        void editBody();
      });
    }
    bodySection.appendChild(display);
  }

  async function editBody(): Promise<void> {
    if (!current) return;
    const target = current;
    const body = bodyEl(target);
    if (body && cdom.isCounterpart(body) && !(await confirmCounterpartEdit('edit'))) return;
    if (current !== target) return;
    const original = cdom.getBody(target);
    const ta = document.createElement('textarea');
    ta.className = 'ahve-cp-body-input';
    ta.value = original;
    ta.rows = Math.max(2, ta.value.split('\n').length);
    bodySection.replaceChildren(ta);

    // Settle exactly once: commit writes into the comment captured at edit
    // start (not the live `current`, which close() nulls before blur fires),
    // and an unchanged value is a no-op so passing through the auto-opened
    // editor does not record history or backups.
    let settled = false;
    const settle = (commitIt: boolean): void => {
      if (settled) return;
      settled = true;
      if (activeEdit === edit) activeEdit = null;
      if (commitIt && ta.value !== original) {
        cdom.setBody(target, ta.value);
        opts.onChange();
      }
      if (current === target) renderBody();
    };
    const edit: ActiveInlineEdit = {
      commit: () => settle(true),
      cancel: () => settle(false),
    };
    activeEdit = edit;

    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        settle(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        settle(false);
      }
    });
    ta.addEventListener('blur', () => settle(true));

    // preventScroll: reposition() keeps the popup inside the viewport, so
    // focus must never scroll the document to wherever the popup happens to
    // be laid out at this instant.
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
    // The textarea is taller than the display div; keep the popup on-screen.
    reposition();
  }

  function renderReplies(): void {
    repliesSection.replaceChildren();
    if (!current) return;
    const replies = cdom.getReplies(current);
    for (const reply of replies) {
      repliesSection.appendChild(renderReplyRow(reply));
    }
  }

  function renderReplyRow(reply: Element): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ahve-cp-reply-row';

    const main = document.createElement('div');
    main.className = 'ahve-cp-reply-main';
    const meta = metaLine(reply);
    if (meta) main.appendChild(meta);

    const display = document.createElement('div');
    display.className = 'ahve-cp-reply-display';
    display.textContent = reply.textContent ?? '';
    onDisplayClick(display, () => {
      void editReply(reply, row);
    });
    main.appendChild(display);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ahve-cp-reply-del';
    setupTooltip(del, 'Delete reply');
    del.textContent = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      void (async (): Promise<void> => {
        if (cdom.isCounterpart(reply) && !(await confirmCounterpartEdit('delete'))) return;
        cdom.removeReply(reply);
        opts.onChange();
        renderReplies();
      })();
    });

    row.append(main, del);
    return row;
  }

  async function editReply(reply: Element, row: HTMLElement): Promise<void> {
    const owner = current;
    if (cdom.isCounterpart(reply) && !(await confirmCounterpartEdit('edit'))) return;
    if (current !== owner) return;
    const original = reply.textContent ?? '';
    const ta = document.createElement('textarea');
    ta.className = 'ahve-cp-reply-input';
    ta.value = original;
    ta.rows = Math.max(1, ta.value.split('\n').length);
    row.replaceChildren(ta);

    // Same exactly-once settle contract as editBody (see the comment there).
    let settled = false;
    const settle = (commitIt: boolean): void => {
      if (settled) return;
      settled = true;
      if (activeEdit === edit) activeEdit = null;
      if (commitIt && ta.value !== original) {
        cdom.updateReply(reply, ta.value);
        opts.onChange();
      }
      if (current === owner) renderReplies();
    };
    const edit: ActiveInlineEdit = {
      commit: () => settle(true),
      cancel: () => settle(false),
    };
    activeEdit = edit;

    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        settle(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        settle(false);
      }
    });
    ta.addEventListener('blur', () => settle(true));

    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
    reposition();
  }

  function submitReply(): void {
    if (!current) return;
    const text = replyInput.value.trim();
    if (text === '') return;
    cdom.addReply(current, text);
    replyInput.value = '';
    opts.onChange();
    renderReplies();
  }

  /**
   * Commit-on-leave: when focus leaves the comment (popup closes, or it
   * switches to another comment), persist the textarea being edited and
   * submit any pending reply-input text instead of dropping them.
   */
  function commitPending(): void {
    activeEdit?.commit();
    if (current) submitReply();
    replyInput.value = '';
  }

  /** Drop pending edits without committing (the comment is being deleted). */
  function discardPending(): void {
    activeEdit?.cancel();
    replyInput.value = '';
  }

  function resyncAfterRemount(): void {
    if (popup.hidden || !current) return;
    // An edit still active here targets the detached pre-remount DOM; save
    // flows flush pending edits before the remount, so cancelling drops
    // nothing that was meant to be kept.
    activeEdit?.cancel();
    const id = current.getAttribute('id');
    const replacement =
      id !== null ? root.querySelector(`comment[id="${CSS.escape(id)}"]`) : null;
    if (!replacement) {
      // Do not go through close(): its commitPending would submit pending
      // reply text into the detached element. The comment is gone; drop it.
      current = null;
      popup.hidden = true;
      hideTooltipFor(popup);
      replyInput.value = '';
      return;
    }
    current = replacement;
    render();
    reposition();
  }

  async function deleteCurrent(): Promise<void> {
    if (!current) return;
    const target = current;
    if (cdom.hasCounterpartEntry(target) && !(await confirmCounterpartEdit('delete'))) return;
    discardPending();
    close();
    removeComment({ root }, target);
    opts.onChange();
  }

  /**
   * Confirm before the editing human overwrites or removes content the
   * counterpart (AI) authored. Returns true when the user proceeds.
   */
  function confirmCounterpartEdit(kind: 'edit' | 'delete'): Promise<boolean> {
    const message =
      kind === 'delete'
        ? 'This comment contains content written by the AI. Delete it anyway?'
        : 'This was written by the AI. Edit it anyway?';
    return openConfirmDialog({
      title: 'Edit the AI’s comment?',
      message,
      confirmLabel: kind === 'delete' ? 'Delete' : 'Edit',
      danger: kind === 'delete',
    });
  }

  /**
   * Build the "Author · time" metadata line for a body/reply entry, or null
   * when the entry carries no metadata (e.g. legacy comments without author).
   */
  function metaLine(entry: Element): HTMLElement | null {
    const author = cdom.getAuthor(entry);
    const parts = [formatAuthor(author), formatTime(cdom.getUpdated(entry))].filter((p) => p !== '');
    if (parts.length === 0) return null;
    const meta = document.createElement('div');
    meta.className = 'ahve-cp-meta';
    meta.classList.toggle('ahve-cp-meta-ai', author === cdom.AI_AUTHOR);
    meta.textContent = parts.join(' · ');
    return meta;
  }

  function updateNavButtons(): void {
    if (!current) return;
    const all = cdom.commentsInDocumentOrder(root);
    const index = all.indexOf(current);
    prevBtn.disabled = index <= 0;
    nextBtn.disabled = index === -1 || index >= all.length - 1;
  }

  function navigate(direction: -1 | 1): void {
    if (!current) return;
    const all = cdom.commentsInDocumentOrder(root);
    const index = all.indexOf(current);
    if (index === -1) return;
    const next = all[index + direction];
    if (!next) return;
    next.scrollIntoView({ behavior: 'smooth', block: 'center' });
    open(next);
  }

  /**
   * The direction an arrow keystroke navigates in, or null when the key is not
   * the popup's to take: a modified or composing key, a text field moving its
   * own caret, a modal dialog covering the popup, or other UI such as the
   * toolbar or the search widget.
   */
  function arrowNavigation(e: KeyboardEvent): -1 | 1 | null {
    const direction = ARROW_DIRECTION[e.key];
    if (direction === undefined) return null;
    if (e.isComposing || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return null;
    // Checked directly rather than through the key target: a click on a
    // modal's non-focusable text leaves focus on <body>.
    if (document.querySelector('.ahve-dialog-overlay')) return null;
    const target = e.target;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return null;
    if (!(target instanceof Node)) return null;
    // <body> holds focus once a committed body/reply editor is removed.
    if (target === document.body || root.contains(target) || popup.contains(target)) {
      return direction;
    }
    return null;
  }

  function reposition(): void {
    if (popup.hidden || !current) return;
    const rect = current.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const viewportW = document.documentElement.clientWidth;
    const viewportH = document.documentElement.clientHeight;

    let top = rect.bottom + MARGIN;
    if (top + popupRect.height > viewportH - VIEWPORT_PADDING) {
      top = Math.max(VIEWPORT_PADDING, rect.top - popupRect.height - MARGIN);
    }
    let left = rect.left;
    if (left + popupRect.width > viewportW - VIEWPORT_PADDING) {
      left = Math.max(VIEWPORT_PADDING, viewportW - popupRect.width - VIEWPORT_PADDING);
    }

    popup.style.top = `${top + window.scrollY}px`;
    popup.style.left = `${left + window.scrollX}px`;
  }

  return {
    open,
    close,
    refreshIfOpen,
    flushPending: commitPending,
    resyncAfterRemount,
    element: () => popup,
  };
}

function bodyEl(comment: Element): Element | null {
  return comment.querySelector(':scope > comment-body');
}

/**
 * Run `activate` on a click that means "edit this text", telling it apart from
 * the click that merely ends a drag-selection (which must keep the selection).
 *
 * Pointer travel decides, not selection state: a mousedown landing inside an
 * existing selection keeps that selection alive until the browser has settled
 * whether a drag started, so a plain click on already-selected text can still
 * see a non-collapsed selection and would never reach the editor.
 *
 * A double-click is not special-cased: its first click opens the editor, and
 * the word selection then happens inside the textarea. Display-mode selection
 * is therefore drag-only, which keeps click-to-edit instant.
 */
function onDisplayClick(display: HTMLElement, activate: () => void): void {
  let downAt: { x: number; y: number } | null = null;
  display.addEventListener('mousedown', (e) => {
    downAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  });
  display.addEventListener('click', (e) => {
    const from = downAt;
    downAt = null;
    // Travel is only measurable for a click that a real press produced.
    // detail === 0 marks a click with no pointer behind it (element .click(),
    // assistive activation): its coordinates are 0, and a press released
    // outside this element leaves `from` set with no click to consume it — so
    // comparing the two would swallow the activation. Treat it as a plain one.
    if (e.detail !== 0 && from) {
      const moved =
        Math.abs(e.clientX - from.x) > CLICK_SLOP || Math.abs(e.clientY - from.y) > CLICK_SLOP;
      if (moved) return;
    }
    activate();
  });
}

function formatAuthor(author: string): string {
  if (author === cdom.AI_AUTHOR) return 'AI';
  if (author === cdom.LOCAL_AUTHOR) return 'Human';
  // Future: human side may carry specific user names — show them verbatim.
  return author;
}

function formatTime(iso: string): string {
  if (iso === '') return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function headerBtn(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ahve-cp-btn';
  setupTooltip(b, title);
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
