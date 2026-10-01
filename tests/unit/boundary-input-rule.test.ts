import { describe, expect, it, vi } from 'vitest';

import type { BlockCommandPorts } from '../../webview/editing/block-command';
import { registerBoundaryRules } from '../../webview/editing/boundary-input-rule';
import { readSelectionRange } from '../../webview/editing/caret';
import type { EditingHooks } from '../../webview/editing/editing-hooks';
import { InputDispatcher } from '../../webview/editing/input-dispatcher';
import type { InputRule, InputRuleResult } from '../../webview/editing/input-dispatcher';
import { ensureTargetBlock } from '../../webview/editing/target-block';
import { createRange, mountRoot, readChildText, readElement } from './helpers/format-dom';

const TABLE = '<table><tbody><tr><td>a</td></tr></tbody></table>';

/** The editor root with the rules registered, and the records of registrations and diagnostics. */
interface Harness {
  readonly root: HTMLElement;
  readonly dispatcher: InputDispatcher;
  readonly hooks: EditingHooks;
  readonly diagnostics: string[];
  /** The input types registered in the fallback queue, in registration order. */
  readonly fallbackTypes: string[];
  /** The number of rules registered in the main queue. */
  readonly mainCount: () => number;
  /** Calls this feature's rule registered for an input type once, passing a range. */
  readonly runRule: (inputType: string, range: Range, data?: string | null) => InputRuleResult;
}

/**
 * Creates an input dispatcher on the editor root and registers the structure boundary rules.
 *
 * The rules end up inside the input dispatcher, so they are taken from a recorder placed on the fallback queue registration port. The recorder passes the registrations through,
 * so the order in which the input dispatcher tries them is also the real one.
 *
 * @param html The content of the editor root.
 * @returns The editor root with the rules registered, and the records.
 */
function createHarness(html: string): Harness {
  const root = mountRoot(html);
  const diagnostics: string[] = [];
  const dispatcher = new InputDispatcher(root, (detail) => diagnostics.push(detail));
  const fallback = vi.spyOn(dispatcher, 'registerFallback');
  const main = vi.spyOn(dispatcher, 'register');
  const hooks: EditingHooks = { rangeDeleteGuards: [], compositionStartHooks: [], splitPreprocessors: [] };
  const ports: BlockCommandPorts = {
    readEditorRoot: () => root,
    isComposing: () => false,
    isInputStopped: () => false,
    runCommandEdit: (_kind, command) => command(),
    ensureTargetBlock: () => ensureTargetBlock(root, readSelectionRange(root)),
    reportDiagnostic: (detail) => diagnostics.push(detail),
  };
  registerBoundaryRules(dispatcher, hooks, ports);

  const rules = new Map<string, InputRule>(fallback.mock.calls.map(([inputType, rule]) => [inputType, rule]));
  const runRule = (inputType: string, range: Range, data: string | null = null): InputRuleResult => {
    const rule = rules.get(inputType);
    if (rule === undefined) {
      throw new Error(`no rule is registered: ${inputType}`);
    }
    return rule({ event: new InputEvent('beforeinput', { inputType, data, cancelable: true }), root, range });
  };
  return {
    root,
    dispatcher,
    hooks,
    diagnostics,
    fallbackTypes: fallback.mock.calls.map(([inputType]) => inputType),
    mainCount: () => main.mock.calls.length,
    runRule,
  };
}

/**
 * Creates a range collapsed at a position.
 *
 * @param node The node of the position.
 * @param offset The offset of the position.
 * @returns A collapsed range.
 */
function caretAt(node: Node, offset: number): Range {
  return createRange(node, offset, node, offset);
}

describe('registering the structure boundary rules', () => {
  it('registers one rule in the fallback queue for each of the eight delete input types, and one each for insertText and insertLineBreak', () => {
    const harness = createHarness('<p>ab</p>');

    expect([harness.fallbackTypes, harness.mainCount()]).toEqual([
      [
        'deleteContentBackward',
        'deleteContentForward',
        'deleteWordBackward',
        'deleteWordForward',
        'deleteSoftLineBackward',
        'deleteSoftLineForward',
        'deleteHardLineBackward',
        'deleteHardLineForward',
        'insertText',
        'insertLineBreak',
      ],
      0,
    ]);
  });

  it('adds two guards and one hook to the lists of the editing hooks', () => {
    const { hooks } = createHarness('<p>ab</p>');

    expect([hooks.rangeDeleteGuards.length, hooks.compositionStartHooks.length]).toEqual([2, 1]);
  });

  it("tries a rule added later to the main queue before this feature's rules, and a rule added later to the fallback queue after them", () => {
    const { root, dispatcher } = createHarness(`${TABLE}\n<p>ab</p>`);
    const tried: string[] = [];
    dispatcher.register('deleteContentBackward', () => {
      tried.push('main');
      return 'pass';
    });
    dispatcher.registerFallback('deleteContentBackward', () => {
      tried.push('fallback');
      return 'pass';
    });
    const text = readChildText(readElement(root, 'p'), 0);

    const result = dispatcher.dispatch(
      new InputEvent('beforeinput', { inputType: 'deleteContentBackward', cancelable: true }),
      caretAt(text, 0),
    );

    // This feature's rule takes over the delete at the start of the paragraph right after the table, so the rule added later to the fallback queue is never reached.
    expect([result, tried]).toEqual(['consumed', ['main']]);
  });
});

describe('delete rule at a structure boundary', () => {
  it('returns pass for a delete with a range selection and for a delete that matches nothing', () => {
    const { root, runRule } = createHarness(`${TABLE}\n<p>ab</p>`);
    const text = readChildText(readElement(root, 'p'), 0);

    expect([
      runRule('deleteContentBackward', createRange(text, 0, text, 1)),
      runRule('deleteContentBackward', caretAt(text, 1)),
    ]).toEqual(['pass', 'pass']);
  });

  it('returns edited and records one diagnostic line when the delete rewrite throws after changing the tree', () => {
    const { root, diagnostics, runRule } = createHarness(`${TABLE}\n<p id="empty"><br></p>\n<p>b</p>`);
    const range = caretAt(readElement(root, '#empty'), 0);
    // Fail when moving the range to the placement after removing the empty standalone block.
    Object.defineProperty(range, 'setStart', {
      value: () => {
        throw new Error('Could not move the range');
      },
    });

    const result = runRule('deleteContentBackward', range);

    expect([result, root.innerHTML, diagnostics.length]).toEqual(['edited', `${TABLE}\n<p>b</p>`, 1]);
  });

  it('returns consumed for an exception before the tree changes', () => {
    const html = `${TABLE}\n<p id="empty"><br></p>\n<p>b</p>`;
    const { root, diagnostics, runRule } = createHarness(html);
    const range = caretAt(readElement(root, '#empty'), 0);
    Object.defineProperty(range, 'collapsed', {
      get: () => {
        throw new Error('Could not read the range');
      },
    });

    const result = runRule('deleteContentBackward', range);

    expect([result, root.innerHTML, diagnostics.length]).toEqual(['consumed', html, 1]);
  });
});

describe('input rule for a structure-crossing range', () => {
  it('returns pass for input over a range it does not take over, input without a range selection, and character input without characters', () => {
    const html = `<p>ab</p>\n${TABLE}`;
    const { root, runRule } = createHarness(html);
    const text = readChildText(readElement(root, 'p'), 0);
    const cell = readChildText(readElement(root, 'td'), 0);

    expect([
      runRule('insertText', createRange(text, 0, text, 1), 'x'),
      runRule('insertLineBreak', caretAt(text, 1)),
      runRule('insertText', createRange(text, 1, cell, 1), ''),
      root.innerHTML,
    ]).toEqual(['pass', 'pass', 'pass', html]);
  });

  it('for character input over a range crossing a table, deletes the range keeping the skeleton, inserts the characters at the start and returns edited', () => {
    const { root, runRule } = createHarness(
      '<p>ab</p>\n<table><tbody><tr><td>cd</td></tr><tr><td>ef</td></tr></tbody></table>',
    );
    const text = readChildText(readElement(root, 'p'), 0);
    const last = readChildText(readElement(root, 'tr:last-child td'), 0);

    const result = runRule('insertText', createRange(text, 1, last, 1), 'x');

    expect([result, root.innerHTML]).toEqual([
      'edited',
      '<p>ax</p>\n<table><tbody><tr><td><br></td></tr><tr><td>f</td></tr></tbody></table>',
    ]);
  });

  it('for a range crossing a table whose start is directly under the editor root next to bare text, leaves the tree unchanged and returns consumed', () => {
    const html = `ab${TABLE}`;
    const { root, runRule } = createHarness(html);
    const cell = readChildText(readElement(root, 'td'), 0);

    const result = runRule('insertText', createRange(root, 1, cell, 1), 'x');

    expect([result, root.innerHTML]).toEqual(['consumed', html]);
  });

  it('does not let an exception from the input rewrite escape and records one diagnostic line', () => {
    const { root, diagnostics, runRule } = createHarness(
      '<p>ab</p>\n<table><tbody><tr><td>cd</td></tr><tr><td>ef</td></tr></tbody></table>',
    );
    const text = readChildText(readElement(root, 'p'), 0);
    const last = readChildText(readElement(root, 'tr:last-child td'), 0);
    const range = createRange(text, 1, last, 1);
    // Fail when inserting the characters after deleting the range.
    Object.defineProperty(range, 'insertNode', {
      value: () => {
        throw new Error('Could not insert the characters');
      },
    });

    const result = runRule('insertText', range, 'x');

    expect([result, diagnostics.length]).toEqual(['edited', 1]);
  });
});
