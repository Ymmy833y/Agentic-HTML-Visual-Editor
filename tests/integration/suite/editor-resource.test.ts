import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { readEditorSource } from '../helpers/editor-tabs';
import { DelayedFileSystem } from '../helpers/delayed-file-system';

interface ExtensionApi {
  readSessionInspection(): { readonly documentUris: readonly string[] };
  readWebviewInspection(documentUri: string): {
    readonly messages: readonly { readonly direction: string; readonly message: unknown }[];
  } | undefined;
  replaceViewContentForTest(documentUri: string, text: string): Promise<boolean>;
  injectViewMessage(documentUri: string, message: unknown): Promise<boolean>;
}

async function waitUntil(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, description);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function messageType(message: unknown): unknown {
  return typeof message === 'object' && message !== null
    ? Object.getOwnPropertyDescriptor(message, 'type')?.value
    : undefined;
}

function extension(): vscode.Extension<ExtensionApi> {
  const found = vscode.extensions.getExtension<ExtensionApi>('YuyaMiyamoto.agentic-html-visual-editor');
  assert.ok(found);
  return found;
}

function sourceUri(): vscode.Uri {
  return vscode.Uri.joinPath(extension().extensionUri, 'tests', 'integration', 'fixtures', 'sample.html');
}

describe('creating and restoring editor resource URIs', () => {
  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it("keeps the original URI's query, fragment, and file name, and identifies the session by the source file", async () => {
    const source = sourceUri().with({ query: '\u7248=1&key=a%20b', fragment: '\u672c\u6587' });
    await vscode.commands.executeCommand('vscode.openWith', source, 'ahve.editor');
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputCustom);

    assert.strictEqual(input.viewType, 'ahve.documentEditor');
    assert.strictEqual(readEditorSource(input.uri).toString(), source.toString());
    assert.strictEqual(input.uri.scheme, source.scheme);
    assert.strictEqual(input.uri.authority, source.authority);
    assert.strictEqual(input.uri.path, source.path);
    assert.strictEqual(input.uri.fragment, '');
    assert.deepStrictEqual((await extension().activate()).readSessionInspection().documentUris, [source.toString()]);
  });

  it('does not create an editing session for the source file from a malformed editor resource URI', async () => {
    const source = sourceUri();
    const invalid = source.with({ query: 'ahve-editor=' + encodeURIComponent('{"query":1,"fragment":""}') });
    try {
      await vscode.commands.executeCommand('vscode.openWith', invalid, 'ahve.documentEditor');
    } catch {
      // Depending on the VS Code version, the provider's rejection becomes a command exception or an error tab.
    }
    assert.deepStrictEqual((await extension().activate()).readSessionInspection().documentUris, []);
  });

  it('rejects a double-wrapped editor resource URI at the entry', async () => {
    const source = sourceUri();
    const wrapped = source.with({ query: 'ahve-editor=' + encodeURIComponent(JSON.stringify({
      query: 'ahve-editor=inner', fragment: '',
    })) });
    try {
      await vscode.commands.executeCommand('vscode.openWith', wrapped, 'ahve.editor');
    } catch {
      // Regardless of how the error is shown, no editing session for the source file may be created.
    }
    assert.deepStrictEqual((await extension().activate()).readSessionInspection().documentUris, []);
  });

  it('identifies the new source file when reopening through the entry an editor resource URI whose path changed as with Save As', async () => {
    const original = sourceUri().with({ query: 'rev=2', fragment: 'note' });
    await vscode.commands.executeCommand('vscode.openWith', original, 'ahve.editor');
    const originalInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(originalInput instanceof vscode.TabInputCustom);
    const destination = vscode.Uri.joinPath(sourceUri(), '..', 'crlf.html').with({ query: original.query, fragment: original.fragment });
    const editorDestination = originalInput.uri.with({ path: destination.path });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    await vscode.commands.executeCommand('vscode.openWith', editorDestination, 'ahve.editor');
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputCustom);
    assert.strictEqual(input.viewType, 'ahve.documentEditor');
    assert.strictEqual(readEditorSource(input.uri).toString(), destination.toString());
    assert.deepStrictEqual((await extension().activate()).readSessionInspection().documentUris, [destination.toString()]);
  });

  it('keeps redo through an undo right after saving a virtual file and a delayed reload', async () => {
    const initial = '<!DOCTYPE html>\n<html>\n<body>\n<p>ab</p>\n</body>\n</html>\n';
    const edited = initial.replace('ab', 'abXY');
    const source = vscode.Uri.parse('ahve-history-test://workspace/notes/\u65e5\u672c\u8a9e.html?rev=1');
    const fs = new DelayedFileSystem(source, initial);
    const registration = vscode.workspace.registerFileSystemProvider(source.scheme, fs, { isCaseSensitive: true });
    let stage = 'open the text model';
    try {
      const buffer = await vscode.workspace.openTextDocument(source);
      stage = 'open the text tab';
      await vscode.window.showTextDocument(buffer);
      stage = 'open the WYSIWYG editor';
      await vscode.commands.executeCommand('vscode.openWith', source, 'ahve.editor');
      const api = await extension().activate();
      const messages = () => api.readWebviewInspection(source.toString())?.messages ?? [];
      const count = (type: string) => messages().filter((entry) => messageType(entry.message) === type).length;
      const historyCandidates = () => messages().flatMap((entry) => {
        const message = entry.message;
        if (entry.direction !== 'toView' || typeof message !== 'object' || message === null
          || Object.getOwnPropertyDescriptor(message, 'kind')?.value !== 'editHistory') {
          return [];
        }
        const text: unknown = Object.getOwnPropertyDescriptor(message, 'text')?.value;
        return typeof text === 'string' ? [text] : [];
      });
      await waitUntil(() => count('initialize') === 1, 'the virtual file was not initialized');
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(input instanceof vscode.TabInputCustom);
      assert.strictEqual(readEditorSource(input.uri).toString(), source.toString());
      stage = 'edit the view';
      assert.strictEqual(await api.replaceViewContentForTest(source.toString(), edited), true);
      for (const message of [
        { type: 'viewEdited' },
        { type: 'editUnitStart', unitId: 'delayed-source', start: { text: initial, selection: null } },
        { type: 'editTransaction', transaction: {
          unitId: 'delayed-source',
          before: { text: initial, selection: null },
          after: { text: edited, selection: null },
        } },
      ]) {
        assert.strictEqual(await api.injectViewMessage(source.toString(), message), true);
      }
      await waitUntil(() => vscode.window.tabGroups.activeTabGroup.activeTab?.isDirty === true,
        "the edit event did not reach VS Code's dirty indicator");
      assert.strictEqual(vscode.window.activeTextEditor, undefined, 'the save target is the WYSIWYG editor');
      stage = 'save';
      const commitsBeforeSave = count('saveCommitted');
      await vscode.commands.executeCommand('workbench.action.files.save');
      await waitUntil(() => count('saveCommitted') > commitsBeforeSave, 'the save round trip did not finish');
      assert.strictEqual(fs.readText(), edited);
      assert.strictEqual(buffer.getText(), initial, 'the reload has not been notified yet');

      const outputsBeforeUndo = count('requestBodyOutput');
      const releasesBeforeUndo = count('saveReleased');
      stage = 'start undo';
      const undo = Promise.resolve(vscode.commands.executeCommand('ahve.undo'));
      await waitUntil(() => count('requestBodyOutput') > outputsBeforeUndo, 'undo did not reach the history path');
      stage = 'notify the reload after save';
      fs.notifyWrittenFile();
      await waitUntil(() => buffer.getText() === edited, 'the delayed reload did not finish');
      await waitUntil(() => count('saveReleased') > releasesBeforeUndo, 'the undo round trip did not finish');
      await undo;
      stage = 'redo';
      const releasesBeforeRedo = count('saveReleased');
      await vscode.commands.executeCommand('ahve.redo');
      await waitUntil(() => count('saveReleased') > releasesBeforeRedo, 'could not redo after the reload');

      assert.deepStrictEqual(fs.writtenUris, [source.toString()]);
      assert.deepStrictEqual(historyCandidates(), [initial, edited]);
      assert.strictEqual(fs.readText(), edited);
      assert.strictEqual(buffer.getText(), edited);
      assert.strictEqual(buffer.isDirty, false);
      assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab?.isDirty, false);
    } catch (error) {
      throw new Error(`Delayed reload test failed at: ${stage}`, { cause: error });
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      registration.dispose();
      fs.dispose();
    }
  });
});
