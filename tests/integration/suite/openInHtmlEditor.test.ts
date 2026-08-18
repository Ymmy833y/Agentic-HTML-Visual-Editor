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

suite('Command: ahve.openInHtmlEditor', () => {
  suiteSetup(activateExtension);
  teardown(closeAllEditors);

  test('replaces the active WYSIWYG tab in the same editor group', async () => {
    const uri = fixtureUri('sample.html');
    await vscode.commands.executeCommand('ahve.openInWysiwygEditor', uri);
    await sleep(500);
    const visualColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;

    await vscode.commands.executeCommand('ahve.openInHtmlEditor');
    await sleep(500);

    assert.strictEqual(visualTab(uri), undefined, 'the WYSIWYG tab should be closed');
    const replacement = textTab(uri);
    assert.ok(replacement, 'the HTML replacement tab should be open');
    assert.strictEqual(replacement.group.viewColumn, visualColumn);
    assert.strictEqual(replacement.isActive, true);
  });

  test('reveals an existing HTML tab without closing the WYSIWYG tab', async () => {
    const uri = fixtureUri('sample.html');
    await vscode.commands.executeCommand('ahve.openInWysiwygEditor', uri);
    await sleep(500);
    const visual = visualTab(uri);
    assert.ok(visual, 'the WYSIWYG tab should be open');

    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside, false);
    const existing = textTab(uri);
    assert.ok(existing, 'the HTML tab should be open beside the WYSIWYG tab');
    const textColumn = existing.group.viewColumn;

    await vscode.commands.executeCommand(
      'vscode.openWith',
      uri,
      CUSTOM_EDITOR_VIEW_TYPE,
      visual.group.viewColumn,
    );
    await vscode.commands.executeCommand('ahve.openInHtmlEditor');
    await sleep(500);

    assert.ok(visualTab(uri), 'the WYSIWYG tab should remain open');
    assert.strictEqual(textTab(uri)?.group.viewColumn, textColumn);
    assert.strictEqual(textTab(uri)?.isActive, true, 'the existing HTML tab should be active');
  });

  test('does not close an unrelated active tab when a uri is passed explicitly', async () => {
    const target = fixtureUri('sample.html');
    await vscode.commands.executeCommand('ahve.openInWysiwygEditor', target);
    await sleep(500);

    const unrelatedUri = vscode.Uri.parse('untitled:unrelated.html');
    const unrelatedDocument = await vscode.workspace.openTextDocument(unrelatedUri);
    await vscode.window.showTextDocument(unrelatedDocument, { preview: false });

    await vscode.commands.executeCommand('ahve.openInHtmlEditor', target);
    await sleep(500);

    assert.ok(textTab(unrelatedUri), 'the unrelated text tab should remain open');
    assert.ok(textTab(target), 'the requested HTML tab should be open');
    assert.ok(visualTab(target), 'the non-active WYSIWYG tab should remain open');
  });
});
