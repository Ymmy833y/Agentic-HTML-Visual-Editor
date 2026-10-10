import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COMMENT_SIDE_KEYS,
  readCommentSideTarget,
  registerCommentSideKeys,
  switchCommentSide,
} from '../../webview/editing/comment-side';
import type { CommentSidePorts } from '../../webview/editing/comment-side';
import { attachShortcutReceiver, matchesShortcutKey } from '../../webview/editing/shortcut-receiver';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

afterEach(() => {
  vi.restoreAllMocks();
});

// A comment with characters before and after its annotated text.
const COMMENT = '<p>x<comment id="c">ab<comment-body>n</comment-body></comment>y</p>';

/**
 * Creates a collapsed range at a position.
 *
 * @param node The position's node.
 * @param offset The position's offset.
 * @returns The range.
 */
function caretAt(node: Node, offset: number): Range {
  return createRange(node, offset, node, offset);
}

/**
 * Creates the ports for switching.
 *
 * @param root The editor root.
 * @param overrides Ports to replace.
 * @returns The ports and the diagnostic record.
 */
function createPorts(root: HTMLElement, overrides: Partial<CommentSidePorts> = {}): { ports: CommentSidePorts; diagnostics: string[] } {
  const diagnostics: string[] = [];
  return {
    ports: {
      readEditorRoot: () => root,
      isComposing: () => false,
      reportDiagnostic: (detail) => {
        diagnostics.push(detail);
      },
      ...overrides,
    },
    diagnostics,
  };
}

/**
 * Reads the selection position.
 *
 * @returns The anchor node and offset.
 */
function readSelection(): unknown[] {
  const selection = window.getSelection();
  return [selection?.anchorNode, selection?.anchorOffset];
}

describe('Side target for switching the comment side', () => {
  it('→ from inside at the end returns just after the comment, and ← from just after the comment returns inside at the end (before the body)', () => {
    const root = mountRoot(COMMENT);
    const paragraph = readElement(root, 'p');
    const comment = readElement(root, 'comment');

    expect([
      readCommentSideTarget(root, caretAt(readChildText(comment, 0), 2), 'forward'),
      readCommentSideTarget(root, caretAt(paragraph, 2), 'backward'),
    ]).toEqual([{ container: paragraph, offset: 2 }, { container: comment, offset: 1 }]);
  });

  it('→ from just before the comment returns inside at the start, and ← from inside at the start returns just before the comment', () => {
    const root = mountRoot(COMMENT);
    const paragraph = readElement(root, 'p');
    const comment = readElement(root, 'comment');

    expect([
      readCommentSideTarget(root, caretAt(paragraph, 1), 'forward'),
      readCommentSideTarget(root, caretAt(readChildText(comment, 0), 0), 'backward'),
    ]).toEqual([{ container: comment, offset: 0 }, { container: paragraph, offset: 1 }]);
  });

  it('returns nothing for → just after the comment, ← just before the comment, a position that is not a comment edge, and a range selection', () => {
    const root = mountRoot(COMMENT);
    const paragraph = readElement(root, 'p');
    const text = readChildText(readElement(root, 'comment'), 0);

    expect([
      readCommentSideTarget(root, caretAt(paragraph, 2), 'forward'),
      readCommentSideTarget(root, caretAt(paragraph, 1), 'backward'),
      readCommentSideTarget(root, caretAt(text, 1), 'forward'),
      readCommentSideTarget(root, createRange(text, 0, text, 2), 'forward'),
    ]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('for a comment with empty annotated text, → returns inside from just before, and just after from inside', () => {
    const root = mountRoot('<p>x<comment id="c"><comment-body>n</comment-body></comment>y</p>');
    const paragraph = readElement(root, 'p');
    const comment = readElement(root, 'comment');

    expect([
      readCommentSideTarget(root, caretAt(paragraph, 1), 'forward'),
      readCommentSideTarget(root, caretAt(comment, 0), 'forward'),
    ]).toEqual([{ container: comment, offset: 0 }, { container: paragraph, offset: 2 }]);
  });

  it('between adjacent comments, → returns inside at the start of the following comment and ← returns inside at the end of the preceding comment', () => {
    const root = mountRoot(
      '<p><comment id="a">ab<comment-body>n</comment-body></comment>'
      + '<comment id="b">cd<comment-body>m</comment-body></comment></p>',
    );
    const paragraph = readElement(root, 'p');

    expect([
      readCommentSideTarget(root, caretAt(paragraph, 1), 'forward'),
      readCommentSideTarget(root, caretAt(paragraph, 1), 'backward'),
    ]).toEqual([{ container: readElement(root, '#b'), offset: 0 }, { container: readElement(root, '#a'), offset: 1 }]);
  });
});

describe('Switching the comment side', () => {
  it('when there is a side target, the selection moves there and "prevent default" is returned', () => {
    const root = mountRoot(COMMENT);
    select(caretAt(readChildText(readElement(root, 'comment'), 0), 2));

    const outcome = switchCommentSide('forward', createPorts(root).ports);

    expect([outcome, readSelection()]).toEqual(['preventDefault', [readElement(root, 'p'), 2]]);
  });

  it('during composition, returns "pass" without changing the selection even at a position where a switch applies', () => {
    const root = mountRoot(COMMENT);
    const text = readChildText(readElement(root, 'comment'), 0);
    select(caretAt(text, 2));

    const outcome = switchCommentSide('forward', createPorts(root, { isComposing: () => true }).ports);

    expect([outcome, readSelection()]).toEqual(['pass', [text, 2]]);
  });

  it('an exception while reading does not escape, leaves one diagnostic line, and returns "pass" without changing the selection', () => {
    const root = mountRoot(COMMENT);
    const text = readChildText(readElement(root, 'comment'), 0);
    select(caretAt(text, 2));
    const { ports, diagnostics } = createPorts(root);
    vi.spyOn(Range.prototype, 'cloneContents').mockImplementation(() => {
      throw new Error('cannot read the copy');
    });

    const outcome = switchCommentSide('forward', ports);

    expect([outcome, diagnostics.length, readSelection()]).toEqual(['pass', 1, [text, 2]]);
  });
});

describe('Key pair for switching the comment side', () => {
  it('matches unmodified ← and →, and does not match ← with Shift', () => {
    const plainLeft = new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft' });
    const plainRight = new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight' });
    const shiftLeft = new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true });

    expect([
      matchesShortcutKey(COMMENT_SIDE_KEYS.backward, plainLeft, 'other'),
      matchesShortcutKey(COMMENT_SIDE_KEYS.forward, plainRight, 'other'),
      matchesShortcutKey(COMMENT_SIDE_KEYS.backward, shiftLeft, 'other'),
    ]).toEqual([true, true, false]);
  });
});

describe('Registering the ← and → shortcuts', () => {
  it('when the registered receiver handles an unmodified →, the default and propagation are stopped at a position where a switch applies', () => {
    const root = mountRoot(COMMENT);
    const receiver = attachShortcutReceiver(root, 'other', () => undefined);
    registerCommentSideKeys(receiver, createPorts(root).ports);
    select(caretAt(readChildText(readElement(root, 'comment'), 0), 2));
    let reached = false;
    const listener = (): void => {
      reached = true;
    };
    document.addEventListener('keydown', listener);

    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true });
    root.dispatchEvent(event);
    document.removeEventListener('keydown', listener);

    expect([event.defaultPrevented, reached]).toEqual([true, false]);
  });
});
