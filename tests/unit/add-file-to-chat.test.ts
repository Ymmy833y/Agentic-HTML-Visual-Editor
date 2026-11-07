// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';

import { createLocalizer } from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { addFileToChat, supportsChatFileAttach } from '../../src/chat/add-file-to-chat';
import type { AddFileToChatPorts } from '../../src/chat/add-file-to-chat';
import { ErrorReporter } from '../../src/diagnostics/error-reporter';
import { createEditorResource } from '../../src/editor/editor-resource';

const FAILED_MESSAGE = englishMessages['addFileToChat.failed.message'];

interface UriComponents {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
}

/** A value with only the Uri members the code under test uses. Real VS Code URIs are covered in integration. */
function uri(changes: Partial<UriComponents> = {}): vscode.Uri {
  const value: UriComponents = {
    scheme: 'file', authority: '', path: '/notes/a.html', query: '', fragment: '', ...changes,
  };
  return {
    ...value,
    with: (next: Partial<UriComponents>) => uri({ ...value, ...next }),
    toString: () => JSON.stringify(value),
  } as unknown as vscode.Uri;
}

interface AttachHarness {
  readonly ports: AddFileToChatPorts;
  readonly reporter: ErrorReporter;
  /** URIs passed to the attach port, as strings, in the order passed. */
  readonly attached: string[];
}

/**
 * Creates ports that record what is passed to the attach port.
 *
 * @param attach The result the attach port returns. When omitted, attaching succeeds.
 */
function createHarness(attach: () => Promise<void> = () => Promise.resolve()): AttachHarness {
  const attached: string[] = [];
  const reporter = new ErrorReporter(
    { appendLine: (): void => undefined, show: (): void => undefined },
    {
      showMessage: (): PromiseLike<string | undefined> => Promise.resolve(undefined),
      showInformation: (): PromiseLike<string | undefined> => Promise.resolve(undefined),
    },
    createLocalizer(englishMessages),
    true,
  );
  return {
    ports: {
      attachFile: (sourceUri) => {
        attached.push(sourceUri.toString());
        return attach();
      },
      errorReporter: reporter,
    },
    reporter,
    attached,
  };
}

describe('telling whether VS Code attaches a given file to chat', () => {
  it('accepts 1.96.0 and later versions, including pre-release builds', () => {
    const versions = ['1.96.0', '1.140.2', '1.141.0-insider', '2.0.0'];

    expect(versions.map((version) => supportsChatFileAttach(version))).toEqual([true, true, true, true]);
  });

  it('rejects versions before 1.96 and strings that are not versions', () => {
    const versions = ['1.90.0', '1.95.3', '', 'insider'];

    expect(versions.map((version) => supportsChatFileAttach(version))).toEqual([false, false, false, false]);
  });
});

describe('adding the document file to chat', () => {
  it('hands the source URI to the attach port when given the document URI of a tab', async () => {
    const harness = createHarness();
    const source = uri();

    await addFileToChat(createEditorResource(source), harness.ports);

    expect(harness.attached).toEqual([source.toString()]);
  });

  it('hands a source URI to the attach port unchanged', async () => {
    const harness = createHarness();
    const source = uri({ path: '/docs/bug-log.html' });

    await addFileToChat(source, harness.ports);

    expect(harness.attached).toEqual([source.toString()]);
  });

  it('attaches nothing and only logs one line when there is no URI', async () => {
    const harness = createHarness();

    await addFileToChat(undefined, harness.ports);

    expect({ attached: harness.attached, inspection: harness.reporter.readInspection() }).toEqual({
      attached: [],
      inspection: { notifications: [], logLines: [expect.stringContaining('no visual editor is active')] },
    });
  });

  it('attaches nothing and logs a line for each URI outside the .html files or with broken restore information', async () => {
    const harness = createHarness();
    const brokenEditorResource = uri({ query: 'ahve-editor=not-json' });

    await addFileToChat(uri({ path: '/notes/a.htm' }), harness.ports);
    await addFileToChat(brokenEditorResource, harness.ports);

    expect({ attached: harness.attached, inspection: harness.reporter.readInspection() }).toEqual({
      attached: [],
      inspection: {
        notifications: [],
        logLines: [expect.stringContaining('.html'), expect.stringContaining('Did not add a file to chat')],
      },
    });
  });

  it('notifies the user and logs the cause when the chat does not take the file', async () => {
    const harness = createHarness(() => Promise.reject(new Error('command not found')));

    await addFileToChat(uri(), harness.ports);

    expect(harness.reporter.readInspection()).toEqual({
      notifications: [FAILED_MESSAGE],
      logLines: [expect.stringContaining('command not found')],
    });
  });
});
