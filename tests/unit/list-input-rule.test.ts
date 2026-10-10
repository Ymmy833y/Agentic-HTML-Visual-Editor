import { describe, expect, it, vi } from 'vitest';

import type { BlockCommandPorts } from '../../webview/editing/block-command';
import { readSelectionRange } from '../../webview/editing/caret';
import { attachEditingCore } from '../../webview/editing/editing-session';
import type { EditingSession } from '../../webview/editing/editing-session';
import type { InputRule, InputRuleResult } from '../../webview/editing/input-dispatcher';
import { registerListRules } from '../../webview/editing/list-input-rule';
import { ensureTargetBlock } from '../../webview/editing/target-block';
import type { EditTransactionLifecycle } from '../../webview/history/edit-transaction-controller';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** An editing session with the list rules registered, and a record of registrations and calls. */
interface Harness {
  readonly root: HTMLElement;
  /** The editing session the rule is registered in. Used to register split preprocessors. */
  readonly session: EditingSession;
  readonly diagnostics: string[];
  /** The times the command path was opened. */
  readonly commandEdits: string[];
  /** Returns the registered input types, in registration order. */
  readonly registeredTypes: () => string[];
  /** Calls the rule registered for an input type. */
  readonly runRule: (inputType: string, range: Range) => InputRuleResult;
}

/**
 * Sets up an editor root and an editing session, and registers the list rules.
 *
 * @param html The content of the editor root.
 * @returns The editing session with the rules registered, and the records.
 */
function createHarness(html: string): Harness {
  const root = mountRoot(html);
  const diagnostics: string[] = [];
  const commandEdits: string[] = [];
  const transactions: EditTransactionLifecycle = {
    beginEdit: () => true,
    completeEdit: () => undefined,
    abortEdit: () => undefined,
  };
  const session = attachEditingCore(root, () => undefined, () => undefined, transactions);
  const ports: BlockCommandPorts = {
    readEditorRoot: () => root,
    isComposing: () => false,
    isInputStopped: () => false,
    runCommandEdit: (kind, command) => {
      commandEdits.push(kind);
      return command();
    },
    ensureTargetBlock: () => ensureTargetBlock(root, readSelectionRange(root)),
    reportDiagnostic: (detail) => diagnostics.push(detail),
  };

  // Records the calls while leaving the implementation running as is, so the registered rules can be taken out
  // and called directly.
  const registerRule = vi.spyOn(session, 'registerRule');
  registerListRules(session, ports);

  const readRule = (inputType: string): InputRule => {
    const registered = registerRule.mock.calls.find(([type]) => type === inputType)?.[1];
    if (registered === undefined) {
      throw new Error(`no rule is registered: ${inputType}`);
    }
    return registered;
  };

  return {
    root,
    session,
    diagnostics,
    commandEdits,
    registeredTypes: () => registerRule.mock.calls.map(([type]) => type),
    runRule: (inputType, range) => readRule(inputType)({
      event: new InputEvent('beforeinput', { inputType, cancelable: true }),
      root,
      range,
    }),
  };
}

/**
 * Places the caret in the text that is the first child of an element and returns that range.
 *
 * @param root The editor root.
 * @param selector The selector of the element holding the text.
 * @param offset The offset within the text.
 * @returns The range placed in the selection.
 */
function placeCaretIn(root: Element, selector: string, offset: number): Range {
  const text = readChildText(readElement(root, selector), 0);
  select(createRange(text, offset, text, offset));
  const range = readSelectionRange(root);
  if (range === undefined) {
    throw new Error('could not place the caret');
  }
  return range;
}

describe('registering the rules', () => {
  it('registers one rule each for paragraph insertion and character-wise and word-wise backward and forward delete, and none for line-wise delete', () => {
    const harness = createHarness('<ul><li>a</li></ul>');

    expect(harness.registeredTypes()).toEqual([
      'insertParagraph',
      'deleteContentBackward',
      'deleteContentForward',
      'deleteWordBackward',
      'deleteWordForward',
    ]);
  });
});

describe('the paragraph insertion rule', () => {
  it('returns "pass" for paragraph insertion outside an item and leaves the tree unchanged', () => {
    const harness = createHarness('<p>ab</p><ul><li>c</li></ul>');
    const before = harness.root.innerHTML;

    const result = harness.runRule('insertParagraph', placeCaretIn(harness.root, 'p', 1));

    expect([result, harness.root.innerHTML]).toEqual(['pass', before]);
  });

  it('returns "edited" and leaves one diagnostic line when the rewrite throws after changing the tree', () => {
    const harness = createHarness('<ul><li>ab<ul><li>c</li></ul></li></ul>');
    const item = readElement(harness.root, 'li');
    Object.defineProperty(item, 'after', {
      value: () => {
        throw new Error('could not insert the item');
      },
    });

    // Splitting in the middle of the line has already changed the tree by extracting the content after the
    // caret before inserting the new item.
    const result = harness.runRule('insertParagraph', placeCaretIn(harness.root, 'li', 1));

    expect([result, harness.diagnostics.length]).toEqual(['edited', 1]);
  });

  it('returns "consumed" and leaves one diagnostic line when the rewrite throws without changing the tree', () => {
    const harness = createHarness('<ul><li>ab<ul><li>c</li></ul></li></ul>');
    const nested = readElement(harness.root, 'li li');
    const before = harness.root.innerHTML;
    Object.defineProperty(nested, 'before', {
      value: () => {
        throw new Error('could not insert the item');
      },
    });

    const result = harness.runRule('insertParagraph', placeCaretIn(harness.root, 'li', 2));

    expect([result, harness.diagnostics.length, harness.root.innerHTML]).toEqual(['consumed', 1, before]);
  });
});

describe('Splitting items and split preprocessors', () => {
  it('in an item with a nested list, when a preprocessor returns the line end boundary, an empty item appears at the start of the nested list', () => {
    const harness = createHarness('<ul><li>ab<ul><li>c</li></ul></li></ul>');
    const item = readElement(harness.root, 'li');
    // Returns the end of the line (the item's own content), that is, just before the nested list.
    harness.session.registerSplitPreprocessor(() => ({ kind: 'split', boundary: { container: item, offset: 1 } }));

    harness.runRule('insertParagraph', placeCaretIn(harness.root, 'li', 1));

    expect(readElement(harness.root, 'li ul').innerHTML).toBe('\n<li><br></li>\n<li>c</li>');
  });

  it('when a preprocessor takes over without changing the tree, the item is not split and the result is "consumed"', () => {
    const harness = createHarness('<ul><li>ab<ul><li>c</li></ul></li></ul>');
    const before = harness.root.innerHTML;
    harness.session.registerSplitPreprocessor(() => ({ kind: 'takenOver', changed: false, boundary: undefined }));

    const result = harness.runRule('insertParagraph', placeCaretIn(harness.root, 'li', 1));

    expect([result, harness.root.innerHTML]).toEqual(['consumed', before]);
  });
});

describe('the backward delete rule', () => {
  it('calls outdent with the rule trigger on backward delete at the start of the first item\'s line, without opening the command path', () => {
    const harness = createHarness('<ul><li>a</li></ul>');

    const result = harness.runRule('deleteContentBackward', placeCaretIn(harness.root, 'li', 0));

    expect([result, harness.root.innerHTML, harness.commandEdits]).toEqual(['edited', '<p>a</p>', []]);
  });
});
