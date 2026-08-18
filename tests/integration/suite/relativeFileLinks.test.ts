import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { AhveTestApi } from '../../../src/extension';
import {
  activateExtension,
  closeAllEditors,
  fixtureUri,
  getExtension,
  sleep,
} from './helpers';

/**
 * Waits until the WYSIWYG Webview answers a serialization round trip. A non-null
 * answer proves the view's `message` listener is live, so a one-way message sent
 * afterwards (e.g. `testOpenRelativeFile`) is guaranteed to be handled rather than
 * dropped by a Webview that is still starting up.
 */
async function waitForWebviewReady(
  api: AhveTestApi,
  uri: vscode.Uri,
  timeoutMs = 10000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await api.getWysiwygTestHtml(uri)) !== null) return true;
  }
  return false;
}

const testRoot = fixtureUri('relative-file-link-test');
const sourceUri = vscode.Uri.joinPath(testRoot, 'nested', 'source.html');

async function writeFile(uri: vscode.Uri, content = 'target\n'): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
}

function tabFor(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === uri.fsPath);
}

async function waitForTab(uri: vscode.Uri, timeoutMs = 3000): Promise<vscode.Tab | undefined> {
  const deadline = Date.now() + timeoutMs;
  let tab = tabFor(uri);
  while (!tab && Date.now() < deadline) {
    await sleep(50);
    tab = tabFor(uri);
  }
  return tab;
}

suite('Relative file links', () => {
  suiteSetup(async () => {
    await activateExtension();
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(testRoot, 'nested'));
    await writeFile(sourceUri, '<p>source</p>\n');
  });

  setup(async () => {
    await vscode.commands.executeCommand('ahve.openInWysiwygEditor', sourceUri);
    await sleep(400);
  });

  teardown(closeAllEditors);

  suiteTeardown(async () => {
    await closeAllEditors();
    await vscode.workspace.fs.delete(testRoot, { recursive: true, useTrash: false });
  });

  test('routes an openRelativeFile message from the webview through the host handler', async () => {
    const target = vscode.Uri.joinPath(testRoot, 'nested', 'via-message.txt');
    await writeFile(target);
    const api = getExtension().exports as AhveTestApi;

    // The only case that depends on a live Webview: it posts a real
    // `openRelativeFile` message from the view. On a cold Webview right after the
    // first launch, a fixed wait is not always enough for the view's message
    // listener to be registered, so confirm the view answers a round trip before
    // posting.
    assert.ok(
      await waitForWebviewReady(api, sourceUri),
      'the WYSIWYG webview should become responsive',
    );

    // Unlike openWysiwygTestRelativeFile, this makes the view post a real
    // `openRelativeFile` message, exercising the provider's message handler and its
    // resolution of the href against the source document's uri.
    assert.strictEqual(
      api.openWysiwygTestRelativeFileViaWebview(sourceUri, 'via-message.txt'),
      true,
    );

    assert.ok(
      await waitForTab(target),
      'the webview message should reach the host handler and open the relative file',
    );
  });

  test('opens a document-relative file in a persistent tab and keeps the WYSIWYG tab', async () => {
    const target = vscode.Uri.joinPath(testRoot, 'nested', 'same-directory.txt');
    await writeFile(target);
    const api = getExtension().exports as AhveTestApi;

    assert.strictEqual(
      await api.openWysiwygTestRelativeFile(
        sourceUri,
        'same%2Ddirectory.txt?download=1#section',
      ),
      true,
    );
    await sleep(300);

    const targetTab = tabFor(target);
    assert.ok(targetTab, 'the relative file should open in a VS Code tab');
    assert.strictEqual(targetTab.isPreview, false, 'the opened tab should be persistent');
    assert.ok(
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .some((tab) => tab.label === 'source.html (WYSIWYG)'),
      'the source WYSIWYG tab should remain open',
    );
    const targetGroup = vscode.window.tabGroups.all.find((group) =>
      group.tabs.includes(targetTab),
    );
    const sourceGroup = vscode.window.tabGroups.all.find((group) =>
      group.tabs.some((tab) => tab.label === 'source.html (WYSIWYG)'),
    );
    assert.strictEqual(
      targetGroup?.viewColumn,
      sourceGroup?.viewColumn,
      'the target should open in the same editor group',
    );
  });

  test('falls back to the workspace root when the document-relative file is missing', async () => {
    const target = vscode.Uri.joinPath(testRoot, 'workspace-target.txt');
    await writeFile(target);
    const api = getExtension().exports as AhveTestApi;

    assert.strictEqual(
      await api.openWysiwygTestRelativeFile(
        sourceUri,
        'relative-file-link-test/workspace-target.txt',
      ),
      true,
    );
    await sleep(300);
    assert.ok(tabFor(target), 'the workspace-relative fallback should open');
  });

  test('accepts a path prefixed with the directly opened workspace directory name', async () => {
    const target = vscode.Uri.joinPath(testRoot, 'workspace-target.txt');
    await writeFile(target);
    const api = getExtension().exports as AhveTestApi;

    assert.strictEqual(
      await api.openWysiwygTestRelativeFile(
        sourceUri,
        'test-fixtures/relative-file-link-test/workspace-target.txt',
      ),
      true,
    );
    await sleep(300);
    assert.ok(tabFor(target), 'the workspace-name-prefixed target should open');
  });

  test('accepts a workspace-name-prefixed path from a document in the workspace root', async () => {
    const rootSource = fixtureUri('sample.html');
    const target = fixtureUri('test.txt');
    const api = getExtension().exports as AhveTestApi;

    assert.strictEqual(
      await api.openWysiwygTestRelativeFile(rootSource, 'test-fixtures/test.txt'),
      true,
    );
    await sleep(300);
    assert.ok(tabFor(target), 'the workspace-root target should open');
  });

  test('prefers the document-relative file when both candidates exist', async () => {
    const href = 'relative-file-link-test/duplicate.txt';
    const documentTarget = vscode.Uri.joinPath(
      testRoot,
      'nested',
      'relative-file-link-test',
      'duplicate.txt',
    );
    const workspaceTarget = vscode.Uri.joinPath(testRoot, 'duplicate.txt');
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.joinPath(testRoot, 'nested', 'relative-file-link-test'),
    );
    await writeFile(documentTarget, 'document\n');
    await writeFile(workspaceTarget, 'workspace\n');
    const api = getExtension().exports as AhveTestApi;

    assert.strictEqual(await api.openWysiwygTestRelativeFile(sourceUri, href), true);
    await sleep(300);
    assert.ok(tabFor(documentTarget), 'the document-relative candidate should open first');
    assert.strictEqual(tabFor(workspaceTarget), undefined);
  });

  test('does not open missing or out-of-workspace paths', async () => {
    const api = getExtension().exports as AhveTestApi;
    const before = vscode.window.tabGroups.all.flatMap((group) => group.tabs).length;

    assert.strictEqual(
      await api.openWysiwygTestRelativeFile(sourceUri, 'missing-target.txt'),
      false,
    );
    assert.strictEqual(
      await api.openWysiwygTestRelativeFile(sourceUri, '../../../outside-target.txt'),
      false,
    );
    assert.strictEqual(
      vscode.window.tabGroups.all.flatMap((group) => group.tabs).length,
      before,
    );
  });
});
