import type { BodyOutput } from '../document/serialization-state';
import { insertBlock } from './block';
import type { BlockInsertPosition } from './block';
import type { BlockCommandPorts } from './block-command';
import { prepareSplit } from './block-split';
import { registerBoundaryRules } from './boundary-input-rule';
import { readSelectionRange } from './caret';
import { ChangeTracker } from './change-tracker';
import type { EditDetectedListener, EditKind, OutputReceiver } from './change-tracker';
import { registerCommentGuardRules } from './comment-guard-rule';
import { CompositionGuard } from './composition-guard';
import { DELETE_INPUT_TYPES, createDeleteRule } from './delete-rule';
import { registerDiagramGuard } from './diagram-guard';
import type {
  CompositionStartHook,
  EditingHooks,
  RangeDeleteGuard,
  SplitPreparation,
  SplitPreprocessor,
} from './editing-hooks';
import { createEnterRule } from './enter-rule';
import { InputDispatcher } from './input-dispatcher';
import type { DiagnosticReporter, InputRule } from './input-dispatcher';
import { createMaterializationRule } from './materialization';
import { createPasteRule, insertPastedText } from './paste-rule';
import { ensureTargetBlock, prepareTargetBlock } from './target-block';
import type { EditEndpointSelections, EditTransactionLifecycle } from '../history/edit-transaction-controller';

/** Editing core for one editor root, with registration points for rules and an output receiver. */
export class EditingSession {
  /**
   * @param root The editor root.
   * @param dispatcher The input dispatcher.
   * @param tracker The change tracker.
   * @param composition The composition guard.
   * @param hooks The editing hooks.
   * @param detach A function that removes the attached listeners.
   */
  constructor(
    private readonly root: HTMLElement,
    private readonly dispatcher: InputDispatcher,
    private readonly tracker: ChangeTracker,
    private readonly composition: CompositionGuard,
    private readonly transactions: EditTransactionLifecycle,
    private readonly hooks: EditingHooks,
    private readonly detach: () => void,
  ) {}

  /**
   * Whether an IME composition is in progress.
   *
   * It returns the composition guard's value as is, without caching it. The toolbar decides whether
   * to run an operation from the value at the moment of the press, and a cached value would hold
   * the operation back even after the composition has ended.
   */
  get isComposing(): boolean {
    return this.composition.isComposing;
  }

  /**
   * Appends a rule to a queue after the built-in rules.
   *
   * @param inputType The target input type.
   * @param rule The rule to add.
   */
  registerRule(inputType: string, rule: InputRule): void {
    this.dispatcher.register(inputType, rule);
  }

  /**
   * Registers the guard a range delete calls.
   *
   * A later registration does not overwrite an earlier one but is appended to the list. The range delete calls every guard in registration order.
   *
   * @param guard The guard to register.
   */
  registerRangeDeleteGuard(guard: RangeDeleteGuard): void {
    this.hooks.rangeDeleteGuards.push(guard);
  }

  /**
   * Registers the hook a composition start calls.
   *
   * A later registration does not overwrite an earlier one but is appended to the list. A composition start calls every hook in registration order.
   *
   * @param hook The hook to register.
   */
  registerCompositionStartHook(hook: CompositionStartHook): void {
    this.hooks.compositionStartHooks.push(hook);
  }

  /**
   * Registers a preprocessor called before a split.
   *
   * A later registration does not overwrite an earlier one; it is appended to the list. A split calls every preprocessor in
   * registration order. They are lost together with the editing session on document replacement, so the registering side
   * registers again on every mount.
   *
   * @param preprocessor The preprocessor to register.
   */
  registerSplitPreprocessor(preprocessor: SplitPreprocessor): void {
    this.hooks.splitPreprocessors.push(preprocessor);
  }

  /**
   * Calls the registered preprocessors and either moves the range to where the split happens or reports that a
   * preprocessor took over.
   *
   * Rules registered outside the editing core (list items, cells) call this before splitting. Unless they apply the same
   * preprocessors as the built-in Enter and paste, whether a comment breaks would differ from rule to rule.
   *
   * @param block The block to split.
   * @param range A collapsed range. Moved to the position of the split or the takeover.
   * @returns For a split, the boundary where checks and the split happen; for a takeover, whether the tree changed and the boundary to continue from.
   */
  prepareSplit(block: Element, range: Range): SplitPreparation {
    return prepareSplit(block, range, this.hooks.splitPreprocessors);
  }

  /**
   * Replaces the output receiver.
   *
   * @param receiver The new output receiver, or `undefined` to remove it.
   */
  setOutputReceiver(receiver: OutputReceiver | undefined): void {
    this.tracker.setReceiver(receiver);
  }

  /**
   * Adds a listener that receives the edit trigger.
   *
   * @param listener The listener to add.
   */
  addEditListener(listener: EditDetectedListener): void {
    this.tracker.addEditListener(listener);
  }

  /** Emits output immediately when a change is pending instead of waiting for the deadline. */
  flush(): void {
    this.tracker.flush();
  }

  /**
   * Drops the change tracker's pending debounce.
   *
   * Only that single pending wait is dropped; debounced emission itself keeps working.
   */
  discardPendingOutput(): void {
    this.tracker.discardPending();
  }

  /**
   * Passes a notification from a tree-changing command to the change tracker.
   *
   * @param kind What caused the edit.
   */
  notifyChange(kind: EditKind): void {
    this.tracker.notify(kind);
  }

  /**
   * Runs a tree-changing command as one edit attempt spanning the before and after states.
   *
   * @param kind The edit kind that identifies the command.
   * @param command A command that returns true only when it makes a change.
   * @param endpoints The selections to record at the endpoints of the standalone edit. If omitted, the selections
   *   captured at the endpoints are recorded.
   * @returns Whether the command made a change.
   */
  runCommandEdit(kind: EditKind, command: () => boolean, endpoints?: EditEndpointSelections): boolean {
    if (!this.transactions.beginEdit(kind, endpoints)) {
      return false;
    }

    try {
      const changed = command();
      if (!changed) {
        this.transactions.abortEdit();
        return false;
      }
      this.tracker.notify(kind);
      this.transactions.completeEdit();
      return true;
    } catch (error) {
      this.transactions.abortEdit();
      throw error;
    }
  }

  /**
   * Ensures a target block from the current selection.
   *
   * @returns The target element, or `undefined` when one cannot be ensured.
   */
  ensureTargetBlock(): Element | undefined {
    return ensureTargetBlock(this.root, readSelectionRange(this.root));
  }

  /**
   * Deletes a range selection if there is one, and returns the target block afterward.
   *
   * This goes through the same procedure as a deletion with a range selection, so any registered
   * guard applies the same way. Callers call this from inside an already-open edit attempt.
   *
   * @param range The range to delete.
   * @returns The target block after the deletion. `undefined` if one cannot be ensured.
   */
  deleteRange(range: Range): Element | undefined {
    return prepareTargetBlock(this.root, range, this.hooks);
  }

  /**
   * Inserts a new block containing one line break. Callers run this inside `runCommandEdit`.
   *
   * @param block The block to insert.
   * @param reference The element that anchors the insertion position.
   * @param position Whether to insert before or after the reference element.
   */
  insertBlock(block: Element, reference: Element, position: BlockInsertPosition): void {
    insertBlock(block, reference, position);
  }

  /**
   * Deletes the range, then inserts the text split into lines. The caller calls this inside an edit attempt.
   *
   * This exists so that pastes that do not go through the paste input type (such as plain text paste) are inserted
   * by the same rules as the built-in paste. The registered range delete protections and split preprocessors apply
   * just as they do for the built-in paste.
   *
   * @param text The text to paste.
   * @param range The range to insert into.
   * @returns Whether the tree changed. If the text is empty, returns false without deleting the range.
   */
  pasteText(text: string, range: Range): boolean {
    return insertPastedText(this.root, range, text, this.hooks);
  }

  /** Removes listeners and disposes of change tracking and the composition guard without flushing pending changes. */
  dispose(): void {
    this.detach();
    this.tracker.dispose();
    this.composition.dispose();
  }
}

/**
 * Attaches an input dispatcher, composition guard, and change tracker to an editor root.
 *
 * Built-in rules are registered in this order: materialization, Enter, deletion, then paste. Materialization
 * comes first because an effectively empty editor root needs a paragraph before any other rule runs.
 * For the paragraph-insertion and deletion input types, the Enter and deletion rules go into the fallback queue,
 * so they are tried after any rule registered later.
 * The built-in paste rule also goes into the fallback queue, so it is tried after rules registered later (the HTML
 * paste rule).
 *
 * @param root The editor root.
 * @param createBodyOutput A function that creates body output.
 * @param reportDiagnostic Receives reports of rule failures for maintainers.
 * @param transactions The controller that manages endpoints before and after edits.
 * @returns The attached editing session.
 */
export function attachEditingCore(
  root: HTMLElement,
  createBodyOutput: () => BodyOutput | undefined,
  reportDiagnostic: DiagnosticReporter,
  transactions: EditTransactionLifecycle,
): EditingSession {
  const dispatcher = new InputDispatcher(root, reportDiagnostic);
  const tracker = new ChangeTracker(createBodyOutput);
  // One set of editing hooks per editing session; it is never shared with a different editor root.
  // The split preprocessor list is read when the built-in Enter and paste rules call it, so preprocessors registered later apply too.
  const hooks: EditingHooks = { rangeDeleteGuards: [], compositionStartHooks: [], splitPreprocessors: [] };
  const composition = new CompositionGuard(root, tracker, transactions, hooks, reportDiagnostic);

  // Registered first, so that no rule writes into the invisible source of a diagram.
  registerDiagramGuard(dispatcher);

  const materializationRule = createMaterializationRule();
  dispatcher.register('insertText', materializationRule);
  dispatcher.register('insertLineBreak', materializationRule);

  const enterRule = createEnterRule(root, hooks);
  // For paragraph insertion and deletion, the built-in replacements go into the fallback queue. Both would
  // always take over Enter inside a `pre` and deletion next to an `hr`, and while they sit at the head of the
  // queue no specific rule registered later is ever tried. The Enter of Shift+Enter picks where it takes over,
  // so it is not moved to the fallback queue.
  dispatcher.registerFallback('insertParagraph', enterRule);
  dispatcher.register('insertLineBreak', enterRule);

  // The structure boundary rules go into the fallback queue before the built-in delete replacement. Adding them through the view's registration port would make the order
  // depend on when they are registered, so they are added here on every attach. The rules are only called when the input dispatcher opens an attempt and never run during an input stop,
  // so the ports' input stop is always false.
  let session: EditingSession | undefined;
  const ports: BlockCommandPorts = {
    readEditorRoot: () => root,
    isComposing: () => composition.isComposing,
    isInputStopped: () => false,
    runCommandEdit: (kind, command) => session?.runCommandEdit(kind, command) ?? false,
    ensureTargetBlock: () => ensureTargetBlock(root, readSelectionRange(root)),
    reportDiagnostic,
  };
  registerBoundaryRules(dispatcher, hooks, ports);

  const deleteRule = createDeleteRule(root, hooks);
  for (const inputType of DELETE_INPUT_TYPES) {
    dispatcher.registerFallback(inputType, deleteRule);
  }

  // The built-in paste always takes the input, even without text, so at the head of the main queue it would keep the
  // later-registered HTML paste rule from being tried. Put it in the fallback queue so that only pastes the HTML rule
  // did not take are inserted as the text form.
  dispatcher.registerFallback('insertFromPaste', createPasteRule(root, hooks));

  // Register the comment rules after the built-in delete replacement and the structural boundary rules. The delete main queue is still empty, so the shift rule comes first
  // and the delete-keeping-entries rule goes to the end of the fallback queue. They bypass the view's registration port, so their order does not depend on when registration happens.
  registerCommentGuardRules(dispatcher, hooks, reportDiagnostic);

  const onBeforeInput = (event: InputEvent): void => {
    if (composition.isComposing) {
      // A paste during composition only blocks the default without trying any rule. Letting the default through would
      // insert styled external HTML as is. To paste, commit the composition and try again.
      if (event.inputType === 'insertFromPaste') {
        event.preventDefault();
      }
      // Composition text insertion cannot be canceled. Changing the tree during composition breaks it,
      // so let the input pass without trying any rules.
      return;
    }

    if (!transactions.beginEdit(event.inputType)) {
      event.preventDefault();
      return;
    }

    const range = readSelectionRange(root);
    if (range === undefined) {
      event.preventDefault();
      transactions.abortEdit();
      return;
    }

    const result = dispatcher.dispatch(event, range);
    if (result === 'edited') {
      tracker.notify(event.inputType);
      transactions.completeEdit();
      return;
    }
    if (result !== 'allowed') {
      transactions.abortEdit();
    }
  };

  const onPaste = (event: ClipboardEvent): void => {
    // VS Code's native paste can omit beforeinput. Cancel the native insertion and route both paste paths
    // through the same rules and edit attempt, so the DOM change always has history endpoints.
    event.preventDefault();
    if (!root.isContentEditable || event.clipboardData === null) {
      return;
    }
    onBeforeInput(new InputEvent('beforeinput', {
      inputType: 'insertFromPaste',
      dataTransfer: event.clipboardData,
      cancelable: true,
    }));
  };

  const onInput = (event: InputEvent): void => {
    if (composition.isComposing) {
      return;
    }
    tracker.notify(event.inputType);
    transactions.completeEdit();
  };

  const onCompositionStart = (): void => {
    composition.handleStart();
  };

  const onCompositionEnd = (event: CompositionEvent): void => {
    composition.handleEnd(event.data);
  };

  root.addEventListener('paste', onPaste);
  root.addEventListener('beforeinput', onBeforeInput);
  root.addEventListener('input', onInput);
  root.addEventListener('compositionstart', onCompositionStart);
  root.addEventListener('compositionend', onCompositionEnd);

  const detach = (): void => {
    root.removeEventListener('paste', onPaste);
    root.removeEventListener('beforeinput', onBeforeInput);
    root.removeEventListener('input', onInput);
    root.removeEventListener('compositionstart', onCompositionStart);
    root.removeEventListener('compositionend', onCompositionEnd);
  };

  session = new EditingSession(root, dispatcher, tracker, composition, transactions, hooks, detach);
  return session;
}
