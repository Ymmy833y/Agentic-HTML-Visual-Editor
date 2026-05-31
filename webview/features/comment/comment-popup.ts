// Comment popup: shows the body and replies for a single <comment> element,
// lets the user edit them inline, add or remove replies, navigate to the
// previous/next comment, and delete the whole comment.

import * as cdom from './comment-dom';
import { removeComment } from './comment-commands';
import { setupTooltip } from '../../ui/tooltip';

export interface CommentPopupOptions {
  /** Called after any DOM mutation inside the comment so the editor can serialize. */
  onChange(): void;
}

export interface CommentPopupHandle {
  open(comment: HTMLElement): void;
  close(): void;
  /** Re-render in place if the currently open comment is the given one (after external edits). */
  refreshIfOpen(comment: HTMLElement): void;
  /** Returns the popup root element so the page can ignore clicks targeting it. */
  element(): HTMLElement;
}

const MARGIN = 8;
const VIEWPORT_PADDING = 8;

export function mountCommentPopup(
  root: HTMLElement,
  opts: CommentPopupOptions,
): CommentPopupHandle {
  let current: HTMLElement | null = null;

  const popup = document.createElement('div');
  popup.id = 'hw-comment-popup';
  popup.hidden = true;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Comment');

  const header = document.createElement('div');
  header.className = 'hw-cp-header';

  const prevBtn = headerBtn('↑', 'Previous comment', () => navigate(-1));
  const nextBtn = headerBtn('↓', 'Next comment', () => navigate(1));
  const spacer = document.createElement('span');
  spacer.className = 'hw-cp-spacer';
  const trashBtn = headerBtn('🗑', 'Delete comment', () => deleteCurrent());
  const closeBtn = headerBtn('×', 'Close', () => close());

  header.append(prevBtn, nextBtn, spacer, trashBtn, closeBtn);

  const bodySection = document.createElement('div');
  bodySection.className = 'hw-cp-body';

  const repliesSection = document.createElement('div');
  repliesSection.className = 'hw-cp-replies';

  const replyForm = document.createElement('div');
  replyForm.className = 'hw-cp-reply-form';
  const replyInput = document.createElement('textarea');
  replyInput.className = 'hw-cp-reply-input';
  replyInput.placeholder = 'Reply';
  replyInput.rows = 1;
  replyForm.appendChild(replyInput);

  popup.append(header, bodySection, repliesSection, replyForm);
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
    close();
  });

  window.addEventListener('scroll', () => reposition(), { passive: true });
  window.addEventListener('resize', () => reposition());

  function open(comment: HTMLElement): void {
    current = comment;
    render();
    popup.hidden = false;
    reposition();
  }

  function close(): void {
    current = null;
    popup.hidden = true;
  }

  function refreshIfOpen(comment: HTMLElement): void {
    if (current === comment) render();
  }

  function render(): void {
    if (!current) return;
    renderBody();
    renderReplies();
    replyInput.value = '';
    updateNavButtons();
  }

  function renderBody(): void {
    bodySection.replaceChildren();
    if (!current) return;
    const display = document.createElement('div');
    display.className = 'hw-cp-body-display';
    const text = cdom.getBody(current);
    if (text === '') {
      display.classList.add('hw-cp-empty');
      display.textContent = 'Add a comment';
    } else {
      display.textContent = text;
    }
    display.addEventListener('click', () => editBody());
    bodySection.appendChild(display);
  }

  function editBody(): void {
    if (!current) return;
    const ta = document.createElement('textarea');
    ta.className = 'hw-cp-body-input';
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

  function renderReplyRow(reply: HTMLElement): HTMLElement {
    const row = document.createElement('div');
    row.className = 'hw-cp-reply-row';

    const display = document.createElement('div');
    display.className = 'hw-cp-reply-display';
    display.textContent = reply.textContent ?? '';
    display.addEventListener('click', () => editReply(reply, row));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'hw-cp-reply-del';
    setupTooltip(del, 'Delete reply');
    del.textContent = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      cdom.removeReply(reply);
      opts.onChange();
      renderReplies();
    });

    row.append(display, del);
    return row;
  }

  function editReply(reply: HTMLElement, row: HTMLElement): void {
    const ta = document.createElement('textarea');
    ta.className = 'hw-cp-reply-input';
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

  function deleteCurrent(): void {
    if (!current) return;
    const target = current;
    close();
    removeComment({ root }, target);
    opts.onChange();
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

function headerBtn(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'hw-cp-btn';
  setupTooltip(b, title);
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
