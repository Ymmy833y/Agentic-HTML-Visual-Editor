import { ALERT_KINDS } from '../../common/index';
import { ALERT_STATE, findAlertTarget } from './alert-state';
import { fillPlaceholder, findBlock, isEmptyBlock } from './block';
import { runBlockOperation } from './block-command';
import type { BlockCommandPorts, BlockOperation } from './block-command';
import { BLOCK_KIND, isConvertibleBlock } from './block-format';
import { placeCaret, placeCaretAtStart } from './caret';
import { readCellRun } from './cell-wrap';
import type { CellRun } from './cell-wrap';
import type { DiagnosticReporter, InputRuleResult } from './input-dispatcher';
import { isBareBlockquote, keepEmptyLastLine, selectCaretLine } from './quote-code-block';

/**
 * An autoformat commit: either a text input of a single half-width space, or a paragraph insertion (Enter).
 *
 * A line break insertion (Shift+Enter) is not included. It splits lines inside a block and carries no intent to
 * rebuild the block.
 */
export type AutoformatCommit = 'space' | 'enter';

/** An entry in the autoformat table: an autoformat commit, a marker and an operation. */
export interface AutoformatEntry {
  /** The autoformat commit that triggers the entry. */
  readonly commit: AutoformatCommit;

  /** The marker. Letters are held in lower case. */
  readonly marker: string;

  /**
   * Whether the entry also matches on a line of a bare blockquote. Left out, it does not.
   *
   * Set on the code block, horizontal rule and list entries. Their operations act on the caret's line of a bare
   * blockquote and keep the blockquote, while heading and blockquote markers there would silently change the kind of
   * the whole blockquote.
   */
  readonly matchesQuoteLine?: boolean;

  /**
   * Whether the entry is left out in a block inside a blockquote. Left out, it is not.
   *
   * Set on the blockquote and alert entries. Their operation acts on the blockquote around the block, so a marker
   * typed at the start of a paragraph there would silently change the kind of the whole blockquote, or, when the
   * blockquote already has that kind, only remove the marker. The marker stays as text instead, the same as on a line
   * of a bare blockquote.
   */
  readonly skipsInsideQuote?: boolean;

  /**
   * Called after the caret has been placed at the start of the block (on a line of a bare blockquote, where the line
   * was, and in a cell run, where the marker was), and rebuilds the block.
   *
   * @returns Whether the tree was changed.
   */
  run(): boolean;
}

/**
 * The matched entry, the block and the removal, handed from matching to applying.
 *
 * Nothing changes the tree after matching; the match is handed to applying within the same input. If the tree
 * changed, the removal would point at different characters.
 */
export interface AutoformatMatch {
  /** The matched entry. */
  readonly entry: AutoformatEntry;

  /**
   * The innermost block containing the caret, which is a convertible paragraph or div, a bare blockquote when the
   * match is on a line of it, or a table cell when the match is in a bare run directly inside it.
   */
  readonly block: Element;

  /**
   * The range to delete as the marker. For a space, from the start of the block to the caret; for Enter, the whole
   * content. On a line of a bare blockquote, the line takes the place of the block, and in a cell run, the run does.
   */
  readonly removal: Range;

  /** Whether the match is on a line of a bare blockquote. */
  readonly quoteLine: boolean;

  /**
   * Whether the match is in a bare run directly inside a table cell.
   *
   * The run is matched as if it were a paragraph. The entry's operation wraps the run holding the caret in a paragraph
   * before it rebuilds anything, the same as when the operation is chosen from the toolbar.
   */
  readonly cellRun: boolean;
}

/**
 * The children of the block that are compared with the markers, as a span of child offsets: all of a paragraph's or
 * div's children, or only the nodes of a cell run.
 */
interface ComparedChildren {
  /** The offset of the first child. */
  readonly start: number;
  /** The offset right after the last child. */
  readonly end: number;
}

// Whitespace not counted when matching the marker. This includes parts that are not displayed, such as newlines and
// indentation in the source, and the no-break spaces the browser inserts when spaces are typed in a row.
const LEADING_WHITESPACE_PATTERN = /^[\t\n\f\r  ]+/u;
const TRAILING_WHITESPACE_PATTERN = /[\t\n\f\r  ]+$/u;

// The elements that can be the block. Limited to paragraphs and divs so that symbols at the start of headings,
// blockquotes, code blocks and list items (a shell comment's # or a YAML -, for example) do not silently change the
// block kind.
const AUTOFORMAT_BLOCK_TAG_NAMES: ReadonlySet<string> = new Set(['p', 'div']);

// The mapping from the number of # in a heading marker minus one to the block kind to convert to.
const HEADING_KINDS = [
  BLOCK_KIND.heading1,
  BLOCK_KIND.heading2,
  BLOCK_KIND.heading3,
  BLOCK_KIND.heading4,
  BLOCK_KIND.heading5,
  BLOCK_KIND.heading6,
] as const;

/** The autoformat table. Holds a list of entries and determines which entry an autoformat commit and range match. */
export class AutoformatTable {
  // Not changed after the entries are added at startup.
  private readonly entries: AutoformatEntry[] = [];

  /**
   * Appends an entry to the end of the list.
   *
   * If several entries have the same autoformat commit and marker, the one added first is used.
   *
   * @param entry The entry to add.
   */
  addEntry(entry: AutoformatEntry): void {
    this.entries.push(entry);
  }

  /**
   * Looks for the entry whose marker matches the block, given an autoformat commit and a range. Changes neither the
   * tree nor the selection.
   *
   * @param commit The autoformat commit.
   * @param root The editor root.
   * @param range A range inside the editor root.
   * @returns The match, or `undefined` when there is a range selection, when there is no block, or when no entry in
   *   the table matches.
   */
  findMatch(commit: AutoformatCommit, root: Element, range: Range): AutoformatMatch | undefined {
    if (!range.collapsed) {
      return undefined;
    }

    const innermost = findBlock(range.startContainer, root);
    if (innermost === undefined) {
      return undefined;
    }
    // In a bare blockquote Enter inserts a line break, so a marker is matched against the caret's line rather than
    // the whole blockquote.
    const quoteLine = isBareBlockquote(innermost);
    const convertible = AUTOFORMAT_BLOCK_TAG_NAMES.has(innermost.localName) && isConvertibleBlock(innermost);
    // Bare text directly inside a table cell is matched as if it were a paragraph, so that a marker typed in a table
    // works as it does elsewhere. Only the run holding the caret counts, which is the run the operation then wraps.
    const cellRun = quoteLine || convertible
      ? undefined
      : readCellRun(root, range.startContainer, range.startOffset);
    if (!quoteLine && !convertible && cellRun === undefined) {
      return undefined;
    }
    const block = cellRun?.cell ?? innermost;
    const children = readComparedChildren(block, cellRun);

    const compared = createComparedRange(commit, block, range, quoteLine, children);
    const text = readComparedText(block, compared);
    if (text === undefined) {
      return undefined;
    }
    const marker = normalizeMarker(text, commit);
    // A blockquote is the alert target of itself, so only a block inside one has another element as its target.
    const insideQuote = findAlertTarget(block, root) !== block;
    const entry = this.entries.find(
      (candidate) => candidate.commit === commit
        && candidate.marker === marker
        && (!quoteLine || candidate.matchesQuoteLine === true)
        && !(insideQuote && candidate.skipsInsideQuote === true),
    );
    if (entry === undefined) {
      return undefined;
    }

    if (commit === 'enter' && !quoteLine) {
      // Include the trailing br that was left out of the comparison in the removal too. Once it is removed, the
      // placeholder is put back in as for an empty block.
      compared.setEnd(block, children.end);
    }
    return { entry, block, removal: compared, quoteLine, cellRun: cellRun !== undefined };
  }
}

/**
 * Returns the children of the block that are compared with the markers.
 *
 * @param block The block. In a cell run, the cell.
 * @param cellRun The cell run, or `undefined` when the caret is not in one.
 * @returns All of the block's children, or in a cell run only the nodes of the run.
 */
function readComparedChildren(block: Element, cellRun: CellRun | undefined): ComparedChildren {
  if (cellRun === undefined) {
    return { start: 0, end: block.childNodes.length };
  }
  const children = [...block.childNodes];
  return {
    start: children.indexOf(cellRun.nodes[0]),
    end: children.indexOf(cellRun.nodes[cellRun.nodes.length - 1]) + 1,
  };
}

/**
 * Creates the range compared with the markers.
 *
 * A new range is created. The range received is tied to the live selection, and moving it would move the caret too.
 *
 * @param commit The autoformat commit.
 * @param block The block.
 * @param range The collapsed range at the caret.
 * @param quoteLine Whether the block is a bare blockquote and the caret's line is compared.
 * @param children The children compared when the caret's line is not.
 * @returns The range to compare.
 */
function createComparedRange(
  commit: AutoformatCommit,
  block: Element,
  range: Range,
  quoteLine: boolean,
  children: ComparedChildren,
): Range {
  if (quoteLine) {
    // The br elements that separate the lines belong to no line, so they stay out of the comparison and the removal.
    const line = selectCaretLine(block, range);
    if (commit === 'space') {
      line.setEnd(range.startContainer, range.startOffset);
    }
    return line;
  }

  const compared = block.ownerDocument.createRange();
  compared.setStart(block, children.start);
  if (commit === 'space') {
    compared.setEnd(range.startContainer, range.startOffset);
    return compared;
  }
  // A single trailing br is regarded as a placeholder that only gives an empty line its height, and is left out of
  // the comparison.
  const last = block.childNodes[children.end - 1];
  const trailingBreak = last instanceof Element && last.localName === 'br';
  compared.setEnd(block, children.end - (trailingBreak ? 1 : 0));
  return compared;
}

/**
 * Creates the entries for headings, blockquotes, alert blockquotes, code blocks and horizontal rules.
 *
 * An entry's operation is called inside the edit attempt the input dispatcher opened, so the block operation is
 * called with the rule trigger. Calling it with the command trigger would try to open the attempt again, be
 * rejected, and do nothing.
 *
 * @param ports The block command ports.
 * @returns 14 entries. List entries are not included.
 */
export function createAutoformatEntries(ports: BlockCommandPorts): AutoformatEntry[] {
  const createEntry = (
    commit: AutoformatCommit,
    marker: string,
    operation: BlockOperation,
  ): AutoformatEntry => ({
    commit,
    marker,
    run: () => runBlockOperation(ports, operation, 'rule'),
  });

  return [
    ...HEADING_KINDS.map((kind, index) => createEntry('space', '#'.repeat(index + 1), { kind: 'convert', to: kind })),
    // A blockquote is made with an alert operation rather than a block conversion. With a block conversion, an
    // alert attribute left on the paragraph would take effect on the blockquote, and the look would disagree with
    // the marker typed.
    { ...createEntry('space', '>', { kind: 'alert', to: ALERT_STATE.none }), skipsInsideQuote: true },
    ...ALERT_KINDS.map((kind) => ({
      ...createEntry('space', `>${kind}`, { kind: 'alert', to: kind }),
      skipsInsideQuote: true,
    })),
    { ...createEntry('enter', '```', { kind: 'convert', to: BLOCK_KIND.codeBlock }), matchesQuoteLine: true },
    { ...createEntry('enter', '---', { kind: 'horizontalRule' }), matchesQuoteLine: true },
  ];
}

/**
 * For a matched entry, deletes the marker and then calls the entry's operation.
 *
 * The marker is deleted first because a horizontal rule is inserted before its reference only when that reference
 * is an empty block, keeping the caret in that block. Rebuilding first would move the marker into the new element,
 * and another paragraph would be inserted after `---`. The autoformat commit itself (the space or line break) is not
 * inserted.
 *
 * @param match The match.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 * @returns `edited` if the marker could be deleted, or `consumed` if it failed before deleting.
 */
export function applyAutoformat(
  match: AutoformatMatch,
  reportDiagnostic: DiagnosticReporter,
): Exclude<InputRuleResult, 'pass'> {
  try {
    const end = match.removal.endContainer;
    match.removal.deleteContents();
    if (end instanceof Text && end.data.length === 0) {
      // A text node that became empty is debris that shows up neither on screen nor in the saved file, so it is not
      // left in the tree.
      end.remove();
    }
  } catch (error) {
    // Returning `pass` would let the space or line break fall through to the default insertion, after the marker.
    reportDiagnostic(`Could not delete the markdown-style autoformat marker: ${String(error)}`);
    return 'consumed';
  }

  try {
    if (isEmptyBlock(match.block)) {
      // A block with no content has no height and looks as if the line disappeared.
      fillPlaceholder(match.block);
    } else if (match.quoteLine) {
      // Likewise a last line left without content would disappear from the blockquote.
      keepEmptyLastLine(match.block, match.removal);
    }
    if (match.quoteLine || match.cellRun) {
      // The operations matched on a line of a bare blockquote work on the caret's line, and those matched in a cell
      // run wrap the run holding the caret, so the caret stays where the marker was. The start of the cell could be
      // before another block, outside the run.
      placeCaret(match.removal.startContainer, match.removal.startOffset);
    } else {
      placeCaretAtStart(match.block);
    }
    if (!match.entry.run()) {
      reportDiagnostic('The markdown-style autoformat operation did not change the tree');
    }
  } catch (error) {
    reportDiagnostic(`Could not finish the markdown-style autoformat operation: ${String(error)}`);
  }
  // The tree has already changed once the marker was deleted. Aborting would make the display and the saved content
  // disagree.
  return 'edited';
}

/**
 * Reads the text of the compared range.
 *
 * If the range spans an element, it does not match. Deleting a marker that spans an element could delete the
 * contents of a format element or a comment annotation too.
 *
 * @param block The block.
 * @param compared The compared range. It starts at the start of the block.
 * @returns The text of the range, or `undefined` if a node other than text intersects the range.
 */
function readComparedText(block: Element, compared: Range): string | undefined {
  let text = '';
  // Looking at the direct children alone is enough. If the caret is inside an element, that element itself
  // intersects the range.
  for (const child of block.childNodes) {
    if (!compared.intersectsNode(child)) {
      continue;
    }
    if (!(child instanceof Text)) {
      return undefined;
    }
    text += child.data.slice(0, child === compared.endContainer ? compared.endOffset : child.data.length);
  }
  return text;
}

/**
 * Strips whitespace from the text to compare and converts it to lower case.
 *
 * For a space only the part before the caret is looked at, so only leading whitespace is stripped.
 *
 * @param text The text of the compared range.
 * @param commit The autoformat commit.
 * @returns The text to compare with an entry's marker.
 */
function normalizeMarker(text: string, commit: AutoformatCommit): string {
  const trimmed = text.replace(LEADING_WHITESPACE_PATTERN, '');
  return (commit === 'enter' ? trimmed.replace(TRAILING_WHITESPACE_PATTERN, '') : trimmed).toLowerCase();
}
