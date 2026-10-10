import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { customTabMatchesSource, waitForEditorEntryToClose } from '../helpers/editor-tabs';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

// Upper bound and polling interval for waiting on the view to load and on tab and group changes.
const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

// How long to wait before concluding that no notice came. Tab and group events reach the extension host within a
// few event loop turns, so a notice that is coming arrives well within this.
const NO_NOTICE_SETTLE_MS = 1000;

interface ExtensionApi {
  getMessage(key: string): string;
  readSessionInspection(): { readonly activeDocumentUri: string | undefined };
  readDiagnosticInspection(): { readonly notifications: readonly string[] };
  clearDiagnosticInspection(): void;
}

function findExtension(): vscode.Extension<ExtensionApi> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `extension ${EXTENSION_ID} is not loaded in VS Code`);
  return extension;
}

async function api(): Promise<ExtensionApi> {
  return findExtension().activate();
}

function fixtureUri(fileName: string): vscode.Uri {
  return vscode.Uri.joinPath(findExtension().extensionUri, 'tests', 'integration', 'fixtures', fileName);
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
    assert.ok(Date.now() < deadline, `timed out waiting until ${description}`);
    await delay(POLLING_INTERVAL_MS);
  }
}

function findCustomTab(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((tab) => customTabMatchesSource(tab, uri));
}

// Wait until the WYSIWYG session is the active one, so the split starts from the WYSIWYG tab.
async function openWysiwyg(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
  await waitForEditorEntryToClose(uri);
  await waitUntil(
    async () => (await api()).readSessionInspection().activeDocumentUri === uri.toString(),
    'the WYSIWYG session becomes active',
  );
}

describe('split notice', () => {
  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('workbench.action.closeEditorsInOtherGroups');
    await vscode.commands.executeCommand('workbench.action.editorLayoutSingle');
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('workbench.action.editorLayoutSingle');
  });

  it('shows one notice when the WYSIWYG tab is split to the right', async () => {
    const extensionApi = await api();
    await openWysiwyg(fixtureUri('sample.html'));
    extensionApi.clearDiagnosticInspection();

    await vscode.commands.executeCommand('workbench.action.splitEditorRight');
    await waitUntil(() => extensionApi.readDiagnosticInspection().notifications.length > 0, 'a notice is shown');
    await delay(NO_NOTICE_SETTLE_MS);

    assert.deepStrictEqual(extensionApi.readDiagnosticInspection().notifications, [
      extensionApi.getMessage('splitEditor.unavailable.message'),
    ]);
  });

  it('shows no notice when a text editor tab is split', async () => {
    const extensionApi = await api();
    await vscode.window.showTextDocument(fixtureUri('sample.html'), { preview: false });
    extensionApi.clearDiagnosticInspection();

    await vscode.commands.executeCommand('workbench.action.splitEditorRight');
    await waitUntil(() => vscode.window.tabGroups.all.length === 2, 'the split adds a group');
    await delay(NO_NOTICE_SETTLE_MS);

    assert.deepStrictEqual(extensionApi.readDiagnosticInspection().notifications, []);
  });

  it('shows no notice when the WYSIWYG tab is moved to a new group on the right', async () => {
    const extensionApi = await api();
    const uri = fixtureUri('sample.html');
    await openWysiwyg(uri);
    const sourceGroup = findCustomTab(uri)?.group;
    extensionApi.clearDiagnosticInspection();

    await vscode.commands.executeCommand('workbench.action.moveEditorToRightGroup');
    await waitUntil(() => {
      const group = findCustomTab(uri)?.group;
      return group !== undefined && group !== sourceGroup;
    }, 'the WYSIWYG tab is in another group');
    await delay(NO_NOTICE_SETTLE_MS);

    assert.deepStrictEqual(extensionApi.readDiagnosticInspection().notifications, []);
  });
});
