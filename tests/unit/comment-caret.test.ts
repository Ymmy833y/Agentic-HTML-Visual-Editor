import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COMMENT_CARET_MARK_NAME,
  COMMENT_CARET_MARK_NAMESPACE,
  CommentCaret,
  attachCommentCaret,
  readCommentCaretColor,
} from '../../webview/ui/comment-caret';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

// The bundled stylesheet. This file sits alongside tests that use the selection, so it runs in jsdom and the read helper that relies on import.meta.url cannot be used.
const DOCUMENT_STYLES_PATH = path.resolve(__dirname, '../../webview/ui/document-styles.css');

// Stylesheet comments (/* */). Removed first so the same spelling inside rule explanations is not picked up.
const STYLESHEET_COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;

// A paragraph with one human-thread comment and one AI-thread comment.
const TWO_THREADS = '<p>x<comment id="h">ab<comment-body data-author="human">n</comment-body></comment>'
  + '<comment id="a">cd<comment-body data-author="ai">m</comment-body></comment>y</p>';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Places a collapsed selection at a position.
 *
 * @param node The position's node.
 * @param offset The position's offset.
 */
function placeAt(node: Node, offset: number): void {
  select(createRange(node, offset, node, offset));
}

/**
 * Reads the value of the mark on the editor root.
 *
 * @param root The editor root.
 * @returns The mark value. `null` if none.
 */
function readMark(root: Element): string | null {
  return root.getAttributeNS(COMMENT_CARET_MARK_NAMESPACE, COMMENT_CARET_MARK_NAME);
}

/**
 * Reads the declarations of the rule for a mark value from the bundled stylesheet.
 *
 * @param value The mark value.
 * @returns The declarations. Empty if there is no rule.
 */
function readCaretRule(value: string): string[] {
  const stylesheet = fs.readFileSync(DOCUMENT_STYLES_PATH, 'utf8');
  const pattern = new RegExp(`#editor-root\\[\\*\\|${COMMENT_CARET_MARK_NAME}="${value}"\\]\\s*\\{([^}]*)\\}`);
  const match = pattern.exec(stylesheet.replace(STYLESHEET_COMMENT_PATTERN, ''));
  return (match?.[1] ?? '').split(';').map((declaration) => declaration.trim()).filter((declaration) => declaration !== '');
}

describe('Reading the inside color', () => {
  it('returns ai inside the annotated text of a thread whose first entry is AI, and human for a human one', () => {
    const root = mountRoot(TWO_THREADS);
    placeAt(readChildText(readElement(root, '#a'), 0), 1);
    const ai = readCommentCaretColor(root);
    placeAt(readChildText(readElement(root, '#h'), 0), 1);
    const human = readCommentCaretColor(root);

    expect([ai, human]).toEqual(['ai', 'human']);
  });

  it('returns human for a comment without entries and for a comment starting with an entry whose author is uppercase AI', () => {
    const root = mountRoot(
      '<p><comment id="e">ab</comment><comment id="u">cd<comment-body data-author="AI">n</comment-body></comment></p>',
    );
    placeAt(readChildText(readElement(root, '#e'), 0), 1);
    const empty = readCommentCaretColor(root);
    placeAt(readChildText(readElement(root, '#u'), 0), 1);
    const uppercase = readCommentCaretColor(root);

    expect([empty, uppercase]).toEqual(['human', 'human']);
  });

  it('returns nothing at the outside neighbor of a comment, for a range selection, and for a selection outside the editor root', () => {
    const root = mountRoot(TWO_THREADS);
    const outside = document.createElement('p');
    outside.textContent = 'outside';
    document.body.append(outside);
    const annotated = readChildText(readElement(root, '#a'), 0);

    placeAt(readElement(root, 'p'), 3);
    const neighbor = readCommentCaretColor(root);
    select(createRange(annotated, 0, annotated, 1));
    const ranged = readCommentCaretColor(root);
    placeAt(readChildText(outside, 0), 1);
    const elsewhere = readCommentCaretColor(root);

    expect([neighbor, ranged, elsewhere]).toEqual([undefined, undefined, undefined]);
  });

  it('with (hand-written) nesting, is decided by the thread author of the inner comment', () => {
    const root = mountRoot(
      '<p><comment id="o">a<comment id="i">b<comment-body data-author="human">n</comment-body></comment>'
      + '<comment-body data-author="ai">m</comment-body></comment></p>',
    );
    placeAt(readChildText(readElement(root, '#i'), 0), 1);

    expect(readCommentCaretColor(root)).toBe('human');
  });
});

describe('Setting and removing the mark', () => {
  it('when the color is ai, the editor root gets the internal-namespace mark with that value, and it is removed by the evaluation after the caret leaves', () => {
    const root = mountRoot(TWO_THREADS);
    const caret = new CommentCaret(window, { readEditorRoot: () => root, reportDiagnostic: () => undefined });
    placeAt(readChildText(readElement(root, '#a'), 0), 1);
    caret.evaluate();
    const inside = readMark(root);
    placeAt(readChildText(readElement(root, 'p'), 0), 1);
    caret.evaluate();

    expect([inside, readMark(root), root.hasAttribute(COMMENT_CARET_MARK_NAME)]).toEqual(['ai', null, false]);
  });

  it('an exception while reading does not escape, leaves one diagnostic line, and removes the mark', () => {
    const root = mountRoot(TWO_THREADS);
    const diagnostics: string[] = [];
    const caret = new CommentCaret(window, { readEditorRoot: () => root, reportDiagnostic: (detail) => diagnostics.push(detail) });
    placeAt(readChildText(readElement(root, '#a'), 0), 1);
    caret.evaluate();
    vi.spyOn(window, 'getSelection').mockImplementation(() => {
      throw new Error('cannot read the selection');
    });

    caret.evaluate();

    expect([diagnostics.length, readMark(root)]).toEqual([1, null]);
  });
});

describe('Batching selection changes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('even if three selection changes arrive within one frame, evaluation runs only once in the next frame', () => {
    const root = mountRoot(TWO_THREADS);
    const caret = new CommentCaret(window, { readEditorRoot: () => root, reportDiagnostic: () => undefined });
    const evaluate = vi.spyOn(caret, 'evaluate');

    caret.handleSelectionChange();
    caret.handleSelectionChange();
    caret.handleSelectionChange();
    const beforeFrame = evaluate.mock.calls.length;
    vi.advanceTimersToNextFrame();

    expect([beforeFrame, evaluate.mock.calls.length]).toEqual([0, 1]);
  });

  it('after attaching, a selectionchange on the document schedules an evaluation', () => {
    const root = mountRoot(TWO_THREADS);
    attachCommentCaret(window, { readEditorRoot: () => root, reportDiagnostic: () => undefined });
    placeAt(readChildText(readElement(root, '#a'), 0), 1);

    document.dispatchEvent(new Event('selectionchange'));
    const beforeFrame = readMark(root);
    vi.advanceTimersToNextFrame();

    expect([beforeFrame, readMark(root)]).toEqual([null, 'ai']);
  });
});

describe('Caret color rules', () => {
  it('the rule for the human mark references only --ahve-comment-mark in caret-color without a priority override', () => {
    expect(readCaretRule('human')).toEqual(['caret-color: var(--ahve-comment-mark)']);
  });

  it('the rule for the ai mark references only --ahve-comment-ai in caret-color without a priority override', () => {
    expect(readCaretRule('ai')).toEqual(['caret-color: var(--ahve-comment-ai)']);
  });
});
