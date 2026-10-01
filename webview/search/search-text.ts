import { COMMENT_TAG_NAME } from '../../common/index';
import { isDiagramSource } from '../diagram/diagram-source';

/** The state of the two toggles in the search condition, excluding the query. */
export interface SearchOptions {
  /** Whether to distinguish uppercase from lowercase. */
  readonly matchCase: boolean;
  /** Whether to match whole words only. */
  readonly wholeWord: boolean;
}

/** One position in the tree: a text node and an offset inside it. */
interface TextPoint {
  readonly node: Text;
  readonly offset: number;
}

/**
 * One search run of visible text, split at search separators.
 *
 * The string has its whitespace collapsed, and for each character, in the same order, the run holds where in the
 * tree it starts and ends. A collapsed space covers the whole original run of whitespace.
 */
export interface SearchRun {
  /** The string with whitespace collapsed. It has no leading or trailing space. */
  readonly text: string;
  /** The start position of each character. */
  readonly starts: readonly TextPoint[];
  /** The end position of each character. */
  readonly ends: readonly TextPoint[];
}

/** The start and end offsets of a match within a run's string. The end points just past the match. */
export interface MatchOffsets {
  readonly start: number;
  readonly end: number;
}

/** The visible text covered by a selection, and whether it crosses a search separator. */
export interface SelectionSearchText {
  readonly text: string;
  readonly crossesSeparator: boolean;
}

/**
 * One search match.
 *
 * A text match has only its range. A comment id match also carries its comment: the id is never displayed, so the
 * caller opens that comment's popup to show what was found.
 */
export interface SearchMatch {
  /**
   * The range to highlight. For a comment id match, the annotated text from its first to its last visible character,
   * or a collapsed range at the start of the comment when it has none.
   */
  readonly range: Range;
  /** The comment whose id contains the query. `undefined` for a text match. */
  readonly comment?: Element;
}

/** A comment rendered in the editor root, with where the visible characters of its annotated text start and end. */
interface SearchComment {
  readonly element: Element;
  /** The start position of the first visible character. `undefined` until one is met. */
  start: TextPoint | undefined;
  /** The end position of the last visible character met so far. */
  end: TextPoint | undefined;
}

/** The search runs of the editor root and the comments rendered in it, each in document order. */
interface SearchContent {
  readonly runs: SearchRun[];
  readonly comments: SearchComment[];
}

// Characters collapsed into a single space. Outside pre, line feeds are collapsed too; inside pre, a line feed is a
// search separator.
const SPACE_CHARACTERS: ReadonlySet<string> = new Set([' ', '\t', ' ']);
const LINE_FEED = '\n';

// Sequences collapsed into a single space in the query. The search field cannot hold line feeds, but the set is kept
// the same as the rule for search runs.
const QUERY_SPACE_PATTERN = /[ \t \n]+/gu;

// Characters that form words. Without combining marks, a word with a trailing accent mark would break in the middle.
const WORD_CHARACTER_PATTERN = /^[\p{L}\p{M}\p{N}_]$/u;

// The only whitespace in a run's string is collapsed spaces, so this is enough to drop spaces at the edges.
const EDGE_SPACES_PATTERN = /^ +| +$/gu;

/** Builds search runs one at a time, and collects the rendered comments on the way. */
class RunBuilder {
  readonly runs: SearchRun[] = [];

  /** The rendered comments in the document order of their start tags. */
  readonly comments: SearchComment[] = [];

  // The comments whose annotated text is being walked. A visible character added now belongs to every one of them.
  private readonly openComments: SearchComment[] = [];

  private characters: string[] = [];

  private starts: TextPoint[] = [];

  private ends: TextPoint[] = [];

  // A run of whitespace not yet added. Leading and trailing whitespace in a run does not count, so it is added as one
  // space only when the next character arrives.
  private pendingSpace: { readonly start: TextPoint; readonly end: TextPoint } | undefined;

  /**
   * Adds a non-whitespace character.
   *
   * @param character The character (one code unit).
   * @param start The start position of the character.
   * @param end The end position of the character.
   */
  addCharacter(character: string, start: TextPoint, end: TextPoint): void {
    const space = this.pendingSpace;
    this.pendingSpace = undefined;
    if (space !== undefined && this.characters.length > 0) {
      this.push(' ', space.start, space.end);
    }
    this.push(character, start, end);
    for (const comment of this.openComments) {
      comment.start ??= start;
      comment.end = end;
    }
  }

  /**
   * Starts walking the annotated text of a comment.
   *
   * @param element The comment.
   */
  enterComment(element: Element): void {
    const comment: SearchComment = { element, start: undefined, end: undefined };
    this.comments.push(comment);
    this.openComments.push(comment);
  }

  /** Ends walking the annotated text of the innermost comment being walked. */
  leaveComment(): void {
    this.openComments.pop();
  }

  /**
   * Adds one whitespace character. It is collapsed together with following whitespace into a single space.
   *
   * @param start The start position of the whitespace.
   * @param end The end position of the whitespace.
   */
  addSpace(start: TextPoint, end: TextPoint): void {
    this.pendingSpace = { start: this.pendingSpace?.start ?? start, end };
  }

  /** Ends the current run. Empty runs are not kept. */
  cut(): void {
    this.pendingSpace = undefined;
    if (this.characters.length > 0) {
      this.runs.push({ text: this.characters.join(''), starts: this.starts, ends: this.ends });
    }
    this.characters = [];
    this.starts = [];
    this.ends = [];
  }

  private push(character: string, start: TextPoint, end: TextPoint): void {
    this.characters.push(character);
    this.starts.push(start);
    this.ends.push(end);
  }
}

/**
 * Splits the visible text of the editor root into search runs at each search separator. Does not change the tree.
 *
 * Entries and elements whose computed `display` is `none` are skipped along with their descendants. The body of a
 * closed collapsible section is included because it is rendered once opened (the body element's own `display` does
 * not become `none` even while closed). Diagram source blocks are skipped too: what the reader sees is the drawn
 * diagram, and the source shows only while it is edited, so whether it matched would change with the caret.
 *
 * @param root The editor root.
 * @returns The search runs in document order. Runs of only whitespace are not included.
 */
export function collectSearchRuns(root: Element): SearchRun[] {
  return collectSearchContent(root).runs;
}

/**
 * Splits the visible text of the editor root into search runs, and collects the comments rendered in it in the same
 * walk. Does not change the tree.
 *
 * Comments are skipped under the same rules as text, so a comment inside an entry or inside an element whose computed
 * `display` is `none` is not collected, and a comment in the body of a closed collapsible section is.
 *
 * @param root The editor root.
 * @returns The search runs and the comments, each in document order.
 */
function collectSearchContent(root: Element): SearchContent {
  const view = root.ownerDocument.defaultView;
  const builder = new RunBuilder();
  if (view !== null) {
    for (const child of root.childNodes) {
      collectNode(child, false, builder, view);
    }
    builder.cut();
  }
  return { runs: builder.runs, comments: builder.comments };
}

/**
 * Adds the visible text of a node and its descendants to the search runs.
 *
 * @param node The target node.
 * @param insidePre Whether the node is inside `pre`.
 * @param builder The run builder.
 * @param view The window used to read computed styles.
 */
function collectNode(node: Node, insidePre: boolean, builder: RunBuilder, view: Window): void {
  if (node instanceof Text) {
    collectText(node, insidePre, builder);
    return;
  }
  if (!(node instanceof Element) || isEntry(node) || isDiagramSource(node)) {
    return;
  }
  if (node.localName === 'br') {
    builder.cut();
    return;
  }

  const display = view.getComputedStyle(node).display;
  if (display === 'none') {
    return;
  }
  // Only inline boxes and elements that generate no box continue a word. Without a cut at block and cell boundaries,
  // text in the next cell or the next paragraph would continue the word.
  const separates = !display.startsWith('inline') && display !== 'contents';
  if (separates) {
    builder.cut();
  }
  const childInsidePre = insidePre || node.localName === 'pre';
  const isComment = node.localName === COMMENT_TAG_NAME.comment;
  if (isComment) {
    builder.enterComment(node);
  }
  for (const child of node.childNodes) {
    collectNode(child, childInsidePre, builder, view);
  }
  if (isComment) {
    builder.leaveComment();
  }
  if (separates) {
    builder.cut();
  }
}

/**
 * Returns whether the element is an entry (a comment body or reply). Entries are not shown in the document flow.
 *
 * @param element The target element.
 */
function isEntry(element: Element): boolean {
  return element.localName === COMMENT_TAG_NAME.body || element.localName === COMMENT_TAG_NAME.reply;
}

/**
 * Adds the characters of a text node to the search runs.
 *
 * @param node The text node.
 * @param insidePre Whether the node is inside `pre`.
 * @param builder The run builder.
 */
function collectText(node: Text, insidePre: boolean, builder: RunBuilder): void {
  const data = node.data;
  for (let offset = 0; offset < data.length; offset += 1) {
    const character = data[offset];
    if (character === LINE_FEED && insidePre) {
      builder.cut();
      continue;
    }
    const start = { node, offset };
    const end = { node, offset: offset + 1 };
    if (SPACE_CHARACTERS.has(character) || character === LINE_FEED) {
      builder.addSpace(start, end);
    } else {
      builder.addCharacter(character, start, end);
    }
  }
}

/**
 * Collapses each run of whitespace in the query into a single space.
 *
 * Leading and trailing spaces are kept. A query in which the user typed a space matches only where there is a space.
 *
 * @param query The query.
 * @returns The query with whitespace collapsed.
 */
export function normalizeSearchQuery(query: string): string {
  return query.replace(QUERY_SPACE_PATTERN, ' ');
}

/**
 * Returns the offsets in a run's string that match the query.
 *
 * Matches do not overlap. The next search starts at the end of the previous match; only a candidate rejected by whole
 * word restarts one character later.
 *
 * @param text The run's string.
 * @param query The query with whitespace collapsed.
 * @param options The toggles of the search condition.
 * @returns The match offsets in string order. Empty if the query is empty.
 */
export function findMatchOffsets(text: string, query: string, options: SearchOptions): MatchOffsets[] {
  if (query.length === 0) {
    return [];
  }
  const haystack = options.matchCase ? text : foldCase(text);
  const needle = options.matchCase ? query : foldCase(query);
  const found: MatchOffsets[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const start = haystack.indexOf(needle, from);
    if (start === -1) {
      break;
    }
    const end = start + needle.length;
    if (options.wholeWord && !isWholeWord(text, start, end)) {
      from = start + 1;
      continue;
    }
    found.push({ start, end });
    from = end;
  }
  return found;
}

/**
 * Returns whether a comment id contains the query.
 *
 * An id is one opaque token, so whole word is not applied: it would reject a part of an id such as c-a1b2, which is
 * exactly what people search for. Match case still applies, so the toggle means the same for text and for ids.
 *
 * @param id The value of the comment's `id` attribute.
 * @param query The query with whitespace collapsed.
 * @param options The toggles of the search condition.
 * @returns Whether the id contains the query. False if the query is empty.
 */
export function matchesCommentId(id: string, query: string, options: SearchOptions): boolean {
  return findMatchOffsets(id, query, { matchCase: options.matchCase, wholeWord: false }).length > 0;
}

/**
 * Folds characters that differ only in case into the same character.
 *
 * Each code point is lowercased, and characters whose length changes when lowercased (such as İ) are left as they
 * are. If the length changed, offsets in the folded string would no longer correspond to offsets in the original.
 *
 * @param text The original string.
 * @returns The folded string, the same length as the original.
 */
function foldCase(text: string): string {
  let folded = '';
  for (const character of text) {
    const lower = character.toLowerCase();
    folded += lower.length === character.length ? lower : character;
  }
  return folded;
}

/**
 * Returns whether both just before and just after the match are word boundaries. The edges of a run count as
 * boundaries.
 *
 * @param text The run's string.
 * @param start The start offset of the match.
 * @param end The end offset of the match.
 */
function isWholeWord(text: string, start: number, end: number): boolean {
  const after = text.codePointAt(end);
  return !isWordCharacter(readCharacterBefore(text, start))
    && !isWordCharacter(after === undefined ? undefined : String.fromCodePoint(after));
}

/**
 * Returns the character just before an offset. If it is a supplementary-plane character, its two code units are
 * returned as one character.
 *
 * @param text The string.
 * @param index The offset.
 * @returns The preceding character. `undefined` at the start.
 */
function readCharacterBefore(text: string, index: number): string | undefined {
  if (index === 0) {
    return undefined;
  }
  const pair = index >= 2 ? text.codePointAt(index - 2) : undefined;
  if (pair !== undefined && pair > 0xffff) {
    return String.fromCodePoint(pair);
  }
  return text[index - 1];
}

/**
 * Returns whether the character forms words.
 *
 * @param character The character. `undefined` if there is none.
 */
function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && WORD_CHARACTER_PATTERN.test(character);
}

/**
 * Returns the search matches of the editor root that meet the search condition, in document order. Changes neither
 * the tree nor the selection.
 *
 * Text matches come from the visible text. Each fits within one search run, and the range ends are positions inside
 * the original text nodes. Comment id matches come from the comments rendered in the editor root, one for each
 * comment whose id contains the query.
 *
 * @param root The editor root.
 * @param query The query before collapsing whitespace.
 * @param options The toggles of the search condition.
 * @returns The matches in document order. Text matches do not overlap one another. Empty if the collapsed query is
 *   empty.
 */
export function findSearchMatches(root: Element, query: string, options: SearchOptions): SearchMatch[] {
  const normalized = normalizeSearchQuery(query);
  if (normalized.length === 0) {
    return [];
  }
  const document = root.ownerDocument;
  const content = collectSearchContent(root);
  const textMatches: SearchMatch[] = [];
  for (const run of content.runs) {
    for (const found of findMatchOffsets(run.text, normalized, options)) {
      const start = run.starts[found.start];
      const end = run.ends[found.end - 1];
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      textMatches.push({ range });
    }
  }
  const idMatches = content.comments
    .filter((comment) => matchesCommentId(comment.element.getAttribute('id') ?? '', normalized, options))
    .map((comment) => ({ range: readAnnotatedRange(comment, document), comment: comment.element }));
  return mergeSearchMatches(textMatches, idMatches);
}

/**
 * Merges text matches and comment id matches into one list in document order.
 *
 * Matches are ordered by their start, and by their end when the starts are the same. A text match with exactly the
 * same range as a comment id match is dropped: to the reader it is one place, and keeping the id match still opens the
 * popup.
 *
 * @param textMatches The text matches.
 * @param idMatches The comment id matches.
 * @returns The merged matches.
 */
export function mergeSearchMatches(
  textMatches: readonly SearchMatch[],
  idMatches: readonly SearchMatch[],
): SearchMatch[] {
  // The sort is stable and the text matches come first, so a text match precedes the id matches with the same range.
  const sorted = [...textMatches, ...idMatches].sort((a, b) => compareRanges(a.range, b.range));
  const merged: SearchMatch[] = [];
  for (const match of sorted) {
    const last = merged.at(-1);
    if (
      last !== undefined
      && last.comment === undefined
      && match.comment !== undefined
      && compareRanges(last.range, match.range) === 0
    ) {
      merged[merged.length - 1] = match;
      continue;
    }
    merged.push(match);
  }
  return merged;
}

/**
 * Creates the range of a comment id match.
 *
 * It runs from the start of the first visible character of the annotated text to the end of the last, the positions
 * a text match uses, so a text match equal to the annotated text has exactly the same range. Annotated text without
 * visible characters (only an image, or nothing) gets a collapsed range at its start. There is nothing to paint, but
 * the match is still counted and its comment still opens.
 *
 * @param comment The collected comment.
 * @param document The document of the editor root.
 * @returns The range.
 */
function readAnnotatedRange(comment: SearchComment, document: Document): Range {
  const range = document.createRange();
  if (comment.start === undefined || comment.end === undefined) {
    range.setStart(comment.element, 0);
    range.collapse(true);
    return range;
  }
  range.setStart(comment.start.node, comment.start.offset);
  range.setEnd(comment.end.node, comment.end.offset);
  return range;
}

/**
 * Compares two ranges in document order by their start, and by their end when the starts are the same.
 *
 * @param a One range.
 * @param b The other range.
 * @returns Negative if a comes first, positive if b comes first, and 0 only for the same start and end.
 */
function compareRanges(a: Range, b: Range): number {
  const start = a.compareBoundaryPoints(Range.START_TO_START, b);
  return start !== 0 ? start : a.compareBoundaryPoints(Range.END_TO_END, b);
}

/**
 * Returns the visible text covered by a range, using the same rules as matching.
 *
 * Leading and trailing spaces are removed. In some environments double-clicking a word also selects the trailing
 * space, and using that as the query as is would match only where a space follows.
 *
 * @param root The editor root.
 * @param range The range.
 * @returns The visible text, and whether two or more search runs contribute non-empty visible text. `undefined` if
 *   the range is collapsed or outside the editor root.
 */
export function readSelectionSearchText(root: Element, range: Range): SelectionSearchText | undefined {
  if (range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return undefined;
  }
  const pieces: string[] = [];
  for (const run of collectSearchRuns(root)) {
    const last = run.text.length - 1;
    if (range.comparePoint(run.ends[last].node, run.ends[last].offset) < 0) {
      continue;
    }
    if (range.comparePoint(run.starts[0].node, run.starts[0].offset) > 0) {
      break;
    }
    const piece = readRunPiece(run, range).replace(EDGE_SPACES_PATTERN, '');
    if (piece.length > 0) {
      pieces.push(piece);
    }
  }
  return { text: pieces.join(LINE_FEED), crossesSeparator: pieces.length > 1 };
}

/**
 * Returns the characters of a search run whose start and end both lie inside the range.
 *
 * @param run The search run.
 * @param range The range.
 * @returns The characters covered by the range. Empty if none.
 */
function readRunPiece(run: SearchRun, range: Range): string {
  let first = -1;
  let last = -1;
  for (let index = 0; index < run.text.length; index += 1) {
    const start = run.starts[index];
    const end = run.ends[index];
    if (range.comparePoint(start.node, start.offset) === 0 && range.comparePoint(end.node, end.offset) === 0) {
      if (first === -1) {
        first = index;
      }
      last = index;
    }
  }
  return first === -1 ? '' : run.text.slice(first, last + 1);
}
