import { COMMENT_ATTRIBUTE, COMMENT_AUTHOR } from '../../common/index';
import type { Localizer } from '../../common/index';
import { readCommentEntries } from './comment-read';

// HTML whitespace at both ends of an entry. Line breaks and indentation the writer put between tags are not part of
// the entry, so the popup shows the entry without them.
const HTML_WHITESPACE_EDGES_PATTERN = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu;

// Shape of a date and time with a time zone offset. Date.parse reads a date-only value as midnight UTC, and converting
// it to local time would make the date look shifted, so values that do not match this shape are shown as they are
// without going through the format.
const ZONED_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * Returns whether an entry is an AI entry.
 *
 * Only an author exactly equal to `ai` counts as the AI side; other values and a missing author count as the human
 * side. Deciding the human side by matching `human` would count the names of future multiple human users as AI.
 *
 * @param entry Entry.
 * @returns `true` for an AI entry. `false` for values that differ in case or have surrounding whitespace.
 */
export function isAiEntry(entry: Element): boolean {
  return entry.getAttribute(COMMENT_ATTRIBUTE.author) === COMMENT_AUTHOR.ai;
}

/**
 * Returns the display name of the author of an entry.
 *
 * The two labels are shown with catalog messages; other values are shown as they are, as the names of future
 * multiple human users.
 *
 * @param entry Entry.
 * @param localizer Localizer.
 * @returns Display name. `undefined` when the author is missing or empty.
 */
export function readEntryAuthorName(entry: Element, localizer: Localizer): string | undefined {
  const author = entry.getAttribute(COMMENT_ATTRIBUTE.author);
  if (author === null || author === '') {
    return undefined;
  }
  if (author === COMMENT_AUTHOR.ai) {
    return localizer.getMessage('commentThread.authorAi');
  }
  if (author === COMMENT_AUTHOR.human) {
    return localizer.getMessage('commentThread.authorHuman');
  }
  return author;
}

/**
 * Returns the string that shows the update time of an entry.
 *
 * Values that cannot be read as a date and time are shown as they are, so that the reader does not hide information
 * even when a value written by an agent is broken.
 *
 * @param entry Entry.
 * @param format Format that turns a date and time into local notation.
 * @returns String to show. `undefined` when the update time is missing or empty.
 */
export function readEntryUpdated(entry: Element, format: (date: Date) => string): string | undefined {
  const updated = entry.getAttribute(COMMENT_ATTRIBUTE.updated);
  if (updated === null || updated === '') {
    return undefined;
  }
  const time = ZONED_DATE_TIME_PATTERN.test(updated) ? Date.parse(updated) : Number.NaN;
  return Number.isFinite(time) ? format(new Date(time)) : updated;
}

/**
 * Returns whether a comment is resolved.
 *
 * The convention is that the resolved state is expressed by the presence of the attribute, so the value (including
 * `false`) is not looked at.
 *
 * @param comment Comment.
 * @returns `true` when `data-resolved` is present.
 */
export function isCommentResolved(comment: Element): boolean {
  return comment.hasAttribute(COMMENT_ATTRIBUTE.resolved);
}

/**
 * Returns whether a comment contains an AI entry.
 *
 * Entries written inside an entry do not belong to this thread, so they are not counted.
 *
 * @param comment Comment.
 * @returns `true` when any of the direct entries is an AI entry.
 */
export function hasAiEntry(comment: Element): boolean {
  return readCommentEntries(comment).some(isAiEntry);
}

/**
 * Returns the string an entry shows.
 *
 * Elements inside the entry are not interpreted; only the characters are joined. Line breaks inside are separators
 * the writer intended, so they are kept.
 *
 * @param entry Entry.
 * @returns String without the HTML whitespace at both ends.
 */
export function readEntryText(entry: Element): string {
  return (entry.textContent ?? '').replace(HTML_WHITESPACE_EDGES_PATTERN, '');
}
