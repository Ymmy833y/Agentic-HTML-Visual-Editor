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
// A change to a line away from the conflict, made to the file while the user is choosing.
const CONFLICT_SOURCE_EDITED_AGAIN_TEXT = CONFLICT_SOURCE_EDITED_TEXT.replace('<p>second</p>', '<p>SECOND</p>');

// Another file, opened in front of the WYSIWYG tab so that the tab is in the background when it is saved.
const OTHER_FILE_NAME = 'save-sync-other.html';

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

// A fragment of the notification shown while a save waits for a choice in a tab that is not visible.
const WAITING_NOTICE_FRAGMENT = 'is waiting for you to choose';

// A fragment of the notification offering to close the view without saving after a canceled choice.
const CLOSE_WITHOUT_SAVING_NOTICE_FRAGMENT = 'close it without saving';

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
  showConflictsForTest(documentUri: string): boolean;
  closeWithoutSavingForTest(documentUri: string): Promise<boolean>;
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
async function openWysiwyg(uri: vscode.Uri, viewColumn = vscode.ViewColumn.Active): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE, { viewColumn });

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
async function makeViewDirty(uri: vscode.Uri, beforeText?: string): Promise<void> {
  const after = { text: await readViewText(uri), selection: null };
  // Unless a case undoes the edit, the before text only has to differ from the after text. An identical pair is
  // rejected as invalid.
  const before = { text: beforeText ?? `${after.text}<!-- before -->`, selection: null };
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
  // The close command returns before tabs and groups disappear; opening sooner can reuse a group still closing.
  await vscode.commands.executeCommand('workbench.action.closeAllGroups');
  await waitUntil(
    () => vscode.window.tabGroups.all.length === 1 && openTabs().length === 0,
    'every editor group closed',
  );
}

// The ids of the conflict presentations the host sent to the view, in send order.
async function readPresentationIds(uri: vscode.Uri): Promise<number[]> {
  return (await readRecordedMessages(uri))
    .filter((recorded) => recorded.direction === 'toView' && readMessageType(recorded.message) === 'presentConflicts')
    .flatMap((recorded) => {
      const value: unknown = Object.getOwnPropertyDescriptor(recorded.message, 'presentationId')?.value;
      return typeof value === 'number' ? [value] : [];
    });
}

// A save with a conflict waits for the user's choice, so it is started without waiting for it. Its outcome is waited
// for after the choice is injected; a cancelled save rejects, and that rejection is not what these cases look at.
function startSave(command = 'workbench.action.files.save'): Promise<unknown> {
  return Promise.resolve(vscode.commands.executeCommand(command)).then(undefined, () => undefined);
}

// Waits until the view has been shown the given number of presentations and returns the id of the last one.
async function waitForPresentation(uri: vscode.Uri, count = 1): Promise<number> {
  await waitUntil(async () => (await readPresentationIds(uri)).length >= count, 'the host presented the conflicts');
  const ids = await readPresentationIds(uri);
  return ids[ids.length - 1];
}

// The extension host cannot press the buttons of the overlay, so the choice the view would send is injected.
async function chooseConflicts(
  uri: vscode.Uri,
  presentationId: number,
  choices: readonly string[] | null,
): Promise<void> {
  const dispatched = await (await api()).injectViewMessage(
    uri.toString(),
    { type: 'conflictsResolved', presentationId, choices },
  );
  assert.ok(dispatched, 'the choice was not delivered because no session is registered');
}

// Prepares a dirty view whose edit and an external edit both change the same line. The edit is recorded from the
// initial content, so undoing it returns there.
async function prepareConflict(
  sourceText = CONFLICT_SOURCE_EDITED_TEXT,
  viewColumn = vscode.ViewColumn.Active,
): Promise<vscode.Uri> {
  const uri = await resetScratch();
  await openWysiwyg(uri, viewColumn);
  await replaceViewContent(uri, CONFLICT_VIEW_EDITED_TEXT);
  await makeViewDirty(uri, INITIAL_TEXT);
  await writeExternally(uri, sourceText);
  return uri;
}

// Whether the extension has shown a notification containing the fragment since the inspection was last cleared.
async function wasNotified(fragment: string): Promise<boolean> {
  return (await api()).readDiagnosticInspection().notifications.some((message) => message.includes(fragment));
}

async function setAutoSave(value: string | undefined): Promise<void> {
  await vscode.workspace.getConfiguration('files').update('autoSave', value, vscode.ConfigurationTarget.Global);
  await waitUntil(
    () => vscode.workspace.getConfiguration('files').inspect('autoSave')?.globalValue === value,
    `auto save became ${String(value)}`,
  );
}

// Sets auto save in the HTML language section of the user settings, leaving the setting for all files as it is.
async function setHtmlAutoSave(value: string | undefined): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('files', { languageId: 'html' });
  await configuration.update('autoSave', value, vscode.ConfigurationTarget.Global, true);
  await waitUntil(
    () => vscode.workspace.getConfiguration('files', { languageId: 'html' }).inspect('autoSave')
      ?.globalLanguageValue === value,
    `auto save for HTML became ${String(value)}`,
  );
}

// The standard undo and redo return before the view has applied the entry, and VS Code does not take the next one
// until the round trip closes. Returns the full text the view was given.
async function runHistoryCommand(uri: vscode.Uri, command: 'undo' | 'redo'): Promise<string> {
  const countReleases = async (): Promise<number> => (await readRecordedMessages(uri)).filter(
    (recorded) => recorded.direction === 'toView' && readMessageType(recorded.message) === 'saveReleased',
  ).length;
  const releasesBefore = await countReleases();
  const appliedBefore = (await readReplacements(uri, 'editHistory')).length;

  await vscode.commands.executeCommand(command);
  await waitUntil(async () => await countReleases() > releasesBefore, `${command} finished its round trip`);

  const applied = await readReplacements(uri, 'editHistory');
  assert.strictEqual(applied.length, appliedBefore + 1, `${command} did not apply exactly one entry`);
  return applied[applied.length - 1];
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

  it('writes the source line and then the view line, each as written, when both sides change the same line and both are kept', async () => {
    const uri = await prepareConflict();

    const saving = startSave();
    await chooseConflicts(uri, await waitForPresentation(uri), ['both']);
    await saving;
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

describe('resolving conflicts on a save', () => {
  beforeEach(async () => {
    await resetEditors();
    await resetScratch();
    (await api()).clearDiagnosticInspection();
  });

  // A case that fails while the save waits for a choice would leave the save holding the document. Cancelling the last
  // presentation lets it go; a presentation no save waits for any longer is only logged.
  afterEach(async () => {
    const uri = fixtureUri(SCRATCH_FILE_NAME);
    const ids = await readPresentationIds(uri);
    if (ids.length > 0) {
      await (await api()).injectViewMessage(
        uri.toString(),
        { type: 'conflictsResolved', presentationId: ids[ids.length - 1], choices: null },
      );
    }
  });

  after(async () => {
    await resetEditors();
    await deleteIfPresent(fixtureUri(SCRATCH_FILE_NAME));
    await deleteIfPresent(fixtureUri(OTHER_FILE_NAME));
  });

  it('writes only the source line and clears the dirty mark when the file\'s version is kept', async () => {
    const uri = await prepareConflict();

    const saving = startSave();
    await chooseConflicts(uri, await waitForPresentation(uri), ['source']);
    await saving;
    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');

    assert.strictEqual(await readFileText(uri), CONFLICT_SOURCE_EDITED_TEXT);
    // The overlay is in front of the user, so no notice says that the save waits.
    assert.strictEqual(await wasNotified(WAITING_NOTICE_FRAGMENT), false);
  });

  it('writes only the view line when the visual editor\'s version is kept', async () => {
    const uri = await prepareConflict();

    const saving = startSave();
    await chooseConflicts(uri, await waitForPresentation(uri), ['view']);
    await saving;
    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');

    assert.strictEqual(await readFileText(uri), CONFLICT_VIEW_EDITED_TEXT);
  });

  it('leaves the file unchanged and keeps the dirty mark when the choice is cancelled', async () => {
    const uri = await prepareConflict();

    const saving = startSave();
    await chooseConflicts(uri, await waitForPresentation(uri), null);
    await saving;
    await delay(SETTLE_MS);

    assert.strictEqual(await readFileText(uri), CONFLICT_SOURCE_EDITED_TEXT);
    assert.strictEqual(findCustomTab(uri)?.isDirty, true);
  });

  it('writes the chosen version together with a change the file received away from the conflict while choosing', async () => {
    const uri = await prepareConflict();

    const saving = startSave();
    const presentationId = await waitForPresentation(uri);
    await writeExternally(uri, CONFLICT_SOURCE_EDITED_AGAIN_TEXT);
    await chooseConflicts(uri, presentationId, ['view']);
    await saving;
    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');

    assert.strictEqual(
      await readFileText(uri),
      CONFLICT_VIEW_EDITED_TEXT.replace('<p>second</p>', '<p>SECOND</p>'),
    );
  });

  it('writes the chosen version and clears the dirty mark when the save is run again while choosing', async () => {
    const uri = await prepareConflict();

    const first = startSave();
    const presentationId = await waitForPresentation(uri);
    const second = startSave();
    await chooseConflicts(uri, presentationId, ['view']);
    await Promise.all([first, second]);
    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');

    assert.strictEqual(await readFileText(uri), CONFLICT_VIEW_EDITED_TEXT);
  });

  it('leaves a WYSIWYG tab in the background where it is, tells the user, and brings it forward when asked', async () => {
    const uri = await prepareConflict();
    const otherUri = fixtureUri(OTHER_FILE_NAME);
    await writeFileText(otherUri, INITIAL_TEXT);
    await vscode.commands.executeCommand('vscode.open', otherUri);
    await waitUntil(() => findCustomTab(uri)?.isActive === false, 'the WYSIWYG tab went to the background');

    const saving = startSave('workbench.action.files.saveAll');
    const presentationId = await waitForPresentation(uri);
    // The notice names the file, so that the notices of two documents do not replace each other.
    await waitUntil(
      () => wasNotified(`${SCRATCH_FILE_NAME} ${WAITING_NOTICE_FRAGMENT}`),
      'the user was told that the save of this file waits',
    );
    const stayedBehind = findCustomTab(uri)?.isActive === false;
    assert.ok((await api()).showConflictsForTest(uri.toString()), 'the notice action found no open document');
    await waitUntil(() => findCustomTab(uri)?.isActive === true, 'the WYSIWYG tab came to the front');
    await chooseConflicts(uri, presentationId, ['view']);
    await saving;

    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');
    assert.strictEqual(stayedBehind, true);
  });

  it('offers no way to close without saving after a cancel while auto save is off', async () => {
    const uri = await prepareConflict();

    const saving = startSave();
    await chooseConflicts(uri, await waitForPresentation(uri), null);
    await saving;
    await delay(SETTLE_MS);

    assert.strictEqual(await wasNotified(CLOSE_WITHOUT_SAVING_NOTICE_FRAGMENT), false);
  });

  for (const viewColumn of [vscode.ViewColumn.One, vscode.ViewColumn.Two]) {
    it(`closes only the WYSIWYG tab without saving while a dirty text editor in another group is active, starting in group ${viewColumn}`, async () => {
      const uri = await prepareConflict(CONFLICT_SOURCE_EDITED_TEXT, viewColumn);
      await waitUntil(
        () => findCustomTab(uri)?.group.viewColumn === viewColumn && findCustomTab(uri)?.group.isActive === true,
        'the WYSIWYG tab opened in the starting group',
      );
      const saving = startSave();
      await chooseConflicts(uri, await waitForPresentation(uri), null);
      await saving;
      const otherUri = fixtureUri(OTHER_FILE_NAME);
      await writeFileText(otherUri, INITIAL_TEXT);
      // WYSIWYG can start in either group, so an absolute column does not ensure another group.
      const editor = await vscode.window.showTextDocument(otherUri, { viewColumn: vscode.ViewColumn.Beside, preview: false });
      await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), '<!-- edited -->'));
      // Focus is a precondition of this case, so activate the text editor after preparing its unsaved edit.
      await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preview: false });
      await waitUntil(
        () => findCustomTab(uri)?.group.isActive === false && findTextTab(otherUri)?.group.isActive === true,
        'the other group became active',
      );
      assert.notStrictEqual(findCustomTab(uri)?.group.viewColumn, findTextTab(otherUri)?.group.viewColumn);
      assert.deepStrictEqual([findCustomTab(uri)?.isDirty, findTextTab(otherUri)?.isDirty], [true, true]);

      assert.ok(await (await api()).closeWithoutSavingForTest(uri.toString()), 'the notice action did not close');
      await waitUntil(() => findCustomTab(uri) === undefined, 'the WYSIWYG tab closed');

      assert.deepStrictEqual(
        [findTextTab(otherUri)?.isDirty, await readFileText(uri)],
        [true, CONFLICT_SOURCE_EDITED_TEXT],
      );
    });
  }

  // Undo takes back the choice alone, to the view side merged with the rest of the same save, and redo returns to the
  // file. Neither adds lines, however often it is repeated.
  for (const [label, choice, chosen] of [
    ['the file\'s version', 'source', CONFLICT_SOURCE_EDITED_TEXT],
    ['both versions', 'both', CONFLICT_MERGED_TEXT],
  ] as const) {
    it(`undoes ${label} back to the view side and redoes it to the file, twice over, after the save`, async () => {
      const uri = await prepareConflict();
      const saving = startSave();
      await chooseConflicts(uri, await waitForPresentation(uri), [choice]);
      await saving;
      await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');
      const buffer = await vscode.workspace.openTextDocument(uri);
      await waitUntil(() => buffer.getText() === chosen, 'the buffer followed the save');

      const steps: [string, boolean | undefined][] = [];
      for (const command of ['undo', 'redo', 'undo', 'redo'] as const) {
        const text = await runHistoryCommand(uri, command);
        await waitUntil(
          () => findCustomTab(uri)?.isDirty === (command === 'undo'),
          `the dirty mark followed the ${command}`,
        );
        steps.push([text, findCustomTab(uri)?.isDirty]);
      }

      assert.deepStrictEqual(steps, [
        [CONFLICT_VIEW_EDITED_TEXT, true],
        [chosen, false],
        [CONFLICT_VIEW_EDITED_TEXT, true],
        [chosen, false],
      ]);
      assert.strictEqual(await readFileText(uri), chosen);
    });
  }

  it('keeps an external change the save took in on a distant line when the original edit is undone too', async () => {
    const uri = await prepareConflict(CONFLICT_SOURCE_EDITED_AGAIN_TEXT);
    const saving = startSave();
    await chooseConflicts(uri, await waitForPresentation(uri), ['source']);
    await saving;
    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the WYSIWYG tab stopped being dirty');
    const buffer = await vscode.workspace.openTextDocument(uri);
    await waitUntil(() => buffer.getText() === CONFLICT_SOURCE_EDITED_AGAIN_TEXT, 'the buffer followed the save');

    const undone = [await runHistoryCommand(uri, 'undo'), await runHistoryCommand(uri, 'undo')];

    assert.deepStrictEqual(undone, [
      CONFLICT_VIEW_EDITED_TEXT.replace('<p>second</p>', '<p>SECOND</p>'),
      INITIAL_TEXT.replace('<p>second</p>', '<p>SECOND</p>'),
    ]);
  });

  describe('with auto save on focus change', () => {
    beforeEach(async () => {
      await setAutoSave('onFocusChange');
    });

    // Turned off before the outer cleanup cancels and closes, so that neither starts another save.
    afterEach(async () => {
      await setAutoSave(undefined);
    });

    it('keeps the tab the user moved to in front when the save on leaving meets a conflict', async () => {
      const uri = await prepareConflict();
      const otherUri = fixtureUri(OTHER_FILE_NAME);
      await writeFileText(otherUri, INITIAL_TEXT);
      const viewColumn = findCustomTab(uri)?.group.viewColumn;

      await vscode.window.showTextDocument(otherUri, { viewColumn, preview: false });
      await waitForPresentation(uri);
      await waitUntil(() => wasNotified(WAITING_NOTICE_FRAGMENT), 'the user was told that the save waits');
      await delay(SETTLE_MS);

      assert.deepStrictEqual(
        [findCustomTab(uri)?.isActive, findTextTab(otherUri)?.isActive],
        [false, true],
      );
    });

    it('offers to close without saving after a close is canceled, and closes the tab without writing', async () => {
      const uri = await prepareConflict();

      const closing = Promise.resolve(vscode.commands.executeCommand('workbench.action.closeActiveEditor'))
        .then(undefined, () => undefined);
      await chooseConflicts(uri, await waitForPresentation(uri), null);
      await closing;
      await waitUntil(
        () => wasNotified(CLOSE_WITHOUT_SAVING_NOTICE_FRAGMENT),
        'the user was offered to close without saving',
      );
      const openAfterCancel = findCustomTab(uri) !== undefined;
      assert.ok(await (await api()).closeWithoutSavingForTest(uri.toString()), 'the notice action did not close');
      await waitUntil(() => findCustomTab(uri) === undefined, 'the WYSIWYG tab closed');

      assert.deepStrictEqual([openAfterCancel, await readFileText(uri)], [true, CONFLICT_SOURCE_EDITED_TEXT]);
    });
  });

  // In the desktop app the offer follows this setting whatever the OS, since the extension cannot tell the OS apart.
  describe('with auto save on window change', () => {
    beforeEach(async () => {
      await setAutoSave('onWindowChange');
    });

    afterEach(async () => {
      await setAutoSave(undefined);
    });

    it('offers to close without saving after a cancel', async () => {
      const uri = await prepareConflict();

      const saving = startSave();
      await chooseConflicts(uri, await waitForPresentation(uri), null);
      await saving;

      await waitUntil(
        () => wasNotified(`${SCRATCH_FILE_NAME} was not saved`),
        'the user was offered to close this file without saving',
      );
    });
  });

  // VS Code reads the setting for the file's language when it closes the editor, so the offer has to as well.
  describe('with auto save on focus change set for HTML only', () => {
    beforeEach(async () => {
      await setHtmlAutoSave('onFocusChange');
    });

    afterEach(async () => {
      await setHtmlAutoSave(undefined);
    });

    it('offers to close without saving after a cancel', async () => {
      const uri = await prepareConflict();

      const saving = startSave();
      await chooseConflicts(uri, await waitForPresentation(uri), null);
      await saving;

      await waitUntil(
        () => wasNotified(CLOSE_WITHOUT_SAVING_NOTICE_FRAGMENT),
        'the user was offered to close without saving',
      );
    });
  });
});
