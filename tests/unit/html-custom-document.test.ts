// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type * as vscode from 'vscode';

import { HtmlCustomDocument } from '../../src/editor/html-custom-document';

/**
 * Creates a document that exposes only its last known content.
 *
 * The document only retains the URI and never reads it, so pass an object that merely holds a URI
 * value and verify retention and disposal without starting VS Code.
 */
function createDocument(): HtmlCustomDocument {
  return new HtmlCustomDocument({ toString: () => 'file:///a.html' } as unknown as vscode.Uri);
}

const CONTENT = '<!DOCTYPE html>\n<html>\n<body>\n<p>ab</p>\n</body>\n</html>\n';

describe('last known content retention', () => {
  it('keeps the history URI and the source URI separately', () => {
    const editorUri = { toString: () => 'file:///a.html?ahve-editor=wrapped' } as unknown as vscode.Uri;
    const sourceUri = { toString: () => 'file:///a.html' } as unknown as vscode.Uri;
    const document = new HtmlCustomDocument(editorUri, sourceUri);

    expect(document.uri).toBe(editorUri);
    expect(document.sourceUri).toBe(sourceUri);
    document.dispose();
  });
  it('sets the last known content to the provided unsaved content', () => {
    const document = createDocument();

    document.retainUnsavedContent(CONTENT);

    expect(document.lastKnownContent).toBe(CONTENT);
  });

  it('retains only the second item when two are provided in sequence', () => {
    const document = createDocument();
    document.retainUnsavedContent(CONTENT);

    document.retainUnsavedContent('<html><body>later</body></html>');

    expect(document.lastKnownContent).toBe('<html><body>later</body></html>');
  });

  it('clears the last known content on disposal and does not throw on a second disposal', () => {
    const document = createDocument();
    document.retainUnsavedContent(CONTENT);

    document.dispose();
    document.dispose();

    expect(document.lastKnownContent).toBeUndefined();
  });

  it('reports false before disposal and true after disposal', () => {
    const document = createDocument();

    const before = document.isDisposed;
    document.dispose();

    expect([before, document.isDisposed]).toEqual([false, true]);
  });
});

describe('clearing the last known content', () => {
  it('leaves no last known content after clearing and still accepts a later retain', () => {
    const document = createDocument();
    document.retainUnsavedContent(CONTENT);

    document.clearUnsavedContent();
    const afterClearing = document.lastKnownContent;
    document.retainUnsavedContent(CONTENT);

    expect([afterClearing, document.lastKnownContent]).toEqual([undefined, CONTENT]);
  });

  it('does nothing when clearing an already disposed document', () => {
    const document = createDocument();
    document.dispose();

    expect(() => document.clearUnsavedContent()).not.toThrow();
  });
});

describe('change notifications to the backup', () => {
  it('notifies the values after each retain, clear, and merge base update, and stops notifying after unsubscribing', () => {
    const document = createDocument();
    const observed: [string | undefined, string | undefined][] = [];
    const unsubscribe = document.subscribeBackupChanges({
      onChange: () => observed.push([document.lastKnownContent, document.syncState.mergeBase]),
      onDispose: () => undefined,
    });

    document.retainUnsavedContent(CONTENT);
    document.syncState.initialize('<html><body>base</body></html>');
    document.clearUnsavedContent();
    unsubscribe();
    document.retainUnsavedContent('<html><body>later</body></html>');

    expect(observed).toEqual([
      [CONTENT, undefined],
      [CONTENT, '<html><body>base</body></html>'],
      [undefined, '<html><body>base</body></html>'],
    ]);
  });

  it('sends the disposal notification exactly once before clearing the retained copy, and ends the subscription', () => {
    const document = createDocument();
    document.retainUnsavedContent(CONTENT);
    const events: string[] = [];
    document.subscribeBackupChanges({
      onChange: () => events.push('change'),
      onDispose: () => events.push(`dispose:${document.lastKnownContent ?? 'none'}`),
    });

    document.dispose();
    document.dispose();
    document.syncState.initialize('<html><body>base</body></html>');

    expect(events).toEqual([`dispose:${CONTENT}`]);
  });
});
