import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { activateExtension, getExtension } from './helpers';

suite('Activation', () => {
  test('the extension activates and exposes the expected commands', async () => {
    await activateExtension();
    const ext = getExtension();
    assert.strictEqual(ext.isActive, true);

    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'htmlWysiwyg.openInWysiwyg',
      'htmlWysiwyg.copyAsHtml',
      'htmlWysiwyg.copyAsConfluenceHtml',
    ]) {
      assert.ok(commands.includes(id), `command ${id} should be registered`);
    }
  });
});
