import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { customTabMatchesSource } from '../helpers/editor-tabs';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';
const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;
const SCRATCH_FILE_NAME = 'test-hooks-scratch.html';
const MISSING_FILE_NAME = 'test-hooks-missing.html';

const INITIAL_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>initial</p>\n</body>\n</html>\n';
const FIRST_REPLACEMENT = INITIAL_TEXT.replace('initial', 'first');
const SECOND_REPLACEMENT = INITIAL_TEXT.replace('initial', 'second');

interface RecordedMessage {
  readonly direction: 'fromView' | 'toView';
  readonly message: unknown;
}

interface WebviewInspection {
  readonly html: string;
  readonly messages: readonly RecordedMessage[];
}

interface SessionInspection {
  readonly documentUris: readonly string[];
  readonly activeDocumentUri: string | undefined;
}

interface DiagnosticInspection {
  readonly notifications: readonly string[];
  readonly logLines: readonly string[];
}

interface SaveEntryCall {
  readonly kind: 'save' | 'saveAs' | 'revert';
  readonly documentUri: string;
}

interface ExtensionApi {
  readWebviewInspection(documentUri: string): WebviewInspection | undefined;
  readSessionInspection(): SessionInspection;
  readDiagnosticInspection(): DiagnosticInspection;
  clearDiagnosticInspection(): void;
  readSaveEntryInspection(): { readonly calls: readonly SaveEntryCall[] };
  clearSaveEntryInspection(): void;
  injectViewMessage(documentUri: string, message: unknown): Promise<boolean>;
  replaceViewContentForTest(documentUri: string, text: string): Promise<boolean>;
}

function findExtension(): vscode.Extension<ExtensionApi> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} is not loaded in VS Code`);
  return extension;
}

async function api(): Promise<ExtensionApi> {
  return findExtension().activate();
}

function fixtureUri(fileName: string): vscode.Uri {
  return vscode.Uri.joinPath(
    findExtension().extensionUri,
    'tests',
    'integration',
    'fixtures',
    fileName,
  );
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  for (;;) {
    if (await condition()) {
      return;
    }
    assert.ok(Date.now() < deadline, description);
    await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));
  }
}

function findCustomTab(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find(
      (tab) => customTabMatchesSource(tab, uri),
    );
}

async function writeFileText(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

async function readFileText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

async function deleteIfPresent(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri);
  } catch {
    // Cleaning up a test file that is not there is the same as having cleaned it up already.
  }
}

async function resetScratch(): Promise<vscode.Uri> {
  const uri = fixtureUri(SCRATCH_FILE_NAME);
  await writeFileText(uri, INITIAL_TEXT);
  return uri;
}

async function openWysiwyg(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
  await waitUntil(
    async () => ((await api()).readWebviewInspection(uri.toString())?.messages.length ?? 0) >= 2,
    'The view did not finish the startup message exchange',
  );
}

// Full document text most recently handed to the view. The view holds it as is, so its output is this text too.
async function readViewText(uri: vscode.Uri): Promise<string> {
  const messages = (await api()).readWebviewInspection(uri.toString())?.messages ?? [];
  const texts = messages
    .filter((recorded) => recorded.direction === 'toView')
    .flatMap((recorded) => {
      const value: unknown = typeof recorded.message === 'object' && recorded.message !== null
        ? Object.getOwnPropertyDescriptor(recorded.message, 'text')?.value
        : undefined;
      return typeof value === 'string' ? [value] : [];
    });
  assert.ok(texts.length > 0, 'The view has not been given any document text yet');
  return texts[texts.length - 1];
}

// Sequence number for injected edit units. Reusing an id would make it count as the previous unit's terminator.
let injectedEditUnits = 0;

// The extension host cannot send key input to the webview, so the signal sequence a real view sends for one edit
// is injected in the same order. The after full text is the full text the view currently holds, because the
// history side compares it with the output right before saving.
async function makeViewDirty(uri: vscode.Uri): Promise<void> {
  const after = { text: await readViewText(uri), selection: null };
  // The before text only has to differ from the after text. An identical pair is rejected as invalid.
  const before = { text: `${after.text}<!-- before -->`, selection: null };
  injectedEditUnits += 1;
  const unitId = `integration-${injectedEditUnits}`;

  for (const message of [
    { type: 'viewEdited' },
    { type: 'editUnitStart', unitId, start: before },
    { type: 'editTransaction', transaction: { unitId, before, after } },
  ]) {
    assert.strictEqual(await (await api()).injectViewMessage(uri.toString(), message), true);
  }

  await waitUntil(
    () => findCustomTab(uri)?.isDirty === true,
    'The WYSIWYG tab did not become dirty',
  );
}

async function resetEditors(): Promise<void> {
  const dirtyCustomTab = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((tab) => tab.input instanceof vscode.TabInputCustom && tab.isDirty);
  if (dirtyCustomTab !== undefined) {
    // The full text used here is a valid document, so saving it gets the tab back to a state where
    // it can be closed without a confirmation prompt.
    await vscode.commands.executeCommand('workbench.action.files.save');
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

function messageType(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const value: unknown = Object.getOwnPropertyDescriptor(message, 'type')?.value;
  return typeof value === 'string' ? value : undefined;
}

describe('test support API', () => {
  beforeEach(async () => {
    await resetEditors();
    await deleteIfPresent(fixtureUri(MISSING_FILE_NAME));
    (await api()).clearDiagnosticInspection();
    (await api()).clearSaveEntryInspection();
  });

  afterEach(async () => {
    await resetEditors();
  });

  after(async () => {
    await deleteIfPresent(fixtureUri(SCRATCH_FILE_NAME));
    await deleteIfPresent(fixtureUri(MISSING_FILE_NAME));
  });

  it('exposes the save entry inspection when the extension runs as a test', async () => {
    const uri = await resetScratch();
    await openWysiwyg(uri);
    await makeViewDirty(uri);

    await vscode.commands.executeCommand('workbench.action.files.save');
    await waitUntil(
      async () => (await api()).readSaveEntryInspection().calls.length > 0,
      'The save entry inspection did not gain a call',
    );

    assert.ok(
      (await api()).readSaveEntryInspection().calls.some(
        (call) => call.kind === 'save' && call.documentUri === uri.toString(),
      ),
    );
  });

  it('shows a reported notification in the diagnostic inspection when the extension runs as a test', async () => {
    await vscode.commands.executeCommand(
      'vscode.openWith',
      fixtureUri(MISSING_FILE_NAME),
      HTML_EDITOR_VIEW_TYPE,
    );

    await waitUntil(
      async () => (await api()).readDiagnosticInspection().notifications.length > 0,
      'The reported notification did not appear in the diagnostic inspection',
    );

    assert.ok((await api()).readDiagnosticInspection().notifications[0]?.length > 0);
  });

  it('shows an open tab in the session inspection', async () => {
    const uri = fixtureUri('sample.html');
    await openWysiwyg(uri);

    assert.ok((await api()).readSessionInspection().documentUris.includes(uri.toString()));
  });

  it('reads the same panel options through a spelling that differs in percent-encoding', async () => {
    const uri = fixtureUri('sample.html');
    await openWysiwyg(uri);
    const encodedUri = uri.toString().replace('sample.html', '%73ample.html');

    assert.ok(((await api()).readWebviewInspection(encodedUri)?.html.length ?? 0) > 0);
  });

  it('finds the same session on Windows through a spelling whose drive letter differs in case', async function () {
    if (process.platform !== 'win32') {
      this.skip();
    }
    const uri = fixtureUri('sample.html');
    await openWysiwyg(uri);
    const value = uri.toString();
    const driveIndex = 'file:///'.length;
    const drive = value[driveIndex];
    assert.ok(drive !== undefined, 'The URI has no drive letter');
    const toggledDrive = drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase();
    const toggledUri = `${value.slice(0, driveIndex)}${toggledDrive}${value.slice(driveIndex + 1)}`;

    assert.ok((await api()).readWebviewInspection(toggledUri));
  });

  it('reports no target for a spelling that differs only in the case of the path itself', async () => {
    const uri = fixtureUri('sample.html');
    await openWysiwyg(uri);
    const changedPathUri = uri.toString().replace('sample.html', 'Sample.html');

    assert.strictEqual((await api()).readWebviewInspection(changedPathUri), undefined);
  });

  it('reports no target instead of throwing for a spelling that cannot be parsed as a URI', async () => {
    assert.strictEqual((await api()).readWebviewInspection('not a URI'), undefined);
  });

  it('writes the replaced full text to the file through a view edited message and a save', async () => {
    const uri = await resetScratch();
    await openWysiwyg(uri);
    assert.strictEqual(
      await (await api()).replaceViewContentForTest(uri.toString(), FIRST_REPLACEMENT),
      true,
    );
    await makeViewDirty(uri);

    await vscode.commands.executeCommand('workbench.action.files.save');
    await waitUntil(
      async () => await readFileText(uri) === FIRST_REPLACEMENT,
      'The replaced full text was not written to the file',
    );

    assert.strictEqual(await readFileText(uri), FIRST_REPLACEMENT);
  });

  it('applies a second replacement to a view that has already become dirty', async () => {
    const uri = await resetScratch();
    await openWysiwyg(uri);
    assert.strictEqual(
      await (await api()).replaceViewContentForTest(uri.toString(), FIRST_REPLACEMENT),
      true,
    );
    await makeViewDirty(uri);

    assert.strictEqual(
      await (await api()).replaceViewContentForTest(uri.toString(), SECOND_REPLACEMENT),
      true,
    );
  });

  it('marks the tab dirty from injecting a view edited message alone', async () => {
    const uri = await resetScratch();
    await openWysiwyg(uri);

    await makeViewDirty(uri);

    assert.strictEqual(findCustomTab(uri)?.isDirty, true);
  });

  it('shows an injected message in the record of messages from the view', async () => {
    const uri = await resetScratch();
    await openWysiwyg(uri);

    await makeViewDirty(uri);

    assert.ok(
      (await api()).readWebviewInspection(uri.toString())?.messages.some(
        (recorded) => recorded.direction === 'fromView'
          && messageType(recorded.message) === 'viewEdited',
      ),
    );
  });
});
