/**
 * Element names of comment annotations.
 *
 * Spelled only here, because reading and creating in the view, and the later search, paste and writing guide,
 * all use the same spelling.
 * Read-only because, if it were rewritten at run time, the reading side and the creating side would point at different elements.
 */
export const COMMENT_TAG_NAME = {
  comment: 'comment',
  body: 'comment-body',
  reply: 'comment-reply',
} as const;

/**
 * Order of the entries that follow the annotated text.
 *
 * The children of a comment put the annotated text first, followed by the body and then the replies; replies are appended oldest first.
 * An opened document with a different order is not fixed, so that merely opening the writer's HTML does not rewrite it.
 */
export const COMMENT_ENTRY_ORDER = [COMMENT_TAG_NAME.body, COMMENT_TAG_NAME.reply] as const;

/** Maximum number of bodies one comment can have. The number of replies is unlimited. */
export const COMMENT_BODY_MAX_COUNT = 1;

/**
 * Format of comment ids.
 *
 * Holds only values; no function for generating or checking the format lives here. Generation uses randomness and is a side effect,
 * and only the view checks the format.
 * Only ids the extension creates must follow the format; it is not applied to ids in an opened document.
 */
export const COMMENT_ID_FORMAT = {
  prefix: 'c-',
  length: 8,
  characters: 'abcdefghijklmnopqrstuvwxyz0123456789',
} as const;

/** Author labels. Fixed to two values: a human and an agent. */
export const COMMENT_AUTHOR = {
  human: 'human',
  ai: 'ai',
} as const;

/** An author label. Takes no value other than the two. */
export type CommentAuthor = (typeof COMMENT_AUTHOR)[keyof typeof COMMENT_AUTHOR];

/**
 * Attribute names of comments and entries.
 *
 * `resolved` marks the resolved state by its presence, not by its value. The format of the `updated` value is not defined here.
 */
export const COMMENT_ATTRIBUTE = {
  id: 'id',
  resolved: 'data-resolved',
  author: 'data-author',
  updated: 'data-updated',
  editable: 'contenteditable',
} as const;

/** The `contenteditable` value of entries. Entries get the non-editable value so they are not edited as document body text. */
export const COMMENT_ENTRY_EDITABLE_VALUE = 'false';
