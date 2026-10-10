// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type * as vscode from 'vscode';

import type { InternalErrorSink } from '../../src/diagnostics/error-reporter';
import { EditorSwitcher } from '../../src/editor/editor-switch';
import type { EditorSwitchHost, EditorSwitchRequest, OpenTargetOutcome } from '../../src/editor/editor-switch';
import type { TargetEditor } from '../../src/editor/open-editor-commands';

// The editor switcher only passes tabs and groups back to the host without reading their contents, so values that
// carry nothing but a name to tell them apart are enough.
const SOURCE_GROUP = { name: 'source-group' } as unknown as vscode.TabGroup;
const SOURCE_TAB = { name: 'source-tab' } as unknown as vscode.Tab;
const OPENED_TAB = { name: 'opened-tab' } as unknown as vscode.Tab;
const EXISTING_TAB = { name: 'existing-tab' } as unknown as vscode.Tab;

const FIRST_FILE = 'file:///first.html';
const SECOND_FILE = 'file:///second.html';

/** An operation called on the host and its arguments. A request is recorded as the canonical form of its source URI. */
type HostCall =
  | readonly ['resolveSourceTab', string]
  | readonly ['findTargetTab', string, TargetEditor]
  | readonly ['revealTab', vscode.Tab]
  | readonly ['openInGroup', string, vscode.TabGroup | undefined]
  | readonly ['closeTab', vscode.Tab];

/** The values the host returns. */
interface HostAnswers {
  readonly source: { readonly group: vscode.TabGroup; readonly tab: vscode.Tab } | undefined;
  readonly existing: vscode.Tab | undefined;
  readonly reveal: () => Promise<void>;
  readonly open: () => Promise<OpenTargetOutcome>;
  readonly close: (tab: vscode.Tab) => Promise<boolean>;
}

// The caller group has a source tab, the target can be opened, and the source tab can be closed.
const SWITCHABLE: HostAnswers = {
  source: { group: SOURCE_GROUP, tab: SOURCE_TAB },
  existing: undefined,
  reveal: () => Promise.resolve(),
  open: () => Promise.resolve({ kind: 'openedInGroup', tab: OPENED_TAB }),
  close: () => Promise.resolve(true),
};

/**
 * Creates a host that records the called operations in order and returns the given values.
 *
 * @param calls The array that records the called operations.
 * @param answers The values each operation returns.
 */
function createHost(calls: HostCall[], answers: HostAnswers): EditorSwitchHost {
  return {
    resolveSourceTab: (request) => {
      calls.push(['resolveSourceTab', request.sourceUri.toString()]);
      return answers.source;
    },
    findTargetTab: (sourceUri, target) => {
      calls.push(['findTargetTab', sourceUri.toString(), target]);
      return answers.existing;
    },
    revealTab: (tab) => {
      calls.push(['revealTab', tab]);
      return answers.reveal();
    },
    openInGroup: (request, group) => {
      calls.push(['openInGroup', request.sourceUri.toString(), group]);
      return answers.open();
    },
    closeTab: (tab) => {
      calls.push(['closeTab', tab]);
      return answers.close(tab);
    },
  };
}

/** An internal error sink that only records the lines it receives. */
function createSink(): InternalErrorSink & { readonly lines: string[] } {
  const lines: string[] = [];
  return { lines, reportInternalError: (detail) => lines.push(detail) };
}

/**
 * Creates an editor switch request.
 *
 * The editor switcher reads only the canonical form from the URI, so a value with nothing but `toString` is enough.
 */
function request(sourceUri: string, target: TargetEditor = 'wysiwyg'): EditorSwitchRequest {
  return { sourceUri: { toString: () => sourceUri } as unknown as vscode.Uri, target, viewColumn: undefined };
}

/** Runs pending Promise continuations to completion. */
async function settlePendingCallbacks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** An open operation result whose resolution is decided from outside. */
function createPendingOpen(): { readonly promise: Promise<OpenTargetOutcome>; resolve(outcome: OpenTargetOutcome): void } {
  let resolve: (outcome: OpenTargetOutcome) => void = () => undefined;
  const promise = new Promise<OpenTargetOutcome>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('resolving the caller group', () => {
  it('only opens without a group, and never calls close, when the host returns no source tab', async () => {
    const calls: HostCall[] = [];
    const switcher = new EditorSwitcher(
      createHost(calls, {
        ...SWITCHABLE,
        source: undefined,
        // The host promises to report a success opened without a group as opened in another group.
        open: () => Promise.resolve({ kind: 'openedElsewhere' }),
      }),
      createSink(),
    );

    await switcher.switchEditor(request(FIRST_FILE));

    expect(calls).toEqual([
      ['resolveSourceTab', FIRST_FILE],
      ['findTargetTab', FIRST_FILE, 'wysiwyg'],
      ['openInGroup', FIRST_FILE, undefined],
    ]);
  });
});

describe('revealing an existing target tab', () => {
  it('only calls reveal, and neither open nor close, when the host returns an existing target tab', async () => {
    const calls: HostCall[] = [];
    const switcher = new EditorSwitcher(createHost(calls, { ...SWITCHABLE, existing: EXISTING_TAB }), createSink());

    await switcher.switchEditor(request(FIRST_FILE));

    expect(calls).toEqual([
      ['resolveSourceTab', FIRST_FILE],
      ['findTargetTab', FIRST_FILE, 'wysiwyg'],
      ['revealTab', EXISTING_TAB],
    ]);
  });
});

describe('opening the target in the caller group', () => {
  it('does not call close on the source tab until the open Promise resolves', async () => {
    const calls: HostCall[] = [];
    const opening = createPendingOpen();
    const switcher = new EditorSwitcher(createHost(calls, { ...SWITCHABLE, open: () => opening.promise }), createSink());

    const switching = switcher.switchEditor(request(FIRST_FILE));
    await settlePendingCallbacks();
    const whileOpening = calls.map(([operation]) => operation);
    opening.resolve({ kind: 'openedInGroup', tab: OPENED_TAB });
    await switching;

    expect([whileOpening, calls.map(([operation]) => operation)]).toEqual([
      ['resolveSourceTab', 'findTargetTab', 'openInGroup'],
      ['resolveSourceTab', 'findTargetTab', 'openInGroup', 'closeTab'],
    ]);
  });

  it('closes nothing and leaves one line in the diagnostic log when open reports opening in another group', async () => {
    const calls: HostCall[] = [];
    const sink = createSink();
    const switcher = new EditorSwitcher(
      createHost(calls, { ...SWITCHABLE, open: () => Promise.resolve({ kind: 'openedElsewhere' }) }),
      sink,
    );

    await switcher.switchEditor(request(FIRST_FILE));

    expect([calls.filter(([operation]) => operation === 'closeTab'), sink.lines.length]).toEqual([[], 1]);
  });

  it('does not call close when open reports failure', async () => {
    const calls: HostCall[] = [];
    const switcher = new EditorSwitcher(
      createHost(calls, { ...SWITCHABLE, open: () => Promise.resolve({ kind: 'failed' }) }),
      createSink(),
    );

    await switcher.switchEditor(request(FIRST_FILE));

    expect(calls.filter(([operation]) => operation === 'closeTab')).toEqual([]);
  });
});

describe('closing the source tab', () => {
  it('does not call close on the target tab once the source tab has been closed', async () => {
    const calls: HostCall[] = [];
    const switcher = new EditorSwitcher(createHost(calls, SWITCHABLE), createSink());

    await switcher.switchEditor(request(FIRST_FILE));

    expect(calls.filter(([operation]) => operation === 'closeTab')).toEqual([['closeTab', SOURCE_TAB]]);
  });
});

describe('reverting on cancel', () => {
  it('calls close on the opened target tab once when closing the source tab is refused', async () => {
    const calls: HostCall[] = [];
    const switcher = new EditorSwitcher(
      // The save prompt for the source tab is cancelled, and the target tab closes without a prompt.
      createHost(calls, { ...SWITCHABLE, close: (tab) => Promise.resolve(tab === OPENED_TAB) }),
      createSink(),
    );

    await switcher.switchEditor(request(FIRST_FILE));

    expect(calls.filter(([operation]) => operation === 'closeTab')).toEqual([
      ['closeTab', SOURCE_TAB],
      ['closeTab', OPENED_TAB],
    ]);
  });

  it('leaves one line in the diagnostic log saying both tabs were kept when closing the target tab is refused too', async () => {
    const sink = createSink();
    const switcher = new EditorSwitcher(
      createHost([], { ...SWITCHABLE, close: () => Promise.resolve(false) }),
      sink,
    );

    await switcher.switchEditor(request(FIRST_FILE));

    expect(sink.lines).toHaveLength(1);
  });
});

describe('excluding concurrent switches of the same file', () => {
  it('does not call the host for a later request, and leaves one line in the diagnostic log, while a switch of the same source file is opening', async () => {
    const calls: HostCall[] = [];
    const sink = createSink();
    const opening = createPendingOpen();
    const switcher = new EditorSwitcher(createHost(calls, { ...SWITCHABLE, open: () => opening.promise }), sink);
    const first = switcher.switchEditor(request(FIRST_FILE));
    await settlePendingCallbacks();
    const callsBefore = calls.length;

    await switcher.switchEditor(request(FIRST_FILE));

    expect([calls.slice(callsBefore), sink.lines.length]).toEqual([[], 1]);
    opening.resolve({ kind: 'openedInGroup', tab: OPENED_TAB });
    await first;
  });

  it('discards a later request with the opposite target editor without calling the host, if it is for the same source file', async () => {
    const calls: HostCall[] = [];
    const opening = createPendingOpen();
    const switcher = new EditorSwitcher(
      createHost(calls, { ...SWITCHABLE, open: () => opening.promise }),
      createSink(),
    );
    const first = switcher.switchEditor(request(FIRST_FILE, 'wysiwyg'));
    await settlePendingCallbacks();
    const callsBefore = calls.length;

    await switcher.switchEditor(request(FIRST_FILE, 'text'));

    expect(calls.slice(callsBefore)).toEqual([]);
    opening.resolve({ kind: 'openedInGroup', tab: OPENED_TAB });
    await first;
  });

  it('handles a request for a different source file independently of the switch in progress', async () => {
    const calls: HostCall[] = [];
    const opening = createPendingOpen();
    const switcher = new EditorSwitcher(createHost(calls, { ...SWITCHABLE, open: () => opening.promise }), createSink());
    const first = switcher.switchEditor(request(FIRST_FILE));
    await settlePendingCallbacks();

    const second = switcher.switchEditor(request(SECOND_FILE));
    await settlePendingCallbacks();

    expect(calls.filter(([operation]) => operation === 'openInGroup')).toEqual([
      ['openInGroup', FIRST_FILE, SOURCE_GROUP],
      ['openInGroup', SECOND_FILE, SOURCE_GROUP],
    ]);
    opening.resolve({ kind: 'openedInGroup', tab: OPENED_TAB });
    await Promise.all([first, second]);
  });

  it('accepts a request for the same source file after the switch has finished', async () => {
    const calls: HostCall[] = [];
    const sink = createSink();
    const switcher = new EditorSwitcher(createHost(calls, SWITCHABLE), sink);
    await switcher.switchEditor(request(FIRST_FILE));

    await switcher.switchEditor(request(FIRST_FILE));

    expect(calls.filter(([operation]) => operation === 'closeTab')).toEqual([
      ['closeTab', SOURCE_TAB],
      ['closeTab', SOURCE_TAB],
    ]);
  });

  it('clears the in-progress state even when the host throws, so the next request for the same source file is handled', async () => {
    const calls: HostCall[] = [];
    const switcher = new EditorSwitcher(
      createHost(calls, {
        ...SWITCHABLE,
        existing: EXISTING_TAB,
        reveal: () => Promise.reject(new Error('reveal failed')),
      }),
      createSink(),
    );
    await switcher.switchEditor(request(FIRST_FILE));

    await switcher.switchEditor(request(FIRST_FILE));

    expect(calls.filter(([operation]) => operation === 'revealTab')).toHaveLength(2);
  });
});
