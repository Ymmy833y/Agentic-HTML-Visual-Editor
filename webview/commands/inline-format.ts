// Inline range-formatting engine: toggling inline wrappers (strong/em/code/s),
// clearing decorative formatting, and the coverage query the toolbar uses to
// decide whether a format button is active. All the segment-collection and
// range-splitting machinery is private to this module.

import { INLINE_FORMAT_TAGS } from '../shared/constants';
import {
  findAncestor,
  isInCommentMeta,
  nodeDepth,
  resolveToTextBoundary,
  unwrap,
} from '../shared/dom-utils';
import type { CommandContext } from '../shared/command-context';

export type InlineTag = 'strong' | 'em' | 'code' | 's';

// Block-level tags plus the table/comment containers that inline styles must
// never cross — wrapping across them would produce invalid nesting or move
// <comment-body>/<comment-reply> out of their owner.
const SEGMENT_BOUNDARY_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'DIV', 'LI',
  'TD', 'TH', 'CAPTION',
  'COMMENT',
]);

// Decorative inline tags that `clearFormatting` unwraps. `<a>` is omitted on
// purpose: links carry navigation intent, not formatting, matching the
// behavior of Word / Google Docs / Notion's Clear Formatting.
const DECORATIVE_INLINE_TAGS = [
  'STRONG', 'EM', 'CODE', 'S', 'DEL', 'U', 'MARK', 'SUB', 'SUP', 'SPAN', 'FONT',
];

const INLINE_CLEANUP_SELECTOR = Array.from(INLINE_FORMAT_TAGS)
  .map((t) => t.toLowerCase())
  .join(',');

/**
 * Toggle an inline wrapper around the current selection.
 *
 * Rule: ALL text covered → remove; ANY text not covered → apply to whole selection.
 * The operation is performed per-segment so it never crosses block or <comment> boundaries.
 */
export function toggleInline(tag: InlineTag, ctx: CommandContext): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return;

  const tagUpper = tag.toUpperCase();
  const segments = collectSegments(range, ctx.root);

  if (isFullyCovered(range, tagUpper, ctx.root)) {
    for (const seg of segments) removeTagFromRange(seg, tagUpper, ctx.root);
  } else {
    for (const seg of segments) {
      if (!seg.collapsed) applyTagToSegment(seg, tag);
    }
  }

  normalizeInline(ctx.root, tagUpper);
  // Restore the original selection range (best-effort; DOM has changed).
  try {
    sel.removeAllRanges();
    sel.addRange(range);
  } catch { /* range invalidated by mutations — leave selection as-is */ }
}

/**
 * Strip inline formatting from the current selection.
 *
 * Phase 1: unwrap decorative inline wrappers (strong/em/code/s/...).
 * Phase 2: drop `style` and `class` from every element the range fully covers.
 *
 * Elements only partially overlapped by the range keep their attributes —
 * mid-paragraph clearing must not also drop the paragraph's text-align.
 * `<a>`, `<comment>`, and block tags are preserved as elements (their
 * `style` / `class` is still cleared when fully covered).
 */
export function clearFormatting(ctx: CommandContext): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return;

  // Save text-node boundaries before any mutation. Live-range tracking
  // across multiple extractContents calls (one per decorative tag) is
  // brittle — a previous iteration can collapse or shift the range.
  // Text-node references survive splitText and node moves, so rebuilding
  // a fresh range from the saved positions each iteration is the safest path.
  const [sNode, sOff] = resolveToTextBoundary(range.startContainer, range.startOffset);
  const [eNode, eOff] = resolveToTextBoundary(range.endContainer, range.endOffset);

  const buildRange = (): Range | null => {
    try {
      const r = document.createRange();
      const sMax = sNode.nodeType === Node.TEXT_NODE
        ? (sNode as Text).length
        : (sNode as Element).childNodes.length;
      const eMax = eNode.nodeType === Node.TEXT_NODE
        ? (eNode as Text).length
        : (eNode as Element).childNodes.length;
      r.setStart(sNode, Math.min(sOff, sMax));
      r.setEnd(eNode, Math.min(eOff, eMax));
      return r;
    } catch {
      return null;
    }
  };

  for (const tag of DECORATIVE_INLINE_TAGS) {
    const r = buildRange();
    if (!r || r.collapsed) continue;
    removeTagFromRange(r, tag, ctx.root);
  }

  const finalRange = buildRange();
  if (!finalRange) return;

  for (const el of Array.from(ctx.root.querySelectorAll<HTMLElement>('*'))) {
    if (!rangeFullyCoversElement(finalRange, el)) continue;
    if (el.hasAttribute('style')) el.removeAttribute('style');
    if (el.hasAttribute('class')) el.removeAttribute('class');
  }

  try {
    sel.removeAllRanges();
    sel.addRange(finalRange);
  } catch { /* range invalidated by mutations — leave selection as-is */ }
}

/**
 * Return true if every text node in range carries tagName as an ancestor.
 * Used by the toolbar to decide whether to show the button as active.
 */
export function isRangeCovered(range: Range, tagName: string, root: Element): boolean {
  return isFullyCovered(range, tagName, root);
}

// ─── private helpers ──────────────────────────────────────────────────────────

function findSegmentBoundary(node: Node, root: Element): Node {
  let cur: Node | null = node;
  while (cur && cur !== root) {
    if (cur instanceof HTMLElement && SEGMENT_BOUNDARY_TAGS.has(cur.tagName)) return cur;
    cur = cur.parentNode;
  }
  return root;
}

/**
 * True iff every text node overlapping range has tagName as an ancestor.
 * Ignores text inside <comment-body>/<comment-reply>.
 */
function isFullyCovered(range: Range, tagName: string, root: Element): boolean {
  // Walk ALL text nodes in root; filter to those that actually overlap the range.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let found = false;
  let node = walker.nextNode() as Text | null;
  while (node) {
    if (!isInCommentMeta(node, root) && textNodeOverlapsRange(node, range)) {
      found = true;
      if (!findAncestor(node, tagName, root)) return false;
    }
    node = walker.nextNode() as Text | null;
  }
  return found;
}

/**
 * Returns true if the text node has at least one character inside range.
 * Uses Range.comparePoint which is reliable across jsdom and browsers even
 * when the range's startContainer/endContainer are element nodes.
 */
function textNodeOverlapsRange(node: Text, range: Range): boolean {
  try {
    // If node's last character is before range start → no overlap
    if (range.comparePoint(node, node.length) < 0) return false;
    // If node's first character is after range end → no overlap
    if (range.comparePoint(node, 0) > 0) return false;
    return true;
  } catch {
    return range.intersectsNode(node);
  }
}

/**
 * For a <comment> element, return the child offset of the first <comment-body>
 * or <comment-reply> child (i.e. the end of user-editable content).
 * Returns childNodes.length for non-comment elements.
 */
function commentContentEnd(el: HTMLElement): number {
  if (el.tagName !== 'COMMENT') return el.childNodes.length;
  let i = 0;
  for (const child of Array.from(el.childNodes)) {
    if (
      child instanceof HTMLElement &&
      (child.tagName === 'COMMENT-BODY' || child.tagName === 'COMMENT-REPLY')
    ) break;
    i++;
  }
  return i;
}

/**
 * Split the range into sub-ranges that each stay within a single segment
 * boundary (block element or <comment>). This prevents surroundContents from
 * crossing boundaries that would produce invalid HTML or displace comment-body.
 */
function collectSegments(range: Range, root: Element): Range[] {
  const startBoundary = findSegmentBoundary(range.startContainer, root);
  const endBoundary   = findSegmentBoundary(range.endContainer,   root);

  if (startBoundary === endBoundary) return [range.cloneRange()];

  const segments: Range[] = [];

  // Case: startBoundary is nested inside endBoundary
  // (e.g. <comment> inside <p> — start is inside comment, end is outside comment but in same p)
  if (endBoundary instanceof HTMLElement && endBoundary.contains(startBoundary)) {
    const sb = startBoundary as HTMLElement;

    const seg1 = document.createRange();
    seg1.setStart(range.startContainer, range.startOffset);
    // End before <comment-body>/<comment-reply> so they are never wrapped.
    seg1.setEnd(sb, commentContentEnd(sb));
    if (!seg1.collapsed) segments.push(seg1);

    const seg2 = document.createRange();
    seg2.setStartAfter(startBoundary);
    seg2.setEnd(range.endContainer, range.endOffset);
    if (!seg2.collapsed) segments.push(seg2);

    return segments.filter(s => !s.collapsed);
  }

  // General case: startBoundary and endBoundary are siblings or cousins at
  // the same level in the content tree.
  // Segment 1: range.start → end of startBoundary content.
  {
    const sb = startBoundary as HTMLElement;
    const seg = document.createRange();
    seg.setStart(range.startContainer, range.startOffset);
    seg.setEnd(sb, commentContentEnd(sb));
    if (!seg.collapsed) segments.push(seg);
  }

  // Middle segments: sibling boundaries between startBoundary and endBoundary.
  let cur: Node | null = startBoundary.nextSibling;
  while (cur && cur !== endBoundary) {
    if (cur instanceof HTMLElement && SEGMENT_BOUNDARY_TAGS.has(cur.tagName)) {
      const seg = document.createRange();
      seg.setStart(cur, 0);
      seg.setEnd(cur, commentContentEnd(cur));
      if (!seg.collapsed) segments.push(seg);
    }
    cur = cur.nextSibling;
  }

  // Last segment: start of endBoundary content → range.end.
  {
    const eb = endBoundary as HTMLElement;
    const seg = document.createRange();
    seg.setStart(eb, 0);
    seg.setEnd(range.endContainer, range.endOffset);
    if (!seg.collapsed) segments.push(seg);
  }

  return segments.filter(s => !s.collapsed);
}

/**
 * Apply tag to a single segment. The segment must not cross block/<comment>
 * boundaries; surroundContents is expected to succeed for simple ranges and
 * the fallback handles partial inline-element overlaps within the segment.
 */
function applyTagToSegment(seg: Range, tag: InlineTag): void {
  const wrapper = document.createElement(tag);
  try {
    seg.surroundContents(wrapper);
  } catch {
    const contents = seg.extractContents();
    wrapper.appendChild(contents);
    seg.insertNode(wrapper);
  }
  // Unwrap any inner elements of the same tag created by the fallback.
  collapseRedundantNesting(wrapper, tag.toUpperCase());
}

function collapseRedundantNesting(el: Element, tagName: string): void {
  for (const inner of Array.from(el.querySelectorAll(tagName))) {
    unwrap(inner);
  }
}

type ElCoverage = 'fully-covers' | 'el-extends-before' | 'el-extends-after' | 'el-straddles';

/**
 * Classify how range relates to el based on text-node positions inside el.
 * Avoids compareBoundaryPoints with selectNodeContents, which treats element
 * boundaries (e.g. {el, 0}) and text-node boundaries (e.g. {textNode, 0}) as
 * distinct positions in tree order even when they represent the same logical
 * spot — that mismatch causes spurious "el-straddles" classifications.
 */
function classifyElCoverage(range: Range, el: Element): ElCoverage {
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode() as Text | null;
  while (n) {
    if (!isInCommentMeta(n, el)) textNodes.push(n);
    n = walker.nextNode() as Text | null;
  }
  if (textNodes.length === 0) return 'fully-covers'; // empty el → just unwrap

  const first = textNodes[0];
  const last  = textNodes[textNodes.length - 1];

  // range.comparePoint(node, offset): -1 = before range, 0 = in range, 1 = after.
  // rangeCoversElStart: el's first text position is at-or-after range.start (>= 0).
  const rangeCoversElStart = safeComparePoint(range, first, 0) >= 0;
  // rangeCoversElEnd: el's last text-end position is at-or-before range.end (<= 0).
  const rangeCoversElEnd   = safeComparePoint(range, last, last.length) <= 0;

  if (rangeCoversElStart && rangeCoversElEnd) return 'fully-covers';
  if (rangeCoversElStart) return 'el-extends-after';
  if (rangeCoversElEnd)   return 'el-extends-before';
  return 'el-straddles';
}

function safeComparePoint(range: Range, node: Node, offset: number): number {
  try { return range.comparePoint(node, offset); } catch { return 0; }
}

/**
 * True iff range spans from at-or-before el's first text position to
 * at-or-after el's last text position. Uses text-node positions to avoid
 * the `{el, 0}` vs `{textNode, 0}` mismatch that compareBoundaryPoints
 * trips over (same reason classifyElCoverage walks text nodes).
 */
function rangeFullyCoversElement(range: Range, el: Element): boolean {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let n = walker.nextNode() as Text | null;
  while (n) {
    textNodes.push(n);
    n = walker.nextNode() as Text | null;
  }
  if (textNodes.length === 0) {
    // Element has no text — fall back to the parent boundary.
    const elRange = document.createRange();
    try { elRange.selectNode(el); } catch { return false; }
    try {
      if (range.compareBoundaryPoints(Range.START_TO_START, elRange) > 0) return false;
      if (range.compareBoundaryPoints(Range.END_TO_END, elRange) < 0) return false;
      return true;
    } catch { return false; }
  }
  const first = textNodes[0];
  const last = textNodes[textNodes.length - 1];
  try {
    if (range.comparePoint(first, 0) < 0) return false;
    if (range.comparePoint(last, last.length) > 0) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove all tagName elements that intersect range, splitting elements that
 * extend beyond range boundaries so only the within-range portion is removed.
 * Elements are processed deepest-first to handle nested same-tag correctly.
 */
function removeTagFromRange(range: Range, tagName: string, root: Element): void {
  const els = Array.from(root.querySelectorAll<HTMLElement>(tagName))
    .filter(el => range.intersectsNode(el))
    .sort((a, b) => nodeDepth(b, root) - nodeDepth(a, root)); // deepest first

  for (const el of els) {
    if (!root.contains(el)) continue; // may have been removed by an earlier unwrap

    switch (classifyElCoverage(range, el)) {
      case 'fully-covers':
        unwrap(el);
        break;
      case 'el-extends-before':
        // el starts before range, range ends at/after el's end → keep [el.start..range.start] styled.
        splitAtStart(el, range);
        break;
      case 'el-extends-after':
        // range starts at/before el's start, el ends after range → keep [range.end..el.end] styled.
        splitAtEnd(el, range);
        break;
      case 'el-straddles':
        splitAtBoth(el, range);
        break;
    }
  }
}

/**
 * Three-way split for the straddle case (range strictly inside el):
 *   keep in el:   [el.start .. range.start] stays styled
 *   extract out:  [range.start .. range.end] becomes plain (after el)
 *   into clone:   [range.end .. el.end] stays styled (clone after the plain content)
 */
function splitAtBoth(el: HTMLElement, range: Range): void {
  // Split text nodes at both range boundaries while range is still live;
  // splitText updates live ranges per spec, so subsequent range reads see the
  // post-split positions.
  if (range.endContainer.nodeType === Node.TEXT_NODE && el.contains(range.endContainer)) {
    (range.endContainer as Text).splitText(range.endOffset);
  }
  if (range.startContainer.nodeType === Node.TEXT_NODE && el.contains(range.startContainer)) {
    (range.startContainer as Text).splitText(range.startOffset);
  }

  // Extract the "after" portion into a styled clone placed after el.
  const afterExtract = document.createRange();
  afterExtract.setStart(range.endContainer, range.endOffset);
  afterExtract.setEnd(el, el.childNodes.length);
  if (!afterExtract.collapsed) {
    const afterContent = afterExtract.extractContents();
    if (afterContent.firstChild) {
      const clone = el.cloneNode(false) as HTMLElement;
      clone.appendChild(afterContent);
      el.after(clone);
    }
  }

  // Extract the "in-range" portion (now [range.start .. el.end]) out of el as plain.
  const midExtract = document.createRange();
  midExtract.setStart(range.startContainer, range.startOffset);
  midExtract.setEnd(el, el.childNodes.length);
  if (!midExtract.collapsed) {
    const midContent = midExtract.extractContents();
    if (midContent.firstChild) el.after(midContent);
  }
}

/**
 * El starts before range.start.
 * Moves content [range.start .. el.end] out of el (unstyled), right after el.
 * El retains [el.start .. range.start].
 */
function splitAtStart(el: HTMLElement, range: Range): void {
  // Split the text node at range.start if it lives inside el.
  if (
    range.startContainer.nodeType === Node.TEXT_NODE &&
    el.contains(range.startContainer)
  ) {
    (range.startContainer as Text).splitText(range.startOffset);
  }

  const extract = document.createRange();
  extract.setStart(range.startContainer, range.startOffset);
  extract.setEnd(el, el.childNodes.length);
  if (extract.collapsed) return;

  const fragment = extract.extractContents();
  if (!fragment.firstChild) return; // nothing extracted — avoid orphan insertion
  el.after(fragment); // insert unstyled content immediately after el
}

/**
 * El ends after range.end.
 * Moves content [range.end .. el.end] into a styled clone after el.
 * El retains [el.start .. range.end], then is unwrapped.
 */
function splitAtEnd(el: HTMLElement, range: Range): void {
  // Split the text node at range.end if it lives inside el.
  if (
    range.endContainer.nodeType === Node.TEXT_NODE &&
    el.contains(range.endContainer)
  ) {
    (range.endContainer as Text).splitText(range.endOffset);
  }

  const extract = document.createRange();
  extract.setStart(range.endContainer, range.endOffset);
  extract.setEnd(el, el.childNodes.length);

  if (!extract.collapsed) {
    const afterContent = extract.extractContents();
    // Only create a styled clone when there is actual content to preserve.
    if (afterContent.firstChild) {
      const clone = el.cloneNode(false) as HTMLElement;
      clone.appendChild(afterContent);
      el.after(clone);
    }
  }

  // el now contains only the within-range portion: unwrap it.
  unwrap(el);
}

/**
 * Remove empty inline elements and merge adjacent same-tag siblings across
 * ALL inline tags (not just the one being toggled). Adjacent same-tag inline
 * elements that arise from any operation are always merged — e.g.
 * `<em>a</em><em>b</em>` collapses to `<em>ab</em>`.
 */
function normalizeInline(root: Element, _tagName: string): void {
  // Remove empty inline elements. extractContents can leave empty wrappers
  // of any inline tag, not just the toggled one.
  for (const el of Array.from(root.querySelectorAll(INLINE_CLEANUP_SELECTOR))) {
    if (!el.textContent && !el.querySelector('img,br,hr')) el.remove();
  }
  // Merge adjacent same-tag siblings across all inline tags (repeat until stable).
  let changed = true;
  while (changed) {
    changed = false;
    for (const el of Array.from(root.querySelectorAll(INLINE_CLEANUP_SELECTOR))) {
      const next = el.nextSibling;
      if (next instanceof HTMLElement && next.tagName === el.tagName) {
        while (next.firstChild) el.appendChild(next.firstChild);
        next.remove();
        changed = true;
        break; // restart — querySelectorAll snapshot is now stale
      }
    }
  }
}
