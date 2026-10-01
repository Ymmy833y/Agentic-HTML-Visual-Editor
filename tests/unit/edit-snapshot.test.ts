import { describe, expect, it, vi } from 'vitest';

import type { DocumentBoundary } from '../../webview/document/document-boundary';
import { SerializationState } from '../../webview/document/serialization-state';
import { placeCaret } from '../../webview/editing/caret';
import { EditSnapshotCapture } from '../../webview/history/edit-snapshot';

const BOUNDARY: DocumentBoundary = {
  prologue: '<!DOCTYPE html>\n<html><body>',
  body: '\n<p>ab</p>\n',
  epilogue: '</body></html>',
};

function parse(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

function createCapture(): {
  readonly root: HTMLElement;
  readonly state: SerializationState;
  readonly capture: EditSnapshotCapture;
} {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.innerHTML = BOUNDARY.body;
  document.body.append(root);
  const state = SerializationState.create(root, BOUNDARY.body, parse(BOUNDARY.body));
  return { root, state, capture: new EditSnapshotCapture(root, BOUNDARY, state) };
}

function selectText(root: HTMLElement, start: number, end: number): void {
  const text = root.querySelector('p')?.firstChild;
  if (!(text instanceof Text)) {
    throw new Error('Could not create the text node for the test');
  }
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe('edit snapshot capture', () => {
  it('captures an in-body range as full document text and simultaneous start and end positions', () => {
    const { root, capture } = createCapture();
    selectText(root, 0, 2);

    expect(capture.captureEnd()).toEqual({
      text: '<!DOCTYPE html>\n<html><body>\n<p>ab</p>\n</body></html>',
      selection: {
        start: { line: 1, column: 3 },
        end: { line: 1, column: 5 },
      },
    });
  });

  it('pairs full document text with null for a selection outside the body', () => {
    const { capture } = createCapture();
    const outside = document.createElement('p');
    outside.textContent = 'outside';
    document.body.append(outside);
    placeCaret(outside.firstChild ?? outside, 0);

    expect(capture.captureEnd()).toEqual({
      text: '<!DOCTYPE html>\n<html><body>\n<p>ab</p>\n</body></html>',
      selection: null,
    });
  });

  it('reuses the end endpoint at the next start without rescanning when tree and selection are unchanged', () => {
    const { root, state, capture } = createCapture();
    selectText(root, 1, 1);
    const createFromCurrent = vi.spyOn(state, 'createBodyOutputFromCurrent');
    const end = capture.captureEnd();

    const start = capture.captureStart();

    expect(start).toBe(end);
    expect(createFromCurrent).toHaveBeenCalledTimes(1);
  });

  it('returns the same encoding as capturing the same range as the live selection', () => {
    const { root, capture } = createCapture();
    selectText(root, 0, 2);
    const range = window.getSelection()?.getRangeAt(0).cloneRange() ?? null;
    const captured = capture.captureEnd()?.selection;

    expect([capture.encodeSelection(range), captured === null]).toEqual([captured, false]);
  });

  it('returns null for null and for a range with an end outside the editor root', () => {
    const { capture } = createCapture();
    const outside = document.createElement('p');
    outside.textContent = 'outside';
    document.body.append(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);

    expect([capture.encodeSelection(null), capture.encodeSelection(range)]).toEqual([null, null]);
  });

  it('discards the latest endpoint and captures again after the tree or selection boundary changes', async () => {
    const { root, state, capture } = createCapture();
    selectText(root, 1, 1);
    const createFromCurrent = vi.spyOn(state, 'createBodyOutputFromCurrent');
    capture.captureEnd();

    root.querySelector('p')?.append('c');
    await Promise.resolve();
    selectText(root, 2, 2);
    const start = capture.captureStart();

    expect(start?.text).toContain('<p>abc</p>');
    expect(createFromCurrent).toHaveBeenCalledTimes(2);
  });
});
