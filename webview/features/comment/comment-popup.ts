// Comment popup: shows the body and replies for a single <comment> element,
// lets the user edit them inline, add or remove replies, navigate to the
// previous/next comment, and delete the whole comment.

import * as cdom from './comment-dom';
import { removeComment } from './comment-commands';
import { setupTooltip } from '../../ui/tooltip';
import { openConfirmDialog } from '../../ui/confirm-dialog';

export interface CommentPopupOptions {
  /** Called after any DOM mutation inside the comment so the editor can serialize. */
  onChange(): void;
}

export interface CommentPopupHandle {
  open(comment: Element): void;
  close(): void;
  /** Re-render in place if the currently open comment is the given one (after external edits). */
  refreshIfOpen(comment: Element): void;
  /** Returns the popup root element so the page can ignore clicks targeting it. */
  element(): HTMLElement;
}

const MARGIN = 8;
const VIEWPORT_PADDING = 8;

export function mountCommentPopup(
  root: HTMLElement,
  opts: CommentPopupOptions,
): CommentPopupHandle {
  let current: Element | null = null;

  const popup = document.createElement('div');
  popup.id = 'ahve-comment-popup';
  popup.hidden = true;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Comment');

  const header = document.createElement('div');
  header.className = 'ahve-cp-header';

  const prevBtn = headerBtn('↑', 'Previous comment', () => navigate(-1));
  const nextBtn = headerBtn('↓', 'Next comment', () => navigate(1));
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
  popup.addEventListener('mousedown', (e) => {
    if (e.target instanceof HTMLElement) {
      const tag = e.target.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
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
        // Let Escape blur the textarea first.
        target.blur();
        return;
      }
      e.preventDefault();
      close();
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (popup.hidden || current === null) return;
    const target = e.target as Node | null;
    if (!target) return;
    if (popup.contains(target)) return;
    if (current.contains(target)) return;
    // A modal confirm dialog (e.g. the counterpart-edit guard) renders above the
    // popup; clicking it must not be treated as an outside click that closes us.
    if (target instanceof Element && target.closest('.ahve-dialog-overlay')) return;
    close();
  });

  window.addEventListener('scroll', () => reposition(), { passive: true });
  window.addEventListener('resize', () => reposition());

  function open(comment: Element): void {
    current = comment;
    render();
    popup.hidden = false;
    reposition();
  }

  function close(): void {
    current = null;
    popup.hidden = true;
  }

  function refreshIfOpen(comment: Element): void {
    if (current === comment) render();
  }

  function render(): void {
    if (!current) return;
    renderBody();
    renderReplies();
    replyInput.value = '';
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
      display.classList.add('ahve-cp-empty');
      display.textContent = 'Add a comment';
    } else {
      display.textContent = text;
    }
    display.addEventListener('click', () => {
      void editBody();
    });
    bodySection.appendChild(display);
  }

  async function editBody(): Promise<void> {
    if (!current) return;
    const body = bodyEl(current);
    if (body && cdom.isCounterpart(body) && !(await confirmCounterpartEdit('edit'))) return;
    if (!current) return;
    const ta = document.createElement('textarea');
    ta.className = 'ahve-cp-body-input';
    ta.value = cdom.getBody(current);
    ta.rows = Math.max(2, ta.value.split('\n').length);
    bodySection.replaceChildren(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    const commit = (): void => {
      if (!current) return;
      cdom.setBody(current, ta.value);
      opts.onChange();
      renderBody();
    };
    const cancel = (): void => {
      renderBody();
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });
    ta.addEventListener('blur', commit, { once: true });
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
    display.addEventListener('click', () => {
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
    if (cdom.isCounterpart(reply) && !(await confirmCounterpartEdit('edit'))) return;
    const ta = document.createElement('textarea');
    ta.className = 'ahve-cp-reply-input';
    ta.value = reply.textContent ?? '';
    ta.rows = Math.max(1, ta.value.split('\n').length);
    row.replaceChildren(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    const commit = (): void => {
      cdom.updateReply(reply, ta.value);
      opts.onChange();
      renderReplies();
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        renderReplies();
      }
    });
    ta.addEventListener('blur', commit, { once: true });
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

  async function deleteCurrent(): Promise<void> {
    if (!current) return;
    const target = current;
    if (cdom.hasCounterpartEntry(target) && !(await confirmCounterpartEdit('delete'))) return;
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
    element: () => popup,
  };
}

function bodyEl(comment: Element): Element | null {
  return comment.querySelector(':scope > comment-body');
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
