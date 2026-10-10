// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as vscode from 'vscode';

import { PDF_EXPORT_REFUSAL, VIEW_TO_HOST_MESSAGE_TYPE, createLocalizer } from '../../common/index';
import type {
  PdfExportRefusal,
  PdfExportResponseMessage,
  PdfPageImage,
  PdfPageLink,
  RequestId,
  RequestPdfExportMessage,
} from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { ErrorReporter } from '../../src/diagnostics/error-reporter';
import type { HtmlCustomDocument } from '../../src/editor/html-custom-document';
import {
  PDF_EXPORT_TIMEOUT_MS,
  PdfExportRequester,
  exportActiveSessionAsPdf,
  exportSenderAsPdf,
  exportSessionAsPdf,
  toPdfPath,
} from '../../src/export/export-pdf';
import type { ExportPdfPorts } from '../../src/export/export-pdf';
import type { LinkResolveHost } from '../../src/link/relative-link-opener';
import { countPathDepth } from '../../src/link/link-path';
import type { SessionRegistry } from '../../src/session/session-registry';
import { WysiwygSession } from '../../src/session/wysiwyg-session';

const FAILED_MESSAGE = englishMessages['exportPdf.failed.message'];
const NO_TARGET_MESSAGE = englishMessages['exportPdf.noTarget.message'];
const CHANGE_MARKS_MESSAGE = englishMessages['exportPdf.changeMarks.message'];
const PROGRESS_TITLE = englishMessages['exportPdf.progress'];

// The smallest JPEG markers, start and end of image, as base64 and as the text of their bytes.
const JPEG_BASE64 = '/9j/2Q==';
const JPEG_TEXT = '\xff\xd8\xff\xd9';

// One page image without links.
const PAGES: readonly PdfPageImage[] = [{ jpeg: JPEG_BASE64, width: 2, height: 3, links: [] }];

interface FakeUri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  with(change: { path: string }): FakeUri;
  toString(): string;
}

interface RequesterHarness {
  readonly requester: PdfExportRequester;
  /** Request PDF export messages sent to the view, in the order sent. */
  readonly requests: RequestPdfExportMessage[];
  /** Lines the requester logged. */
  readonly lines: string[];
}

interface ExportHarness {
  readonly ports: ExportPdfPorts;
  readonly reporter: ErrorReporter;
  /** Calls to the ports, in the order called. A write records the bytes as text, one character per byte. */
  readonly trace: unknown[][];
}

interface ExportBehavior {
  /** The location the dialog answers with. `undefined` means the user cancels. */
  readonly destination?: FakeUri | undefined;
  /** The result the write port returns. When omitted, writing succeeds. */
  readonly write?: () => Promise<void>;
  /** The paths of the files that exist. Every other path is not found. */
  readonly files?: readonly string[];
  /** The paths whose check fails for a reason other than not found. */
  readonly unreadable?: readonly string[];
  /** The path of the workspace folder the document belongs to, or `undefined` when it belongs to none. */
  readonly workspaceFolder?: string | undefined;
}

/**
 * Creates a file URI with only the members the export reads.
 *
 * @param path The path of the URI.
 */
function createUri(path: string): FakeUri {
  return {
    scheme: 'file',
    authority: '',
    path,
    with: (change) => createUri(change.path),
    toString: () => `file://${path}`,
  };
}

/**
 * Creates a requester that records the request PDF export messages it sends.
 *
 * @param post The result the send port returns. When omitted, sending succeeds.
 */
function createRequesterHarness(post: () => Promise<void> = () => Promise.resolve()): RequesterHarness {
  const requests: RequestPdfExportMessage[] = [];
  const lines: string[] = [];
  const requester = new PdfExportRequester(
    (message) => {
      requests.push(message);
      return post();
    },
    { reportInternalError: (detail) => lines.push(detail) },
  );
  return { requester, requests, lines };
}

/**
 * Creates ports bound to a document that look files up in a fixed list, recording each check.
 *
 * @param documentPath The path of the document.
 * @param behavior Which files exist and which workspace folder the document belongs to.
 * @param trace Where each check is recorded.
 */
function createLinkHost(documentPath: string, behavior: ExportBehavior, trace: unknown[][]): LinkResolveHost {
  const files = new Set(behavior.files ?? []);
  const unreadable = new Set(behavior.unreadable ?? []);
  const folder = behavior.workspaceFolder;
  return {
    documentPath,
    belongsToWorkspaceFolder: () => folder !== undefined,
    // Outside a workspace folder the scope root is the folder of the document.
    resolveScopeDepth: () => (folder === undefined ? countPathDepth(documentPath) - 1 : countPathDepth(folder)),
    checkLinkTarget: (targetPath) => {
      trace.push(['check', targetPath]);
      if (unreadable.has(targetPath)) {
        return Promise.resolve({ kind: 'openFailed', cause: 'NoPermissions' });
      }
      return Promise.resolve(files.has(targetPath) ? { kind: 'file' } : { kind: 'notFound' });
    },
  };
}

/**
 * Creates ports that record every call.
 *
 * @param behavior The answer of the dialog, the result of the write and the files the links may lead to.
 */
function createExportHarness(behavior: ExportBehavior = { destination: createUri('/out/a.pdf') }): ExportHarness {
  const trace: unknown[][] = [];
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
    ports: {
      withProgress: async (title, task) => {
        trace.push(['progress', title]);
        const result = await task();
        trace.push(['progress done']);
        return result;
      },
      showSaveDialog: (defaultUri) => {
        trace.push(['dialog', defaultUri.toString()]);
        return Promise.resolve(behavior.destination as vscode.Uri | undefined);
      },
      writeFile: (uri, bytes) => {
        trace.push(['write', uri.toString(), Buffer.from(bytes).toString('latin1')]);
        return behavior.write?.() ?? Promise.resolve();
      },
      showStatus: (message, timeoutMs) => {
        trace.push(['status', message, timeoutMs]);
      },
      createLinkHost: (documentUri) => createLinkHost(documentUri.path, behavior, trace),
      errorReporter: reporter,
      localizer,
    },
  };
}

/**
 * Creates a session without launching VS Code.
 *
 * The export reads only the requester and the document URI from the session, so the document is replaced by a value
 * with only that shape, and the panel by an empty value.
 *
 * @param requester The requester to hand over. When omitted, none is handed over.
 * @param documentPath The path of the document.
 */
function createSession(requester?: PdfExportRequester, documentPath = '/docs/report.html'): WysiwygSession {
  const document = { sourceUri: createUri(documentPath) } as unknown as HtmlCustomDocument;
  const session = new WysiwygSession(document, {} as unknown as vscode.WebviewPanel);
  if (requester !== undefined) {
    session.setPdfExportRequester(requester);
  }
  return session;
}

/**
 * Creates a PDF export response.
 *
 * @param requestId The request id of the request being answered.
 * @param pages The page images, or `null` when they cannot be drawn.
 * @param refusal Why the view declined, or `null`.
 */
function createResponse(
  requestId: RequestId,
  pages: readonly PdfPageImage[] | null,
  refusal: PdfExportRefusal | null = null,
): PdfExportResponseMessage {
  return { type: VIEW_TO_HOST_MESSAGE_TYPE.pdfExportResponse, requestId, pages, refusal };
}

/**
 * Creates a page image whose links all cover the same small area.
 *
 * @param hrefs The hrefs of the links, in order.
 */
function createLinkedPage(hrefs: readonly string[]): PdfPageImage {
  const links: PdfPageLink[] = hrefs.map((href) => ({ x: 0, y: 0, width: 1, height: 1, target: { kind: 'href', href } }));
  return { jpeg: JPEG_BASE64, width: 2, height: 3, links };
}

/**
 * Starts an export of the session and answers its request with the response once it has been sent.
 *
 * @param view The requester harness of the session's view.
 * @param exporter The ports harness.
 * @param pages The page images to answer with, or `null`.
 * @param documentPath The path of the document.
 */
async function exportAnswering(
  view: RequesterHarness,
  exporter: ExportHarness,
  pages: readonly PdfPageImage[] | null,
  documentPath?: string,
): Promise<boolean> {
  const done = exportSessionAsPdf(createSession(view.requester, documentPath), exporter.ports);
  await vi.advanceTimersByTimeAsync(0);
  view.requester.settle(createResponse(view.requests[0].requestId, pages));
  return done;
}

/**
 * Starts an export of the session and answers its request with a value outside the contract.
 *
 * @param view The requester harness of the session's view.
 * @param exporter The ports harness.
 * @param pages The value of the pages.
 */
async function exportAnsweringUnchecked(
  view: RequesterHarness,
  exporter: ExportHarness,
  pages: unknown,
): Promise<boolean> {
  const done = exportSessionAsPdf(createSession(view.requester), exporter.ports);
  await vi.advanceTimersByTimeAsync(0);
  // The type is fixed, but at runtime the view can send any value. The type assertion is dropped to create one.
  view.requester.settle({
    type: VIEW_TO_HOST_MESSAGE_TYPE.pdfExportResponse,
    requestId: view.requests[0].requestId,
    pages,
    refusal: null,
  } as unknown as PdfExportResponseMessage);
  return done;
}

/**
 * Returns the URLs of the link annotations of a written PDF, in order.
 *
 * @param exporter The ports harness that recorded the write.
 */
function readWrittenUris(exporter: ExportHarness): string[] {
  const written = exporter.trace.find((call) => call[0] === 'write')?.[2];
  return typeof written === 'string' ? [...written.matchAll(/\/URI \(([^)]*)\)/gu)].map((match) => match[1]) : [];
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('identifying the target session', () => {
  it('without an active session, sends no request and notifies that nothing was exported', async () => {
    const exporter = createExportHarness();
    const registry = { getActiveSession: () => undefined } as unknown as SessionRegistry;

    await exportActiveSessionAsPdf(registry, exporter.ports);

    expect([exporter.reporter.readInspection().notifications, exporter.trace]).toEqual([[NO_TARGET_MESSAGE], []]);
  });
});

describe('drawing, choosing the location and writing', () => {
  it('waits for the drawing inside a progress notification', async () => {
    const view = createRequesterHarness();
    const exporter = createExportHarness();

    await exportAnswering(view, exporter, PAGES);

    expect(exporter.trace.slice(0, 2)).toEqual([['progress', PROGRESS_TITLE], ['progress done']]);
  });

  it('fills the dialog with the name of the document and the extension pdf in the same folder', async () => {
    const view = createRequesterHarness();
    const exporter = createExportHarness();

    await exportAnswering(view, exporter, PAGES);

    expect(exporter.trace[2]).toEqual(['dialog', 'file:///docs/report.pdf']);
  });

  it('writes nothing when the dialog is cancelled', async () => {
    const view = createRequesterHarness();
    const exporter = createExportHarness({ destination: undefined });

    const written = await exportAnswering(view, exporter, PAGES);

    expect([written, exporter.trace.map((call) => call[0])]).toEqual([false, ['progress', 'progress done', 'dialog']]);
  });

  it('writes a PDF built from the page images of the response to the chosen location, then shows Exported to PDF for 2 seconds', async () => {
    const view = createRequesterHarness();
    const exporter = createExportHarness({ destination: createUri('/out/chosen.pdf') });

    const written = await exportAnswering(view, exporter, PAGES);

    const [write, status] = exporter.trace.slice(3);
    const pdf = String(write[2]);
    expect([
      written,
      write.slice(0, 2),
      pdf.startsWith('%PDF-'),
      pdf.includes('/Width 2 /Height 3'),
      pdf.includes(`stream\n${JPEG_TEXT}\nendstream`),
      status,
    ]).toEqual([true, ['write', 'file:///out/chosen.pdf'], true, true, true, ['status', 'Exported to PDF', 2000]]);
  });

  it('notifies without opening the dialog when the view responds that it cannot create the PDF', async () => {
    const view = createRequesterHarness();
    const exporter = createExportHarness();

    await exportAnswering(view, exporter, null);

    expect([exporter.reporter.readInspection().notifications, exporter.trace.map((call) => call[0])]).toEqual([
      [FAILED_MESSAGE],
      ['progress', 'progress done'],
    ]);
  });

  it('notifies without opening the dialog when no response arrives before the timeout', async () => {
    const view = createRequesterHarness();
    const exporter = createExportHarness();

    const done = exportSessionAsPdf(createSession(view.requester), exporter.ports);
    await vi.advanceTimersByTimeAsync(PDF_EXPORT_TIMEOUT_MS);
    await done;

    expect([exporter.reporter.readInspection().notifications, exporter.trace.map((call) => call[0])]).toEqual([
      [FAILED_MESSAGE],
      ['progress', 'progress done'],
    ]);
  });

  it.each([
    ['the pages are not an array', 1],
    ['there are no pages', []],
    ['a page image is not base64', [{ ...PAGES[0], jpeg: '%%%' }]],
    ['the width of a page is not a whole number', [{ ...PAGES[0], width: 1.5 }]],
    ['the height of a page is zero', [{ ...PAGES[0], height: 0 }]],
    ['a link leads to a kind outside the contract', [
      { ...PAGES[0], links: [{ x: 0, y: 0, width: 1, height: 1, target: { kind: 'uri', uri: 'index.html' } }] },
    ]],
    ['the page of a link is not a whole number', [
      { ...PAGES[0], links: [{ x: 0, y: 0, width: 1, height: 1, target: { kind: 'page', pageIndex: 0.5, y: 0 } }] },
    ]],
  ])('notifies without opening the dialog when %s', async (_name, pages) => {
    const view = createRequesterHarness();
    const exporter = createExportHarness();

    const written = await exportAnsweringUnchecked(view, exporter, pages);

    expect([written, exporter.reporter.readInspection().notifications, exporter.trace.map((call) => call[0])]).toEqual([
      false,
      [FAILED_MESSAGE],
      ['progress', 'progress done'],
    ]);
  });

  it('notifies without opening the dialog when the view is recreated while drawing', async () => {
    const view = createRequesterHarness();
    const exporter = createExportHarness();

    const done = exportSessionAsPdf(createSession(view.requester), exporter.ports);
    await vi.advanceTimersByTimeAsync(0);
    view.requester.notifyViewRestarted();
    await done;

    expect([exporter.reporter.readInspection().notifications, exporter.trace.map((call) => call[0])]).toEqual([
      [FAILED_MESSAGE],
      ['progress', 'progress done'],
    ]);
  });

  it('notifies and shows no status when the write is rejected', async () => {
    const view = createRequesterHarness();
    const exporter = createExportHarness({
      destination: createUri('/out/a.pdf'),
      write: () => Promise.reject(new Error('the folder is read-only')),
    });

    const written = await exportAnswering(view, exporter, PAGES);

    expect([written, exporter.reporter.readInspection().notifications, exporter.trace.at(-1)?.[0]]).toEqual([
      false,
      [FAILED_MESSAGE],
      'write',
    ]);
  });
});

describe('the links of the PDF', () => {
  it('looks the files of the links up inside the progress notification, before the dialog opens', async () => {
    const view = createRequesterHarness();
    const exporter = createExportHarness({
      destination: createUri('/ws/docs/report.pdf'),
      files: ['/ws/docs/index.html'],
      workspaceFolder: '/ws',
    });

    await exportAnswering(view, exporter, [createLinkedPage(['index.html'])], '/ws/docs/report.html');

    expect(exporter.trace.map((call) => call[0]).slice(0, 4)).toEqual(['progress', 'check', 'progress done', 'dialog']);
  });

  it('writes a relative link and a root-relative link as paths from the folder the PDF is saved in', async () => {
    const view = createRequesterHarness();
    const exporter = createExportHarness({
      destination: createUri('/ws/out/report.pdf'),
      files: ['/ws/docs/index.html', '/ws/index.html'],
      workspaceFolder: '/ws',
    });

    await exportAnswering(view, exporter, [createLinkedPage(['index.html', '/index.html'])], '/ws/docs/report.html');

    expect(readWrittenUris(exporter)).toEqual(['../docs/index.html', '../index.html']);
  });

  it('writes web and mail links as written', async () => {
    const view = createRequesterHarness();
    const exporter = createExportHarness({ destination: createUri('/out/a.pdf') });

    await exportAnswering(view, exporter, [createLinkedPage(['https://example.com/a', 'mailto:a@example.com'])]);

    expect(readWrittenUris(exporter)).toEqual(['https://example.com/a', 'mailto:a@example.com']);
  });

  it('leaves out links to a missing file, to a file outside the scope and from a root-relative href outside a workspace folder, without a notification or a log line', async () => {
    const view = createRequesterHarness();
    const exporter = createExportHarness({
      destination: createUri('/ws/docs/report.pdf'),
      files: ['/ws/docs/index.html', '/index.html', '/secret.html'],
    });

    await exportAnswering(
      view,
      exporter,
      [createLinkedPage(['missing.html', '../../secret.html', '/index.html', 'index.html'])],
      '/ws/docs/report.html',
    );

    const inspection = exporter.reporter.readInspection();
    expect([readWrittenUris(exporter), inspection.notifications, inspection.logLines]).toEqual([
      ['./index.html'],
      [],
      [],
    ]);
  });
});

describe('recording links left out of the PDF', () => {
  it('records one line, without a notification, for a link whose file could not be checked, and still writes the PDF', async () => {
    const view = createRequesterHarness();
    const exporter = createExportHarness({
      destination: createUri('/ws/docs/report.pdf'),
      unreadable: ['/ws/docs/locked.html'],
      workspaceFolder: '/ws',
    });

    const written = await exportAnswering(view, exporter, [createLinkedPage(['locked.html'])], '/ws/docs/report.html');

    const inspection = exporter.reporter.readInspection();
    expect([written, readWrittenUris(exporter), inspection.notifications, inspection.logLines.length]).toEqual([
      true,
      [],
      [],
      1,
    ]);
  });
});

describe('declining for change marks and the toolbar path', () => {
  it('notifies only that changes are waiting, without opening the dialog or logging, when the view declines for change marks', async () => {
    const view = createRequesterHarness();
    const exporter = createExportHarness();

    const done = exportSessionAsPdf(createSession(view.requester), exporter.ports);
    await vi.advanceTimersByTimeAsync(0);
    view.requester.settle(createResponse(view.requests[0].requestId, null, PDF_EXPORT_REFUSAL.changeMarks));
    const written = await done;

    const inspection = exporter.reporter.readInspection();
    expect([written, inspection.notifications, inspection.logLines, exporter.trace.map((call) => call[0])]).toEqual([
      false,
      [CHANGE_MARKS_MESSAGE],
      [],
      ['progress', 'progress done'],
    ]);
  });

  it('exports the sender\'s session on the toolbar path', async () => {
    const view = createRequesterHarness();
    const exporter = createExportHarness();

    const done = exportSenderAsPdf(createSession(view.requester), 'file:///docs/report.html', exporter.ports);
    await vi.advanceTimersByTimeAsync(0);
    view.requester.settle(createResponse(view.requests[0].requestId, PAGES));
    await done;

    expect(exporter.trace.map((call) => call[0])).toEqual(['progress', 'progress done', 'dialog', 'write', 'status']);
  });

  it('only logs one line, without a notification or a request, when the sender\'s session no longer exists', async () => {
    const exporter = createExportHarness();

    await exportSenderAsPdf(undefined, 'file:///docs/report.html', exporter.ports);

    const inspection = exporter.reporter.readInspection();
    expect([inspection.notifications, inspection.logLines.length, exporter.trace]).toEqual([[], 1, []]);
  });
});

describe('the PDF export request', () => {
  it('returns a failure caused by base64 when a page image is not base64', async () => {
    const view = createRequesterHarness();

    const outcome = view.requester.request();
    view.requester.settle(createResponse(view.requests[0].requestId, [{ ...PAGES[0], jpeg: '%%%' }]));

    expect(await outcome).toEqual({ ok: false, cause: expect.stringContaining('not base64') });
  });

  it('waits up to the export timeout rather than the default response timeout', async () => {
    const view = createRequesterHarness();
    let settled = false;
    void view.requester.request().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(PDF_EXPORT_TIMEOUT_MS - 1);

    expect(settled).toBe(false);
  });

  it('returns a failure without waiting for the timeout when the send port rejects', async () => {
    const view = createRequesterHarness(() => Promise.reject(new Error('the send port is closed')));

    const outcome = view.requester.request();
    await vi.advanceTimersByTimeAsync(0);

    expect(await outcome).toEqual({ ok: false, cause: expect.stringContaining('the send port is closed') });
  });

  it('drops a response for a request id nobody is waiting for, logging one line', () => {
    const view = createRequesterHarness();

    const accepted = view.requester.settle(createResponse('never-issued', PAGES));

    expect([accepted, view.lines.length]).toEqual([false, 1]);
  });
});

describe('the path of the PDF next to the document', () => {
  it('replaces the extension with pdf', () => {
    expect(toPdfPath('/docs/report.html')).toBe('/docs/report.pdf');
  });

  it('keeps a dot in a folder name', () => {
    expect(toPdfPath('/docs.v2/report')).toBe('/docs.v2/report.pdf');
  });

  it('adds the extension to a name that starts with a dot', () => {
    expect(toPdfPath('/docs/.html')).toBe('/docs/.html.pdf');
  });
});
