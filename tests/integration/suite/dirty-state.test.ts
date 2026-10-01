import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { customTabMatchesSource, waitForEditorEntryToClose } from '../helpers/editor-tabs';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';

// This must match the package.json declaration, or the WYSIWYG editor cannot be opened.
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

// Upper bound for view loading, round trips, and tab state changes.
const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

// Scratch file. Save verification changes the disk, so do not use a fixed repository file.
const SCRATCH_FILE_NAME = 'dirty-state-scratch.html';
const SCRATCH_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>ab</p>\n</body>\n</html>\n';
const UNSAVED_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>abX</p>\n</body>\n</html>\n';

interface RecordedMessage {
  readonly direction: 'fromView' | 'toView';
  readonly message: unknown;
}

interface WebviewInspection {
  readonly messages: readonly RecordedMessage[];
}

interface ExtensionApi {
  readWebviewInspection(documentUri: string): WebviewInspection | undefined;
  injectViewMessage(documentUri: string, message: unknown): Promise<boolean>;
}

function findExtension(): vscode.Extension<ExtensionApi> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} is not loaded in VS Code`);
  return extension;
}

// The extension path passed to the development host is the repository root.
function scratchUri(): vscode.Uri {
  return vscode.Uri.joinPath(
    findExtension().extensionUri,
    'tests',
    'integration',
    'fixtures',
    SCRATCH_FILE_NAME,
  );
}

function openTabs(): readonly vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

function findCustomTab(uri: vscode.Uri): vscode.Tab | undefined {
  return openTabs().find(
    (tab) => customTabMatchesSource(tab, uri),
  );
}

function findTextTab(uri: vscode.Uri): vscode.Tab | undefined {
  return openTabs().find(
    (tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString(),
  );
}

// VS Code does not notify when a tab state changes, so poll until the condition is met.
async function waitUntil(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;

  for (;;) {
    if (condition()) {
      return;
    }
    assert.ok(Date.now() < deadline, `Timed out before ${description}`);
    await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));
  }
}

async function readRecordedMessages(uri: vscode.Uri): Promise<readonly RecordedMessage[]> {
  const inspection = (await findExtension().activate()).readWebviewInspection(uri.toString());
  return inspection?.messages ?? [];
}

// View loading is asynchronous and has no completion signal, so poll until the records are ready.
async function waitForRecordedMessages(uri: vscode.Uri, count: number): Promise<readonly RecordedMessage[]> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;

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

// The text of the most recent initialize message sent to the view.
async function readLatestInitializeText(uri: vscode.Uri): Promise<string | undefined> {
  const messages = await readRecordedMessages(uri);
  const initializes = messages.filter(
    (recorded) => recorded.direction === 'toView' && readMessageField(recorded.message, 'type') === 'initialize',
  );
  return readMessageField(initializes[initializes.length - 1]?.message, 'text');
}

// Wait for the view ready response to finish so later injections reach the registered session.
async function openWysiwyg(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
  await waitForRecordedMessages(uri, 2);
}

async function inject(uri: vscode.Uri, message: unknown): Promise<void> {
  const dispatched = await (await findExtension().activate()).injectViewMessage(uri.toString(), message);
  assert.ok(dispatched, 'The message was not dispatched because no session is registered');
}

// A sequence number for injected edit units. Reusing an id would count as the terminator of the previous unit.
let injectedEditUnits = 0;

// With edit events, the dirty indicator is raised by an edit unit start, not by a content-less view edited message.
// Inject the view edited message and the start in the same order as the real view.
async function makeViewDirty(uri: vscode.Uri): Promise<void> {
  injectedEditUnits += 1;
  await inject(uri, { type: 'viewEdited' });
  await inject(uri, {
    type: 'editUnitStart',
    unitId: `dirty-state-${injectedEditUnits}`,
    start: { text: SCRATCH_TEXT, selection: null },
  });
  await waitUntil(() => findCustomTab(uri)?.isDirty === true, 'the WYSIWYG tab became dirty');
}

async function editTextBuffer(uri: vscode.Uri): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(3, 0), 'Z');
  assert.ok(await vscode.workspace.applyEdit(edit), 'The text buffer edit was not applied');
  await waitUntil(() => findTextTab(uri)?.isDirty === true, 'the text tab became dirty');
}

// A dirty text editor would block the next test's cleanup with a confirmation dialog.
async function revertDirtyTextEditors(): Promise<void> {
  for (const tab of openTabs()) {
    if (tab.input instanceof vscode.TabInputText && tab.isDirty) {
      await vscode.window.showTextDocument(tab.input.uri);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  }
}

describe('dirty-state isolation', () => {
  beforeEach(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.writeFile(scratchUri(), new TextEncoder().encode(SCRATCH_TEXT));
  });

  after(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(scratchUri());
  });

  it('keeps an already dirty tab dirty after another injection', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);
    await makeViewDirty(uri);

    await inject(uri, { type: 'viewEdited' });

    assert.strictEqual(findCustomTab(uri)?.isDirty, true);
  });

  it('marks only the text tab dirty when only the text editor is edited', async () => {
    const uri = scratchUri();
    await vscode.commands.executeCommand('vscode.open', uri);
    await openWysiwyg(uri);

    await editTextBuffer(uri);

    assert.deepStrictEqual(
      [findTextTab(uri)?.isDirty, findCustomTab(uri)?.isDirty],
      [true, false],
    );
  });

  it('raises the WYSIWYG dirty indicator on an edit unit start, independent of the source dirty indicator', async () => {
    const uri = scratchUri();
    await vscode.commands.executeCommand('vscode.open', uri);
    await openWysiwyg(uri);

    await makeViewDirty(uri);

    assert.deepStrictEqual(
      [findTextTab(uri)?.isDirty, findCustomTab(uri)?.isDirty],
      [false, true],
    );
  });

  it('marks both tabs dirty at the same time when both are edited', async () => {
    const uri = scratchUri();
    await vscode.commands.executeCommand('vscode.open', uri);
    await openWysiwyg(uri);

    await editTextBuffer(uri);
    await makeViewDirty(uri);

    assert.deepStrictEqual(
      [findTextTab(uri)?.isDirty, findCustomTab(uri)?.isDirty],
      [true, true],
    );
  });

  it('clears only the text tab dirty state when the text side is saved', async () => {
    const uri = scratchUri();
    await vscode.commands.executeCommand('vscode.open', uri);
    await openWysiwyg(uri);
    await editTextBuffer(uri);
    await makeViewDirty(uri);

    assert.ok(await (await vscode.workspace.openTextDocument(uri)).save(), 'The text buffer was not saved');

    await waitUntil(() => findTextTab(uri)?.isDirty === false, 'the text tab stopped being dirty');
    assert.strictEqual(findCustomTab(uri)?.isDirty, true);
  });

  it('does not add a second tab when the same file is reopened in the WYSIWYG editor', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);

    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE, vscode.ViewColumn.Beside);
    await waitForEditorEntryToClose(uri);

    assert.strictEqual(openTabs().length, 1);
  });
});

describe('passing the last known content', () => {
  beforeEach(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.writeFile(scratchUri(), new TextEncoder().encode(SCRATCH_TEXT));
  });

  after(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(scratchUri());
  });

  it('uses the last known content in the initialize message after a view ready message', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);
    await inject(uri, { type: 'unsavedContent', text: UNSAVED_TEXT });

    await inject(uri, { type: 'viewReady' });

    assert.strictEqual(await readLatestInitializeText(uri), UNSAVED_TEXT);
  });

  it('uses the text buffer in the initialize message when no last known content exists', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);

    await inject(uri, { type: 'viewReady' });

    assert.strictEqual(await readLatestInitializeText(uri), SCRATCH_TEXT);
  });
});
