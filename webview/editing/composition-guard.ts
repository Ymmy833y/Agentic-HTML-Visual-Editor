import { placeCaret, placeCaretAtStart, readSelectionRange } from './caret';
import type { ChangeTracker } from './change-tracker';
import { insertCompositionPlaceholder, removeCompositionPlaceholder } from './code-composition';
import type { CompositionPlaceholder } from './code-composition';
import type { EditingHooks } from './editing-hooks';
import type { DiagnosticReporter } from './input-dispatcher';
import {
  isEffectivelyEmpty,
  materializeBetweenBlocks,
  materializeParagraph,
  rollbackMaterialization,
} from './materialization';
import type { Materialization } from './materialization';
import type { EditTransactionLifecycle } from '../history/edit-transaction-controller';

/** Edit kind used to report a committed composition as one edit. */
const COMPOSITION_EDIT_KIND = 'insertCompositionText';

/** Suspends input rules and change tracking during IME composition. */
export class CompositionGuard {
  private composing = false;

  private materialization: Materialization | undefined;

  // The paragraph created at a between-blocks position. Unlike materializing an effectively empty root, rolling it back returns the caret to its original position.
  private betweenBlocks: Materialization | undefined;

  // Placeholders inserted before composition. Both those for empty code and the composition placeholders a preprocessor put at a comment edge are removed together when composition ends.
  private placeholders: CompositionPlaceholder[] = [];

  /**
   * @param root The editor root.
   * @param tracker The change tracker.
   * @param transactions The controller that manages endpoints before and after an IME edit.
   * @param hooks The editing hooks.
   * @param reportDiagnostic The diagnostic reporter for maintainers. Used only to record failures inserting or removing the placeholder and materializing the paragraph.
   */
  constructor(
    private readonly root: Element,
    private readonly tracker: ChangeTracker,
    private readonly transactions: EditTransactionLifecycle,
    private readonly hooks: EditingHooks = {
      rangeDeleteGuards: [],
      compositionStartHooks: [],
      compositionEndHooks: [],
      splitPreprocessors: [],
    },
    private readonly reportDiagnostic?: DiagnosticReporter,
  ) {}

  /** Whether composition is active. Remains `false` if composition text arrives without a start event. */
  get isComposing(): boolean {
    return this.composing;
  }

  /**
   * Handles the start of composition.
   *
   * Composition text insertion cannot be canceled, and wrapping it after composition starts breaks composition.
   * An effectively empty editor root is therefore materialized here before composition begins.
   * If the caret is at a between-blocks position, inserts a paragraph; if it is at an empty code position, inserts a placeholder; for the same reason,
   * does so before the composition and remembers it as the pre-composition state. If body output for the edit right before the composition is pending, flushes it first.
   */
  handleStart(): void {
    if (this.composing) {
      return;
    }
    if (!this.transactions.beginEdit(COMPOSITION_EDIT_KIND)) {
      return;
    }
    this.composing = true;

    // The change tracker's deferred output does not stop when a composition starts. Leaving the output for the edit right before the composition pending lets its deadline
    // arrive mid-composition and send the host a body containing the pre-composition state placed below (placeholder, created paragraph) and uncommitted characters.
    this.tracker.flush();

    // The composition text cannot be stopped, so the registered hooks get a chance, in registration order, to adjust the selection before it goes in.
    // Hooks are called on the assumption that they do not throw, so exceptions are not caught here.
    const placeholders: CompositionPlaceholder[] = [];
    this.placeholders = placeholders;
    for (const hook of this.hooks.compositionStartHooks) {
      hook(this.root, (text) => {
        placeholders.push({ text });
      });
    }

    if (isEffectivelyEmpty(this.root)) {
      const materialization = materializeParagraph(this.root);
      placeCaretAtStart(materialization.paragraph);
      this.materialization = materialization;
      return;
    }

    this.betweenBlocks = this.materializeBetweenBlocks();
    if (this.betweenBlocks !== undefined) {
      // The created paragraph has no empty `code`, so no placeholder is needed.
      return;
    }
    const placeholder = insertCompositionPlaceholder(this.root, this.reportDiagnostic);
    if (placeholder !== undefined) {
      placeholders.push(placeholder);
    }
  }

  /**
   * Handles the end of composition.
   *
   * @param data The committed text, or an empty string when composition ends without a commit.
   */
  handleEnd(data: string): void {
    this.composing = false;
    const materialization = this.materialization;
    const betweenBlocks = this.betweenBlocks;
    const placeholders = this.placeholders;
    this.materialization = undefined;
    this.betweenBlocks = undefined;
    this.placeholders = [];

    // Content under `pre` is exempt from removing editing artifacts before saving, so remove it before deciding whether to finish or abort, whether committed or not.
    // Composition placeholders at a comment edge are removed the same way, because if left behind they put a zero-width space into the saved content.
    // For a composition that only placed a composition placeholder, removing it returns the tree to its pre-composition state.
    for (const placeholder of placeholders) {
      removeCompositionPlaceholder(placeholder, this.reportDiagnostic);
    }

    // What a start hook built around its placeholder is taken back out here, before deciding whether the composition counts as an edit, so an
    // uncommitted one leaves the tree as it was. Hooks are called on the assumption that they do not throw, so exceptions are not caught here.
    for (const hook of this.hooks.compositionEndHooks) {
      hook(this.root, data.length > 0);
    }

    if (data.length === 0) {
      if (materialization === undefined && betweenBlocks === undefined) {
        // Without materialization the tree was untouched, so ending without a commit is not an edit.
        this.transactions.abortEdit();
        return;
      }
      if (materialization !== undefined && rollbackMaterialization(this.root, materialization)) {
        // Rollback removes the caret's referenced node, so move the caret back to the start of the root.
        placeCaret(this.root, 0);
        this.transactions.abortEdit();
        return;
      }
      if (betweenBlocks !== undefined && this.rollbackBetweenBlocks(betweenBlocks)) {
        this.transactions.abortEdit();
        return;
      }
    }

    this.tracker.notify(COMPOSITION_EDIT_KIND);
    this.transactions.completeEdit();
  }

  /** Discards the composition flag and pre-composition state in preparation for remounting. */
  dispose(): void {
    if (this.composing) {
      this.transactions.abortEdit();
    }
    this.composing = false;
    this.materialization = undefined;
    this.betweenBlocks = undefined;
    // The tree is discarded by the replacement, so the placeholder is not removed; only the record is discarded.
    this.placeholders = [];
  }

  /**
   * If a collapsed caret is at a between-blocks position, creates a paragraph at that position and places the caret at its start.
   *
   * @returns The record of the created paragraph, or `undefined` if none was created or creation failed.
   */
  private materializeBetweenBlocks(): Materialization | undefined {
    try {
      const range = readSelectionRange(this.root);
      if (range === undefined || !range.collapsed) {
        return undefined;
      }
      const materialization = materializeBetweenBlocks(this.root, range);
      if (materialization !== undefined) {
        placeCaretAtStart(materialization.paragraph);
      }
      return materialization;
    } catch (error) {
      // The composition cannot be stopped, so even on failure do not throw; let it continue with the default behavior.
      this.reportDiagnostic?.(`Could not create a paragraph at the between-blocks position before the composition: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * Removes the paragraph created for a composition that was not committed, and returns the caret to where the paragraph was.
   *
   * @param materialization The record of the created paragraph.
   * @returns `true` if it was removed; `false` if the paragraph has content.
   */
  private rollbackBetweenBlocks(materialization: Materialization): boolean {
    const next = materialization.paragraph.nextSibling;
    if (!rollbackMaterialization(this.root, materialization)) {
      return false;
    }
    placeCaret(
      this.root,
      next !== null && next.parentNode === this.root
        ? [...this.root.childNodes].indexOf(next)
        : this.root.childNodes.length,
    );
    return true;
  }
}
