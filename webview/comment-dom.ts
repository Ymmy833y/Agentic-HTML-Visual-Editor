// Helpers that treat the DOM as the comment store.
// A comment is represented as:
//   <comment id="c-xxxxxx">target text<comment-body>body</comment-body><comment-reply>reply</comment-reply>...</comment>
// The popup UI and commands read/write directly from these elements; there is
// no separate metadata store.

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 8;

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

export function getBody(comment: HTMLElement): string {
  const body = comment.querySelector(':scope > comment-body');
  return body?.textContent ?? '';
}

export function setBody(comment: HTMLElement, text: string): void {
  let body = comment.querySelector(':scope > comment-body') as HTMLElement | null;
  if (!body) {
    body = document.createElement('comment-body');
    body.setAttribute('contenteditable', 'false');
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
}

export function getReplies(comment: HTMLElement): HTMLElement[] {
  return Array.from(comment.querySelectorAll(':scope > comment-reply')) as HTMLElement[];
}

export function addReply(comment: HTMLElement, text: string): HTMLElement {
  const reply = document.createElement('comment-reply');
  reply.setAttribute('contenteditable', 'false');
  reply.textContent = text;
  comment.appendChild(reply);
  return reply;
}

export function updateReply(reply: HTMLElement, text: string): void {
  reply.textContent = text;
}

export function removeReply(reply: HTMLElement): void {
  reply.remove();
}

export function commentsInDocumentOrder(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll('comment[id]')) as HTMLElement[];
}

/** Mark body/reply children as non-editable so contenteditable does not let the user type inside them. */
export function lockChildren(comment: HTMLElement): void {
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
