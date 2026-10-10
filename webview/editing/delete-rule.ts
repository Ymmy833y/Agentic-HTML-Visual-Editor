import { findBlock } from './block';
import { findMergeCandidate, mergeBlocks } from './block-merge';
import { isAtBlockEnd, isAtBlockStart, placeCaret } from './caret';
import type { EditingHooks } from './editing-hooks';
import type { InputRule } from './input-dispatcher';
import { prepareTargetBlock } from './target-block';

/**
 * The granularity by which the selection is extended to find the deletion extent.
 *
 * Spelled the same as the `Selection.modify` granularity. The range is found with the same extension as the browser delete, so no mapping is needed.
 */
export type DeleteGranularity = 'character' | 'word' | 'lineboundary' | 'paragraphboundary';

/** Treatment for each deletion input type. */
export interface DeleteKind {
  /** Whether deletion is backward, which determines which edge of the block is inspected. */
  readonly backward: boolean;
  /** Whether deletion covers a line. Visual layout determines line ranges, so they cannot be reproduced here. */
  readonly line: boolean;
  /** The granularity by which the selection is extended to find the deletion extent. */
  readonly granularity: DeleteGranularity;
}

// Spell each type only here. Splitting direction and line granularity into separate sets would let omissions evade
// the type system and silently alter behavior, such as checking the end of a block for backward deletion.
const DELETE_KINDS: ReadonlyMap<string, DeleteKind> = new Map<string, DeleteKind>([
  ['deleteContentBackward', { backward: true, line: false, granularity: 'character' }],
  ['deleteContentForward', { backward: false, line: false, granularity: 'character' }],
  ['deleteWordBackward', { backward: true, line: false, granularity: 'word' }],
  ['deleteWordForward', { backward: false, line: false, granularity: 'word' }],
  ['deleteSoftLineBackward', { backward: true, line: true, granularity: 'lineboundary' }],
  ['deleteSoftLineForward', { backward: false, line: true, granularity: 'lineboundary' }],
  ['deleteHardLineBackward', { backward: true, line: true, granularity: 'paragraphboundary' }],
  ['deleteHardLineForward', { backward: false, line: true, granularity: 'paragraphboundary' }],
]);

/** Input types registered for deletion rules: backward and forward deletion by character, word, or line. */
export const DELETE_INPUT_TYPES: readonly string[] = [...DELETE_KINDS.keys()];

/**
 * Reads the delete kind from an input type.
 *
 * Other features with delete rules read the same table. Keeping separate spellings per kind would let direction or granularity mismatches slip past the types.
 *
 * @param inputType The input type.
 * @returns The delete kind, or `undefined` if it is not one of the eight delete input types.
 */
export function readDeleteKind(inputType: string): DeleteKind | undefined {
  return DELETE_KINDS.get(inputType);
}

/**
 * Creates a rule that handles deletion of selected ranges and at block edges.
 *
 * The browser's default merge inserts formatting `span` elements and deletes body content across structural
 * boundaries. Selected ranges are deleted by the same rule used for Enter and paste. At an edge, this rule merges
 * only with a mergeable neighbor and otherwise does nothing. Positions away from an edge pass to the browser.
 *
 * Only a deletion with a range selection goes through the guard; deletion from the caret is unchanged.
 *
 * @param root The editor root.
 * @param hooks The editing hooks. Passed through to the range deletion.
 * @returns A rule registered for deletion input types.
 */
export function createDeleteRule(root: Element, hooks?: EditingHooks): InputRule {
  return ({ event, range }) => {
    const kind = readDeleteKind(event.inputType);
    if (kind === undefined) {
      // Registered types derive from the same map, so this is unreachable. Pass unknown deletion directions through.
      return 'pass';
    }

    if (!range.collapsed) {
      // Default deletion would differ from Enter and paste over the same range because default merging inserts a
      // formatting `span` and does not restore deleted line breaks.
      const target = prepareTargetBlock(root, range, hooks);
      return target === undefined ? 'consumed' : 'edited';
    }

    const block = findBlock(range.startContainer, root);
    if (block === undefined) {
      return 'pass';
    }

    const atEdge = kind.backward ? isAtBlockStart(range, block) : isAtBlockEnd(range, block);
    if (!atEdge) {
      return 'pass';
    }

    // Visual layout determines line ranges and cannot be reproduced here. Line deletion at an edge does nothing.
    if (kind.line) {
      return 'consumed';
    }

    const candidate = findMergeCandidate(block, kind.backward ? 'backward' : 'forward');
    if (candidate === undefined) {
      return 'consumed';
    }

    const point = kind.backward ? mergeBlocks(candidate, block) : mergeBlocks(block, candidate);
    if (point === undefined) {
      return 'consumed';
    }

    placeCaret(point.container, point.offset);
    return 'edited';
  };
}
