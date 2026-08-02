// Deletion around an inline <comment>.
//
// A comment carries its body and replies as display:none,
// contenteditable=false metadata inside the element itself, so every browser
// default deletion near one mistakes that metadata for "the next thing to
// delete" and wipes the annotation as collateral. These handlers stand in
// front of that: they decide whether the browser can be trusted with the
// keystroke and, where it cannot, perform the deletion themselves on visible
// characters only.
//
// The Chromium defaults being stood in front of are measured by the native
// probes in tests/e2e/comment-delete-sweep.spec.ts.

import { BLOCK_TAGS } from '../../shared/constants';
import type { DeleteDirection, DeleteGranularity } from '../../shared/constants';
import {
  bareRunSiblingInDirection,
  blockBoundaryNeighbour,
  deepestEditableText,
  findAncestor,
  findBlockAncestor,
  isCaretAtBlockEnd,
  isCaretAtBlockStart,
  isInCommentMeta,
  nodeImmediatelyAfterCaret,
  nodeImmediatelyBeforeCaret,
} from '../../shared/dom-utils';
import { firstNonEmptyTargetText, lastNonEmptyTargetText } from './comment-dom';

/**
 * Whether a <comment> sits in the caret's block — i.e. within reach of a
 * deletion that spans a whole line.
 *
 * A bare inline run has no block to ask, so the whole root is scanned there.
 * That over-blocks a document whose only comment is elsewhere, which is the
 * right way round: the cost is a keystroke that does nothing, against an
 * annotation the user cannot get back.
 */
export function commentInCaretBlock(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.startContainer)) return false;
  const block = findBlockAncestor(range.startContainer, root);
  return (block ?? root).querySelector('comment') !== null;
}

/**
 * What a deletion this module takes over actually removes: {length} characters
 * from {text}[{index}], or — when {text} is null — the whole (now anchorless)
 * {comment}.
 */
interface DeletionSpot {
  text: Text | null;
  index: number;
  length: number;
  comment: Element | null;
}

/**
 * Where a deletion lands, or why it has nowhere to land: a spot to edit,
 * `'blocked'` when the keystroke must be consumed without editing anything, or
 * null to hand it back to the rest of the chain. See {@link DeletionOutcome}
 * for why the middle case cannot be folded into either of the others.
 */
type SpotResult = DeletionSpot | 'blocked' | null;

/**
 * What a handler in this module did with the keystroke.
 *
 * - `'edited'` — it performed the deletion; the caller records an edit.
 * - `'blocked'` — it consumed the keystroke and changed nothing, because the
 *   only thing beyond the caret is in another block and no safe deletion
 *   exists (see {@link visibleTextBeyondComment}). The caller must
 *   preventDefault() WITHOUT recording an edit — the same trade
 *   isProtectedStructuralBoundary makes — since recording one would mark the
 *   document dirty and push an undo step for a no-op.
 * - `null` — declined; the rest of the beforeinput chain (block merge, the
 *   structural guards, finally the browser) owns the keystroke.
 */
export type DeletionOutcome = 'edited' | 'blocked' | null;

/**
 * Backspace near a comment. Acts only on *visible* characters (target text and
 * the text around it), never on the invisible metadata; far from any comment it
 * returns false and the browser default runs.
 */
export function handleCommentBackspace(
  root: HTMLElement,
  granularity: DeleteGranularity,
): DeletionOutcome {
  return handleCommentDeletion(root, backwardDeletionSpot, granularity);
}

/** Mirror of {@link handleCommentBackspace} for forward deletion. */
export function handleCommentDelete(
  root: HTMLElement,
  granularity: DeleteGranularity,
): DeletionOutcome {
  return handleCommentDeletion(root, forwardDeletionSpot, granularity);
}

function handleCommentDeletion(
  root: HTMLElement,
  findSpot: (
    range: Range,
    root: HTMLElement,
    granularity: DeleteGranularity,
  ) => SpotResult,
  granularity: DeleteGranularity,
): DeletionOutcome {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.startContainer)) return null;

  const spot = findSpot(range, root, granularity);
  if (!spot) return null;
  if (spot === 'blocked') return 'blocked';

  if (spot.text) {
    spot.text.deleteData(spot.index, spot.length);
    return 'edited';
  }
  if (spot.comment) removeAnchorlessComment(spot.comment, selection);
  return 'edited';
}

/**
 * The spot for a deletion running from `offset` inside `text`. Shared by a
 * text-level caret and by an element-level caret resolved onto its adjacent
 * text node, so both get the same granularity-aware comment guard. Returns null
 * outside the comment danger zone, or when the browser's own deletion provably
 * stops short of the comment.
 */
function textDeletionSpot(
  text: Text,
  offset: number,
  direction: DeleteDirection,
  granularity: DeleteGranularity,
  root: HTMLElement,
): DeletionSpot | null {
  if (!isCommentDangerText(text, root, granularity)) return null;
  const comment = findAncestor(text, 'COMMENT', root);
  if (!comment && nativeDeletionStaysClearOfComment(text, offset, direction, granularity, root)) {
    return null;
  }
  if (direction === 'backward') {
    const index = backwardDeletionStart(text, offset, granularity);
    return { text, index, length: offset - index, comment };
  }
  const end = forwardDeletionEnd(text, offset, granularity);
  return { text, index: offset, length: end - offset, comment };
}

/** Backspace: the previous visible characters, skipping comment metadata. */
function backwardDeletionSpot(
  range: Range,
  root: HTMLElement,
  granularity: DeleteGranularity,
): SpotResult {
  const { startContainer: sc, startOffset: so } = range;

  // A deletion within the current text node, only inside the comment danger
  // zone (in a comment's target text, or in text adjacent to a comment).
  if (sc.nodeType === Node.TEXT_NODE && so > 0) {
    return textDeletionSpot(sc as Text, so, 'backward', granularity, root);
  }

  // Otherwise resolve the node the caret faces, following the inline flow out
  // of any wrapper the caret is pinned against.
  const before = adjacentNodeInInlineFlow(range, 'backward', root);
  if (!before) {
    const emptied = commentEmptiedFromInside(range, root);
    if (emptied) return emptied;
    // Nothing inline precedes the caret and the comment still holds a target,
    // so the caret sits at the comment's visible leading edge. The inline-flow
    // walk above stops AT the <comment> (it is not a flow wrapper) and never
    // reaches the comment's own siblings, so what lies beyond them has to be
    // asked for separately — exactly as the trailing edge does in
    // {@link forwardDeletionSpot}.
    const host = findAncestor(sc, 'COMMENT', root);
    if (host && !isInCommentMeta(sc, root)) return blockedBeforeComment(host, root);
    return null;
  }
  if (before.nodeType === Node.TEXT_NODE) {
    // An element-level caret renders at that text node's end; resolving it
    // there keeps a block/inline-level caret on the same guard as a text one.
    const t = before as Text;
    if (t.data.length === 0) return null;
    return textDeletionSpot(t, t.data.length, 'backward', granularity, root);
  }
  if (before.nodeType !== Node.ELEMENT_NODE) return null;
  const comment = ownerCommentForMeta(before as Element);
  if (!comment) return null;
  // Shrink the comment's target from its end; remove it once nothing is left.
  // Deliberately one character at a time whatever the granularity: the caret is
  // outside the comment here, so a keystroke must not swallow a whole word of
  // someone else's annotated text.
  return lastCharSpot(lastNonEmptyTargetText(comment), comment);
}

/**
 * The keystroke that removes a comment a word/line deletion has already emptied
 * from the inside. Used by both directions.
 *
 * Word and line granularity can clear a comment's whole target in one keystroke
 * (see {@link backwardDeletionStart} / {@link forwardDeletionEnd}), leaving the
 * caret in an empty text node inside a comment that now renders as nothing.
 * Backward there is no inline neighbour at all; forward the only neighbour is
 * the comment's own metadata. Either way the browser default would run with the
 * caret pressed against that contenteditable=false metadata. Returning the
 * comment here makes the next keystroke drop it — the same second step both
 * outside-in paths take once {@link lastNonEmptyTargetText} /
 * {@link firstNonEmptyTargetText} runs out, so an annotation is never destroyed
 * by a single keystroke and never lingers as an invisible, unremovable element
 * (serialize.ts deliberately never prunes an empty comment).
 */
function commentEmptiedFromInside(range: Range, root: HTMLElement): DeletionSpot | null {
  const { startContainer: sc } = range;
  const host = findAncestor(sc, 'COMMENT', root);
  if (!host || isInCommentMeta(sc, root)) return null;
  if (lastNonEmptyTargetText(host)) return null;
  return { text: null, index: -1, length: 1, comment: host };
}

/** Delete: the next visible characters, skipping comment metadata. */
function forwardDeletionSpot(
  range: Range,
  root: HTMLElement,
  granularity: DeleteGranularity,
): SpotResult {
  const { startContainer: sc, startOffset: so } = range;

  if (sc.nodeType === Node.TEXT_NODE && so < (sc as Text).data.length) {
    return textDeletionSpot(sc as Text, so, 'forward', granularity, root);
  }

  const after = adjacentNodeInInlineFlow(range, 'forward', root);
  if (after) {
    if (after.nodeType === Node.TEXT_NODE) {
      // Mirror of the backward case: an element-level caret renders at this
      // text node's start.
      const t = after as Text;
      if (t.data.length === 0) return null;
      return textDeletionSpot(t, 0, 'forward', granularity, root);
    }
    if (after.nodeType === Node.ELEMENT_NODE) {
      const el = after as Element;
      if (el.tagName === 'COMMENT') {
        // Just before a comment: delete its first target character.
        return firstCharSpot(firstNonEmptyTargetText(el), el);
      }
      const meta = ownerCommentForMeta(el);
      if (meta) {
        // The metadata is the only thing left beside the caret, so a comment
        // this keystroke's predecessor emptied has to be dropped here rather
        // than handed to the browser default.
        const emptied = commentEmptiedFromInside(range, root);
        if (emptied) return emptied;
        // At a comment's trailing edge (next node is its metadata): skip the
        // metadata and delete the first character of the following text.
        return spotAfterComment(visibleTextBeyondComment(meta, root, 'forward'));
      }
    }
    return null;
  }

  // Caret at the trailing edge inside a comment (after the metadata / its end):
  // the next visible character is the first one of the text following it.
  const emptied = commentEmptiedFromInside(range, root);
  if (emptied) return emptied;
  const host = findAncestor(sc, 'COMMENT', root);
  if (host) return spotAfterComment(visibleTextBeyondComment(host, root, 'forward'));
  return null;
}

/** {@link visibleTextBeyondComment}'s answer, as a forward deletion spot. */
function spotAfterComment(found: TextBeyondComment): SpotResult {
  if (found === 'block-sibling') return 'blocked';
  return found ? firstCharSpot(found, null) : null;
}

/**
 * The leading-edge mirror of {@link spotAfterComment} — deliberately only its
 * `'blocked'` half.
 *
 * Travelling backward the comment's metadata sits on the FAR side of the caret,
 * so the browser default at a leading edge with ordinary text before it is safe
 * (every such position is measured by the sweep in
 * tests/e2e/comment-delete-sweep.spec.ts) and reproducing the deletion here
 * would only take the keystroke away from the block-merge handlers that own a
 * block edge. The one answer that must not be handed back is `'block-sibling'`:
 * a block sitting before the comment in its OWN container ends the caret's line
 * while the container goes on, so no merge handler owns the shape and the
 * default runs with the comment — its display:none, contenteditable=false
 * metadata included — inside its range.
 *
 * Measured, not merely symmetric with the trailing edge: with this guard
 * removed, `<blockquote><p>tail</p><comment>note…</comment></blockquote>` loses
 * the annotation on a single plain Backspace at the target start — the target
 * text lands in the previous paragraph as bare text ("tailnote") and the
 * <comment> with it. Ctrl+Backspace there removes the previous paragraph
 * outright. Both are covered in tests/e2e/comment-delete-sweep.spec.ts.
 */
function blockedBeforeComment(comment: Element, root: HTMLElement): SpotResult {
  return visibleTextBeyondComment(comment, root, 'backward') === 'block-sibling'
    ? 'blocked'
    : null;
}

/**
 * Whether the browser's own word/line deletion provably stops inside this text
 * node instead of reaching the <comment> next to it.
 *
 * The browser skips whitespace and then removes the whole adjacent word, so a
 * word deletion is safe only when a word boundary sits strictly between the
 * comment and the caret — with `<comment>di</comment>ng` the caret in "n|g" is
 * still mid-word, and the native deletion runs straight through the comment and
 * its contenteditable=false body. A line deletion spans the entire visual line,
 * which always contains a comment sitting in it, so it is never handed back.
 * Character deletion never reaches here (the caller keeps it in-house).
 */
function nativeDeletionStaysClearOfComment(
  text: Text,
  offset: number,
  direction: DeleteDirection,
  granularity: DeleteGranularity,
  root: HTMLElement,
): boolean {
  if (granularity === 'character') return false;

  // A caret pinned against a comment renders at the same spot as the comment's
  // own edge, so the browser may resolve its range on the comment's side and
  // take the metadata along — whichever way the deletion then travels.
  if (offset === 0 && reachableComment(text, 'backward', root, 'whitespace')) return false;
  if (
    offset === text.data.length &&
    reachableComment(text, 'forward', root, 'whitespace')
  ) {
    return false;
  }

  if (!reachableComment(text, direction, root, 'whitespace')) return true;
  if (granularity !== 'word') return false;
  return direction === 'backward'
    ? /\s\S/.test(text.data.slice(0, offset))
    : /\S\s/.test(text.data.slice(offset));
}

// What stops a deletion travelling through the inline flow: block-level
// containers, list/table structure, replaced and void content, and the comment
// tags themselves. Everything else is a wrapper the browser reads straight
// through — it treats the text on both sides of one as a single word, so a
// <comment> beyond such a wrapper is still inside the native deletion's range.
//
// Stated as a deny list on purpose, because the sanitizer it has to survive is
// one too: renderer.ts only drops FORBIDDEN_TAGS (script/iframe/style/…), so a
// .html file opened from disk — or pasted HTML, which paste-sanitize strips
// attributes from without dropping the element — can carry any inline tag at
// all (<font>, <abbr>, <q>, <cite>, <kbd>, <ins>, …). An allow list of the
// formats this editor emits cannot keep up with that, and every tag it misses
// silently reopens the metadata-destroying path this guard exists to close.
// Being too wide only costs a deletion we perform ourselves; being too narrow
// costs the user their comment.
const DELETION_FLOW_STOP_TAGS = new Set([
  ...BLOCK_TAGS,
  'UL', 'OL', 'DL', 'DT', 'DD',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH',
  'CAPTION', 'COLGROUP', 'COL',
  'FIGURE', 'FIGCAPTION', 'FORM', 'FIELDSET', 'LEGEND',
  'HR', 'BR', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS',
  'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'IFRAME', 'OBJECT', 'EMBED',
  'COMMENT', 'COMMENT-BODY', 'COMMENT-REPLY',
]);

// Foreign content (<svg>, <math>) is handled by namespace rather than by a
// name in the set above: tagName is only uppercased for HTML-namespace
// elements, so an <svg> reports 'svg' and every entry spelled in the deny
// list's uppercase convention would silently miss it — along with each of its
// descendants (<text>, <title>, <desc>), whose names are lowercase too.
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/**
 * Whether a deletion reads straight through this element rather than stopping
 * at it — the inline-flow counterpart of a word boundary. See
 * {@link DELETION_FLOW_STOP_TAGS} for why this is a deny list.
 *
 * Foreign content stops the scan whatever it holds: an <svg> is replaced
 * content to the browser, so its inner text is never the thing a deletion at
 * the caret acts on. Reading through one would let this editor delete a
 * character out of an imported graphic that the user cannot even see.
 */
function isInlineFlowWrapper(element: Element): boolean {
  if (element.namespaceURI !== HTML_NAMESPACE) return false;
  return !DELETION_FLOW_STOP_TAGS.has(element.tagName);
}

/** One neighbour's verdict for {@link reachableComment}'s inline-flow scan. */
type InlineScanResult = Element | 'stop' | 'continue';

/**
 * How far a deletion reaches before text stops it, which differs by granularity:
 *
 * - `'whitespace'` — word and line deletion. Only whitespace makes a word
 *   boundary, so the scan runs straight through unbroken text.
 * - `'any-text'` — character deletion. It only ever touches what is immediately
 *   beside the caret, so the first rendered character ends the search.
 */
type InlineScanStop = 'whitespace' | 'any-text';

/**
 * Whether the deletion runs past this neighbour, stops at it, or finds a
 * <comment> in it. An inline wrapper is scanned from its facing edge inwards:
 * in `<comment>di</comment><strong>n</strong>g` no comment appears on the
 * caret's own sibling list, yet nothing renders between them either — Chromium
 * reads "Heading" as one word for Ctrl+Backspace, and even a plain Delete at
 * that boundary resolves onto the comment and takes its display:none,
 * contenteditable=false body with it.
 */
function scanInlineNeighbour(
  node: Node,
  direction: DeleteDirection,
  stop: InlineScanStop,
): InlineScanResult {
  if (node.nodeType === Node.TEXT_NODE) {
    const data = (node as Text).data;
    if (data.length === 0) return 'continue'; // renders nothing either way
    return stop === 'any-text' || /\s/.test(data) ? 'stop' : 'continue';
  }
  if (node.nodeType === Node.COMMENT_NODE) return 'continue';
  if (node.nodeType !== Node.ELEMENT_NODE) return 'stop';
  const element = node as Element;
  if (element.tagName === 'COMMENT') return element;
  if (!isInlineFlowWrapper(element)) return 'stop';
  const children = Array.from(element.childNodes);
  if (direction === 'backward') children.reverse();
  for (const child of children) {
    const found = scanInlineNeighbour(child, direction, stop);
    if (found !== 'continue') return found;
  }
  return 'continue';
}

/**
 * The <comment> a deletion travelling in `direction` would reach from `node`,
 * or null. The scan follows the inline flow rather than the sibling list,
 * because that is what the browser does: element boundaries are not deletion
 * boundaries, so it both climbs out of inline wrappers and descends into them
 * (see {@link isInlineFlowWrapper} and {@link scanInlineNeighbour}). Text (per
 * `stop`), a non-inline neighbour, or the enclosing block ends the search.
 */
function reachableComment(
  node: Node,
  direction: DeleteDirection,
  root: HTMLElement,
  stop: InlineScanStop,
): Element | null {
  let current: Node = node;
  while (current !== root) {
    let sibling = direction === 'backward' ? current.previousSibling : current.nextSibling;
    while (sibling) {
      const found = scanInlineNeighbour(sibling, direction, stop);
      if (found === 'stop') return null;
      if (found !== 'continue') return found;
      sibling = direction === 'backward' ? sibling.previousSibling : sibling.nextSibling;
    }
    const parent = current.parentElement;
    if (!parent || parent === root || !isInlineFlowWrapper(parent)) return null;
    current = parent;
  }
  return null;
}

/**
 * Where a backward deletion starts within the caret's own text node. Word and
 * hard-line granularity are clipped to that node, so the removed range can never
 * contain a neighbouring comment or its metadata.
 *
 * Clipping is only ever a *reduction* against what the browser would remove —
 * which is what makes it safe. That holds for a hard line, which is the block
 * this text node lives in. It does NOT hold for a soft line, which is a visual
 * line: the caret's text node spans several of them in a wrapped paragraph, so
 * clipping there would remove lines the user never asked for. Soft lines never
 * reach this function; editor-core blocks the keystroke instead (see
 * DeleteGranularity in shared/constants), and the `!== 'word'` test degrades to
 * the same whole-node reduction if one ever did.
 */
function backwardDeletionStart(
  text: Text,
  offset: number,
  granularity: DeleteGranularity,
): number {
  if (granularity === 'character') return offset - codeUnitsBefore(text.data, offset);
  if (granularity !== 'word') return 0;
  let index = offset;
  while (index > 0 && /\s/.test(text.data[index - 1])) index--;
  while (index > 0 && !/\s/.test(text.data[index - 1])) index--;
  return index;
}

/** Mirror of {@link backwardDeletionStart} for forward deletion. */
function forwardDeletionEnd(
  text: Text,
  offset: number,
  granularity: DeleteGranularity,
): number {
  const end = text.data.length;
  if (granularity === 'character') return offset + codeUnitsAfter(text.data, offset);
  if (granularity !== 'word') return end;
  let index = offset;
  while (index < end && /\s/.test(text.data[index])) index++;
  while (index < end && !/\s/.test(text.data[index])) index++;
  return index;
}

/**
 * What "one visible character" means to a deletion: a grapheme cluster, not a
 * code unit and not a code point.
 *
 * `Text.deleteData` counts UTF-16 code units, so a fixed 1 splits an astral
 * character (emoji, rare CJK) in half and leaves a lone surrogate in the
 * document — which then gets serialized and saved. A code-point rule is not
 * enough either: "e" + U+0301 renders as one é and a family emoji is several
 * code points joined by ZWJ, and taking one of them apart leaves a dangling
 * accent or joiner the user never typed. The browser's own Backspace removes
 * the whole cluster, so a deletion this code performs in its place has to as
 * well.
 *
 * Character granularity is the only deletion that removes a fixed amount; word
 * and line granularity stop at whitespace, which never falls inside a cluster.
 */
const GRAPHEME_SEGMENTER: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** UTF-16 code units the visible character before `offset` occupies. */
function codeUnitsBefore(data: string, offset: number): number {
  if (offset < 1) return 1;
  const cluster = GRAPHEME_SEGMENTER?.segment(data).containing(offset - 1);
  if (cluster) return offset - cluster.index;
  return surrogateUnitsBefore(data, offset);
}

/** Mirror of {@link codeUnitsBefore} for a deletion travelling forward. */
function codeUnitsAfter(data: string, offset: number): number {
  const cluster = GRAPHEME_SEGMENTER?.segment(data).containing(offset);
  if (cluster) return cluster.index + cluster.segment.length - offset;
  return surrogateUnitsAfter(data, offset);
}

/**
 * Surrogate-pair fallback for a runtime without `Intl.Segmenter`. It keeps an
 * astral character whole — the split that corrupts the saved file — and leaves
 * the composed cases to the same one-unit step the editor took before.
 */
function surrogateUnitsBefore(data: string, offset: number): number {
  if (offset < 2) return 1;
  const low = data.charCodeAt(offset - 1);
  const high = data.charCodeAt(offset - 2);
  return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? 2 : 1;
}

/** Mirror of {@link surrogateUnitsBefore}. */
function surrogateUnitsAfter(data: string, offset: number): number {
  if (offset + 2 > data.length) return 1;
  const high = data.charCodeAt(offset);
  const low = data.charCodeAt(offset + 1);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? 2 : 1;
}

/** One visible character at the start of `text`, as a deletion spot. */
function firstCharSpot(text: Text | null, comment: Element | null): DeletionSpot {
  if (!text) return { text: null, index: -1, length: 1, comment };
  return { text, index: 0, length: codeUnitsAfter(text.data, 0), comment };
}

/** One visible character at the end of `text`, as a deletion spot. */
function lastCharSpot(text: Text | null, comment: Element | null): DeletionSpot {
  if (!text) return { text: null, index: -1, length: 1, comment };
  const units = codeUnitsBefore(text.data, text.data.length);
  return { text, index: text.data.length - units, length: units, comment };
}

/**
 * True when a deletion starting in this text node can reach a comment: the node
 * is a comment's target text, or a <comment> sits beside it in the inline flow.
 *
 * Resolved with {@link reachableComment} in both directions for every
 * granularity — the caret may be pinned against a comment on the far side of
 * the one it deletes towards. Only the reach differs: a character deletion stops
 * at the first rendered character, word and line deletion run on to the next
 * whitespace. Neither stops at an element boundary, so a `<strong>` between the
 * caret and the comment hides nothing.
 */
function isCommentDangerText(
  text: Text,
  root: HTMLElement,
  granularity: DeleteGranularity,
): boolean {
  if (findAncestor(text, 'COMMENT', root) && !isInCommentMeta(text, root)) return true;
  const stop = scanStopFor(granularity);
  return (
    reachableComment(text, 'backward', root, stop) !== null ||
    reachableComment(text, 'forward', root, stop) !== null
  );
}

function scanStopFor(granularity: DeleteGranularity): InlineScanStop {
  return granularity === 'character' ? 'any-text' : 'whitespace';
}

/** The comment owning a node that is a comment element or a comment's metadata,
 *  else null. */
function ownerCommentForMeta(el: Element): Element | null {
  if (el.tagName === 'COMMENT') return el;
  if (el.tagName === 'COMMENT-BODY' || el.tagName === 'COMMENT-REPLY') {
    const p = el.parentElement;
    if (p && p.tagName === 'COMMENT') return p;
  }
  return null;
}

/** Remove an anchorless comment and drop the caret where it stood. */
function removeAnchorlessComment(comment: Element, selection: Selection): void {
  const parent = comment.parentNode;
  if (!parent) return;
  const index = Array.prototype.indexOf.call(parent.childNodes, comment);
  comment.remove();
  const r = document.createRange();
  r.setStart(parent, index);
  r.collapse(true);
  selection.removeAllRanges();
  selection.addRange(r);
}

/**
 * What {@link visibleTextBeyondComment} found: the next visible text, or the
 * reason there is none. The two "none" answers are not interchangeable — see
 * that function.
 */
type TextBeyondComment = Text | 'block-sibling' | null;

/**
 * First non-empty *visible* text node beyond a comment within its block, taken
 * in the deletion's direction — a neighbouring comment's hidden metadata is
 * never the answer.
 *
 * Directional rather than one function per edge, because both edges ask the
 * very same question from opposite sides: what the caret's line still holds
 * once the comment itself is stepped over. Written twice it was answered twice,
 * and the leading edge went unanswered for as long as the trailing one had it.
 *
 * Follows the inline flow rather than the comment's own sibling list, the same
 * walk {@link reachableComment} and {@link adjacentNodeInInlineFlow} make. A
 * sibling-only lookup answers "nothing beyond it" for a comment that is the
 * last child of an inline wrapper — `<strong>Hea<comment>ng…</comment></strong>
 * more` is produced by commenting the tail of a bold run — and the callers turn
 * that null into "leave it to the browser", which is the default that takes the
 * display:none, contenteditable=false body with it.
 *
 * Neither the climb NOR the sibling walk may leave the block: text in another
 * block is not the character this deletion removes. The two ways out of the
 * block need opposite answers, which is why this reports which one it hit:
 *
 * - `null` — the walk ran off the end of the enclosing block (`<h2>Hea<comment>
 *   di</comment></h2><p>next</p>`). A block merge may still own the keystroke,
 *   so the caller declines and lets the chain continue.
 * - `'block-sibling'` — a block sits in the comment's OWN container, so the
 *   caret's line ends there while the container goes on (`<blockquote>
 *   <comment>note</comment><p>body</p></blockquote>`, its mirror
 *   `<blockquote><p>body</p><comment>note</comment></blockquote>`, or either
 *   shape at the root, in a <div>, an <li> or a cell — renderer.ts installs
 *   body content verbatim, so a .html file from disk carries it straight into
 *   the view). No merge handler owns that shape, and declining would hand the
 *   keystroke to the browser default with the comment inside its range. The
 *   caller consumes it instead.
 *
 * A <comment> is the one non-wrapper worth descending into: its target text
 * really is the next visible character. Everything else that renders no text of
 * its own (a <br>, an <hr>, an <img>) is stepped over, since
 * {@link deepestEditableText} finds nothing in it either way.
 */
function visibleTextBeyondComment(
  comment: Element,
  root: HTMLElement,
  direction: DeleteDirection,
): TextBeyondComment {
  // Backward wants the LAST text of the neighbour it steps into, the way
  // forward wants the first: the two are the same walk read from either end.
  const backward = direction === 'backward';
  let current: Node = comment;
  while (current !== root) {
    let sibling = backward ? current.previousSibling : current.nextSibling;
    while (sibling) {
      const text = deepestEditableText(sibling, backward);
      if (text) return endsTheLine(sibling) ? 'block-sibling' : text;
      sibling = backward ? sibling.previousSibling : sibling.nextSibling;
    }
    const parent = current.parentElement;
    if (!parent || parent === root || !isInlineFlowWrapper(parent)) return null;
    current = parent;
  }
  return null;
}

/** Whether the text found inside `node` lies beyond the end of the caret's
 *  line — i.e. `node` is a block-level box rather than something the inline
 *  flow reads through. See {@link isInlineFlowWrapper}. */
function endsTheLine(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  return element.tagName !== 'COMMENT' && !isInlineFlowWrapper(element);
}

/**
 * The node the caret faces in the inline flow, climbing out of inline wrappers
 * when the caret sits at a wrapper's inner edge.
 *
 * {@link nodeImmediatelyBeforeCaret} / {@link nodeImmediatelyAfterCaret} only
 * consult the caret's own sibling list, so in `<em>Hea|</em><comment>` they
 * report "nothing after the caret" — yet the comment is the very next thing
 * Chromium's word deletion reaches, and it takes the contenteditable=false body
 * with it. The climb mirrors {@link reachableComment}: it follows the inline
 * flow, because that is what the browser's word iterator does.
 *
 * The walk stops at the enclosing block. A caret at a block edge has no inline
 * neighbour, and reaching into the adjacent block would let a deletion act
 * across a boundary the block-merge handlers own.
 */
function adjacentNodeInInlineFlow(range: Range, direction: DeleteDirection, root: HTMLElement): Node | null {
  const immediate = firstRenderedInDirection(
    direction === 'backward'
      ? nodeImmediatelyBeforeCaret(range)
      : nodeImmediatelyAfterCaret(range),
    direction,
  );
  if (immediate) return facingLeaf(immediate, direction);

  // Nothing beside the caret within its own container, so the caret is at that
  // container's edge. Step out of it — but only while what we are leaving is
  // itself inline content.
  let current: Node = range.startContainer;
  while (current !== root) {
    if (
      current.nodeType === Node.ELEMENT_NODE &&
      !isInlineFlowWrapper(current as Element)
    ) {
      return null;
    }
    const sibling = firstRenderedInDirection(
      direction === 'backward' ? current.previousSibling : current.nextSibling,
      direction,
    );
    if (sibling) return facingLeaf(sibling, direction);
    const parent = current.parentElement;
    if (!parent || parent === root) return null;
    current = parent;
  }
  return null;
}

/**
 * Walk a sibling list from `node` in `direction` until something that actually
 * paints is found. This is {@link scanInlineNeighbour}'s `'continue'` applied
 * to the caret's own neighbourhood: the two must agree on what counts as being
 * in the way, or the caret resolves onto a node the deletion reads straight
 * past. Without it, `<comment>…</comment><strong></strong>|c` — the shape left
 * behind the moment the last character inside a <strong> is deleted — reports
 * the empty wrapper as the thing the caret faces, no owning comment is found,
 * and the keystroke falls through to the browser default that
 * tests/e2e/comment-delete-sweep.spec.ts measures destroying the annotation.
 */
function firstRenderedInDirection(node: Node | null, direction: DeleteDirection): Node | null {
  let current = node;
  while (current && rendersNothing(current)) {
    current = direction === 'backward' ? current.previousSibling : current.nextSibling;
  }
  return current;
}

/**
 * Whether a node paints nothing at all: an empty text node, an HTML comment, or
 * an inline wrapper whose every child paints nothing. Whitespace text is NOT
 * included — it renders, and it is exactly what makes a word boundary.
 *
 * A <comment> and its metadata are never inline-flow wrappers (see
 * {@link DELETION_FLOW_STOP_TAGS}), so an annotation emptied of its target text
 * is never skipped over: the handlers that drop it have to be able to see it.
 */
function rendersNothing(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data.length === 0;
  if (node.nodeType === Node.COMMENT_NODE) return true;
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  if (!isInlineFlowWrapper(element)) return false;
  return Array.from(element.childNodes).every(rendersNothing);
}

/**
 * Descend through inline wrappers to the node the caret actually faces.
 * `…</comment>|<strong>ng</strong>` puts a <strong> beside the caret, but the
 * thing that renders there — and that a deletion acts on — is the "ng" inside
 * it. A <comment> or its metadata is never a wrapper, so those are returned
 * whole for the callers that special-case them. Children that paint nothing are
 * stepped over on the way down for the same reason they are stepped over on the
 * way across (see {@link firstRenderedInDirection}).
 */
function facingLeaf(node: Node, direction: DeleteDirection): Node {
  let current = node;
  while (current.nodeType === Node.ELEMENT_NODE && isInlineFlowWrapper(current as Element)) {
    const child = firstRenderedInDirection(
      direction === 'backward' ? current.lastChild : current.firstChild,
      direction,
    );
    if (!child) return current;
    current = child;
  }
  return current;
}

/**
 * Whether a block-edge deletion would cross into a block that carries a
 * <comment>, with no safe merge available to it.
 *
 * The block-merge handlers in core/editor-core move nodes by reference and so
 * keep every comment in the join whole — but only when BOTH sides are mergeable
 * leaf blocks. A list, a table, or a quote
 * holding nested blocks is neither, so the keystroke falls through to
 * Chromium, whose word range does not stop at the block boundary; the
 * <comment-body> it reaches there is display:none and contenteditable=false,
 * which is exactly what turns a merge into a lost annotation.
 *
 * Measured forward: with this guard removed, Delete at the end of a paragraph
 * followed by a commented list keeps the <comment> but strips its body — at
 * word granularity AND at plain character granularity, which is why no
 * granularity is exempt here. "A character deletion only acts on what is
 * immediately beside the caret" stops being true once the thing beside the
 * caret is a block boundary: the browser's range is resolved from layout, and
 * it reaches the display:none, contenteditable=false metadata in the next block
 * all the same. Backward is not destructive in Chromium today; it is blocked
 * anyway, because a user should not discover that difference by losing an
 * annotation. Both directions and both granularities are covered in
 * tests/e2e/comment-delete-sweep.spec.ts, which also records why this cannot be
 * pinned down with a native probe.
 *
 * The question is whether the neighbour CARRIES a comment, not how near the
 * join it sits. The browser resolves its range from layout this cannot
 * reproduce, and the safe merge being stood in for is whole-block too — so a
 * comment anywhere in that block is reason enough to keep the blocks apart.
 */
export function facesCommentAcrossBlockBoundary(
  root: HTMLElement,
  direction: DeleteDirection,
): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.startContainer)) return false;

  // The same second reading {@link isProtectedStructuralBoundary} in
  // commands/structural-boundary takes, for the same reason: a bare inline run
  // is not delimited by the block the edge test below asks about, so that test
  // cannot see the neighbour the run actually faces — `text|<ul><li>…comment…`
  // at the root has no block ancestor at all, and `<div><ul>…</ul>text|</div>`
  // has one that reaches past the list entirely. Answered first, but only when
  // it says YES, so the block-level test keeps its own.
  //
  // A <comment> the run faces directly is not this guard's case (the deletion
  // handlers above claim that keystroke before it is ever asked), but it is
  // counted all the same: over-blocking costs a keystroke, under-blocking costs
  // the annotation.
  const bareRun = bareRunSiblingInDirection(range, root, direction);
  if (carriesComment(bareRun)) return true;

  const block = findBlockAncestor(range.startContainer, root);
  if (!block) return false;
  const atBoundary = direction === 'backward'
    ? isCaretAtBlockStart(range, block)
    : isCaretAtBlockEnd(range, block);
  if (!atBoundary) return false;

  return carriesComment(blockBoundaryNeighbour(block, root, direction));
}

/** Whether a deletion crossing into `node` would take a <comment> with it. */
function carriesComment(node: Node | null): boolean {
  if (!(node instanceof Element)) return false;
  return node.tagName === 'COMMENT' || node.querySelector('comment') !== null;
}
