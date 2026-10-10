import { describe, expect, it, vi } from 'vitest';

import { ALLOWED_INPUT_TYPES, InputDispatcher } from '../../webview/editing/input-dispatcher';
import type { InputRule } from '../../webview/editing/input-dispatcher';

// Input types allowed through to the browser when no rule handles them.
const PASSED_INPUT_TYPES = [
  'insertText',
  'insertLineBreak',
  'insertCompositionText',
  'deleteCompositionText',
  'deleteContentBackward',
  'deleteContentForward',
  'deleteWordBackward',
  'deleteWordForward',
  'deleteSoftLineBackward',
  'deleteSoftLineForward',
  'deleteHardLineBackward',
  'deleteHardLineForward',
];

// Suppressed types for formatting, history, and drag operations, plus types replaced by paragraph and paste rules.
const NOT_PASSED_INPUT_TYPES = [
  'insertParagraph',
  'insertFromPaste',
  'formatBold',
  'formatItalic',
  'formatUnderline',
  'historyUndo',
  'historyRedo',
  'insertFromDrop',
  'deleteByDrag',
];

/**
 * Creates an input dispatcher and a range inside its editor root.
 *
 * @returns The input dispatcher, range, and collected diagnostics.
 */
function createDispatcher(): {
  dispatcher: InputDispatcher;
  range: Range;
  diagnostics: string[];
} {
  const root = document.createElement('div');
  root.innerHTML = '<p>a</p>';
  const range = document.createRange();
  range.setStart(root, 0);
  range.collapse(true);
  const diagnostics: string[] = [];
  return {
    dispatcher: new InputDispatcher(root, (detail) => diagnostics.push(detail)),
    range,
    diagnostics,
  };
}

/**
 * Creates a cancelable input event.
 *
 * @param inputType The input type.
 * @returns The input event.
 */
function createInputEvent(inputType: string): InputEvent {
  return new InputEvent('beforeinput', { inputType, cancelable: true });
}

describe('allowed input type set', () => {
  it('contains every input type designated as allowed', () => {
    for (const inputType of PASSED_INPUT_TYPES) {
      expect(ALLOWED_INPUT_TYPES.has(inputType)).toBe(true);
    }
  });

  it('excludes every input type designated for suppression or replacement', () => {
    for (const inputType of NOT_PASSED_INPUT_TYPES) {
      expect(ALLOWED_INPUT_TYPES.has(inputType)).toBe(false);
    }
  });
});

describe('input dispatch', () => {
  it('suppresses an input type absent from the allowed set', () => {
    const { dispatcher, range } = createDispatcher();
    const event = createInputEvent('formatBold');

    const result = dispatcher.dispatch(event, range);

    expect(result).toBe('prevented');
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not call later rules after an earlier rule handles input', () => {
    const { dispatcher, range } = createDispatcher();
    const later = vi.fn<InputRule>(() => 'edited');
    dispatcher.register('insertText', () => 'edited');
    dispatcher.register('insertText', later);

    dispatcher.dispatch(createInputEvent('insertText'), range);

    expect(later).not.toHaveBeenCalled();
  });

  it('tries the next rule when an earlier rule passes', () => {
    const { dispatcher, range } = createDispatcher();
    const later = vi.fn<InputRule>(() => 'edited');
    dispatcher.register('insertText', () => 'pass');
    dispatcher.register('insertText', later);

    const result = dispatcher.dispatch(createInputEvent('insertText'), range);

    expect(later).toHaveBeenCalledTimes(1);
    expect(result).toBe('edited');
  });

  it('applies default treatment when no rule handles input', () => {
    const { dispatcher, range } = createDispatcher();
    dispatcher.register('insertText', () => 'pass');
    const event = createInputEvent('insertText');

    const result = dispatcher.dispatch(event, range);

    expect(result).toBe('allowed');
    expect(event.defaultPrevented).toBe(false);
  });

  it('stops default behavior when a rule handles input without changing the tree', () => {
    const { dispatcher, range } = createDispatcher();
    dispatcher.register('insertText', () => 'consumed');
    const event = createInputEvent('insertText');

    const result = dispatcher.dispatch(event, range);

    expect(result).toBe('consumed');
    expect(event.defaultPrevented).toBe(true);
  });

  it('stops default behavior after a rule throws and continues accepting later input', () => {
    const { dispatcher, range } = createDispatcher();
    dispatcher.register('insertText', () => {
      throw new Error('Rule failure');
    });
    const failing = createInputEvent('insertText');

    const result = dispatcher.dispatch(failing, range);

    expect(result).toBe('prevented');
    expect(failing.defaultPrevented).toBe(true);
    expect(dispatcher.dispatch(createInputEvent('deleteContentBackward'), range)).toBe('allowed');
  });

  it('tries a rule registered later before a rule put into the fallback queue earlier', () => {
    const { dispatcher, range } = createDispatcher();
    const fallback = vi.fn<InputRule>(() => 'edited');
    dispatcher.registerFallback('insertParagraph', fallback);
    const rule = vi.fn<InputRule>(() => 'edited');
    dispatcher.register('insertParagraph', rule);

    dispatcher.dispatch(createInputEvent('insertParagraph'), range);

    expect([rule.mock.calls.length, fallback.mock.calls.length]).toEqual([1, 0]);
  });

  it('tries the fallback queue when no rule takes over, and follows the default treatment when it does not either', () => {
    const { dispatcher, range } = createDispatcher();
    dispatcher.register('insertText', () => 'pass');
    const fallback = vi.fn<InputRule>(() => 'pass');
    dispatcher.registerFallback('insertText', fallback);

    const result = dispatcher.dispatch(createInputEvent('insertText'), range);

    expect([fallback.mock.calls.length, result]).toEqual([1, 'allowed']);
  });

  it('records a rule exception in one diagnostic line', () => {
    const { dispatcher, range, diagnostics } = createDispatcher();
    dispatcher.register('insertText', () => {
      throw new Error('Rule failure');
    });

    dispatcher.dispatch(createInputEvent('insertText'), range);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('insertText');
    expect(diagnostics[0]).toContain('Rule failure');
  });
});
