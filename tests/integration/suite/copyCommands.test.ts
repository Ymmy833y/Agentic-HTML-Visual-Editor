import * as vscode from 'vscode';
import { activateExtension, closeAllEditors, fixtureUri, sleep } from './helpers';

suite('Commands: copy as HTML / Confluence', () => {
  suiteSetup(activateExtension);
  teardown(closeAllEditors);

  test('copyAsHtml does not throw when no WYSIWYG panel is active', async () => {
    await closeAllEditors();
    await vscode.commands.executeCommand('ahve.copyAsHtml');
    await vscode.commands.executeCommand('ahve.copyAsConfluenceHtml');
  });

  test('copyAsHtml does not throw with an active WYSIWYG panel', async () => {
    await vscode.commands.executeCommand('ahve.openInVisualEditor', fixtureUri('sample.html'));
    await sleep(500);
    // The copy round-trip lives in the webview; from the extension host all we
    // can verify safely is that the dispatch path is wired up and does not
    // throw. The transformed clipboard content is covered by the webview's
    // confluence/copy unit tests.
    await vscode.commands.executeCommand('ahve.copyAsHtml');
    await vscode.commands.executeCommand('ahve.copyAsConfluenceHtml');
  });
});
