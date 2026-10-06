import { describe, expect, it } from 'vitest';

import { readSelectionRange } from '../../webview/editing/caret';
import { COMPOSITION_PLACEHOLDER_TEXT } from '../../webview/editing/code-composition';
import type { CompositionEndHook, CompositionStartHook } from '../../webview/editing/editing-hooks';
import type { FormatCommandPorts } from '../../webview/editing/format-command';
import type { ToggleFormat } from '../../webview/editing/inline-format';
import type { InputRule, InputRuleResult } from '../../webview/editing/input-dispatcher';
import { PendingFormat } from '../../webview/editing/pending-format';
import { createPendingFormatRule, registerPendingFormatRules } from '../../webview/editing/pending-format-rule';
import { ensureTargetBlock } from '../../webview/editing/target-block';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** What one test works with: the mounted root, the pending format, the registered rule and hooks, and the records. */
interface Harness {
  readonly root: HTMLElement;
  readonly pending: PendingFormat;
  readonly diagnostics: string[];
  /** Runs the registered text insertion rule for the typed text at the current selection. */
  readonly type: (data: string) => InputRuleResult;
  /** Runs the registered composition start hooks and returns the placeholders they passed to the port. */
  readonly startComposition: () => Text[];
  /** Runs the registered composition end hooks. */
  readonly endComposition: (committed: boolean) => void;
}

/**
 * Mounts the contents and registers the rule and hooks with a stand-in for the editing session.
 *
 * @param html The contents of the editor root.
 * @returns The harness.
 */
function mount(html: string): Harness {
  const root = mountRoot(html);
  const pending = new PendingFormat();
  const diagnostics: string[] = [];
  const ports: FormatCommandPorts = {
    readEditorRoot: () => root,
    isComposing: () => false,
    isInputStopped: () => false,
    runCommandEdit: (_kind, command) => command(),
    ensureTargetBlock: () => ensureTargetBlock(root, readSelectionRange(root)),
    togglePendingFormat: (format) => pending.toggle(format, root),
    reportDiagnostic: (detail) => diagnostics.push(detail),
  };

  const rules: InputRule[] = [];
  const startHooks: CompositionStartHook[] = [];
  const endHooks: CompositionEndHook[] = [];
  registerPendingFormatRules({
    registerRule: (_inputType, rule) => rules.push(rule),
    registerCompositionStartHook: (hook) => startHooks.push(hook),
    registerCompositionEndHook: (hook) => endHooks.push(hook),
  }, pending, ports, (detail) => diagnostics.push(detail));

  return {
    root,
    pending,
    diagnostics,
    type: (data) => {
      const range = readSelectionRange(root);
      const rule = rules[0];
      if (range === undefined || rule === undefined) {
        throw new Error('no selection or no rule');
      }
      return rule({ event: new InputEvent('beforeinput', { inputType: 'insertText', data, cancelable: true }), root, range });
    },
    startComposition: () => {
      const placeholders: Text[] = [];
      for (const hook of startHooks) {
        hook(root, (text) => placeholders.push(text));
      }
      return placeholders;
    },
    endComposition: (committed) => {
      for (const hook of endHooks) {
        hook(root, committed);
      }
    },
  };
}

/**
 * Places a bare caret inside the first text of an element and holds the given formats there.
 *
 * @param harness The harness.
 * @param selector A CSS selector for the element holding the text.
 * @param offset The caret's offset.
 * @param formats The formats to hold.
 */
function holdAt(harness: Harness, selector: string, offset: number, formats: readonly ToggleFormat[]): void {
  const text = readChildText(readElement(harness.root, selector), 0);
  const caret = createRange(text, offset, text, offset);
  select(caret);
  for (const format of formats) {
    harness.pending.toggle(format, harness.root);
  }
}

/**
 * Reads the caret as the text it sits in and the offset.
 *
 * @returns The text content of the caret's node and the offset.
 */
function readCaret(): [string | null, number | undefined] {
  const selection = window.getSelection();
  return [selection?.anchorNode?.textContent ?? null, selection?.anchorOffset];
}

describe('typing under a pending format', () => {
  it('wraps the typed character in the format, puts the caret after it, consumes the pending format, and reports an edit', () => {
    const harness = mount('<p>abcd</p>');
    holdAt(harness, 'p', 2, ['bold']);

    const result = harness.type('x');

    expect([result, harness.root.innerHTML, readCaret(), harness.pending.isEmpty])
      .toEqual(['edited', '<p>ab<strong>x</strong>cd</p>', ['x', 1], true]);
  });

  it('puts the typed character outside the format, splitting the element, when the format is held inside it', () => {
    const harness = mount('<p><strong>abcd</strong></p>');
    holdAt(harness, 'strong', 2, ['bold']);

    const result = harness.type('x');

    expect([result, harness.root.innerHTML, readCaret()])
      .toEqual(['edited', '<p><strong>ab</strong>x<strong>cd</strong></p>', ['x', 1]]);
  });

  it('stacks two held formats on the one character and leaves no empty or duplicate elements', () => {
    const harness = mount('<p>ab<em>cd</em></p>');
    holdAt(harness, 'em', 0, ['bold', 'italic']);

    harness.type('x');

    expect(harness.root.innerHTML).toBe('<p>ab<strong>x</strong><em>cd</em></p>');
  });

  it('removes the height placeholder of an empty block and turns a space at the end of the line into U+00A0', () => {
    const harness = mount('<p><br></p>');
    const paragraph = readElement(harness.root, 'p');
    const caret = createRange(paragraph, 0, paragraph, 0);
    select(caret);
    harness.pending.toggle('inlineCode', harness.root);

    harness.type(' ');

    expect(harness.root.innerHTML).toBe('<p><code>&nbsp;</code></p>');
  });

  it('wraps a bare run in a paragraph before giving it the format', () => {
    const harness = mount('abcd');
    const text = readChildText(harness.root, 0);
    const caret = createRange(text, 4, text, 4);
    select(caret);
    harness.pending.toggle('strikethrough', harness.root);

    const result = harness.type('x');

    expect([result, harness.root.innerHTML]).toEqual(['edited', '\n<p>abcd<s>x</s></p>']);
  });

  it('passes without touching anything when nothing is held', () => {
    const harness = mount('<p>abcd</p>');
    holdAt(harness, 'p', 2, []);

    expect([harness.type('x'), harness.root.innerHTML]).toEqual(['pass', '<p>abcd</p>']);
  });

  it('drops the held formats and passes for empty data or a range selection', () => {
    const harness = mount('<p>abcd</p>');
    holdAt(harness, 'p', 2, ['bold']);
    const emptyData = harness.type('');
    const afterEmpty = harness.pending.isEmpty;

    holdAt(harness, 'p', 2, ['bold']);
    const text = readChildText(readElement(harness.root, 'p'), 0);
    select(createRange(text, 1, text, 3));
    const rangeSelection = harness.type('x');

    expect([emptyData, afterEmpty, rangeSelection, harness.pending.isEmpty, harness.root.innerHTML])
      .toEqual(['pass', true, 'pass', true, '<p>abcd</p>']);
  });

  it('drops the held formats and passes when the caret has left the anchor before its selection change was handled', () => {
    const harness = mount('<p>abcd</p>');
    holdAt(harness, 'p', 2, ['bold']);
    const text = readChildText(readElement(harness.root, 'p'), 0);
    select(createRange(text, 3, text, 3));

    const result = harness.type('x');

    expect([result, harness.pending.isEmpty, harness.root.innerHTML]).toEqual(['pass', true, '<p>abcd</p>']);
  });

  it('passes inside a pre, where no format is applied', () => {
    const harness = mount('<pre><code>abcd</code></pre>');
    const text = readChildText(readElement(harness.root, 'code'), 0);
    const caret = createRange(text, 2, text, 2);
    select(caret);
    harness.pending.toggle('bold', harness.root);

    expect([harness.type('x'), harness.root.innerHTML]).toEqual(['pass', '<pre><code>abcd</code></pre>']);
  });

  it('the rule alone consumes the input, reports a diagnostic, and keeps the tree when ensuring the block throws', () => {
    const root = mountRoot('abcd');
    const pending = new PendingFormat();
    const diagnostics: string[] = [];
    const rule = createPendingFormatRule(pending, {
      readEditorRoot: () => root,
      isComposing: () => false,
      isInputStopped: () => false,
      runCommandEdit: (_kind, command) => command(),
      ensureTargetBlock: () => {
        throw new Error('cannot ensure a block');
      },
      togglePendingFormat: () => undefined,
      reportDiagnostic: (detail) => diagnostics.push(detail),
    }, (detail) => diagnostics.push(detail));
    const text = readChildText(root, 0);
    const caret = createRange(text, 1, text, 1);
    select(caret);
    pending.toggle('bold', root);

    const result = rule({ event: new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', cancelable: true }), root, range: caret });

    expect([result, diagnostics.length, root.innerHTML]).toEqual(['consumed', 1, 'abcd']);
  });
});

describe('composing under a pending format', () => {
  it('places the composition placeholder inside the format, passes it to the port, puts the caret after it, and consumes the pending format', () => {
    const harness = mount('<p>abcd</p>');
    holdAt(harness, 'p', 2, ['bold']);

    const placeholders = harness.startComposition();

    expect([harness.root.innerHTML, placeholders.length, readCaret(), harness.pending.isEmpty]).toEqual([
      `<p>ab<strong>${COMPOSITION_PLACEHOLDER_TEXT}</strong>cd</p>`,
      1,
      [COMPOSITION_PLACEHOLDER_TEXT, 1],
      true,
    ]);
  });

  it('removes the element left empty by an uncommitted composition and puts the caret back where it was', () => {
    const harness = mount('<p>abcd</p>');
    holdAt(harness, 'p', 2, ['bold']);
    const [placeholder] = harness.startComposition();
    // The composition guard takes the placeholder character out before the end hooks run.
    placeholder?.remove();

    harness.endComposition(false);

    expect([harness.root.innerHTML, readCaret()]).toEqual(['<p>abcd</p>', ['cd', 0]]);
  });

  it('joins the element that was split to hold the placeholder outside when nothing is committed', () => {
    const harness = mount('<p><strong>abcd</strong></p>');
    holdAt(harness, 'strong', 2, ['bold']);
    const [placeholder] = harness.startComposition();
    placeholder?.remove();

    harness.endComposition(false);

    expect([harness.root.querySelectorAll('strong').length, readElement(harness.root, 'strong').textContent, readCaret()])
      .toEqual([1, 'abcd', ['cd', 0]]);
  });

  it('keeps the composed text inside the format when the composition is committed', () => {
    const harness = mount('<p>abcd</p>');
    holdAt(harness, 'p', 2, ['bold']);
    const [placeholder] = harness.startComposition();
    placeholder?.replaceData(0, 1, 'x');

    harness.endComposition(true);

    expect(harness.root.innerHTML).toBe('<p>ab<strong>x</strong>cd</p>');
  });

  it('places nothing for a caret with no block-level ancestor, and leaves nothing for the end', () => {
    const harness = mount('abcd');
    const text = readChildText(harness.root, 0);
    const caret = createRange(text, 2, text, 2);
    select(caret);
    harness.pending.toggle('bold', harness.root);

    const placeholders = harness.startComposition();
    harness.endComposition(false);

    expect([placeholders.length, harness.root.innerHTML, harness.pending.isEmpty]).toEqual([0, 'abcd', true]);
  });
});
