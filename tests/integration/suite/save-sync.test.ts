import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { customTabMatchesSource } from '../helpers/editor-tabs';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';

// Must match the package.json declaration so the WYSIWYG editor can open.
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

// Maximum wait for view loading, round trips, and tab state changes.
const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

// Wait longer than the response timeout (2 seconds) and buffer-follow timeout (3 seconds) to confirm no wait remains.
const SETTLE_MS = 5000;

// Saves modify the disk, so do not use a fixed fixture checked into the repository.
const SCRATCH_FILE_NAME = 'save-sync-scratch.html';
const GLOB_SCRATCH_FILE_NAME = 'save-sync[1].html';
const LEGACY_GLOB_MATCH_FILE_NAME = 'save-sync1.html';

// Place a line between the two paragraphs so that these cases stay about changes that are apart. The adjacent case
// has a fixture of its own below.
const INITIAL_TEXT = [
  '<!DOCTYPE html>', '<html>', '<body>', '<p>first</p>', '<hr>', '<p>second</p>', '</body>', '</html>', '',
].join('\n');
const SOURCE_EDITED_TEXT = INITIAL_TEXT.replace('<p>first</p>', '<p>FIRST</p>');
const VIEW_EDITED_TEXT = INITIAL_TEXT.replace('<p>second</p>', '<p>SECOND</p>');
const MERGED_TEXT = SOURCE_EDITED_TEXT.replace('<p>second</p>', '<p>SECOND</p>');

// Both sides change the same line. The candidate keeps both lines as written, the source line first.
const CONFLICT_SOURCE_EDITED_TEXT = INITIAL_TEXT.replace('<p>first</p>', '<p>from source</p>');
const CONFLICT_VIEW_EDITED_TEXT = INITIAL_TEXT.replace('<p>first</p>', '<p>from view</p>');
const CONFLICT_MERGED_TEXT = INITIAL_TEXT.replace('<p>first</p>', '<p>from source</p>\n<p>from view</p>');

const CRLF_TEXT = INITIAL_TEXT.replace(/\n/g, '\r\n');
const CRLF_SOURCE_EDITED_TEXT = SOURCE_EDITED_TEXT.replace(/\n/g, '\r\n');

// Document missing its closing tags. Applying this content fails because the view cannot determine its boundaries.
const UNBOUNDED_TEXT = INITIAL_TEXT.replace('</body>\n', '');

// The two paragraphs sit on adjacent lines, so the source edit and the view edit touch at their boundary.
const ADJACENT_INITIAL_TEXT = [
  '<!DOCTYPE html>', '<html>', '<body>', '<p>first</p>', '<p>second</p>', '</body>', '</html>', '',
].join('\n');
const ADJACENT_SOURCE_EDITED_TEXT = ADJACENT_INITIAL_TEXT.replace('<p>first</p>', '<p>FIRST</p>');
const ADJACENT_VIEW_EDITED_TEXT = ADJACENT_INITIAL_TEXT.replace('<p>second</p>', '<p>SECOND</p>');
const ADJACENT_MERGED_TEXT = ADJACENT_SOURCE_EDITED_TEXT.replace('<p>second</p>', '<p>SECOND</p>');

// A fragment of the notification shown when the text tab holds unsaved edits.
const DIRTY_TEXT_TAB_NOTICE_FRAGMENT = 'unsaved edits';

interface RecordedMessage {
  readonly direction: 'fromView' | 'toView';
  readonly message: unknown;
}

interface ExtensionApi {
  readWebviewInspection(documentUri: string): {
    readonly messages: readonly RecordedMessage[];
    readonly sourceChangeTriggers: readonly string[];
  } | undefined;
  readDiagnosticInspection(): {
    readonly notifications: readonly string[];
    readonly logLines: readonly string[];
  };
  clearDiagnosticInspection(): void;
  readSaveEntryInspection(): { readonly calls: readonly { readonly kind: string }[] };
  clearSaveEntryInspection(): void;
  saveTextEditorThenViewForTest(documentUri: string): Promise<boolean>;
  injectViewMessage(documentUri: string, message: unknown): Promise<boolean>;
  replaceViewContentForTest(documentUri: string, text: string): Promise<boolean>;
  prepareInitialReconcileForTest(documentUri: string): {
    readonly reached: Promise<void>;
    release(): void;
  } | undefined;
}

function findExtension(): vscode.Extension<ExtensionApi> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} is not loaded in VS Code`);
  return extension;
}

async function api(): Promise<ExtensionApi> {
  return findExtension().activate();
}

// The extension path passed to the development host is the repository root.
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

async function readFileText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

async function writeFileText(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

// Write back to disk and wait for the open buffer to follow that content. Otherwise the next test would operate on a
// buffer still containing the previous test's content.
async function resetScratch(text: string = INITIAL_TEXT): Promise<vscode.Uri> {
  const uri = fixtureUri(SCRATCH_FILE_NAME);
  await writeFileText(uri, text);

  const document = await vscode.workspace.openTextDocument(uri);
  await waitUntil(() => document.getText() === text, 'the buffer followed the initial content');
  return uri;
}

// Modify the disk outside the extension and wait for the text buffer to follow that content.
async function writeExternally(uri: vscode.Uri, text: string): Promise<void> {
  await writeFileText(uri, text);
  const document = await vscode.workspace.openTextDocument(uri);
  await waitUntil(() => document.getText() === text, 'the buffer followed the external content');
}

async function readRecordedMessages(uri: vscode.Uri): Promise<readonly RecordedMessage[]> {
  const inspection = (await api()).readWebviewInspection(uri.toString());
  return inspection?.messages ?? [];
}

async function readFileChangeTriggers(uri: vscode.Uri): Promise<string[]> {
  const inspection = (await api()).readWebviewInspection(uri.toString());
  return (inspection?.sourceChangeTriggers ?? []).filter((trigger) => trigger === 'fileChange');
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

// Return, in send order, the full document text of replacements with the specified application kind sent from the
// host to the view. Save candidate application uses the same message type, so filtering by kind prevents confusion.
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

// View loading has no completion signal, so wait until the startup round trip finishes.
async function openWysiwyg(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);

  await waitUntil(
    async () => (await readRecordedMessages(uri)).length >= 2,
    'the view exchanged its startup messages',
  );
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

// The extension host cannot generate webview keystrokes, so the signal sequence a real view sends for one
// edit is injected in the same order. The after full text is the full text the view currently holds, because
// the history side compares it with the output right before saving.
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

// Discard text-tab edits so cleanup for the next test is not blocked by a confirmation dialog.
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
    // The cleanup only attempted to delete a file that was never created.
  }
}

async function resetEditors(): Promise<void> {
  await revertDirtyTextEditors();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

describe('reflecting external changes in the view', () => {
  beforeEach(async () => {
    await resetEditors();
    await resetScratch();
    (await api()).clearDiagnosticInspection();
  });

  after(async () => {
    await resetEditors();
    await deleteIfPresent(fixtureUri(SCRATCH_FILE_NAME));
    await deleteIfPresent(fixtureUri(GLOB_SCRATCH_FILE_NAME));
    await deleteIfPresent(fixtureUri(LEGACY_GLOB_MATCH_FILE_NAME));
  });

  it('replaces a view without unsaved edits when the source is changed externally', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    await openWysiwyg(uri);

    await writeExternally(uri, SOURCE_EDITED_TEXT);

    await waitUntil(
      async () => (await readReplacements(uri, 'externalChange')).includes(SOURCE_EDITED_TEXT),
      'the external content reached the view as a replacement',
    );
  });

  it('passes only target file changes with glob characters to source-change reconciliation', async () => {
    const uri = fixtureUri(GLOB_SCRATCH_FILE_NAME);
    const legacyMatchUri = fixtureUri(LEGACY_GLOB_MATCH_FILE_NAME);
    await writeFileText(uri, INITIAL_TEXT);
    await deleteIfPresent(legacyMatchUri);
    await openWysiwyg(uri);
    // Consume the notification from writing the target file during setup before comparing only the increase caused by
    // another URI.
    await delay(SETTLE_MS);
    const triggersBeforeOtherChange = await readFileChangeTriggers(uri);

    // Change another URI first that the old glob implementation would misidentify as the target.
    await writeFileText(legacyMatchUri, SOURCE_EDITED_TEXT);
    await delay(SETTLE_MS);
    assert.deepStrictEqual(await readFileChangeTriggers(uri), triggersBeforeOtherChange);

    await writeFileText(uri, SOURCE_EDITED_TEXT);

    await waitUntil(
      async () => (await readFileChangeTriggers(uri)).length > triggersBeforeOtherChange.length,
      'the target file change reached source reconciliation',
    );
  });

  it('replaces the view during initial reconciliation after an external change following the mount read', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    const gate = (await api()).prepareInitialReconcileForTest(uri.toString());
    assert.ok(gate, 'the initial reconcile test gate is unavailable');

    const opening = vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
    try {
      // Hold startup after the mount read but before sync-base initialization. The external write then produces a
      // notification that cannot yet be reconciled, forcing initial reconciliation to consume it after release.
      await gate.reached;
      await writeExternally(uri, SOURCE_EDITED_TEXT);
    } finally {
      gate.release();
    }
    await opening;

    await waitUntil(
      async () => (await readReplacements(uri, 'externalChange')).includes(SOURCE_EDITED_TEXT),
      'the initial reconcile sent the external content to the view',
    );
  });

  it('does not replace a view with unsaved edits and preserves both changes on the subsequent save', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    await openWysiwyg(uri);
    await replaceViewContent(uri, VIEW_EDITED_TEXT);
    await makeViewDirty(uri);

    await writeExternally(uri, SOURCE_EDITED_TEXT);
    await delay(SETTLE_MS);
    const replacementsWhileDirty = await readReplacements(uri, 'externalChange');
    await vscode.commands.executeCommand('workbench.action.files.save');
    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');

    assert.deepStrictEqual(replacementsWhileDirty, []);
    assert.strictEqual(await readFileText(uri), MERGED_TEXT);
  });

  it('does not report saved content back to the view as an external change immediately after saving', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    await openWysiwyg(uri);
    await makeViewDirty(uri);

    await vscode.commands.executeCommand('workbench.action.files.save');
    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');
    await delay(SETTLE_MS);

    assert.deepStrictEqual(await readReplacements(uri, 'externalChange'), []);
  });
});

describe('save-time merge', () => {
  beforeEach(async () => {
    await resetEditors();
    await resetScratch();
    (await api()).clearDiagnosticInspection();
  });

  after(async () => {
    await resetEditors();
    await deleteIfPresent(fixtureUri(SCRATCH_FILE_NAME));
  });

  it('preserves view and source changes after saving when another source line changes during view editing', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    await openWysiwyg(uri);
    await replaceViewContent(uri, VIEW_EDITED_TEXT);
    await makeViewDirty(uri);
    await writeExternally(uri, SOURCE_EDITED_TEXT);

    await vscode.commands.executeCommand('workbench.action.files.save');
    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');

    assert.strictEqual(await readFileText(uri), MERGED_TEXT);
  });

  it('keeps both changes in place after saving when the source changes the line next to the view edit', async () => {
    const uri = await resetScratch(ADJACENT_INITIAL_TEXT);
    await openWysiwyg(uri);
    await replaceViewContent(uri, ADJACENT_VIEW_EDITED_TEXT);
    await makeViewDirty(uri);
    await writeExternally(uri, ADJACENT_SOURCE_EDITED_TEXT);

    await vscode.commands.executeCommand('workbench.action.files.save');
    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');

    assert.strictEqual(await readFileText(uri), ADJACENT_MERGED_TEXT);
  });

  it('writes the source line and then the view line, each as written, after saving when both sides change the same line', async () => {
    const uri = await resetScratch();
    await openWysiwyg(uri);
    await replaceViewContent(uri, CONFLICT_VIEW_EDITED_TEXT);
    await makeViewDirty(uri);
    await writeExternally(uri, CONFLICT_SOURCE_EDITED_TEXT);

    await vscode.commands.executeCommand('workbench.action.files.save');
    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');

    assert.strictEqual(await readFileText(uri), CONFLICT_MERGED_TEXT);
  });

  it('keeps a CRLF file in CRLF when saving with incorporated external changes', async () => {
    const uri = await resetScratch(CRLF_TEXT);
    await openWysiwyg(uri);
    await makeViewDirty(uri);
    await writeExternally(uri, CRLF_SOURCE_EDITED_TEXT);

    await vscode.commands.executeCommand('workbench.action.files.save');
    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');

    assert.strictEqual(await readFileText(uri), CRLF_SOURCE_EDITED_TEXT);
  });

  it('fails to save without changing the file when its text tab is dirty', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    await vscode.commands.executeCommand('vscode.open', uri);
    // The text buffer is made dirty before the view opens. The first edit of a clean buffer reaches an open view as a
    // change event whose document does not read as dirty yet, so the view would take the unsaved text as an external
    // change, and the save would then fail on the view output instead of on the dirty text buffer.
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(3, 0), 'Z');
    assert.ok(await vscode.workspace.applyEdit(edit), 'the edit to the text buffer was not applied');
    await waitUntil(() => findTextTab(uri)?.isDirty === true, 'the text tab became dirty');
    await openWysiwyg(uri);
    await makeViewDirty(uri);

    await vscode.commands
      .executeCommand('workbench.action.files.save')
      .then(undefined, () => undefined);
    await delay(SETTLE_MS);

    assert.strictEqual(await readFileText(uri), INITIAL_TEXT);
    const { notifications, logLines } = (await api()).readDiagnosticInspection();
    assert.ok(
      notifications.some((message) => message.includes(DIRTY_TEXT_TAB_NOTICE_FRAGMENT)),
      `no notification names the unsaved edits of the text tab: ${notifications.join(' | ')}; log: ${logLines.join(' | ')}`,
    );
  });

  it('saves the text editor and then the view when the dirty text buffer notice action is taken', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    await vscode.commands.executeCommand('vscode.open', uri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(3, 0), 'Z');
    assert.ok(await vscode.workspace.applyEdit(edit), 'the edit to the text buffer was not applied');
    await waitUntil(() => findTextTab(uri)?.isDirty === true, 'the text tab became dirty');
    await openWysiwyg(uri);
    await makeViewDirty(uri);
    (await api()).clearSaveEntryInspection();

    // The action of a notification cannot be selected from a test, so its handler is run through the test hook.
    assert.ok(await (await api()).saveTextEditorThenViewForTest(uri.toString()), 'the action found no open document');
    await waitUntil(
      () => findTextTab(uri)?.isDirty === false && findCustomTab(uri)?.isDirty === false,
      'both tabs stopped being dirty',
    );

    assert.strictEqual(await readFileText(uri), INITIAL_TEXT.replace('<p>first</p>', 'Z<p>first</p>'));
    assert.deepStrictEqual(
      (await api()).readSaveEntryInspection().calls.map((call) => call.kind),
      ['save'],
    );
  });

  it('fails to save without changing the file or clearing the dirty mark when the view cannot apply the candidate', async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    await openWysiwyg(uri);
    await makeViewDirty(uri);
    // The view cannot apply a candidate containing source text without closing tags because its boundaries are invalid.
    await writeExternally(uri, UNBOUNDED_TEXT);

    await vscode.commands
      .executeCommand('workbench.action.files.save')
      .then(undefined, () => undefined);
    await delay(SETTLE_MS);

    assert.strictEqual(await readFileText(uri), UNBOUNDED_TEXT);
    assert.strictEqual(findCustomTab(uri)?.isDirty, true);
  });
});
