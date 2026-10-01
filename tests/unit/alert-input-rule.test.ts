import { describe, expect, it, vi } from 'vitest';

import { registerAlertRules } from '../../webview/editing/alert-input-rule';
import type { BlockCommandPorts } from '../../webview/editing/block-command';
import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { insertBreakInBlockquote } from '../../webview/editing/blockquote-enter';
import { attachEditingCore } from '../../webview/editing/editing-session';
import type { InputRule, InputRuleResult } from '../../webview/editing/input-dispatcher';
import type { EditTransactionLifecycle } from '../../webview/history/edit-transaction-controller';
import { createRange, mountRoot, readElement } from './helpers/format-dom';

/** Only the rewrites of the tree are looked at, so the history endpoints are merely taken and dropped. */
const TRANSACTIONS: EditTransactionLifecycle = {
  beginEdit: () => true,
  completeEdit: () => undefined,
  abortEdit: () => undefined,
};

/**
 * Creates an editing session and takes out the paragraph-insertion rule that was registered.
 *
 * The rule goes inside the input dispatcher, so it is taken through a spy put on the registration port.
 *
 * @param html The contents of the editor root.
 * @returns The editor root, the list of registered input types, the rules, and the diagnostic lines left behind.
 */
function registerRules(html: string): {
  root: HTMLElement;
  inputTypes: string[];
  rules: InputRule[];
  diagnostics: string[];
} {
  const root = mountRoot(html);
  const session = attachEditingCore(root, () => undefined, () => undefined, TRANSACTIONS);
  const inputTypes: string[] = [];
  const rules: InputRule[] = [];
  vi.spyOn(session, 'registerRule').mockImplementation((inputType, rule) => {
    inputTypes.push(inputType);
    rules.push(rule);
  });

  const diagnostics: string[] = [];
  const ports: BlockCommandPorts = {
    readEditorRoot: () => root,
    isComposing: () => false,
    isInputStopped: () => false,
    runCommandEdit: (kind, command) => command(),
    ensureTargetBlock: () => undefined,
    reportDiagnostic: (detail) => diagnostics.push(detail),
  };
  registerAlertRules(session, ports);
  return { root, inputTypes, rules, diagnostics };
}

/**
 * Calls a rule.
 *
 * @param rule The rule to call.
 * @param root The editor root.
 * @param range The range that points at the caret.
 * @returns The value the rule returns.
 */
function runRule(rule: InputRule, root: Element, range: Range): InputRuleResult {
  return rule({
    event: new InputEvent('beforeinput', { inputType: 'insertParagraph' }),
    root,
    range,
  });
}

/**
 * Creates a collapsed range pointing at a position inside a blockquote.
 *
 * @param container The node holding the position.
 * @param offset The position within the node.
 * @returns The collapsed range.
 */
function caretAt(container: Node, offset: number): Range {
  return createRange(container, offset, container, offset);
}

describe('registering the paragraph-insertion rule', () => {
  it('registers one rule for the paragraph-insertion input type', () => {
    expect(registerRules('<blockquote>ab</blockquote>').inputTypes).toEqual(['insertParagraph']);
  });

  it('returns pass and leaves the tree unchanged outside a bare blockquote', () => {
    const { root, rules } = registerRules('<p>ab</p>');
    const paragraph = readElement(root, 'p');

    const result = runRule(rules[0], root, caretAt(paragraph.firstChild ?? paragraph, 1));

    expect([result, root.innerHTML]).toEqual(['pass', '<p>ab</p>']);
  });

  it('returns edited and leaves one diagnostic line when the rewrite throws after changing the tree', () => {
    const { root, rules, diagnostics } = registerRules('<blockquote>ab<br><br></blockquote>');
    const quote = readElement(root, 'blockquote');
    // Fail after the trailing break is removed but before the paragraph is inserted.
    Object.defineProperty(quote, 'after', {
      value: () => {
        throw new Error('could not insert the paragraph');
      },
    });

    const result = runRule(rules[0], root, caretAt(quote, 2));

    expect([result, diagnostics.length, quote.innerHTML]).toEqual(['edited', 1, 'ab<br>']);
  });

  it('returns consumed when the rewrite throws without having changed the tree', () => {
    const { root, rules, diagnostics } = registerRules('<blockquote>ab</blockquote>');
    const quote = readElement(root, 'blockquote');
    const range = caretAt(quote.firstChild ?? quote, 1);
    Object.defineProperty(range, 'insertNode', {
      value: () => {
        throw new Error('could not insert the line break');
      },
    });

    const result = runRule(rules[0], root, range);

    expect([result, diagnostics.length, quote.innerHTML]).toEqual(['consumed', 1, 'ab']);
  });

  it('takes over Enter in the trailing quote paragraph and returns edited, leaving the blockquote', () => {
    const { root, rules } = registerRules('<blockquote><p>ab</p>\n<p><br></p></blockquote>');
    const trailing = root.querySelectorAll('p')[1];

    const result = runRule(rules[0], root, caretAt(trailing, 0));

    expect([result, root.innerHTML]).toEqual(['edited', '<blockquote><p>ab</p></blockquote>\n<p><br></p>']);
  });
});

describe('inserting an in-block break in a blockquote', () => {
  it('inserts two br elements when called at the end of the content and one when called partway through', () => {
    const root = mountRoot('<blockquote>ab</blockquote><blockquote>cd</blockquote>');
    const quotes = [...root.querySelectorAll('blockquote')];
    const progress: BlockRewriteProgress = { changed: false };

    insertBreakInBlockquote(quotes[0], caretAt(quotes[0].firstChild ?? quotes[0], 2), progress);
    insertBreakInBlockquote(quotes[1], caretAt(quotes[1].firstChild ?? quotes[1], 1), progress);

    expect(quotes.map((quote) => quote.innerHTML)).toEqual(['ab<br><br>', 'c<br>d']);
  });
});
