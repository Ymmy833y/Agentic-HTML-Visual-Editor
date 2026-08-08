// Block-level commands: change the current block's tag, insert horizontal
// rules, and create/transform lists. Operate on the nearest block ancestor of
// the caret.

import { blockOrBareCell, findAncestor, findBlockAncestor, findListContainer, isBlockEmpty, isBlockEmptyOrStubBr, isInsignificantTail, isRootBlockBoundary, resolveToTextBoundary, significantSiblingInDirection, unwrap } from '../shared/dom-utils';
import { BLOCK_TAGS, QUOTE_PLACEHOLDER_ATTR } from '../shared/constants';
import type { DeleteDirection } from '../shared/constants';
import type { CommandContext } from '../shared/command-context';
import type { AlertType } from '../shared/alert-types';

export type BlockTag = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'blockquote' | 'pre';
const ALERT_ATTR = 'data-alert';

export interface BareRootRun {
  first: Node;
  last: Node;
}

export interface BareBlockquoteRun extends BareRootRun {
  blockquote: HTMLElement;
}

export interface BareBlockquoteLine {
  blockquote: HTMLElement;
  first: Node | null;
  last: Node | null;
  lineIndex: number;
  previousBreak: HTMLBRElement | null;
  nextBreak: HTMLBRElement | null;
}

/**
 * Find the contiguous inline run directly under the editor root that contains
 * node. Existing HTML may place text or inline elements directly in <body>
 * without a paragraph wrapper; toolbar block commands must still format it.
 */
export function findBareRootRun(
  node: Node,
  root: Element,
  offset = 0,
): BareRootRun | null {
  let top: Node | null = node === root
    ? root.childNodes[Math.max(0, Math.min(root.childNodes.length - 1, offset > 0 ? offset - 1 : 0))]
      ?? null
    : node;
  while (top && top.parentNode !== root) {
    if (top === root) return null;
    top = top.parentNode;
  }
  if (!top || isRootBlockBoundary(top)) return null;

  let first = top;
  while (first.previousSibling && !isRootBlockBoundary(first.previousSibling)) {
    first = first.previousSibling;
  }
  let last = top;
  while (last.nextSibling && !isRootBlockBoundary(last.nextSibling)) {
    last = last.nextSibling;
  }
  return { first, last };
}

/**
 * Find the contiguous bare inline run inside the nearest blockquote that
 * contains the caret. A nested block is already independently editable, so it
 * terminates the search instead of being folded into the quote's inline run.
 */
export function findBareBlockquoteRun(
  node: Node,
  root: Element,
  offset = 0,
): BareBlockquoteRun | null {
  let blockquote: HTMLElement | null = null;
  let cur: Node | null = node;
  while (cur && cur !== root) {
    if (cur instanceof HTMLElement && cur.tagName === 'BLOCKQUOTE') {
      blockquote = cur;
      break;
    }
    if (cur instanceof Element && isRootBlockBoundary(cur)) return null;
    cur = cur.parentNode;
  }
  if (!blockquote) return null;

  let direct: Node | null;
  if (node === blockquote) {
    const index = Math.max(
      0,
      Math.min(blockquote.childNodes.length - 1, offset > 0 ? offset - 1 : 0),
    );
    direct = blockquote.childNodes[index] ?? null;
  } else {
    direct = node;
    while (direct && direct.parentNode !== blockquote) direct = direct.parentNode;
  }
  if (!direct || isRootBlockBoundary(direct)) return null;

  let first = direct;
  while (first.previousSibling && !isRootBlockBoundary(first.previousSibling)) {
    first = first.previousSibling;
  }
  let last = direct;
  while (last.nextSibling && !isRootBlockBoundary(last.nextSibling)) {
    last = last.nextSibling;
  }
  return { blockquote, first, last };
}

/**
 * Resolve the visual line containing a caret in a bare blockquote run. Enter
 * inserts direct-child <br> separators in these runs, so each segment between
 * separators can later be promoted independently to a paragraph/code block.
 */
export function findBareBlockquoteLine(
  node: Node,
  root: Element,
  offset = 0,
): BareBlockquoteLine | null {
  const run = findBareBlockquoteRun(node, root, offset);
  if (!run) return null;

  const { blockquote } = run;
  const nodes: Node[] = [];
  let current: Node | null = run.first;
  while (current) {
    nodes.push(current);
    if (current === run.last) break;
    current = current.nextSibling;
  }

  let caretPosition: number;
  if (node === blockquote) {
    const firstIndex = Array.from(blockquote.childNodes).indexOf(run.first);
    caretPosition = Math.max(0, Math.min(nodes.length, offset - firstIndex));
  } else {
    let direct: Node | null = node;
    while (direct && direct.parentNode !== blockquote) direct = direct.parentNode;
    const index = direct ? nodes.indexOf(direct) : -1;
    if (index < 0) return null;
    caretPosition = index + 0.5;
  }

  let previousBreak = -1;
  let nextBreak = nodes.length;
  let lineIndex = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (
      !(nodes[i] instanceof HTMLBRElement) ||
      (nodes[i] as HTMLBRElement).hasAttribute(QUOTE_PLACEHOLDER_ATTR)
    ) continue;
    if (i < caretPosition) {
      previousBreak = i;
      lineIndex++;
    } else {
      nextBreak = i;
      break;
    }
  }

  const first = nodes[previousBreak + 1] ?? null;
  const last = nodes[nextBreak - 1] ?? null;
  return {
    blockquote,
    first: first instanceof HTMLBRElement ? null : first,
    last: last instanceof HTMLBRElement ? null : last,
    lineIndex,
    previousBreak: previousBreak >= 0 ? nodes[previousBreak] as HTMLBRElement : null,
    nextBreak: nextBreak < nodes.length ? nodes[nextBreak] as HTMLBRElement : null,
  };
}

/**
 * Promote every <br>-delimited line in the caret's bare quote run to a <p>,
 * returning the paragraph for the active line. Existing block siblings are
 * outside the run and remain untouched.
 */
export function ensureBlockquoteLineBlock(
  node: Node,
  root: HTMLElement,
  offset = 0,
): HTMLElement | null {
  const line = findBareBlockquoteLine(node, root, offset);
  if (!line) return null;

  const { blockquote } = line;
  const runNodes: Node[] = [];
  const run = findBareBlockquoteRun(node, root, offset);
  if (!run) return null;
  let current: Node | null = run.first;
  while (current) {
    runNodes.push(current);
    if (current === run.last) break;
    current = current.nextSibling;
  }
  if (runNodes.length === 0) return null;

  const originalChildren = Array.from(blockquote.childNodes);
  const firstIndex = originalChildren.indexOf(run.first);
  const sel = window.getSelection();
  const liveRange = sel?.rangeCount ? sel.getRangeAt(0) : null;
  const saved = liveRange
    ? {
        sc: liveRange.startContainer,
        so: liveRange.startOffset,
        ec: liveRange.endContainer,
        eo: liveRange.endOffset,
      }
    : null;

  const paragraphs: HTMLElement[] = [document.createElement('p')];
  for (const child of runNodes) {
    if (child instanceof HTMLBRElement) {
      if (child.hasAttribute(QUOTE_PLACEHOLDER_ATTR)) {
        child.remove();
        continue;
      }
      child.remove();
      paragraphs.push(document.createElement('p'));
    } else {
      paragraphs[paragraphs.length - 1].appendChild(child);
    }
  }
  for (const p of paragraphs) {
    if (p.childNodes.length === 0) p.appendChild(document.createElement('br'));
  }

  const fragment = document.createDocumentFragment();
  for (const p of paragraphs) fragment.appendChild(p);
  const reference = originalChildren[originalChildren.indexOf(run.last) + 1] ?? null;
  blockquote.insertBefore(fragment, reference);

  const active = paragraphs[Math.min(line.lineIndex, paragraphs.length - 1)];
  if (saved && sel) {
    const remap = (container: Node, boundaryOffset: number): [Node, number] => {
      if (container !== blockquote) return [container, boundaryOffset];
      const relative = boundaryOffset - firstIndex;
      let paragraphIndex = 0;
      let paragraphOffset = 0;
      for (let i = 0; i < Math.max(0, relative); i++) {
        if (runNodes[i] instanceof HTMLBRElement) {
          paragraphIndex++;
          paragraphOffset = 0;
        } else {
          paragraphOffset++;
        }
      }
      const p = paragraphs[Math.min(paragraphIndex, paragraphs.length - 1)];
      return [p, Math.min(paragraphOffset, p.childNodes.length)];
    };

    try {
      const [sc, so] = remap(saved.sc, saved.so);
      const [ec, eo] = remap(saved.ec, saved.eo);
      const restored = document.createRange();
      restored.setStart(sc, so);
      restored.setEnd(ec, eo);
      sel.removeAllRanges();
      sel.addRange(restored);
    } catch {
      const fallback = document.createRange();
      fallback.selectNodeContents(active);
      fallback.collapse(false);
      sel.removeAllRanges();
      sel.addRange(fallback);
    }
  }
  return active;
}

/**
 * Wrap the bare inline run at the caret inside a blockquote in a paragraph.
 * Only that run is moved, so existing sibling blocks (tables, lists, nested
 * paragraphs, etc.) remain untouched. Live selection boundaries are remapped
 * when they point directly at the blockquote; descendants move with their
 * nodes and therefore remain valid automatically.
 */
export function ensureBlockInBlockquote(
  node: Node,
  root: HTMLElement,
  offset = 0,
): HTMLElement | null {
  const run = findBareBlockquoteRun(node, root, offset);
  if (!run) return null;

  const { blockquote, first, last } = run;
  const originalChildren = Array.from(blockquote.childNodes);
  const firstIndex = originalChildren.indexOf(first);
  const lastIndex = originalChildren.indexOf(last);
  if (firstIndex < 0 || lastIndex < firstIndex) return null;

  const sel = window.getSelection();
  const liveRange = sel?.rangeCount ? sel.getRangeAt(0) : null;
  const saved = liveRange
    ? {
        sc: liveRange.startContainer,
        so: liveRange.startOffset,
        ec: liveRange.endContainer,
        eo: liveRange.endOffset,
      }
    : null;
  const p = document.createElement('p');
  blockquote.insertBefore(p, first);

  let current: Node | null = first;
  for (;;) {
    const next: Node | null = current.nextSibling;
    p.appendChild(current);
    if (current === last) break;
    current = next;
    if (!current) break;
  }
  if (p.childNodes.length === 0) p.appendChild(document.createElement('br'));

  if (saved && sel) {
    const runLength = lastIndex - firstIndex + 1;
    const remap = (container: Node, boundaryOffset: number): [Node, number] => {
      if (container !== blockquote) return [container, boundaryOffset];
      if (boundaryOffset >= firstIndex && boundaryOffset <= lastIndex + 1) {
        return [p, boundaryOffset - firstIndex];
      }
      if (boundaryOffset > lastIndex + 1) {
        return [blockquote, boundaryOffset - runLength + 1];
      }
      return [blockquote, boundaryOffset];
    };

    try {
      const [sc, so] = remap(saved.sc, saved.so);
      const [ec, eo] = remap(saved.ec, saved.eo);
      const restored = document.createRange();
      restored.setStart(sc, so);
      restored.setEnd(ec, eo);
      sel.removeAllRanges();
      sel.addRange(restored);
    } catch {
      const fallback = document.createRange();
      fallback.selectNodeContents(p);
      fallback.collapse(false);
      sel.removeAllRanges();
      sel.addRange(fallback);
    }
  }
  return p;
}

/** Wrap a bare top-level inline run in a paragraph and preserve its selection. */
export function ensureBlockAtRoot(
  node: Node,
  root: HTMLElement,
  offset = 0,
): HTMLElement | null {
  const run = findBareRootRun(node, root, offset);
  if (!run) return null;

  const sel = window.getSelection();
  const saved = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
  const p = document.createElement('p');
  root.insertBefore(p, run.first);

  let current: Node | null = run.first;
  for (;;) {
    const next: Node | null = current.nextSibling;
    p.appendChild(current);
    if (current === run.last) break;
    current = next;
    if (!current) break;
  }
  if (p.childNodes.length === 0) p.appendChild(document.createElement('br'));

  if (saved && sel) {
    try {
      if (saved.collapsed && saved.startContainer === root) {
        const r = document.createRange();
        r.selectNodeContents(p);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
        return p;
      }
      if (!root.contains(saved.startContainer) || !root.contains(saved.endContainer)) {
        throw new Error('Selection boundary left the editor root.');
      }
      sel.removeAllRanges();
      sel.addRange(saved);
    } catch {
      const r = document.createRange();
      r.selectNodeContents(p);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }
  return p;
}

/**
 * The one root-level <br> {@link materializeEmptyRootParagraph} stood in for,
 * paired with the sibling it sat in front of. Restoring it before that anchor
 * rebuilds the root's child list exactly as it was.
 */
export interface DroppedBreak {
  node: HTMLBRElement;
  anchor: Node | null;
}

/** What {@link materializeEmptyRootParagraph} created, and what it took away. */
export interface MaterializedParagraph {
  paragraph: HTMLElement;
  droppedBreak: DroppedBreak | null;
}

/**
 * Whether the root holds nothing but the placeholders an untouched document
 * carries: whitespace text and root-level <br> elements.
 *
 * Deliberately NOT {@link isInsignificantTail}. That predicate answers "is the
 * caret at the edge of its block", so it calls every childless non-block element
 * insignificant — an <img>, an <hr>, a table whose cells happen to be empty —
 * and a document showing an image would then count as empty and be edited as
 * one. The question here is whether the document has content at all, which is
 * a narrower one.
 */
export function isEmptyRootDocument(root: HTMLElement): boolean {
  return Array.from(root.childNodes).every(
    (node) =>
      node instanceof HTMLBRElement ||
      (node.nodeType === Node.TEXT_NODE && /^\s*$/.test((node as Text).data)),
  );
}

/**
 * Materialize the canonical empty paragraph in an effectively empty editor
 * root and move the caret into it. Editing an empty document is the one place
 * where the browser's defaults write directly under the root — the typed,
 * composed, or pasted content becomes a bare node with no block wrapper, which
 * the list commands and whole-document formatting cannot anchor to.
 *
 * Lives here rather than in core/editor-core because it is the same
 * materialization {@link ensureBlockAtRoot} performs for a bare run, and
 * because the entry points are not only keyboard ones: core/editor-core routes
 * insertText / insertParagraph / compositionstart through it, and
 * features/clipboard routes paste.
 *
 * Deliberately restricted to an effectively empty root: a bare inline run in
 * an existing document is a supported shape (see {@link findBareRootRun}) that
 * must not be rewritten by mere typing.
 *
 * At most ONE root-level <br> is dropped — the one the caret's own offset points
 * at, whose line box the paragraph now provides. Every other break is a blank
 * line the reader can see, so removing it would silently delete content on the
 * first keystroke; whitespace text nodes are left as found for the same reason.
 * The dropped break is RETURNED rather than forgotten: an IME composition may
 * still be abandoned, and the rollback in core/editor-core has to put the
 * document back exactly, break included. Returns null when the root holds real
 * content or the caret is not at the root level.
 */
export function materializeEmptyRootParagraph(root: HTMLElement): MaterializedParagraph | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.startContainer)) return null;
  if (range.startContainer !== root && range.startContainer.parentNode !== root) {
    return null;
  }
  if (!isEmptyRootDocument(root)) return null;

  // Resolved as a NODE before anything is removed: an index into root.childNodes
  // read afterwards would name a different child, and the paragraph would land
  // on the wrong side of the caret.
  let reference: Node | null = range.startContainer === root
    ? root.childNodes[Math.min(range.startOffset, root.childNodes.length)] ?? null
    : range.startContainer;

  let droppedBreak: DroppedBreak | null = null;
  if (reference instanceof HTMLBRElement) {
    droppedBreak = { node: reference, anchor: reference.nextSibling };
    const next = reference.nextSibling;
    reference.remove();
    reference = next;
  }

  const p = document.createElement('p');
  p.appendChild(document.createElement('br'));
  root.insertBefore(p, reference);

  const caret = document.createRange();
  caret.setStart(p, 0);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
  return { paragraph: p, droppedBreak };
}

/**
 * The block a block-level command acts on, materializing one when the caret
 * has none.
 *
 * The last fallback is what makes an untouched document editable from the
 * toolbar. {@link ensureBlockAtRoot} resolves its target through
 * {@link findBareRootRun}, which starts from a child of the root — so a root
 * with NO children at all (a fresh `.html` opened straight in the WYSIWYG view)
 * yields nothing, and the block dropdown, the alert types, and the list buttons
 * all returned silently while the same buttons worked the moment the document
 * held a single <br>. {@link materializeEmptyRootParagraph} checks the caret
 * and {@link isEmptyRootDocument} itself, so it declines on any document that
 * holds real content and cannot rewrite a bare run the user already has.
 */
function commandBlock(range: Range, root: HTMLElement): HTMLElement | null {
  return ensureBlockInCell(range.startContainer, root)
    ?? findBlockAncestor(range.startContainer, root)
    ?? ensureBlockAtRoot(range.startContainer, root, range.startOffset)
    ?? materializeEmptyRootParagraph(root)?.paragraph
    ?? null;
}

/**
 * If the caret sits directly in a bare table cell (TD/TH holding inline content
 * with no block wrapper), wrap that content in a <p> so the block-level commands
 * below — which all resolve their target via findBlockAncestor — have a block to
 * act on, and the resulting block lives INSIDE the cell. Returns the new <p>, or
 * null when no wrap is needed: the caret is outside a cell, already inside a
 * block, or the cell already holds block-level children (left to existing logic,
 * since wrapping a loose inline run would risk nesting a block inside a <p>).
 *
 * The cell's existing child nodes are moved into the <p> (identity preserved) and
 * the live selection is re-anchored into it, so a Range captured before this call
 * must be re-read from the selection afterwards.
 */
export function ensureBlockInCell(node: Node, root: Element): HTMLElement | null {
  const found = blockOrBareCell(node, root);
  if (!found || !found.bareCell) return null;
  const cell = found.el;
  const hasBlockChild = Array.from(cell.children).some(
    (c) => BLOCK_TAGS.has(c.tagName) || c.tagName === 'UL' || c.tagName === 'OL' || c.tagName === 'TABLE',
  );
  if (hasBlockChild) return null;

  const sel = window.getSelection();
  const saved = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  const snap = saved
    ? { sc: saved.startContainer, so: saved.startOffset, ec: saved.endContainer, eo: saved.endOffset }
    : null;

  const p = document.createElement('p');
  while (cell.firstChild) p.appendChild(cell.firstChild);
  if (p.childNodes.length === 0) p.appendChild(document.createElement('br'));
  cell.appendChild(p);

  // The cell's children moved into <p> 1:1, so a boundary that pointed at the
  // cell now points at the same index inside <p>; text-node boundaries moved
  // with their node and stay valid.
  if (snap && sel) {
    const remap = (c: Node): Node => (c === cell ? p : c);
    try {
      const r = document.createRange();
      r.setStart(remap(snap.sc), snap.so);
      r.setEnd(remap(snap.ec), snap.eo);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch {
      const r = document.createRange();
      r.selectNodeContents(p);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }
  return p;
}

/**
 * Map a Ctrl/Cmd+Shift+<digit> keydown to a block tag: Digit1–Digit6 → h1–h6,
 * Digit0 → p (plain). Returns null for any other key.
 *
 * Matches on `KeyboardEvent.code` (the physical key) rather than `.key`,
 * because while Shift is held `.key` is the shifted symbol ('!', '@', …) — not
 * the digit — so a digit test against `.key` never fires in a real browser.
 */
export function headingShortcutTag(code: string): BlockTag | null {
  const m = /^Digit([0-6])$/.exec(code);
  if (!m) return null;
  return m[1] === '0' ? 'p' : (('h' + m[1]) as BlockTag);
}

/**
 * Replace block with replacement in place: copy every attribute except the
 * alert marker, move the children across (keeping a <br> placeholder when the
 * block had none), then collapse the caret to the end of the new element.
 * replacement may already carry its own data-alert; the copy never overwrites
 * it because the block's own alert marker is skipped.
 */
function replaceBlockKeepingContent(
  block: HTMLElement,
  replacement: HTMLElement,
  sel: Selection,
): void {
  for (const attr of Array.from(block.attributes)) {
    if (attr.name.toLowerCase() === ALERT_ATTR) continue;
    replacement.setAttribute(attr.name, attr.value);
  }
  while (block.firstChild) replacement.appendChild(block.firstChild);
  if (replacement.childNodes.length === 0) {
    replacement.appendChild(document.createElement('br'));
  }
  block.replaceWith(replacement);

  const r = document.createRange();
  r.selectNodeContents(replacement);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Replace the current block element's tag (e.g. P → H1). */
export function setBlockTag(tag: BlockTag, ctx: CommandContext): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  const block = tag === 'pre'
    ? ensureBlockquoteLineBlock(range.startContainer, ctx.root, range.startOffset)
      ?? commandBlock(sel.getRangeAt(0), ctx.root)
    : commandBlock(range, ctx.root);
  if (!block) return;
  // Lists and details elements are structural; never rewrite them into a
  // paragraph, heading, quote, or alert.
  if (block.tagName === 'LI' || block.tagName === 'SUMMARY' || block.tagName === 'DETAILS') return;

  replaceBlockKeepingContent(block, document.createElement(tag), sel);
}

/**
 * Convert the current block to a blockquote carrying a normalized alert type.
 * Passing null removes the alert metadata while leaving an ordinary blockquote.
 */
export function setAlertType(type: AlertType | null, ctx: CommandContext): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  const block = commandBlock(range, ctx.root);
  if (!block) return;
  if (block.tagName === 'LI' || block.tagName === 'SUMMARY' || block.tagName === 'DETAILS') return;

  if (block.tagName === 'BLOCKQUOTE') {
    if (type === null) block.removeAttribute(ALERT_ATTR);
    else block.setAttribute(ALERT_ATTR, type);
    return;
  }
  const quote = document.createElement('blockquote');
  if (type !== null) quote.setAttribute(ALERT_ATTR, type);
  replaceBlockKeepingContent(block, quote, sel);
}

/**
 * Whether inserting a block below block also drops block itself. Ordinary
 * blocks keep the long-standing "empty means no children and no text" rule, so
 * an insertion from a <p><br></p> still leaves the paragraph in place. A list
 * item is judged empty even when it only holds the stub <br> that a fresh item
 * always carries (see convertToList below and the Enter handler in
 * editor-core), because leaving it behind shows a stray bullet — and, once no
 * <li> remains, an empty <ul>/<ol> shell.
 */
function dropsSourceBlock(block: HTMLElement): boolean {
  return block.tagName === 'LI' ? isBlockEmptyOrStubBr(block) : isBlockEmpty(block);
}

/**
 * Build the tail half for splitting list: a new list of the same type that the
 * caller fills with everything from the split point on. The tail is still the
 * same list to the user, so it keeps the list's attributes — except id, which
 * must stay unique in the document — and, for ordered lists, a start that
 * continues the numbering. headLis is the number of items the head half keeps
 * (a dropped or unwrapped item leaves no number behind, closing its gap), so
 * the tail starts right after them.
 */
function createListTail(
  list: HTMLElement,
  headLis: number,
  tailNodes: Node[],
): HTMLElement {
  const tail = document.createElement(list.tagName);
  for (const attr of Array.from(list.attributes)) {
    if (attr.name.toLowerCase() === 'id') continue;
    tail.setAttribute(attr.name, attr.value);
  }
  if (list.tagName === 'OL') {
    const parsed = Number.parseInt(list.getAttribute('start') ?? '', 10);
    const explicitStart = Number.isNaN(parsed) ? null : parsed;
    if (!list.hasAttribute('reversed')) {
      const tailStart = (explicitStart ?? 1) + headLis;
      // 1 is the default, so spelling it out would only add noise — and the
      // attribute copy above may have brought over a start that no longer
      // applies, which is why this drops it rather than leaving it alone.
      if (tailStart === 1) tail.removeAttribute('start');
      else tail.setAttribute('start', String(tailStart));
    } else {
      // A reversed list counts DOWN, by default from its own item count, so
      // the split changes both halves' defaults. Keeping the numbers of the
      // items both halves keep therefore means making the starts explicit: the
      // head keeps the number its first item shows, the tail continues right
      // below the head's last kept item. A half whose new default already
      // matches gets no attribute (which also clears the start the copy above
      // brought).
      const tailLis = tailNodes.filter(
        (n) => n instanceof Element && n.tagName === 'LI',
      ).length;
      const start = explicitStart ?? headLis + tailLis;
      if (explicitStart === null && start !== headLis) {
        list.setAttribute('start', String(start));
      }
      const tailStart = start - headLis;
      if (tailStart === tailLis) tail.removeAttribute('start');
      else tail.setAttribute('start', String(tailStart));
    }
  }
  for (const n of tailNodes) tail.appendChild(n);
  return tail;
}

/**
 * Split list before splitBefore so a block can land between the halves.
 * The whitespace between pretty-printed items is not content: when nothing
 * meaningful follows the split point, the block simply goes after the list.
 * Anything meaningful — further items, but also a list nested directly under
 * the list, which hand-written HTML does — moves into a {@link createListTail}
 * inserted after the head. droppedLis is how many head items the caller is
 * about to remove; they must not be counted when the tail's numbering
 * continues from the head. Returns where the block must land.
 */
function splitListAt(
  list: HTMLElement,
  splitBefore: Node | null,
  droppedLis: number,
): { parent: Node; before: Node | null } {
  const trailing: Node[] = [];
  for (let n: Node | null = splitBefore; n; n = n.nextSibling) trailing.push(n);
  if (trailing.some((n) => !isInsignificantTail(n))) {
    let headLis = -droppedLis;
    for (let n: Node | null = list.firstChild; n && n !== splitBefore; n = n.nextSibling) {
      if (n instanceof Element && n.tagName === 'LI') headLis++;
    }
    const tail = createListTail(list, headLis, trailing);
    list.parentNode!.insertBefore(tail, list.nextSibling);
  }
  return { parent: list.parentNode!, before: list.nextSibling };
}

/**
 * Where a block inserted "below" block must land, splitting lists first when
 * that is what it takes. For an ordinary block the point is simply after it,
 * among its siblings. A list item is different: its siblings live inside a
 * UL/OL where only <li> children are valid, so the list is split after the
 * item and the insertion point is between the two halves, at the list's parent
 * level. Hand-written HTML also nests lists directly under lists, so when that
 * parent level is itself a UL/OL the split repeats outward until the insertion
 * point leaves list containers entirely. dropsSource reports whether the caret
 * item is about to be removed, so the tail's numbering matches what the head
 * actually keeps.
 */
function splitListForBlockInsertion(
  block: HTMLElement,
  dropsSource: boolean,
): { parent: Node; before: Node | null } {
  const list = block.parentElement;
  if (
    block.tagName !== 'LI' ||
    !list || !list.parentNode ||
    (list.tagName !== 'UL' && list.tagName !== 'OL')
  ) {
    return { parent: block.parentNode!, before: block.nextSibling };
  }
  let point = splitListAt(list, block.nextSibling, dropsSource ? 1 : 0);
  while (
    point.parent instanceof HTMLElement &&
    (point.parent.tagName === 'UL' || point.parent.tagName === 'OL') &&
    point.parent.parentNode
  ) {
    point = splitListAt(point.parent, point.before, 0);
  }
  return point;
}

/**
 * Drop the block the caret left behind, mirroring the long-standing "removes
 * the original block if it is empty" behaviour. A list item additionally takes
 * its list along once nothing significant remains in it — walking further up
 * through lists nested directly under lists — so an insertion from the only
 * item never leaves empty <ul>/<ol> shells behind. "No <li> left" alone is not
 * the right test: a nested list still holding items must keep its parent alive
 * rather than be deleted with it. Only ever called when
 * {@link dropsSourceBlock} agreed, so the split above stays consistent with it.
 */
function removeSourceBlock(block: HTMLElement): void {
  let container = block.parentElement;
  block.remove();
  while (
    container && (container.tagName === 'UL' || container.tagName === 'OL') &&
    Array.from(container.childNodes).every(isInsignificantTail)
  ) {
    const parent: HTMLElement | null = container.parentElement;
    container.remove();
    container = parent;
  }
}

/**
 * Insert a collapsible `<details>` (with a `<summary>` title and an empty body
 * paragraph) below the current block. Inserted open so the body is immediately
 * visible/editable; the summary text is selected so typing overwrites the
 * "Details" placeholder.
 */
export function insertDetails(ctx: CommandContext): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  const block = ensureBlockInCell(range.startContainer, ctx.root)
    ?? findBlockAncestor(range.startContainer, ctx.root);

  const details = document.createElement('details');
  details.setAttribute('open', '');
  const summary = document.createElement('summary');
  summary.textContent = 'Details';
  const body = document.createElement('p');
  body.appendChild(document.createElement('br'));
  details.appendChild(summary);
  details.appendChild(body);

  if (block && block.parentNode) {
    const dropsSource = dropsSourceBlock(block);
    const { parent, before } = splitListForBlockInsertion(block, dropsSource);
    parent.insertBefore(details, before);
    if (dropsSource) removeSourceBlock(block);
  } else {
    ctx.root.appendChild(details);
  }

  // Select the summary text so the user can type a title over the placeholder.
  const r = document.createRange();
  r.selectNodeContents(summary);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Insert a horizontal rule below the current block. */
export function insertHr(ctx: CommandContext): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  const block = ensureBlockInCell(range.startContainer, ctx.root)
    ?? findBlockAncestor(range.startContainer, ctx.root);
  const hr = document.createElement('hr');
  const p = document.createElement('p');
  p.appendChild(document.createElement('br'));

  if (block && block.parentNode) {
    const dropsSource = dropsSourceBlock(block);
    const { parent, before } = splitListForBlockInsertion(block, dropsSource);
    parent.insertBefore(hr, before);
    parent.insertBefore(p, hr.nextSibling);
    if (dropsSource) removeSourceBlock(block);
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

// --- List commands ---------------------------------------------------------
//
// UL/OL are containers (not single replaceable tags), so they are handled here
// rather than through setBlockTag. toggleList covers three cases driven by the
// caret's nearest enclosing list: CONVERT (no list → wrap blocks), TOGGLE OFF
// (same type → unwrap to paragraphs), and SWITCH (other type → rename ul↔ol).

interface RangeSnapshot {
  sc: Node;
  so: number;
  ec: Node;
  eo: number;
}

/**
 * Toggle the selection's block(s) into a list of the given type, or — when the
 * caret already sits in a list — out of it (same type) or across to the other
 * type. SUMMARY/DETAILS are skipped, mirroring setBlockTag.
 */
export function toggleList(type: 'ul' | 'ol', ctx: CommandContext): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  // A bare table cell has no block to convert; wrap its content first so the
  // list is created inside the cell. No-op (and selection untouched) elsewhere.
  ensureBlockInCell(sel.getRangeAt(0).startContainer, ctx.root);
  const range = sel.getRangeAt(0);

  const list = findListContainer(range.startContainer, ctx.root);
  if (list) {
    if (list.tagName.toLowerCase() === type) {
      toggleListOff(range, list, ctx, sel);
    } else {
      switchListType(type, list, ctx, sel);
    }
    return;
  }
  convertToList(type, range, ctx, sel);
}

/** What {@link ensureBlocksAtRootInRange} did, and what shape the range was in. */
interface RootRunWrap {
  /** The paragraphs it created, so a caller that does not use one can undo it. */
  created: HTMLElement[];
  /**
   * Whether a range boundary still rested on the editor root itself — the shape
   * Ctrl+A produces in ANY document. It says the command was aimed at the whole
   * document rather than at a particular block, which is the distinction
   * {@link dropSpannedContainers} needs.
   */
  fromRootBoundary: boolean;
}

/**
 * Wrap every significant bare root-level inline run the range touches in a
 * paragraph (via {@link ensureBlockAtRoot}), so commands that need real blocks
 * — list conversion in particular — can operate on selections over bare text.
 * A caret sitting directly on the root resolves its run through the same
 * offset rule findBareRootRun uses. Runs are collected before any wrap so the
 * range stays readable; each wrap re-anchors the live selection itself.
 *
 * Returns the paragraphs it created — so a caller that ends up not using one
 * can undo the wrap instead of leaving a structural change the command has
 * nothing to show for — alongside the shape the range was in ({@link RootRunWrap}).
 */
function ensureBlocksAtRootInRange(range: Range, root: HTMLElement): RootRunWrap {
  if (range.collapsed && range.startContainer === root) {
    // Same last resort as {@link commandBlock}: a root with no children holds
    // no run for ensureBlockAtRoot to find, which left the UL/OL buttons doing
    // nothing at all on a fresh document.
    const only = ensureBlockAtRoot(root, root, range.startOffset)
      ?? materializeEmptyRootParagraph(root)?.paragraph
      ?? null;
    return { created: only ? [only] : [], fromRootBoundary: true };
  }
  const runFirsts: Node[] = [];
  let first: Node | null = null;
  let significant = false;
  let intersects = false;
  const flush = (): void => {
    if (first && significant && intersects) runFirsts.push(first);
    first = null;
    significant = false;
    intersects = false;
  };
  for (const child of Array.from(root.childNodes)) {
    if (isRootBlockBoundary(child)) {
      flush();
      continue;
    }
    first ??= child;
    if (!isInsignificantTail(child)) significant = true;
    if (range.intersectsNode(child)) intersects = true;
  }
  flush();

  // Text-node boundaries survive the moves below (nodes keep their identity),
  // whereas a saved Range collapses when its container is reparented — which
  // is what ensureBlockAtRoot's own per-run restore is limited by. Snapshot
  // the selection at text level, wrap, then rebuild it.
  const [sc, so] = resolveToTextBoundary(range.startContainer, range.startOffset);
  const [ec, eo] = resolveToTextBoundary(range.endContainer, range.endOffset);
  // A boundary that stayed on the root is an INDEX, and the wraps below shorten
  // the child list (a run of n nodes becomes one <p>). Read afterwards the same
  // number names a different child, which pulled blocks the user never selected
  // into the conversion, so resolve each side to the node it points at now.
  // Forward looks at the child AT the boundary, backward at the one before it.
  const startAnchor = sc === root ? root.childNodes[so] ?? null : null;
  const endAnchor = ec === root ? root.childNodes[eo - 1] ?? null : null;
  // Each side's scan may not run past the OTHER side: see the `limit` argument
  // of {@link rootBoundaryIntoBlock}. A text-level boundary names its own node.
  const startSide = sc === root ? startAnchor : sc;
  const endSide = ec === root ? endAnchor : ec;
  const fromRootBoundary = sc === root || ec === root;
  const created: HTMLElement[] = [];
  for (const node of runFirsts) {
    const wrapped = ensureBlockAtRoot(node, root);
    if (wrapped) created.push(wrapped);
  }

  const sel = window.getSelection();
  if (!sel || !root.contains(sc) || !root.contains(ec)) {
    return { created, fromRootBoundary };
  }
  // Nothing was wrapped AND neither boundary rests on the root itself: the
  // caller's range already names real blocks, so leave the selection alone.
  // A boundary still on root is rebuilt even with no wrap — that is the whole
  // point of {@link rootBoundaryIntoBlock}, and a whole-document selection
  // produces it whether or not the document happens to hold bare text.
  if (runFirsts.length === 0 && sc !== root && ec !== root) {
    return { created, fromRootBoundary };
  }
  try {
    const [rsc, rso] = sc === root
      ? rootBoundaryIntoBlock(root, startAnchor, 'forward', endSide) ?? [sc, so]
      : [sc, so];
    const [rec, reo] = ec === root
      ? rootBoundaryIntoBlock(root, endAnchor, 'backward', startSide) ?? [ec, eo]
      : [ec, eo];
    const r = document.createRange();
    const sMax = rsc.nodeType === Node.TEXT_NODE
      ? (rsc as Text).length
      : rsc.childNodes.length;
    const eMax = rec.nodeType === Node.TEXT_NODE
      ? (rec as Text).length
      : rec.childNodes.length;
    r.setStart(rsc, Math.min(rso, sMax));
    r.setEnd(rec, Math.min(reo, eMax));
    sel.removeAllRanges();
    sel.addRange(r);
  } catch {
    /* keep the selection the last wrap left behind */
  }
  return { created, fromRootBoundary };
}

/**
 * Step a range boundary that still points at the editor root itself into the
 * neighbouring block, looking in the direction of the range's interior.
 *
 * {@link resolveToTextBoundary} can only descend to a text node when one sits
 * at (or just before) the boundary index; a whole-document selection whose
 * first root child is a `<table>` leaves the start boundary on the root. The
 * block lookup in {@link selectedBlocks} climbs from the boundary's container
 * and the root is no block, so such a boundary makes the list conversion find
 * nothing and return.
 *
 * Applied to every element-level boundary, not only to ranges where a bare run
 * was wrapped: Ctrl+A leaves both boundaries on the root in ANY document, so
 * gating this on the presence of bare text would make the same gesture convert
 * `<table>…</table>para` but silently no-op on `<p>a</p><p>b</p>`.
 *
 * Takes the boundary as the NODE it pointed at before any wrapping, not as the
 * offset it was: the wraps shorten the root's child list, so the same number
 * afterwards names a different child. A wrapped anchor is climbed back to its
 * new root-level parent, which is the paragraph the run became. Returns null
 * when there is no block to step into, leaving the boundary as it was.
 *
 * `limit` is the range's OTHER side, and the scan stops there. Without it a
 * selection holding no block at all sends this walk past the far end: the two
 * sides cross, `Range.setEnd` collapses a range whose end precedes its start,
 * and the conversion then ran on the block the backward scan had wandered into
 * — selecting only an `<hr>` between two paragraphs turned the paragraph BEFORE
 * it into a list. Nothing outside the selection may be reached, so the scan is
 * bounded by it.
 */
function rootBoundaryIntoBlock(
  root: HTMLElement,
  anchor: Node | null,
  direction: 'forward' | 'backward',
  limit: Node | null,
): [Node, number] | null {
  // Nothing at (or before) the boundary: it starts past the edge, so there is
  // nothing in this direction to step into.
  if (!anchor) return null;
  const children = Array.from(root.childNodes);
  const forward = direction === 'forward';
  const top = rootLevelAncestor(anchor, root);
  const index = top ? children.indexOf(top) : -1;
  if (index < 0) return null;

  const limitTop = limit ? rootLevelAncestor(limit, root) : null;
  const limitIndex = limitTop ? children.indexOf(limitTop) : -1;
  const stop = limitIndex >= 0 ? limitIndex : (forward ? children.length - 1 : 0);
  for (let i = index; forward ? i <= stop : i >= stop; i += forward ? 1 : -1) {
    const child = children[i];
    if (child instanceof HTMLElement && BLOCK_TAGS.has(child.tagName)) {
      return forward ? [child, 0] : [child, child.childNodes.length];
    }
  }
  return null;
}

/** The ancestor of node that is a direct child of root, or null when outside. */
function rootLevelAncestor(node: Node, root: HTMLElement): Node | null {
  let cur: Node | null = node;
  while (cur && cur.parentNode !== root) {
    if (cur === root) return null;
    cur = cur.parentNode;
  }
  return cur;
}

/**
 * Blocks a list conversion never consumes. SUMMARY/DETAILS mirror setBlockTag.
 * PRE is here because a code block turned into an <li> loses the block and
 * leaves its <code> bare inside the item — a selection that merely happens to
 * span a code block must not destroy it.
 */
const LIST_CONVERSION_SKIP_TAGS = new Set(['SUMMARY', 'DETAILS', 'PRE']);

/**
 * Blocks a list conversion consumes only when the command was aimed at them
 * ALONE. A <blockquote> is a legitimate conversion target of its own — the
 * block dropdown turns a paragraph into one and back, and it produces a BARE
 * quote (setAlertType/setBlockTag move the inline content straight in, with no
 * inner <p>), so the caret in a freshly created quote resolves to the quote
 * itself. Putting it in {@link LIST_CONVERSION_SKIP_TAGS} would therefore make
 * the UL/OL buttons dead on the shape this editor creates most.
 *
 * But dissolving a quote the selection merely SPANS destroys a structure the
 * user never aimed at: Ctrl+A then the UL button turned
 * `<blockquote data-alert="warning">` into a plain `<li>`, dropping the quote
 * and its alert type into the saved file with no way back but undo. That
 * gesture only became reachable once {@link rootBoundaryIntoBlock} started
 * stepping element-level boundaries into a block, so it is guarded here rather
 * than left to the skip set above.
 */
const SPANNED_ONLY_SKIP_TAGS = new Set(['BLOCKQUOTE']);

/**
 * Drop the blocks that a conversion covering SEVERAL blocks must leave alone.
 * A single block is what the command was aimed at, so it is always converted;
 * see {@link SPANNED_ONLY_SKIP_TAGS} for why the distinction exists. Dropping
 * one leaves a gap, which {@link contiguousBlockGroups} then turns into
 * separate lists on either side of it.
 *
 * "Spanned" is read from what ELSE is in range, not from the block count alone.
 * A DRAGGED selection made of nothing but quotes was aimed at those quotes —
 * there is no other block it could have been meant for — so dropping them all
 * left the UL/OL buttons doing nothing at all, silently, which is the very
 * failure this command was extended to fix for bare text.
 *
 * `fromRootBoundary` is what keeps that fallback out of Ctrl+A. A whole-document
 * selection was aimed at no block in particular, so reading it as "aimed at the
 * quotes" turned `<blockquote data-alert="warning">alert</blockquote>` plus one
 * more quote into plain `<li>`s — dropping both quotes and the alert type into
 * the saved file, on a two-keystroke gesture, with no way back but undo. There
 * is nothing else in range to convert instead, so the command declines; a
 * caret placed IN a quote still converts it, because a single block is always
 * what the command was aimed at.
 *
 * That decline is SILENT, and deliberately so — the one case where this command
 * consumes a click and changes nothing. Ctrl+A then the UL button on a document
 * of nothing but quotes does exactly nothing, while dragging across the same two
 * quotes converts them; the shape of the selection is the whole difference. It
 * reads like the "silently does nothing" failure this command was extended to
 * remove for bare text, so it is worth stating why it is not the same thing:
 * there, declining lost the user an edit the command could have made safely;
 * here, the only alternative to declining is dissolving a structure — and its
 * `data-alert` — that the user never pointed at. Refusing an edit is recoverable
 * by placing the caret; an unnoticed one is not. Both halves are pinned in
 * tests/unit/list-commands.test.ts ("converts several quotes when a DRAG holds
 * nothing else" against "silently does nothing for the element-level Ctrl+A
 * shape"), so neither can be changed by accident.
 */
function dropSpannedContainers(
  blocks: HTMLElement[],
  fromRootBoundary: boolean,
): HTMLElement[] {
  if (blocks.length <= 1) return blocks;
  const aimed = blocks.filter((b) => !SPANNED_ONLY_SKIP_TAGS.has(b.tagName));
  if (aimed.length > 0) return aimed;
  return fromRootBoundary ? [] : blocks;
}

/**
 * Wrap the selection's sibling blocks into lists, one <li> per block — and one
 * list per contiguous group of them (see {@link contiguousBlockGroups}).
 */
function convertToList(
  type: 'ul' | 'ol',
  range: Range,
  ctx: CommandContext,
  sel: Selection,
): void {
  // Bare root-level text has no block for selectedBlocks to find, so the UL/OL
  // buttons used to silently do nothing there (and to skip bare runs inside a
  // wider selection). Wrap those runs first; the block dropdown and the
  // markdown shortcuts already materialize the same way.
  const { created, fromRootBoundary } = ensureBlocksAtRootInRange(range, ctx.root);
  // The wraps re-anchored the selection; the passed range may be stale.
  const live = sel.rangeCount > 0 ? sel.getRangeAt(0) : range;

  const blocks = dropSpannedContainers(
    selectedBlocks(live, ctx.root).filter(
      (b) => !LIST_CONVERSION_SKIP_TAGS.has(b.tagName),
    ),
    fromRootBoundary,
  );
  // A wrap the conversion does not use is a mutation with nothing to show for
  // it — the bare text would be silently promoted to a paragraph and saved
  // that way. selectedBlocks can stop short of a wrapped run (it returns only
  // the start block when the two ends live under different parents), so roll
  // those paragraphs back rather than leaving them behind.
  for (const p of created) {
    if (!blocks.includes(p) && p.parentNode) unwrap(p);
  }
  if (blocks.length === 0) return;

  const snap = snapshotRange(sel);

  const lists: HTMLElement[] = [];
  for (const group of contiguousBlockGroups(blocks)) {
    const listEl = document.createElement(type);
    for (const block of group) {
      const li = document.createElement('li');
      while (block.firstChild) li.appendChild(block.firstChild);
      if (li.childNodes.length === 0) li.appendChild(document.createElement('br'));
      listEl.appendChild(li);
    }
    const first = group[0];
    first.parentNode!.insertBefore(listEl, first);
    for (const block of group) block.remove();
    lists.push(listEl);
  }

  const last = mergeAdjacentLists(lists, type.toUpperCase());
  if (!last) return;

  if (!restoreRange(sel, snap, ctx.root)) {
    collapseToEnd(sel, last.lastElementChild ?? last);
  }
}

/**
 * Fold each freshly created list into a same-type list it now sits beside, and
 * return the last surviving one (where the caret goes when the range cannot be
 * restored).
 *
 * Two adjacent lists are one list to the reader, and an <ol> restarts its
 * numbering at every element: without this, Ctrl+A then the OL button over
 * `<p>a</p><ol><li>l</li></ol><p>b</p>` rendered "1. / 1. / 1." instead of a
 * single run. The neighbour need not be one this command created — a paragraph
 * converted right below an existing list joins it, which is what every other
 * editor does.
 *
 * Which of the two elements SURVIVES decides which attributes survive with it.
 * A list this command just built carries none, while one that was already in
 * the document may carry a `start`, a `reversed`, an `id`, or a `class` the
 * file depends on — {@link createListTail} goes to the same trouble when a
 * split has to keep them. So a pre-existing neighbour always wins over a
 * freshly created list, in either direction; between two lists of equal
 * standing the earlier one wins, because one of the two identities has to go
 * whichever way the merge runs.
 *
 * Absorbing forward can consume a later entry of `lists`, so a list that has
 * already left the document is skipped rather than merged a second time.
 */
function mergeAdjacentLists(lists: HTMLElement[], tagName: string): HTMLElement | null {
  const created = new Set<HTMLElement>(lists);
  let last: HTMLElement | null = null;
  for (const list of lists) {
    if (!list.parentNode) continue;
    let target = list;
    const previous = mergeableNeighbour(list, 'backward', tagName);
    if (previous) target = mergeListPair(previous, list, created);
    let next = mergeableNeighbour(target, 'forward', tagName);
    while (next) {
      // Read before the merge removes `next`. Whatever separated the two was
      // only formatting noise, so it still separates the survivor from `after`.
      const after = mergeableNeighbour(next, 'forward', tagName);
      target = mergeListPair(target, next, created);
      next = after;
    }
    last = target;
  }
  return last;
}

/**
 * The list `el` may be folded into on that side: the nearest sibling once
 * formatting noise is skipped, and only when it is a list of the same type.
 *
 * {@link significantSiblingInDirection} is what decides "nearest" — it steps
 * over whitespace between tags and HTML comments, and stops at everything else.
 * The element-level accessors this used to ask (`previousElementSibling` /
 * `nextElementSibling`) skip EVERY non-element, so a bare root-level text run
 * between the two lists was invisible to the merge: folding across one carried
 * the second list's items away and left that text BEHIND the merged list, which
 * is where it was then saved. Bare runs are a shape this command now creates
 * lists next to, so the gap they leave is as real as the <table>/<hr> ones
 * {@link contiguousBlockGroups} already keeps in place.
 */
function mergeableNeighbour(
  el: HTMLElement,
  direction: DeleteDirection,
  tagName: string,
): HTMLElement | null {
  const sibling = significantSiblingInDirection(el, direction);
  return sibling instanceof HTMLElement && sibling.tagName === tagName ? sibling : null;
}

/**
 * Merge two adjacent same-type lists into one and return the survivor. `first`
 * precedes `second` in document order and the items keep that order either
 * way, so the only thing the choice of survivor changes is which element's
 * attributes the merged list ends up with — see {@link mergeAdjacentLists} for
 * why a list that was already in the document is the one to keep.
 */
function mergeListPair(
  first: HTMLElement,
  second: HTMLElement,
  created: ReadonlySet<HTMLElement>,
): HTMLElement {
  if (created.has(first) && !created.has(second)) {
    const joined = countChildLi(first);
    // Every item goes before the same anchor, so `first`'s own order survives
    // the move and its items land ahead of `second`'s.
    const anchor = second.firstChild;
    while (first.firstChild) second.insertBefore(first.firstChild, anchor);
    first.remove();
    keepFirstItemNumber(second, joined);
    return second;
  }
  while (second.firstChild) first.appendChild(second.firstChild);
  second.remove();
  return first;
}

/**
 * Move an ordered list's explicit `start` along with the item it names, after
 * `joined` items were inserted AHEAD of the ones the list already had.
 *
 * An `<ol>` numbers item i as `start + i`, or — when `reversed` — as
 * `start - i`. Either way `start` pins the FIRST item, so items arriving in
 * front of it hand that number to a different item and every kept item shifts:
 * converting a paragraph above `<ol start="5">` left the item that read "5."
 * reading "6." while the new one took its number. Moving `start` by the number
 * of arrivals keeps each kept item on the number it was already showing — the
 * same care {@link createListTail} takes when a SPLIT changes the numbering.
 *
 * Only an EXPLICIT start is moved. An absent one means "the default numbering",
 * which is what a reader expects the merged list to show — a list that starts
 * at the default 1 would otherwise need `start="0"`, and a reversed list counts
 * down from its own item count, which already grows by exactly the number of
 * arrivals and so keeps the later items where they were.
 *
 * Nothing to do when items join at the BACK: the kept items keep both their
 * indices and their start.
 */
function keepFirstItemNumber(list: HTMLElement, joined: number): void {
  if (list.tagName !== 'OL' || joined === 0) return;
  const parsed = Number.parseInt(list.getAttribute('start') ?? '', 10);
  if (Number.isNaN(parsed)) return;

  const moved = list.hasAttribute('reversed') ? parsed + joined : parsed - joined;
  // 1 is the default for a forward list, so spelling it out would only add noise.
  if (moved === 1 && !list.hasAttribute('reversed')) list.removeAttribute('start');
  else list.setAttribute('start', String(moved));
}

/** Number of <li> children directly under list. */
function countChildLi(list: Element): number {
  return Array.from(list.children).filter((c) => c.tagName === 'LI').length;
}

/**
 * Split the selected blocks into runs of IMMEDIATE element siblings.
 *
 * {@link selectedBlocks} walks with nextElementSibling and keeps only
 * BLOCK_TAGS, so anything else between two of them — a <table>, a <ul>, a
 * <details> or <pre> the filter dropped — leaves a gap. Building one list out
 * of every block would insert it at the first block's position and then remove
 * the rest, which moves whatever sat in those gaps BEHIND the whole list: a
 * plain Ctrl+A followed by the UL button reordered the document. One list per
 * run converts everything the user selected and leaves the gaps where they are.
 */
function contiguousBlockGroups(blocks: HTMLElement[]): HTMLElement[][] {
  const groups: HTMLElement[][] = [];
  let current: HTMLElement[] = [];
  for (const block of blocks) {
    const previous = current[current.length - 1];
    if (previous && previous.nextElementSibling !== block) {
      groups.push(current);
      current = [];
    }
    current.push(block);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Unwrap the selected list item(s) back into paragraphs, splicing the list. */
function toggleListOff(
  range: Range,
  list: HTMLElement,
  ctx: CommandContext,
  sel: Selection,
): void {
  const startLi = directChildLi(range.startContainer, list);
  if (!startLi) return;
  const endLi = directChildLi(range.endContainer, list) ?? startLi;

  const lis = Array.from(list.children).filter((c) => c.tagName === 'LI') as HTMLElement[];
  const firstIdx = lis.indexOf(startLi);
  let lastIdx = lis.indexOf(endLi);
  if (lastIdx < firstIdx) lastIdx = firstIdx;
  const selected = lis.slice(firstIdx, lastIdx + 1);
  const after = lis.slice(lastIdx + 1);

  const snap = snapshotRange(sel);
  const parent = list.parentNode!;
  const anchor = list.nextSibling;

  // Build a paragraph per selected item; promote any nested list out as a
  // sibling after the paragraph (a list cannot live inside a <p>).
  const frag = document.createDocumentFragment();
  let firstP: HTMLElement | null = null;
  for (const li of selected) {
    const p = document.createElement('p');
    const nested: HTMLElement[] = [];
    for (const child of Array.from(li.childNodes)) {
      const tag = child.nodeType === Node.ELEMENT_NODE ? (child as Element).tagName : '';
      if (tag === 'UL' || tag === 'OL') {
        nested.push(child as HTMLElement);
      } else {
        p.appendChild(child);
      }
    }
    if (p.childNodes.length === 0) p.appendChild(document.createElement('br'));
    if (!firstP) firstP = p;
    frag.appendChild(p);
    for (const n of nested) frag.appendChild(n);
  }

  if (after.length > 0) {
    // The tail carries the list's attributes and continues its numbering; the
    // unwrapped items stop being numbered, so their gap closes (firstIdx is
    // exactly the LI count the head keeps).
    const tail = createListTail(list, firstIdx, after);
    parent.insertBefore(frag, anchor);
    parent.insertBefore(tail, anchor);
  } else {
    parent.insertBefore(frag, anchor);
  }

  for (const li of selected) li.remove();
  if (!hasChildLi(list)) list.remove();

  if (!restoreRange(sel, snap, ctx.root) && firstP) {
    collapseToEnd(sel, firstP);
  }
}

/** Rename the innermost list container ul↔ol, preserving attributes/children. */
function switchListType(
  type: 'ul' | 'ol',
  list: HTMLElement,
  ctx: CommandContext,
  sel: Selection,
): void {
  const snap = snapshotRange(sel);
  const repl = document.createElement(type);
  for (const attr of Array.from(list.attributes)) repl.setAttribute(attr.name, attr.value);
  while (list.firstChild) repl.appendChild(list.firstChild);
  list.replaceWith(repl);

  if (!restoreRange(sel, snap, ctx.root)) {
    collapseToEnd(sel, repl.lastElementChild ?? repl);
  }
}

/**
 * Tab: nest the current <li> under its previous-sibling <li>, reusing that
 * sibling's trailing same-type sublist or creating one. No-op (returns false)
 * when the item is first in its list.
 */
export function indentListItem(ctx: CommandContext): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  const li = findAncestor(range.startContainer, 'LI', ctx.root);
  if (!li) return false;
  const prev = li.previousElementSibling;
  if (!prev || prev.tagName !== 'LI') return false;
  const list = li.parentElement;
  if (!list) return false;

  const snap = snapshotRange(sel);

  let sub = prev.lastElementChild as HTMLElement | null;
  if (!sub || sub.tagName !== list.tagName) {
    sub = document.createElement(list.tagName);
    prev.appendChild(sub);
  }
  sub.appendChild(li);

  restoreRange(sel, snap, ctx.root);
  return true;
}

/**
 * Shift+Tab: un-nest the current <li>. When nested, it moves out to follow its
 * parent <li> in the grandparent list, carrying any trailing siblings as its
 * own children. At the top level it is promoted back to a paragraph (splitting
 * the list when it sits in the middle). Returns whether it mutated.
 */
export function dedentListItem(ctx: CommandContext): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  const li = findAncestor(range.startContainer, 'LI', ctx.root);
  if (!li) return false;
  const list = li.parentElement;
  if (!list) return false;
  const parentLi = list.parentElement;

  if (parentLi && parentLi.tagName === 'LI') {
    const grandList = parentLi.parentElement;
    if (!grandList) return false;

    const snap = snapshotRange(sel);

    // Items following li in the nested list become li's own children so nothing
    // is reordered or lost when li moves up a level.
    const followers: HTMLElement[] = [];
    let n = li.nextElementSibling;
    while (n) {
      if (n.tagName === 'LI') followers.push(n as HTMLElement);
      n = n.nextElementSibling;
    }
    if (followers.length > 0) {
      let sub = li.lastElementChild as HTMLElement | null;
      if (!sub || sub.tagName !== list.tagName) {
        sub = document.createElement(list.tagName);
        li.appendChild(sub);
      }
      for (const f of followers) sub.appendChild(f);
    }

    grandList.insertBefore(li, parentLi.nextSibling);
    if (!hasChildLi(list)) list.remove();

    restoreRange(sel, snap, ctx.root);
    return true;
  }

  // Top-level: promote the item out of the list as a paragraph.
  toggleListOff(range, list, ctx, sel);
  return true;
}

// --- List helpers ----------------------------------------------------------

/**
 * The block(s) the selection intersects. Collapsed selections yield the single
 * caret block. Ranges yield the run of sibling blocks from start to end when
 * they share a parent; otherwise only the start block (conservative fallback).
 */
function selectedBlocks(range: Range, root: HTMLElement): HTMLElement[] {
  const startBlock = findBlockAncestor(range.startContainer, root);
  if (!startBlock) return [];
  const endBlock = findBlockAncestor(range.endContainer, root);
  if (!endBlock || startBlock === endBlock) return [startBlock];
  if (startBlock.parentNode !== endBlock.parentNode) return [startBlock];

  const blocks: HTMLElement[] = [];
  let cur: Element | null = startBlock;
  while (cur) {
    if (cur instanceof HTMLElement && BLOCK_TAGS.has(cur.tagName)) blocks.push(cur);
    if (cur === endBlock) break;
    cur = cur.nextElementSibling;
  }
  return blocks;
}

/** The <li> that is a direct child of list on the path from node up to list. */
function directChildLi(node: Node, list: Element): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== list) {
    if (cur instanceof HTMLElement && cur.tagName === 'LI' && cur.parentElement === list) {
      return cur;
    }
    cur = cur.parentNode;
  }
  return null;
}

function hasChildLi(list: Element): boolean {
  return countChildLi(list) > 0;
}

function collapseToEnd(sel: Selection, el: Node): void {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

function snapshotRange(sel: Selection): RangeSnapshot | null {
  if (sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  return { sc: r.startContainer, so: r.startOffset, ec: r.endContainer, eo: r.endOffset };
}

// Re-apply a snapshotted range. Moving nodes keeps their identity, so the saved
// boundaries stay valid as long as both nodes are still inside root. Returns
// false when the boundaries are gone (e.g. an emptied block was removed) so the
// caller can fall back to an explicit caret position.
function restoreRange(sel: Selection, snap: RangeSnapshot | null, root: Element): boolean {
  if (!snap) return false;
  if (!root.contains(snap.sc) || !root.contains(snap.ec)) return false;
  try {
    const r = document.createRange();
    r.setStart(snap.sc, snap.so);
    r.setEnd(snap.ec, snap.eo);
    sel.removeAllRanges();
    sel.addRange(r);
    return true;
  } catch {
    return false;
  }
}
