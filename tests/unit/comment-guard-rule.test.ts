import { describe, expect, it, vi } from 'vitest';

import { registerCommentCompositionHook, registerCommentGuardRules } from '../../webview/editing/comment-guard-rule';
import type { CompositionStartHook, EditingHooks } from '../../webview/editing/editing-hooks';
import { InputDispatcher } from '../../webview/editing/input-dispatcher';
import { mountRoot } from './helpers/format-dom';

describe('Registering the comment rules', () => {
  it('adds one rule each to the main and fallback queues of the 8 delete types and to the fallback queues of text input and line break insertion, and one guard to the guard list', () => {
    const root = mountRoot('<p>ab</p>');
    const dispatcher = new InputDispatcher(root, () => undefined);
    const main = vi.spyOn(dispatcher, 'register');
    const fallback = vi.spyOn(dispatcher, 'registerFallback');
    const hooks: EditingHooks = { rangeDeleteGuards: [], compositionStartHooks: [], compositionEndHooks: [], splitPreprocessors: [] };
    const deletes = [
      'deleteContentBackward',
      'deleteContentForward',
      'deleteWordBackward',
      'deleteWordForward',
      'deleteSoftLineBackward',
      'deleteSoftLineForward',
      'deleteHardLineBackward',
      'deleteHardLineForward',
    ];

    registerCommentGuardRules(dispatcher, hooks, () => undefined);

    expect([
      main.mock.calls.map(([inputType]) => inputType),
      fallback.mock.calls.map(([inputType]) => inputType),
      hooks.rangeDeleteGuards.length,
      hooks.compositionStartHooks.length,
    ]).toEqual([deletes, [...deletes, 'insertText', 'insertLineBreak'], 1, 0]);
  });
});

describe('Registering the composition start preprocessor', () => {
  it('appends one to the end of the preprocessor list and keeps the previously registered preprocessors', () => {
    const earlier: CompositionStartHook = () => undefined;
    const hooks: CompositionStartHook[] = [earlier];

    registerCommentCompositionHook({ registerCompositionStartHook: (hook) => hooks.push(hook) }, () => undefined);

    expect([hooks.length, hooks[0]]).toEqual([2, earlier]);
  });
});
