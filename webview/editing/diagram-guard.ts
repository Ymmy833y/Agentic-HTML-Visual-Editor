import { findContainingDiagramSource } from '../diagram/diagram-source';
import { DELETE_INPUT_TYPES } from './delete-rule';
import type { InputDispatcher, InputRule } from './input-dispatcher';

/**
 * The input types the guard watches: everything that would write into the tree at the selection.
 *
 * Composition is not listed. Its text cannot be canceled, and the caret never rests in a diagram to start one.
 */
export const DIAGRAM_GUARD_INPUT_TYPES: readonly string[] = [
  'insertText',
  'insertLineBreak',
  'insertParagraph',
  'insertFromPaste',
  'insertFromDrop',
  'insertReplacementText',
  ...DELETE_INPUT_TYPES,
];

/**
 * Creates the rule that takes, and drops, input whose selection has an end inside a diagram source block.
 *
 * The source of a diagram is invisible and edited only in its dialog. The browser keeps the caret out of invisible
 * text, and this rule makes sure that input still cannot write into a source when a selection end lands there anyway.
 * A range that contains a whole diagram has both ends outside it and passes.
 *
 * @returns The rule.
 */
export function createDiagramGuardRule(): InputRule {
  return ({ root, range }) => {
    const inside = findContainingDiagramSource(range.startContainer, root) !== undefined
      || findContainingDiagramSource(range.endContainer, root) !== undefined;
    return inside ? 'consumed' : 'pass';
  };
}

/**
 * Registers the guard at the head of the main queue of every watched input type.
 *
 * It has to come before the built-in rules, which would otherwise insert a line break into the source.
 *
 * @param dispatcher The input dispatcher. Nothing may be registered on it yet.
 */
export function registerDiagramGuard(dispatcher: InputDispatcher): void {
  const rule = createDiagramGuardRule();
  for (const inputType of DIAGRAM_GUARD_INPUT_TYPES) {
    dispatcher.register(inputType, rule);
  }
}
