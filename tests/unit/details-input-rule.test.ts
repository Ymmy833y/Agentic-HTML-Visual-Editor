import { describe, expect, it, vi } from 'vitest';

import type { BlockCommandPorts } from '../../webview/editing/block-command';
import { readSelectionRange } from '../../webview/editing/caret';
import { registerDetailsRules } from '../../webview/editing/details-input-rule';
import { attachEditingCore } from '../../webview/editing/editing-session';
import type { EditingSession } from '../../webview/editing/editing-session';
import type { InputRule, InputRuleResult } from '../../webview/editing/input-dispatcher';
import { ensureTargetBlock } from '../../webview/editing/target-block';
import type { EditTransactionLifecycle } from '../../webview/history/edit-transaction-controller';
import { createRange, mountRoot, readChildText, readElement } from './helpers/format-dom';

/** An editing session with the rules registered, along with a record of the registrations. */
interface Harness {
  readonly root: HTMLElement;
  readonly session: EditingSession;
  readonly diagnostics: string[];
  /** Returns the registered input types, in registration order. */
  readonly registeredTypes: () => string[];
  /** Returns the number of registered guards and hooks. */
  readonly hookCounts: () => [number, number];
  /** Calls the rule registered for an input type. */
  readonly runRule: (inputType: string, event: InputEvent, range: Range) => InputRuleResult;
}

/**
 * Sets up an editor root and an editing session, and registers the collapsible-section rules.
 *
 * @param html The editor root's contents.
 * @returns The registered editing session, along with a record of the registrations.
 */
function createHarness(html: string): Harness {
  const root = mountRoot(html);
  const diagnostics: string[] = [];
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
    runCommandEdit: (kind, command) => command(),
    ensureTargetBlock: () => ensureTargetBlock(root, readSelectionRange(root)),
    reportDiagnostic: (detail) => diagnostics.push(detail),
  };

  // Lets the implementation run as-is while recording the calls, so the registered rule can be pulled
  // out and called directly.
  const registerRule = vi.spyOn(session, 'registerRule');
  const registerGuard = vi.spyOn(session, 'registerRangeDeleteGuard');
  const registerHook = vi.spyOn(session, 'registerCompositionStartHook');
  registerDetailsRules(session, ports);

  const readRule = (inputType: string): InputRule => {
    const registered = registerRule.mock.calls.find(([type]) => type === inputType)?.[1];
    if (registered === undefined) {
      throw new Error(`no rule registered for: ${inputType}`);
    }
    return registered;
  };

  return {
    root,
    session,
    diagnostics,
    registeredTypes: () => registerRule.mock.calls.map(([type]) => type),
    hookCounts: () => [registerGuard.mock.calls.length, registerHook.mock.calls.length],
    runRule: (inputType, event, range) => readRule(inputType)({ event, root, range }),
  };
}

/**
 * Creates an input event.
 *
 * @param inputType The input type.
 * @param data The typed character.
 * @returns The created event.
 */
function createInput(inputType: string, data: string | null = null): InputEvent {
  return new InputEvent('beforeinput', { inputType, data, cancelable: true });
}

describe('registering the rules and hooks', () => {
  it('registers one rule each for the paragraph-insertion and character-input types', () => {
    const harness = createHarness('<details open=""><summary>t</summary>\n<p>b</p></details>');

    expect(harness.registeredTypes()).toEqual(['insertParagraph', 'insertText']);
  });

  it('registers one range delete guard and one composition start hook each', () => {
    const harness = createHarness('<details open=""><summary>t</summary>\n<p>b</p></details>');

    expect(harness.hookCounts()).toEqual([1, 1]);
  });
});

describe('the paragraph-insertion rule', () => {
  it('does not take over or change the tree when the start is outside a title', () => {
    const harness = createHarness('\n<p>ab</p>\n<details open=""><summary>t</summary>\n<p>b</p></details>');
    const before = harness.root.innerHTML;
    const text = readChildText(readElement(harness.root, 'p'), 0);

    const result = harness.runRule(
      'insertParagraph',
      createInput('insertParagraph'),
      createRange(text, 1, text, 1),
    );

    expect([result, harness.root.innerHTML]).toEqual(['pass', before]);
  });

  it('returns edited and leaves one diagnostic line when a rewrite throws after having changed the tree', () => {
    const harness = createHarness('\n<details><summary>title</summary>\n<p>body</p></details>');
    const section = readElement(harness.root, 'details');
    Object.defineProperty(section, 'setAttribute', {
      value: () => {
        throw new Error('could not set the attribute');
      },
    });
    const title = readChildText(readElement(harness.root, 'summary'), 0);

    // An Enter with a range selection has already changed the tree by deleting the range before the exception.
    const result = harness.runRule(
      'insertParagraph',
      createInput('insertParagraph'),
      createRange(title, 1, title, 3),
    );

    expect([result, harness.diagnostics.length]).toEqual(['edited', 1]);
  });

  it('returns consumed when a rewrite throws without having changed the tree', () => {
    const harness = createHarness('\n<details><summary>title</summary>\n<p>body</p></details>');
    const section = readElement(harness.root, 'details');
    const before = harness.root.innerHTML;
    Object.defineProperty(section, 'setAttribute', {
      value: () => {
        throw new Error('could not set the attribute');
      },
    });
    const title = readChildText(readElement(harness.root, 'summary'), 0);

    const result = harness.runRule(
      'insertParagraph',
      createInput('insertParagraph'),
      createRange(title, 1, title, 1),
    );

    expect([result, harness.root.innerHTML]).toEqual(['consumed', before]);
  });
});

describe('the character-input rule', () => {
  it('does not take over a non-crossing range, input with no range selection, or input with no character', () => {
    const harness = createHarness(
      '\n<p>ab</p>\n<details open="">\n<summary>st</summary>\n<p>body</p>\n</details>\n',
    );
    const inside = readChildText(readElement(harness.root, 'details > p'), 0);
    const outside = readChildText(readElement(harness.root, 'p'), 0);

    const results = [
      harness.runRule('insertText', createInput('insertText', 'x'), createRange(inside, 1, inside, 3)),
      harness.runRule('insertText', createInput('insertText', 'x'), createRange(outside, 1, outside, 1)),
      harness.runRule('insertText', createInput('insertText'), createRange(outside, 0, inside, 2)),
    ];

    expect(results).toEqual(['pass', 'pass', 'pass']);
  });
});
