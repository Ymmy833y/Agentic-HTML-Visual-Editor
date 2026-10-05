import { COMMENT_TAG_NAME } from '../../common/index';
import { isDiagramSource } from '../diagram/diagram-source';
import type { BlockCommandPorts } from './block-command';
import { insertTextAtRange, placeCaret, readSelectionRange } from './caret';
import { placeRangeInEmptyCode } from './code-block-text';
import type { ShortcutKey, ShortcutReceiver } from './shortcut-receiver';

/** The shortcut key that indents code (Tab). Requires none of the modifier keys. */
export const CODE_INDENT_KEY: ShortcutKey = { code: 'Tab', primary: false, shift: false, alt: false };

/** The shortcut key that outdents code (Shift+Tab). Does not match if any other modifier key is added. */
export const CODE_OUTDENT_KEY: ShortcutKey = { code: 'Tab', primary: false, shift: true, alt: false };

/** The edit kind of indenting code. */
export const CODE_INDENT_EDIT_KIND = 'codeBlock:indent';

/** The edit kind of outdenting code. */
export const CODE_OUTDENT_EDIT_KIND = 'codeBlock:outdent';

/** One level of code indent: four spaces, the default tab size of VS Code. */
export const CODE_INDENT_TEXT = '    ';

// The comment entries are not part of the code, so their line breaks and spaces never form or indent a line.
const COMMENT_ENTRY_NAMES: ReadonlySet<string> = new Set([COMMENT_TAG_NAME.body, COMMENT_TAG_NAME.reply]);

/** The ports of the code indent shortcuts. Read on every call, because document replacement swaps the session. */
export type CodeIndentPorts = Pick<
  BlockCommandPorts,
  'readEditorRoot' | 'isComposing' | 'isInputStopped' | 'runCommandEdit'
>;

/** A position in the tree. */
interface Point {
  readonly node: Node;
  readonly offset: number;
}

/** One leading whitespace character of a line. */
interface LeadingCharacter {
  readonly text: Text;
  readonly offset: number;
  readonly character: string;
}

/** One line of a code block. */
interface CodeLine {
  /** The position where the line starts, which is where an indent goes. */
  readonly start: Point;
  /** The spaces and tabs the line starts with, in order. */
  readonly leading: LeadingCharacter[];
  /** Whether the line holds nothing before its break or the end of the block. */
  empty: boolean;
}

/**
 * Appends Tab and Shift+Tab to the shortcut receiver as shortcuts taken over when the selection lies in one code
 * block. Register them before the list and table shortcuts, so that a code block inside a list item or a cell
 * indents its code rather than nesting the item or moving to the next cell.
 *
 * @param receiver The shortcut receiver.
 * @param ports The ports of the code indent shortcuts.
 */
export function registerCodeBlockIndentShortcuts(receiver: ShortcutReceiver, ports: CodeIndentPorts): void {
  const register = (key: ShortcutKey, direction: 'indent' | 'outdent'): void => {
    receiver.register({ key, run: () => (runCodeIndent(ports, direction) ? 'preventDefault' : 'pass') });
  };

  register(CODE_INDENT_KEY, 'indent');
  register(CODE_OUTDENT_KEY, 'outdent');
}

/**
 * Indents or outdents the code at the selection as one edit.
 *
 * During a composition and an input stop, the key is still taken over and nothing happens. Letting it through would
 * move focus out of the editor root.
 *
 * @param ports The ports of the code indent shortcuts.
 * @param direction Whether to add or remove one level.
 * @returns `true` when the key is taken over: both ends of the selection lie in the same code block.
 */
export function runCodeIndent(ports: CodeIndentPorts, direction: 'indent' | 'outdent'): boolean {
  const root = ports.readEditorRoot();
  const range = root === undefined ? undefined : readSelectionRange(root);
  const pre = root === undefined || range === undefined ? undefined : findIndentTarget(root, range);
  if (root === undefined || range === undefined || pre === undefined) {
    return false;
  }
  if (ports.isComposing() || ports.isInputStopped()) {
    return true;
  }
  ports.runCommandEdit(direction === 'indent' ? CODE_INDENT_EDIT_KIND : CODE_OUTDENT_EDIT_KIND, () => (
    direction === 'indent' ? indentCode(root, pre, range) : outdentCode(pre, range)
  ));
  return true;
}

/**
 * Returns the code block that holds both ends of the range: the innermost `pre`, unless it is a diagram source block.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @returns The `pre`, or `undefined` when the ends are not in the same code block.
 */
export function findIndentTarget(root: Element, range: Range): Element | undefined {
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const pre = start?.closest('pre') ?? null;
  if (pre === null || !root.contains(pre) || isDiagramSource(pre) || !pre.contains(range.endContainer)) {
    return undefined;
  }
  return pre;
}

/**
 * Adds one level of indent. A caret gets the indent at its position; a range gets it at the start of each line it
 * touches, leaving out blank lines when it touches several. The selection keeps covering the same characters.
 *
 * @param root The editor root.
 * @param pre The code block.
 * @param range The selection range.
 * @returns `true`, since an indent always goes in.
 */
export function indentCode(root: Element, pre: Element, range: Range): boolean {
  if (range.collapsed) {
    // In an empty code block the caret sits outside the `code`, and the spaces would land outside it.
    placeRangeInEmptyCode(root, range);
    const inserted = insertTextAtRange(range, CODE_INDENT_TEXT);
    if (inserted !== undefined) {
      placeCaret(inserted, inserted.data.length);
    }
    return true;
  }

  const touched = readTouchedLines(pre, range);
  const lines = touched.length > 1 ? touched.filter((line) => !line.empty) : touched;
  const kept = range.cloneRange();
  // Later lines first, so that an insertion never shifts a position that is still to be used.
  for (const line of [...lines].reverse()) {
    insertIndent(line.start);
  }
  restoreSelection(kept);
  return lines.length > 0;
}

/**
 * Removes one level of indent from each line the selection touches: a leading tab, or else up to four leading
 * spaces.
 *
 * @param pre The code block.
 * @param range The selection range.
 * @returns Whether any character was removed.
 */
export function outdentCode(pre: Element, range: Range): boolean {
  const kept = range.cloneRange();
  let changed = false;
  for (const line of [...readTouchedLines(pre, range)].reverse()) {
    const removed = readRemovableIndent(line.leading);
    // Last character first, so that the offsets of the earlier ones in the same text stay valid.
    for (const character of [...removed].reverse()) {
      character.text.deleteData(character.offset, 1);
      changed = true;
    }
  }
  if (changed) {
    restoreSelection(kept);
  }
  return changed;
}

/**
 * Returns the characters one level of outdent removes: a leading tab, or else up to four leading spaces.
 *
 * @param leading The leading whitespace of a line.
 * @returns The characters to remove, in order.
 */
function readRemovableIndent(leading: readonly LeadingCharacter[]): LeadingCharacter[] {
  if (leading[0]?.character === '\t') {
    return [leading[0]];
  }
  const spaces: LeadingCharacter[] = [];
  for (const character of leading) {
    if (character.character !== ' ' || spaces.length === CODE_INDENT_TEXT.length) {
      break;
    }
    spaces.push(character);
  }
  return spaces;
}

/**
 * Returns the lines the range touches. A range that ends right at the start of a line does not touch that line, unless
 * it also starts there.
 *
 * @param pre The code block.
 * @param range The selection range.
 * @returns The lines, in order.
 */
function readTouchedLines(pre: Element, range: Range): CodeLine[] {
  const lines = readCodeLines(pre);
  if (lines.length === 0) {
    return [];
  }
  const first = findLineIndex(lines, range.startContainer, range.startOffset);
  let last = findLineIndex(lines, range.endContainer, range.endOffset);
  if (last > first && comparePoints(lines[last].start, { node: range.endContainer, offset: range.endOffset }) === 0) {
    last -= 1;
  }
  return lines.slice(first, last + 1);
}

/**
 * Returns the index of the line that holds a position: the last line starting at or before it, or the first line.
 *
 * @param lines The lines of the code block.
 * @param node The node of the position.
 * @param offset The offset of the position.
 * @returns The index.
 */
function findLineIndex(lines: readonly CodeLine[], node: Node, offset: number): number {
  let index = 0;
  lines.forEach((line, candidate) => {
    if (comparePoints(line.start, { node, offset }) <= 0) {
      index = candidate;
    }
  });
  return index;
}

/**
 * Splits a code block into lines. A newline in a text and a `br` end a line. The trailing newline that forms no line
 * starts no line either.
 *
 * @param pre The code block.
 * @returns The lines, in order. Empty for a code block without content.
 */
function readCodeLines(pre: Element): CodeLine[] {
  const lines: CodeLine[] = [];
  let current: CodeLine | undefined;
  // Whether the line still has only whitespace so far.
  let inLeading = true;
  const startLine = (start: Point): void => {
    current = { start, leading: [], empty: true };
    lines.push(current);
    inLeading = true;
  };
  const touchContent = (start: Point): CodeLine => {
    if (current === undefined) {
      startLine(start);
    }
    const line = current as CodeLine;
    line.empty = false;
    return line;
  };

  const walker = pre.ownerDocument.createTreeWalker(pre, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node instanceof Element && COMMENT_ENTRY_NAMES.has(node.localName)
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text) {
      for (let offset = 0; offset < node.data.length; offset += 1) {
        const character = node.data[offset];
        if (character === '\n') {
          if (current === undefined) {
            startLine({ node, offset });
          }
          startLine({ node, offset: offset + 1 });
          continue;
        }
        const line = touchContent({ node, offset });
        if (inLeading && (character === ' ' || character === '\t')) {
          line.leading.push({ text: node, offset, character });
        } else {
          inLeading = false;
        }
      }
      continue;
    }
    if (!(node instanceof Element) || node.parentNode === null) {
      continue;
    }
    const index = Array.prototype.indexOf.call(node.parentNode.childNodes, node) as number;
    if (node.localName === 'br') {
      if (current === undefined) {
        startLine({ node: node.parentNode, offset: index });
      }
      startLine({ node: node.parentNode, offset: index + 1 });
    } else if (node.localName === 'img') {
      touchContent({ node: node.parentNode, offset: index });
      inLeading = false;
    }
  }
  // A last line with nothing in it follows the trailing break, which forms no line of its own.
  if (lines.length > 1 && lines[lines.length - 1].empty) {
    lines.pop();
  }
  return lines;
}

/**
 * Puts one level of indent at a position. A range's end that sits exactly there stays before the indent, as the tree
 * moves the ends of a live range.
 *
 * @param point The start of a line.
 */
function insertIndent(point: Point): void {
  if (point.node instanceof Text) {
    point.node.insertData(point.offset, CODE_INDENT_TEXT);
    return;
  }
  const document = point.node.ownerDocument;
  if (document !== null) {
    point.node.insertBefore(document.createTextNode(CODE_INDENT_TEXT), point.node.childNodes[point.offset] ?? null);
  }
}

/**
 * Makes a range the selection again.
 *
 * @param range The range to select.
 */
function restoreSelection(range: Range): void {
  const selection = range.startContainer.ownerDocument?.defaultView?.getSelection();
  if (selection === null || selection === undefined) {
    return;
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Compares two positions in tree order.
 *
 * @param a The first position.
 * @param b The second position.
 * @returns -1 when `a` comes first, 0 when they are the same, and 1 when `b` comes first.
 */
function comparePoints(a: Point, b: Point): number {
  const document = a.node.ownerDocument;
  if (document === null) {
    return 0;
  }
  const probe = document.createRange();
  probe.setStart(a.node, a.offset);
  return -probe.comparePoint(b.node, b.offset);
}
