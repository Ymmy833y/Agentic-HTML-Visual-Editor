import { describe, expect, it, vi } from 'vitest';

import { AutoformatTable, createAutoformatEntries } from '../../webview/editing/autoformat';
import { registerAutoformatRules } from '../../webview/editing/autoformat-input-rule';
import type { BlockCommandPorts } from '../../webview/editing/block-command';
import { attachEditingCore } from '../../webview/editing/editing-session';
import type { InputRule, InputRuleResult } from '../../webview/editing/input-dispatcher';
import type { EditTransactionLifecycle } from '../../webview/history/edit-transaction-controller';
import { createRange, mountRoot, readChildText, readElement } from './helpers/format-dom';

/** Only tree rewriting is examined, so history endpoints are accepted and discarded. */
const TRANSACTIONS: EditTransactionLifecycle = {
  beginEdit: () => true,
  completeEdit: () => undefined,
  abortEdit: () => undefined,
};

/** Block command ports that do nothing, for tests that never reach an entry's operation. */
const IDLE_PORTS: BlockCommandPorts = {
  readEditorRoot: () => undefined,
  isComposing: () => false,
  isInputStopped: () => false,
  runCommandEdit: () => false,
  ensureTargetBlock: () => undefined,
  reportDiagnostic: () => undefined,
};

/** The editor root with the rules registered, and a record of the registrations. */
interface Harness {
  readonly root: HTMLElement;
  readonly table: AutoformatTable;
  /** The registered input types, in registration order. */
  readonly inputTypes: string[];
  /** Calls the rule registered for an input type with the caret at the end of the paragraph's text. */
  readonly runRule: (inputType: string, data: string | null) => InputRuleResult;
}

/**
 * Creates an editing session on an editor root with a single paragraph and registers the markdown-style autoformat
 * rules.
 *
 * The rules end up inside the input dispatcher, so they are taken out through a spy placed on the registration
 * port.
 *
 * @param html The contents of the editor root. The paragraph's first child must be text.
 * @returns The editor root with the rules registered, and the records.
 */
function createHarness(html: string): Harness {
  const root = mountRoot(html);
  const session = attachEditingCore(root, () => undefined, () => undefined, TRANSACTIONS);
  const inputTypes: string[] = [];
  const rules = new Map<string, InputRule>();
  vi.spyOn(session, 'registerRule').mockImplementation((inputType, rule) => {
    inputTypes.push(inputType);
    rules.set(inputType, rule);
  });

  const table = new AutoformatTable();
  for (const entry of createAutoformatEntries(IDLE_PORTS)) {
    table.addEntry(entry);
  }
  registerAutoformatRules(session, table, () => undefined);

  const runRule = (inputType: string, data: string | null): InputRuleResult => {
    const rule = rules.get(inputType);
    if (rule === undefined) {
      throw new Error(`no rule is registered: ${inputType}`);
    }
    const text = readChildText(readElement(root, 'p'), 0);
    return rule({
      event: new InputEvent('beforeinput', { inputType, data }),
      root,
      range: createRange(text, text.length, text, text.length),
    });
  };
  return { root, table, inputTypes, runRule };
}

describe('Registering the markdown-style autoformat rules', () => {
  it('registers one rule each for text input and paragraph insertion, and none for other input types', () => {
    expect(createHarness('<p>ab</p>').inputTypes).toEqual(['insertText', 'insertParagraph']);
  });

  it('for text input whose data is not a single half-width space (# or a full-width space), it returns pass without matching', () => {
    const harness = createHarness('<p>#</p>');
    const findMatch = vi.spyOn(harness.table, 'findMatch');

    const results = [
      harness.runRule('insertText', '#'),
      harness.runRule('insertText', '　'),
      harness.runRule('insertText', '  '),
    ];

    expect([results, findMatch.mock.calls.length]).toEqual([['pass', 'pass', 'pass'], 0]);
  });

  it('for a space and an Enter that do not match, it returns pass and does not change the tree', () => {
    const harness = createHarness('<p>ab</p>');

    const results = [
      harness.runRule('insertText', ' '),
      harness.runRule('insertParagraph', null),
    ];

    expect([results, harness.root.innerHTML]).toEqual([['pass', 'pass'], '<p>ab</p>']);
  });
});
