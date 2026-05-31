// Shared tag-name constants. Only sets that were genuinely duplicated across
// modules live here. serialize.ts and paste-sanitize.ts keep their own
// block-tag sets on purpose — they encode different rules (serialize includes
// UL/OL/TABLE/etc.; paste-sanitize works in lowercase and adds TD/TH).

/**
 * Uppercase tag names treated as block-level containers when walking up the
 * tree to find the enclosing block. Single source of truth shared by the
 * editing commands and editor-core.
 */
export const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'DIV', 'LI',
]);

/**
 * Uppercase tag names of the inline formats the editor can toggle. Shared by
 * the inline-format command and editor-core (Enter format inheritance).
 */
export const INLINE_FORMAT_TAGS = new Set(['STRONG', 'EM', 'CODE', 'S']);
