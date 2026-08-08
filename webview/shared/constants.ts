// Shared tag-name constants. Only sets that were genuinely duplicated across
// modules live here. serialize.ts and paste-sanitize.ts keep their own
// block-tag sets on purpose — they encode different rules (serialize includes
// UL/OL/TABLE/etc.; paste-sanitize works in lowercase and adds TD/TH).

/**
 * Which way a deletion travels from the caret. Shared by editor-core's
 * beforeinput routing and the <pre> edge test in commands/code-block.
 */
export type DeleteDirection = 'backward' | 'forward';

/**
 * How much a deletion removes. The browser reports this through the
 * `deleteContent*` / `deleteWord*` / `delete{Soft,Hard}Line*` input types; the
 * comment handlers need it to reproduce the right amount themselves.
 *
 * The two line granularities are kept apart because only one of them can be
 * reproduced safely. A HARD line is the block, so clipping a deletion to the
 * caret's own text node can only ever remove less than the browser would. A SOFT
 * line is a VISUAL line, whose extent comes from layout — in a wrapped paragraph
 * the caret's text node spans several of them, so the same clipping removes
 * whole lines the user never asked for. Soft-line deletions are therefore
 * blocked rather than reproduced wherever they are unsafe.
 */
export type DeleteGranularity = 'character' | 'word' | 'soft-line' | 'hard-line';

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
 * The root-level children a bare inline run may never absorb: a block, list,
 * table, or other structural element. {@link isRootBlockBoundary} in
 * shared/dom-utils is the predicate over this set; the set itself is exported
 * because commands/inline-format builds a CSS selector from it to ask "does
 * this block hold anything the segment walk has to descend into?" in one
 * native query.
 */
export const ROOT_BLOCK_BOUNDARY_TAGS: ReadonlySet<string> = new Set([
  ...BLOCK_TAGS,
  'UL', 'OL', 'TABLE', 'HR', 'FIGURE',
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

/**
 * Class applied to every anchor cell inside the active multi-cell table
 * selection (plain click + Shift+click). Pure UI state: it changes no layout,
 * lives on the live DOM only, and is stripped on serialize. The same literal
 * is referenced by the `td.ahve-tc-selected` rule in styles/table.css.
 */
export const CELL_SELECTED_CLASS = 'ahve-tc-selected';

/**
 * Legacy single-cell merge-anchor class. Older builds applied it on
 * Shift+click and never stripped it on serialize, so saved files may still
 * contain the token; the serializer keeps removing it even though nothing
 * applies it anymore.
 */
export const LEGACY_MERGE_ANCHOR_CLASS = 'ahve-tc-merge-anchor';

/**
 * Marks the extra trailing <br> that keeps Chromium's caret on the new line
 * after Enter at the end of a bare blockquote. The serializer removes it, and
 * the input handler drops it as soon as real content is typed on that line.
 */
export const QUOTE_PLACEHOLDER_ATTR = 'data-ahve-quote-placeholder';
