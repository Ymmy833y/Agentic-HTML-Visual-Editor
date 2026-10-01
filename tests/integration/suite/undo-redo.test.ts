import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { customTabMatchesSource } from '../helpers/editor-tabs';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

// Driving history rewrites the disk, so the fixture files checked into the repository are not used.
const SCRATCH_FILE_NAME = 'undo-redo-scratch.html';
// A case that enters protection leaves a protection backup, and reopening that source file starts a restore.
// Each case uses its own source file.
const PROTECTION_APPLY_SCRATCH_FILE_NAME = 'undo-redo-protection-apply-scratch.html';
const PROTECTION_REVERT_SCRATCH_FILE_NAME = 'undo-redo-protection-revert-scratch.html';

const INITIAL_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>ab</p>\n</body>\n</html>\n';
const EDITED_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>abXY</p>\n</body>\n</html>\n';

// Keep the source-side and view-side changes apart. Adjacent lines often form one structure and cannot be
// mechanically merged as separate changes.
const MERGE_BASE_TEXT = [
  '<!DOCTYPE html>', '<html>', '<body>', '<p>first</p>', '<hr>', '<p>second</p>', '</body>', '</html>', '',
].join('\n');
const MERGE_SOURCE_TEXT = MERGE_BASE_TEXT.replace('<p>first</p>', '<p>FIRST</p>');
const MERGE_VIEW_TEXT = MERGE_BASE_TEXT.replace('<p>second</p>', '<p>SECOND</p>');

interface RecordedMessage {
  readonly direction: 'fromView' | 'toView';
  readonly message: unknown;
}

interface SaveEntryCall {
  readonly kind: 'save' | 'saveAs' | 'revert';
  readonly documentUri: string;
}

interface ExtensionApi {
  readWebviewInspection(documentUri: string): { readonly messages: readonly RecordedMessage[] } | undefined;
  readDiagnosticInspection(): {
    readonly notifications: readonly string[];
    readonly logLines: readonly string[];
  };
  clearDiagnosticInspection(): void;
  injectViewMessage(documentUri: string, message: unknown): Promise<boolean>;
  replaceViewContentForTest(documentUri: string, text: string): Promise<boolean>;
  readSaveEntryInspection(): { readonly calls: readonly SaveEntryCall[] };
  clearSaveEntryInspection(): void;
  runHistoryTransitionForTest(
    documentUri: string,
    direction: 'undo' | 'redo',
  ): Promise<boolean | undefined>;
}

function findExtension(): vscode.Extension<ExtensionApi> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} is not loaded in VS Code`);
  return extension;
}

async function api(): Promise<ExtensionApi> {
  return findExtension().activate();
}

function fixtureUri(fileName: string): vscode.Uri {
  return vscode.Uri.joinPath(
    findExtension().extensionUri,
    'tests',
    'integration',
    'fixtures',
    fileName,
  );
}

function scratchUri(): vscode.Uri {
  return fixtureUri(SCRATCH_FILE_NAME);
}

function openTabs(): readonly vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

function findCustomTab(uri: vscode.Uri): vscode.Tab | undefined {
  return openTabs().find(
    (tab) => customTabMatchesSource(tab, uri),
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  for (;;) {
    if (await condition()) {
      return;
    }
    assert.ok(Date.now() < deadline, `Timed out before ${description}`);
    await delay(POLLING_INTERVAL_MS);
  }
}

async function readFileText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

async function writeFileText(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

async function updateSetting(section: string, key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration(section)
    .update(key, value, vscode.ConfigurationTarget.Global);
}

// Write back to disk and wait until the open buffer catches up with that content. Without waiting, the test
// would work against a buffer still holding the previous test's content.
async function resetScratch(text: string = INITIAL_TEXT): Promise<vscode.Uri> {
  return resetNamedScratch(SCRATCH_FILE_NAME, text);
}

async function resetNamedScratch(fileName: string, text: string = INITIAL_TEXT): Promise<vscode.Uri> {
  const uri = fixtureUri(fileName);
  await writeFileText(uri, text);

  const document = await vscode.workspace.openTextDocument(uri);
  await waitUntil(() => document.getText() === text, 'the buffer followed the initial content');
  return uri;
}

async function readRecordedMessages(uri: vscode.Uri): Promise<readonly RecordedMessage[]> {
  return (await api()).readWebviewInspection(uri.toString())?.messages ?? [];
}

function readMessageField(message: unknown, field: string): unknown {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(message, field)?.value;
}

function readMessageType(message: unknown): string | undefined {
  const value = readMessageField(message, 'type');
  return typeof value === 'string' ? value : undefined;
}

function readMessageText(message: unknown): string | undefined {
  const value = readMessageField(message, 'text');
  return typeof value === 'string' ? value : undefined;
}

// Full document text most recently handed to the view. The view holds it as is.
async function readViewText(uri: vscode.Uri): Promise<string> {
  const texts = (await readRecordedMessages(uri))
    .filter((recorded) => recorded.direction === 'toView')
    .flatMap((recorded) => {
      const text = readMessageText(recorded.message);
      return text === undefined ? [] : [text];
    });
  assert.ok(texts.length > 0, 'the view has not been given any document text yet');
  return texts[texts.length - 1];
}

// Reads, in send order, the candidate full texts sent to the view as history applications. They share the
// message type with save candidate applications, so without filtering by apply kind they get mixed up.
async function readHistoryCandidates(uri: vscode.Uri): Promise<string[]> {
  return (await readRecordedMessages(uri))
    .filter(
      (recorded) => recorded.direction === 'toView'
        && readMessageType(recorded.message) === 'replaceDocument'
        && readMessageField(recorded.message, 'kind') === 'editHistory',
    )
    .flatMap((recorded) => {
      const text = readMessageText(recorded.message);
      return text === undefined ? [] : [text];
    });
}

async function readTypesSentToView(uri: vscode.Uri): Promise<string[]> {
  return (await readRecordedMessages(uri))
    .filter((recorded) => recorded.direction === 'toView')
    .flatMap((recorded) => {
      const type = readMessageType(recorded.message);
      return type === undefined ? [] : [type];
    });
}

/** The standard command returns before the application round trip completes, so the next operation waits for the release. */
async function runStandardHistoryCommand(
  uri: vscode.Uri,
  command: 'undo' | 'redo' | 'ahve.undo' | 'ahve.redo',
): Promise<void> {
  const before = (await readTypesSentToView(uri)).filter((type) => type === 'saveReleased').length;
  await vscode.commands.executeCommand(command);
  await waitUntil(async () =>
    (await readTypesSentToView(uri)).filter((type) => type === 'saveReleased').length > before,
  'history application round trip completed');
}

async function openWysiwyg(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
  await waitUntil(
    async () => (await readRecordedMessages(uri)).length >= 2,
    'the view exchanged its startup messages',
  );
}

async function inject(uri: vscode.Uri, message: unknown): Promise<void> {
  const dispatched = await (await api()).injectViewMessage(uri.toString(), message);
  assert.ok(dispatched, 'the message was not delivered because no session is registered');
}

// Sequence number for injected edit units. Reusing an id would make it count as the previous unit's terminator.
let injectedEditUnits = 0;

/**
 * Injects, in the same order, the signal sequence a real view sends for one edit.
 *
 * The extension host cannot send key input to the webview. The after full text is the full text the view
 * currently holds, because the history side compares it with the output right before saving.
 *
 * @param uri Target document.
 * @returns Before and after endpoints of the injected edit unit.
 */
async function injectEditUnit(uri: vscode.Uri): Promise<{ before: string; after: string }> {
  const afterText = await readViewText(uri);
  // The before text only has to differ from the after text. An identical pair is rejected as invalid.
  const beforeText = `${afterText}<!-- before -->`;
  injectedEditUnits += 1;
  const unitId = `undo-redo-${injectedEditUnits}`;
  const before = { text: beforeText, selection: null };
  const after = { text: afterText, selection: null };

  await inject(uri, { type: 'viewEdited' });
  await inject(uri, { type: 'editUnitStart', unitId, start: before });
  await inject(uri, { type: 'editTransaction', transaction: { unitId, before, after } });
  await waitUntil(() => findCustomTab(uri)?.isDirty === true, 'the WYSIWYG tab became dirty');
  return { before: beforeText, after: afterText };
}

/** Leaves an edit unit without a terminator on the host, for the pre-save flush to close. */
async function injectUnsettledEditUnit(uri: vscode.Uri): Promise<void> {
  const text = await readViewText(uri);
  injectedEditUnits += 1;
  const unitId = `undo-redo-unsettled-${injectedEditUnits}`;

  await inject(uri, { type: 'viewEdited' });
  await inject(uri, {
    type: 'editUnitStart',
    unitId,
    start: { text, selection: null },
  });
  await waitUntil(() => findCustomTab(uri)?.isDirty === true, 'the WYSIWYG tab became dirty');
}

/**
 * Replaces the view content, then injects an edit unit whose after state is that content.
 *
 * @param uri Target document.
 * @param beforeText Full text to record as the before state.
 * @param afterText Full text to load into the view and record as the after state.
 */
async function injectEditFrom(
  uri: vscode.Uri,
  beforeText: string,
  afterText: string,
): Promise<void> {
  const replaced = await (await api()).replaceViewContentForTest(uri.toString(), afterText);
  assert.ok(replaced, 'the view did not accept the test document replacement');

  injectedEditUnits += 1;
  const unitId = `undo-redo-${injectedEditUnits}`;
  const before = { text: beforeText, selection: null };
  const after = { text: afterText, selection: null };

  await inject(uri, { type: 'viewEdited' });
  await inject(uri, { type: 'editUnitStart', unitId, start: before });
  await inject(uri, { type: 'editTransaction', transaction: { unitId, before, after } });
  await waitUntil(() => findCustomTab(uri)?.isDirty === true, 'the WYSIWYG tab became dirty');
}

async function revertDirtyEditors(): Promise<void> {
  for (const tab of openTabs()) {
    if (tab.input instanceof vscode.TabInputText && tab.isDirty) {
      await vscode.window.showTextDocument(tab.input.uri);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  }
}

async function deleteIfPresent(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri);
  } catch {
    // This only tried to delete a file that was never created.
  }
}

describe('undo/redo history registration and command delegation', () => {
  beforeEach(async () => {
    await revertDirtyEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await resetScratch();
    (await api()).clearDiagnosticInspection();
    (await api()).clearSaveEntryInspection();
  });

  after(async () => {
    await revertDirtyEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await deleteIfPresent(scratchUri());
  });

  for (const saveBeforeUndo of [false, true]) {
    it(`restores a cell paste through undo/redo ${saveBeforeUndo ? 'after' : 'before'} saving without adding table rows`, async () => {
      const beforeText = INITIAL_TEXT.replace('<p>ab</p>',
        '<table><tbody><tr><th>あああいいい</th></tr><tr><td><br></td></tr></tbody></table>\n<p><br></p>');
      const afterText = beforeText.replace('<td><br></td>', '<td>いいい</td>');
      const uri = await resetScratch(beforeText);
      await openWysiwyg(uri);
      await injectEditFrom(uri, beforeText, afterText);
      const buffer = await vscode.workspace.openTextDocument(uri);
      if (saveBeforeUndo) {
        await vscode.commands.executeCommand('workbench.action.files.save');
        await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the pasted table reached the save point');
        await waitUntil(() => buffer.getText() === afterText, 'the source followed the saved paste');
      }

      await runStandardHistoryCommand(uri, 'ahve.undo');

      assert.strictEqual(await readViewText(uri), beforeText);
      assert.strictEqual(await readFileText(uri), saveBeforeUndo ? afterText : beforeText);
      // History changes the view; saving the restored endpoint brings source and view together.
      await vscode.commands.executeCommand('workbench.action.files.save');
      await waitUntil(() => buffer.getText() === beforeText, 'the source followed the restored table');
      assert.strictEqual(await readFileText(uri), beforeText);

      await runStandardHistoryCommand(uri, 'ahve.redo');

      assert.strictEqual(await readViewText(uri), afterText);
      assert.deepStrictEqual(await readHistoryCandidates(uri), [beforeText, afterText]);
      await vscode.commands.executeCommand('workbench.action.files.save');
      await waitUntil(() => buffer.getText() === afterText, 'the source followed the redone table');
      assert.strictEqual(await readFileText(uri), afterText);
      // The save requested fresh output from the live view, so this also detects extra rows in that tree.
      const outputs = (await readRecordedMessages(uri))
        .filter((record) => record.direction === 'fromView' && readMessageType(record.message) === 'bodyOutputResponse')
        .map((record) => readMessageText(record.message));
      assert.strictEqual(outputs[outputs.length - 1], afterText);
      assert.strictEqual(findCustomTab(uri)?.isDirty, false);
      assert.deepStrictEqual((await api()).readDiagnosticInspection(), { notifications: [], logLines: [] });
    });
  }

  it('makes the tab dirty without diagnostics when a start and a pair are injected into the real receive path', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);
    (await api()).clearDiagnosticInspection();

    await injectEditUnit(uri);

    assert.strictEqual(findCustomTab(uri)?.isDirty, true);
    assert.deepStrictEqual((await api()).readDiagnosticInspection().logLines, []);
  });

  it('calls the save entry point from the extension save command while WYSIWYG is active', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);
    await injectEditUnit(uri);
    (await api()).clearSaveEntryInspection();

    await vscode.commands.executeCommand('ahve.save');

    await waitUntil(
      async () => (await api()).readSaveEntryInspection().calls.some(
        (call) => call.kind === 'save' && call.documentUri === uri.toString(),
      ),
      'the extension save command reached the save entry point',
    );
  });

  it('does not delegate through the extension while a text editor is active', async () => {
    const uri = scratchUri();
    await vscode.window.showTextDocument(uri);
    (await api()).clearSaveEntryInspection();

    await vscode.commands.executeCommand('ahve.save');

    assert.deepStrictEqual((await api()).readSaveEntryInspection().calls, []);
  });

  it('runs per-unit undo/redo from the standard commands with history events enabled, without mixing in history-less events', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);
    await injectEditFrom(uri, INITIAL_TEXT, EDITED_TEXT);

    await vscode.commands.executeCommand('ahve.undo');
    await waitUntil(async () => (await readHistoryCandidates(uri)).length === 1, 'undo applied the before state');
    await vscode.commands.executeCommand('ahve.redo');
    await waitUntil(async () => (await readHistoryCandidates(uri)).length === 2, 'redo applied the after state');

    assert.deepStrictEqual(await readHistoryCandidates(uri), [INITIAL_TEXT, EDITED_TEXT]);
    assert.ok(
      !(await api()).readDiagnosticInspection().logLines.some((line) => line.startsWith('Dropped a history-less change event')),
      'a history-less change event was fired alongside edit events',
    );
  });

  it('changes only the view on undo/redo across the save boundary, and keeps the save point and dirty indicator consistent', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);
    await injectEditFrom(uri, INITIAL_TEXT, EDITED_TEXT);
    await vscode.commands.executeCommand('workbench.action.files.save');
    await waitUntil(async () => await readFileText(uri) === EDITED_TEXT, 'the edit was written');
    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the tab reached the save point');
    // Move history only after the text buffer has followed the save, so the undo target does not change around the follow.
    const buffer = await vscode.workspace.openTextDocument(uri);
    await waitUntil(() => buffer.getText() === EDITED_TEXT, 'the buffer followed the save');
    await delay(500);

    assert.ok(!openTabs().some((tab) => tab.input instanceof vscode.TabInputText), 'no text tab is shown');
    const releasesBeforeUndo = (await readTypesSentToView(uri)).filter((type) => type === 'saveReleased').length;
    await vscode.commands.executeCommand('undo');
    await waitUntil(() => findCustomTab(uri)?.isDirty === true, 'undo left the save point');
    // VS Code does not accept the next redo until the running undo finishes. Wait until the application round trip closes.
    await waitUntil(
      async () => (await readTypesSentToView(uri)).filter((type) => type === 'saveReleased').length > releasesBeforeUndo,
      'undo finished its round trip',
    );
    const fileAfterUndo = await readFileText(uri);
    await vscode.commands.executeCommand('redo');
    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'redo returned to the save point');

    assert.deepStrictEqual([fileAfterUndo, await readHistoryCandidates(uri)], [EDITED_TEXT, [INITIAL_TEXT, EDITED_TEXT]]);
    assert.strictEqual(buffer.getText(), EDITED_TEXT);
    assert.strictEqual(buffer.isDirty, false);
  });

  it('keeps redo through a text reload after undo and preserves the source change in the view', async () => {
    const uri = await resetScratch(MERGE_BASE_TEXT);
    await openWysiwyg(uri);
    await injectEditFrom(uri, MERGE_BASE_TEXT, MERGE_VIEW_TEXT);
    await vscode.commands.executeCommand('workbench.action.files.save');
    await runStandardHistoryCommand(uri, 'ahve.undo');
    await waitUntil(async () => (await readHistoryCandidates(uri)).length === 1, 'undo applied');
    // Cause the same text model update as following a save after the undo, to confirm the redo branch is independent.
    const external = MERGE_SOURCE_TEXT.replace('<p>second</p>', '<p>SECOND</p>');
    await writeFileText(uri, external);
    const buffer = await vscode.workspace.openTextDocument(uri);
    await waitUntil(() => buffer.getText() === external, 'text reloaded after undo');
    await runStandardHistoryCommand(uri, 'ahve.redo');
    await waitUntil(async () => (await readHistoryCandidates(uri)).length === 2, 'redo after reload');

    assert.deepStrictEqual(await readHistoryCandidates(uri), [MERGE_BASE_TEXT, external]);
    assert.strictEqual(await readFileText(uri), external);
    assert.strictEqual(buffer.getText(), external);
    assert.strictEqual(buffer.isDirty, false);
    assert.strictEqual(findCustomTab(uri)?.isDirty, false);
  });

  it('changes only the view with the standard undo/redo after reloading an external change', async () => {
    const uri = await resetScratch(MERGE_BASE_TEXT);
    await openWysiwyg(uri);
    await injectEditFrom(uri, MERGE_BASE_TEXT, MERGE_VIEW_TEXT);
    await writeFileText(uri, MERGE_SOURCE_TEXT);
    const buffer = await vscode.workspace.openTextDocument(uri);
    await waitUntil(() => buffer.getText() === MERGE_SOURCE_TEXT, 'external change reloaded');

    await runStandardHistoryCommand(uri, 'undo');
    await waitUntil(async () => (await readHistoryCandidates(uri)).length === 1, 'undo after the external change');
    await runStandardHistoryCommand(uri, 'redo');
    await waitUntil(async () => (await readHistoryCandidates(uri)).length === 2, 'redo after the external change');

    const merged = MERGE_SOURCE_TEXT.replace('<p>second</p>', '<p>SECOND</p>');
    assert.deepStrictEqual(await readHistoryCandidates(uri), [MERGE_SOURCE_TEXT, merged]);
    assert.strictEqual(await readFileText(uri), MERGE_SOURCE_TEXT);
    assert.strictEqual(buffer.getText(), MERGE_SOURCE_TEXT);
    assert.strictEqual(buffer.isDirty, false);
    assert.strictEqual(findCustomTab(uri)?.isDirty, true);
  });

  it('keeps undo/redo of a new edit after saving consistent with the save point', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);
    await injectEditFrom(uri, INITIAL_TEXT, EDITED_TEXT);
    await vscode.commands.executeCommand('workbench.action.files.save');
    const buffer = await vscode.workspace.openTextDocument(uri);
    await waitUntil(() => buffer.getText() === EDITED_TEXT, 'followed the save');
    const latest = EDITED_TEXT.replace('abXY', 'abXYZ');
    await injectEditFrom(uri, EDITED_TEXT, latest);

    await runStandardHistoryCommand(uri, 'ahve.undo');
    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'undo of the new edit returns to the save point');
    await waitUntil(async () => (await readHistoryCandidates(uri)).length === 1, 'undo of the new edit applied');
    await runStandardHistoryCommand(uri, 'ahve.redo');
    await waitUntil(async () => (await readHistoryCandidates(uri)).length === 2, 'redo of the new edit applied');

    assert.deepStrictEqual(await readHistoryCandidates(uri), [EDITED_TEXT, latest]);
    assert.strictEqual(findCustomTab(uri)?.isDirty, true);
    assert.strictEqual(await readFileText(uri), EDITED_TEXT);
    assert.strictEqual(buffer.getText(), EDITED_TEXT);
    assert.strictEqual(buffer.isDirty, false);
  });

  it('does not erase existing text history when the WYSIWYG entry and editor tabs are closed', async () => {
    const uri = scratchUri();
    const editor = await vscode.window.showTextDocument(uri);
    const edited = await editor.edit((edit) => edit.replace(
      new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(INITIAL_TEXT.length)),
      EDITED_TEXT,
    ));
    assert.strictEqual(edited, true);
    assert.strictEqual(await editor.document.save(), true);
    await openWysiwyg(uri);
    const tab = findCustomTab(uri);
    assert.ok(tab);
    assert.strictEqual(await vscode.window.tabGroups.close(tab), true);
    await vscode.window.showTextDocument(editor.document);

    await vscode.commands.executeCommand('undo');
    await waitUntil(() => editor.document.getText() === INITIAL_TEXT, 'text undo after closing the WYSIWYG editor');
    assert.strictEqual(editor.document.isDirty, true);
    assert.strictEqual(await readFileText(uri), EDITED_TEXT);
  });

  it('flushes an unsettled unit through F-21 before deciding whether to save, even for Save All', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);
    await injectUnsettledEditUnit(uri);
    const before = (await readTypesSentToView(uri))
      .filter((type) => type === 'requestEditTransactionFlush').length;

    void Promise.resolve(vscode.commands.executeCommand('saveAll')).then(
      undefined,
      () => undefined,
    );

    await waitUntil(
      async () => (await readTypesSentToView(uri))
        .filter((type) => type === 'requestEditTransactionFlush').length > before,
      'Save All requested an edit transaction flush',
    );
  });

  it('flushes an unsettled unit through F-21 before deciding whether to save, even for auto save', async () => {
    const uri = scratchUri();
    await updateSetting('files', 'autoSaveDelay', 100);
    await updateSetting('files', 'autoSave', 'afterDelay');
    try {
      await openWysiwyg(uri);
      const before = (await readTypesSentToView(uri))
        .filter((type) => type === 'requestEditTransactionFlush').length;
      await injectUnsettledEditUnit(uri);

      await waitUntil(
        async () => (await readTypesSentToView(uri))
          .filter((type) => type === 'requestEditTransactionFlush').length > before,
        'auto save requested an edit transaction flush',
      );
    } finally {
      await updateSetting('files', 'autoSave', undefined);
      await updateSetting('files', 'autoSaveDelay', undefined);
    }
  });
});

describe('undo/redo application and the save boundary', () => {
  beforeEach(async () => {
    await revertDirtyEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await resetScratch();
    (await api()).clearDiagnosticInspection();
  });

  after(async () => {
    await revertDirtyEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await deleteIfPresent(scratchUri());
    await deleteIfPresent(fixtureUri(PROTECTION_APPLY_SCRATCH_FILE_NAME));
    await deleteIfPresent(fixtureUri(PROTECTION_REVERT_SCRATCH_FILE_NAME));
  });

  it('returns the view content to the recorded before state when undo is driven', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);
    await injectEditFrom(uri, INITIAL_TEXT, EDITED_TEXT);

    const applied = await (await api()).runHistoryTransitionForTest(uri.toString(), 'undo');

    assert.strictEqual(applied, true);
    assert.deepStrictEqual(await readHistoryCandidates(uri), [INITIAL_TEXT]);
  });

  it('returns to the pre-save content with undo after saving, and the following redo also succeeds', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);
    await injectEditFrom(uri, INITIAL_TEXT, EDITED_TEXT);
    await vscode.commands.executeCommand('workbench.action.files.save');
    await waitUntil(async () => await readFileText(uri) === EDITED_TEXT, 'the edit was written');

    const undone = await (await api()).runHistoryTransitionForTest(uri.toString(), 'undo');
    const redone = await (await api()).runHistoryTransitionForTest(uri.toString(), 'redo');

    assert.deepStrictEqual([undone, redone], [true, true]);
    // Saving does not clear the history stack. It can go back across the save boundary and forward again.
    assert.deepStrictEqual(await readHistoryCandidates(uri), [INITIAL_TEXT, EDITED_TEXT]);
  });

  it('applies undo while keeping an external change made to a different line', async () => {
    const uri = await resetScratch(MERGE_BASE_TEXT);
    await openWysiwyg(uri);
    await injectEditFrom(uri, MERGE_BASE_TEXT, MERGE_VIEW_TEXT);

    await writeFileText(uri, MERGE_SOURCE_TEXT);
    const document = await vscode.workspace.openTextDocument(uri);
    await waitUntil(() => document.getText() === MERGE_SOURCE_TEXT, 'the buffer followed the source change');
    const applied = await (await api()).runHistoryTransitionForTest(uri.toString(), 'undo');

    assert.strictEqual(applied, true);
    // Only the view-side change is reverted; the source-side change that came in later is kept.
    assert.deepStrictEqual(await readHistoryCandidates(uri), [MERGE_SOURCE_TEXT]);
  });

  it('stops editing, saving, and history and shows the protection notification after an application failure', async () => {
    const uri = await resetNamedScratch(PROTECTION_APPLY_SCRATCH_FILE_NAME);
    await openWysiwyg(uri);
    await injectEditFrom(uri, INITIAL_TEXT, EDITED_TEXT);
    // Leave an edit unit whose terminator never arrives. Unsettled content cannot serve as a history endpoint.
    await inject(uri, {
      type: 'editUnitStart',
      unitId: 'unsettled',
      start: { text: EDITED_TEXT, selection: null },
    });
    (await api()).clearDiagnosticInspection();

    // This call waits for preservation of the old content to complete, so it never resolves.
    void (await api()).runHistoryTransitionForTest(uri.toString(), 'undo');

    await waitUntil(
      async () => (await api()).readDiagnosticInspection().notifications.length > 0,
      'the protection notification was shown',
    );
    await waitUntil(
      async () => (await readTypesSentToView(uri)).includes('historyProtectionActivated'),
      'the view received the protection state',
    );
    assert.deepStrictEqual(await readHistoryCandidates(uri), []);

    (await api()).clearSaveEntryInspection();
    void Promise.resolve(vscode.commands.executeCommand('ahve.save')).then(
      undefined,
      () => undefined,
    );
    await delay(POLLING_INTERVAL_MS);
    assert.deepStrictEqual((await api()).readSaveEntryInspection().calls, []);

    void (await api()).runHistoryTransitionForTest(uri.toString(), 'undo');
    await delay(POLLING_INTERVAL_MS);
    assert.deepStrictEqual(await readHistoryCandidates(uri), []);
  });

  it('enters history-side protection after a Revert failure', async () => {
    const uri = await resetNamedScratch(PROTECTION_REVERT_SCRATCH_FILE_NAME);
    await openWysiwyg(uri);
    await injectEditUnit(uri);
    // Make the text tab dirty. Revert cannot proceed while the source is not following the disk.
    const editor = await vscode.window.showTextDocument(uri);
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), '<!-- dirty -->'));
    (await api()).clearDiagnosticInspection();

    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
    await vscode.commands.executeCommand('workbench.action.files.revert').then(
      () => undefined,
      () => undefined,
    );

    await waitUntil(
      async () => (await api()).readDiagnosticInspection().notifications.length > 0,
      'the revert failure and protection were reported',
    );
    await waitUntil(
      () => findCustomTab(uri)?.isDirty === false,
      'the failed revert completed without a history-less change event',
    );
  });
});
