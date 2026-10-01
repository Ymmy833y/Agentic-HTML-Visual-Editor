import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';

// This must match the package.json declaration, or the WYSIWYG editor cannot be opened.
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

// Maximum time for the view to load and complete its exchange with the host.
const ROUND_TRIP_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

interface DiagnosticInspection {
  readonly notifications: readonly string[];
  readonly logLines: readonly string[];
}

interface RecordedMessage {
  readonly direction: 'fromView' | 'toView';
  readonly message: unknown;
}

interface WebviewInspection {
  readonly messages: readonly RecordedMessage[];
}

interface ExtensionApi {
  readDiagnosticInspection(): DiagnosticInspection;
  clearDiagnosticInspection(): void;
  readWebviewInspection(documentUri: string): WebviewInspection | undefined;
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

async function readDiagnosticInspection(): Promise<DiagnosticInspection> {
  return (await findExtension().activate()).readDiagnosticInspection();
}

// Reports originate from asynchronous message handling, which has no completion signal. Wait with a
// deadline until the expected counts are reached.
async function waitForDiagnostics(
  isSatisfied: (inspection: DiagnosticInspection) => boolean,
  description: string,
): Promise<DiagnosticInspection> {
  const deadline = Date.now() + ROUND_TRIP_TIMEOUT_MS;

  for (;;) {
    const inspection = await readDiagnosticInspection();
    if (isSatisfied(inspection)) {
      return inspection;
    }
    assert.ok(Date.now() < deadline, description);
    await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));
  }
}

async function waitForRecordedMessages(uri: vscode.Uri, count: number): Promise<readonly RecordedMessage[]> {
  const deadline = Date.now() + ROUND_TRIP_TIMEOUT_MS;

  for (;;) {
    const inspection = (await findExtension().activate()).readWebviewInspection(uri.toString());
    const messages = inspection?.messages ?? [];
    if (messages.length >= count) {
      return messages;
    }
    assert.ok(Date.now() < deadline, `Timed out before ${count} messages were recorded`);
    await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));
  }
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
    const inspection = (await findExtension().activate()).readWebviewInspection(uri.toString());
    const found = (inspection?.messages ?? []).find(
      (recorded) => recorded.direction === direction && readMessageType(recorded.message) === type,
    );
    if (found !== undefined) {
      return found;
    }
    assert.ok(Date.now() < deadline, `Timed out before a ${direction} ${type} message was recorded`);
    await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));
  }
}

function readMessageType(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type: unknown = Object.getOwnPropertyDescriptor(message, 'type')?.value;
  return typeof type === 'string' ? type : undefined;
}

describe('error notifications and diagnostic logs', () => {
  // This file must remain absent. Creating it would change these tests to exercise the openable path.
  const missing = (): vscode.Uri => fixtureUri('does-not-exist.html');
  const openable = (): vscode.Uri => fixtureUri('sample.html');

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // The inspection accumulates throughout the extension's lifetime. Close all editors before clearing
    // it so each test observes only its own reports.
    (await findExtension().activate()).clearDiagnosticInspection();
  });

  it('has no notifications or diagnostic log lines immediately after clearing the inspection', async () => {
    const inspection = await readDiagnosticInspection();

    assert.deepStrictEqual(
      { notifications: [...inspection.notifications], logLines: [...inspection.logLines] },
      { notifications: [], logLines: [] },
    );
  });

  it('adds no notification or diagnostic log line when an openable file is opened in the WYSIWYG editor', async () => {
    const uri = openable();

    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
    await waitForRecordedMessages(uri, 2);

    const inspection = await readDiagnosticInspection();
    assert.deepStrictEqual([inspection.notifications.length, inspection.logLines.length], [0, 0]);
  });

  it('adds one notification when a missing file is opened in the WYSIWYG editor', async () => {
    await vscode.commands.executeCommand('vscode.openWith', missing(), HTML_EDITOR_VIEW_TYPE);

    const inspection = await waitForDiagnostics(
      (current) => current.notifications.length > 0,
      'No notification was shown for the unreadable file',
    );
    assert.strictEqual(inspection.notifications.length, 1);
  });

  it('adds one diagnostic log line for the cause when a missing file is opened in the WYSIWYG editor', async () => {
    await vscode.commands.executeCommand('vscode.openWith', missing(), HTML_EDITOR_VIEW_TYPE);

    const inspection = await waitForDiagnostics(
      (current) => current.logLines.length > 0,
      'The cause of the read failure was not recorded in the diagnostic log',
    );
    assert.strictEqual(inspection.logLines.length, 1);
  });

  it('can open another file in the WYSIWYG editor after opening a missing file', async () => {
    await vscode.commands.executeCommand('vscode.openWith', missing(), HTML_EDITOR_VIEW_TYPE);
    await waitForDiagnostics(
      (current) => current.notifications.length > 0,
      'No notification was shown for the unreadable file',
    );

    const uri = openable();
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);

    // The round trip completing proves the second open succeeded. Check the direction so a message the
    // view sent could not satisfy it.
    const initialize = await waitForRecordedMessage(uri, 'toView', 'initialize');
    assert.strictEqual(initialize.direction, 'toView');
  });
});
