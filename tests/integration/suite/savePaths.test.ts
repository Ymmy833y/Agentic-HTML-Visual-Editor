import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { AhveTestApi } from '../../../src/extension';
import {
  activateExtension,
  deleteIfExists,
  fileExists,
  findCustomTab,
  fixtureUri,
  getExtension,
  readFileText,
  revertAndCloseAllEditors,
  sleep,
  waitFor,
  waitForValue,
  writeFileText,
} from './helpers';

function htmlDocument(body: string[], eol = '\n'): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '    <meta charset="UTF-8">',
    '    <title>Document</title>',
    '</head>',
    '<body>',
    ...body,
    '',
    '</body>',
    '</html>',
  ].join(eol);
}

function testApi(): AhveTestApi {
  return getExtension().exports as AhveTestApi;
}

async function openWysiwygEditor(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand(
    'vscode.openWith',
    uri,
    'ahve.editor',
    vscode.ViewColumn.One,
  );
  // Wait for the Webview to start up and for the `init` round trip. We do not poll
  // `getWysiwygTestHtml` here because that hook is a plain `getFileData` request and
  // would increment the Webview's pending-save counter (see the note about a dirty
  // view below).
  await sleep(1200);
}

async function editViewAndWaitDirty(
  api: AhveTestApi,
  uri: vscode.Uri,
  html: string,
): Promise<void> {
  assert.strictEqual(api.setWysiwygTestHtml(uri, html), true, 'the WYSIWYG panel should be live');
  await waitFor(
    () => findCustomTab(uri)?.isDirty === true,
    'the WYSIWYG tab should be dirty after a view edit',
  );
}

suite('Save paths', () => {
  suiteSetup(activateExtension);

  test('merges a concurrent external change with the unsaved view edit', async () => {
    const uri = fixtureUri('save-merge.html');
    const initial = htmlDocument(['<h1>merge</h1>', '<p>alpha</p>', '<p>bravo</p>']);
    const viewEdited = initial.replace('<p>bravo</p>', '<p>bravo (view)</p>');
    const externallyEdited = initial.replace('<p>alpha</p>', '<p>alpha (external)</p>');
    await writeFileText(uri, initial);

    try {
      const api = testApi();
      await openWysiwygEditor(uri);
      await editViewAndWaitDirty(api, uri, viewEdited);

      // While the view is dirty, `documentChanged` is not applied to it. The view's
      // sync baseline therefore stays at `initial`, and the save becomes the point
      // where the two meet.
      await writeFileText(uri, externallyEdited);
      await sleep(1500);

      assert.strictEqual(api.requestWysiwygTestSave(uri), true);

      const saved = await waitForValue(
        () => readFileText(uri),
        (text) => text.includes('bravo (view)'),
        'the unsaved view edit should reach disk',
      );
      assert.ok(
        saved.includes('alpha (external)'),
        'the concurrent external edit must survive the merged save',
      );
      assert.ok(
        !saved.includes('<<<<<<<') && !saved.includes('>>>>>>>'),
        'the merge must never write git-style conflict markers into an HTML document',
      );
    } finally {
      await revertAndCloseAllEditors();
      await deleteIfExists(uri);
    }
  });

  test('rebuilds the file from the view when it disappeared from disk', async () => {
    const uri = fixtureUri('save-missing.html');
    const initial = htmlDocument(['<p>original</p>']);
    const viewEdited = htmlDocument(['<p>rebuilt from the view</p>']);
    await writeFileText(uri, initial);

    try {
      const api = testApi();
      await openWysiwygEditor(uri);
      await editViewAndWaitDirty(api, uri, viewEdited);

      await vscode.workspace.fs.delete(uri);
      assert.strictEqual(await fileExists(uri), false, 'the file should be gone before saving');

      assert.strictEqual(api.requestWysiwygTestSave(uri), true);

      const saved = await waitForValue(
        async () => ((await fileExists(uri)) ? await readFileText(uri) : null),
        (text) => text !== null && text.includes('rebuilt from the view'),
        'a save must recreate the file rather than drop the edit',
      );
      assert.ok(saved?.includes('rebuilt from the view'));
    } finally {
      await revertAndCloseAllEditors();
      await deleteIfExists(uri);
    }
  });

  test('keeps CRLF line endings through a WYSIWYG save', async () => {
    const uri = fixtureUri('save-crlf.html');
    const initial = htmlDocument(['<h1>crlf</h1>', '<p>before</p>'], '\r\n');
    const viewEdited = initial.replace('<p>before</p>', '<p>after</p>');
    await writeFileText(uri, initial);

    try {
      const api = testApi();
      await openWysiwygEditor(uri);
      await editViewAndWaitDirty(api, uri, viewEdited);

      assert.strictEqual(api.requestWysiwygTestSave(uri), true);

      const saved = await waitForValue(
        () => readFileText(uri),
        (text) => text.includes('after'),
        'the view edit should reach disk',
      );
      assert.ok(
        !/(?<!\r)\n/.test(saved),
        'a CRLF document must stay CRLF after a WYSIWYG save',
      );
    } finally {
      await revertAndCloseAllEditors();
      await deleteIfExists(uri);
    }
  });

  test('syncs an external change into a clean view', async () => {
    const uri = fixtureUri('save-external-clean.html');
    const initial = htmlDocument(['<p>before the external edit</p>']);
    const externallyEdited = htmlDocument(['<p>after the external edit</p>']);
    await writeFileText(uri, initial);

    try {
      const api = testApi();
      await openWysiwygEditor(uri);
      assert.strictEqual(findCustomTab(uri)?.isDirty, false, 'the view should start clean');

      await writeFileText(uri, externallyEdited);
      // This cannot be polled with `waitForValue`: `getWysiwygTestHtml` increments
      // the Webview's pending-save counter, and `documentChanged` is ignored while
      // that counter is non-zero. Wait, then read exactly once.
      await sleep(2500);

      const view = await api.getWysiwygTestHtml(uri);
      assert.ok(
        view?.includes('after the external edit'),
        'a clean view should follow the document on disk',
      );
      assert.strictEqual(
        findCustomTab(uri)?.isDirty,
        false,
        'following an external change must not make the view dirty',
      );
    } finally {
      await revertAndCloseAllEditors();
      await deleteIfExists(uri);
    }
  });

  test('keeps unsaved view edits when the document changes externally', async () => {
    const uri = fixtureUri('save-external-dirty.html');
    const initial = htmlDocument(['<p>original</p>']);
    const viewEdited = htmlDocument(['<p>edited in the view</p>']);
    const externallyEdited = htmlDocument(['<p>edited externally</p>']);
    await writeFileText(uri, initial);

    try {
      const api = testApi();
      await openWysiwygEditor(uri);
      await editViewAndWaitDirty(api, uri, viewEdited);

      await writeFileText(uri, externallyEdited);
      await sleep(2500);

      const view = await api.getWysiwygTestHtml(uri);
      assert.ok(
        view?.includes('edited in the view'),
        'an external change must never discard unsaved view edits',
      );
      assert.ok(
        !view?.includes('edited externally'),
        'the external change is deferred to the next save, not applied to a dirty view',
      );
    } finally {
      await revertAndCloseAllEditors();
      await deleteIfExists(uri);
    }
  });

  test('reverting the WYSIWYG editor discards its unsaved changes', async () => {
    const uri = fixtureUri('save-revert.html');
    // Use markers where neither is a substring of the other; otherwise the check for
    // the discarded side could pass by accident on the surviving side's string.
    const initial = htmlDocument(['<p>persisted paragraph</p>']);
    const viewEdited = htmlDocument(['<p>draft paragraph</p>']);
    await writeFileText(uri, initial);

    try {
      const api = testApi();
      await openWysiwygEditor(uri);
      await editViewAndWaitDirty(api, uri, viewEdited);

      await vscode.commands.executeCommand('workbench.action.files.revert');
      await waitFor(
        () => findCustomTab(uri)?.isDirty === false,
        'revert should return the WYSIWYG tab to a clean state',
      );

      // The tab turns clean as soon as the host-side edit stack unwinds, while the
      // `revert` message to the view is sent fire-and-forget. Wait until the view has
      // finished remounting — that remount is itself the evidence that it went
      // through `revertCustomDocument`.
      const view = await waitForValue(
        () => api.getWysiwygTestHtml(uri),
        (html) => html !== null && html.includes('persisted paragraph'),
        'the view should mount the document again after a revert',
      );
      assert.ok(!view?.includes('draft paragraph'), 'the unsaved edit should be discarded');
      assert.strictEqual(
        await readFileText(uri),
        initial,
        'reverting must not write anything to disk',
      );
    } finally {
      await revertAndCloseAllEditors();
      await deleteIfExists(uri);
    }
  });
});
