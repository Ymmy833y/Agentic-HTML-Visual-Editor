// Editor core: enables contenteditable on the WYSIWYG root, intercepts
// browser default behaviors that misbehave with our HTML structure, applies
// lightweight markdown-style shortcuts, and dispatches debounced change
// notifications so callers can serialize and push edits back.

import { BLOCK_TAGS, INLINE_FORMAT_TAGS } from '../shared/constants';
import { findAncestor, findBlockAncestor } from '../shared/dom-utils';

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

  let pending: number | null = null;

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
    if (e.inputType === 'insertParagraph') {
      if (handleEnter(root)) {
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
    }
    if (e.inputType === 'insertText' && e.data === ' ') {
      if (handleHeadingShortcut(root)) {
        e.preventDefault();
        scheduleChange();
        return;
      }
    }
  });

  // The browser's contenteditable inserts presentational tags (<b>, <i>) for
  // its built-in bold/italic — e.g. after the only character in a <strong> is
  // deleted, the leftover bold state makes the next keystroke a <b>. Rewrite
  // those to the semantic tags the editor uses so formatting stays consistent.
  // Skip while an IME composition is active; rewriting then would cancel it.
  let composing = false;
  root.addEventListener('compositionstart', () => {
    composing = true;
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
 * "# ", "## ", ..., "###### " typed at the start of a paragraph converts the
 * paragraph into the corresponding heading level. The leading "#" markers
 * are removed.
 */
function handleHeadingShortcut(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return false;

  const block = findBlockAncestor(range.startContainer, root);
  if (!block || block.tagName !== 'P') return false;

  const beforeText = textBeforeCursor(range, block);
  const match = /^(#{1,6})$/.exec(beforeText);
  if (!match) return false;
  const level = match[1].length;

  // Remove the "#"s from the block, then convert to heading.
  const deleteRange = document.createRange();
  deleteRange.setStart(block, 0);
  deleteRange.setEnd(range.startContainer, range.startOffset);
  deleteRange.deleteContents();

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
 * "---" alone in a paragraph + Enter becomes an <hr> followed by a fresh
 * paragraph for continued typing.
 */
function handleThematicBreakShortcut(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return false;

  const block = findBlockAncestor(range.startContainer, root);
  if (!block || block.tagName !== 'P') return false;

  if ((block.textContent ?? '').trim() !== '---') return false;

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
