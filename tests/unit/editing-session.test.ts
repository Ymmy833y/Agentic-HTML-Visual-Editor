import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChangeTracker, OUTPUT_DEBOUNCE_MS } from '../../webview/editing/change-tracker';
import type { OutputReceiver } from '../../webview/editing/change-tracker';
import { COMPOSITION_PLACEHOLDER_TEXT } from '../../webview/editing/code-composition';
import { CompositionGuard } from '../../webview/editing/composition-guard';
import type { CompositionStartHook, SplitPreprocessor } from '../../webview/editing/editing-hooks';
import { attachEditingCore } from '../../webview/editing/editing-session';
import type { EditingSession } from '../../webview/editing/editing-session';
import type { BodyOutput } from '../../webview/document/serialization-state';
import type { EditTransactionLifecycle } from '../../webview/history/edit-transaction-controller';
import { createRange, readChildText, readElement, select } from './helpers/format-dom';

const OUTPUT: BodyOutput = { body: '\n<p>a</p>\n', current: '\n<p>a</p>' };

/**
 * Creates an editing session attached to an editor root and an output receiver that records calls.
 *
 * @returns The editing session and values recorded by the output receiver.
 */
function attach(): {
  session: EditingSession;
  kinds: string[];
  outputs: BodyOutput[];
  transactionCalls: string[];
  root: HTMLElement;
} {
  const root = document.createElement('div');
  root.innerHTML = '<p>a</p>';
  const kinds: string[] = [];
  const outputs: BodyOutput[] = [];
  const transactionCalls: string[] = [];
  const receiver: OutputReceiver = {
    onEditDetected: (kind) => kinds.push(kind),
    onBodyOutput: (output) => outputs.push(output),
  };

  // Diagnostics are outside this test's scope, so pass a function that only accepts them.
  const transactions: EditTransactionLifecycle = {
    beginEdit: (kind) => {
      transactionCalls.push(`begin:${kind}`);
      return true;
    },
    completeEdit: () => transactionCalls.push('complete'),
    abortEdit: () => transactionCalls.push('abort'),
  };
  const session = attachEditingCore(root, () => OUTPUT, () => undefined, transactions);
  session.setOutputReceiver(receiver);
  document.body.replaceChildren(root);
  const range = document.createRange();
  range.setStart(root.firstChild?.firstChild ?? root, 0);
  range.collapse(true);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  return { session, kinds, outputs, transactionCalls, root };
}

describe('editing session', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends an immediate notification for an explicit change and output after the deadline', () => {
    const { session, kinds, outputs } = attach();

    session.notifyChange('applyBlockFormat');
    vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS);

    expect(kinds).toEqual(['applyBlockFormat']);
    expect(outputs).toEqual([OUTPUT]);
  });

  it('emits no pending output or later explicit notifications after disposal', () => {
    const { session, kinds, outputs } = attach();
    session.notifyChange('applyBlockFormat');

    session.dispose();
    vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS);
    session.notifyChange('applyBlockFormat');

    expect(outputs).toEqual([]);
    expect(kinds).toEqual(['applyBlockFormat']);
  });

  it('notifies and completes only changed commands, aborting unchanged commands and exceptions', () => {
    const { session, kinds, transactionCalls } = attach();

    expect(session.runCommandEdit('insertBlockCommand', () => true)).toBe(true);
    expect(session.runCommandEdit('noopCommand', () => false)).toBe(false);
    expect(() => session.runCommandEdit('failedCommand', () => {
      throw new Error('Failure');
    })).toThrow('Failure');

    expect(kinds).toEqual(['insertBlockCommand']);
    expect(transactionCalls).toEqual([
      'begin:insertBlockCommand',
      'complete',
      'begin:noopCommand',
      'abort',
      'begin:failedCommand',
      'abort',
    ]);
  });

  it('passes the given edit endpoint selections as the second argument of beginEdit', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>a</p>';
    const passed: unknown[] = [];
    const transactions: EditTransactionLifecycle = {
      beginEdit: (kind, endpoints) => {
        passed.push(endpoints);
        return true;
      },
      completeEdit: () => undefined,
      abortEdit: () => undefined,
    };
    const session = attachEditingCore(root, () => OUTPUT, () => undefined, transactions);
    const text = root.firstChild?.firstChild ?? root;
    const endpoints = { start: createRange(text, 0, text, 0), end: createRange(text, 1, text, 1) };

    session.runCommandEdit('details:toggle', () => true, endpoints);

    expect([passed.length, passed[0] === endpoints]).toEqual([1, true]);
    session.dispose();
  });

  it('closes changed, consumed, and exceptional rules once as complete, abort, and abort', () => {
    const { session, root, transactionCalls } = attach();
    session.registerRule('changedRule', () => 'edited');
    session.registerRule('consumedRule', () => 'consumed');
    session.registerRule('failedRule', () => {
      throw new Error('Rule failure');
    });

    for (const inputType of ['changedRule', 'consumedRule', 'failedRule']) {
      root.dispatchEvent(new InputEvent('beforeinput', { inputType, cancelable: true }));
    }

    expect(transactionCalls).toEqual([
      'begin:changedRule',
      'complete',
      'begin:consumedRule',
      'abort',
      'begin:failedRule',
      'abort',
    ]);
  });

  it('completes a committed IME edit and reverts materialization then aborts if an empty editor does not commit', () => {
    const root = document.createElement('div');
    const transactionCalls: string[] = [];
    const transactions: EditTransactionLifecycle = {
      beginEdit: (kind) => {
        transactionCalls.push(`begin:${kind}`);
        return true;
      },
      completeEdit: () => transactionCalls.push('complete'),
      abortEdit: () => transactionCalls.push('abort'),
    };
    const session = attachEditingCore(root, () => OUTPUT, () => undefined, transactions);

    root.dispatchEvent(new CompositionEvent('compositionstart'));
    root.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
    root.dispatchEvent(new CompositionEvent('compositionstart'));
    root.firstElementChild?.append('composition');
    root.dispatchEvent(new CompositionEvent('compositionend', { data: 'composition' }));

    expect(transactionCalls).toEqual([
      'begin:insertCompositionText',
      'abort',
      'begin:insertCompositionText',
      'complete',
    ]);
    session.dispose();
  });
});

describe('Registering listeners that receive the edit trigger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a listener registered through the editing session receives the trigger for edits via the command path', () => {
    const { session } = attach();
    const detected: string[] = [];
    session.addEditListener((kind) => detected.push(kind));

    session.runCommandEdit('applyBlockFormat', () => true);

    expect(detected).toEqual(['applyBlockFormat']);
    session.dispose();
  });
});

const TABLE = '<table><tbody><tr><td>a</td></tr></tbody></table>';

/** The editing session attached to an editor root placed in the document, and the records of attempts and diagnostics. */
interface MountedSession {
  readonly root: HTMLElement;
  readonly session: EditingSession;
  readonly transactionCalls: string[];
  readonly diagnostics: string[];
}

/**
 * Places the editor root in the document and attaches an editing session. Nothing is registered through the view's registration port.
 *
 * @param html The content of the editor root.
 * @returns The editing session and the records.
 */
function mountSession(html: string): MountedSession {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.replaceChildren(root);
  const transactionCalls: string[] = [];
  const diagnostics: string[] = [];
  const transactions: EditTransactionLifecycle = {
    beginEdit: (kind) => {
      transactionCalls.push(`begin:${kind}`);
      return true;
    },
    completeEdit: () => transactionCalls.push('complete'),
    abortEdit: () => transactionCalls.push('abort'),
  };
  const session = attachEditingCore(root, () => OUTPUT, (detail) => diagnostics.push(detail), transactions);
  return { root, session, transactionCalls, diagnostics };
}

/**
 * Places the caret at a position.
 *
 * @param node The node of the position.
 * @param offset The offset of the position.
 */
function placeAt(node: Node, offset: number): void {
  select(createRange(node, offset, node, offset));
}

/**
 * Reads the current caret position.
 *
 * @returns The node and offset of the caret.
 */
function readCaret(): unknown[] {
  const selection = window.getSelection();
  return [selection?.anchorNode, selection?.anchorOffset];
}

describe('registering range delete guards and composition start hooks', () => {
  it('registering two guards overwrites neither, and the range delete calls both in registration order', () => {
    const { root, session } = mountSession('<p>ab</p>\n<p>cd</p>');
    const called: string[] = [];
    session.registerRangeDeleteGuard(() => {
      called.push('first');
      return [];
    });
    session.registerRangeDeleteGuard(() => {
      called.push('second');
      return { emptiedElements: [], keptNodes: [] };
    });
    const [first, second] = [...root.querySelectorAll('p')].map((paragraph) => readChildText(paragraph, 0));

    session.deleteRange(createRange(first, 1, second, 1));

    expect(called).toEqual(['first', 'second']);
    session.dispose();
  });

  it('registering two hooks makes a composition start call both in registration order', () => {
    const { root, session } = mountSession('<p>ab</p>');
    const called: string[] = [];
    session.registerCompositionStartHook(() => called.push('first'));
    session.registerCompositionStartHook(() => called.push('second'));
    placeAt(readChildText(readElement(root, 'p'), 0), 1);

    root.dispatchEvent(new CompositionEvent('compositionstart'));

    expect(called).toEqual(['first', 'second']);
    session.dispose();
  });

  it('merely attaching without view registrations makes a backward delete at the start of the paragraph right after a table stop the default and leave the tree unchanged', () => {
    const html = `${TABLE}\n<p>ab</p>`;
    const { root, session, transactionCalls } = mountSession(html);
    placeAt(readChildText(readElement(root, 'p'), 0), 0);
    const event = new InputEvent('beforeinput', { inputType: 'deleteContentBackward', cancelable: true });

    root.dispatchEvent(event);

    expect([event.defaultPrevented, root.innerHTML, transactionCalls])
      .toEqual([true, html, ['begin:deleteContentBackward', 'abort']]);
    session.dispose();
  });
});

describe('composition in an empty code', () => {
  it('starting a composition inside an empty code inserts a placeholder into code', () => {
    const { root, session } = mountSession('<pre><code></code></pre>');
    placeAt(readElement(root, 'code'), 0);

    root.dispatchEvent(new CompositionEvent('compositionstart'));

    expect(readElement(root, 'code').textContent).toBe(COMPOSITION_PLACEHOLDER_TEXT);
    session.dispose();
  });

  it('ending without commit removes the placeholder, restores the tree and closes the attempt as aborted', () => {
    const { root, session, transactionCalls } = mountSession('<pre><code></code></pre>');
    placeAt(readElement(root, 'code'), 0);

    root.dispatchEvent(new CompositionEvent('compositionstart'));
    root.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));

    expect([root.innerHTML, transactionCalls])
      .toEqual(['<pre><code></code></pre>', ['begin:insertCompositionText', 'abort']]);
    session.dispose();
  });

  it('ending with commit removes only the placeholder and closes the attempt as complete', () => {
    const { root, session, transactionCalls } = mountSession('<pre><code></code></pre>');
    const code = readElement(root, 'code');
    placeAt(code, 0);

    root.dispatchEvent(new CompositionEvent('compositionstart'));
    // The composition characters go into the placeholder text, where the caret is.
    readChildText(code, 0).appendData('a');
    root.dispatchEvent(new CompositionEvent('compositionend', { data: 'a' }));

    expect([root.innerHTML, transactionCalls])
      .toEqual(['<pre><code>a</code></pre>', ['begin:insertCompositionText', 'complete']]);
    session.dispose();
  });

  it('disposing mid-composition discards the placeholder record and does not carry it over to the next composition', () => {
    const root = document.createElement('div');
    root.innerHTML = '<pre><code></code></pre>';
    document.body.replaceChildren(root);
    const transactionCalls: string[] = [];
    const guard = new CompositionGuard(root, new ChangeTracker(() => undefined), {
      beginEdit: (kind) => {
        transactionCalls.push(`begin:${kind}`);
        return true;
      },
      completeEdit: () => transactionCalls.push('complete'),
      abortEdit: () => transactionCalls.push('abort'),
    });
    const code = readElement(root, 'code');
    placeAt(code, 0);
    guard.handleStart();

    guard.dispose();
    guard.handleStart();
    guard.handleEnd('');

    // If the end of the next composition used the discarded record, the placeholder of the previous composition would be removed.
    expect([code.textContent, transactionCalls]).toEqual([
      COMPOSITION_PLACEHOLDER_TEXT,
      ['begin:insertCompositionText', 'abort', 'begin:insertCompositionText', 'abort'],
    ]);
  });

  it('the composition continues even if inserting the placeholder fails, and one line reaches the diagnostic reporter', () => {
    const { root, session, diagnostics } = mountSession('<pre><code></code></pre>');
    const code = readElement(root, 'code');
    placeAt(code, 0);
    Object.defineProperty(code, 'append', {
      value: () => {
        throw new Error('Could not insert');
      },
    });

    root.dispatchEvent(new CompositionEvent('compositionstart'));

    expect([session.isComposing, diagnostics.length, root.innerHTML]).toEqual([true, 1, '<pre><code></code></pre>']);
    session.dispose();
  });
});

describe('body output for the edit right before a composition', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starting a composition in an empty code while the change tracker has pending output emits the body before the placeholder once, and nothing during the composition even after the deferral deadline', () => {
    const root = document.createElement('div');
    root.innerHTML = '<pre><code></code></pre>';
    document.body.replaceChildren(root);
    const bodies: string[] = [];
    const tracker = new ChangeTracker(() => ({ body: root.innerHTML, current: root.innerHTML }));
    tracker.setReceiver({ onEditDetected: () => undefined, onBodyOutput: (output) => bodies.push(output.body) });
    const guard = new CompositionGuard(root, tracker, {
      beginEdit: () => true,
      completeEdit: () => undefined,
      abortEdit: () => undefined,
    });
    placeAt(readElement(root, 'code'), 0);
    // Detect the edit right before the composition (such as a delete that empties code), leaving the output waiting for the deferral deadline.
    tracker.notify('deleteContentBackward');

    guard.handleStart();
    vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS);

    expect(bodies).toEqual(['<pre><code></code></pre>']);
  });
});

describe('composition at a between-blocks position', () => {
  it('starting a composition directly under the editor root right after a table creates an empty paragraph right after the table with the caret inside', () => {
    const { root, session } = mountSession(`${TABLE}\n<p>ab</p>`);
    placeAt(root, 1);

    root.dispatchEvent(new CompositionEvent('compositionstart'));

    expect([root.innerHTML, readCaret()]).toEqual([`${TABLE}\n<p><br></p>\n<p>ab</p>`, [root.children[1], 0]]);
    session.dispose();
  });

  it('when that composition ends without commit, removes the paragraph and the line break before it, returns the caret to its original position, and closes the attempt as aborted', () => {
    const html = `${TABLE}\n<p>ab</p>`;
    const { root, session, transactionCalls } = mountSession(html);
    placeAt(root, 1);

    root.dispatchEvent(new CompositionEvent('compositionstart'));
    root.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));

    expect([root.innerHTML, readCaret(), transactionCalls])
      .toEqual([html, [root, 1], ['begin:insertCompositionText', 'abort']]);
    session.dispose();
  });

  it('the composition continues even if materializing the paragraph throws, and one line reaches the diagnostic reporter', () => {
    const html = `${TABLE}\n<p>ab</p>`;
    const { root, session, diagnostics } = mountSession(html);
    placeAt(root, 1);
    Object.defineProperty(readElement(root, 'table'), 'after', {
      value: () => {
        throw new Error('Could not place the paragraph');
      },
    });

    root.dispatchEvent(new CompositionEvent('compositionstart'));

    expect([session.isComposing, diagnostics.length, root.innerHTML]).toEqual([true, 1, html]);
    session.dispose();
  });
});

/**
 * Sends a paragraph insertion input to the editor root.
 *
 * @param root The editor root.
 */
function dispatchParagraphInsertion(root: HTMLElement): void {
  root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', cancelable: true }));
}

/** A preprocessor that inserts a line break at the caret and takes over with just after it as the boundary to continue from (the same shape as in the middle of a comment). */
const insertBreak: SplitPreprocessor = (_block, caret) => {
  const at = document.createRange();
  at.setStart(caret.container, caret.offset);
  const lineBreak = document.createElement('br');
  at.insertNode(lineBreak);
  at.setStartAfter(lineBreak);
  return { kind: 'takenOver', changed: true, boundary: { container: at.startContainer, offset: at.startOffset } };
};

describe('Registering and calling split preprocessors', () => {
  it('registering two preprocessors does not overwrite, and a paragraph insertion mid-paragraph calls both in registration order', () => {
    const { root, session } = mountSession('<p>ab</p>');
    const called: string[] = [];
    session.registerSplitPreprocessor((_block, caret) => {
      called.push('first');
      return { kind: 'split', boundary: caret };
    });
    session.registerSplitPreprocessor((_block, caret) => {
      called.push('second');
      return { kind: 'split', boundary: caret };
    });
    placeAt(readChildText(readElement(root, 'p'), 0), 1);

    dispatchParagraphInsertion(root);

    expect(called).toEqual(['first', 'second']);
    session.dispose();
  });

  it('calls the registered preprocessor and moves the range to the boundary it returns', () => {
    const { root, session } = mountSession('<p>ab</p>');
    const paragraph = readElement(root, 'p');
    session.registerSplitPreprocessor(() => ({ kind: 'split', boundary: { container: paragraph, offset: 0 } }));
    const range = createRange(readChildText(paragraph, 0), 1, readChildText(paragraph, 0), 1);

    session.prepareSplit(paragraph, range);

    expect([range.startContainer, range.startOffset]).toEqual([paragraph, 0]);
    session.dispose();
  });
});

describe('The Enter rule and split preprocessors', () => {
  it('splits at the paragraph end boundary a preprocessor returns, leaving an empty paragraph after it', () => {
    const { root, session } = mountSession('<p>ab</p>');
    const paragraph = readElement(root, 'p');
    session.registerSplitPreprocessor(() => ({
      kind: 'split',
      boundary: { container: paragraph, offset: paragraph.childNodes.length },
    }));
    placeAt(readChildText(paragraph, 0), 1);

    dispatchParagraphInsertion(root);

    expect(root.innerHTML).toBe('<p>ab</p>\n<p><br></p>');
    session.dispose();
  });

  it('does not split the paragraph and closes the attempt as complete when a preprocessor inserts a line break and takes over', () => {
    const { root, session, transactionCalls } = mountSession('<p>ab</p>');
    session.registerSplitPreprocessor(insertBreak);
    placeAt(readChildText(readElement(root, 'p'), 0), 1);

    dispatchParagraphInsertion(root);

    expect([root.innerHTML, transactionCalls]).toEqual(['<p>a<br>b</p>', ['begin:insertParagraph', 'complete']]);
    session.dispose();
  });

  it('does not split the paragraph and closes the attempt as aborted when a preprocessor takes over without changing the tree', () => {
    const { root, session, transactionCalls } = mountSession('<p>ab</p>');
    session.registerSplitPreprocessor(() => ({ kind: 'takenOver', changed: false, boundary: undefined }));
    placeAt(readChildText(readElement(root, 'p'), 0), 1);

    dispatchParagraphInsertion(root);

    expect([root.innerHTML, transactionCalls]).toEqual(['<p>ab</p>', ['begin:insertParagraph', 'abort']]);
    session.dispose();
  });

  it('does not call preprocessors for a paragraph insertion inside pre', () => {
    const { root, session } = mountSession('<pre><code>ab</code></pre>');
    const called: string[] = [];
    session.registerSplitPreprocessor((_block, caret) => {
      called.push('called');
      return { kind: 'split', boundary: caret };
    });
    placeAt(readChildText(readElement(root, 'code'), 0), 1);

    dispatchParagraphInsertion(root);

    expect(called).toEqual([]);
    session.dispose();
  });

  it('without registered preprocessors, a paragraph insertion mid-paragraph splits into two paragraphs as before', () => {
    const { root, session } = mountSession('<p>ab</p>');
    placeAt(readChildText(readElement(root, 'p'), 0), 1);

    dispatchParagraphInsertion(root);

    expect(root.innerHTML).toBe('<p>a</p>\n<p>b</p>');
    session.dispose();
  });
});

describe('Order of the comment delete rules', () => {
  it('a backward delete inside at the start of a comment at the paragraph start is merged with the previous paragraph by the built-in replacement at the shifted position, keeping the entries', () => {
    const { root, session } = mountSession('<p>ab</p>\n<p><comment id="c">cd<comment-body>n</comment-body></comment></p>');
    placeAt(readChildText(readElement(root, 'comment'), 0), 0);

    root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', cancelable: true }));

    expect(root.innerHTML).toBe('<p>ab<comment id="c">cd<comment-body>n</comment-body></comment></p>');
    session.dispose();
  });

  it('a forward delete just after a comment at the paragraph end tries the built-in replacement before the comment delete rules and merges with the next paragraph', () => {
    const { root, session } = mountSession('<p>ab<comment id="c">cd<comment-body>n</comment-body></comment></p>\n<p>ef</p>');
    placeAt(readElement(root, 'p'), 2);

    root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentForward', cancelable: true }));

    expect(root.innerHTML).toBe('<p>ab<comment id="c">cd<comment-body>n</comment-body></comment>ef</p>');
    session.dispose();
  });
});

/**
 * Creates a preprocessor that places a composition placeholder at the end of the paragraph, moves the caret into it, and passes it to the port.
 *
 * @param paragraph The paragraph to place the composition placeholder in.
 * @returns The preprocessor.
 */
function createPlaceholderHook(paragraph: Element): CompositionStartHook {
  return (_root, keepPlaceholder) => {
    const text = document.createTextNode(COMPOSITION_PLACEHOLDER_TEXT);
    paragraph.append(text);
    placeAt(text, 1);
    keepPlaceholder(text);
  };
}

describe('Composition placeholders placed by preprocessors', () => {
  it('a composition placeholder passed to the port is removed when composition ends with a commit, leaving the composed characters and closing with complete', () => {
    const { root, session, transactionCalls } = mountSession('<p>ab</p>');
    const paragraph = readElement(root, 'p');
    session.registerCompositionStartHook(createPlaceholderHook(paragraph));
    placeAt(readChildText(paragraph, 0), 2);

    root.dispatchEvent(new CompositionEvent('compositionstart'));
    // The composed characters go into the composition placeholder text where the caret is.
    readChildText(paragraph, 1).appendData('x');
    root.dispatchEvent(new CompositionEvent('compositionend', { data: 'x' }));

    expect([root.innerHTML, transactionCalls]).toEqual(['<p>abx</p>', ['begin:insertCompositionText', 'complete']]);
    session.dispose();
  });

  it('calls the composition end hooks in registration order after the placeholder is removed and before the attempt closes, with whether text was committed', () => {
    const { root, session, transactionCalls } = mountSession('<p>ab</p>');
    const paragraph = readElement(root, 'p');
    session.registerCompositionStartHook(createPlaceholderHook(paragraph));
    const called: string[] = [];
    session.registerCompositionEndHook((editorRoot, committed) => {
      called.push(`first:${String(editorRoot === root)}:${String(committed)}:${paragraph.textContent ?? ''}:${transactionCalls.length}`);
    });
    session.registerCompositionEndHook(() => called.push('second'));
    placeAt(readChildText(paragraph, 0), 2);

    root.dispatchEvent(new CompositionEvent('compositionstart'));
    root.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
    root.dispatchEvent(new CompositionEvent('compositionstart'));
    readChildText(paragraph, 1).appendData('x');
    root.dispatchEvent(new CompositionEvent('compositionend', { data: 'x' }));

    expect(called).toEqual(['first:true:false:ab:1', 'second', 'first:true:true:abx:3', 'second']);
    session.dispose();
  });

  it('ending without a commit a composition that only placed a composition placeholder returns the tree to its pre-composition state and closes with abort', () => {
    const { root, session, transactionCalls } = mountSession('<p>ab</p>');
    const paragraph = readElement(root, 'p');
    session.registerCompositionStartHook(createPlaceholderHook(paragraph));
    placeAt(readChildText(paragraph, 0), 2);

    root.dispatchEvent(new CompositionEvent('compositionstart'));
    root.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));

    expect([root.innerHTML, transactionCalls]).toEqual(['<p>ab</p>', ['begin:insertCompositionText', 'abort']]);
    session.dispose();
  });

  it('disposing during composition does not carry the composition placeholder record over to the next composition', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>ab</p>';
    document.body.replaceChildren(root);
    const paragraph = readElement(root, 'p');
    const transactionCalls: string[] = [];
    let placing = true;
    const placeOnce: CompositionStartHook = (editorRoot, keepPlaceholder) => {
      if (placing) {
        placing = false;
        createPlaceholderHook(paragraph)(editorRoot, keepPlaceholder);
      }
    };
    const guard = new CompositionGuard(
      root,
      new ChangeTracker(() => undefined),
      {
        beginEdit: (kind) => {
          transactionCalls.push(`begin:${kind}`);
          return true;
        },
        completeEdit: () => transactionCalls.push('complete'),
        abortEdit: () => transactionCalls.push('abort'),
      },
      { rangeDeleteGuards: [], compositionStartHooks: [placeOnce], compositionEndHooks: [], splitPreprocessors: [] },
    );
    placeAt(readChildText(paragraph, 0), 2);
    guard.handleStart();

    guard.dispose();
    guard.handleStart();
    guard.handleEnd('');

    // If the end of the next composition used the discarded record, the previous composition's placeholder would be removed.
    expect([paragraph.textContent, transactionCalls]).toEqual([
      `ab${COMPOSITION_PLACEHOLDER_TEXT}`,
      ['begin:insertCompositionText', 'abort', 'begin:insertCompositionText', 'abort'],
    ]);
  });

  it('preprocessors taking only the first argument are called in registration order alongside preprocessors taking the port', () => {
    const { root, session } = mountSession('<p>ab</p>');
    const called: string[] = [];
    session.registerCompositionStartHook((editorRoot) => called.push(`first:${String(editorRoot === root)}`));
    session.registerCompositionStartHook((_editorRoot, keepPlaceholder) => called.push(`second:${typeof keepPlaceholder}`));
    session.registerCompositionStartHook(() => called.push('third'));
    placeAt(readChildText(readElement(root, 'p'), 0), 1);

    root.dispatchEvent(new CompositionEvent('compositionstart'));

    expect(called).toEqual(['first:true', 'second:function', 'third']);
    session.dispose();
  });
});

describe('text paste from a command path', () => {
  it('applies the registered split preprocessor, inserts two lines of text, and returns whether the tree changed', () => {
    const { root, session } = mountSession('<p>ab</p>');
    session.registerSplitPreprocessor(insertBreak);
    const text = readChildText(readElement(root, 'p'), 0);

    const changed = session.pasteText('x\ny', createRange(text, 1, text, 1));

    expect([changed, root.innerHTML]).toEqual([true, '<p>ax<br>yb</p>']);
    session.dispose();
  });
});
