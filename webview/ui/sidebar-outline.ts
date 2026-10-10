import { CHANGE_KIND, COMMENT_AUTHOR, COMMENT_TAG_NAME } from '../../common/index';
import type { CommentAuthor } from '../../common/index';
import { HEADING_TAG_NAMES } from '../editing/block';
import {
  REPLACEMENT_KIND,
  readChangeAuthor,
  readChangeKind,
  readChanges,
  readReplacementPartner,
} from '../editing/change-read';
import type { ChangeUnitKind } from '../editing/change-read';
import { readCommentEntries } from '../editing/comment-read';
import { isAiEntry, isCommentResolved } from '../editing/comment-thread-read';

/** One heading of the heading outline. */
export interface HeadingOutlineItem {
  /** The heading element in the editor root. */
  readonly element: Element;
  /** How many headings above it the heading nests under, counting from 0. */
  readonly depth: number;
  /** The outline text. Empty when the heading has no text. */
  readonly text: string;
}

/** One comment of the comment outline. */
export interface CommentOutlineItem {
  /** The comment element in the editor root. */
  readonly element: Element;
  /** The outline text of the annotated text. Empty when there is none. */
  readonly text: string;
  /** Whether the thread is resolved. */
  readonly resolved: boolean;
  /** The side of the thread's author, decided by its first entry like the color of the annotated text. */
  readonly author: CommentAuthor;
}

/** One entry of the change outline: a change mark, or a replacement pair listed as one. */
export interface ChangeOutlineItem {
  /**
   * The change mark in the editor root: an inline mark, an element that carries the kind, or the deletion that leads
   * a replacement pair.
   */
  readonly element: Element;
  /** Whether the entry is an insertion, a deletion or a replacement pair. */
  readonly kind: ChangeUnitKind;
  /**
   * The outline text of the content of the mark. For a pair, the text of the deletion, an arrow and the text of the
   * insertion. Empty when there is none.
   */
  readonly text: string;
  /** The side of the mark's author. */
  readonly author: CommentAuthor;
}

// Entries are not shown in the document flow, so neither they nor anything written inside them names a heading or a
// comment in the outline.
const ENTRY_TAG_NAMES: ReadonlySet<string> = new Set([COMMENT_TAG_NAME.body, COMMENT_TAG_NAME.reply]);

// Selects every heading level. Built from the shared set so that the outline and the block kinds agree on what a
// heading is.
const HEADING_SELECTOR = [...HEADING_TAG_NAMES].join(', ');

// Runs of whitespace, including line breaks and no-break spaces, are shown as one space, as the document renders them.
const WHITESPACE_RUN_PATTERN = /\s+/gu;

// Joins the two texts of a replacement pair in one item: what goes, then what comes in its place.
const REPLACEMENT_TEXT_SEPARATOR = ' → ';

/**
 * Returns the headings of the editor root in document order, with how deep each nests. Does not change the tree.
 *
 * A heading nests under the nearest heading before it with a higher level (a smaller number). A skipped level (an h3
 * right after an h1) still nests only one step deeper, so the outline has no empty steps. Headings in the body of a
 * closed collapsible section are included, because opening the section shows them; headings inside entries are not.
 *
 * @param root The editor root.
 * @returns The headings with their depths and outline texts.
 */
export function readHeadingOutline(root: Element): HeadingOutlineItem[] {
  const items: HeadingOutlineItem[] = [];
  // The levels of the headings the next heading can nest under, outermost first.
  const levels: number[] = [];
  for (const element of root.querySelectorAll(HEADING_SELECTOR)) {
    if (isInsideEntry(element, root)) {
      continue;
    }
    const level = Number(element.localName.slice(1));
    while (levels.length > 0 && levels[levels.length - 1] >= level) {
      levels.pop();
    }
    items.push({ element, depth: levels.length, text: readOutlineText(element) });
    levels.push(level);
  }
  return items;
}

/**
 * Returns every comment of the editor root in the document order of their start tags. Does not change the tree.
 *
 * Nested comments count one each, the same order in which the popup moves to the previous and next comment.
 *
 * @param root The editor root.
 * @returns The comments with the outline texts of their annotated text, whether each is resolved and which side wrote it.
 */
export function readCommentOutline(root: Element): CommentOutlineItem[] {
  return [...root.querySelectorAll(COMMENT_TAG_NAME.comment)].map((element) => {
    const first = readCommentEntries(element).at(0);
    return {
      element,
      text: readOutlineText(element),
      resolved: isCommentResolved(element),
      author: first !== undefined && isAiEntry(first) ? COMMENT_AUTHOR.ai : COMMENT_AUTHOR.human,
    };
  });
}

/**
 * Returns every change of the editor root in the document order of their start tags. Does not change the tree.
 *
 * Nested marks count one each, and marks inside entries are left out, as the marks are read everywhere else. A
 * replacement pair is one entry, listed where its deletion is and decided as one from the popup it opens.
 *
 * @param root The editor root.
 * @returns The entries with their kinds, the outline texts of their content and the sides of their authors.
 */
export function readChangeOutline(root: Element): ChangeOutlineItem[] {
  const items: ChangeOutlineItem[] = [];
  for (const element of readChanges(root)) {
    // Reading marks returns only elements that have a kind.
    const kind = readChangeKind(element) ?? CHANGE_KIND.insertion;
    const partner = readReplacementPartner(element);
    // The insertion of a pair is listed with its deletion, which comes before it in document order.
    if (partner !== undefined && kind === CHANGE_KIND.insertion) {
      continue;
    }
    items.push({
      element,
      kind: partner === undefined ? kind : REPLACEMENT_KIND,
      text: partner === undefined
        ? readOutlineText(element)
        : `${readOutlineText(element)}${REPLACEMENT_TEXT_SEPARATOR}${readOutlineText(partner)}`,
      author: readChangeAuthor(element),
    });
  }
  return items;
}

/**
 * Returns the text an item of the sidebar shows for an element.
 *
 * Entries (including those of nested comments) are left out, a line break counts as a space, and runs of whitespace
 * are collapsed to one space with the ends trimmed, so that the one line of the item reads like the rendered text.
 *
 * @param element The heading, the comment or the change mark.
 * @returns The outline text. Empty when the element shows no text.
 */
export function readOutlineText(element: Element): string {
  const parts: string[] = [];
  appendOutlineText(element, parts);
  return parts.join('').replace(WHITESPACE_RUN_PATTERN, ' ').trim();
}

/**
 * Appends the texts under a node to the parts, skipping entries and turning line breaks into spaces.
 *
 * @param node The node whose children are read.
 * @param parts The parts read so far. Modified.
 */
function appendOutlineText(node: Node, parts: string[]): void {
  for (const child of node.childNodes) {
    if (child instanceof Text) {
      parts.push(child.data);
      continue;
    }
    if (!(child instanceof Element) || ENTRY_TAG_NAMES.has(child.localName)) {
      continue;
    }
    if (child.localName === 'br') {
      parts.push(' ');
      continue;
    }
    appendOutlineText(child, parts);
  }
}

/**
 * Returns whether an element sits inside an entry.
 *
 * @param element The element to check.
 * @param root The editor root. Ancestors outside it are not looked at.
 * @returns `true` when an ancestor below the editor root is a body or a reply.
 */
function isInsideEntry(element: Element, root: Element): boolean {
  for (let current = element.parentElement; current !== null && current !== root; current = current.parentElement) {
    if (ENTRY_TAG_NAMES.has(current.localName)) {
      return true;
    }
  }
  return false;
}
