import type { BlockCommandPorts } from './block-command';
import type { BlockRewriteProgress } from './block-format';
import { findTitleAtRange, moveCaretIntoBody } from './details-enter';
import {
  collapseCrossingSelection,
  collectProtectedTitles,
  insertTextAfterDeletion,
  isCrossingRange,
} from './details-guard';
import { handleDetailsClick, handleDetailsPointerDown } from './details-marker';
import { createDragExtender, extendSelectionByKey } from './details-selection';
import type { EditingSession } from './editing-session';
import type { InputRule, InputRuleResult } from './input-dispatcher';

/**
 * Registers the collapsible-section rules, along with the range delete guard and the composition
 * start hook.
 *
 * The editing session is replaced on a tree swap, so this must be called again each time one is
 * recreated.
 *
 * @param session The editing session.
 * @param ports The block command ports. Diagnostics go through this too.
 */
export function registerDetailsRules(session: EditingSession, ports: BlockCommandPorts): void {
  const enterRule: InputRule = ({ root, range }) => {
    const title = findTitleAtRange(root, range);
    if (title === undefined) {
      // A paragraph insertion outside a title is passed on to later rules and the built-in replacement.
      return 'pass';
    }

    return runRewrite(ports, 'Failed to handle Enter inside a title', (progress) => {
      if (!range.collapsed) {
        // The range delete guard applies, so deleting it does not remove the title whole as an element.
        session.deleteRange(range);
        progress.changed = true;
      }
      moveCaretIntoBody(title, range, progress);
    });
  };
  session.registerRule('insertParagraph', enterRule);

  const textRule: InputRule = ({ event, root, range }) => {
    const text = event.data ?? '';
    if (text.length === 0 || !isCrossingRange(range, root, ports.reportDiagnostic)) {
      // Character input into a non-crossing range is left to the browser's default replacement.
      return 'pass';
    }

    return runRewrite(ports, 'Failed to handle character input into a crossing range', (progress) => {
      session.deleteRange(range);
      progress.changed = true;
      insertTextAfterDeletion(range, text, progress);
    });
  };
  session.registerRule('insertText', textRule);

  session.registerRangeDeleteGuard(
    (range, root) => collectProtectedTitles(range, root, ports.reportDiagnostic),
  );
  session.registerCompositionStartHook(
    (root) => collapseCrossingSelection(root, ports.reportDiagnostic),
  );
}

/**
 * Attaches pointer and key receivers to the editor root.
 *
 * The editor root stays the same element even across a tree swap, so this is called once, on a
 * successful mount. The marker press suppression is attached before selection extension, so the
 * suppression takes effect first.
 *
 * @param ports The block command ports.
 * @param root The editor root.
 */
export function attachDetailsReceivers(ports: BlockCommandPorts, root: HTMLElement): void {
  const reportDiagnostic = (detail: string): void => ports.reportDiagnostic(detail);
  const extender = createDragExtender(root, reportDiagnostic);

  root.addEventListener('mousedown', (event) => {
    handleDetailsPointerDown(root, event, reportDiagnostic);
  });
  root.addEventListener('mousedown', (event) => extender.handlePointerDown(event));
  root.addEventListener('mousemove', (event) => extender.handlePointerMove(event));
  root.addEventListener('mouseup', () => extender.handlePointerUp());
  root.addEventListener('dragstart', (event) => extender.handleDragStart(event));
  root.addEventListener('click', (event) => handleDetailsClick(ports, root, event));
  root.addEventListener('keydown', (event) => {
    extendSelectionByKey(root, event, reportDiagnostic);
  });
}

/**
 * Runs a rewrite that a rule has taken on, and turns it into an input rule result.
 *
 * Letting an exception escape would have the input dispatcher abort the edit attempt, and the changed
 * tree would never reach the change tracker. Even when the tree was not changed, this does not fall
 * through to the default replacement and insertion.
 *
 * @param ports The block command ports.
 * @param failure The lead-in for the one-line diagnostic this leaves.
 * @param rewrite The procedure that rewrites the tree.
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
