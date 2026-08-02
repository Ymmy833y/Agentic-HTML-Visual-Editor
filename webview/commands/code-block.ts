// Structural helpers for code-block editing. These functions inspect a
// collapsed caret without reading editor state or mutating the live DOM.

import type { DeleteDirection } from '../shared/constants';

// Syntax highlighting and imported HTML may wrap code in inline elements.
// Unknown elements (especially comment metadata) are protected as content so
// an Enter handler can never remove them as if they were an empty line. Every
// consumer below spells that guarantee differently — 'content' / true / null —
// but they all mean "not an ignorable wrapper, so do not touch it".
const TRANSPARENT_CODE_TAGS = new Set([
  'CODE', 'SPAN', 'STRONG', 'EM', 'S', 'A', 'B', 'I',
]);

export interface CodeLineBreakBoundary {
  container: Node;
  offset: number;
}

interface CodeFragmentSummary {
  hasContent: boolean;
  lineBreaks: number;
}

type BackwardScanResult = CodeLineBreakBoundary | 'content' | null;

/**
 * A preformatted block cannot use the ordinary block-edge test because spaces,
 * newlines, and <br> nodes are editable code content. Ignore only empty inline
 * wrapper shells introduced by syntax highlighting.
 */
export function isCaretAtPreEdge(
  range: Range,
  pre: HTMLElement,
  direction: DeleteDirection,
): boolean {
  const edge = document.createRange();
  if (direction === 'backward') {
    edge.setStart(pre, 0);
    edge.setEnd(range.startContainer, range.startOffset);
  } else {
    edge.setStart(range.endContainer, range.endOffset);
    edge.setEnd(pre, pre.childNodes.length);
  }
  return !Array.from(edge.cloneContents().childNodes).some(preNodeHasContent);
}

function preNodeHasContent(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data.length > 0;
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  if (element.tagName === 'BR') return true;
  if (!TRANSPARENT_CODE_TAGS.has(element.tagName)) return true;
  return Array.from(element.childNodes).some(preNodeHasContent);
}

function codePlaceholderBreakCount(node: Node): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node as Text).data.length === 0 ? 0 : null;
  }
  if (node.nodeType === Node.COMMENT_NODE) return null;
  if (node.nodeType !== Node.ELEMENT_NODE) return 0;
  const element = node as Element;
  if (element.tagName === 'BR') return 1;
  if (!TRANSPARENT_CODE_TAGS.has(element.tagName)) return null;

  let breaks = 0;
  for (const child of Array.from(element.childNodes)) {
    const childBreaks = codePlaceholderBreakCount(child);
    if (childBreaks === null) return null;
    breaks += childBreaks;
  }
  return breaks;
}

export function isEmptyPrePlaceholder(pre: HTMLElement): boolean {
  let breaks = 0;
  for (const child of Array.from(pre.childNodes)) {
    const childBreaks = codePlaceholderBreakCount(child);
    if (childBreaks === null) return false;
    breaks += childBreaks;
  }
  return breaks <= 1;
}

/**
 * Return the <br> that starts the trailing empty code line at the caret.
 *
 * Chromium keeps one final <br> after the caret as a placeholder, so the tail
 * may contain at most one logical line break. Two or more breaks mean the
 * caret is on an earlier blank line and exiting would discard later lines.
 * A literal newline before the caret is source content, not proof that the
 * user already pressed Enter once; this keeps imported `<pre><code>…\n` blocks
 * on the same two-Enter contract. Whitespace on the empty line is accepted and
 * is intentionally discarded together with that line when the caller exits.
 * This also applies to whitespace-only lines already present after a <br>;
 * their source cannot be distinguished from freshly typed whitespace in DOM.
 * For the same reason, an existing trailing <br> can serve as the empty-line
 * marker and make the next Enter exit immediately.
 */
export function findTrailingEmptyCodeLine(
  range: Range,
  pre: HTMLElement,
): CodeLineBreakBoundary | null {
  if (!range.collapsed || !pre.contains(range.startContainer)) return null;

  const boundary = findBreakBeforeCaret(range, pre);
  if (!boundary) return null;

  const after = document.createRange();
  after.setStart(range.startContainer, range.startOffset);
  after.setEnd(pre, pre.childNodes.length);
  const suffix = summarizeCodeFragment(after.cloneContents());
  if (suffix.hasContent || suffix.lineBreaks > 1) return null;

  // A sole <br> is only an empty-block placeholder. After the first Enter,
  // Chromium adds a second placeholder after the caret, which distinguishes
  // that state without cloning and walking the entire prefix.
  if (!hasAnythingBefore(boundary, pre) && suffix.lineBreaks === 0) return null;

  return boundary;
}

function hasAnythingBefore(boundary: CodeLineBreakBoundary, pre: HTMLElement): boolean {
  let container = boundary.container;
  let offset = boundary.offset;
  while (true) {
    for (let index = offset - 1; index >= 0; index--) {
      if (nodeHasAnything(container.childNodes[index])) return true;
    }
    if (container === pre) return false;
    const parent = container.parentNode;
    if (!parent) return false;
    offset = Array.prototype.indexOf.call(parent.childNodes, container);
    container = parent;
  }
}

function nodeHasAnything(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    const data = (node as Text).data;
    return data.includes('\n') || /\S/.test(data);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  if (element.tagName === 'BR') return true;
  if (!TRANSPARENT_CODE_TAGS.has(element.tagName)) return true;
  for (let index = element.childNodes.length - 1; index >= 0; index--) {
    if (nodeHasAnything(element.childNodes[index])) return true;
  }
  return false;
}

function findBreakBeforeCaret(range: Range, pre: HTMLElement): CodeLineBreakBoundary | null {
  let container: Node = range.startContainer;
  let offset = range.startOffset;

  if (container.nodeType === Node.TEXT_NODE) {
    const found = scanTextBackward(container as Text, offset);
    if (found === 'content') return null;
  } else {
    const found = scanChildrenBackward(container, offset);
    if (found === 'content') return null;
    if (found) return found;
  }

  while (container !== pre) {
    const parent = container.parentNode;
    if (!parent) return null;
    offset = Array.prototype.indexOf.call(parent.childNodes, container);
    container = parent;
    const found = scanChildrenBackward(container, offset);
    if (found === 'content') return null;
    if (found) return found;
  }
  return null;
}

function scanChildrenBackward(container: Node, offset: number): BackwardScanResult {
  for (let index = offset - 1; index >= 0; index--) {
    const found = scanNodeBackward(container.childNodes[index]);
    if (found) return found;
  }
  return null;
}

function scanNodeBackward(node: Node): BackwardScanResult {
  if (node.nodeType === Node.TEXT_NODE) {
    return scanTextBackward(node as Text, (node as Text).length);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const element = node as Element;
  if (element.tagName === 'BR') {
    const parent = element.parentNode;
    if (!parent) return null;
    return {
      container: parent,
      offset: Array.prototype.indexOf.call(parent.childNodes, element),
    };
  }
  if (!TRANSPARENT_CODE_TAGS.has(element.tagName)) return 'content';
  return scanChildrenBackward(element, element.childNodes.length);
}

function scanTextBackward(text: Text, offset: number): 'content' | null {
  for (let index = offset - 1; index >= 0; index--) {
    const char = text.data[index];
    // A source newline must receive its first real Enter before it can exit.
    if (char === '\n' || !/\s/.test(char)) return 'content';
  }
  return null;
}

function summarizeCodeFragment(fragment: DocumentFragment): CodeFragmentSummary {
  let hasContent = false;
  let lineBreaks = 0;
  const walker = document.createTreeWalker(
    fragment,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  );
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const char of (node as Text).data) {
        if (char === '\n') lineBreaks++;
        else if (!/\s/.test(char)) hasContent = true;
      }
    } else {
      const element = node as Element;
      if (element.tagName === 'BR') lineBreaks++;
      else if (!TRANSPARENT_CODE_TAGS.has(element.tagName)) hasContent = true;
    }
    node = walker.nextNode();
  }
  return { hasContent, lineBreaks };
}
