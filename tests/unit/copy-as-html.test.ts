// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as vscode from 'vscode';

import { RESPONSE_TIMEOUT_MS, VIEW_TO_HOST_MESSAGE_TYPE, createLocalizer } from '../../common/index';
import type { CopyHtmlResponseMessage, RequestCopyHtmlMessage, RequestId } from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import {
  CopyHtmlRequester,
  copyCodeBlockText,
  copySenderAsHtml,
  copySessionAsHtml,
} from '../../src/clipboard/copy-as-html';
import type { CopyAsHtmlPorts, CopyHtmlOutcome } from '../../src/clipboard/copy-as-html';
import { ErrorReporter } from '../../src/diagnostics/error-reporter';
import type { HtmlCustomDocument } from '../../src/editor/html-custom-document';
import { WysiwygSession } from '../../src/session/wysiwyg-session';

const FAILED_MESSAGE = englishMessages['copyAsHtml.failed.message'];
const CODE_FAILED_MESSAGE = englishMessages['codeBlockCopy.failed.message'];

interface RequesterHarness {
  readonly requester: CopyHtmlRequester;
  /** Request copy HTML messages sent to the view, in the order sent. */
  readonly requests: RequestCopyHtmlMessage[];
  /** Lines the requester logged. */
  readonly lines: string[];
}

interface CopyHarness {
  readonly ports: CopyAsHtmlPorts;
  readonly reporter: ErrorReporter;
  /** Calls to the write and show ports, in the order called. */
  readonly trace: unknown[][];
  /** Strings passed to the write port, in the order passed. */
  readonly written: string[];
}

/**
 * Creates a requester that records the request copy HTML messages it sends.
 *
 * @param post The result the send port returns. When omitted, sending succeeds.
 */
function createRequesterHarness(post: () => Promise<void> = () => Promise.resolve()): RequesterHarness {
  const requests: RequestCopyHtmlMessage[] = [];
  const lines: string[] = [];
  const requester = new CopyHtmlRequester(
    (message) => {
      requests.push(message);
      return post();
    },
    { reportInternalError: (detail) => lines.push(detail) },
  );
  return { requester, requests, lines };
}

/**
 * Creates ports that record calls to the write and show ports.
 *
 * @param write The result the write port returns. When omitted, writing succeeds.
 */
function createCopyHarness(write: () => Promise<void> = () => Promise.resolve()): CopyHarness {
  const trace: unknown[][] = [];
  const written: string[] = [];
  const localizer = createLocalizer(englishMessages);
  const reporter = new ErrorReporter(
    { appendLine: (): void => undefined, show: (): void => undefined },
    {
      showMessage: (): PromiseLike<string | undefined> => Promise.resolve(undefined),
      showInformation: (): PromiseLike<string | undefined> => Promise.resolve(undefined),
    },
    localizer,
    true,
  );
  return {
    reporter,
    trace,
    written,
    ports: {
      writeClipboard: (text) => {
        trace.push(['write', text]);
        written.push(text);
        return write();
      },
      showStatus: (message, timeoutMs) => {
        trace.push(['status', message, timeoutMs]);
      },
      errorReporter: reporter,
      localizer,
    },
  };
}

/**
 * Creates a copy succeeded port that records each call in the harness trace.
 *
 * @param copy The harness whose trace records the calls.
 * @param send The result the port returns. When omitted, sending succeeds.
 */
function createSucceededPort(
  copy: CopyHarness,
  send: () => Promise<void> = () => Promise.resolve(),
): () => Promise<void> {
  return () => {
    copy.trace.push(['succeeded']);
    return send();
  };
}

/**
 * Creates a session without launching VS Code.
 *
 * Copying reads only the requester and the document URI from the session, so the document is replaced by a value with
 * only that shape, and the panel by an empty value.
 *
 * @param requester The requester to hand over. When omitted, none is handed over.
 */
function createSession(requester?: CopyHtmlRequester): WysiwygSession {
  const document = { sourceUri: { toString: () => 'file:///a.html' } } as unknown as HtmlCustomDocument;
  const session = new WysiwygSession(document, {} as unknown as vscode.WebviewPanel);
  if (requester !== undefined) {
    session.setCopyHtmlRequester(requester);
  }
  return session;
}

/**
 * Creates a copy HTML response.
 *
 * @param requestId The request id of the request being answered.
 * @param html The HTML form to carry, or `null` when it cannot be created.
 */
function createResponse(requestId: RequestId, html: string | null): CopyHtmlResponseMessage {
  return { type: VIEW_TO_HOST_MESSAGE_TYPE.copyHtmlResponse, requestId, html };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('identifying the sender session', () => {
  it('without a sender session, sends no request, logs exactly one line, and neither notifies, writes the clipboard, nor tells the view', async () => {
    const copy = createCopyHarness();

    await copySenderAsHtml(undefined, 'file:///a.html', copy.ports, createSucceededPort(copy));

    const inspection = copy.reporter.readInspection();
    expect([inspection.logLines.length, inspection.notifications, copy.trace]).toEqual([1, [], []]);
  });
});

describe('telling the sender view that the copy succeeded', () => {
  it('on the toolbar path, calls the copy succeeded port once after writing and showing success in the status bar', async () => {
    const view = createRequesterHarness();
    const copy = createCopyHarness();

    const done = copySenderAsHtml(
      createSession(view.requester),
      'file:///a.html',
      copy.ports,
      createSucceededPort(copy),
    );
    view.requester.settle(createResponse(view.requests[0].requestId, '<p>a</p>'));
    await done;

    expect(copy.trace).toEqual([['write', '<p>a</p>'], ['status', 'Copied as HTML', 2000], ['succeeded']]);
  });

  it('on the toolbar path, does not call the copy succeeded port when the write is rejected', async () => {
    const view = createRequesterHarness();
    const copy = createCopyHarness(() => Promise.reject(new Error('the clipboard is unavailable')));

    const done = copySenderAsHtml(
      createSession(view.requester),
      'file:///a.html',
      copy.ports,
      createSucceededPort(copy),
    );
    view.requester.settle(createResponse(view.requests[0].requestId, '<p>a</p>'));
    await done;

    expect(copy.trace).toEqual([['write', '<p>a</p>']]);
  });

  it('on the toolbar path, does not call the copy succeeded port when the view responds that it cannot create the HTML', async () => {
    const view = createRequesterHarness();
    const copy = createCopyHarness();

    const done = copySenderAsHtml(
      createSession(view.requester),
      'file:///a.html',
      copy.ports,
      createSucceededPort(copy),
    );
    view.requester.settle(createResponse(view.requests[0].requestId, null));
    await done;

    expect(copy.trace).toEqual([]);
  });

  it('shows no notification and logs one line when the copy succeeded port rejects', async () => {
    const view = createRequesterHarness();
    const copy = createCopyHarness();
    const succeeded = createSucceededPort(copy, () => Promise.reject(new Error('the webview is disposed')));

    const done = copySenderAsHtml(createSession(view.requester), 'file:///a.html', copy.ports, succeeded);
    view.requester.settle(createResponse(view.requests[0].requestId, '<p>a</p>'));
    await done;

    const inspection = copy.reporter.readInspection();
    expect([inspection.notifications, inspection.logLines.length]).toEqual([[], 1]);
  });
});

describe('the copy HTML request', () => {
  it('returns the string as the outcome when a response with the HTML form arrives', async () => {
    const view = createRequesterHarness();

    const outcome = view.requester.request();
    view.requester.settle(createResponse(view.requests[0].requestId, '<p>a</p>'));

    expect(await outcome).toEqual({ ok: true, html: '<p>a</p>' });
  });

  it('returns a failure caused by the HTML not being creatable when a response with a null html arrives', async () => {
    const view = createRequesterHarness();

    const outcome = view.requester.request();
    view.requester.settle(createResponse(view.requests[0].requestId, null));

    expect(await outcome).toEqual({ ok: false, cause: expect.stringContaining('could not create') });
  });

  it('returns a failure caused by a value outside the contract when html is neither a string nor null', async () => {
    const view = createRequesterHarness();

    const outcome = view.requester.request();
    // The type is limited to a string or null, but at runtime the view can send any value. The type assertion is
    // dropped to create such a value.
    view.requester.settle({
      type: VIEW_TO_HOST_MESSAGE_TYPE.copyHtmlResponse,
      requestId: view.requests[0].requestId,
      html: 1,
    } as unknown as CopyHtmlResponseMessage);

    expect(await outcome).toEqual({ ok: false, cause: expect.stringContaining('outside the contract') });
  });

  it('returns a failure and logs one timeout line when no response arrives before the timeout', async () => {
    const view = createRequesterHarness();

    const outcome = view.requester.request();
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS);

    expect([(await outcome).ok, view.lines.length]).toEqual([false, 1]);
  });

  it('returns a failure without waiting for the timeout when the send port rejects', async () => {
    const view = createRequesterHarness(() => Promise.reject(new Error('the send port is closed')));
    let settled: CopyHtmlOutcome | undefined;

    void view.requester.request().then((outcome) => {
      settled = outcome;
    });
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS - 1);

    expect(settled).toEqual({ ok: false, cause: expect.stringContaining('the send port is closed') });
  });

  it('immediately returns a failure caused by view disposal when disposed while waiting', async () => {
    const view = createRequesterHarness();
    let settled: CopyHtmlOutcome | undefined;
    void view.requester.request().then((outcome) => {
      settled = outcome;
    });

    view.requester.dispose();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toEqual({ ok: false, cause: expect.stringContaining('disposed') });
  });

  it('returns a failure without waiting for the timeout when the view is recreated while waiting', async () => {
    const view = createRequesterHarness();
    let settled: CopyHtmlOutcome | undefined;
    void view.requester.request().then((outcome) => {
      settled = outcome;
    });

    view.requester.notifyViewRestarted();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled?.ok).toBe(false);
  });

  it('gives each of two requests on the same requester the HTML for its own request id, even when answered in reverse order', async () => {
    const view = createRequesterHarness();

    const first = view.requester.request();
    const second = view.requester.request();
    view.requester.settle(createResponse(view.requests[1].requestId, '<p>2</p>'));
    view.requester.settle(createResponse(view.requests[0].requestId, '<p>1</p>'));

    expect([await first, await second]).toEqual([
      { ok: true, html: '<p>1</p>' },
      { ok: true, html: '<p>2</p>' },
    ]);
  });

  it('drops a response for a request id nobody is waiting for, settling no wait and logging one line', async () => {
    const view = createRequesterHarness();
    let settled = false;
    void view.requester.request().then(() => {
      settled = true;
    });

    const accepted = view.requester.settle(createResponse('never-issued', '<p>x</p>'));
    await vi.advanceTimersByTimeAsync(0);

    expect([accepted, settled, view.lines.length]).toEqual([false, false, 1]);
  });
});

describe('writing the clipboard and showing the result', () => {
  it('writes an HTML form with leading and trailing whitespace and newlines as is, then shows Copied as HTML for 2 seconds', async () => {
    const view = createRequesterHarness();
    const copy = createCopyHarness();

    const done = copySessionAsHtml(createSession(view.requester), copy.ports);
    view.requester.settle(createResponse(view.requests[0].requestId, '\n  <p>a</p>\n'));
    await done;

    expect(copy.trace).toEqual([['write', '\n  <p>a</p>\n'], ['status', 'Copied as HTML', 2000]]);
  });

  it('shows no notification when the write succeeds', async () => {
    const view = createRequesterHarness();
    const copy = createCopyHarness();

    const done = copySessionAsHtml(createSession(view.requester), copy.ports);
    view.requester.settle(createResponse(view.requests[0].requestId, '<p>a</p>'));
    await done;

    expect(copy.reporter.readInspection().notifications).toEqual([]);
  });

  it('writes an empty string and shows success when the HTML form is empty', async () => {
    const view = createRequesterHarness();
    const copy = createCopyHarness();

    const done = copySessionAsHtml(createSession(view.requester), copy.ports);
    view.requester.settle(createResponse(view.requests[0].requestId, ''));
    await done;

    expect(copy.trace).toEqual([['write', ''], ['status', 'Copied as HTML', 2000]]);
  });

  it('does not show success when the write is rejected, shows one failure notification, and logs one cause line', async () => {
    const view = createRequesterHarness();
    const copy = createCopyHarness(() => Promise.reject(new Error('the clipboard is unavailable')));

    const done = copySessionAsHtml(createSession(view.requester), copy.ports);
    view.requester.settle(createResponse(view.requests[0].requestId, '<p>a</p>'));
    await done;

    const inspection = copy.reporter.readInspection();
    expect([copy.trace, inspection.notifications, inspection.logLines.length])
      .toEqual([[['write', '<p>a</p>']], [FAILED_MESSAGE], 1]);
  });

  it('does not call the write when the request fails, shows one failure notification, and logs one cause line', async () => {
    const view = createRequesterHarness();
    const copy = createCopyHarness();

    const done = copySessionAsHtml(createSession(view.requester), copy.ports);
    view.requester.settle(createResponse(view.requests[0].requestId, null));
    await done;

    const inspection = copy.reporter.readInspection();
    expect([copy.trace, inspection.notifications, inspection.logLines.length]).toEqual([[], [FAILED_MESSAGE], 1]);
  });

  it('neither requests nor writes for a session with no requester, and shows one failure notification', async () => {
    const copy = createCopyHarness();

    await copySessionAsHtml(createSession(), copy.ports);

    expect([copy.trace, copy.reporter.readInspection().notifications]).toEqual([[], [FAILED_MESSAGE]]);
  });

  it('writes in arrival order when two copy results arrive in reverse order, leaving the earlier request\'s HTML last', async () => {
    const view = createRequesterHarness();
    const copy = createCopyHarness();
    const session = createSession(view.requester);

    const first = copySessionAsHtml(session, copy.ports);
    const second = copySessionAsHtml(session, copy.ports);
    view.requester.settle(createResponse(view.requests[1].requestId, '<p>2</p>'));
    await second;
    view.requester.settle(createResponse(view.requests[0].requestId, '<p>1</p>'));
    await first;

    expect(copy.written).toEqual(['<p>2</p>', '<p>1</p>']);
  });
});

describe('writing the code of a code block', () => {
  it('writes code text with leading and trailing whitespace and line breaks as is, then calls the success port once', async () => {
    const copy = createCopyHarness();

    await copyCodeBlockText('\n  a\n\tb \n', 'file:///a.html', copy.ports, createSucceededPort(copy));

    expect(copy.trace).toEqual([['write', '\n  a\n\tb \n'], ['succeeded']]);
  });

  it('shows neither a notification nor a status bar message when the write succeeds', async () => {
    const copy = createCopyHarness();

    await copyCodeBlockText('a', 'file:///a.html', copy.ports, createSucceededPort(copy));

    expect([
      copy.reporter.readInspection().notifications,
      copy.trace.filter((call) => call[0] === 'status'),
    ]).toEqual([[], []]);
  });

  it('does not call the success port when the write is rejected, shows one failure notification, and logs one cause line', async () => {
    const copy = createCopyHarness(() => Promise.reject(new Error('the clipboard is unavailable')));

    await copyCodeBlockText('a', 'file:///a.html', copy.ports, createSucceededPort(copy));

    const inspection = copy.reporter.readInspection();
    expect([copy.trace, inspection.notifications, inspection.logLines.length])
      .toEqual([[['write', 'a']], [CODE_FAILED_MESSAGE], 1]);
  });

  it('logs one line without notifying when the success port rejects', async () => {
    const copy = createCopyHarness();

    await copyCodeBlockText(
      'a',
      'file:///a.html',
      copy.ports,
      createSucceededPort(copy, () => Promise.reject(new Error('the panel is disposed'))),
    );

    const inspection = copy.reporter.readInspection();
    expect([inspection.notifications, inspection.logLines.length]).toEqual([[], 1]);
  });

  it('writes an empty string and calls the success port when the code text is empty', async () => {
    const copy = createCopyHarness();

    await copyCodeBlockText('', 'file:///a.html', copy.ports, createSucceededPort(copy));

    expect(copy.trace).toEqual([['write', ''], ['succeeded']]);
  });
});
