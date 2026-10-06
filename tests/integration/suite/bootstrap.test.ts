import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { DelayedFileSystem } from '../helpers/delayed-file-system';
import { customTabMatchesSource } from '../helpers/editor-tabs';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';

// This must match the package.json declaration, or the WYSIWYG editor cannot be opened.
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

// Maximum time for the view to load and complete its exchange with the host.
const ROUND_TRIP_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

interface RecordedMessage {
  readonly direction: 'fromView' | 'toView';
  readonly message: unknown;
}

interface WebviewInspection {
  readonly messages: readonly RecordedMessage[];
}

interface SessionInspection {
  readonly documentUris: readonly string[];
}

interface ExtensionApi {
  getMessage(key: string): string;
  readWebviewInspection(documentUri: string): WebviewInspection | undefined;
  readSessionInspection(): SessionInspection;
  readDiagnosticInspection(): { readonly notifications: readonly string[]; readonly logLines: readonly string[] };
  clearDiagnosticInspection(): void;
  injectViewMessage(documentUri: string, message: unknown): Promise<boolean>;
}

function findExtension(): vscode.Extension<ExtensionApi> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} is not loaded in VS Code`);
  return extension;
}

// The extension path passed to the development host is the repository root.
function fixtureUri(fileName: string): vscode.Uri {
  return vscode.Uri.joinPath(findExtension().extensionUri, 'tests', 'integration', 'fixtures', fileName);
}

async function readRegisteredSessionUris(): Promise<readonly string[]> {
  return (await findExtension().activate()).readSessionInspection().documentUris;
}

async function readRecordedMessages(uri: vscode.Uri): Promise<readonly RecordedMessage[]> {
  const inspection = (await findExtension().activate()).readWebviewInspection(uri.toString());
  return inspection?.messages ?? [];
}

// View loading is asynchronous and VS Code provides no completion signal, so poll until the record is complete.
async function waitForRecordedMessages(uri: vscode.Uri, count: number): Promise<readonly RecordedMessage[]> {
  const deadline = Date.now() + ROUND_TRIP_TIMEOUT_MS;

  for (;;) {
    const messages = await readRecordedMessages(uri);
    if (messages.length >= count) {
      return messages;
    }
    assert.ok(Date.now() < deadline, `Timed out before ${count} messages were recorded`);
    await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));
  }
}

function readMessageField(message: unknown, field: string): string | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const value: unknown = Object.getOwnPropertyDescriptor(message, field)?.value;
  return typeof value === 'string' ? value : undefined;
}

// A fixture outside the workspace. Only when opening this file is the resource root not the
// workspace folder.
function outsideWorkspaceUri(fileName: string): vscode.Uri {
  return vscode.Uri.joinPath(
    findExtension().extensionUri,
    'tests',
    'integration',
    'outside-workspace',
    fileName,
  );
}

// Polls until a message of the given direction and type is recorded, then returns it.
// Look messages up by type rather than by position: the startup exchange gained a dirty state message,
// and a position-based lookup silently returns the wrong message whenever the sequence grows.
async function waitForRecordedMessage(
  uri: vscode.Uri,
  direction: RecordedMessage['direction'],
  type: string,
): Promise<RecordedMessage> {
  const deadline = Date.now() + ROUND_TRIP_TIMEOUT_MS;

  for (;;) {
    const found = (await readRecordedMessages(uri)).find(
      (recorded) => recorded.direction === direction && readMessageField(recorded.message, 'type') === type,
    );
    if (found !== undefined) {
      return found;
    }
    assert.ok(Date.now() < deadline, `Timed out before a ${direction} ${type} message was recorded`);
    await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));
  }
}

// Reads the message delivered in response to the view ready message.
async function readInitializeMessage(uri: vscode.Uri): Promise<unknown> {
  return (await waitForRecordedMessage(uri, 'toView', 'initialize')).message;
}

async function readFileText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

function readMessageValue(message: unknown, field: string): unknown {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(message, field)?.value;
}

// A complete document whose paragraph holds three Japanese characters in Shift_JIS. Those bytes are not valid UTF-8.
const SHIFT_JIS_DOCUMENT_BYTES = new Uint8Array([
  ...new TextEncoder().encode('<!DOCTYPE html>\n<html>\n<body>\n<p>'),
  0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea,
  ...new TextEncoder().encode('</p>\n</body>\n</html>\n'),
]);

// Each case uses its own file, because VS Code keeps the text model of a closed file, and the encoding it was
// decoded with, for a while.
async function writeShiftJisScratch(fileName: string): Promise<vscode.Uri> {
  const uri = fixtureUri(fileName);
  await vscode.workspace.fs.writeFile(uri, SHIFT_JIS_DOCUMENT_BYTES);
  return uri;
}

describe('view startup and document boundary', () => {
  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('delivers a view ready message from the view to the host when opened in WYSIWYG', async () => {
    const uri = fixtureUri('sample.html');
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);

    // Wait for the response so the exchange has finished, then look the request up by type alone:
    // the direction is what this case verifies, so it must not be part of the lookup.
    await waitForRecordedMessage(uri, 'toView', 'initialize');
    const ready = (await readRecordedMessages(uri)).find(
      (recorded) => readMessageField(recorded.message, 'type') === 'viewReady',
    );

    assert.strictEqual(ready?.direction, 'fromView');
  });

  it('responds to the view ready message with an initialize message containing the entire file text', async () => {
    const uri = fixtureUri('sample.html');
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);

    const initialize = await waitForRecordedMessage(uri, 'toView', 'initialize');

    assert.strictEqual(readMessageField(initialize.message, 'text'), await readFileText(uri));
  });

  it('includes no CR in the initialize message when a CRLF file is opened', async () => {
    const uri = fixtureUri('crlf.html');
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);

    const text = readMessageField(await readInitializeMessage(uri), 'text') ?? '';

    assert.ok(!text.includes('\r'), 'A CR is left in the initialize message');
  });

  it('delivers text to the view matching the file when an LF file is opened', async () => {
    const uri = fixtureUri('sample.html');
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);

    assert.strictEqual(readMessageField(await readInitializeMessage(uri), 'text'), await readFileText(uri));
  });

  it('responds to the view ready message with an initialize message after registering the session', async () => {
    const uri = fixtureUri('sample.html');
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);

    const initialize = await waitForRecordedMessage(uri, 'toView', 'initialize');

    // The session now owns the receiver, so verify that the round trip succeeds after registration.
    // Registration precedes receiver setup, so a completed round trip also proves registration completed.
    assert.ok((await readRegisteredSessionUris()).includes(uri.toString()), 'The session is not registered');
    assert.strictEqual(readMessageField(initialize.message, 'type'), 'initialize');
  });

  it('includes the document URI pointing to the open file in the initialize message', async () => {
    const uri = fixtureUri('sample.html');
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);

    // The base URI has been converted into a form the view can read, so its exact spelling cannot
    // be reconstructed. Check its trailing path instead.
    const documentUri = readMessageField(await readInitializeMessage(uri), 'documentUri') ?? '';

    assert.ok(
      documentUri.endsWith('/tests/integration/fixtures/sample.html'),
      `The initialize message does not point at the opened file: ${documentUri}`,
    );
  });

  it('uses the workspace folder as the resource root for a file inside the workspace', async () => {
    const uri = fixtureUri('sample.html');
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);

    const rootUri = readMessageField(await readInitializeMessage(uri), 'resourceRootUri') ?? '';

    assert.ok(
      rootUri.endsWith('/tests/integration/fixtures'),
      `The resource root does not point at the workspace folder: ${rootUri}`,
    );
  });

  it("uses the file's directory as the resource root for a file outside the workspace", async () => {
    const uri = outsideWorkspaceUri('sample.html');
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);

    const rootUri = readMessageField(await readInitializeMessage(uri), 'resourceRootUri') ?? '';

    assert.ok(
      rootUri.endsWith('/tests/integration/outside-workspace'),
      `The resource root does not point at the file directory: ${rootUri}`,
    );
  });

  it('sends only one initialize message to the view in response to the view ready message', async () => {
    const uri = fixtureUri('sample.html');
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);

    // Wait for the dirty state that follows the initialize, so the startup exchange is complete before counting.
    // Counting after a fixed number of messages would race with that trailing message.
    await waitForRecordedMessage(uri, 'toView', 'dirtyState');

    const initializes = (await readRecordedMessages(uri)).filter(
      (recorded) => recorded.direction === 'toView'
        && readMessageField(recorded.message, 'type') === 'initialize',
    );

    assert.strictEqual(initializes.length, 1, 'More than one initialize message was sent');
  });

  it('leaves an empty file unchanged when its boundary cannot be determined after opening in WYSIWYG', async () => {
    const uri = fixtureUri('empty.html');
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);

    // Wait for the exchange to finish before checking. Reading immediately could pass before a
    // rewrite has time to occur.
    await waitForRecordedMessages(uri, 2);

    assert.strictEqual(await readFileText(uri), '');
  });
});

describe('opening a file decoded with a mismatched encoding', () => {
  const MISMATCH_FILE_NAME = 'bootstrap-encoding-mismatch-scratch.html';
  const REOPENED_FILE_NAME = 'bootstrap-encoding-reopened-scratch.html';

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.getConfiguration('files').update('encoding', undefined, vscode.ConfigurationTarget.Global);
    for (const fileName of [MISMATCH_FILE_NAME, REOPENED_FILE_NAME]) {
      await vscode.workspace.fs.delete(fixtureUri(fileName)).then(undefined, () => undefined);
    }
  });

  it('flags the mismatch in the initialize message and leaves the bytes unchanged for a Shift_JIS file read as UTF-8', async () => {
    const uri = await writeShiftJisScratch(MISMATCH_FILE_NAME);
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);

    const encodingMismatch = readMessageValue(await readInitializeMessage(uri), 'encodingMismatch');
    await waitForRecordedMessages(uri, 2);

    assert.deepStrictEqual(
      [encodingMismatch, Array.from(await vscode.workspace.fs.readFile(uri))],
      [true, Array.from(SHIFT_JIS_DOCUMENT_BYTES)],
    );
  });

  it('does not flag a mismatch for a Shift_JIS file read with the Shift_JIS encoding', async () => {
    await vscode.workspace.getConfiguration('files').update('encoding', 'shiftjis', vscode.ConfigurationTarget.Global);
    const uri = await writeShiftJisScratch(REOPENED_FILE_NAME);
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);

    const initialize = await readInitializeMessage(uri);

    assert.strictEqual(readMessageValue(initialize, 'encodingMismatch'), undefined);
  });
});

describe('writing an HTML skeleton to a blank document', () => {
  const SCRATCH_FILE_NAME = 'bootstrap-skeleton-scratch.html';
  const DIRTY_SCRATCH_FILE_NAME = 'bootstrap-skeleton-dirty-scratch.html';

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const fileName of [SCRATCH_FILE_NAME, DIRTY_SCRATCH_FILE_NAME]) {
      await vscode.workspace.fs.delete(fixtureUri(fileName)).then(undefined, () => undefined);
    }
  });

  // Each case uses its own file, because VS Code keeps the text model of a closed file for a while.
  async function openBlankScratch(fileName: string): Promise<vscode.Uri> {
    const uri = fixtureUri(fileName);
    await vscode.workspace.fs.writeFile(uri, new Uint8Array());
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
    await readInitializeMessage(uri);
    return uri;
  }

  // Writes an empty file and returns once the extension host has received a change notice for it. A session opened
  // afterwards never receives that notice, so no reconcile is left waiting for the buffer when the test starts. A new
  // watcher starts reporting only after a moment, so the write is repeated until the first notice arrives.
  async function writeBlankScratchAndSettle(fileName: string): Promise<vscode.Uri> {
    const uri = fixtureUri(fileName);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), fileName));
    let notified = false;
    watcher.onDidCreate(() => {
      notified = true;
    });
    watcher.onDidChange(() => {
      notified = true;
    });
    try {
      const deadline = Date.now() + ROUND_TRIP_TIMEOUT_MS;
      while (!notified) {
        assert.ok(Date.now() < deadline, 'Timed out before the write of the scratch file was notified');
        await vscode.workspace.fs.writeFile(uri, new Uint8Array());
        await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));
      }
    } finally {
      watcher.dispose();
    }
    return uri;
  }

  async function readInitializeTexts(uri: vscode.Uri): Promise<(string | undefined)[]> {
    return (await readRecordedMessages(uri))
      .filter((recorded) => recorded.direction === 'toView'
        && readMessageField(recorded.message, 'type') === 'initialize')
      .map((recorded) => readMessageField(recorded.message, 'text'));
  }

  async function waitUntil(condition: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + ROUND_TRIP_TIMEOUT_MS;
    while (!condition()) {
      assert.ok(Date.now() < deadline, `Timed out before ${description}`);
      await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));
    }
  }

  it('writes the skeleton, initializes the recreated view with it, and shows no notice', async () => {
    const extensionApi = await findExtension().activate();
    const uri = await openBlankScratch(SCRATCH_FILE_NAME);
    extensionApi.clearDiagnosticInspection();
    const skeleton = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n'
      + '<title>bootstrap-skeleton-scratch</title>\n</head>\n<body>\n</body>\n</html>\n';

    assert.ok(
      await extensionApi.injectViewMessage(uri.toString(), { type: 'documentSkeletonRequested' }),
      'could not deliver the skeleton request because there is no session',
    );
    const deadline = Date.now() + ROUND_TRIP_TIMEOUT_MS;
    while ((await readInitializeTexts(uri)).length < 2) {
      assert.ok(Date.now() < deadline, 'Timed out before the recreated view was initialized');
      await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));
    }

    assert.deepStrictEqual(
      {
        file: await readFileText(uri),
        initializeTexts: await readInitializeTexts(uri),
        notifications: extensionApi.readDiagnosticInspection().notifications,
      },
      { file: skeleton, initializeTexts: ['', skeleton], notifications: [] },
    );
  });

  it('leaves the file unchanged and shows one failure notice when a text editor holds unsaved edits', async () => {
    const extensionApi = await findExtension().activate();
    // The buffer is made dirty before the WYSIWYG opens. An edit made while the view is open would itself reach the
    // view as a source change, which a blank document's view cannot take, and the test would no longer be about the
    // skeleton request.
    const uri = await writeBlankScratchAndSettle(DIRTY_SCRATCH_FILE_NAME);
    const textDocument = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(0, 0), '\n');
    assert.ok(await vscode.workspace.applyEdit(edit), 'could not make the text buffer dirty');
    assert.ok(textDocument.isDirty, 'the text buffer is not dirty');
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
    await readInitializeMessage(uri);
    extensionApi.clearDiagnosticInspection();

    assert.ok(
      await extensionApi.injectViewMessage(uri.toString(), { type: 'documentSkeletonRequested' }),
      'could not deliver the skeleton request because there is no session',
    );
    const deadline = Date.now() + ROUND_TRIP_TIMEOUT_MS;
    while (extensionApi.readDiagnosticInspection().notifications.length === 0) {
      assert.ok(Date.now() < deadline, 'Timed out before a notice was shown');
      await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));
    }

    assert.deepStrictEqual(
      { file: await readFileText(uri), notifications: extensionApi.readDiagnosticInspection().notifications },
      { file: '', notifications: [extensionApi.getMessage('documentSkeleton.failed.message')] },
    );
  });

  it('writes the skeleton but logs one line instead of recreating the view when the tab is closed during the write', async () => {
    const extensionApi = await findExtension().activate();
    const uri = vscode.Uri.parse('ahve-skeleton-test://workspace/notes/bootstrap-skeleton-closed-scratch.html');
    const fileSystem = new DelayedFileSystem(uri, '');
    const registration = vscode.workspace.registerFileSystemProvider(uri.scheme, fileSystem, { isCaseSensitive: true });
    const write = fileSystem.pauseNextWrite();
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
      await readInitializeMessage(uri);
      extensionApi.clearDiagnosticInspection();

      assert.ok(
        await extensionApi.injectViewMessage(uri.toString(), { type: 'documentSkeletonRequested' }),
        'could not deliver the skeleton request because there is no session',
      );
      // Dispatch only starts the request. Wait for the actual write, then hold it until the panel's disposal has
      // unregistered the session. Neither completion of dispatch nor closeAllEditors guarantees this order.
      let writeReached = false;
      void write.reached.then(() => {
        writeReached = true;
      });
      await waitUntil(() => writeReached, 'the skeleton write started');
      assert.strictEqual(fileSystem.readText(), '', 'the skeleton write is still paused');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await waitUntil(
        () => !extensionApi.readSessionInspection().documentUris.includes(uri.toString()),
        'the closed panel unregistered its session',
      );
      write.release();
      await waitUntil(() => fileSystem.writtenUris.length === 1, 'the skeleton write completed');
      fileSystem.notifyWrittenFile();
      await waitUntil(
        () => extensionApi.readDiagnosticInspection().logLines.some((line) => line.includes('the tab was closed')),
        'the closed tab was logged',
      );

      const skeleton = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n'
        + '<title>bootstrap-skeleton-closed-scratch</title>\n</head>\n<body>\n</body>\n</html>\n';
      assert.deepStrictEqual(
        {
          file: await readFileText(uri),
          initializeTexts: await readInitializeTexts(uri),
          notifications: extensionApi.readDiagnosticInspection().notifications,
          closedTabLogs: extensionApi.readDiagnosticInspection().logLines.filter((line) => line.includes('the tab was closed')),
          hasCustomTab: vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => customTabMatchesSource(tab, uri))),
        },
        {
          file: skeleton,
          initializeTexts: [''],
          notifications: [],
          closedTabLogs: [`Did not recreate the view after writing the skeleton because the tab was closed: ${uri.toString()}`],
          hasCustomTab: false,
        },
      );
    } finally {
      write.release();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      registration.dispose();
      fileSystem.dispose();
    }
  });
});
