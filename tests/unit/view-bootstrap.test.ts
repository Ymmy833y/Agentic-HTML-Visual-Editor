import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  VIEW_TO_HOST_MESSAGE_TYPE,
  splitDocument,
} from '../../common/index';
import type { HostToViewMessage, ViewToHostMessage } from '../../common/index';
import type { EditingSession } from '../../webview/editing/editing-session';
import type { WebviewWindow } from '../../webview/messaging/host-channel';
import { OVERLAY_ELEMENT_ID } from '../../webview/ui/overlay-presenter';

const OPENABLE_DOCUMENT = '<!DOCTYPE html>\n<html>\n<body>\n<p>a</p>\n</body>\n</html>\n';

const FORBIDDEN_TAG_DOCUMENT = '<html>\n<body>\n<script>a</script>\n</body>\n</html>\n';

// Use empty strings for the base URIs. This layer covers boundaries and editability and does not
// need resolution.
function initialize(text: string): HostToViewMessage {
  return {
    type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
    text,
    documentUri: '',
    resourceRootUri: '',
  };
}

interface StartedView {
  readonly deliver: (message: HostToViewMessage) => void;
  readonly createBodyOutput: () => { readonly body: string; readonly current: string } | undefined;
  readonly readDocumentBoundary: () => ReturnType<typeof splitDocument>;
  readonly readEditorRoot: () => HTMLElement | null;
  readonly readEditingSession: () => EditingSession | undefined;
  readonly replaceDocument: (text: string) => boolean;
  readonly readOverlay: () => HTMLElement | null;
  /** Messages sent to the host, in send order. */
  readonly posted: ViewToHostMessage[];
  /** Fires the unload trigger. */
  readonly firePagehide: () => void;
  /** Makes inert document creation fail to simulate an unexpected serialization failure. */
  readonly breakBodyOutput: () => void;
  /** Fails only the next delivery of the specified type. */
  readonly failNextType: (type: string) => void;
}

/**
 * Creates one started view.
 *
 * The entry point uses only 5 things: acquiring the API, registering listeners, the document,
 * waiting for a frame, and the user agent. So a container holding only those 5 is passed.
 * Reusing the jsdom window would retain the receiver registered by the previous test and cause
 * interference.
 */
async function startView(): Promise<StartedView> {
  const view = document.implementation.createHTMLDocument('');
  view.body.innerHTML = `<div id="${EDITOR_ROOT_ELEMENT_ID}"></div>`;

  const listeners: ((event: MessageEvent<HostToViewMessage>) => void)[] = [];
  const unloadListeners: (() => void)[] = [];
  const posted: ViewToHostMessage[] = [];
  const failingTypes = new Set<string>();
  const stub = {
    document: view,
    // The caret follow schedules its coalescing wait as a one-frame wait. What this layer checks is
    // startup and the save round trip, not the arrival of frames, so only accepting the request is
    // simulated and the callback is never invoked.
    requestAnimationFrame: () => 0,
    // Read only to decide the shortcut receiver's platform. What this layer checks, startup and the
    // save round trip, does not depend on the platform, so an empty value is enough.
    navigator: { userAgent: '' },
    acquireVsCodeApi: () => ({
      postMessage: (message: ViewToHostMessage): void => {
        if (failingTypes.delete(message.type)) {
          throw new Error(`Delivery failed: ${message.type}`);
        }
        posted.push(message);
      },
    }),
    // Startup subscribes to host messages and unload. Retain them separately by type so delivery from
    // the host does not also invoke the unload subscription.
    addEventListener: (type: string, listener: (event: MessageEvent<HostToViewMessage>) => void): void => {
      if (type === 'message') {
        listeners.push(listener);
        return;
      }
      if (type === 'pagehide') {
        unloadListeners.push(listener as unknown as () => void);
      }
    },
  };

  // The retained boundary is module state, so reload the module for every test and start empty.
  vi.resetModules();
  const bootstrap = await import('../../webview/bootstrap/view-bootstrap');
  bootstrap.startView(stub as unknown as WebviewWindow);

  return {
    deliver: (message) => {
      for (const listener of listeners) {
        listener({ data: message } as MessageEvent<HostToViewMessage>);
      }
    },
    createBodyOutput: bootstrap.createBodyOutput,
    readDocumentBoundary: bootstrap.readDocumentBoundary,
    readEditorRoot: () => view.getElementById(EDITOR_ROOT_ELEMENT_ID),
    readEditingSession: bootstrap.readEditingSession,
    replaceDocument: bootstrap.replaceDocument,
    readOverlay: () => view.getElementById(OVERLAY_ELEMENT_ID),
    posted,
    firePagehide: () => {
      for (const listener of unloadListeners) {
        listener();
      }
    },
    breakBodyOutput: () => {
      view.implementation.createHTMLDocument = (): Document => {
        throw new Error('Failed to create an inert document');
      };
    },
    failNextType: (type) => failingTypes.add(type),
  };
}

// Transforming the modules behind the bootstrap for the first time takes several seconds even on its own. Only
// the first test to run pays that cost, and running the 3 layers at once pushes it past the default 5 seconds
// and fails, so it is imported once up front with a longer time limit. Each test's re-import then uses the
// already transformed modules.
const BOOTSTRAP_IMPORT_TIMEOUT_MS = 30_000;

beforeAll(async () => {
  // Startup only needs to subscribe; label layout is exercised in the browser tests.
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
  });
  await import('../../webview/bootstrap/view-bootstrap');
}, BOOTSTRAP_IMPORT_TIMEOUT_MS);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('view startup', () => {
  it('retains a determined boundary that matches the split result', async () => {
    const view = await startView();

    view.deliver(initialize(OPENABLE_DOCUMENT));

    expect(view.readDocumentBoundary()).toEqual(splitDocument(OPENABLE_DOCUMENT));
  });

  it('retains no boundary for a document whose boundary cannot be determined', async () => {
    const view = await startView();

    view.deliver(initialize(''));

    expect(view.readDocumentBoundary()).toBeUndefined();
  });

  it('does not replace the determined boundary on a second initialize message', async () => {
    const view = await startView();
    view.deliver(initialize(OPENABLE_DOCUMENT));

    view.deliver(initialize('<html><body>b</body></html>'));

    expect(view.readDocumentBoundary()).toEqual(splitDocument(OPENABLE_DOCUMENT));
  });

  it('retains no boundary for a document containing a forbidden tag', async () => {
    const view = await startView();

    view.deliver(initialize(FORBIDDEN_TAG_DOCUMENT));

    expect(view.readDocumentBoundary()).toBeUndefined();
  });

  it('does not make the editor root editable for a document containing a forbidden tag', async () => {
    const view = await startView();

    view.deliver(initialize(FORBIDDEN_TAG_DOCUMENT));

    expect(view.readEditorRoot()?.contentEditable).not.toBe('true');
  });

  it('returns an output equal to the disk body after a successful mount', async () => {
    const view = await startView();

    view.deliver(initialize(OPENABLE_DOCUMENT));

    expect(view.createBodyOutput()?.body).toBe('\n<p>a</p>\n');
  });

  it('returns no output for a document that cannot be opened', async () => {
    const view = await startView();

    view.deliver(initialize(FORBIDDEN_TAG_DOCUMENT));

    expect(view.createBodyOutput()).toBeUndefined();
  });

  it('returns an editing session after mounting an openable document', async () => {
    const view = await startView();

    view.deliver(initialize(OPENABLE_DOCUMENT));

    expect(view.readEditingSession()).toBeDefined();
  });

  it('returns no editing session for an unopenable document', async () => {
    const view = await startView();

    view.deliver(initialize(FORBIDDEN_TAG_DOCUMENT));

    expect(view.readEditingSession()).toBeUndefined();
  });

  it('fails to mount and sends nothing to the host when the document boundary is undetermined', async () => {
    const view = await startView();

    view.deliver(initialize(''));

    // Only the startup view ready message remains. No unsaved content sender is created for an
    // unopenable document, so nothing is added afterward.
    expect(view.posted).toEqual([{ type: VIEW_TO_HOST_MESSAGE_TYPE.viewReady }]);
  });

  it('logs and drops a restore completion with no reason waiting for it, even while input is stopped for another reason', async () => {
    const view = await startView();
    // The protection stops input under a reason of its own, separate from the restore. Being
    // stopped is not in itself evidence that a restore completion is being awaited.
    view.deliver({ type: HOST_TO_VIEW_MESSAGE_TYPE.historyProtectionActivated });

    view.deliver({ type: HOST_TO_VIEW_MESSAGE_TYPE.restoreCompleted });

    expect(view.posted.at(-1)).toEqual({
      type: VIEW_TO_HOST_MESSAGE_TYPE.viewDiagnostic,
      detail: expect.stringContaining('no input stop is waiting for'),
    });
  });

  it('sends one diagnostic line to the host when flushing on unload fails', async () => {
    const view = await startView();
    view.deliver(initialize(OPENABLE_DOCUMENT));
    view.readEditingSession()?.notifyChange('insertText');

    view.breakBodyOutput();
    view.firePagehide();

    expect(view.posted.at(-1)).toEqual({
      type: VIEW_TO_HOST_MESSAGE_TYPE.viewDiagnostic,
      detail: expect.stringContaining('Failed to flush pending changes on unload'),
    });
  });

  it('sends unsaved content and finally disposes history state even when history delivery fails', async () => {
    const view = await startView();
    view.deliver(initialize(OPENABLE_DOCUMENT));
    const session = view.readEditingSession();
    const paragraph = view.readEditorRoot()?.querySelector('p');
    if (session === undefined || paragraph === null || paragraph === undefined) {
      throw new Error('Could not start the editing session');
    }
    view.failNextType(VIEW_TO_HOST_MESSAGE_TYPE.editTransaction);
    session.runCommandEdit('appendCommand', () => {
      paragraph.append('b');
      return true;
    });
    // Create the unsent queue by failing a standalone edit's first delivery, then fail its unload retry separately.
    view.failNextType(VIEW_TO_HOST_MESSAGE_TYPE.editTransaction);

    view.firePagehide();

    expect(view.posted.some((message) => (
      message.type === VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent
      && message.text.includes('<p>ab</p>')
    ))).toBe(true);
    const historyDiagnostic = view.posted.find((message) => (
      message.type === VIEW_TO_HOST_MESSAGE_TYPE.viewDiagnostic
      && message.detail.includes('edit transaction')
    ));
    expect(historyDiagnostic, JSON.stringify(view.posted)).toBeDefined();
  });

  it('responds only to the replacement request when a different new flush request arrives', async () => {
    const view = await startView();
    view.deliver(initialize(OPENABLE_DOCUMENT));
    const root = view.readEditorRoot();
    const paragraph = root?.querySelector('p');
    if (root === null || paragraph === null || paragraph === undefined) {
      throw new Error('Could not start the editor root');
    }
    root.dispatchEvent(new CompositionEvent('compositionstart'));
    view.deliver({
      type: HOST_TO_VIEW_MESSAGE_TYPE.requestEditTransactionFlush,
      requestId: 'old',
    });
    view.deliver({
      type: HOST_TO_VIEW_MESSAGE_TYPE.requestEditTransactionFlush,
      requestId: 'new',
    });

    paragraph.append('b');
    root.dispatchEvent(new CompositionEvent('compositionend', { data: 'b' }));
    await vi.waitFor(() => {
      expect(view.posted.filter((message) => (
        message.type === VIEW_TO_HOST_MESSAGE_TYPE.editTransactionFlushResult
      ))).toHaveLength(1);
    });

    expect(view.posted.filter((message) => (
      message.type === VIEW_TO_HOST_MESSAGE_TYPE.editTransactionFlushResult
    ))).toEqual([{
      type: VIEW_TO_HOST_MESSAGE_TYPE.editTransactionFlushResult,
      requestId: 'new',
      success: true,
    }]);
  });
});

describe('document replacement', () => {
  const REPLACEMENT = '<!DOCTYPE html>\n<html lang="fr">\n<body>\n<p>b</p>\n</body>\n</html>\n';
  const REPLACED_BODY = '\n<p>b</p>\n';

  it('does not replace the document before the initial mount', async () => {
    const view = await startView();

    expect(view.replaceDocument(REPLACEMENT)).toBe(false);
  });

  it('does not change the tree when called before the initial mount', async () => {
    const view = await startView();

    view.replaceDocument(REPLACEMENT);

    expect(view.readEditorRoot()?.innerHTML).toBe('');
  });

  it('does not determine a boundary when called before the initial mount', async () => {
    const view = await startView();

    view.replaceDocument(REPLACEMENT);

    expect(view.readDocumentBoundary()).toBeUndefined();
  });

  it('replaces the editor root children with the new body', async () => {
    const view = await startView();
    view.deliver(initialize(OPENABLE_DOCUMENT));

    view.replaceDocument(REPLACEMENT);

    expect(view.readEditorRoot()?.innerHTML).toBe(REPLACED_BODY);
  });

  it('replaces the current form in the output with the new text', async () => {
    const view = await startView();
    view.deliver(initialize(OPENABLE_DOCUMENT));

    view.replaceDocument(REPLACEMENT);

    expect(view.createBodyOutput()?.current).toBe(REPLACED_BODY);
  });

  it('applies the new prologue language declaration to the editor root lang', async () => {
    const view = await startView();
    view.deliver(initialize(OPENABLE_DOCUMENT));

    view.replaceDocument(REPLACEMENT);

    expect(view.readEditorRoot()?.getAttribute('lang')).toBe('fr');
  });

  it('does not replace the document with text whose boundary cannot be determined', async () => {
    const view = await startView();
    view.deliver(initialize(OPENABLE_DOCUMENT));

    expect(view.replaceDocument('')).toBe(false);
  });

  it('retains the previous body for text whose boundary cannot be determined', async () => {
    const view = await startView();
    view.deliver(initialize(OPENABLE_DOCUMENT));
    view.replaceDocument(REPLACEMENT);

    view.replaceDocument('');

    expect(view.readEditorRoot()?.innerHTML).toBe(REPLACED_BODY);
  });

  it('retains the previous lang for text whose boundary cannot be determined', async () => {
    const view = await startView();
    view.deliver(initialize(OPENABLE_DOCUMENT));
    view.replaceDocument(REPLACEMENT);

    view.replaceDocument('');

    expect(view.readEditorRoot()?.getAttribute('lang')).toBe('fr');
  });

  it('does not replace the document with text containing a forbidden tag', async () => {
    const view = await startView();
    view.deliver(initialize(OPENABLE_DOCUMENT));

    expect(view.replaceDocument(FORBIDDEN_TAG_DOCUMENT)).toBe(false);
  });

  it('retains the previous body for text containing a forbidden tag', async () => {
    const view = await startView();
    view.deliver(initialize(OPENABLE_DOCUMENT));

    view.replaceDocument(FORBIDDEN_TAG_DOCUMENT);

    expect(view.readEditorRoot()?.innerHTML).toBe('\n<p>a</p>\n');
  });

  it('does not show an overlay for replacement text containing a forbidden tag', async () => {
    const view = await startView();
    view.deliver(initialize(OPENABLE_DOCUMENT));

    view.replaceDocument(FORBIDDEN_TAG_DOCUMENT);

    expect(view.readOverlay()).toBeNull();
  });
});

// The candidate has one extra line from a later source change. The recorded selection, used as is, points at a
// different line.
const HISTORY_TARGET = '<!DOCTYPE html>\n<html>\n<body>\n<p>target</p>\n</body>\n</html>\n';
const HISTORY_CANDIDATE =
  '<!DOCTYPE html>\n<html>\n<body>\n<p>x</p>\n<p>target</p>\n</body>\n</html>\n';

describe('history application port', () => {
  it('remaps through the history application port before calling replacement with selection restore', async () => {
    const view = await startView();
    view.deliver(initialize(OPENABLE_DOCUMENT));

    view.deliver({
      type: HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument,
      requestId: 'history-1',
      kind: 'editHistory',
      text: HISTORY_CANDIDATE,
      targetText: HISTORY_TARGET,
      targetSelection: { start: { line: 1, column: 3 }, end: { line: 1, column: 9 } },
      editRange: { start: 3, count: 1 },
    });
    await vi.waitFor(() => expect(view.posted).toContainEqual(expect.objectContaining({
      type: VIEW_TO_HOST_MESSAGE_TYPE.documentReplaced,
      requestId: 'history-1',
      outcome: 'applied',
    })));

    // It is replaced with the candidate's body, not the recorded endpoint's full text.
    expect(view.readEditorRoot()?.innerHTML).toContain('<p>x</p>');
  });
});
