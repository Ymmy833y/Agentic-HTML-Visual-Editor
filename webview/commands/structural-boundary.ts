// Deletion at the edge of a structural block (<details>/<summary>/<pre>/<table>).
//
// Chromium does not safely no-op at these boundaries: crossing a details/summary
// boundary can discard the details body, crossing a pre boundary moves text
// inside the <pre> but outside its <code> wrapper, and crossing a table boundary
// dissolves the adjacent paragraph into a bare text node directly under the
// root. There is no unambiguous flat merge for any of these shapes, so the
// browser default is blocked. The one deletion that IS meaningful there —
// dropping the empty block left behind when exiting a code block (or an empty
// paragraph beside a details/table) — is performed here instead.
//
// The native defaults these two entry points stand in front of are measured in
// tests/e2e/structural-boundaries.spec.ts (native probe).

import { BLOCK_TAGS } from '../shared/constants';
import type { DeleteDirection } from '../shared/constants';
import {
  bareRunSiblingInDirection,
  climbToBoundaryNeighbour,
  deepestEditableText,
  findBlockAncestor,
  isBlockEmptyOrStubBr,
  isCaretAtBlockEnd,
  isCaretAtBlockStart,
  isContentEditableFalse,
  significantNodeFrom,
  significantSiblingInDirection,
} from '../shared/dom-utils';
import { isCaretAtPreEdge, isEmptyPrePlaceholder } from './code-block';

// TABLE is protected for the same reason as the others: Chromium's default
// merge at a table edge does not stop at the boundary — Backspace at the start
// of the block after a table unwraps that block into a bare text node under
// the root (measured on a native probe in
// tests/e2e/structural-boundaries.spec.ts).
//
// This set also feeds {@link handleEmptyBlockAtStructuralBoundary}, so the
// deliberate edit it performs now applies beside a table too: an empty block
// at the table's outer edge is DROPPED and the caret moves into the nearest
// cell, including an empty first <li> the climb reaches the table from. That
// is the same trade already made beside a <pre>/<details>, and the opposite of
// what happens INSIDE a cell, where the browser's outdent is left alone. Both
// halves are pinned in tests/unit/editor-core.test.ts.
const PROTECTED_STRUCTURAL_TAGS = new Set(['DETAILS', 'SUMMARY', 'PRE', 'TABLE']);

// The subset whose protection also carries through a CLIMB — a caret whose own
// block sits at the edge of a container nested inside the structure, so the
// deletion would leave that container before reaching the structural edge.
//
// TABLE is deliberately absent, and that is not a subtlety of the climb: the
// climb out of a cell's only block does reach the table (through TD/TR/TBODY),
// which is exactly why the distinction has to be stated here rather than left
// implicit. Chromium simply refuses to merge across a cell boundary in either
// direction, so an in-cell caret never reaches the table's outer edge by
// default — Backspace at the start of a first cell, Delete at the end of a
// last cell, and every crossing between cells are all plain no-ops. Inheriting
// the table's protection there would consume keystrokes that edit nothing, and
// would swallow the one in-cell default that IS meaningful: outdenting an
// empty first list item into a paragraph, which stays inside the cell. All of
// these are measured in tests/e2e/structural-boundaries.spec.ts, both on a
// native probe and against the real editor root.
//
// The cell-to-cell crossings need a table that HAS a second cell, so they are
// measured on a 2x2 grid rather than the single-cell table the outer-edge cases
// use: Backspace at the start of a second cell, Delete at the end of a first
// one, and Backspace at the start of a second row. A single-cell table has no
// boundary to cross, so it can say nothing about this exclusion.
const CLIMB_PROTECTED_TAGS = new Set(
  Array.from(PROTECTED_STRUCTURAL_TAGS).filter((tag) => tag !== 'TABLE'),
);

// Tags that can hold a collapsed caret once a structural block turns out to
// carry no text. Derived from BLOCK_TAGS so a new block tag is never missed
// here, plus the cell/code hosts that are deliberately not block tags.
const EDITABLE_HOST_TAGS = new Set([...BLOCK_TAGS, 'TD', 'TH', 'CODE']);

// PRE and DETAILS only ever wrap the real host (CODE / SUMMARY), so they
// qualify as the node itself but are never the descendant we descend into.
const NESTED_EDITABLE_HOST_SELECTOR = Array.from(EDITABLE_HOST_TAGS)
  .filter((tag) => tag !== 'PRE' && tag !== 'DETAILS')
  .map((tag) => tag.toLowerCase())
  .join(',');

/**
 * Remove an empty ordinary block at a protected structural boundary. Unlike a
 * blocked merge, this is an intentional edit: it lets users undo a paragraph
 * created when exiting a code block (and the equivalent empty block beside
 * details) without moving any structural content across the boundary.
 */
export function handleEmptyBlockAtStructuralBoundary(
  root: HTMLElement,
  direction: DeleteDirection,
): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.startContainer)) return false;

  const block = findBlockAncestor(range.startContainer, root);
  if (!block) return false;
  // Checked ahead of the edge test on purpose: Chromium empties a <pre> down to
  // a bare <br>, which isCaretAtPreEdge counts as content, so the edge test
  // would report "not at a boundary" and hand the placeholder to the browser
  // default — which merges the next block INTO the pre and drops its <code>.
  if (block.tagName === 'PRE' && isEmptyPrePlaceholder(block)) {
    return removeEmptyPre(block, selection, direction);
  }
  const atBoundary = isCaretAtStructuralBlockEdge(range, block, direction);
  if (!atBoundary) return false;

  // The same climb {@link isProtectedStructuralBoundary} makes. Without it the
  // drop would only see a direct sibling while the protection reaches through a
  // container, so an empty block at the edge of a list or a quote next to a
  // <pre> would be guarded into a keystroke that consumes the key and changes
  // nothing — while the identical bare <p><br></p> is removed.
  const { neighbour: adjacent, crossed } = climbToBoundaryNeighbour(block, root, direction);
  if (!(adjacent instanceof HTMLElement)) return false;
  if (isDetailsSummaryPair(block, adjacent)) return false;

  const blockProtected = PROTECTED_STRUCTURAL_TAGS.has(block.tagName);
  const adjacentProtected = PROTECTED_STRUCTURAL_TAGS.has(adjacent.tagName);
  let emptyBlock: HTMLElement;
  let structuralBlock: HTMLElement;
  let placeAtEnd: boolean;

  if (!blockProtected && adjacentProtected && isDroppableEmptyBlock(block)) {
    // The caret's own block goes, so the containers the climb left behind are
    // unwound with it — but only the ones that mean nothing once emptied.
    if (!crossed.every(isUnwindableContainer)) return false;
    emptyBlock = block;
    structuralBlock = adjacent;
    placeAtEnd = direction === 'backward';
  } else if (
    blockProtected &&
    // Mirror case only: here the block that goes is the one BEYOND the climb,
    // so a non-empty `crossed` would mean deleting a block outside the
    // structure the caret is actually in.
    crossed.length === 0 &&
    !adjacentProtected &&
    isDroppableEmptyBlock(adjacent)
  ) {
    emptyBlock = adjacent;
    structuralBlock = block;
    placeAtEnd = direction === 'forward';
  } else {
    return false;
  }

  if (!placeCaretAtStructuralEdge(selection, structuralBlock, placeAtEnd)) {
    return false;
  }
  emptyBlock.remove();
  if (emptyBlock === block) removeEmptiedContainers(crossed);
  return true;
}

/**
 * A container an empty block may be unwound out of when it is dropped at a
 * structural boundary. Deliberately narrow: a list, a list item, or a quote
 * left holding nothing renders as nothing, whereas table structure, <details>,
 * and an imported <div> wrapper carry meaning of their own and must never be
 * removed by a single Backspace. A container outside this set makes the drop
 * decline entirely, so the keystroke falls back to the structural protection.
 */
function isUnwindableContainer(el: Element): boolean {
  return el.tagName === 'UL' || el.tagName === 'OL' || el.tagName === 'LI'
    || el.tagName === 'BLOCKQUOTE';
}

/**
 * Drop the containers a removed empty block left behind, innermost first.
 * {@link climbToBoundaryNeighbour} only steps out of a container when the block
 * sat at its edge with nothing beside it, so one that is empty now held nothing
 * else; leaving it would keep an invisible <ul>/<blockquote> in the document.
 * The walk stops at the first container that still has content, which is what
 * keeps the other items of a list the block was merely the first of.
 */
function removeEmptiedContainers(containers: HTMLElement[]): void {
  for (const container of containers) {
    if (!isBlockEmptyOrStubBr(container)) return;
    container.remove();
  }
}

/**
 * Whether a browser-default deletion would cross a structural block boundary
 * that cannot be represented as a safe flat merge. This deliberately checks
 * the current block first, then climbs only while there is no sibling in the
 * deletion direction. This preserves native editing within lists, quotes, and
 * tables while protecting the outer edge of an enclosing details element.
 */
export function isProtectedStructuralBoundary(
  root: HTMLElement,
  direction: DeleteDirection,
): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.startContainer)) return false;

  // A caret in a bare inline run is not delimited by the block the edge test
  // below asks about, so that test cannot see the structural neighbour the run
  // actually faces. Answered first — but only when it says YES. A bare run's
  // neighbour is a second, narrower reading of the same keystroke: it can find
  // a hazard the block-level test misses, and it must never overrule the
  // block-level test's own yes, which the enclosing block or the climb out of
  // its container may still produce (`<pre>…</pre><p><br>|text</p>` faces a
  // <br> as a run and the <pre> as a block).
  const bareRun = bareRunSiblingInDirection(range, root, direction);
  if (bareRun && isProtectedStructuralElement(bareRun)) return true;

  const block = findBlockAncestor(range.startContainer, root);
  if (!block) return false;
  const atBoundary = isCaretAtStructuralBlockEdge(range, block, direction);
  if (!atBoundary) return false;

  if (PROTECTED_STRUCTURAL_TAGS.has(block.tagName)) return true;

  // The climb may leave a list, quote, or table. Chromium does NOT break the
  // item out of its container there — it merges the block into the structural
  // sibling, dropping <code> out of a pre and wrapping the moved text in a
  // presentational span — so the outer neighbour protects the caret's block
  // through the container just the same, and a protected container the climb
  // steps out of protects it directly. See the native probes in
  // tests/e2e/structural-boundaries.spec.ts.
  const { neighbour, crossed } = climbToBoundaryNeighbour(block, root, direction);
  if (crossed.some((el) => CLIMB_PROTECTED_TAGS.has(el.tagName))) return true;
  return neighbour !== null && isProtectedStructuralElement(neighbour);
}

function isCaretAtStructuralBlockEdge(
  range: Range,
  block: HTMLElement,
  direction: DeleteDirection,
): boolean {
  if (block.tagName === 'PRE') {
    // A <pre> emptied down to Chromium's bare <br> placeholder has no interior,
    // so the caret is at both of its edges. Asked ahead of isCaretAtPreEdge,
    // which counts that <br> as content and would answer "not at a boundary"
    // for a caret sitting before it. {@link handleEmptyBlockAtStructuralBoundary}
    // drops such a pre wherever it can, but it declines when the neighbour
    // offers nowhere to put the caret (an <hr>, a bare <img>) or when there is
    // no neighbour at all — and without this the keystroke would then reach the
    // very default this module stands in front of. Measured on a native probe
    // in tests/e2e/structural-boundaries.spec.ts: `<pre><br></pre><p>text</p>`
    // pulls the paragraph INTO the pre, and `<pre><br></pre><hr>` takes the
    // <hr> and the pre's own placeholder together, leaving `<pre></pre>` —
    // a code block with no line in it that the user cannot type into.
    return isEmptyPrePlaceholder(block) || isCaretAtPreEdge(range, block, direction);
  }
  return direction === 'backward'
    ? isCaretAtBlockStart(range, block)
    : isCaretAtBlockEnd(range, block);
}

/**
 * An empty block the boundary handler may drop. {@link isBlockEmptyOrStubBr}
 * only reasons about text blocks — every childless element answers "empty" to
 * it — so membership in {@link BLOCK_TAGS} is what keeps a void neighbour (an
 * <hr>, a bare <img> in imported HTML) from being mistaken for a leftover
 * placeholder and deleted.
 */
function isDroppableEmptyBlock(el: Element): boolean {
  return BLOCK_TAGS.has(el.tagName) && isBlockEmptyOrStubBr(el);
}

/**
 * A summary and the details body it belongs to: removing the block on either
 * side of that pair would leave a details element in a shape no command emits,
 * so no deletion may join or drop across it.
 *
 * Containment rather than siblinghood, because the climb in
 * {@link handleEmptyBlockAtStructuralBoundary} means the two need not be
 * siblings — an empty <li> at the top of the list that IS the details body
 * faces the summary just the same, and dropping it would leave the details
 * bodyless exactly as dropping a bare empty <p> there would.
 */
function isDetailsSummaryPair(block: Element, adjacent: Element): boolean {
  const summary = block.tagName === 'SUMMARY'
    ? block
    : adjacent.tagName === 'SUMMARY' ? adjacent : null;
  if (!summary) return false;
  const details = summary.parentElement;
  if (!details || details.tagName !== 'DETAILS') return false;
  return details.contains(summary === block ? adjacent : block);
}

function removeEmptyPre(
  pre: HTMLElement,
  selection: Selection,
  direction: DeleteDirection,
): boolean {
  const adjacent = significantSiblingInDirection(pre, direction);
  if (
    adjacent instanceof HTMLElement &&
    !isDetailsSummaryPair(pre, adjacent) &&
    placeCaretAtStructuralEdge(selection, adjacent, direction === 'backward')
  ) {
    pre.remove();
    return true;
  }

  if (direction === 'forward') return false;

  // No block to merge into (or the only one is the summary this pre is the
  // body of): degrade the empty code block to an empty paragraph in place
  // rather than leaving a details without a body.
  const paragraph = document.createElement('p');
  paragraph.appendChild(document.createElement('br'));
  pre.replaceWith(paragraph);
  placeCaretAtStructuralEdge(selection, paragraph, false);
  return true;
}

/**
 * The element a caret should land in for a structural block: a <pre> hands over
 * to its <code>, and a <details> to its summary when the caret would otherwise
 * go into a body the reader cannot see — a collapsed details renders only its
 * summary, its body living in the UA shadow tree.
 *
 * Applied repeatedly, because the body block it hands over to may itself be a
 * <pre> or a collapsed <details>. Resolving only one level would drop the caret
 * into a nested hidden body and leave the user typing into nothing visible.
 * Each step descends one level, so the walk terminates.
 *
 * The descent stops at the first target that is neither, so a collapsed
 * <details> BEHIND an ordinary container (a <div>, a list, a quote) is out of
 * its reach — {@link isCollapsedDetailsBody}, applied when the caret is finally
 * placed, is what covers that however deep the wrapper chain is.
 *
 * `fallback` carries the nearest summary for {@link placeCaretAtStructuralEdge}
 * to use when the resolved target turns out to hold nowhere to put a caret.
 */
function structuralCaretTarget(
  structuralBlock: HTMLElement,
  atEnd: boolean,
): { target: HTMLElement; fallback: HTMLElement | null } {
  let target = structuralBlock;
  let fallback: HTMLElement | null = null;
  for (;;) {
    if (target.tagName === 'PRE') {
      const code = Array.from(target.children).find((child) => child.tagName === 'CODE');
      if (!(code instanceof HTMLElement)) return { target, fallback };
      target = code;
      continue;
    }
    if (target.tagName !== 'DETAILS') return { target, fallback };

    const summary = Array.from(target.children).find(
      (child): child is HTMLElement => child.tagName === 'SUMMARY',
    ) ?? null;
    if (summary) fallback = summary;

    const body = atEnd && target.hasAttribute('open')
      ? lastBodyNode(target, summary)
      : null;
    // A body ending in bare text has no element to descend into, and this
    // details is open — so its own end IS the spot, and the text walk in
    // {@link placeCaretAtStructuralEdge} finds that run from here. Handing over
    // to the summary instead would send the caret BACKWARDS past body text the
    // reader can see, and the next typed character into the title.
    if (body && !(body instanceof HTMLElement)) return { target, fallback };

    const next = body ?? summary;
    if (!next) return { target, fallback };
    target = next;
  }
}

/**
 * The last node of an open <details> body, formatting noise and the summary
 * excluded — or null when the details holds no body at all.
 *
 * Read from `childNodes` rather than `children` on purpose: a details body may
 * be bare text (renderer.ts installs body content verbatim, so a .html file
 * from disk carries that shape straight into the view), and an element-only
 * lookup cannot see it. Treating "no element body" as "no body" is what sent
 * the caret back into the summary.
 */
function lastBodyNode(details: HTMLElement, summary: HTMLElement | null): Node | null {
  const last = significantNodeFrom(details.lastChild, 'backward');
  return last && last !== summary ? last : null;
}

function placeCaretAtStructuralEdge(
  selection: Selection,
  structuralBlock: HTMLElement,
  atEnd: boolean,
): boolean {
  const { target, fallback } = structuralCaretTarget(structuralBlock, atEnd);

  const caret = document.createRange();
  const text = deepestEditableText(target, atEnd, isCollapsedDetailsBody);
  if (text) {
    caret.setStart(text, atEnd ? text.length : 0);
    caret.collapse(true);
  } else {
    const host = emptyEditableHost(target, atEnd) ?? fallback;
    if (host) {
      caret.selectNodeContents(host);
      caret.collapse(!atEnd);
    } else {
      return false;
    }
  }
  selection.removeAllRanges();
  selection.addRange(caret);
  return true;
}

/**
 * The empty block a caret may land in, when the structural target holds no text
 * at all. A `contenteditable="false"` subtree is no such place — the caret can
 * be put there but the user cannot type — and neither is a collapsed <details>
 * body, so those are skipped and the caller falls back to the summary.
 * {@link deepestEditableText} applies both rules to the text case.
 *
 * `node` itself is only tested for the lock: it is the structural target the
 * caller resolved, which {@link structuralCaretTarget} never takes into a
 * collapsed body.
 */
function emptyEditableHost(node: HTMLElement, atEnd: boolean): HTMLElement | null {
  const descendants = Array.from(
    node.querySelectorAll<HTMLElement>(NESTED_EDITABLE_HOST_SELECTOR),
  ).filter((el) => isUsableCaretHost(el, node));
  if (descendants.length > 0) return atEnd ? descendants.at(-1)! : descendants[0];
  if (!EDITABLE_HOST_TAGS.has(node.tagName)) return null;
  return isContentEditableFalse(node) ? null : node;
}

/**
 * Whether a caret may be placed in `el`: neither it nor an ancestor is locked
 * or a collapsed <details> body. The walk is bounded by `stopAt` because that is
 * the subtree {@link emptyEditableHost} is choosing within; anything outside it
 * was already accounted for by the caller. `querySelectorAll` returns a flat
 * list, so the ancestor walk is what {@link isCollapsedDetailsBody}'s one-level
 * test needs here — the text walk gets the same coverage from recursing.
 */
function isUsableCaretHost(el: HTMLElement, stopAt: HTMLElement): boolean {
  let current: HTMLElement | null = el;
  while (current) {
    if (isContentEditableFalse(current) || isCollapsedDetailsBody(current)) return false;
    if (current === stopAt) return true;
    current = current.parentElement;
  }
  return true;
}

/**
 * Whether `el` is the body of a collapsed <details> — content the reader cannot
 * see, because such a details renders only its summary and keeps the rest in the
 * UA shadow tree. A caret there leaves the user typing into nothing.
 *
 * Stated as a one-level test on the element's own parent so it can be handed to
 * {@link deepestEditableText}, whose recursion applies it at every level on the
 * way down. That is what covers a collapsed details reached through an ordinary
 * container, which {@link structuralCaretTarget}'s descent stops short of.
 */
function isCollapsedDetailsBody(el: HTMLElement): boolean {
  const parent = el.parentElement;
  return (
    parent !== null &&
    parent.tagName === 'DETAILS' &&
    !parent.hasAttribute('open') &&
    el.tagName !== 'SUMMARY'
  );
}

function isProtectedStructuralElement(node: Node): boolean {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    PROTECTED_STRUCTURAL_TAGS.has((node as Element).tagName)
  );
}
