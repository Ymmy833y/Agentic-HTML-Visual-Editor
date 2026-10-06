import { describe, expect, it } from 'vitest';

import { readSelectionRange } from '../../webview/editing/caret';
import type { FormatCommandPorts } from '../../webview/editing/format-command';
import { LINK_INSERT_EDIT_KIND, insertLink } from '../../webview/editing/link-insert';
import { ensureTargetBlock } from '../../webview/editing/target-block';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

const LINK_URL = 'https://example.test/';

/** Ports to replace. Without them, the ports behave as in the real environment. */
interface PortOverrides {
  readonly isComposing?: () => boolean;
  readonly isInputStopped?: () => boolean;
  readonly runCommandEdit?: (kind: string, command: () => boolean) => boolean;
  readonly ensureTargetBlock?: () => Element | undefined;
}

/**
 * Creates doubles of the format command ports and records of the calls.
 *
 * As in the editing session, the command path completes the attempt only when the tree changed. Without calling
 * in the same order as the real environment, whether an attempt was opened could not be told apart.
 *
 * @param root The editor root.
 * @param overrides The ports to replace.
 * @returns The ports and the records of the diagnostics and attempts.
 */
function createPorts(root: HTMLElement, overrides: PortOverrides = {}): {
  ports: FormatCommandPorts;
  diagnostics: string[];
  attempts: string[];
} {
  const diagnostics: string[] = [];
  const attempts: string[] = [];
  const ports: FormatCommandPorts = {
    readEditorRoot: () => root,
    isComposing: overrides.isComposing ?? (() => false),
    isInputStopped: overrides.isInputStopped ?? (() => false),
    runCommandEdit: overrides.runCommandEdit ?? ((kind, command) => {
      attempts.push(`begin:${kind}`);
      const changed = command();
      attempts.push(changed ? 'complete' : 'abort');
      return changed;
    }),
    ensureTargetBlock: overrides.ensureTargetBlock
      ?? (() => ensureTargetBlock(root, readSelectionRange(root))),
    togglePendingFormat: () => undefined,
    reportDiagnostic: (detail) => diagnostics.push(detail),
  };
  return { ports, diagnostics, attempts };
}

/**
 * Places the caret in the text that is the first child of an element.
 *
 * @param root The editor root.
 * @param selector The selector of the element that holds the text.
 * @param offset The position inside the text.
 */
function placeCaretIn(root: Element, selector: string, offset: number): void {
  const text = readChildText(readElement(root, selector), 0);
  select(createRange(text, offset, text, offset));
}

describe('the preconditions for inserting at a position without text', () => {
  it('returns false without opening an attempt at a caret inside a', () => {
    const root = mountRoot('<p><a href="a.html">ab</a></p>');
    placeCaretIn(root, 'a', 1);
    const { ports, attempts } = createPorts(root);

    const changed = insertLink(ports, LINK_URL);

    expect([changed, attempts, root.innerHTML]).toEqual([false, [], '<p><a href="a.html">ab</a></p>']);
  });

  it('returns false without opening an attempt at a caret inside pre or inside a comment body', () => {
    const inPre = mountRoot('<pre><code>ab</code></pre>');
    placeCaretIn(inPre, 'code', 1);
    const pre = createPorts(inPre);
    const preChanged = insertLink(pre.ports, LINK_URL);

    const inBody = mountRoot('<p>x<comment id="c1">y<comment-body>note</comment-body></comment></p>');
    placeCaretIn(inBody, 'comment-body', 2);
    const body = createPorts(inBody);
    const bodyChanged = insertLink(body.ports, LINK_URL);

    expect([preChanged, pre.attempts, bodyChanged, body.attempts]).toEqual([false, [], false, []]);
  });

  it('returns false without opening an attempt for a range selection', () => {
    const root = mountRoot('<p>ab</p>');
    const text = readChildText(readElement(root, 'p'), 0);
    select(createRange(text, 0, text, 2));
    const { ports, attempts } = createPorts(root);

    const changed = insertLink(ports, LINK_URL);

    expect([changed, attempts, root.innerHTML]).toEqual([false, [], '<p>ab</p>']);
  });

  it('returns false without opening an attempt during a composition and while input is stopped', () => {
    const root = mountRoot('<p>ab</p>');
    placeCaretIn(root, 'p', 1);
    const composing = createPorts(root, { isComposing: () => true });
    const stopped = createPorts(root, { isInputStopped: () => true });

    expect([
      insertLink(composing.ports, LINK_URL),
      composing.attempts,
      insertLink(stopped.ports, LINK_URL),
      stopped.attempts,
      root.innerHTML,
    ]).toEqual([false, [], false, [], '<p>ab</p>']);
  });
});

describe('failures when inserting at a position without text', () => {
  it('returns false with one diagnostic line, without throwing, when ensuring the target block throws inside the attempt', () => {
    // Place the caret in a bare run directly under the editor root, so that ensuring the target block is called.
    const root = mountRoot('ab');
    const text = readChildText(root, 0);
    select(createRange(text, 1, text, 1));
    const { ports, diagnostics, attempts } = createPorts(root, {
      ensureTargetBlock: () => {
        throw new Error('Cannot ensure the target block');
      },
    });

    const changed = insertLink(ports, LINK_URL);

    expect([changed, diagnostics.length, attempts, root.innerHTML])
      .toEqual([false, 1, [`begin:${LINK_INSERT_EDIT_KIND}`, 'abort'], 'ab']);
  });

  it('returns false without changing the tree when the attempt cannot be started', () => {
    const root = mountRoot('<p>ab</p>');
    placeCaretIn(root, 'p', 1);
    const { ports } = createPorts(root, { runCommandEdit: () => false });

    const changed = insertLink(ports, LINK_URL);

    expect([changed, root.innerHTML]).toEqual([false, '<p>ab</p>']);
  });
});
