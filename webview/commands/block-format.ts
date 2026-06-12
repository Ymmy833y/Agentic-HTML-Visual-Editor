// Block-level commands: change the current block's tag and insert horizontal
// rules. Operate on the nearest block ancestor of the caret.

import { findBlockAncestor, isBlockEmpty } from '../shared/dom-utils';
import type { CommandContext } from '../shared/command-context';

export type BlockTag = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'blockquote' | 'pre';

/** Replace the current block element's tag (e.g. P → H1). */
export function setBlockTag(tag: BlockTag, ctx: CommandContext): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  const block = findBlockAncestor(range.startContainer, ctx.root);
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

  const block = findBlockAncestor(range.startContainer, ctx.root);

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
