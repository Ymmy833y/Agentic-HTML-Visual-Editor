import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { customTabMatchesSource } from '../helpers/editor-tabs';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';

// This must match the package.json declaration, or the WYSIWYG editor cannot be opened.
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

// Registration and unregistration are reflected through tab lifecycle events, so set a bounded wait.
const REGISTRATION_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

interface SessionInspection {
  readonly documentUris: readonly string[];
  readonly activeDocumentUri: string | undefined;
}

interface ExtensionApi {
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

async function readSessionInspection(): Promise<SessionInspection> {
  return (await findExtension().activate()).readSessionInspection();
}

// Session registry updates have no completion signal, so poll with a timeout until the expected state appears.
async function waitForSessions(
  isSatisfied: (inspection: SessionInspection) => boolean,
  description: string,
): Promise<SessionInspection> {
  const deadline = Date.now() + REGISTRATION_TIMEOUT_MS;

  for (;;) {
    const inspection = await readSessionInspection();
    if (isSatisfied(inspection)) {
      return inspection;
    }
    assert.ok(Date.now() < deadline, description);
    await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));
  }
}

function findCustomEditorTab(uri: vscode.Uri): vscode.Tab {
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
  const tab = tabs.find(
    (candidate) =>
      customTabMatchesSource(candidate, uri),
  );
  assert.ok(tab, `No WYSIWYG tab found for ${uri.toString()}`);
  return tab;
}

async function openInWysiwyg(uri: vscode.Uri): Promise<SessionInspection> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
  return waitForSessions(
    (inspection) => inspection.documentUris.includes(uri.toString()),
    `${uri.toString()} did not appear in the session registry`,
  );
}

describe('session registration and unregistration', () => {
  // The second file is used only to add another registration. Registration does not depend on document content.
  const first = (): vscode.Uri => fixtureUri('sample.html');
  const second = (): vscode.Uri => fixtureUri('empty.html');

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitForSessions(
      (inspection) => inspection.documentUris.length === 0,
      'A tab registration from the previous test remains',
    );
  });

  it('registers the file in the session registry when opened in WYSIWYG', async () => {
    const uri = first();

    const inspection = await openInWysiwyg(uri);

    assert.deepStrictEqual([...inspection.documentUris], [uri.toString()]);
  });

  it('sets the file as the active session immediately after opening it in WYSIWYG', async () => {
    const uri = first();

    const inspection = await openInWysiwyg(uri);

    assert.strictEqual(inspection.activeDocumentUri, uri.toString());
  });

  it('switches the active session when switching between two open files', async () => {
    const target = first();
    await openInWysiwyg(target);
    await openInWysiwyg(second());

    // Reopening an open file brings its existing tab to the front, which switches tabs.
    await vscode.commands.executeCommand('vscode.openWith', target, HTML_EDITOR_VIEW_TYPE);

    const inspection = await waitForSessions(
      (current) => current.activeDocumentUri === target.toString(),
      'The active session did not switch to the target',
    );
    assert.strictEqual(inspection.activeDocumentUri, target.toString());
  });

  it('clears the active session when the same file becomes active in a text editor', async () => {
    const uri = first();
    await openInWysiwyg(uri);

    await vscode.commands.executeCommand('vscode.open', uri);

    const inspection = await waitForSessions(
      (current) => current.activeDocumentUri !== uri.toString(),
      'The active session remained after switching to the text editor',
    );
    assert.strictEqual(inspection.activeDocumentUri, undefined);
  });

  it('returns no active session when no WYSIWYG editor is open', async () => {
    const inspection = await readSessionInspection();

    assert.strictEqual(inspection.activeDocumentUri, undefined);
  });

  it('removes the file from the session registry when its tab is closed', async () => {
    const uri = first();
    await openInWysiwyg(uri);

    await vscode.window.tabGroups.close(findCustomEditorTab(uri));

    const inspection = await waitForSessions(
      (current) => !current.documentUris.includes(uri.toString()),
      'The registration remains after closing the tab',
    );
    assert.deepStrictEqual([...inspection.documentUris], []);
  });

  it('clears the active session when the active tab is closed', async () => {
    const uri = first();
    await openInWysiwyg(uri);

    await vscode.window.tabGroups.close(findCustomEditorTab(uri));

    const inspection = await waitForSessions(
      (current) => current.documentUris.length === 0,
      'The registration remains after closing the tab',
    );
    assert.strictEqual(inspection.activeDocumentUri, undefined);
  });

  it('keeps the active session unchanged when only the inactive tab is closed', async () => {
    const closed = first();
    const active = second();
    await openInWysiwyg(closed);
    await openInWysiwyg(active);

    // The later-opened tab is active. Close the other tab without moving focus to verify that closing it
    // does not change the target.
    await vscode.window.tabGroups.close(findCustomEditorTab(closed), true);

    const inspection = await waitForSessions(
      (current) => current.documentUris.length === 1,
      'Closing the inactive tab did not remove its registration',
    );
    assert.strictEqual(inspection.activeDocumentUri, active.toString());
  });

  it('keeps the other registration when one of two tabs is closed', async () => {
    const remaining = first();
    const closed = second();
    await openInWysiwyg(remaining);
    await openInWysiwyg(closed);

    await vscode.window.tabGroups.close(findCustomEditorTab(closed));

    const inspection = await waitForSessions(
      (current) => !current.documentUris.includes(closed.toString()),
      'The closed tab remains registered',
    );
    assert.deepStrictEqual([...inspection.documentUris], [remaining.toString()]);
  });

  it('empties the session registry when all tabs are closed', async () => {
    await openInWysiwyg(first());
    await openInWysiwyg(second());

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const inspection = await waitForSessions(
      (current) => current.documentUris.length === 0,
      'Registrations remain after closing all tabs',
    );
    assert.deepStrictEqual([...inspection.documentUris], []);
  });

  it('registers the file again and makes it active after closing and reopening it', async () => {
    const uri = first();
    await openInWysiwyg(uri);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitForSessions(
      (current) => current.documentUris.length === 0,
      'The registration remains after closing the tab',
    );

    const inspection = await openInWysiwyg(uri);

    assert.strictEqual(inspection.activeDocumentUri, uri.toString());
  });
});
