// Helpers that treat the DOM as the comment store.
// A comment is represented as:
//   <comment id="c-xxxxxx" data-resolved>target text<comment-body data-author="ai" data-updated="...">body</comment-body><comment-reply data-author="human" data-updated="...">reply</comment-reply>...</comment>
// The popup UI and commands read/write directly from these elements; there is
// no separate metadata store. Each body/reply carries its own author and last
// update time; `data-resolved` lives on the <comment> parent (thread scope).

import { deepestEditableText } from '../../shared/dom-utils';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 8;

// Author label written when a human edits in the WYSIWYG view. The human side
// may become multiple named users in the future, so this is just the default
// local label, not the value the counterpart check keys off.
export const LOCAL_AUTHOR = 'human';
// Fixed label for the AI side. "Is this the counterpart?" is decided by
// matching this value (not by comparing against LOCAL_AUTHOR), so adding more
// human users later does not break the check.
export const AI_AUTHOR = 'ai';

const ATTR_AUTHOR = 'data-author';
const ATTR_UPDATED = 'data-updated';
const ATTR_RESOLVED = 'data-resolved';

export function newCommentId(root: HTMLElement): string {
  for (let attempt = 0; attempt < 16; attempt++) {
    const id = 'c-' + randomString(ID_LENGTH);
    if (!root.querySelector(`comment[id="${id}"]`)) return id;
  }
  // Extremely unlikely; fall back to a longer id.
  return 'c-' + randomString(ID_LENGTH * 2);
}

export function findCommentById(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector(`comment[id="${cssEscape(id)}"]`);
}

/**
 * Deepest, first non-empty text node within a comment's editable target region
 * (the content before the first <comment-body>/<comment-reply>), or null.
 *
 * The target region is what the reader sees and the only part of a comment an
 * edit may touch, so both the deletion handlers and the arrow/typing boundary
 * handlers resolve it through this pair rather than each walking the children
 * themselves.
 */
export function firstNonEmptyTargetText(comment: Element): Text | null {
  return targetText(comment, false);
}

/** Mirror of {@link firstNonEmptyTargetText}, taken from the target's end. */
export function lastNonEmptyTargetText(comment: Element): Text | null {
  return targetText(comment, true);
}

function targetText(comment: Element, atEnd: boolean): Text | null {
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
  const order = atEnd
    ? Array.from({ length: end }, (_, i) => end - 1 - i)
    : Array.from({ length: end }, (_, i) => i);
  for (const i of order) {
    const found = deepestEditableText(kids[i], atEnd);
    if (found) return found;
  }
  return null;
}

export function getBody(comment: Element): string {
  const body = comment.querySelector(':scope > comment-body');
  return body?.textContent ?? '';
}

/**
 * Set the comment body text. On first creation the body records its author; on
 * later edits the author is preserved (so the counterpart's attribution stays)
 * and only the update time is refreshed.
 */
export function setBody(comment: Element, text: string, author: string = LOCAL_AUTHOR): void {
  let body = comment.querySelector(':scope > comment-body');
  if (!body) {
    body = document.createElement('comment-body');
    body.setAttribute('contenteditable', 'false');
    body.setAttribute(ATTR_AUTHOR, author);
    // Insert before any existing replies so the document order stays:
    // target text, body, replies.
    const firstReply = comment.querySelector(':scope > comment-reply');
    if (firstReply) {
      comment.insertBefore(body, firstReply);
    } else {
      comment.appendChild(body);
    }
  }
  body.textContent = text;
  touch(body);
}

export function getReplies(comment: Element): Element[] {
  return Array.from(comment.querySelectorAll(':scope > comment-reply'));
}

export function addReply(comment: Element, text: string, author: string = LOCAL_AUTHOR): HTMLElement {
  const reply = document.createElement('comment-reply');
  reply.setAttribute('contenteditable', 'false');
  reply.setAttribute(ATTR_AUTHOR, author);
  reply.textContent = text;
  touch(reply);
  comment.appendChild(reply);
  return reply;
}

/** Update reply text, refreshing the update time but keeping the author. */
export function updateReply(reply: Element, text: string): void {
  reply.textContent = text;
  touch(reply);
}

export function removeReply(reply: Element): void {
  reply.remove();
}

/** Author label of a body/reply entry. Empty string when unset (legacy data). */
export function getAuthor(entry: Element): string {
  return entry.getAttribute(ATTR_AUTHOR) ?? '';
}

/** Last-updated timestamp (ISO 8601) of a body/reply entry, or '' when unset. */
export function getUpdated(entry: Element): string {
  return entry.getAttribute(ATTR_UPDATED) ?? '';
}

/** True when the entry was authored by the AI side (the editing human's counterpart). */
export function isCounterpart(entry: Element): boolean {
  return getAuthor(entry) === AI_AUTHOR;
}

/** True when a comment contains any body/reply authored by the counterpart (AI). */
export function hasCounterpartEntry(comment: Element): boolean {
  const body = comment.querySelector(':scope > comment-body');
  if (body && isCounterpart(body)) return true;
  return getReplies(comment).some((r) => isCounterpart(r));
}

export function isResolved(comment: Element): boolean {
  return comment.hasAttribute(ATTR_RESOLVED);
}

export function setResolved(comment: Element, resolved: boolean): void {
  if (resolved) {
    comment.setAttribute(ATTR_RESOLVED, '');
  } else {
    comment.removeAttribute(ATTR_RESOLVED);
  }
}

/** Stamp an entry's last-updated time with the current instant (ISO 8601). */
function touch(entry: Element): void {
  entry.setAttribute(ATTR_UPDATED, new Date().toISOString());
}

export function commentsInDocumentOrder(root: HTMLElement): Element[] {
  return Array.from(root.querySelectorAll('comment[id]'));
}

/** Mark body/reply children as non-editable so contenteditable does not let the user type inside them. */
export function lockChildren(comment: Element): void {
  for (const child of Array.from(comment.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === 'comment-body' || tag === 'comment-reply') {
      child.setAttribute('contenteditable', 'false');
    }
  }
}

function randomString(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return out;
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
}
