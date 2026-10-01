import { hasBlockChild } from './block';
import { isItemLineParagraph } from './list-structure';

/**
 * Identifiers for the block kinds.
 *
 * List items, cells, and summary are not included. Replacing their tag names would break the structure of the
 * list or the table itself.
 */
export const BLOCK_KIND = {
  paragraph: 'paragraph',
  heading1: 'heading1',
  heading2: 'heading2',
  heading3: 'heading3',
  heading4: 'heading4',
  heading5: 'heading5',
  heading6: 'heading6',
  quote: 'quote',
  codeBlock: 'codeBlock',
  div: 'div',
} as const;

/** A block kind. Values absent from the table above cannot be accepted. */
export type BlockKind = (typeof BLOCK_KIND)[keyof typeof BLOCK_KIND];

/**
 * The one-to-one correspondence between a block kind and the tag name of the element to create.
 *
 * `hr` and `code` are excluded. A horizontal rule can only be inserted and cannot be chosen as a kind, and
 * `code` is the container for the contents of a code block.
 */
export const BLOCK_KIND_TAG_NAME: Readonly<Record<BlockKind, string>> = {
  paragraph: 'p',
  heading1: 'h1',
  heading2: 'h2',
  heading3: 'h3',
  heading4: 'h4',
  heading5: 'h5',
  heading6: 'h6',
  quote: 'blockquote',
  codeBlock: 'pre',
  div: 'div',
};

// Reverse lookup from tag name to block kind. `Object.entries` widens the key type to `string`, so the map is
// built by looking each tag name up from the list of block kinds instead.
const BLOCK_KIND_BY_TAG_NAME: ReadonlyMap<string, BlockKind> = new Map(
  Object.values(BLOCK_KIND).map((kind): [string, BlockKind] => [BLOCK_KIND_TAG_NAME[kind], kind]),
);

/**
 * Holds, stage by stage, whether the tree has been rewritten.
 *
 * Even when an exception occurs partway through, whatever was rewritten up to that point can still be closed as
 * a change. Aborting would leave the display and the saved content out of step.
 */
export interface BlockRewriteProgress {
  changed: boolean;
}

/**
 * Returns the current kind of the target block.
 *
 * Ancestors are not inspected. A paragraph inside a quote is a paragraph; the kind is decided solely by the tag
 * name of the target itself.
 *
 * @param target The target block, or `undefined` when there is no target.
 * @returns The block kind, or `undefined` when the tag name is not one of the kinds.
 */
export function readBlockKind(target: Element | undefined): BlockKind | undefined {
  if (target === undefined) {
    return undefined;
  }
  return BLOCK_KIND_BY_TAG_NAME.get(target.localName);
}

/**
 * Determines whether the target is a convertible block.
 *
 * An element with a block child is excluded: replacing it would change the kind while leaving only the nested
 * structure behind. A `pre` whose sole child is a single `code` is convertible, because `code` is not a block.
 *
 * A paragraph that is the item line of a list item is excluded just like `li`. Turning it into a heading would
 * leave the item without a line, so neither a backward delete at its start nor Enter at its end would act on
 * the edge of the item. The block for markdown-style autoformat and the displayed block kind follow this
 * decision too.
 *
 * @param target The target block.
 * @returns `true` when the target is a convertible block.
 */
export function isConvertibleBlock(target: Element): boolean {
  return BLOCK_KIND_BY_TAG_NAME.has(target.localName)
    && !hasBlockChild(target)
    && !isItemLineParagraph(target);
}
