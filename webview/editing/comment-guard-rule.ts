import { CommentShiftRecord, collectCommentKeep, createCommentRemoveRule, createCommentShiftRule } from './comment-delete';
import { createCommentInputRule, prepareCommentComposition } from './comment-input';
import { DELETE_INPUT_TYPES } from './delete-rule';
import type { EditingHooks } from './editing-hooks';
import type { EditingSession } from './editing-session';
import type { DiagnosticReporter, InputDispatcher } from './input-dispatcher';

/**
 * Registers the delete and input rules around comments and the range delete guard.
 *
 * The shift rule goes at the head of the delete main queue so it shifts outward deletes to the outside neighbor before any other rule.
 * The delete-keeping-entries rule goes at the end of the fallback queue and receives only deletes that none of the block edge and
 * structural boundary rules took over. Going through the view's registration port would make the order depend on when registration happens,
 * so call this while attaching the editing session, while the delete main queue is still empty.
 *
 * @param dispatcher The input dispatcher.
 * @param hooks The editing hooks.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 */
export function registerCommentGuardRules(
  dispatcher: InputDispatcher,
  hooks: EditingHooks,
  reportDiagnostic: DiagnosticReporter,
): void {
  // Both rules share, within the same input, whether the delete was shifted.
  const record = new CommentShiftRecord();
  const shiftRule = createCommentShiftRule(record, reportDiagnostic);
  const removeRule = createCommentRemoveRule(record, reportDiagnostic);
  for (const inputType of DELETE_INPUT_TYPES) {
    dispatcher.register(inputType, shiftRule);
    dispatcher.registerFallback(inputType, removeRule);
  }

  const inputRule = createCommentInputRule(hooks, reportDiagnostic);
  dispatcher.registerFallback('insertText', inputRule);
  dispatcher.registerFallback('insertLineBreak', inputRule);

  hooks.rangeDeleteGuards.push((range, root) => collectCommentKeep(range, root, reportDiagnostic));
}

/**
 * Appends the comment-edge composition adjustment to the current editing session's composition start preprocessors.
 *
 * Preprocessors are lost together with the editing session on document replacement, so call this on every mount, including the first.
 * Call it after registering the structure and collapsible section preprocessors, so it applies after they have adjusted the selection.
 *
 * @param session The editing session. Only its preprocessor registration port is used.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 */
export function registerCommentCompositionHook(
  session: Pick<EditingSession, 'registerCompositionStartHook'>,
  reportDiagnostic: DiagnosticReporter,
): void {
  session.registerCompositionStartHook((root, keepPlaceholder) => {
    prepareCommentComposition(root, keepPlaceholder, reportDiagnostic);
  });
}
