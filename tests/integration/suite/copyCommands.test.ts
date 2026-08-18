import * as vscode from 'vscode';
import { activateExtension, closeAllEditors, fixtureUri, sleep } from './helpers';

suite('Commands: copy as HTML', () => {
  suiteSetup(activateExtension);
  teardown(closeAllEditors);

  test('copyAsHtml does not throw when no WYSIWYG panel is active', async () => {
    await closeAllEditors();
    await vscode.commands.executeCommand('ahve.copyAsHtml');
  });

  test('copyAsHtml does not throw with an active WYSIWYG panel', async () => {
    await vscode.commands.executeCommand('ahve.openInWysiwygEditor', fixtureUri('sample.html'));
    await sleep(500);
    // The copy round trip lives in the Webview, so all the extension host can safely
    // confirm is that the dispatch path is wired up and does not throw. What gets
    // written to the clipboard is covered by the Webview's copy unit tests.
    await vscode.commands.executeCommand('ahve.copyAsHtml');
  });
});
