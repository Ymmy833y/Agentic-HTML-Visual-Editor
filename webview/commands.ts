// Editing commands invoked by the toolbar, floating menu, keybindings, and
// markdown-style shortcuts. Each command operates on the current Selection
// inside the WYSIWYG root and mutates the DOM directly.

export interface CommandContext {
  root: HTMLElement;
}

export type InlineTag = 'strong' | 'em' | 'code';
export type BlockTag = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'blockquote';

const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'DIV', 'LI',
]);

/** Toggle an inline wrapper (strong/em/code) around the current selection. */
export function toggleInline(tag: InlineTag, ctx: CommandContext): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return;

  const existing = findInlineWrapAround(range, tag.toUpperCase(), ctx.root);
  if (existing) {
    unwrap(existing);
    restoreSelectionInside(sel, existing.parentNode ?? ctx.root);
    return;
  }

  const wrapper = document.createElement(tag);
  surroundSelection(range, wrapper);
  selectContents(sel, wrapper);
}

/** Replace the current block element's tag (e.g. P -> H1). */
export function setBlockTag(tag: BlockTag, ctx: CommandContext): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  const block = findBlockAncestor(range.startContainer, ctx.root);
  if (!block) return;

  const replacement = document.createElement(tag);
  for (const attr of Array.from(block.attributes)) {
    replacement.setAttribute(attr.name, attr.value);
  }
  while (block.firstChild) replacement.appendChild(block.firstChild);
  block.replaceWith(replacement);

  const r = document.createRange();
  r.selectNodeContents(replacement);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Insert a horizontal rule below the current block and place the cursor in a fresh paragraph. */
export function insertHr(ctx: CommandContext): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  const block = findBlockAncestor(range.startContainer, ctx.root);
  const hr = document.createElement('hr');
  const p = document.createElement('p');
  p.appendChild(document.createElement('br'));

  if (block && block.parentNode) {
    block.parentNode.insertBefore(hr, block.nextSibling);
    hr.parentNode!.insertBefore(p, hr.nextSibling);
    if (isBlockEmpty(block)) block.remove();
  } else {
    ctx.root.appendChild(hr);
    ctx.root.appendChild(p);
  }

  const r = document.createRange();
  r.setStart(p, 0);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Wrap the selection (or insert an empty <comment> at the cursor). */
export function wrapInComment(ctx: CommandContext): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  const comment = document.createElement('comment');
  if (range.collapsed) {
    comment.appendChild(document.createElement('br'));
    range.insertNode(comment);
  } else {
    surroundSelection(range, comment);
  }
  selectContents(sel, comment);
}

/** Insert or update a link. Pass an empty string to remove an existing link wrapper. */
export function insertLink(href: string, ctx: CommandContext): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  const existing = findAncestor(range.startContainer, 'A', ctx.root);
  if (existing) {
    if (href === '') {
      unwrap(existing);
    } else {
      existing.setAttribute('href', href);
    }
    return;
  }

  if (href === '') return;

  const a = document.createElement('a');
  a.setAttribute('href', href);

  if (range.collapsed) {
    a.textContent = href;
    range.insertNode(a);
  } else {
    surroundSelection(range, a);
  }
  selectContents(sel, a);
}

/** Look up the nearest ancestor of the given tag inside the editor root. */
export function findInlineAncestor(
  node: Node,
  tagName: string,
  stopAt: Element,
): HTMLElement | null {
  return findAncestor(node, tagName, stopAt);
}

// --- helpers ---

function findAncestor(node: Node, tagName: string, stopAt: Element): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== stopAt) {
    if (cur instanceof HTMLElement && cur.tagName === tagName) return cur;
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

function findInlineWrapAround(
  range: Range,
  tagName: string,
  stopAt: Element,
): HTMLElement | null {
  // Only treat as "existing wrap" if both endpoints share the same ancestor.
  const start = findAncestor(range.startContainer, tagName, stopAt);
  const end = findAncestor(range.endContainer, tagName, stopAt);
  return start && start === end ? start : null;
}

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) {
    parent.insertBefore(el.firstChild, el);
  }
  el.remove();
}

function isBlockEmpty(el: Element): boolean {
  return el.children.length === 0 && (el.textContent ?? '').trim() === '';
}

function surroundSelection(range: Range, wrapper: Element): void {
  try {
    range.surroundContents(wrapper);
  } catch {
    const contents = range.extractContents();
    wrapper.appendChild(contents);
    range.insertNode(wrapper);
  }
}

function selectContents(sel: Selection, el: Node): void {
  const r = document.createRange();
  r.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(r);
}

function restoreSelectionInside(sel: Selection, node: Node): void {
  const r = document.createRange();
  r.selectNodeContents(node);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}
