import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { customTabMatchesSource } from '../helpers/editor-tabs';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';

// The WYSIWYG editor cannot be opened unless this matches the declaration in package.json.
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

// The upper bounds for loading the view, for a round trip, and for a change of the tab's state.
const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

// Saving rewrites the disk, so no fixed file checked into the repository is used.
const SCRATCH_FILE_NAME = 'ui-shell-scratch.html';
// Entering the protection leaves a protection backup behind, and reopening the same source starts a
// restore, so a separate file is used.
const PROTECTION_SCRATCH_FILE_NAME = 'ui-shell-protection-scratch.html';
// 0xFF never occurs in UTF-8, so a strict decoder rejects this content.
const NOT_UTF8_BYTES = new Uint8Array([0xff, 0xfe, 0x00]);
// A separate file, for confirming that nothing but the sender is saved.
const OTHER_FILE_NAME = 'ui-shell-other-scratch.html';

const INITIAL_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>ab</p>\n</body>\n</html>\n';
const EDITED_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>edited</p>\n</body>\n</html>\n';

interface RecordedMessage {
  readonly direction: 'fromView' | 'toView';
  readonly message: unknown;
}

interface ExtensionApi {
  readWebviewInspection(documentUri: string): { readonly messages: readonly RecordedMessage[] } | undefined;
  readDiagnosticInspection(): {
    readonly notifications: readonly string[];
    readonly logLines: readonly string[];
  };
  clearDiagnosticInspection(): void;
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

// The extension path handed to the development host is the repository root.
function fixtureUri(fileName: string): vscode.Uri {
  return vscode.Uri.joinPath(
    findExtension().extensionUri,
    'tests',
    'integration',
    'fixtures',
    fileName,
  );
}

function openTabs(): readonly vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

function findCustomTab(uri: vscode.Uri): vscode.Tab | undefined {
  return openTabs().find((tab) => customTabMatchesSource(tab, uri));
}

function findTextTab(uri: vscode.Uri): vscode.Tab | undefined {
  return openTabs().find(
    (tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString(),
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(condition: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;

  for (;;) {
    if (await condition()) {
      return;
    }
    assert.ok(Date.now() < deadline, `Timed out before ${description}`);
    await delay(POLLING_INTERVAL_MS);
  }
}

async function readFileText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

async function writeFileText(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

// Writes back to disk and waits for a buffer that is still open to catch up with that content.
async function resetScratch(fileName: string, text: string = INITIAL_TEXT): Promise<vscode.Uri> {
  const uri = fixtureUri(fileName);
  await writeFileText(uri, text);

  const document = await vscode.workspace.openTextDocument(uri);
  await waitUntil(() => document.getText() === text, 'the open buffer catches up with the initial content');
  return uri;
}

async function readRecordedMessages(uri: vscode.Uri): Promise<readonly RecordedMessage[]> {
  return (await api()).readWebviewInspection(uri.toString())?.messages ?? [];
}

function readMessageType(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const value: unknown = Object.getOwnPropertyDescriptor(message, 'type')?.value;
  return typeof value === 'string' ? value : undefined;
}

function readMessageText(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const value: unknown = Object.getOwnPropertyDescriptor(message, 'text')?.value;
  return typeof value === 'string' ? value : undefined;
}

function readMessageDirty(message: unknown): boolean | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const value: unknown = Object.getOwnPropertyDescriptor(message, 'dirty')?.value;
  return typeof value === 'boolean' ? value : undefined;
}

/** Returns the types of the messages sent from the host to the view, in the order they were sent. */
async function readTypesSentToView(uri: vscode.Uri): Promise<string[]> {
  const messages = await readRecordedMessages(uri);
  return messages
    .filter((recorded) => recorded.direction === 'toView')
    .flatMap((recorded) => {
      const type = readMessageType(recorded.message);
      return type === undefined ? [] : [type];
    });
}

/** Returns the dirty state values sent to the view, in the order they were sent. */
async function readDirtyStates(uri: vscode.Uri): Promise<boolean[]> {
  const messages = await readRecordedMessages(uri);
  return messages
    .filter((recorded) => recorded.direction === 'toView' && readMessageType(recorded.message) === 'dirtyState')
    .flatMap((recorded) => {
      const dirty = readMessageDirty(recorded.message);
      return dirty === undefined ? [] : [dirty];
    });
}

// Loading the view gives no completion signal, so this waits until the startup round trip is done.
async function openWysiwyg(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
  await waitUntil(async () => (await readRecordedMessages(uri)).length >= 2, 'the view exchanges the startup messages');
}

/**
 * The full document text most recently handed to the view. The view keeps it as is, so the output
 * comes back as this same text.
 */
async function readViewText(uri: vscode.Uri): Promise<string> {
  const texts = (await readRecordedMessages(uri))
    .filter((recorded) => recorded.direction === 'toView')
    .flatMap((recorded) => {
      const text = readMessageText(recorded.message);
      return text === undefined ? [] : [text];
    });
  assert.ok(texts.length > 0, 'no document text has been handed to the view yet');
  return texts[texts.length - 1];
}

// The running number of the injected edit units. Reusing the same ID would count as the terminator
// of the previous unit.
let injectedEditUnits = 0;

// Key input in the webview cannot be driven from the extension host, so the signals a real view
// sends for one edit are injected in that same order.
async function makeViewDirty(uri: vscode.Uri): Promise<void> {
  const after = { text: await readViewText(uri), selection: null };
  const before = { text: `${after.text}<!-- before -->`, selection: null };
  injectedEditUnits += 1;
  const unitId = `ui-shell-${injectedEditUnits}`;

  for (const message of [
    { type: 'viewEdited' },
    { type: 'editUnitStart', unitId, start: before },
    { type: 'editTransaction', transaction: { unitId, before, after } },
  ]) {
    const dispatched = await (await api()).injectViewMessage(uri.toString(), message);
    assert.ok(dispatched, 'the message was not delivered because no session is registered');
  }

  await waitUntil(() => findCustomTab(uri)?.isDirty === true, 'the WYSIWYG tab becomes dirty');
}

/**
 * Replaces the tree of the live view, so that the next output request returns this text.
 */
async function replaceViewContent(uri: vscode.Uri, text: string): Promise<void> {
  const replaced = await (await api()).replaceViewContentForTest(uri.toString(), text);
  assert.ok(replaced, 'the view did not accept the replacement from the test');
}

/** Injects the same save request that a press on the toolbar's save button sends. */
async function injectSaveRequest(uri: vscode.Uri): Promise<void> {
  const dispatched = await (await api()).injectViewMessage(uri.toString(), { type: 'saveRequested' });
  assert.ok(dispatched, 'the save request was not delivered because no session is registered');
}

// A dirty text tab left behind would stall the next test's cleanup on a confirmation dialog.
async function revertDirtyTextEditors(): Promise<void> {
  for (const tab of openTabs()) {
    if (tab.input instanceof vscode.TabInputText && tab.isDirty) {
      await vscode.window.showTextDocument(tab.input.uri);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  }
}

async function deleteIfPresent(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri);
  } catch {
    // Nothing more than an attempt to delete a file that was never created.
  }
}

describe('accepting the save request', () => {
  beforeEach(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await resetScratch(SCRATCH_FILE_NAME);
    (await api()).clearDiagnosticInspection();
  });

  after(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await deleteIfPresent(fixtureUri(SCRATCH_FILE_NAME));
    await deleteIfPresent(fixtureUri(OTHER_FILE_NAME));
  });

  it('writes the file and clears the dirty mark when a save request is injected into a dirty WYSIWYG tab', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    await openWysiwyg(uri);
    await replaceViewContent(uri, EDITED_TEXT);
    await makeViewDirty(uri);

    await injectSaveRequest(uri);

    await waitUntil(() => findCustomTab(uri)?.isDirty === false, "the WYSIWYG tab's dirty mark clears");
    assert.strictEqual(await readFileText(uri), EDITED_TEXT);
  });

  it('saves only the sender when the request is injected while another editor is active', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    const otherUri = await resetScratch(OTHER_FILE_NAME);
    await openWysiwyg(uri);
    await replaceViewContent(uri, EDITED_TEXT);
    await makeViewDirty(uri);
    // Brings the text editor of another file to the front and leaves it dirty.
    await vscode.window.showTextDocument(otherUri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(otherUri, new vscode.Position(3, 0), 'Z');
    assert.ok(await vscode.workspace.applyEdit(edit), 'the edit to the text buffer was not applied');
    await waitUntil(() => findTextTab(otherUri)?.isDirty === true, 'the other text tab becomes dirty');

    await injectSaveRequest(uri);

    await waitUntil(() => findCustomTab(uri)?.isDirty === false, "the WYSIWYG tab's dirty mark clears");
    assert.deepStrictEqual(
      [await readFileText(uri), await readFileText(otherUri), findTextTab(otherUri)?.isDirty],
      [EDITED_TEXT, INITIAL_TEXT, true],
    );
  });
});

describe('a save request while protected', () => {
  beforeEach(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    (await api()).clearDiagnosticInspection();
  });

  after(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await deleteIfPresent(fixtureUri(PROTECTION_SCRATCH_FILE_NAME));
  });

  it('writes nothing and shows the protection notice when the request is injected into a protected document', async () => {
    const uri = await resetScratch(PROTECTION_SCRATCH_FILE_NAME);
    await vscode.commands.executeCommand('vscode.open', uri);
    await openWysiwyg(uri);
    // A revert while the text tab is dirty reads the file on disk, and a file that is not UTF-8 makes it fail
    // and enter the protection.
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(3, 0), 'Z');
    assert.ok(await vscode.workspace.applyEdit(edit), 'the edit to the text buffer was not applied');
    await waitUntil(() => findTextTab(uri)?.isDirty === true, 'the text tab becomes dirty');
    await vscode.workspace.fs.writeFile(uri, NOT_UTF8_BYTES);
    await makeViewDirty(uri);
    await vscode.commands
      .executeCommand('workbench.action.files.revert')
      .then(undefined, () => undefined);
    await waitUntil(
      async () => (await api()).readDiagnosticInspection().notifications.length >= 2,
      'the revert failure and the protection notice appear',
    );
    await replaceViewContent(uri, EDITED_TEXT);
    (await api()).clearDiagnosticInspection();

    await injectSaveRequest(uri);

    await waitUntil(
      async () => (await api()).readDiagnosticInspection().notifications.length >= 1,
      'the protection notice appears',
    );
    assert.deepStrictEqual(Array.from(await vscode.workspace.fs.readFile(uri)), Array.from(NOT_UTF8_BYTES));
    // Put a readable file back so that the text side can be reverted in the cleanup.
    await writeFileText(uri, INITIAL_TEXT);
  });
});

describe('notifying the dirty state', () => {
  beforeEach(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await resetScratch(SCRATCH_FILE_NAME);
    (await api()).clearDiagnosticInspection();
  });

  after(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await deleteIfPresent(fixtureUri(SCRATCH_FILE_NAME));
  });

  it('follows the initialize message with one dirty state on a normal startup', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);

    await openWysiwyg(uri);

    await waitUntil(async () => (await readDirtyStates(uri)).length >= 1, 'a dirty state arrives');
    const types = await readTypesSentToView(uri);
    assert.strictEqual(types[types.indexOf('initialize') + 1], 'dirtyState');
  });

  it('sends a dirty state of true to the view when an edit notice sets the dirty mark', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    await openWysiwyg(uri);

    await makeViewDirty(uri);

    await waitUntil(async () => (await readDirtyStates(uri)).includes(true), 'a dirty state of true arrives');
  });

  it('sends a dirty state of false to the view when a save clears the dirty mark', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    await openWysiwyg(uri);
    await makeViewDirty(uri);
    await waitUntil(async () => (await readDirtyStates(uri)).includes(true), 'a dirty state of true arrives');

    await injectSaveRequest(uri);

    await waitUntil(
      async () => (await readDirtyStates(uri)).lastIndexOf(false) > (await readDirtyStates(uri)).lastIndexOf(true),
      'a dirty state of false arrives last',
    );
  });

  it('sends nothing and leaves one diagnostic line when a trigger arrives after the tab was closed', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    await openWysiwyg(uri);
    (await api()).clearDiagnosticInspection();

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    await waitUntil(
      async () => (await api()).readDiagnosticInspection().logLines.some(
        (line) => line.includes('Could not read the dirty mark'),
      ),
      'the diagnostic that the tab could not be found is left behind',
    );
  });
});
