import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { activateExtension, closeAllEditors, fixtureUri, sleep } from './helpers';

const CUSTOM_EDITOR_VIEW_TYPE = 'ahve.editor';

function allTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

function textTab(uri: vscode.Uri): vscode.Tab | undefined {
  return allTabs().find(
    (tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === uri.fsPath,
  );
}

function visualTab(uri: vscode.Uri): vscode.Tab | undefined {
  return allTabs().find(
    (tab) =>
      tab.input instanceof vscode.TabInputCustom &&
      tab.input.viewType === CUSTOM_EDITOR_VIEW_TYPE &&
      tab.input.uri.fsPath === uri.fsPath,
  );
}

suite('Command: ahve.openInVisualEditor', () => {
  suiteSetup(activateExtension);
  teardown(closeAllEditors);

  test('opens the WYSIWYG custom editor for the given HTML uri', async () => {
    const uri = fixtureUri('sample.html');
    await vscode.commands.executeCommand('ahve.openInVisualEditor', uri);

    // Give VS Code a moment to mount the webview-backed editor.
    await sleep(500);

    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab, 'an active tab is expected after opening the custom editor');
    const input = tab.input as { viewType?: string; uri?: vscode.Uri } | undefined;
    assert.strictEqual(input?.viewType, CUSTOM_EDITOR_VIEW_TYPE);
    assert.strictEqual(input?.uri?.fsPath, uri.fsPath);
  });

  test('replaces the active HTML text tab in the same editor group', async () => {
    const uri = fixtureUri('sample.html');
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    const sourceColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;

    await vscode.commands.executeCommand('ahve.openInVisualEditor', uri);
    await sleep(500);

    assert.strictEqual(textTab(uri), undefined, 'the source HTML tab should be closed');
    const replacement = visualTab(uri);
    assert.ok(replacement, 'the WYSIWYG replacement tab should be open');
    assert.strictEqual(replacement.group.viewColumn, sourceColumn);
    assert.strictEqual(replacement.isActive, true);
  });

  test('does not close an unrelated active tab when a uri is passed explicitly', async () => {
    const unrelatedUri = vscode.Uri.parse('untitled:unrelated.txt');
    const unrelatedDocument = await vscode.workspace.openTextDocument(unrelatedUri);
    await vscode.window.showTextDocument(unrelatedDocument, { preview: false });

    const target = fixtureUri('sample.html');
    await vscode.commands.executeCommand('ahve.openInVisualEditor', target);
    await sleep(500);

    assert.ok(textTab(unrelatedUri), 'the unrelated text tab should remain open');
    assert.ok(visualTab(target), 'the requested WYSIWYG tab should be open');
  });

  test('reveals an existing WYSIWYG tab without closing the active HTML tab', async () => {
    const uri = fixtureUri('sample.html');
    await vscode.commands.executeCommand('ahve.openInVisualEditor', uri);
    await sleep(500);
    const existing = visualTab(uri);
    assert.ok(existing, 'the initial WYSIWYG tab should be open');
    const visualColumn = existing.group.viewColumn;

    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside, false);
    assert.ok(textTab(uri), 'the HTML text tab should be open beside the WYSIWYG tab');

    await vscode.commands.executeCommand('ahve.openInVisualEditor', uri);
    await sleep(500);

    assert.ok(textTab(uri), 'the HTML text tab should remain open');
    assert.strictEqual(visualTab(uri)?.group.viewColumn, visualColumn);
    assert.strictEqual(visualTab(uri)?.isActive, true, 'the existing WYSIWYG tab should be active');
  });

  test('does not throw when invoked with no argument and no active text editor', async () => {
    await closeAllEditors();
    // We do not assert the warning message specifically (intercepting
    // showWarningMessage requires patching live module bindings, which is
    // brittle inside the Extension Development Host). The contract here is
    // simply: the command path completes without throwing.
    await vscode.commands.executeCommand('ahve.openInVisualEditor');
  });
});
