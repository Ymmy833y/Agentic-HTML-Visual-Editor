// Plain-text search over the editor's rendered content.
//
// Only the visible text is searched: tag names, attributes (e.g. an <a href>
// URL), and structure are never matched — searching the raw HTML is the job of
// VSCode's standard text editor. Text inside <comment-body>/<comment-reply>
// (shown in the comment popup, not inline) is skipped.
//
// Matches are returned as live Range objects so the caller can paint them with
// the CSS Custom Highlight API without mutating the DOM. A match may span
// multiple text nodes (e.g. across an inline <strong>): the text is flattened
// into one string with an index→(node, offset) map, and match offsets are
// resolved back into Range boundaries.

import { isInCommentMeta } from '../shared/dom-utils';
import { isInMermaidSource } from '../features/mermaid/mermaid-dom';

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

interface Segment {
  node: Text;
  /** Inclusive start index of this node's text in the flattened string. */
  start: number;
  /** Exclusive end index. */
  end: number;
}

/**
 * Find every match of query in root's visible text. Returns ranges in document
 * order. An empty (or whitespace-only) query returns no matches.
 */
export function findMatches(root: HTMLElement, query: string, opts: SearchOptions): Range[] {
  if (query === '') return [];

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

  const ranges: Range[] = [];
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
      ranges.push(range);
    }
    // Advance past this match; guard against a zero-length needle.
    from = idx + Math.max(needle.length, 1);
  }
  return ranges;
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
