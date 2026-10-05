import * as assert from 'node:assert';
import * as vscode from 'vscode';

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
  readWebviewInspection(documentUri: string): WebviewInspection | undefined;
  readSessionInspection(): SessionInspection;
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
