// Block-level commands: change the current block's tag, insert horizontal
// rules, and create/transform lists. Operate on the nearest block ancestor of
// the caret.

import { blockOrBareCell, findAncestor, findBlockAncestor, findListContainer, isBlockEmpty } from '../shared/dom-utils';
import { BLOCK_TAGS } from '../shared/constants';
import type { CommandContext } from '../shared/command-context';

export type BlockTag = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'blockquote' | 'pre';

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

/** Replace the current block element's tag (e.g. P → H1). */
export function setBlockTag(tag: BlockTag, ctx: CommandContext): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  const block = ensureBlockInCell(range.startContainer, ctx.root)
    ?? findBlockAncestor(range.startContainer, ctx.root);
  if (!block) return;
  // <summary>/<details> are structural; never rewrite them into a paragraph or
  // heading just because the caret happens to sit inside one.
  if (block.tagName === 'SUMMARY' || block.tagName === 'DETAILS') return;

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
    block.parentNode.insertBefore(details, block.nextSibling);
    if (isBlockEmpty(block)) block.remove();
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

/** Wrap the selection's sibling blocks into a single list, one <li> per block. */
function convertToList(
  type: 'ul' | 'ol',
  range: Range,
  ctx: CommandContext,
  sel: Selection,
): void {
  const blocks = selectedBlocks(range, ctx.root).filter(
    (b) => b.tagName !== 'SUMMARY' && b.tagName !== 'DETAILS',
  );
  if (blocks.length === 0) return;

  const snap = snapshotRange(sel);

  const listEl = document.createElement(type);
  for (const block of blocks) {
    const li = document.createElement('li');
    while (block.firstChild) li.appendChild(block.firstChild);
    if (li.childNodes.length === 0) li.appendChild(document.createElement('br'));
    listEl.appendChild(li);
  }
  const first = blocks[0];
  first.parentNode!.insertBefore(listEl, first);
  for (const block of blocks) block.remove();

  if (!restoreRange(sel, snap, ctx.root)) {
    collapseToEnd(sel, listEl.lastElementChild ?? listEl);
  }
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
    const tail = document.createElement(list.tagName);
    for (const li of after) tail.appendChild(li);
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
  return Array.from(list.children).some((c) => c.tagName === 'LI');
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
