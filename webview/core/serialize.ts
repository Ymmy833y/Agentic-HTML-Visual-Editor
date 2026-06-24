// Pretty-printer for the editor's HTML output.
//
// The contenteditable browser default inserts a placeholder `<br>` whenever
// the user creates an empty block (e.g. pressing Enter at the end of a
// paragraph). The placeholder is required to keep the empty block selectable
// in the live DOM, but it should not survive into the saved file — the file
// should contain `<p></p>` rather than `<p><br></p>`.
//
// To keep round-tripping stable, the serializer must NOT rewrite whitespace
// the user (or the previous save) put between blocks: re-formatting otherwise
// untouched lines drifts indent and breaks the selection-path restore that
// runs on save echo. So this module only:
//   1. Strips `<br>` (and empty inline wrappers) from blocks that look empty.
//   2. Inserts a single whitespace text node where two block siblings sit
//      directly adjacent (no whitespace between them at all). The inserted
//      whitespace copies an existing inter-block whitespace pattern in the
//      same parent so indentation is preserved.
//
// `<pre>` and `<table>` subtrees stay opaque.

export const EMPTYABLE_BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'DIV', 'LI', 'SUMMARY',
]);

const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'DIV', 'LI',
  'UL', 'OL', 'HR', 'FIGURE', 'FIGCAPTION',
  'TABLE', 'DETAILS', 'SUMMARY',
]);

const OPAQUE_TAGS = new Set([
  'PRE', 'CODE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR',
]);

// Marks the empty block that currently holds the caret. Empty inline-format
// wrappers (e.g. `<strong></strong>`) are kept in the serialized output only
// for this block, so the line being edited keeps its formatting in the saved
// file while abandoned empty wrappers elsewhere are still pruned to `<p></p>`.
const ACTIVE_ATTR = 'data-ahve-active';

export function formatForSerialize(root: HTMLElement): string {
  const active = collapsedActiveEmptyBlock(root);
  if (active) active.setAttribute(ACTIVE_ATTR, '');
  const clone = root.cloneNode(true) as HTMLElement;
  // The marker lives on the live DOM only for the duration of the clone.
  if (active) active.removeAttribute(ACTIVE_ATTR);
  pruneEmptyBlocks(clone);
  fillMissingBlockGaps(clone);
  return clone.innerHTML;
}

function pruneEmptyBlocks(scope: Element): void {
  const selector = Array.from(EMPTYABLE_BLOCK_TAGS).map((t) => t.toLowerCase()).join(',');
  for (const block of Array.from(scope.querySelectorAll(selector))) {
    if (hasOpaqueAncestor(block)) continue;
    if (!isBlockEffectivelyEmpty(block)) {
      block.removeAttribute(ACTIVE_ATTR);
      continue;
    }
    if (block.hasAttribute(ACTIVE_ATTR)) {
      block.removeAttribute(ACTIVE_ATTR);
      softPruneEmptyBlock(block);
    } else {
      block.replaceChildren();
    }
  }
}

// Strip `<br>` placeholders and empty text nodes but keep inline-format
// wrappers, so `<p><strong><br></strong></p>` becomes `<p><strong></strong></p>`
// (and a plain `<p><br></p>` becomes `<p></p>`).
function softPruneEmptyBlock(node: Element): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child as Text).data === '') child.remove();
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      if (el.tagName === 'BR') {
        el.remove();
      } else {
        softPruneEmptyBlock(el);
      }
    }
  }
}

// The empty, caret-holding block whose formatting should survive serialization:
// a collapsed selection inside the live root whose nearest emptyable-block
// ancestor is effectively empty. Returns null otherwise (e.g. tests with no
// selection), so the default pruning applies.
function collapsedActiveEmptyBlock(root: HTMLElement): Element | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const anchor = sel.anchorNode;
  if (!anchor || !root.contains(anchor)) return null;

  let cur: Node | null = anchor;
  while (cur && cur !== root) {
    if (cur.nodeType === Node.ELEMENT_NODE && EMPTYABLE_BLOCK_TAGS.has((cur as Element).tagName)) {
      const el = cur as Element;
      if (hasOpaqueAncestor(el)) return null;
      return isBlockEffectivelyEmpty(el) ? el : null;
    }
    cur = cur.parentNode;
  }
  return null;
}

function hasOpaqueAncestor(node: Node): boolean {
  let cur: Node | null = node.parentNode;
  while (cur) {
    if (cur.nodeType === Node.ELEMENT_NODE && OPAQUE_TAGS.has((cur as Element).tagName)) {
      return true;
    }
    cur = cur.parentNode;
  }
  return false;
}

export function isBlockEffectivelyEmpty(block: Element): boolean {
  return Array.from(block.childNodes).every(isPlaceholderOrEmptyWrapper);
}

// Void/replaced elements that are real content even with no children, so a
// block holding only one of these is NOT empty (e.g. `<p><img></p>` must keep
// its image). Without this, a childless non-block element would be mistaken
// for an empty inline wrapper and pruned away.
const VOID_CONTENT_TAGS = new Set(['IMG']);

// A child counts as "placeholder/empty wrapper" if it is:
//   - an empty text node,
//   - a <br>, or
//   - an inline element whose own children are all of the above.
// Block elements and void content elements (e.g. <img>) never count, so
// nested blocks and images are preserved.
function isPlaceholderOrEmptyWrapper(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data === '';
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  if (el.tagName === 'BR') return true;
  // A <comment> is a deliberate annotation keyed by id; it must never be
  // mistaken for an empty inline wrapper and pruned, even when its target text
  // and body are momentarily empty (e.g. a just-added comment whose body has
  // not been typed yet). Otherwise a debounced save firing during that window
  // would drop the comment, and the save echo's remount would make it permanent.
  if (el.tagName === 'COMMENT') return false;
  if (BLOCK_TAGS.has(el.tagName) || VOID_CONTENT_TAGS.has(el.tagName)) return false;
  return Array.from(el.childNodes).every(isPlaceholderOrEmptyWrapper);
}

function fillMissingBlockGaps(parent: Element): void {
  if (OPAQUE_TAGS.has(parent.tagName)) return;
  for (const child of Array.from(parent.children)) {
    fillMissingBlockGaps(child);
  }

  const inferred = inferGapWhitespace(parent);

  let cur: Node | null = parent.firstChild;
  while (cur) {
    const next = cur.nextSibling;
    if (next && isBlockElement(cur) && isBlockElement(next)) {
      const gap = parent.ownerDocument.createTextNode(inferred);
      parent.insertBefore(gap, next);
      cur = next;
    } else {
      cur = next;
    }
  }
}

function isBlockElement(node: Node | null): boolean {
  if (!node) return false;
  return node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((node as Element).tagName);
}

// Pick a whitespace string to insert between two directly-adjacent block
// siblings. Prefer copying an existing whitespace text node that sits next
// to a block within the same parent — that text was either an existing
// inter-block gap or a leading/trailing indent, and either way it tells us
// the user's preferred indentation. Fall back to a bare newline.
function inferGapWhitespace(parent: Element): string {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType !== Node.TEXT_NODE) continue;
    const text = (child as Text).data;
    if (text.length === 0 || !/^\s+$/.test(text) || !text.includes('\n')) continue;
    const prev = child.previousSibling;
    const next = child.nextSibling;
    if (isBlockElement(prev) || isBlockElement(next)) return text;
  }
  return '\n';
}
