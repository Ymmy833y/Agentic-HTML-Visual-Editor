// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type * as vscode from 'vscode';

import type { InternalErrorSink } from '../../src/diagnostics/error-reporter';
import type { HtmlCustomDocument } from '../../src/editor/html-custom-document';
import { SessionRegistry } from '../../src/session/session-registry';

interface RecordingSink extends InternalErrorSink {
  readonly lines: string[];
}

/** Creates an internal error sink that only records received lines. */
function createSink(): RecordingSink {
  const lines: string[] = [];
  return { lines, reportInternalError: (detail) => lines.push(detail) };
}

/**
 * Inspects registration without launching VS Code, keeping the history URI and the source URI apart.
 *
 * @param uri The source URI used as the registration key.
 */
function createDocument(uri: string): HtmlCustomDocument {
  return {
    uri: { toString: () => uri + '?ahve-editor=wrapped' },
    sourceUri: { toString: () => uri },
  } as unknown as HtmlCustomDocument;
}

/**
 * Creates a panel that simulates only subscriptions and active state.
 *
 * The registry calls only the two subscription methods and reads `active`. The subscription methods
 * only need to return disposables, so they return no-op disposables.
 */
function createPanel(): vscode.WebviewPanel {
  const subscribe = (): vscode.Disposable => ({ dispose: (): void => undefined });
  return { active: false, onDidChangeViewState: subscribe, onDidDispose: subscribe } as unknown as vscode.WebviewPanel;
}

describe('session registration', () => {
  it('uses the source URI, not the history URI, for registration, the session URI, and inspection', () => {
    const registry = new SessionRegistry(createSink());
    const document = createDocument('file:///a.html');
    const session = registry.register(document, createPanel());

    expect(registry.findSession('file:///a.html')).toBe(session);
    expect(registry.findSession(document.uri.toString())).toBeUndefined();
    expect(session.documentUri).toBe(document.sourceUri);
    expect(registry.readInspection().documentUris).toEqual(['file:///a.html']);
    registry.dispose();
  });
  it('records a replacement as an internal error when the same document is registered twice', () => {
    const sink = createSink();
    const registry = new SessionRegistry(sink);
    registry.register(createDocument('file:///a.html'), createPanel());

    registry.register(createDocument('file:///a.html'), createPanel());

    expect(sink.lines).toHaveLength(1);
  });

  it('does not record an internal error when different documents are registered in sequence', () => {
    const sink = createSink();
    const registry = new SessionRegistry(sink);

    registry.register(createDocument('file:///a.html'), createPanel());
    registry.register(createDocument('file:///b.html'), createPanel());

    expect(sink.lines).toEqual([]);
  });
});
