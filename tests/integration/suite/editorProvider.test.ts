import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { activateExtension, closeAllEditors, fixtureUri, sleep } from './helpers';

suite('HtmlWysiwygEditorProvider', () => {
  suiteSetup(activateExtension);
  teardown(closeAllEditors);

  test('the custom editor accepts a workspace edit to the underlying document', async () => {
    const uri = fixtureUri('sample.html');
    await vscode.commands.executeCommand('htmlWysiwyg.openInWysiwyg', uri);
    await sleep(500);

    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    assert.ok(doc, 'the document for the fixture should be loaded');

    const before = doc!.getText();
    const marker = '<!-- inserted-by-test -->';
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(0, 0), marker + '\n');
    const ok = await vscode.workspace.applyEdit(edit);
    assert.strictEqual(ok, true);

    assert.ok(doc!.getText().startsWith(marker), 'edit should be visible in the document text');

    // Revert so the fixture stays clean for the next test run.
    const revert = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      doc!.positionAt(0),
      doc!.positionAt(doc!.getText().length),
    );
    revert.replace(uri, fullRange, before);
    await vscode.workspace.applyEdit(revert);
  });
});
