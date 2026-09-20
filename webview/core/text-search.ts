// Search over the editor's rendered content, plus comment thread ids.
//
// Only the visible text is searched: tag names, attributes (e.g. an <a href>
// URL), and structure are never matched — searching the raw HTML is the job of
// VSCode's standard text editor. Text inside <comment-body>/<comment-reply>
// (shown in the comment popup, not inline) is skipped.
//
// The one attribute that is searched is a <comment> element's `id`: a thread id
// is how a human and an agent refer to the same annotation across the document
// and the chat, so it has to be reachable from the find widget even though it
// is never painted. See findCommentIdMatches for what that hit looks like.
//
// Matches are returned as live Range objects so the caller can paint them with
// the CSS Custom Highlight API without mutating the DOM. A match may span
// multiple text nodes (e.g. across an inline <strong>): the text is flattened
// into one string with an index→(node, offset) map, and match offsets are
// resolved back into Range boundaries.

import { isInCommentMeta } from '../shared/dom-utils';
import { isInMermaidSource } from '../features/mermaid/mermaid-dom';
import {
  commentsInDocumentOrder,
  firstNonEmptyTargetText,
  lastNonEmptyTargetText,
} from '../features/comment/comment-dom';

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface SearchMatch {
  /** The text to highlight and scroll to. */
  range: Range;
  /**
   * The comment this hit came from, when the query matched its thread id rather
   * than any visible text. The caller opens the comment popup for it: the id
   * itself is invisible, so the popup is what "found it" looks like.
   */
  comment?: Element;
}

interface Segment {
  node: Text;
  /** Inclusive start index of this node's text in the flattened string. */
  start: number;
  /** Exclusive end index. */
  end: number;
}

/**
 * Find every match of query in root's visible text and comment thread ids.
 * Returns matches in document order. An empty query returns no matches.
 */
export function findMatches(root: HTMLElement, query: string, opts: SearchOptions): SearchMatch[] {
  if (query === '') return [];
  return merge(findTextMatches(root, query, opts), findCommentIdMatches(root, query, opts));
}

function findTextMatches(root: HTMLElement, query: string, opts: SearchOptions): SearchMatch[] {
  const segments: Segment[] = [];
  let flat = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    if (!isInCommentMeta(node, root) && !isInMermaidSource(node, root)) {
      const data = node.data;
      if (data.length > 0) {
        segments.push({ node, start: flat.length, end: flat.length + data.length });
        flat += data;
      }
    }
    node = walker.nextNode() as Text | null;
  }
  if (flat === '') return [];

  const haystack = opts.caseSensitive ? flat : flat.toLowerCase();
  const needle = opts.caseSensitive ? query : query.toLowerCase();

  const matches: SearchMatch[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    const matchEnd = idx + needle.length;
    if (!opts.wholeWord || isWholeWord(flat, idx, matchEnd)) {
      const range = document.createRange();
      const [sNode, sOff] = locate(segments, idx);
      const [eNode, eOff] = locate(segments, matchEnd);
      range.setStart(sNode, sOff);
      range.setEnd(eNode, eOff);
      matches.push({ range });
    }
    // Advance past this match; guard against a zero-length needle.
    from = idx + Math.max(needle.length, 1);
  }
  return matches;
}

/**
 * One hit per comment whose thread id contains the query.
 *
 * A thread id is an opaque token, so it matches on a plain substring: the
 * whole-word option is deliberately ignored (it would reject a partial id like
 * "c-i27twz", which is exactly the kind of query this exists for), while the
 * case-sensitivity option still applies so the two toggles do not disagree.
 * Resolved threads match too — they stay on screen, only dimmed.
 */
function findCommentIdMatches(
  root: HTMLElement,
  query: string,
  opts: SearchOptions,
): SearchMatch[] {
  const needle = opts.caseSensitive ? query : query.toLowerCase();
  const matches: SearchMatch[] = [];
  for (const comment of commentsInDocumentOrder(root)) {
    const id = comment.getAttribute('id') ?? '';
    const haystack = opts.caseSensitive ? id : id.toLowerCase();
    // includes(), not a loop: a query occurring twice in one id is still one
    // thread, and one thread is one hit.
    if (haystack.includes(needle)) {
      matches.push({ range: annotatedRange(comment), comment });
    }
  }
  return matches;
}

/**
 * What an id hit highlights: the comment's annotated text — the content before
 * its <comment-body>, which is the part the reader sees. A comment whose
 * annotated text is empty has nothing to paint, so the range collapses to a
 * boundary before it; the hit still scrolls into view and still opens the popup.
 */
function annotatedRange(comment: Element): Range {
  const range = document.createRange();
  const first = firstNonEmptyTargetText(comment);
  const last = lastNonEmptyTargetText(comment);
  if (first && last) {
    range.setStart(first, 0);
    range.setEnd(last, last.data.length);
  } else {
    range.setStartBefore(comment);
    range.collapse(true);
  }
  return range;
}

/**
 * Interleave the two kinds of hit. Both lists are already in document order, so
 * this is a linear merge. When a text hit and an id hit cover exactly the same
 * range — the annotated text equals the query and that same string also occurs
 * in the id — they are one hit to the reader, and the id hit wins so the popup
 * still opens.
 */
function merge(text: SearchMatch[], ids: SearchMatch[]): SearchMatch[] {
  if (ids.length === 0) return text;
  const out: SearchMatch[] = [];
  let t = 0;
  let i = 0;
  while (t < text.length && i < ids.length) {
    const order = compareRanges(text[t].range, ids[i].range);
    if (order < 0) {
      out.push(text[t++]);
    } else {
      if (order === 0) t++;
      out.push(ids[i++]);
    }
  }
  while (t < text.length) out.push(text[t++]);
  while (i < ids.length) out.push(ids[i++]);
  return out;
}

// Document order, with the end point breaking a tie on the start point so that
// only genuinely identical ranges compare equal.
function compareRanges(a: Range, b: Range): number {
  const start = a.compareBoundaryPoints(Range.START_TO_START, b);
  return start !== 0 ? start : a.compareBoundaryPoints(Range.END_TO_END, b);
}

// A match is a whole word when the characters bordering it are not word
// characters (letters, digits, or underscore, including non-ASCII letters).
function isWholeWord(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : '';
  const after = end < text.length ? text[end] : '';
  return !isWordChar(before) && !isWordChar(after);
}

function isWordChar(ch: string): boolean {
  return ch !== '' && /[\p{L}\p{N}_]/u.test(ch);
}

// Resolve a flattened-string index to a (text node, offset) boundary. An index
// landing exactly on a node boundary resolves to the start of the next node,
// which is an equivalent Range boundary.
function locate(segments: Segment[], index: number): [Text, number] {
  for (const seg of segments) {
    if (index < seg.end) {
      return [seg.node, Math.max(0, index - seg.start)];
    }
  }
  // index === total length: end of the last segment.
  const last = segments[segments.length - 1];
  return [last.node, last.node.data.length];
}
