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
  'DETAILS', 'SUMMARY',
]);

/**
 * Uppercase tag names of the inline formats the editor can toggle. Shared by
 * the inline-format command and editor-core (Enter format inheritance).
 */
export const INLINE_FORMAT_TAGS = new Set(['STRONG', 'EM', 'CODE', 'S']);

/**
 * Transient marker set on the <comment> the collapsed caret has stepped just
 * outside of — on either side (before via ArrowLeft, after via ArrowRight). The
 * inside-edge and just-outside positions render at the same spot, and the
 * browser paints the boundary caret with the comment's own caret-color (caret
 * affinity), so a pure-CSS rule cannot flip it. This attribute lets CSS reset
 * the comment's caret-color to the default while the caret sits outside,
 * signalling that the next character lands beyond the comment. Pure UI state: it
 * changes no layout, lives on the live DOM only, and is stripped on serialize.
 * The same literal is referenced by the `comment[data-ahve-caret-outside]` rule
 * in styles/default.css.
 */
export const CARET_OUTSIDE_ATTR = 'data-ahve-caret-outside';

/**
 * Transient marker set on a <comment> whose leading edge the caret has stepped
 * into via ArrowRight. The browser normalises the inside-start caret to the
 * outside (nothing separates them on the left), so the caret is physically in
 * the comment's parent and painted with the parent's caret-color. This marker
 * lets CSS tint the PARENT's caret with the author colour, signalling that the
 * next character lands inside the comment. Like CARET_OUTSIDE_ATTR it is pure UI
 * state: no layout change, live DOM only, stripped on serialize. Referenced by
 * the `:has(> comment[data-ahve-caret-inside])` rule in styles/default.css.
 */
export const CARET_INSIDE_ATTR = 'data-ahve-caret-inside';
