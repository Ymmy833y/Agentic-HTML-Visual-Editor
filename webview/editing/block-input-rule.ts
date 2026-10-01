import type { BlockCommandPorts } from './block-command';
import type { BlockRewriteProgress } from './block-format';
import type { MergeDirection } from './block-merge';
import { exitCodeBlock, findExitableCodeBlock } from './code-block-exit';
import { findEmptyCodeBlock, insertTextIntoCodeBlock } from './code-block-text';
import { findAdjacentDiagram, removeAdjacentDiagram } from './diagram-edit';
import type { EditingSession } from './editing-session';
import { findAdjacentRule, removeHorizontalRule } from './horizontal-rule';
import type { InputRule, InputRuleResult } from './input-dispatcher';

/**
 * The deletion input types that get a rule, and the direction of each.
 *
 * Line-wise deletion is not listed. The extent of a line is decided by how the display wraps and cannot be
 * reproduced, so it is left doing nothing at the edge of a block.
 */
export const BLOCK_DELETE_INPUT_TYPES: Readonly<Record<string, MergeDirection>> = {
  deleteContentBackward: 'backward',
  deleteContentForward: 'forward',
  deleteWordBackward: 'backward',
  deleteWordForward: 'forward',
};

/**
 * Registers the paragraph-insertion, deletion, and text-input rules with the input dispatcher.
 *
 * The editing session is replaced whenever the document is replaced, so this is called again each time one is
 * rebuilt.
 *
 * @param session The editing session.
 * @param ports The block command ports.
 */
export function registerBlockRules(session: EditingSession, ports: BlockCommandPorts): void {
  const exitRule: InputRule = ({ root, range }) => {
    const pre = findExitableCodeBlock(root, range);
    if (pre === undefined) {
      // Without a trailing blank line the rule does not take over, leaving the built-in Enter to insert a newline.
      return 'pass';
    }
    return runRewrite(ports, 'Could not leave the code block', (progress) => {
      exitCodeBlock(pre, range, progress);
    });
  };
  session.registerRule('insertParagraph', exitRule);

  for (const [inputType, direction] of Object.entries(BLOCK_DELETE_INPUT_TYPES)) {
    session.registerRule(inputType, ({ root, range }) => {
      const rule = findAdjacentRule(root, range, direction);
      if (rule !== undefined) {
        return runRewrite(ports, 'Could not remove the horizontal rule', (progress) => {
          removeHorizontalRule(rule, progress);
        });
      }
      // A diagram takes no caret either, so the delete next to it removes it the same way.
      const diagram = findAdjacentDiagram(root, range, direction);
      if (diagram !== undefined) {
        return runRewrite(ports, 'Could not remove the diagram', (progress) => {
          removeAdjacentDiagram(diagram, progress);
        });
      }
      return 'pass';
    });
  }

  const textRule: InputRule = ({ event, root, range }) => {
    const text = event.data ?? '';
    const pre = text.length === 0 ? undefined : findEmptyCodeBlock(root, range);
    if (pre === undefined) {
      // A code block with contents, and anywhere else, is left to the browser's default insertion.
      return 'pass';
    }
    return runRewrite(ports, 'Could not insert text into the code block', (progress) => {
      insertTextIntoCodeBlock(pre, range, text, progress);
    });
  };
  session.registerRule('insertText', textRule);
}

/**
 * Runs a rewrite the rule took over and turns it into an input rule result.
 *
 * Letting an exception escape would make the input dispatcher abort the edit attempt, leaving the tree changed
 * without reaching change tracking. Even when the tree was not changed, the input is not dropped back to the
 * default handling but closed as taken over.
 *
 * @param ports The block command ports.
 * @param failure The opening of the single diagnostic line to leave behind.
 * @param rewrite The steps that rewrite the tree.
 * @returns The input rule result.
 */
function runRewrite(
  ports: BlockCommandPorts,
  failure: string,
  rewrite: (progress: BlockRewriteProgress) => void,
): InputRuleResult {
  const progress: BlockRewriteProgress = { changed: false };
  try {
    rewrite(progress);
  } catch (error) {
    ports.reportDiagnostic(`${failure}: ${String(error)}`);
  }
  return progress.changed ? 'edited' : 'consumed';
}
