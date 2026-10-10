import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { customTabMatchesSource } from '../helpers/editor-tabs';

// A test that checks VS Code's own behavior.
// It observes whether revert is called for a document that is not dirty. Save as is called even on a
// clean document, but revert is not necessarily the same. If it is called, revertCustomDocument stops
// being an entry point that merely discards edits: an unedited document would also go through a
// re-read and a replacement that moves the selection, so a short circuit would have to be considered.
// If it is not called, we may assume that there are always edits to discard by the time the entry
// point is reached. The current implementation rests on the latter, so this test is kept to catch the
// behavior changing.

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

// Not being called is not something waiting can confirm, so the record is read after letting things settle.
const SETTLE_MS = 3000;

const SCRATCH_FILE_NAME = 'revert-on-clean-scratch.html';
const INITIAL_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>ab</p>\n</body>\n</html>\n';

interface SaveEntryCall {
  readonly kind: 'save' | 'saveAs' | 'revert';
  readonly documentUri: string;
  readonly at: number;
}

interface ExtensionApi {
  injectViewMessage(documentUri: string, message: unknown): Promise<boolean>;
  readSaveEntryInspection(): { readonly calls: readonly SaveEntryCall[] };
  clearSaveEntryInspection(): void;
}

function findExtension(): vscode.Extension<ExtensionApi> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} is not loaded in VS Code`);
  return extension;
}

async function api(): Promise<ExtensionApi> {
  return findExtension().activate();
}

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

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;

  for (;;) {
    if (condition()) {
      return;
    }
    assert.ok(Date.now() < deadline, `Timed out before ${description}`);
    await delay(POLLING_INTERVAL_MS);
  }
}

// Opens the view and waits until the response to the view ready message has finished.
async function openWysiwyg(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
  await delay(1000);
}

// Injects a view edited message to mark the tab dirty. Key input in the webview cannot be driven from
// the extension host.
// While history events are enabled, the dirty indicator appears only once an edit unit start arrives, so inject it
// right after, just as the real view does.
async function makeViewDirty(uri: vscode.Uri): Promise<void> {
  for (const message of [
    { type: 'viewEdited' },
    { type: 'editUnitStart', unitId: 'revert-on-clean', start: { text: INITIAL_TEXT, selection: null } },
  ]) {
    const dispatched = await (await api()).injectViewMessage(uri.toString(), message);
    assert.ok(dispatched, 'the message was not delivered because no session is registered');
  }
  await waitUntil(() => findCustomTab(uri)?.isDirty === true, 'the WYSIWYG tab became dirty');
}

async function revertCalls(uri: vscode.Uri): Promise<readonly SaveEntryCall[]> {
  const inspection = (await api()).readSaveEntryInspection();
  return inspection.calls.filter(
    (call) => call.kind === 'revert' && call.documentUri === uri.toString(),
  );
}

describe('whether revert is called for a document that is not dirty', () => {
  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.writeFile(scratchUri(), new TextEncoder().encode(INITIAL_TEXT));
    (await api()).clearSaveEntryInspection();
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(scratchUri());
  });

  it('does not call the entry point when the revert command runs on a document that is still clean', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);
    assert.strictEqual(findCustomTab(uri)?.isDirty, false, 'the premise no longer holds: the tab is dirty right after opening');

    await vscode.commands.executeCommand('workbench.action.files.revert');
    await delay(SETTLE_MS);

    assert.deepStrictEqual(
      await revertCalls(uri),
      [],
      'the entry point was called for a clean document; it now has to tell for itself whether there are edits',
    );
  });

  // Evidence that the observation point itself works, showing that the zero above is not merely a
  // failure to record.
  it('calls the entry point when the tab is dirty', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);
    await makeViewDirty(uri);

    await vscode.commands.executeCommand('workbench.action.files.revert');

    await delay(SETTLE_MS);
    assert.strictEqual((await revertCalls(uri)).length, 1, 'the entry point was not called for a dirty document');
  });
});
