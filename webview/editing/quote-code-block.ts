import { BLOCK_SEPARATOR_TEXT, isHtmlWhitespaceOnly, wrapInlineRuns } from './block';
import { removeTrailingBreak, replaceBreaksWithNewlines } from './block-convert';
import { BLOCK_KIND, isConvertibleBlock, readBlockKind } from './block-format';
import { countCharacters, findCountedPosition } from './character-count';
import type { CountRule, SelectionPoint } from './character-count';

// The body and replies of a comment annotation are left out, so a restored caret never lands inside an annotation the
// user cannot type into. A bare blockquote and its code block hold no blocks, so all the other text is content.
const QUOTE_LINE_COUNT: CountRule = { skipsWhitespaceBetweenBlocks: false, skipsCommentText: true };

/**
 * A line of a bare blockquote.
 *
 * Lines are split only at the `br` elements directly inside the blockquote. A `br` inside a format element or a
 * comment annotation does not split a line, because splitting there would split or duplicate that element.
 */
export interface QuoteLine {
  /** The children on the line, in document order. The `br` that separates the line from the next is not included. */
  readonly nodes: readonly ChildNode[];
  /** The `br` directly inside the blockquote that separates the line from the next, or `undefined` on the last line. */
  readonly lineBreak: Element | undefined;
}

/**
 * Where one end of the selection lies against a bare blockquote.
 *
 * Inside the blockquote, the end is held as the number of characters counted from the start of the first line the
 * selection covers, with a `br` counted as one character. Converting to a code block exchanges each `br` for one
 * newline character, so the same count points at the same character afterwards.
 */
export type QuoteLineEnd =
  | { readonly place: 'before' | 'after' }
  | { readonly place: 'inside'; readonly count: number };

/** How a bare blockquote splits into lines and which of them the selection covers, decided before any rewrite. */
export interface QuoteLinePlan {
  /** The bare blockquote. */
  readonly quote: Element;
  /** The lines in document order. There is always at least one. */
  readonly lines: readonly QuoteLine[];
  /** The `br` at the end of the content. It only lets the line before it show, so it opens no line of its own. */
  readonly trailingBreak: Element | undefined;
  /** The index of the first line the selection covers. */
  readonly first: number;
  /** The index of the last line the selection covers. */
  readonly last: number;
  /** Where the start of the selection lies. */
  readonly start: QuoteLineEnd;
  /** Where the end of the selection lies. */
  readonly end: QuoteLineEnd;
}

/** Where the ends of the selection that were inside the blockquote go after the conversion. */
export interface QuoteLinePoints {
  /** Where the start goes, or `undefined` when it was outside the blockquote. */
  readonly start: SelectionPoint | undefined;
  /** Where the end goes, or `undefined` when it was outside the blockquote. */
  readonly end: SelectionPoint | undefined;
}

/**
 * Determines whether an element is a bare blockquote: a blockquote whose children are all inline.
 *
 * @param element The element to inspect.
 * @returns `true` for a bare blockquote.
 */
export function isBareBlockquote(element: Element): boolean {
  return readBlockKind(element) === BLOCK_KIND.quote && isConvertibleBlock(element);
}

/**
 * Splits a bare blockquote into lines and decides which of them the selection covers. Changes neither the tree nor
 * the selection.
 *
 * An end before the blockquote covers from the first line, and an end after it covers up to the last line. An end
 * right before a `br` that separates lines belongs to the line before it, and one right after it to the line after.
 *
 * @param quote The bare blockquote.
 * @param range The selection range. It must intersect the blockquote.
 * @returns The plan.
 */
export function planQuoteLines(quote: Element, range: Range): QuoteLinePlan {
  const { lines, trailingBreak } = splitLines(quote);
  const startPlace = comparePlace(quote, range.startContainer, range.startOffset);
  const endPlace = comparePlace(quote, range.endContainer, range.endOffset);
  const first = startPlace === 'inside'
    ? findLineIndex(quote, lines, range.startContainer, range.startOffset)
    : 0;
  const last = endPlace === 'inside'
    ? findLineIndex(quote, lines, range.endContainer, range.endOffset)
    : lines.length - 1;

  const lineStart = readLineStart(quote, lines, first);
  const readEnd = (place: EndPlace, container: Node, offset: number): QuoteLineEnd => {
    if (place !== 'inside') {
      return { place };
    }
    const count = countCharacters(quote, lineStart, { node: container, offset }, QUOTE_LINE_COUNT, trailingBreak);
    return { place, count };
  };
  return {
    quote,
    lines,
    trailingBreak,
    first,
    last,
    start: readEnd(startPlace, range.startContainer, range.startOffset),
    end: readEnd(endPlace, range.endContainer, range.endOffset),
  };
}

/**
 * Turns the lines the selection covers into a single code block inside the blockquote, and the lines before and
 * after them into a paragraph each.
 *
 * The blockquote stays in place with its attributes, so an alert blockquote keeps its alert. The children move by
 * reference, so format elements and comment annotations are neither split nor duplicated. Only the `br` elements that
 * separated the covered lines from the rest, and whitespace at the edges of the new paragraphs, leave the tree.
 *
 * @param plan The plan made by `planQuoteLines` for the same tree.
 * @returns Where the ends of the selection that were inside the blockquote go.
 */
export function convertQuoteLines(plan: QuoteLinePlan): QuoteLinePoints {
  const { quote, lines, trailingBreak, first, last } = plan;
  const document = quote.ownerDocument;

  const before = collectLines(lines, 0, first);
  const covered = collectLines(lines, first, last + 1);
  const after = collectLines(lines, last + 1, lines.length);
  const leadingBreak = first > 0 ? lines[first - 1].lineBreak : undefined;
  if (leadingBreak !== undefined) {
    if (isBlankLine(lines[first - 1])) {
      // A br at the end of a paragraph opens no line. Keeping this one lets the empty line before the code block
      // still show.
      before.push(leadingBreak);
    } else {
      leadingBreak.remove();
    }
  }
  lines[last].lineBreak?.remove();
  if (trailingBreak !== undefined) {
    (last === lines.length - 1 ? covered : after).push(trailingBreak);
  }

  const code = document.createElement('code');
  code.append(...covered);
  // The same steps as converting a paragraph: the trailing br is not a visible line break, and the others become
  // newline characters.
  removeTrailingBreak(code);
  replaceBreaksWithNewlines(code);
  const pre = document.createElement('pre');
  pre.append(code);

  const blocks: ChildNode[] = [
    ...(before.length > 0 ? wrapInlineRuns(before, document) : []),
    pre,
    ...(after.length > 0 ? wrapInlineRuns(after, document) : []),
  ];
  // What is left in the blockquote is only the whitespace and HTML comments after the trailing br, so the blocks go
  // before it.
  quote.prepend(...joinBlocks(blocks, document));

  const start = plan.start.place === 'inside'
    ? findCodePosition(pre, code, plan.start.count, 'start')
    : undefined;
  if (plan.end.place !== 'inside') {
    return { start, end: undefined };
  }
  // A caret stays a caret. Resolving the same count from the other side could split it across a seam.
  const end = plan.start.place === 'inside' && plan.start.count === plan.end.count
    ? start
    : findCodePosition(pre, code, plan.end.count, 'end');
  return { start, end };
}

/**
 * Turns each line the selection covers into a paragraph of its own inside the blockquote, and the lines before and
 * after them into a paragraph each.
 *
 * A block or list item can then be put next to the covered line, or made of it, inside the blockquote, by the same
 * rules as outside one. The lines before and after keep the `br` elements between them, so lines that are not acted
 * on look the same. The blockquote stays in place with its attributes, and the children move by reference.
 *
 * @param plan The plan made by `planQuoteLines` for the same tree.
 * @returns Where the ends of the selection that were inside the blockquote go.
 */
export function splitQuoteLines(plan: QuoteLinePlan): QuoteLinePoints {
  const { quote, lines, trailingBreak, first, last } = plan;
  const document = quote.ownerDocument;
  // Measured before the rewrite: the br elements between the covered lines leave the tree, and each one was counted
  // as a character.
  const lengths: number[] = [];
  for (let index = first; index <= last; index += 1) {
    lengths.push(countLine(quote, lines, index, trailingBreak));
  }

  const before = collectLines(lines, 0, first);
  const after = collectLines(lines, last + 1, lines.length);
  const leadingBreak = first > 0 ? lines[first - 1].lineBreak : undefined;
  if (leadingBreak !== undefined) {
    if (isBlankLine(lines[first - 1])) {
      // A br at the end of a paragraph opens no line. Keeping this one lets the empty line before still show.
      before.push(leadingBreak);
    } else {
      leadingBreak.remove();
    }
  }

  const paragraphs: Element[] = [];
  for (let index = first; index <= last; index += 1) {
    const line = lines[index];
    line.lineBreak?.remove();
    const paragraph = document.createElement('p');
    // Appended as they are, without trimming the whitespace at the edges, so the counts taken in the plan point at
    // the same characters in the paragraph.
    paragraph.append(...line.nodes);
    if (index === lines.length - 1 && trailingBreak !== undefined) {
      paragraph.append(trailingBreak);
    } else if (isBlankLine(line)) {
      // An empty line has no height as a paragraph of its own.
      paragraph.append(document.createElement('br'));
    }
    paragraphs.push(paragraph);
  }
  if (trailingBreak !== undefined && last < lines.length - 1) {
    after.push(trailingBreak);
  }

  const blocks: ChildNode[] = [
    ...(before.length > 0 ? wrapInlineRuns(before, document) : []),
    ...paragraphs,
    ...(after.length > 0 ? wrapInlineRuns(after, document) : []),
  ];
  // What is left in the blockquote is only the whitespace and HTML comments after the trailing br, so the blocks go
  // before it.
  quote.prepend(...joinBlocks(blocks, document));

  const start = plan.start.place === 'inside'
    ? findSplitPosition(paragraphs, lengths, plan.start.count, 'start')
    : undefined;
  if (plan.end.place !== 'inside') {
    return { start, end: undefined };
  }
  // A caret stays a caret. Resolving the same count from the other side could split it across a seam.
  const end = plan.start.place === 'inside' && plan.start.count === plan.end.count
    ? start
    : findSplitPosition(paragraphs, lengths, plan.end.count, 'end');
  return { start, end };
}

/**
 * Returns a new range over the content of the line holding the start of the range. Changes neither the tree nor the
 * selection.
 *
 * The `br` elements that separate lines and the trailing `br` are left out. On an empty line the range is collapsed
 * at the position of that line.
 *
 * @param quote The bare blockquote.
 * @param range A range that starts inside the blockquote.
 * @returns The range over the line.
 */
export function selectCaretLine(quote: Element, range: Range): Range {
  const { lines } = splitLines(quote);
  const index = findLineIndex(quote, lines, range.startContainer, range.startOffset);
  const start = readLineStart(quote, lines, index);
  const selected = quote.ownerDocument.createRange();
  selected.setStart(start.node, start.offset);
  const last = lines[index].nodes.at(-1);
  if (last === undefined) {
    selected.collapse(true);
  } else {
    selected.setEndAfter(last);
  }
  return selected;
}

/**
 * Keeps the last line of a bare blockquote showing after its content was removed.
 *
 * A `br` at the end of the content only lets the line before it show. Once the last line loses its content, the `br`
 * before it ends the content and the line is gone, so one more `br` goes at the caret, which stays before it.
 *
 * @param quote The bare blockquote.
 * @param range A collapsed range at the caret, where the content of a line was removed.
 */
export function keepEmptyLastLine(quote: Element, range: Range): void {
  const trailingBreak = findTrailingBreak([...quote.childNodes]);
  if (trailingBreak === undefined) {
    return;
  }
  const afterBreak = quote.ownerDocument.createRange();
  afterBreak.setStartAfter(trailingBreak);
  if (range.compareBoundaryPoints(Range.START_TO_START, afterBreak) < 0) {
    // The caret is on a line before the trailing br, which still shows that line.
    return;
  }
  const lineBreak = quote.ownerDocument.createElement('br');
  range.insertNode(lineBreak);
  range.setEndBefore(lineBreak);
}

/** Where a boundary point lies against the contents of a blockquote. */
type EndPlace = 'before' | 'inside' | 'after';

/**
 * Splits the children of a bare blockquote into lines.
 *
 * @param quote The bare blockquote.
 * @returns The lines, and the trailing `br` when the content ends with one.
 */
function splitLines(quote: Element): { lines: QuoteLine[]; trailingBreak: Element | undefined } {
  const children = [...quote.childNodes];
  const trailingBreak = findTrailingBreak(children);
  const lines: QuoteLine[] = [];
  let nodes: ChildNode[] = [];
  for (const child of children) {
    if (child === trailingBreak) {
      // Only whitespace and HTML comments follow the trailing br, and they belong to no line.
      break;
    }
    if (isBreak(child)) {
      lines.push({ nodes, lineBreak: child });
      nodes = [];
      continue;
    }
    nodes.push(child);
  }
  lines.push({ nodes, lineBreak: undefined });
  return { lines, trailingBreak };
}

/**
 * Returns the `br` at the end of the content: the last child that shows, when it is a `br`.
 *
 * @param children The children of the blockquote.
 * @returns The trailing `br`, or `undefined` when the content does not end with one.
 */
function findTrailingBreak(children: readonly ChildNode[]): Element | undefined {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child instanceof Element) {
      return isBreak(child) ? child : undefined;
    }
    if (child instanceof Text && !isHtmlWhitespaceOnly(child.data)) {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Returns where a boundary point lies against the contents of a blockquote.
 *
 * @param quote The blockquote.
 * @param container The container of the boundary point.
 * @param offset The offset of the boundary point.
 * @returns Whether the point is before, inside or after the contents.
 */
function comparePlace(quote: Element, container: Node, offset: number): EndPlace {
  const bounds = quote.ownerDocument.createRange();
  bounds.selectNodeContents(quote);
  // comparePoint returns -1 before the range, 0 inside it, and 1 after it.
  const position = bounds.comparePoint(container, offset);
  if (position < 0) {
    return 'before';
  }
  return position > 0 ? 'after' : 'inside';
}

/**
 * Returns the index of the line holding a boundary point inside the blockquote.
 *
 * @param quote The bare blockquote.
 * @param lines The lines of the blockquote.
 * @param container The container of the boundary point.
 * @param offset The offset of the boundary point.
 * @returns The index of the line.
 */
function findLineIndex(quote: Element, lines: readonly QuoteLine[], container: Node, offset: number): number {
  const children = [...quote.childNodes];
  let end = offset;
  if (container !== quote) {
    // Inside a child, the line is decided by the child holding the point.
    let holder: Node = container;
    while (holder.parentNode !== quote && holder.parentNode !== null) {
      holder = holder.parentNode;
    }
    const child = holder;
    end = children.findIndex((node) => node === child);
  }

  const lineBreaks = new Set<Node | undefined>(lines.map((line) => line.lineBreak));
  let index = 0;
  for (const child of children.slice(0, end)) {
    if (lineBreaks.has(child)) {
      index += 1;
    }
  }
  return Math.min(index, lines.length - 1);
}

/**
 * Returns the position where a line starts.
 *
 * @param quote The bare blockquote.
 * @param lines The lines of the blockquote.
 * @param index The index of the line.
 * @returns The position before the first child of the line, or right after the `br` before an empty line.
 */
function readLineStart(quote: Element, lines: readonly QuoteLine[], index: number): SelectionPoint {
  const children = [...quote.childNodes];
  const first = lines[index].nodes.at(0);
  if (first !== undefined) {
    return { node: quote, offset: children.indexOf(first) };
  }
  const previous = index > 0 ? lines[index - 1].lineBreak : undefined;
  return { node: quote, offset: previous === undefined ? 0 : children.indexOf(previous) + 1 };
}

/**
 * Finds the position in a code block that a character count points at.
 *
 * @param pre The `pre` of the code block.
 * @param code The `code` holding the contents.
 * @param count The number of characters counted from the start of the contents.
 * @param side Whether the position is for the start or the end of the selection.
 * @returns The position.
 */
function findCodePosition(pre: Element, code: Element, count: number, side: 'start' | 'end'): SelectionPoint {
  if (!code.hasChildNodes()) {
    // The same place as when an empty block is converted to a code block: the start of the `pre`.
    return { node: pre, offset: 0 };
  }
  return findCountedPosition(code, count, side, QUOTE_LINE_COUNT)
    ?? { node: code, offset: side === 'start' ? 0 : code.childNodes.length };
}

/**
 * Counts the characters of a line, the same way a plan counts the ends of the selection.
 *
 * @param quote The bare blockquote.
 * @param lines The lines of the blockquote.
 * @param index The index of the line.
 * @param trailingBreak The `br` at the end of the content, which the plan leaves out of its counts.
 * @returns The number of characters.
 */
function countLine(
  quote: Element,
  lines: readonly QuoteLine[],
  index: number,
  trailingBreak: Element | undefined,
): number {
  const start = readLineStart(quote, lines, index);
  const last = lines[index].nodes.at(-1);
  const end = last === undefined
    ? start
    : { node: quote, offset: [...quote.childNodes].indexOf(last) + 1 };
  return countCharacters(quote, start, end, QUOTE_LINE_COUNT, trailingBreak);
}

/**
 * Finds the position in the paragraphs made of the covered lines that a character count points at.
 *
 * The count runs from the start of the first covered line, with the `br` that separated two lines counted as one
 * character. A count at the end of a line stays on that line, as the plan counts an end right before a `br`.
 *
 * @param paragraphs The paragraphs made of the covered lines, in document order.
 * @param lengths The number of characters of each covered line.
 * @param count The number of characters counted from the start of the first covered line.
 * @param side Whether the position is for the start or the end of the selection.
 * @returns The position.
 */
function findSplitPosition(
  paragraphs: readonly Element[],
  lengths: readonly number[],
  count: number,
  side: 'start' | 'end',
): SelectionPoint {
  let remaining = count;
  for (const [index, paragraph] of paragraphs.entries()) {
    if (remaining <= lengths[index] || index === paragraphs.length - 1) {
      return findCountedPosition(paragraph, remaining, side, QUOTE_LINE_COUNT) ?? { node: paragraph, offset: 0 };
    }
    remaining -= lengths[index] + 1;
  }
  return { node: paragraphs[0], offset: 0 };
}

/**
 * Collects the children of a run of lines, with the `br` elements between them.
 *
 * @param lines The lines of the blockquote.
 * @param from The index of the first line in the run.
 * @param to The index just past the last line in the run.
 * @returns The children in document order.
 */
function collectLines(lines: readonly QuoteLine[], from: number, to: number): ChildNode[] {
  const nodes: ChildNode[] = [];
  for (let index = from; index < to; index += 1) {
    const previous = index > from ? lines[index - 1].lineBreak : undefined;
    if (previous !== undefined) {
      nodes.push(previous);
    }
    nodes.push(...lines[index].nodes);
  }
  return nodes;
}

/**
 * Determines whether nothing shows on a line.
 *
 * @param line The line.
 * @returns `true` when the line holds only whitespace and HTML comments.
 */
function isBlankLine(line: QuoteLine): boolean {
  return line.nodes.every(
    (node) => !(node instanceof Element) && !(node instanceof Text && !isHtmlWhitespaceOnly(node.data)),
  );
}

/**
 * Puts a single newline before every block but the first.
 *
 * @param blocks The blocks in document order.
 * @param document The document used to create the newlines.
 * @returns The blocks with the newlines between them.
 */
function joinBlocks(blocks: readonly ChildNode[], document: Document): ChildNode[] {
  const joined: ChildNode[] = [];
  for (const [index, block] of blocks.entries()) {
    if (index > 0) {
      joined.push(document.createTextNode(BLOCK_SEPARATOR_TEXT));
    }
    joined.push(block);
  }
  return joined;
}

/**
 * Determines whether a node is a line break.
 *
 * @param node The node to inspect.
 * @returns `true` for a `br`.
 */
function isBreak(node: Node): node is Element {
  return node instanceof Element && node.localName === 'br';
}
