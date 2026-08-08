// Inline range-formatting engine: toggling inline wrappers (strong/em/code/s),
// clearing decorative formatting, and the coverage query the toolbar uses to
// decide whether a format button is active.
//
// The coverage query is TWO exports, not one: {@link collectSegments} splits a
// selection into the stretches a wrapper may cover, and {@link segmentsCovered}
// reads the apply-or-remove verdict off them. They are separate because the
// toolbar asks about four tags per selectionchange and must segment once for
// all of them. Everything else — the range splitting, the wrapper rewrites, the
// snapshot/rebuild machinery — is private to this module.

import { INLINE_FORMAT_TAGS, ROOT_BLOCK_BOUNDARY_TAGS } from '../shared/constants';
import {
  findAncestor,
  isInCommentMeta,
  isRootBlockBoundary,
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
  'TD', 'TH', 'CAPTION', 'FIGCAPTION',
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
  let segments = collectSegments(range, ctx.root);
  // Snapshot the boundaries BEFORE mutating. surroundContents extracts a
  // segment and re-inserts it, which shifts the element-level offsets the live
  // range holds: a whole-document range over `<table>…</table>para` came back
  // covering only the table, so the next Ctrl+B read "not covered" and applied
  // again instead of removing what the first one had applied.
  const bounds = snapshotBoundaries(range);

  if (segmentsCovered(segments, tagUpper, ctx.root)) {
    // The rewrite moves the very nodes these segments are anchored on, so they
    // are collected again afterwards — from the snapshot, not from the live
    // range. Moving a node RESETS every live range whose boundary sits inside
    // it to the node's old parent and index (the DOM remove steps), so the live
    // range comes back collapsed against the very text it was selecting.
    //
    // The old segments are therefore worthless once the rewrite has run, and
    // keeping them was the one failure a toggle must never have: the wrappers
    // came out distributed while the tag stayed applied, so Ctrl+B rewrote the
    // saved HTML and changed nothing the user could see. Dropping them is the
    // honest fallback — the document keeps a shape that renders identically,
    // rather than one the removal has half-finished.
    if (splitWrappersAroundStructure(ctx.root, tagUpper, segments)) {
      const rebuilt = rebuildRange(ctx.root, bounds);
      segments = rebuilt ? collectSegments(rebuilt, ctx.root) : [];
    }
    for (const seg of reversed(segments)) removeTagFromRange(seg, tagUpper, ctx.root);
  } else {
    for (const seg of reversed(segments)) {
      if (!seg.collapsed) applyTagToSegment(seg, tag);
    }
  }

  normalizeInline(ctx.root, tagUpper);
  restoreSelection(sel, ctx.root, range, bounds);
}

/**
 * Rewritten last segment first. A root-level segment is anchored on an INDEX
 * into the editor root, and rewriting an earlier sibling shifts every index
 * behind it: surroundContents extracts the child and inserts the wrapper in its
 * place, which left the following segment pointing one node off and its text
 * unformatted. Walking backwards means every segment still waiting its turn
 * sits BEFORE the one being rewritten, so its anchor cannot move.
 */
function reversed(segments: Range[]): Range[] {
  return segments.slice().reverse();
}

/** The largest valid offset inside node — its text length or its child count. */
function boundaryMax(node: Node): number {
  return node.nodeType === Node.TEXT_NODE
    ? (node as Text).length
    : node.childNodes.length;
}

/**
 * The child node an ELEMENT-level boundary stands next to. A boundary that
 * {@link deepTextBoundary} could not take down to a text position is an INDEX
 * into a child list, and the rewrites below regroup those children — wrapping a
 * run replaces several with one, unwrapping replaces one with several — so the
 * same number afterwards names a different child. A node keeps its identity
 * through every move, so the boundary is remembered as "just before this node"
 * (or, at the end of the list, "just after this one") instead. Same technique as
 * `rootBoundaryIntoBlock` in commands/block-format, for the same reason.
 */
interface ChildAnchor {
  node: Node;
  side: 'before' | 'after';
}

/**
 * A range remembered so it survives the moves a toggle makes.
 *
 * A TEXT boundary is its node and a character offset: no move changes either,
 * and the LENGTH recorded alongside is what says the offset still means what it
 * did — see {@link rebuildRange}. An ELEMENT boundary is remembered by
 * {@link ChildAnchor} instead, because its offset does not survive.
 */
interface TextBoundaries {
  sNode: Node;
  sOff: number;
  sLen: number;
  sAnchor: ChildAnchor | null;
  eNode: Node;
  eOff: number;
  eLen: number;
  eAnchor: ChildAnchor | null;
}

/**
 * How a snapshot resolves a raw range boundary. {@link deepTextBoundary} takes
 * it down to the text the user selected, which is what survives a rewrite;
 * {@link resolveToTextBoundary} stops at the first level, which is what keeps an
 * element-level boundary covering the text-less elements between it and the
 * range's edge. {@link clearFormatting} needs one of each.
 */
type BoundaryResolver = (
  container: Node,
  offset: number,
  side: 'start' | 'end',
) => [Node, number];

function snapshotBoundaries(
  range: Range,
  resolve: BoundaryResolver = deepTextBoundary,
): TextBoundaries {
  const [sNode, sOff] = resolve(range.startContainer, range.startOffset, 'start');
  const [eNode, eOff] = resolve(range.endContainer, range.endOffset, 'end');
  return {
    sNode,
    sOff,
    sLen: boundaryMax(sNode),
    sAnchor: childAnchor(sNode, sOff),
    eNode,
    eOff,
    eLen: boundaryMax(eNode),
    eAnchor: childAnchor(eNode, eOff),
  };
}

/**
 * The {@link ChildAnchor} for an element-level boundary, or null when there is
 * nothing to anchor to: a text boundary (its offset is a character index, which
 * the rewrites never touch) or an element with no children at all. The latter
 * keeps the raw offset, which is harmless — a rewrite that only MOVES existing
 * nodes cannot give an empty element children, and {@link rebuildRange}'s length
 * check catches it if anything else does.
 */
function childAnchor(node: Node, offset: number): ChildAnchor | null {
  if (node.nodeType === Node.TEXT_NODE) return null;
  const at = node.childNodes[offset];
  if (at) return { node: at, side: 'before' };
  const previous = node.childNodes[offset - 1];
  return previous ? { node: previous, side: 'after' } : null;
}

/**
 * Resolve a range boundary to the deepest TEXT position it stands for, looking
 * in the direction of the range's interior.
 *
 * {@link resolveToTextBoundary} only steps into an IMMEDIATE text child, so an
 * element-level boundary — `(p, 1)`, which is what a whole-document selection
 * leaves — comes straight back as an index into that element's child list. Any
 * rewrite that regroups those children then makes the same number name
 * something else: after the wrapper distribution below, `(p, 0)…(p, 1)` covered
 * one of the three children the block had just gained. A text node keeps its
 * identity through every move, which is what makes this snapshot survivable.
 *
 * <comment-body>/<comment-reply> are stepped over: their text is never part of
 * what the user selected, and resolving a boundary into one would put the range
 * inside the metadata the rest of this module works to stay out of. Falls back
 * to the shallow resolution when the direction holds no text at all.
 */
function deepTextBoundary(
  container: Node,
  offset: number,
  side: 'start' | 'end',
): [Node, number] {
  if (container.nodeType === Node.TEXT_NODE) return [container, offset];
  const children = Array.from(container.childNodes);
  const inward = side === 'start'
    ? children.slice(offset)
    : children.slice(0, offset).reverse();
  for (const child of inward) {
    const text = edgeTextIn(child, side);
    if (text) return [text, side === 'start' ? 0 : text.length];
  }
  return resolveToTextBoundary(container, offset);
}

/** The first (or last) non-empty, non-metadata text node in node's subtree. */
function edgeTextIn(node: Node, side: 'start' | 'end'): Text | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node as Text).length > 0 ? (node as Text) : null;
  }
  if (node instanceof HTMLElement && COMMENT_META_TAGS.has(node.tagName)) return null;
  const children = Array.from(node.childNodes);
  if (side === 'end') children.reverse();
  for (const child of children) {
    const text = edgeTextIn(child, side);
    if (text) return text;
  }
  return null;
}

/**
 * The first and last text node of the selection, each lying WHOLLY inside it.
 * Together they address the selected text by node identity alone, which is the
 * one thing a rewrite cannot take away — see {@link pinSelectionText}.
 */
interface PinnedText {
  first: Text;
  last: Text;
}

/**
 * Split the boundary text nodes so the selection begins at the start of one
 * text node and ends at the end of another, and return that pair.
 *
 * This is what lets {@link clearFormatting} address the same text across ELEVEN
 * consecutive rewrites. An offset cannot survive them: {@link splitAtBoth} calls
 * `splitText` at the range's own boundaries, so the boundary node comes back
 * shorter and the same number counts different characters. Clamping it — which
 * is what this used to do — collapsed the range against its own start whenever
 * both boundaries shared one text node, and every remaining tag was then
 * skipped: clearing the middle of `<p><em><span style="color:…">abcdef</span></em></p>`
 * took the <em> off and left the <span> and its colour behind, because 'EM' is
 * processed before 'SPAN'.
 *
 * Splitting up front makes the boundaries element-level for the rest of the
 * command, so `splitAtStart`/`splitAtEnd`/`splitAtBoth` find no text node to
 * split and never move the pins again. A pinned node is fully contained by
 * every range built from it, so `extractContents` MOVES it rather than cloning
 * a substring, and identity survives.
 *
 * Splits are only made strictly inside a node, so no empty text node is ever
 * created, and text-node boundaries are invisible in the serialized HTML.
 * Returns null when there is nothing to pin — a boundary that selects none of
 * its own node, or one that could not be resolved to text at all.
 */
function pinSelectionText(range: Range): PinnedText | null {
  const [sNode, sOff] = deepTextBoundary(range.startContainer, range.startOffset, 'start');
  const [eNode, eOff] = deepTextBoundary(range.endContainer, range.endOffset, 'end');
  if (sNode.nodeType !== Node.TEXT_NODE || eNode.nodeType !== Node.TEXT_NODE) return null;
  let first = sNode as Text;
  let last = eNode as Text;
  if (first === last) {
    if (sOff >= eOff) return null;
  } else if (sOff >= first.length || eOff === 0) {
    // A boundary sitting at the far edge of its own node selects none of it, so
    // pinning there would name text the user did not choose.
    return null;
  }

  // The END split first: when both boundaries share a node, splitting the start
  // would carry the end offset into the new node and leave it pointing at the
  // wrong characters.
  if (eOff > 0 && eOff < last.length) last.splitText(eOff);
  if (sOff > 0 && sOff < first.length) {
    const tail = first.splitText(sOff);
    if (first === last) last = tail;
    first = tail;
  }
  return { first, last };
}

/** The range a {@link PinnedText} stands for, or null once a pin has left the root. */
function pinnedRange(pin: PinnedText, root: Element): Range | null {
  if (!root.contains(pin.first) || !root.contains(pin.last)) return null;
  try {
    const r = document.createRange();
    r.setStartBefore(pin.first);
    r.setEndAfter(pin.last);
    return r.collapsed ? null : r;
  } catch {
    return null;
  }
}

/**
 * Rebuild a range from snapshotted boundaries. Nodes keep their identity
 * through the moves a rewrite makes, whereas offsets into a reparented element
 * do not — so this is what lets anything downstream of a mutation address the
 * text the user actually selected. Returns null when a boundary has left the
 * root, no longer means what it did, or no longer spans anything.
 *
 * A boundary node whose LENGTH changed is one whose offset no longer names the
 * same position, and the snapshot has to be given up rather than repaired.
 * extractContents does not move a partially contained text node: it keeps the
 * original and moves a CLONE of the selected stretch, so the original comes
 * back shorter and every offset into it addresses different characters. The
 * same goes for an element boundary whose children were regrouped. Clamping
 * such an offset — which is what this used to do — silently produces a VALID
 * range over text the user never selected: bolding "plain italic mo" in
 * `<p>plain <em>italic</em> more</p>` came back selecting the untouched "re"
 * as well, so the next Ctrl+B read "not covered" and bolded the whole
 * paragraph instead of removing what the first one had applied.
 *
 * An unchanged length is what the toggle's own rewrites leave behind wherever
 * the rebuild is actually needed: a segment that covers its nodes whole makes
 * extractContents MOVE them, identity and data intact. Everything else falls
 * back to the live range, which the DOM keeps up to date through those same
 * mutations.
 *
 * An ELEMENT boundary never gets that far: its offset is an index the rewrites
 * DO change, so it is placed from its {@link ChildAnchor} — by node identity,
 * which survives every move — rather than repaired or clamped.
 */
function rebuildRange(root: Element, bounds: TextBoundaries): Range | null {
  try {
    const rebuilt = document.createRange();
    if (!placeBoundary(rebuilt, 'start', root, bounds)) return null;
    if (!placeBoundary(rebuilt, 'end', root, bounds)) return null;
    return rebuilt.collapsed ? null : rebuilt;
  } catch {
    return null;
  }
}

/**
 * Place one side of a rebuilt range: from the {@link ChildAnchor} when the
 * boundary was element-level, from the node and offset otherwise. Returns false
 * when the side can no longer be addressed — the node has left the root, or its
 * length no longer matches the one the offset was measured against.
 */
function placeBoundary(
  range: Range,
  side: 'start' | 'end',
  root: Element,
  bounds: TextBoundaries,
): boolean {
  const anchor = side === 'start' ? bounds.sAnchor : bounds.eAnchor;
  if (anchor) {
    if (!root.contains(anchor.node)) return false;
    if (side === 'start') {
      if (anchor.side === 'before') range.setStartBefore(anchor.node);
      else range.setStartAfter(anchor.node);
    } else if (anchor.side === 'before') {
      range.setEndBefore(anchor.node);
    } else {
      range.setEndAfter(anchor.node);
    }
    return true;
  }

  const node = side === 'start' ? bounds.sNode : bounds.eNode;
  const offset = side === 'start' ? bounds.sOff : bounds.eOff;
  const length = side === 'start' ? bounds.sLen : bounds.eLen;
  if (!root.contains(node) || boundaryMax(node) !== length) return false;
  if (side === 'start') range.setStart(node, offset);
  else range.setEnd(node, offset);
  return true;
}

/**
 * Re-establish the user's selection once the toggle has rewritten the DOM.
 *
 * Rebuilt from the snapshotted boundaries whenever both are still in the
 * document and still span something. The live range stays as the fallback for
 * the cases where a boundary was consumed (an unwrap that merged its text
 * away), which is the behavior this had before the rebuild existed.
 */
function restoreSelection(
  sel: Selection,
  root: Element,
  live: Range,
  bounds: TextBoundaries,
): void {
  const rebuilt = rebuildRange(root, bounds);
  if (rebuilt) {
    try {
      sel.removeAllRanges();
      sel.addRange(rebuilt);
      return;
    } catch { /* boundary no longer addressable — fall back to the live range */ }
  }
  try {
    sel.removeAllRanges();
    sel.addRange(live);
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

  // Save the boundaries before any mutation. Live-range tracking across
  // multiple extractContents calls (one per decorative tag) is brittle — the
  // DOM remove steps reset a range whose boundary sits inside a moved node to
  // that node's old parent, so a previous iteration collapses the range against
  // the very text it was covering — so each phase addresses the DOM by NODE
  // IDENTITY instead, which no move takes away.
  //
  // The two phases need DIFFERENT granularities, which is why there are two
  // snapshots rather than one:
  //
  //  - Phase 2 clears attributes at ELEMENT granularity, so it needs the
  //    shallow resolution. A boundary resolved down to the first (or last)
  //    text node stops covering the text-less structural elements between it
  //    and the range's real edge: a `<col style="width:…">` in a fully
  //    selected table kept its width once the boundaries had been pulled in
  //    to the only text the table holds, a cell's. {@link rebuildRange} places
  //    such a boundary from its {@link ChildAnchor}, by node identity, so the
  //    wrapper distribution below cannot make the same index name a different
  //    child — which is how `(p, 0)…(p, 1)` came to cover one of the three
  //    wrappers the paragraph had just gained, and only the first was cleared.
  //  - Phase 1 rewrites the tree ELEVEN times over (once per decorative tag)
  //    and its own splits move the characters an offset counts, so the selected
  //    text is PINNED first: {@link pinSelectionText} splits the boundary text
  //    nodes so the selection begins at the start of one and ends at the end of
  //    another, and those two nodes then address it for every tag.
  const attributeBounds = snapshotBoundaries(range, resolveToTextBoundary);
  const pin = pinSelectionText(range);
  // Nothing to pin (a selection holding no text of its own): keep addressing
  // the range by its resolved boundaries, and let rebuildRange's length check
  // REFUSE a snapshot the rewrites invalidated rather than clamp it into one
  // that covers text the user never selected.
  const textBounds = pin ? null : snapshotBoundaries(range);
  const unwrapRange = (): Range | null => {
    if (pin) return pinnedRange(pin, ctx.root);
    return textBounds ? rebuildRange(ctx.root, textBounds) : null;
  };

  for (const tag of DECORATIVE_INLINE_TAGS) {
    let r = unwrapRange();
    if (!r || r.collapsed) continue;
    // The same precondition {@link toggleInline} establishes, for the same
    // reason: a wrapper that ENCLOSES a <comment>, a list, or a table sends
    // {@link splitAtStart} / {@link splitAtEnd} extracting from a boundary
    // inside that child out to the wrapper's own end, and extractContents
    // clones whatever it only partially contains. That duplicated a
    // <comment> — id and all, one copy left without its body — and split a
    // <ul> in two, reachable by bolding a phrase, commenting a word inside
    // it, and pressing Ctrl+\.
    if (splitWrappersAroundStructure(ctx.root, tag, [r])) {
      r = unwrapRange();
      if (!r || r.collapsed) continue;
    }
    removeTagFromRange(r, tag, ctx.root);
  }

  // The element-level snapshot first: it is the only one that can still reach a
  // text-less <col>/<colgroup>. Where the rewrites invalidated it, the pinned
  // text is exactly what the user selected, so fall back to that rather than to
  // nothing at all.
  const finalRange = rebuildRange(ctx.root, attributeBounds) ?? unwrapRange();
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
 * The apply-or-remove verdict for a toggle, asked of the segments the toggle
 * will operate on rather than of the whole selection. Also what the toolbar
 * shows as the button's active state, so the two cannot disagree: a button
 * that reads "not applied" for a selection the command is about to strip would
 * be worse than any of the skipping described below.
 *
 * The segments and the selection are still not the same range: segmentation
 * drops the stretches that carry no text (pretty-printing between blocks, an
 * empty block's <br> placeholder), and asking {@link isFullyCovered} about the
 * raw selection would count those as "not covered" forever — the toggle could
 * then apply but never remove. Reading the verdict from the segments is what
 * keeps apply and remove talking about the same text.
 */
export function segmentsCovered(segments: Range[], tagName: string, root: Element): boolean {
  if (segments.length === 0) return false;
  return segments.every((seg) => isFullyCovered(seg, tagName, root));
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
 * Ignores text inside <comment-body>/<comment-reply>, and empty text nodes.
 *
 * The empty ones matter: extractContents keeps the ORIGINAL text node and
 * moves a clone into the wrapper, so applying a tag to a whole root-level run
 * leaves a zero-length node behind it, outside the wrapper. It carries no text
 * the user can see, but counting it as "not covered" made the verdict answer
 * "apply" forever — a second Ctrl+B re-applied instead of removing.
 */
function isFullyCovered(range: Range, tagName: string, root: Element): boolean {
  // Walk the text nodes of the range's own subtree; filter to those that
  // actually overlap it. {@link segmentsCovered} asks this question once
  // PER SEGMENT, on the unthrottled selectionchange path the toolbar updates
  // from, so the walk is bounded twice over:
  //
  //  - the common ancestor, not root, is the walk root (nothing outside it can
  //    overlap the range anyway);
  //  - element subtrees that do not intersect the range are REJECTED, which
  //    prunes their descendants too. The scope alone is not enough for a
  //    segment anchored on root's own children (a bare root-level run): its
  //    common ancestor IS root, so an unpruned walk would visit the whole
  //    document once per segment.
  const walker = document.createTreeWalker(
    coverageScope(range),
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node: Node): number {
        if (node.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_ACCEPT;
        return range.intersectsNode(node)
          ? NodeFilter.FILTER_SKIP
          : NodeFilter.FILTER_REJECT;
      },
    },
  );
  let found = false;
  let node = walker.nextNode() as Text | null;
  while (node) {
    if (node.length > 0 && !isInCommentMeta(node, root) && textNodeOverlapsRange(node, range)) {
      found = true;
      if (!findAncestor(node, tagName, root)) return false;
    }
    node = walker.nextNode() as Text | null;
  }
  return found;
}

/**
 * The subtree {@link isFullyCovered} has to walk: the range's common ancestor,
 * or its parent when that ancestor is a text node — a TreeWalker never yields
 * its own root, so a text-node scope would report no text at all. The parent is
 * a superset of the range, which the per-node overlap test then clips.
 */
function coverageScope(range: Range): Node {
  const scope = range.commonAncestorContainer;
  return scope.nodeType === Node.TEXT_NODE ? scope.parentNode ?? scope : scope;
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
 *
 * Exported for callers that ask {@link segmentsCovered} about SEVERAL tags at
 * once: the toolbar refreshes four buttons from the unthrottled selectionchange
 * event, and this is O(nodes the range touches), so it has to happen once per
 * event rather than once per button.
 */
export function collectSegments(range: Range, root: Element): Range[] {
  const startBoundary = findSegmentBoundary(range.startContainer, root);
  const endBoundary   = findSegmentBoundary(range.endContainer,   root);

  // Both ends in the same block or <comment>, and that boundary holds nothing
  // the walk would have to split at: the range is already one wrappable
  // stretch. Taken verbatim so the partial-overlap fallback in
  // {@link applyTagToSegment} still addresses exactly the text the user
  // selected, character offsets included.
  //
  // The structural test is what makes this safe. Both ends resolve to the same
  // block whenever they sit OUTSIDE an inline <comment> the selection merely
  // spans — {@link findSegmentBoundary} only reports the COMMENT for a boundary
  // inside it — so a plain drag across a commented word in one paragraph landed
  // here and surroundContents wrapped the comment, contenteditable=false body
  // and all. Falling through to the walk splits it the same way the
  // whole-document path already did.
  if (
    startBoundary === endBoundary &&
    startBoundary !== root &&
    !holdsStructuralChild(startBoundary)
  ) {
    return [range.cloneRange()];
  }

  const segments: Range[] = [];
  collectSegmentsIn(range, segmentScope(range, root), segments);
  return segments;
}

/**
 * The subtree the walk starts from: the range's common ancestor — its parent
 * when that is a text node, because a walk cannot descend into one — clamped to
 * the editor root. Nothing outside it can overlap the range, so this is what
 * keeps the per-selectionchange cost proportional to the selection rather than
 * to the document.
 */
function segmentScope(range: Range, root: Element): Node {
  const common = range.commonAncestorContainer;
  const scope = common.nodeType === Node.TEXT_NODE ? common.parentNode ?? root : common;
  return scope === root || root.contains(scope) ? scope : root;
}

/**
 * Table plumbing: it holds no inline content of its own and is no segment
 * boundary either, but a segment that swallowed one would put a <tbody> or a
 * <tr> inside a <strong>. Descended into like any other structural child.
 */
const SEGMENT_SPLIT_TAGS = new Set(['THEAD', 'TBODY', 'TFOOT', 'TR', 'COLGROUP', 'COL']);

/**
 * A comment's own metadata. Never wrapped and never descended into: it carries
 * no text the user selected, and moving it into an inline wrapper corrupts the
 * comment. Unreachable through a <comment> the walk enters (the walk stops at
 * {@link commentContentEnd}), so this only has to answer for a stray one — but
 * it is also what {@link STRUCTURAL_CHILD_SELECTOR} needs in order to keep the
 * verbatim fast path away from a range that reaches into a body.
 */
const COMMENT_META_TAGS = new Set(['COMMENT-BODY', 'COMMENT-REPLY']);

/** A child no segment may wrap or cross — it is descended into instead. */
function isStructuralChild(node: Node): boolean {
  return (
    node instanceof HTMLElement &&
    (SEGMENT_BOUNDARY_TAGS.has(node.tagName) ||
      isRootBlockBoundary(node) ||
      SEGMENT_SPLIT_TAGS.has(node.tagName) ||
      // A code block's <code> is not a boundary anywhere else — inline <code>
      // is an inline format this command toggles — but under a <pre> it is the
      // element that holds the block's content. Wrapping it whole produced
      // `pre > strong > code` for a selection that merely spans the block,
      // while a selection made INSIDE it produced `pre > code > strong`, the
      // nesting the rest of the editor emits. Descending here makes both
      // paths agree.
      isPreCode(node))
  );
}

/** The <code> element a <pre> keeps its content in. */
function isPreCode(el: HTMLElement): boolean {
  return el.tagName === 'CODE' && el.parentElement?.tagName === 'PRE';
}

/** {@link isStructuralChild} as a selector, for asking about a whole subtree. */
const STRUCTURAL_CHILD_SELECTOR = Array.from(
  new Set([
    ...SEGMENT_BOUNDARY_TAGS,
    ...ROOT_BLOCK_BOUNDARY_TAGS,
    ...SEGMENT_SPLIT_TAGS,
    ...COMMENT_META_TAGS,
  ]),
)
  .map((tag) => tag.toLowerCase())
  .join(',');

/**
 * Whether el holds anything {@link collectSegmentsIn} would split at or descend
 * into. Asked of a single block by {@link collectSegments} before it takes its
 * verbatim fast path, so it is one native query that stops at the first match —
 * and it answers "no" for the overwhelmingly common block of plain text and
 * inline marks, which is what keeps that fast path in place.
 */
function holdsStructuralChild(node: Node): boolean {
  return node instanceof Element && node.querySelector(STRUCTURAL_CHILD_SELECTOR) !== null;
}

/**
 * Collect the segments the range covers inside `container`: one per contiguous
 * run of inline children, descending into every structural child the range
 * touches.
 *
 * Descending is the whole point. A container the walk merely stepped OVER — a
 * <ul>, a <table>, a <details> — kept its interior unformatted while
 * {@link segmentsCovered}, reading these same segments, reported the button as
 * active. And a boundary element the walk wrapped WHOLE took its nested content
 * with it: that is how a plain Ctrl+A then Ctrl+B put a <comment> and its
 * contenteditable=false body inside a <strong>, and how a nested list ended up
 * inside its parent item's wrapper. Walking children instead of wrapping the
 * container fixes both at once, at every depth.
 *
 * Runs are clipped to the range at both ends: a boundary point that lies inside
 * the run's first (or last) node is used verbatim, so a selection starting
 * mid-word stays mid-word. A run carrying no text at all — pretty-printing
 * between blocks, a lone <br> placeholder — is dropped rather than turned into
 * an empty wrapper.
 *
 * A <comment>'s children are walked only up to {@link commentContentEnd}, so
 * <comment-body>/<comment-reply> are unreachable through the comment itself
 * rather than by a clip each caller has to remember; a stray one reached any
 * other way is skipped outright ({@link COMMENT_META_TAGS}).
 *
 * An inline element is ordinarily part of a run — that is what keeps
 * `<em>text</em>` inside one wrapper — but one that HOLDS something structural
 * has to be entered all the same. Without that, `<strong>a<comment>…</comment>b</strong>`
 * was absorbed whole and surroundContents put the <comment> and its
 * contenteditable=false body inside the new wrapper: exactly the corruption the
 * split exists to prevent, reachable by bolding a phrase, commenting a word
 * inside it, then pressing Ctrl+A Ctrl+I. Entering it yields the same shape a
 * drag made entirely inside that wrapper already produced.
 */
function collectSegmentsIn(range: Range, container: Node, out: Range[]): void {
  const limit = container instanceof HTMLElement
    ? commentContentEnd(container)
    : container.childNodes.length;

  let runFirst: Node | null = null;
  let runLast: Node | null = null;
  const flushRun = (): void => {
    if (runFirst && runLast) {
      const seg = document.createRange();
      // `contains` is true for the node itself, which is the common case: the
      // boundary sits in the very text node the run starts (or ends) with.
      if (runFirst.contains(range.startContainer)) {
        seg.setStart(range.startContainer, range.startOffset);
      } else {
        seg.setStartBefore(runFirst);
      }
      if (runLast.contains(range.endContainer)) {
        seg.setEnd(range.endContainer, range.endOffset);
      } else {
        seg.setEndAfter(runLast);
      }
      if (!seg.collapsed && /\S/.test(seg.toString())) out.push(seg);
    }
    runFirst = null;
    runLast = null;
  };

  for (const child of Array.from(container.childNodes).slice(0, limit)) {
    // The range is contiguous, so the children it misses can only be at the
    // ends of this list — skipping one can never join two separate runs.
    if (!range.intersectsNode(child)) continue;
    if (child instanceof HTMLElement && COMMENT_META_TAGS.has(child.tagName)) {
      flushRun();
      continue;
    }
    // An inline child joins the run only when nothing inside it has to be split
    // at; otherwise it is entered like any structural child.
    if (!isStructuralChild(child) && !holdsStructuralChild(child)) {
      runFirst ??= child;
      runLast = child;
      continue;
    }
    flushRun();
    collectSegmentsIn(range, child, out);
  }
  flushRun();
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
 * Rewrite every tagName wrapper the removal is about to touch that HOLDS
 * something structural, so that it no longer encloses it: the wrapper is
 * distributed over each contiguous inline run and re-applied INSIDE the
 * structural child. That is the same shape {@link collectSegmentsIn} and
 * {@link applyTagToSegment} produce when the tag is applied, so removal and
 * application finally reason about the same DOM.
 *
 * Without it, {@link removeTagFromRange} reaches {@link splitAtStart} /
 * {@link splitAtEnd} with a boundary INSIDE the structural child while their
 * extraction runs to the WRAPPER's own end — across that child's edge.
 * extractContents then clones the partially contained element, which duplicated
 * a `<comment>` (id and all, one copy left empty and its body carried into the
 * other) and split a `<ul>` into two lists. Reachable with two ordinary
 * commands: bold a phrase, comment a word inside it, then un-bold.
 *
 * A wrapper is chosen by INTERSECTION and rewritten END TO END, so the rewrite
 * reaches text the selection never covered: un-bolding one word of
 * `<strong>alpha <comment>beta…</comment> gamma</strong>` gives `beta` and
 * ` gamma` wrappers of their own as well. Nothing renders differently — every
 * run keeps the tag and the attributes it had — but the saved HTML changes
 * outside the selection, and the three-way diff shows it. Clipping the rewrite
 * to the selection is not an option: the whole point is that the wrapper must
 * stop enclosing the structural child, which is a property of the wrapper, not
 * of the range. Pinned in tests/unit/commands.test.ts ("rewrites the whole
 * wrapper, not only the part the selection covers").
 *
 * Returns whether it rewrote anything, so the caller knows to collect its
 * segments again — the rewrite moves the very nodes they are anchored on.
 */
function splitWrappersAroundStructure(
  root: Element,
  tagName: string,
  segments: Range[],
): boolean {
  const wrappers = Array.from(root.querySelectorAll<HTMLElement>(tagName)).filter(
    (el) => holdsStructuralChild(el) && segments.some((seg) => seg.intersectsNode(el)),
  );
  if (wrappers.length === 0) return false;

  for (const el of wrappers) {
    // An outer wrapper distributed first can carry an inner one out of the
    // document, and can leave it holding nothing structural after all.
    if (root.contains(el) && holdsStructuralChild(el)) {
      wrapRunsIn(el, el);
      unwrap(el);
    }
  }
  return true;
}

/**
 * Wrap each contiguous inline run of `container` in a fresh clone of
 * `template`, descending into every structural child instead of enclosing it —
 * the run-by-run rule {@link collectSegmentsIn} walks by, performed rather than
 * collected. `template` supplies the tag AND the attributes, the same way
 * {@link splitAtEnd} clones a wrapper it has to keep a styled remainder in.
 *
 * A run carrying no text is left bare: it is what {@link collectSegmentsIn}
 * drops, so wrapping it would leave behind a wrapper no segment can ever come
 * back for. The two have to agree on more than whitespace — a run of nothing
 * but an <img> or a <br> carries no text either, and wrapping one produced a
 * `<strong>` the removal could no longer reach, kept in the saved file with no
 * way to toggle it off. Both sides therefore ask the same question:
 * {@link hasVisibleText}.
 *
 * `state` carries the one attribute that may not simply be copied onto every
 * clone: an `id` has to stay unique in the document, so only the FIRST run
 * keeps it and the rest are stripped — the same rule {@link createListTail} in
 * commands/block-format applies when a split has to keep a list's attributes.
 * Dropping it everywhere instead would delete an anchor target the file may
 * depend on; the first run is the closest thing to the element that carried it.
 * The state is threaded through the recursion because the runs of a nested
 * structural child are clones of the same template.
 */
function wrapRunsIn(
  container: Node,
  template: HTMLElement,
  state: { idTaken: boolean } = { idTaken: false },
): void {
  // A <comment>'s metadata is past this limit, so it is never wrapped and never
  // descended into — the same bound the segment walk uses.
  const limit = container instanceof HTMLElement
    ? commentContentEnd(container)
    : container.childNodes.length;

  let run: Node[] = [];
  const flushRun = (): void => {
    if (run.some(hasVisibleText)) {
      const wrapper = template.cloneNode(false) as HTMLElement;
      if (wrapper.hasAttribute('id')) {
        if (state.idTaken) wrapper.removeAttribute('id');
        else state.idTaken = true;
      }
      container.insertBefore(wrapper, run[0]);
      for (const node of run) wrapper.appendChild(node);
    }
    run = [];
  };

  for (const child of Array.from(container.childNodes).slice(0, limit)) {
    if (child instanceof HTMLElement && COMMENT_META_TAGS.has(child.tagName)) {
      flushRun();
      continue;
    }
    if (isStructuralChild(child) || holdsStructuralChild(child)) {
      flushRun();
      wrapRunsIn(child, template, state);
      continue;
    }
    run.push(child);
  }
  flushRun();
}

/**
 * Whether node's subtree carries any non-whitespace text — the test
 * {@link collectSegmentsIn} drops a run by, stated for a single node so
 * {@link wrapRunsIn} can apply it to the run it is about to wrap.
 */
function hasVisibleText(node: Node): boolean {
  return /\S/.test(node.textContent ?? '');
}

/**
 * Remove all tagName elements that intersect range, splitting elements that
 * extend beyond range boundaries so only the within-range portion is removed.
 * Elements are processed deepest-first to handle nested same-tag correctly.
 *
 * The range must not cross a structural boundary and no intersecting wrapper
 * may hold one — {@link splitWrappersAroundStructure} is what guarantees the
 * second half for {@link toggleInline}.
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
