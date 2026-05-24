import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { activateExtension, closeAllEditors, fixtureUri, sleep } from './helpers';

const CUSTOM_EDITOR_VIEW_TYPE = 'htmlWysiwyg.editor';

suite('Command: htmlWysiwyg.openInWysiwyg', () => {
  suiteSetup(activateExtension);
  teardown(closeAllEditors);

  test('opens the WYSIWYG custom editor for the given HTML uri', async () => {
    const uri = fixtureUri('sample.html');
    await vscode.commands.executeCommand('htmlWysiwyg.openInWysiwyg', uri);

    // Give VS Code a moment to mount the webview-backed editor.
    await sleep(500);

    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab, 'an active tab is expected after opening the custom editor');
    const input = tab!.input as { viewType?: string; uri?: vscode.Uri } | undefined;
    assert.strictEqual(input?.viewType, CUSTOM_EDITOR_VIEW_TYPE);
    assert.strictEqual(input?.uri?.fsPath, uri.fsPath);
  });

  test('does not throw when invoked with no argument and no active text editor', async () => {
    await closeAllEditors();
    // We do not assert the warning message specifically (intercepting
    // showWarningMessage requires patching live module bindings, which is
    // brittle inside the Extension Development Host). The contract here is
    // simply: the command path completes without throwing.
    await vscode.commands.executeCommand('htmlWysiwyg.openInWysiwyg');
  });
});
