import { COMMENT_ATTRIBUTE, COMMENT_AUTHOR } from './comment-annotation';

/**
 * Kinds of change marks, which are also the element names of the inline marks.
 *
 * An agent wraps what it added in `ins` and what it removed in `del`. Spelled only here, because reading and resolving
 * in the view, the sidebar list and the writing guide all use the same spelling.
 */
export const CHANGE_KIND = {
  insertion: 'ins',
  deletion: 'del',
} as const;

/** A change kind. Takes no value other than the two. */
export type ChangeKind = (typeof CHANGE_KIND)[keyof typeof CHANGE_KIND];

/**
 * Attribute names of change marks.
 *
 * `kind` marks an element that `ins` and `del` cannot wrap, such as a paragraph, a list item or a table row, and takes a
 * change kind as its value. The author and the update time share the attribute names of comment entries, so an agent
 * writes both the same way and the view reads both with the same rules.
 */
export const CHANGE_ATTRIBUTE = {
  kind: 'data-change',
  author: COMMENT_ATTRIBUTE.author,
  updated: COMMENT_ATTRIBUTE.updated,
} as const;

/** Author labels of change marks. The same two values as comment entries. */
export const CHANGE_AUTHOR = COMMENT_AUTHOR;
