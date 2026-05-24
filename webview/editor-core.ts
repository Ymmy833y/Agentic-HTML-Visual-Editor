// Editor core: enables contenteditable on the WYSIWYG root, intercepts
// browser default behaviors that misbehave with our HTML structure, applies
// lightweight markdown-style shortcuts, and dispatches debounced change
// notifications so callers can serialize and push edits back.

const DEBOUNCE_MS = 250;

const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'DIV', 'LI',
]);

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

  root.addEventListener('input', scheduleChange);

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

function findAncestor(node: Node, tagName: string, stopAt: Element): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== stopAt) {
    if (cur instanceof HTMLElement && cur.tagName === tagName) {
      return cur;
    }
    cur = cur.parentNode;
  }
  return null;
}

function findBlockAncestor(node: Node, stopAt: Element): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== stopAt) {
    if (cur instanceof HTMLElement && BLOCK_TAGS.has(cur.tagName)) return cur;
    cur = cur.parentNode;
  }
  return null;
}
