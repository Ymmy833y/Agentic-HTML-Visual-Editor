// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { MessageKey } from '../../common/index';
import { ErrorReporter } from '../../src/diagnostics/error-reporter';
import {
  LINK_OPEN_FAILURE,
  formatLinkOpenFailure,
  openRelativeLink,
  resolveLinkTarget,
} from '../../src/link/relative-link-opener';
import type {
  LinkFailureReporter,
  LinkOpenAttempt,
  LinkTargetCheck,
  RelativeLinkHost,
} from '../../src/link/relative-link-opener';

// The base document. Its base directory is `/ws/docs`, and the scope root `/ws` has depth 1.
const DOCUMENT_PATH = '/ws/docs/a.html';
const WORKSPACE_DEPTH = 1;

const IN_SCOPE_HREF = 'sub/b.html';
const IN_SCOPE_TARGET = '/ws/docs/sub/b.html';
// The same href read from the scope root `/ws`.
const SCOPE_ROOT_TARGET = '/ws/sub/b.html';

// Points to `/outside/b.html`, outside the scope root `/ws`.
const OUTSIDE_SCOPE_HREF = '../../outside/b.html';

// A root-relative href and the target it names from the workspace folder `/ws`.
const ROOT_RELATIVE_HREF = '/abs-root.html';
const ROOT_RELATIVE_TARGET = '/ws/abs-root.html';

/** A message key and cause requested from the notification port. */
interface NotificationRequest {
  readonly key: MessageKey;
  readonly cause: string;
}

interface HarnessOptions {
  /** The result the opening operation returns. When omitted, it returns opened. */
  readonly attempt?: LinkOpenAttempt;
  /** The exception thrown while resolving the scope depth. */
  readonly scopeError?: Error;
  /** The result the link target check returns. When omitted, it returns a file. */
  readonly check?: LinkTargetCheck;
  /** Results for individual target paths. They take precedence over `check`. */
  readonly checks?: ReadonlyMap<string, LinkTargetCheck>;
  /** Whether the base document belongs to a workspace folder. When omitted, it does. */
  readonly inWorkspaceFolder?: boolean;
}

interface Harness {
  readonly host: RelativeLinkHost;
  readonly reporter: LinkFailureReporter;
  /** Port calls in the order they were received. */
  readonly trace: string[];
  /** Lines written to the log-only port. */
  readonly logLines: string[];
  /**
   * Message keys and causes requested from the notification port, in order. The error reporter writes each cause as
   * one diagnostic log line.
   */
  readonly notifications: NotificationRequest[];
}

/**
 * Prepares ports and a reporter whose behavior is determined only by values.
 *
 * @param options The results the link target check and opening operation return, and the exception thrown while
 *   resolving the scope depth.
 */
function createHarness(options: HarnessOptions = {}): Harness {
  const trace: string[] = [];
  const logLines: string[] = [];
  const notifications: NotificationRequest[] = [];

  return {
    trace,
    logLines,
    notifications,
    reporter: {
      reportInternalError: (detail) => logLines.push(detail),
      reportUserError: (key, cause) => {
        notifications.push({ key, cause });
        return Promise.resolve();
      },
    },
    host: {
      documentPath: DOCUMENT_PATH,
      belongsToWorkspaceFolder: () => {
        trace.push('belongsToWorkspaceFolder');
        return options.inWorkspaceFolder ?? true;
      },
      resolveScopeDepth: () => {
        trace.push('resolveScopeDepth');
        if (options.scopeError !== undefined) {
          throw options.scopeError;
        }
        return WORKSPACE_DEPTH;
      },
      checkLinkTarget: (targetPath) => {
        trace.push(`checkLinkTarget:${targetPath}`);
        return Promise.resolve(options.checks?.get(targetPath) ?? options.check ?? { kind: 'file' });
      },
      openLinkTarget: (targetPath) => {
        trace.push(`openLinkTarget:${targetPath}`);
        return Promise.resolve(options.attempt ?? { opened: true });
      },
    },
  };
}

describe('relative link request handling', () => {
  it('calls the scope check, link target check, and opening operation once each in order, with no log or notification, when the check returns a file', async () => {
    const harness = createHarness();

    await openRelativeLink(IN_SCOPE_HREF, harness.host, harness.reporter);

    expect([harness.trace, harness.logLines, harness.notifications]).toEqual([
      ['resolveScopeDepth', `checkLinkTarget:${IN_SCOPE_TARGET}`, `openLinkTarget:${IN_SCOPE_TARGET}`],
      [],
      [],
    ]);
  });

  it('does not call the opening operation and requests one notification caused by the not-found line when the check returns not found', async () => {
    const harness = createHarness({ check: { kind: 'notFound' } });

    await openRelativeLink(IN_SCOPE_HREF, harness.host, harness.reporter);

    expect([harness.trace, harness.logLines, harness.notifications]).toEqual([
      ['resolveScopeDepth', `checkLinkTarget:${IN_SCOPE_TARGET}`, `checkLinkTarget:${SCOPE_ROOT_TARGET}`],
      [],
      [{
        key: 'relativeLink.notFound.message',
        cause: formatLinkOpenFailure(LINK_OPEN_FAILURE.notFound, IN_SCOPE_HREF),
      }],
    ]);
  });

  it('opens the target read from the scope root when the document-relative target is not found and that one is a file', async () => {
    const harness = createHarness({
      checks: new Map<string, LinkTargetCheck>([
        [IN_SCOPE_TARGET, { kind: 'notFound' }],
        [SCOPE_ROOT_TARGET, { kind: 'file' }],
      ]),
    });

    await openRelativeLink(IN_SCOPE_HREF, harness.host, harness.reporter);

    expect([harness.trace, harness.logLines, harness.notifications]).toEqual([
      [
        'resolveScopeDepth',
        `checkLinkTarget:${IN_SCOPE_TARGET}`,
        `checkLinkTarget:${SCOPE_ROOT_TARGET}`,
        `openLinkTarget:${SCOPE_ROOT_TARGET}`,
      ],
      [],
      [],
    ]);
  });

  it('opens a backslash-separated href read from the scope root when the document-relative target is not found', async () => {
    const harness = createHarness({
      checks: new Map<string, LinkTargetCheck>([
        ['/ws/docs/docs/c.txt', { kind: 'notFound' }],
        ['/ws/docs/c.txt', { kind: 'file' }],
      ]),
    });

    await openRelativeLink('docs\\c.txt', harness.host, harness.reporter);

    expect(harness.trace.at(-1)).toBe('openLinkTarget:/ws/docs/c.txt');
  });

  it('keeps the document-relative target when it is found, without checking the scope-root reading', async () => {
    const harness = createHarness({ checks: new Map([[SCOPE_ROOT_TARGET, { kind: 'file' } as const]]) });

    await openRelativeLink(IN_SCOPE_HREF, harness.host, harness.reporter);

    expect(harness.trace).toEqual([
      'resolveScopeDepth',
      `checkLinkTarget:${IN_SCOPE_TARGET}`,
      `openLinkTarget:${IN_SCOPE_TARGET}`,
    ]);
  });

  it('reports not found without opening when the scope-root reading is a directory', async () => {
    const harness = createHarness({
      checks: new Map<string, LinkTargetCheck>([
        [IN_SCOPE_TARGET, { kind: 'notFound' }],
        [SCOPE_ROOT_TARGET, { kind: 'notFile', entryType: 'directory' }],
      ]),
    });

    await openRelativeLink(IN_SCOPE_HREF, harness.host, harness.reporter);

    expect([harness.trace.at(-1), harness.notifications.map((n) => n.key)]).toEqual([
      `checkLinkTarget:${SCOPE_ROOT_TARGET}`,
      ['relativeLink.notFound.message'],
    ]);
  });

  it('does not check a scope-root reading that leaves the scope', async () => {
    // From `/ws/docs`, `../b.html` is `/ws/b.html`; from the root `/ws` it would be `/b.html`, outside the scope.
    const harness = createHarness({ check: { kind: 'notFound' } });

    await openRelativeLink('../b.html', harness.host, harness.reporter);

    expect(harness.trace).toEqual(['resolveScopeDepth', 'checkLinkTarget:/ws/b.html']);
  });

  it('notifies with the same message key regardless of entry type when the check returns not a file, with the entry type distinguishable by the cause in the log line', async () => {
    const directory = createHarness({ check: { kind: 'notFile', entryType: 'directory' } });
    const unknown = createHarness({ check: { kind: 'notFile', entryType: 'unknown' } });

    await openRelativeLink(IN_SCOPE_HREF, directory.host, directory.reporter);
    await openRelativeLink(IN_SCOPE_HREF, unknown.host, unknown.reporter);

    expect([...directory.notifications, ...unknown.notifications]).toEqual([
      {
        key: 'relativeLink.notFile.message',
        cause: formatLinkOpenFailure(LINK_OPEN_FAILURE.notFile, IN_SCOPE_HREF, 'directory'),
      },
      {
        key: 'relativeLink.notFile.message',
        cause: formatLinkOpenFailure(LINK_OPEN_FAILURE.notFile, IN_SCOPE_HREF, 'unknown'),
      },
    ]);
  });

  it('does not call the opening operation and notifies with an open-failed line carrying the cause when the check returns an open failure with a cause', async () => {
    const cause = 'NoPermissions (FileSystemError)';
    const harness = createHarness({ check: { kind: 'openFailed', cause } });

    await openRelativeLink(IN_SCOPE_HREF, harness.host, harness.reporter);

    expect([harness.trace, harness.notifications]).toEqual([
      ['resolveScopeDepth', `checkLinkTarget:${IN_SCOPE_TARGET}`],
      [{
        key: 'relativeLink.openFailed.message',
        cause: formatLinkOpenFailure(LINK_OPEN_FAILURE.openFailed, IN_SCOPE_HREF, cause),
      }],
    ]);
  });

  it('passes the same target path to the link target check and the opening operation as to the scope check', async () => {
    const harness = createHarness();
    // A double-encoded space. The value the scope check sees has the three characters `%20` in its name; decoding
    // again partway through would yield a different target with a space in its name.
    await openRelativeLink('sub/a%2520b.html', harness.host, harness.reporter);

    expect(harness.trace).toEqual([
      'resolveScopeDepth',
      'checkLinkTarget:/ws/docs/sub/a%20b.html',
      'openLinkTarget:/ws/docs/sub/a%20b.html',
    ]);
  });

  it('does not reject an href that stays within scope even with encoded `..` and separators, and proceeds to the link target check', async () => {
    const harness = createHarness();
    // A spelling whose upward traversal appears only after decoding. It resolves to `/ws/docs/b.html`, inside the
    // scope root `/ws`.
    await openRelativeLink('sub/%2e%2e%2fb.html', harness.host, harness.reporter);

    expect(harness.trace).toEqual([
      'resolveScopeDepth',
      'checkLinkTarget:/ws/docs/b.html',
      'openLinkTarget:/ws/docs/b.html',
    ]);
  });

  it('writes only a not-relative log line and requests no notification for a value that is not a relative file href', async () => {
    const harness = createHarness();
    const href = 'https://example.com/a.html';

    await openRelativeLink(href, harness.host, harness.reporter);

    expect([harness.trace, harness.logLines, harness.notifications]).toEqual([
      [],
      [formatLinkOpenFailure(LINK_OPEN_FAILURE.notRelative, href)],
      [],
    ]);
  });

  it('calls neither the link target check nor the opening operation and notifies with an unresolvable line for an href containing the NUL character', async () => {
    const harness = createHarness();
    const href = 'a%00.html';

    await openRelativeLink(href, harness.host, harness.reporter);

    expect([harness.trace, harness.notifications]).toEqual([
      [],
      [{
        key: 'relativeLink.unresolvable.message',
        cause: formatLinkOpenFailure(LINK_OPEN_FAILURE.unresolvable, href),
      }],
    ]);
  });

  it('also notifies an href that cannot be decoded with an unresolvable line and the same message key', async () => {
    const harness = createHarness();
    const href = '%zz.html';

    await openRelativeLink(href, harness.host, harness.reporter);

    expect(harness.notifications).toEqual([{
      key: 'relativeLink.unresolvable.message',
      cause: formatLinkOpenFailure(LINK_OPEN_FAILURE.unresolvable, href),
    }]);
  });

  it('does not call the link target check and notifies with an outside-scope line for an href leaving the scope, regardless of spelling', async () => {
    const plain = createHarness();
    const encoded = createHarness();
    const encodedHref = '..%2F..%2Foutside%2Fb.html';

    await openRelativeLink(OUTSIDE_SCOPE_HREF, plain.host, plain.reporter);
    await openRelativeLink(encodedHref, encoded.host, encoded.reporter);

    expect([plain.trace, encoded.trace, [...plain.notifications, ...encoded.notifications]]).toEqual([
      ['resolveScopeDepth'],
      ['resolveScopeDepth'],
      [
        {
          key: 'relativeLink.outsideScope.message',
          cause: formatLinkOpenFailure(LINK_OPEN_FAILURE.outsideScope, OUTSIDE_SCOPE_HREF),
        },
        {
          key: 'relativeLink.outsideScope.message',
          cause: formatLinkOpenFailure(LINK_OPEN_FAILURE.outsideScope, encodedHref),
        },
      ],
    ]);
  });

  it('notifies with an open-failed line carrying the cause when the opening operation returns a failure', async () => {
    const cause = 'EntryNotFound (FileSystemError)';
    const harness = createHarness({ attempt: { opened: false, cause } });

    await openRelativeLink(IN_SCOPE_HREF, harness.host, harness.reporter);

    expect(harness.notifications).toEqual([{
      key: 'relativeLink.openFailed.message',
      cause: formatLinkOpenFailure(LINK_OPEN_FAILURE.openFailed, IN_SCOPE_HREF, cause),
    }]);
  });

  it('resolves a root-relative href from the workspace folder, checks and opens that target, and leaves no log or notification', async () => {
    const harness = createHarness();

    await openRelativeLink(ROOT_RELATIVE_HREF, harness.host, harness.reporter);

    expect([harness.trace, harness.logLines, harness.notifications]).toEqual([
      [
        'belongsToWorkspaceFolder',
        'resolveScopeDepth',
        `checkLinkTarget:${ROOT_RELATIVE_TARGET}`,
        `openLinkTarget:${ROOT_RELATIVE_TARGET}`,
      ],
      [],
      [],
    ]);
  });

  it('calls neither the scope depth, the link target check, nor the opening operation and notifies with a no-workspace-folder line for a root-relative href from a document outside every workspace folder', async () => {
    const harness = createHarness({ inWorkspaceFolder: false });

    await openRelativeLink(ROOT_RELATIVE_HREF, harness.host, harness.reporter);

    expect([harness.trace, harness.notifications]).toEqual([
      ['belongsToWorkspaceFolder'],
      [{
        key: 'relativeLink.noWorkspaceFolder.message',
        cause: formatLinkOpenFailure(LINK_OPEN_FAILURE.noWorkspaceFolder, ROOT_RELATIVE_HREF),
      }],
    ]);
  });

  it('reports not found for a root-relative href without checking another reading', async () => {
    const harness = createHarness({ check: { kind: 'notFound' } });

    await openRelativeLink(ROOT_RELATIVE_HREF, harness.host, harness.reporter);

    expect([harness.trace, harness.notifications.map((n) => n.key)]).toEqual([
      ['belongsToWorkspaceFolder', 'resolveScopeDepth', `checkLinkTarget:${ROOT_RELATIVE_TARGET}`],
      ['relativeLink.notFound.message'],
    ]);
  });

  it('does not call the link target check and notifies with an outside-scope line for a root-relative href that climbs above the workspace folder', async () => {
    const harness = createHarness();
    const href = '/../outside/b.html';

    await openRelativeLink(href, harness.host, harness.reporter);

    expect([harness.trace, harness.notifications]).toEqual([
      ['belongsToWorkspaceFolder', 'resolveScopeDepth'],
      [{
        key: 'relativeLink.outsideScope.message',
        cause: formatLinkOpenFailure(LINK_OPEN_FAILURE.outsideScope, href),
      }],
    ]);
  });

  it('writes only a not-relative log line and requests no notification for an href starting with //', async () => {
    const harness = createHarness();
    const href = '//host/a.html';

    await openRelativeLink(href, harness.host, harness.reporter);

    expect([harness.trace, harness.logLines, harness.notifications]).toEqual([
      [],
      [formatLinkOpenFailure(LINK_OPEN_FAILURE.notRelative, href)],
      [],
    ]);
  });

  it('does not rethrow when a port throws, and notifies an unexpected-exception line with the same message key as an open failure', async () => {
    const scopeError = new Error('cannot resolve the scope root');
    const harness = createHarness({ scopeError });

    await openRelativeLink(IN_SCOPE_HREF, harness.host, harness.reporter);

    expect(harness.notifications).toEqual([{
      key: 'relativeLink.openFailed.message',
      cause: formatLinkOpenFailure(LINK_OPEN_FAILURE.unexpectedError, IN_SCOPE_HREF, String(scopeError)),
    }]);
  });
});

describe('reporting a link open failure', () => {
  it('completes request handling even with a reporter whose notification request never completes', async () => {
    const harness = createHarness();
    const reporter: LinkFailureReporter = {
      reportInternalError: () => undefined,
      // Simulates the user never closing the notification.
      reportUserError: () => new Promise<void>(() => undefined),
    };

    await expect(openRelativeLink(OUTSIDE_SCOPE_HREF, harness.host, reporter)).resolves.toBeUndefined();
  });

  it('requests one notification each time when the same href fails to open twice in succession', async () => {
    const harness = createHarness();

    await openRelativeLink(OUTSIDE_SCOPE_HREF, harness.host, harness.reporter);
    await openRelativeLink(OUTSIDE_SCOPE_HREF, harness.host, harness.reporter);

    const request = {
      key: 'relativeLink.outsideScope.message',
      cause: formatLinkOpenFailure(LINK_OPEN_FAILURE.outsideScope, OUTSIDE_SCOPE_HREF),
    };
    expect(harness.notifications).toEqual([request, request]);
  });

  it('finishes without rethrowing and leaves the log line when given an error reporter whose notification presenter throws', async () => {
    const harness = createHarness();
    const logLines: string[] = [];
    const reporter = new ErrorReporter(
      { appendLine: (line) => logLines.push(line), show: () => undefined },
      {
        showMessage: () => {
          throw new Error('cannot show the notification');
        },
        showInformation: () => {
          throw new Error('cannot show the notification');
        },
      },
      createLocalizer({}),
      false,
    );

    await openRelativeLink(OUTSIDE_SCOPE_HREF, harness.host, reporter);

    expect(logLines).toEqual([formatLinkOpenFailure(LINK_OPEN_FAILURE.outsideScope, OUTSIDE_SCOPE_HREF)]);
  });
});

describe('the diagnostic record of a link open failure', () => {
  it('formats each of the nine reasons as a distinct single line that contains the href', () => {
    const lines = Object.values(LINK_OPEN_FAILURE)
      .map((failure) => formatLinkOpenFailure(failure, IN_SCOPE_HREF));

    expect([
      new Set(lines).size,
      lines.every((line) => line.includes(IN_SCOPE_HREF) && !line.includes('\n')),
    ]).toEqual([9, true]);
  });

  it('keeps an href containing a newline on one line and leaves that href readable', () => {
    // An attribute value wrapped in the source. Writing it as is would split one record across several lines.
    const line = formatLinkOpenFailure(LINK_OPEN_FAILURE.outsideScope, 'a\n  b.html');

    expect([line.includes('\n'), line.includes('"a\\n  b.html"')]).toEqual([false, true]);
  });

  it('keeps a cause containing a newline on one line and leaves that cause readable', () => {
    // Exception text can span several lines. Quoting only the href would still split the record at the cause.
    const line = formatLinkOpenFailure(LINK_OPEN_FAILURE.openFailed, IN_SCOPE_HREF, 'cannot open\n  details');

    expect([line.includes('\n'), line.includes('"cannot open\\n  details"')]).toEqual([false, true]);
  });
});

describe('deciding the target of a link without opening it', () => {
  it('returns the target path of a file without an opening operation', async () => {
    const harness = createHarness();

    const resolution = await resolveLinkTarget(IN_SCOPE_HREF, harness.host);

    expect([resolution, harness.trace.some((call) => call.startsWith('openLinkTarget'))]).toEqual([
      { resolved: true, targetPath: IN_SCOPE_TARGET },
      false,
    ]);
  });

  it('returns the target read from the scope root when the document-relative target is not found', async () => {
    const harness = createHarness({ checks: new Map([[IN_SCOPE_TARGET, { kind: 'notFound' }]]) });

    expect(await resolveLinkTarget(IN_SCOPE_HREF, harness.host)).toEqual({
      resolved: true,
      targetPath: SCOPE_ROOT_TARGET,
    });
  });

  it('returns no workspace folder for a root-relative href of a document outside every folder, without checking the target', async () => {
    const harness = createHarness({ inWorkspaceFolder: false });

    const resolution = await resolveLinkTarget(ROOT_RELATIVE_HREF, harness.host);

    expect([resolution, harness.trace.some((call) => call.startsWith('checkLinkTarget'))]).toEqual([
      { resolved: false, failure: LINK_OPEN_FAILURE.noWorkspaceFolder },
      false,
    ]);
  });

  it('returns outside scope for a target outside the scope root, without checking the target', async () => {
    const harness = createHarness();

    const resolution = await resolveLinkTarget(OUTSIDE_SCOPE_HREF, harness.host);

    expect([resolution, harness.trace.some((call) => call.startsWith('checkLinkTarget'))]).toEqual([
      { resolved: false, failure: LINK_OPEN_FAILURE.outsideScope },
      false,
    ]);
  });

  it('returns an unexpected error with its cause instead of throwing when a port throws', async () => {
    const harness = createHarness({ scopeError: new Error('the workspace is gone') });

    expect(await resolveLinkTarget(IN_SCOPE_HREF, harness.host)).toEqual({
      resolved: false,
      failure: LINK_OPEN_FAILURE.unexpectedError,
      cause: 'Error: the workspace is gone',
    });
  });
});
