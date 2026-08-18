import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { AhveTestApi } from '../../../src/extension';
import { activateExtension, closeAllEditors, fixtureUri, getExtension, sleep } from './helpers';

suite('AhveEditorProvider', () => {
  suiteSetup(activateExtension);
  teardown(closeAllEditors);

  test('the custom editor tab is labelled with filename and (WYSIWYG) suffix', async () => {
    const uri = fixtureUri('sample.html');
    await vscode.commands.executeCommand('ahve.openInWysiwygEditor', uri);
    await sleep(500);

    const allTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const wysiwygTab = allTabs.find((t) => t.label === 'sample.html (WYSIWYG)');
    assert.ok(wysiwygTab, 'WYSIWYG tab should have a "(WYSIWYG)" suffix in its label');
  });

  test('the custom editor accepts a workspace edit to the underlying document', async () => {
    const uri = fixtureUri('sample.html');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.commands.executeCommand('ahve.openInWysiwygEditor', uri);
    await sleep(500);

    const before = doc.getText();
    const marker = '<!-- inserted-by-test -->';
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(0, 0), marker + '\n');
    const ok = await vscode.workspace.applyEdit(edit);
    assert.strictEqual(ok, true);

    assert.ok(doc.getText().startsWith(marker), 'edit should be visible in the document text');

    // Revert so the fixture stays clean for the next test run.
    const revert = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length),
    );
    revert.replace(uri, fullRange, before);
    await vscode.workspace.applyEdit(revert);
    await doc.save();
  });

  test('opening only the WYSIWYG editor does not pin an HTML TextDocument', async () => {
    const uri = fixtureUri('wysiwyg-unpinned.html');
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('<p>hello</p>\n'));
    try {
      await vscode.commands.executeCommand('ahve.openInWysiwygEditor', uri);
      await sleep(500);
      assert.strictEqual(
        vscode.workspace.textDocuments.some((document) => document.uri.fsPath === uri.fsPath),
        false,
        'the WYSIWYG-only save path must not create a text-model undo stack',
      );
    } finally {
      await closeAllEditors();
      await vscode.workspace.fs.delete(uri);
    }
  });

  test('a filesystem save reloads an open clean HTML document without a workspace edit', async () => {
    const uri = fixtureUri('sample.html');
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(doc.isDirty, false, 'the direct-save precondition is a clean buffer');
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand(
      'vscode.openWith',
      uri,
      'ahve.editor',
      vscode.ViewColumn.Beside,
    );
    await sleep(500);
    const before = doc.getText();
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const changed = `<!-- direct-wysiwyg-save -->${eol}${before}`;

    try {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(changed));
      for (let i = 0; i < 60 && doc.getText() !== changed; i++) await sleep(50);
      assert.strictEqual(
        doc.getText(),
        changed,
        'the open TextDocument should reload the direct filesystem save',
      );
    } finally {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(before));
      for (let i = 0; i < 60 && doc.getText() !== before; i++) await sleep(50);
    }
  });

  test('saving WYSIWYG changes keeps them when an HTML tab is also open', async () => {
    const uri = fixtureUri('wysiwyg-dual-save.html');
    const initial = [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '    <meta charset="UTF-8">',
      '    <title>Document</title>',
      '</head>',
      '<body>',
      '<h1>undo and redo test</h1>',
      '<p>This is apple</p>',
      '',
      '</body>',
      '</html>',
    ].join('\r\n');
    const edited = initial.replace(
      '<p>This is apple</p>',
      '<p>This is apple</p>\r\n<p>This is banana</p>',
    );
    const editedByShortcut = edited.replace(
      '<p>This is banana</p>',
      '<p>This is banana</p>\r\n<p>This is cherry</p>',
    );
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(initial));

    try {
      const textDocument = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(textDocument, { preview: false });
      await vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        'ahve.editor',
        vscode.ViewColumn.One,
      );
      await sleep(700);

      const api = getExtension().exports as AhveTestApi;
      assert.strictEqual(api.setWysiwygTestHtml(uri, edited), true);
      await sleep(400);
      assert.strictEqual(api.requestWysiwygTestSave(uri), true);
      await sleep(800);

      const disk = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      const view = await api.getWysiwygTestHtml(uri);
      assert.ok(disk.includes('This is banana'), 'the saved file should contain the WYSIWYG edit');
      assert.ok(
        textDocument.getText().includes('This is banana'),
        'the open HTML tab should contain the WYSIWYG edit',
      );
      assert.ok(view?.includes('This is banana'), 'the WYSIWYG view should keep its edit after save');

      // `ahve.save` is the command bound to Ctrl/Cmd+S while the custom editor is
      // active. It must use the same single save path as the toolbar.
      assert.strictEqual(api.setWysiwygTestHtml(uri, editedByShortcut), true);
      await sleep(400);
      await vscode.commands.executeCommand('ahve.save');
      await sleep(800);

      const shortcutDisk = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      const shortcutView = await api.getWysiwygTestHtml(uri);
      assert.ok(shortcutDisk.includes('This is cherry'));
      assert.ok(textDocument.getText().includes('This is cherry'));
      assert.ok(shortcutView?.includes('This is cherry'));
    } finally {
      await closeAllEditors();
      await vscode.workspace.fs.delete(uri);
    }
  });
});
