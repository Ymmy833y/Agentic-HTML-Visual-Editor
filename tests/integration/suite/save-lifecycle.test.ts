import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { customTabMatchesSource } from '../helpers/editor-tabs';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';

// The WYSIWYG editor cannot be opened unless this matches the declaration in package.json.
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

// The upper bound for loading the view, for a round trip, and for a tab changing state.
const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

// A wait longer than the response timeout (2 seconds), used to confirm that nothing is left waiting.
const SETTLE_MS = 3000;

// A save rewrites the disk, so no fixture file committed to the repository is used.
const SCRATCH_FILE_NAME = 'save-lifecycle-scratch.html';
// The dirty text tab cases leave their text side dirty or rewritten until the suite's cleanup, so they use a source
// file separate from the later cases.
const DIRTY_TEXT_TAB_SCRATCH_FILE_NAME = 'save-lifecycle-dirty-text-tab-scratch.html';

const INITIAL_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>ab</p>\n</body>\n</html>\n';
const EXTERNAL_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>external</p>\n</body>\n</html>\n';
// INITIAL_TEXT after the one-character edit that the dirty text tab cases insert at the start of line 3.
const TEXT_TAB_EDITED_TEXT = '<!DOCTYPE html>\n<html>\n<body>\nZ<p>ab</p>\n</body>\n</html>\n';
const MERGE_BASE_TEXT = [
  '<!DOCTYPE html>', '<html>', '<body>', '<p>first</p>', '<hr>', '<p>second</p>', '</body>', '</html>', '',
].join('\n');
const MERGE_SOURCE_TEXT = MERGE_BASE_TEXT.replace('<p>first</p>', '<p>FIRST</p>');
const MERGE_VIEW_TEXT = MERGE_BASE_TEXT.replace('<p>second</p>', '<p>SECOND</p>');
const MERGED_TEXT = MERGE_SOURCE_TEXT.replace('<p>second</p>', '<p>SECOND</p>');
const CRLF_TEXT = INITIAL_TEXT.replace(/\n/g, '\r\n');
const NON_ASCII_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>Japanese and emoji 🎈</p>\n</body>\n</html>\n';
// ASCII only, so its bytes read the same in Shift_JIS and UTF-8 and only the declaration differs.
const SHIFT_JIS_DECLARED_TEXT =
  '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="shift_jis">\n</head>\n<body>\n<p>ab</p>\n</body>\n</html>\n';
// Line 3 has trailing whitespace. If the save participants run, that whitespace is trimmed.
const TRAILING_SPACE_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>ab</p>   \n</body>\n</html>\n';

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
}

function findExtension(): vscode.Extension<ExtensionApi> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} is not loaded in VS Code`);
  return extension;
}

async function api(): Promise<ExtensionApi> {
  return findExtension().activate();
}

// The extension path handed to the development host is the repository root.
function fixtureUri(fileName: string): vscode.Uri {
  return vscode.Uri.joinPath(
    findExtension().extensionUri,
    'tests',
    'integration',
    'fixtures',
    fileName,
  );
}

function openTabs(): readonly vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

function findCustomTab(uri: vscode.Uri): vscode.Tab | undefined {
  return openTabs().find(
    (tab) => customTabMatchesSource(tab, uri),
  );
}

function findTextTab(uri: vscode.Uri): vscode.Tab | undefined {
  return openTabs().find(
    (tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString(),
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(condition: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;

  for (;;) {
    if (await condition()) {
      return;
    }
    assert.ok(Date.now() < deadline, `Timed out before ${description}`);
    await delay(POLLING_INTERVAL_MS);
  }
}

async function updateSetting(section: string, key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration(section)
    .update(key, value, vscode.ConfigurationTarget.Global);
}

async function readFileBytes(uri: vscode.Uri): Promise<Uint8Array> {
  return vscode.workspace.fs.readFile(uri);
}

async function readFileText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await readFileBytes(uri));
}

async function writeFileText(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

// Writes back to disk and waits until the still-open buffer follows that content.
// Without the wait, the test would be working against a buffer still holding the previous test's content.
async function resetScratch(text: string = INITIAL_TEXT): Promise<vscode.Uri> {
  const uri = fixtureUri(SCRATCH_FILE_NAME);
  await writeFileText(uri, text);

  const document = await vscode.workspace.openTextDocument(uri);
  await waitUntil(() => document.getText() === text, 'the buffer followed the initial content');
  return uri;
}

async function readRecordedMessages(uri: vscode.Uri): Promise<readonly RecordedMessage[]> {
  const inspection = (await api()).readWebviewInspection(uri.toString());
  return inspection?.messages ?? [];
}

function readMessageType(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const value: unknown = Object.getOwnPropertyDescriptor(message, 'type')?.value;
  return typeof value === 'string' ? value : undefined;
}

function readMessageText(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const value: unknown = Object.getOwnPropertyDescriptor(message, 'text')?.value;
  return typeof value === 'string' ? value : undefined;
}

function readMessageKind(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const value: unknown = Object.getOwnPropertyDescriptor(message, 'kind')?.value;
  return typeof value === 'string' ? value : undefined;
}

// Return the full document text of replacements sent with the given application kind, in send order. Revert, external
// change, and save candidate application use the same message type, so filtering by application kind keeps them apart.
async function readReplacements(uri: vscode.Uri, kind: string): Promise<string[]> {
  const messages = await readRecordedMessages(uri);
  return messages
    .filter(
      (recorded) =>
        recorded.direction === 'toView'
        && readMessageType(recorded.message) === 'replaceDocument'
        && readMessageKind(recorded.message) === kind,
    )
    .flatMap((recorded) => {
      const text = readMessageText(recorded.message);
      return text === undefined ? [] : [text];
    });
}

// Returns the types of the messages sent from the host to the view, in send order.
async function readTypesSentToView(uri: vscode.Uri): Promise<string[]> {
  const messages = await readRecordedMessages(uri);
  return messages
    .filter((recorded) => recorded.direction === 'toView')
    .flatMap((recorded) => {
      const type = readMessageType(recorded.message);
      return type === undefined ? [] : [type];
    });
}

// Loading the view gives no completion signal, so wait until the startup round trip has finished.
async function openWysiwyg(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);

  const deadline = Date.now() + STATE_TIMEOUT_MS;
  for (;;) {
    if ((await readRecordedMessages(uri)).length >= 2) {
      return;
    }
    assert.ok(Date.now() < deadline, 'Timed out before the view exchanged its startup messages');
    await delay(POLLING_INTERVAL_MS);
  }
}

// Full document text most recently handed to the view. The view holds it as is, so its output is this text too.
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

// Sequence number for injected edit units. Reusing an id would make it count as the previous unit's terminator.
let injectedEditUnits = 0;

// Key input in the webview cannot be driven from the extension host, so the signal sequence a real view
// sends for one edit is injected in the same order. The after full text is the full text the view currently
// holds, because the history side compares it with the output right before saving.
async function makeViewDirty(uri: vscode.Uri): Promise<void> {
  const after = { text: await readViewText(uri), selection: null };
  // The before text only has to differ from the after text. An identical pair is rejected as invalid.
  const before = { text: `${after.text}<!-- before -->`, selection: null };
  injectedEditUnits += 1;
  const unitId = `integration-${injectedEditUnits}`;

  for (const message of [
    { type: 'viewEdited' },
    { type: 'editUnitStart', unitId, start: before },
    { type: 'editTransaction', transaction: { unitId, before, after } },
  ]) {
    const dispatched = await (await api()).injectViewMessage(uri.toString(), message);
    assert.ok(dispatched, 'the message was not delivered because no session is registered');
  }

  await waitUntil(() => findCustomTab(uri)?.isDirty === true, 'the WYSIWYG tab became dirty');
}

// Replace the live view tree so the next output request returns the modified full text.
async function replaceViewContent(uri: vscode.Uri, text: string): Promise<void> {
  const replaced = await (await api()).replaceViewContentForTest(uri.toString(), text);
  assert.ok(replaced, 'the view did not accept the test document replacement');
}

// Discards the text tab's edits so that the next test's cleanup is not blocked by a confirmation dialog.
async function revertDirtyTextEditors(): Promise<void> {
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

describe('writing to the file on save', () => {
  beforeEach(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await resetScratch();
  });

  after(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await deleteIfPresent(fixtureUri(SCRATCH_FILE_NAME));
  });

  it('marks a cell paste dirty and saves the pasted text without diagnostics', async () => {
    const beforeText = INITIAL_TEXT.replace('<p>ab</p>',
      '<table><tbody><tr><th>あああいいい</th></tr><tr><td><br></td></tr></tbody></table>\n<p><br></p>');
    const afterText = beforeText.replace('<td><br></td>', '<td>いいい</td>');
    const uri = await resetScratch(beforeText);
    await openWysiwyg(uri);
    await replaceViewContent(uri, afterText);
    const extensionApi = await api();
    extensionApi.clearDiagnosticInspection();
    injectedEditUnits += 1;
    const unitId = `cell-paste-${injectedEditUnits}`;
    const before = { text: beforeText, selection: null };
    const after = { text: afterText, selection: null };
    // DOM paste behavior is covered in E2E; this layer exercises the real host receive and save paths.
    for (const message of [
      { type: 'editUnitStart', unitId, start: before },
      { type: 'viewEdited' },
      { type: 'editTransaction', transaction: { unitId, before, after } },
    ]) {
      assert.strictEqual(await extensionApi.injectViewMessage(uri.toString(), message), true);
    }
    await waitUntil(() => findCustomTab(uri)?.isDirty === true, 'the cell paste marked the tab dirty');
    assert.strictEqual(await readFileText(uri), beforeText);

    await vscode.commands.executeCommand('workbench.action.files.save');

    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the cell paste was saved');
    assert.strictEqual(await readFileText(uri), afterText);
    const document = await vscode.workspace.openTextDocument(uri);
    await waitUntil(() => document.getText() === afterText, 'the source buffer followed the cell paste save');
    assert.deepStrictEqual(extensionApi.readDiagnosticInspection(), { notifications: [], logLines: [] });
  });

  it('writes the file and clears the dirty mark when saving from a dirty WYSIWYG tab', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    await openWysiwyg(uri);
    await makeViewDirty(uri);

    await vscode.commands.executeCommand('workbench.action.files.save');

    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');
    assert.strictEqual(await readFileText(uri), INITIAL_TEXT);
  });

  it('writes a CRLF file back with CRLF intact', async () => {
    const uri = await resetScratch(CRLF_TEXT);
    await openWysiwyg(uri);
    await makeViewDirty(uri);

    await vscode.commands.executeCommand('workbench.action.files.save');

    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');
    assert.strictEqual(await readFileText(uri), CRLF_TEXT);
  });

  it('drops the BOM but keeps the content when saving a UTF-8 file with a BOM', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    await writeFileText(uri, `﻿${INITIAL_TEXT}`);
    await openWysiwyg(uri);
    await makeViewDirty(uri);

    await vscode.commands.executeCommand('workbench.action.files.save');

    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');
    const bytes = await readFileBytes(uri);
    assert.deepStrictEqual([bytes[0], bytes[1], bytes[2]], [0x3c, 0x21, 0x44]);
    assert.strictEqual(await readFileText(uri), INITIAL_TEXT);
  });

  it('declares UTF-8 in the head on save and leaves the other lines unchanged when the file declares another encoding', async () => {
    const uri = await resetScratch(SHIFT_JIS_DECLARED_TEXT);
    await openWysiwyg(uri);
    await makeViewDirty(uri);

    await vscode.commands.executeCommand('workbench.action.files.save');

    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');
    assert.strictEqual(
      await readFileText(uri),
      SHIFT_JIS_DECLARED_TEXT.replace('<meta charset="shift_jis">', '<meta charset="utf-8">'),
    );
  });

  it('leaves the characters unchanged when saving a file containing non-ASCII text', async () => {
    const uri = await resetScratch(NON_ASCII_TEXT);
    await openWysiwyg(uri);
    await makeViewDirty(uri);

    await vscode.commands.executeCommand('workbench.action.files.save');

    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');
    assert.strictEqual(await readFileText(uri), NON_ASCII_TEXT);
  });

  it('leaves unedited lines untouched on save even when trailing whitespace trimming is enabled', async () => {
    await updateSetting('files', 'trimTrailingWhitespace', true);
    try {
      const uri = await resetScratch(TRAILING_SPACE_TEXT);
      await openWysiwyg(uri);
      await makeViewDirty(uri);

      await vscode.commands.executeCommand('workbench.action.files.save');

      await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');
      assert.strictEqual(await readFileText(uri), TRAILING_SPACE_TEXT);
    } finally {
      await updateSetting('files', 'trimTrailingWhitespace', undefined);
    }
  });
});

describe('signalling the end of a round trip', () => {
  beforeEach(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await resetScratch();
  });

  after(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await deleteIfPresent(fixtureUri(SCRATCH_FILE_NAME));
  });

  it('delivers one request body output message and one save committed message to the view, in that order, on a successful save', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    await openWysiwyg(uri);
    await makeViewDirty(uri);

    await vscode.commands.executeCommand('workbench.action.files.save');

    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');
    // The save committed message is sent after the outcome is returned, so it may not have arrived yet
    // at the moment the dirty mark clears.
    await delay(SETTLE_MS);
    const types = (await readTypesSentToView(uri)).filter(
      (type) => type === 'requestBodyOutput' || type === 'saveCommitted',
    );
    assert.deepStrictEqual(types, ['requestBodyOutput', 'saveCommitted']);
  });

  it('sends the revert replacement after the save committed message when a revert runs right after a save', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    await openWysiwyg(uri);
    await makeViewDirty(uri);

    await vscode.commands.executeCommand('workbench.action.files.save');
    await makeViewDirty(uri);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await waitUntil(
      async () => (await readReplacements(uri, 'revert')).length > 0,
      'the revert replacement was sent to the view',
    );

    const messages = await readRecordedMessages(uri);
    const order = messages
      .filter((recorded) => recorded.direction === 'toView')
      .flatMap((recorded) => {
        const type = readMessageType(recorded.message);
        if (type === 'saveCommitted') {
          return ['saveCommitted'];
        }
        return type === 'replaceDocument' && readMessageKind(recorded.message) === 'revert'
          ? ['revertReplacement']
          : [];
      });
    assert.deepStrictEqual(order, ['saveCommitted', 'revertReplacement']);
  });
});

describe('re-reading the view on revert', () => {
  beforeEach(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await resetScratch();
    (await api()).clearDiagnosticInspection();
  });

  after(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await deleteIfPresent(fixtureUri(SCRATCH_FILE_NAME));
    await deleteIfPresent(fixtureUri(DIRTY_TEXT_TAB_SCRATCH_FILE_NAME));
  });

  it('delivers a replacement carrying the external content when reverting after something outside rewrote the disk', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    await openWysiwyg(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    await writeFileText(uri, EXTERNAL_TEXT);
    await waitUntil(() => document.getText() === EXTERNAL_TEXT, 'the buffer followed the external content');
    // Buffer follow alone leaves the external change replacement still mid round trip with the view. Injecting
    // the dirtying edit during that time would overlap the replacement, and how long Revert waits in the queue
    // would vary from run to run.
    await waitUntil(
      async () => (await readRecordedMessages(uri)).some(
        (recorded) => recorded.direction === 'fromView' && readMessageType(recorded.message) === 'documentReplaced',
      ),
      'the view answered the external change replacement',
    );
    await makeViewDirty(uri);

    await vscode.commands.executeCommand('workbench.action.files.revert');
    await waitUntil(
      async () => (await readReplacements(uri, 'revert')).length > 0,
      'a replacement carrying the external content was sent to the view',
    );

    assert.deepStrictEqual(await readReplacements(uri, 'revert'), [EXTERNAL_TEXT]);
  });

  it('Revert immediately after Save waits for buffer follow before restoring the just-written full text', async () => {
    const uri = await resetScratch(MERGE_BASE_TEXT);
    await openWysiwyg(uri);
    await replaceViewContent(uri, MERGE_VIEW_TEXT);
    await makeViewDirty(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    await writeFileText(uri, MERGE_SOURCE_TEXT);
    await waitUntil(() => document.getText() === MERGE_SOURCE_TEXT, 'the buffer followed the external content');

    await vscode.commands.executeCommand('workbench.action.files.save');
    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');
    assert.strictEqual(await readFileText(uri), MERGED_TEXT);
    await makeViewDirty(uri);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await waitUntil(
      async () => (await readReplacements(uri, 'revert')).length > 0,
      'a replacement carrying the saved content was sent to the view',
    );

    // Rereading without waiting for buffer follow would return the pre-write buffer content.
    assert.deepStrictEqual(await readReplacements(uri, 'revert'), [MERGED_TEXT]);
  });

  it('reverts the view to the file on disk and keeps the text tab dirty when the text tab holds unsaved edits', async () => {
    const uri = fixtureUri(DIRTY_TEXT_TAB_SCRATCH_FILE_NAME);
    await writeFileText(uri, INITIAL_TEXT);
    const buffer = await vscode.workspace.openTextDocument(uri);
    await waitUntil(() => buffer.getText() === INITIAL_TEXT, 'the buffer followed the initial content');
    await vscode.commands.executeCommand('vscode.open', uri);
    await openWysiwyg(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(3, 0), 'Z');
    assert.ok(await vscode.workspace.applyEdit(edit), 'the edit to the text buffer was not applied');
    await waitUntil(() => findTextTab(uri)?.isDirty === true, 'the text tab became dirty');
    await makeViewDirty(uri);
    (await api()).clearDiagnosticInspection();

    await vscode.commands.executeCommand('workbench.action.files.revert');

    await waitUntil(
      async () => (await readReplacements(uri, 'revert')).length > 0,
      'the revert replacement reached the view',
    );
    assert.deepStrictEqual(await readReplacements(uri, 'revert'), [INITIAL_TEXT]);
    assert.strictEqual(findCustomTab(uri)?.isDirty, false);
    // The unsaved edits of the text tab are not the revert's business: they stay where they are.
    assert.strictEqual(findTextTab(uri)?.isDirty, true);
    assert.strictEqual(await readFileText(uri), INITIAL_TEXT);
    assert.deepStrictEqual((await api()).readDiagnosticInspection().notifications, []);
  });

  it('delivers the text tab edits to the view as an external change when the text tab is saved after the revert', async () => {
    const uri = fixtureUri(DIRTY_TEXT_TAB_SCRATCH_FILE_NAME);
    await writeFileText(uri, INITIAL_TEXT);
    const buffer = await vscode.workspace.openTextDocument(uri);
    await waitUntil(() => buffer.getText() === INITIAL_TEXT, 'the buffer followed the initial content');
    await vscode.commands.executeCommand('vscode.open', uri);
    await openWysiwyg(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(3, 0), 'Z');
    assert.ok(await vscode.workspace.applyEdit(edit), 'the edit to the text buffer was not applied');
    await waitUntil(() => findTextTab(uri)?.isDirty === true, 'the text tab became dirty');
    await makeViewDirty(uri);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await waitUntil(
      async () => (await readReplacements(uri, 'revert')).length > 0,
      'the revert replacement reached the view',
    );

    // The text document saves itself. The save command would go to whichever tab is active instead.
    assert.ok(await buffer.save(), 'the text buffer was not saved');

    await waitUntil(
      async () => (await readReplacements(uri, 'externalChange')).length > 0,
      'the external change replacement reached the view',
    );
    assert.deepStrictEqual(await readReplacements(uri, 'externalChange'), [TEXT_TAB_EDITED_TEXT]);
  });
});

describe('disposing the tab mid round trip', () => {
  beforeEach(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await resetScratch();
    (await api()).clearDiagnosticInspection();
  });

  after(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await deleteIfPresent(fixtureUri(SCRATCH_FILE_NAME));
  });

  it('leaves the extension host with nothing waiting for a response when the tab is closed mid save round trip', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    await openWysiwyg(uri);
    await makeViewDirty(uri);
    (await api()).clearDiagnosticInspection();

    // Close without waiting for completion. Waiting would let the round trip finish, so the disposal
    // would no longer overlap it.
    void Promise.resolve(vscode.commands.executeCommand('workbench.action.files.save')).then(
      undefined,
      () => undefined,
    );
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await delay(SETTLE_MS);

    const timedOut = (await api())
      .readDiagnosticInspection()
      .logLines.filter((line) => line.includes('No response of type'));
    assert.deepStrictEqual(timedOut, []);
  });
});

describe('how it meshes with auto save', () => {
  beforeEach(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await resetScratch();
    (await api()).clearSaveEntryInspection();
  });

  afterEach(async () => {
    await updateSetting('files', 'autoSave', undefined);
    await updateSetting('files', 'autoSaveDelay', undefined);
  });

  after(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await deleteIfPresent(fixtureUri(SCRATCH_FILE_NAME));
  });

  it('keeps save entry point calls for a single edit to at most two when auto save is set to onFocusChange', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    await updateSetting('files', 'autoSave', 'onFocusChange');
    await openWysiwyg(uri);
    (await api()).clearSaveEntryInspection();
    await makeViewDirty(uri);

    // If the blur that raising the overlay causes triggers another onFocusChange save, saves start
    // going round in a loop from here.
    await vscode.commands.executeCommand('vscode.open', fixtureUri('sample.html'));
    await delay(SETTLE_MS);

    const calls = (await api())
      .readSaveEntryInspection()
      .calls.filter((call) => call.kind === 'save' && call.documentUri === uri.toString());
    assert.ok(calls.length <= 2, `saves are going round in a loop: ${calls.length} calls`);
  });
});
