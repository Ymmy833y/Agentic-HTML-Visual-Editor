import type { BlockCommandPorts } from './block-command';
import type { BlockRewriteProgress } from './block-format';
import { applyBoundaryDelete, readBoundaryDelete } from './boundary-delete';
import { collapseStructureCrossingSelection, insertLineBreak, insertTypedText, needsRangeReplacement } from './crossing-input';
import { DELETE_INPUT_TYPES, readDeleteKind } from './delete-rule';
import { collectClosedBodyKeep } from './details-body-guard';
import type { EditingHooks } from './editing-hooks';
import type { InputDispatcher, InputRule, InputRuleResult } from './input-dispatcher';
import { collectTableKeep } from './table-range-guard';
import { prepareTargetBlock } from './target-block';

/**
 * Registers the structure boundary rules, the range delete guards and the composition start hooks.
 *
 * The rules go into the fallback queue. The horizontal rule and list edge rules also act at a structure boundary, so these rules only
 * receive input that no rule in the main queue took over. Calling this before the built-in delete replacement tries them first regardless of when they are registered.
 * The rules use the edit attempt opened by the input dispatcher and never open one themselves.
 *
 * @param dispatcher The input dispatcher.
 * @param hooks The editing hooks.
 * @param ports The block command ports. Diagnostics also go through them.
 */
export function registerBoundaryRules(
  dispatcher: InputDispatcher,
  hooks: EditingHooks,
  ports: BlockCommandPorts,
): void {
  const deleteRule: InputRule = ({ event, root, range }) => {
    const kind = readDeleteKind(event.inputType);
    if (kind === undefined) {
      return 'pass';
    }
    return runRule(ports, 'Could not handle the delete at a structure boundary', (progress) => {
      const step = readBoundaryDelete(root, range, kind);
      return step === undefined ? 'pass' : applyBoundaryDelete(step, range, ports, progress);
    });
  };
  for (const inputType of DELETE_INPUT_TYPES) {
    dispatcher.registerFallback(inputType, deleteRule);
  }

  const inputRule: InputRule = ({ event, root, range }) => {
    const text = event.data ?? '';
    if ((event.inputType === 'insertText' && text.length === 0) || !needsRangeReplacement(range, root)) {
      return 'pass';
    }
    return runRule(ports, 'Could not handle input over a structure-crossing range', (progress) => {
      // The range delete changes the tree even if it throws partway. Set the progress before calling so the view and the saved content do not diverge.
      progress.changed = true;
      const target = prepareTargetBlock(root, range, hooks);
      if (target === undefined) {
        // Where a target block cannot be ensured, neither delete the range nor hand the input to the default insertion.
        progress.changed = false;
        return 'consumed';
      }
      if (event.inputType === 'insertText') {
        insertTypedText(range, root, text, progress);
      } else {
        insertLineBreak(range, root, progress);
      }
      return 'edited';
    });
  };
  dispatcher.registerFallback('insertText', inputRule);
  dispatcher.registerFallback('insertLineBreak', inputRule);

  hooks.rangeDeleteGuards.push(
    (range, root) => collectTableKeep(range, root, ports.reportDiagnostic),
    (range, root) => collectClosedBodyKeep(range, root, ports.reportDiagnostic),
  );
  hooks.compositionStartHooks.push((root) => collapseStructureCrossingSelection(root, ports.reportDiagnostic));
}

/**
 * Calls the rule body and converts exceptions into an input rule result instead of throwing.
 *
 * Letting an exception escape makes the input dispatcher abort the edit attempt, so the changed tree never reaches the change tracker. Even if the tree
 * is unchanged, the input does not fall through to the default delete and insertion, which would cross the boundary being protected.
 *
 * @param ports The block command ports.
 * @param failure The opening of the diagnostic to record.
 * @param body The rule body.
 * @returns The input rule result.
 */
function runRule(
  ports: BlockCommandPorts,
  failure: string,
  body: (progress: BlockRewriteProgress) => InputRuleResult,
): InputRuleResult {
  const progress: BlockRewriteProgress = { changed: false };
  try {
    return body(progress);
  } catch (error) {
    ports.reportDiagnostic(`${failure}: ${String(error)}`);
    return progress.changed ? 'edited' : 'consumed';
  }
}
