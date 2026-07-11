import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { AhveTestApi } from '../../../src/extension';
import { activateExtension, closeAllEditors, fixtureUri, getExtension, sleep } from './helpers';

// The acceptance test for independent tab dirty indicators: the text tab
// follows the TextDocument, the WYSIWYG tab follows the custom document's
// content-change events, and neither leaks into the other.

const TEMP_FIXTURE = 'dirty-matrix.html';
const INITIAL_CONTENT = [
  '<!DOCTYPE html>',
  '<html>',
  '<head><title>dirty matrix</title></head>',
  '<body>',
  '<p>hello</p>',
  '</body>',
  '</html>',
  '',
].join('\n');

function allTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs);
}

function findTextTab(uri: vscode.Uri): vscode.Tab | undefined {
  return allTabs().find(
    (t) => t.input instanceof vscode.TabInputText && t.input.uri.fsPath === uri.fsPath,
  );
}

function findCustomTab(uri: vscode.Uri): vscode.Tab | undefined {
  return allTabs().find(
    (t) =>
      t.input instanceof vscode.TabInputCustom &&
      t.input.viewType === 'ahve.editor' &&
      t.input.uri.fsPath === uri.fsPath,
  );
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(50);
  }
  assert.ok(predicate(), message);
}

suite('Dirty indicator matrix', () => {
  suiteSetup(async () => {
    await activateExtension();
    await vscode.workspace.fs.writeFile(
      fixtureUri(TEMP_FIXTURE),
      new TextEncoder().encode(INITIAL_CONTENT),
    );
  });

  suiteTeardown(async () => {
    try {
      await vscode.workspace.fs.delete(fixtureUri(TEMP_FIXTURE));
    } catch {
      // Already gone.
    }
  });

  teardown(async () => {
    // A dirty editor would make closeAllEditors pop a save dialog; revert
    // editors first so teardown can never hang on a prompt.
    for (let i = 0; i < 10 && allTabs().length > 0; i++) {
      try {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      } catch {
        break;
      }
    }
    await closeAllEditors();
  });

  test('tab dirty indicators are independent per editor', async () => {
    const uri = fixtureUri(TEMP_FIXTURE);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand(
      'vscode.openWith',
      uri,
      'ahve.editor',
      vscode.ViewColumn.Beside,
    );
    // Let the custom editor resolve and its webview boot.
    await sleep(1000);

    assert.ok(findTextTab(uri), 'the text tab should be open');
    assert.ok(findCustomTab(uri), 'the WYSIWYG tab should be open');

    // Both editors start clean.
    assert.strictEqual(findTextTab(uri)?.isDirty, false, 'text tab should start clean');
    assert.strictEqual(findCustomTab(uri)?.isDirty, false, 'WYSIWYG tab should start clean');

    // HTML edited only -> text ●, WYSIWYG ✕.
    const textEdit = new vscode.WorkspaceEdit();
    textEdit.insert(uri, new vscode.Position(0, 0), '<!-- text edit -->\n');
    assert.ok(await vscode.workspace.applyEdit(textEdit), 'text edit should apply');
    await waitFor(
      () => findTextTab(uri)?.isDirty === true,
      'text tab should be dirty after a text edit',
    );
    assert.strictEqual(
      findCustomTab(uri)?.isDirty,
      false,
      'WYSIWYG tab must stay clean while only the text buffer is edited',
    );

    // A plain text-document save returns to clean without involving the
    // custom editor.
    await doc.save();
    await waitFor(
      () => findTextTab(uri)?.isDirty === false,
      'text tab should be clean after saving the text document',
    );
    assert.strictEqual(findCustomTab(uri)?.isDirty, false, 'WYSIWYG tab should still be clean');

    // WYSIWYG edited only -> WYSIWYG ●, text ✕.
    const api = getExtension().exports as AhveTestApi;
    assert.strictEqual(api.fireWysiwygEdit(uri), true, 'the WYSIWYG document should be open');
    await waitFor(
      () => findCustomTab(uri)?.isDirty === true,
      'WYSIWYG tab should be dirty after a WYSIWYG edit',
    );
    assert.strictEqual(
      findTextTab(uri)?.isDirty,
      false,
      'text tab must stay clean while only the WYSIWYG view is edited',
    );

    // Both edited -> both ●.
    const secondTextEdit = new vscode.WorkspaceEdit();
    secondTextEdit.insert(uri, new vscode.Position(0, 0), '<!-- second text edit -->\n');
    assert.ok(await vscode.workspace.applyEdit(secondTextEdit), 'second text edit should apply');
    await waitFor(
      () => findTextTab(uri)?.isDirty === true,
      'text tab should be dirty after the second text edit',
    );
    assert.strictEqual(
      findCustomTab(uri)?.isDirty,
      true,
      'WYSIWYG tab should stay dirty alongside the text tab',
    );

    // Saving the resource (what the webview's save request runs) clears the
    // WYSIWYG tab; its save merges into the buffer and saves the file, so the
    // text tab clears too.
    await vscode.workspace.save(uri);
    await waitFor(
      () => findCustomTab(uri)?.isDirty === false,
      'WYSIWYG tab should be clean after workspace.save',
      8000,
    );
    await waitFor(
      () => findTextTab(uri)?.isDirty === false,
      'text tab should be clean after the merged save',
    );
  });
});
