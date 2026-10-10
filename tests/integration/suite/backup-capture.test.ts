import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { customTabMatchesSource } from '../helpers/editor-tabs';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

// Backups and saves rewrite the disk, so the fixtures in the repository are not used.
const SCRATCH_FILE_NAME = 'backup-capture-scratch.html';

const INITIAL_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>ab</p>\n</body>\n</html>\n';
const EDITED_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>abXY</p>\n</body>\n</html>\n';
const EDITED_AGAIN_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>abXYZ</p>\n</body>\n</html>\n';
const STALE_RESPONSE_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>stale</p>\n</body>\n</html>\n';

interface RecordedMessage {
  readonly direction: 'fromView' | 'toView';
  readonly message: unknown;
}

interface BackupInspection {
  readonly trackedBackupUri: string | undefined;
  readonly protectionStatus: string | undefined;
  readonly protectionBackupUri: string | undefined;
}

interface StoredBackup {
  readonly version: number;
  readonly documentUri: string;
  readonly fullText: string;
  readonly mergeBase: string;
}

interface ExtensionApi {
  readWebviewInspection(documentUri: string): { readonly messages: readonly RecordedMessage[] } | undefined;
  readDiagnosticInspection(): { readonly notifications: readonly string[]; readonly logLines: readonly string[] };
  clearDiagnosticInspection(): void;
  injectViewMessage(documentUri: string, message: unknown): Promise<boolean>;
  replaceViewContentForTest(documentUri: string, text: string): Promise<boolean>;
  readBackupInspection(documentUri: string): BackupInspection | undefined;
  requestBackupForTest(
    documentUri: string,
    destinationUri: string,
  ): Promise<{ readonly id: string; delete(): void } | undefined>;
  controlBackupViewForTest(documentUri: string, operation: string, text?: string): Promise<boolean>;
}

function findExtension(): vscode.Extension<ExtensionApi> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} is not loaded in VS Code`);
  return extension;
}

async function api(): Promise<ExtensionApi> {
  return findExtension().activate();
}

function scratchUri(): vscode.Uri {
  return vscode.Uri.joinPath(findExtension().extensionUri, 'tests', 'integration', 'fixtures', SCRATCH_FILE_NAME);
}

// A location standing in for the destination VS Code indicates in a backup request. The extension creates backups in a
// folder next to it.
function destinationUri(): vscode.Uri {
  return vscode.Uri.file(path.join(os.tmpdir(), 'ahve-backup-capture-test', 'destination'));
}

function findCustomTab(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((tab) => customTabMatchesSource(tab, uri));
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

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function resetScratch(text: string): Promise<vscode.Uri> {
  const uri = scratchUri();
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
  const document = await vscode.workspace.openTextDocument(uri);
  await waitUntil(() => document.getText() === text, 'the buffer followed the initial content');
  return uri;
}

async function readRecordedMessages(uri: vscode.Uri): Promise<readonly RecordedMessage[]> {
  return (await api()).readWebviewInspection(uri.toString())?.messages ?? [];
}

function readField(message: unknown, field: string): unknown {
  return typeof message === 'object' && message !== null ? Reflect.get(message, field) : undefined;
}

async function openWysiwyg(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
  await waitUntil(async () => (await readRecordedMessages(uri)).length >= 2, 'the view exchanged its startup messages');
}

async function inject(uri: vscode.Uri, message: unknown): Promise<void> {
  assert.ok(await (await api()).injectViewMessage(uri.toString(), message), 'no session is registered');
}

let injectedUnits = 0;

/**
 * Injects the signals a real view sends for one edit and the unsaved content after the debounce, in the same order.
 *
 * The extension host cannot send key input to the view. The view's tree is also set to the same full text so the output
 * and the check on save match.
 */
async function injectEdit(uri: vscode.Uri, beforeText: string, afterText: string): Promise<void> {
  assert.ok(await (await api()).replaceViewContentForTest(uri.toString(), afterText), 'the view did not accept the content');
  injectedUnits += 1;
  const unitId = `backup-capture-${injectedUnits}`;
  const before = { text: beforeText, selection: null };
  const after = { text: afterText, selection: null };
  await inject(uri, { type: 'viewEdited' });
  await inject(uri, { type: 'editUnitStart', unitId, start: before });
  await inject(uri, { type: 'editTransaction', transaction: { unitId, before, after } });
  await inject(uri, { type: 'unsavedContent', text: afterText });
  await waitUntil(() => findCustomTab(uri)?.isDirty === true, 'the WYSIWYG tab became dirty');
}

/**
 * Reads the latest generation with a completion marker from a backup directory, per the storage format and independently
 * of the extension's reader.
 *
 * @param backupUri The backup directory URI.
 */
async function readLatestGeneration(backupUri: vscode.Uri): Promise<StoredBackup | undefined> {
  if (!(await exists(backupUri))) {
    return undefined;
  }
  const names = new Set((await vscode.workspace.fs.readDirectory(backupUri)).map(([name]) => name));
  const latest = [...names]
    .map((name) => /^(\d+)\.json$/.exec(name))
    .flatMap((match) => (match === null ? [] : [Number(match[1])]))
    .filter((generation) => names.has(`${generation}.done`))
    .sort((left, right) => right - left)[0];
  if (latest === undefined) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(await readFileText(vscode.Uri.joinPath(backupUri, `${latest}.json`)));
  // No format validation. The comparison checks every field with deepStrictEqual, so a different shape fails there.
  return parsed as StoredBackup;
}

async function readInspection(uri: vscode.Uri): Promise<BackupInspection | undefined> {
  return (await api()).readBackupInspection(uri.toString());
}

async function control(uri: vscode.Uri, operation: string, text?: string): Promise<void> {
  assert.ok(await (await api()).controlBackupViewForTest(uri.toString(), operation, text), `the view refused ${operation}`);
}

async function readOutputRequestIds(uri: vscode.Uri): Promise<string[]> {
  return (await readRecordedMessages(uri))
    .filter((recorded) => recorded.direction === 'toView' && readField(recorded.message, 'type') === 'requestBodyOutput')
    .map((recorded) => String(readField(recorded.message, 'requestId')));
}

async function closeEverything(): Promise<void> {
  // No dialog appears during tests, so dirty tabs close without saving.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

describe('creating and updating hot exit backups', () => {
  beforeEach(async () => {
    await closeEverything();
    await resetScratch(INITIAL_TEXT);
    (await api()).clearDiagnosticInspection();
  });

  after(async () => {
    await closeEverything();
    await vscode.workspace.fs.delete(scratchUri());
    await vscode.workspace.fs.delete(vscode.Uri.file(path.dirname(destinationUri().fsPath)), { recursive: true })
      .then(undefined, () => undefined);
  });

  it('drives the production backup entry point and verifies the complete generation\'s target URI, full text, and merge base, and the delete handle', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);
    await injectEdit(uri, INITIAL_TEXT, EDITED_TEXT);

    const backup = await (await api()).requestBackupForTest(uri.toString(), destinationUri().toString());
    assert.ok(backup, 'the backup entry point returned nothing');
    const backupUri = vscode.Uri.parse(backup.id);

    assert.strictEqual(path.basename(path.dirname(backupUri.fsPath)), 'ahve-backups');
    assert.deepStrictEqual(await readLatestGeneration(backupUri), {
      version: 1,
      documentUri: uri.toString(),
      fullText: EDITED_TEXT,
      mergeBase: INITIAL_TEXT,
    });

    backup.delete();
    await waitUntil(async () => !(await exists(backupUri)), 'the deleted backup disappeared');
    assert.notStrictEqual((await readInspection(uri))?.trackedBackupUri, backup.id);
  });

  it('has VS Code call the automatic backup after a real edit, and the completed identifier becomes the tracked backup', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);

    await injectEdit(uri, INITIAL_TEXT, EDITED_TEXT);

    await waitUntil(async () => (await readInspection(uri))?.trackedBackupUri !== undefined, 'VS Code requested a backup');
    const tracked = (await readInspection(uri))?.trackedBackupUri ?? '';
    assert.strictEqual((await readLatestGeneration(vscode.Uri.parse(tracked)))?.fullText, EDITED_TEXT);
  });

  it('reflects an update within the same edit unit after the first backup in the latest generation without an additional change event', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);
    await injectEdit(uri, INITIAL_TEXT, EDITED_TEXT);
    await waitUntil(async () => (await readInspection(uri))?.trackedBackupUri !== undefined, 'VS Code requested a backup');

    // Edit events fire once per edit unit, so the rest of the same unit arrives only as unsaved content.
    await inject(uri, { type: 'unsavedContent', text: EDITED_AGAIN_TEXT });

    await waitUntil(async () => {
      const tracked = (await readInspection(uri))?.trackedBackupUri;
      return tracked !== undefined
        && (await readLatestGeneration(vscode.Uri.parse(tracked)))?.fullText === EDITED_AGAIN_TEXT;
    }, 'the tracked backup caught up with the later content');
  });

  it('uses the sync base moved by a save as the full text and merge base of a backup created afterwards', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);
    await injectEdit(uri, INITIAL_TEXT, EDITED_TEXT);
    await waitUntil(async () => (await readInspection(uri))?.trackedBackupUri !== undefined, 'VS Code requested a backup');

    await vscode.commands.executeCommand('workbench.action.files.save');
    await waitUntil(async () => await readFileText(uri) === EDITED_TEXT, 'the edit was saved');

    // A successful save discards every backup the document adopted, so no backup from before the save remains.
    // A backup created after the save shows that the sync base moved to the saved full text.
    const backup = await (await api()).requestBackupForTest(uri.toString(), destinationUri().toString());
    assert.ok(backup, 'the backup entry point returned nothing');
    await waitUntil(async () => {
      const stored = await readLatestGeneration(vscode.Uri.parse(backup.id));
      return stored?.fullText === EDITED_TEXT && stored.mergeBase === EDITED_TEXT;
    }, 'the backup took the saved text as its common ancestor');
    backup.delete();
  });

  it('prepares an unsent edit, closes the real panel, and records whether it reached the host after pagehide and the completed backup', async () => {
    const uri = scratchUri();
    await openWysiwyg(uri);
    // Advance the first edit through output in the real view so a tracked backup gets created.
    await control(uri, 'prepareUnsentEdit', 'first');
    await waitUntil(async () => (await readInspection(uri))?.trackedBackupUri !== undefined, 'VS Code requested a backup');
    const tracked = vscode.Uri.parse((await readInspection(uri))?.trackedBackupUri ?? '');
    await waitUntil(
      async () => (await readLatestGeneration(tracked))?.fullText.includes('first') === true,
      'the first edit reached the backup',
    );

    await control(uri, 'prepareUnsentEdit', 'second');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await waitUntil(() => findCustomTab(uri) === undefined, 'the tab closed');
    await delay(1000);

    const arrived = (await readRecordedMessages(uri)).some((recorded) => recorded.direction === 'fromView'
      && readField(recorded.message, 'type') === 'unsavedContent'
      && String(readField(recorded.message, 'text')).includes('firstsecond'));
    const stored = await readLatestGeneration(tracked);
    // Whether it arrives depends on the send timing at close. Record the result and verify only that the remaining
    // backup is intact.
    console.log(`pagehide flush reached the host: ${String(arrived)}; backup: ${stored === undefined ? 'none' : JSON.stringify(stored.fullText)}`);
    if (stored !== undefined) {
      assert.ok(stored.fullText.includes('first'), 'the remaining backup lost the edit written before closing');
    }
  });
});

describe('save fallback when unresponsive', () => {
  beforeEach(async () => {
    await closeEverything();
    (await api()).clearDiagnosticInspection();
  });

  after(async () => {
    await closeEverything();
    await vscode.workspace.fs.delete(scratchUri()).then(undefined, () => undefined);
  });

  it('saves the original URI with the view\'s output responses stopped, and the retained copy, line ending, sync base, and save point match', async () => {
    const uri = await resetScratch(INITIAL_TEXT.replace(/\n/g, '\r\n'));
    await openWysiwyg(uri);
    await injectEdit(uri, INITIAL_TEXT, EDITED_TEXT);
    await control(uri, 'suspendOutputResponses');
    try {
      await vscode.commands.executeCommand('workbench.action.files.save');

      await waitUntil(async () => await readFileText(uri) === EDITED_TEXT.replace(/\n/g, '\r\n'), 'the retained copy was written');
      await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the save point moved to the written content');
      // If the sync base advanced to the written full text, a text buffer change with the same content is not treated as
      // an external change.
      await delay(1000);
      assert.ok(
        !(await readRecordedMessages(uri)).some((recorded) => readField(recorded.message, 'kind') === 'externalChange'),
        'the write was treated as an external change',
      );
    } finally {
      await control(uri, 'resumeOutputResponses');
    }
  });

  it('makes the old request unresponsive on a reload while waiting for the output response, and does not let a stale response settle another save', async () => {
    const uri = await resetScratch(INITIAL_TEXT);
    await openWysiwyg(uri);
    await injectEdit(uri, INITIAL_TEXT, EDITED_TEXT);
    await control(uri, 'suspendOutputResponses');
    try {
      void Promise.resolve(vscode.commands.executeCommand('workbench.action.files.save')).then(undefined, () => undefined);
      await waitUntil(async () => (await readOutputRequestIds(uri)).length === 1, 'the first output request was sent');
      const [staleRequestId] = await readOutputRequestIds(uri);

      // The view ready message settles waits addressed to the old view through the same path as view recreation.
      await inject(uri, { type: 'viewReady' });
      await waitUntil(async () => await readFileText(uri) === EDITED_TEXT, 'the first save fell back to the retained copy');
      await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the first save completed');

      await injectEdit(uri, EDITED_TEXT, EDITED_AGAIN_TEXT);
      void Promise.resolve(vscode.commands.executeCommand('workbench.action.files.save')).then(undefined, () => undefined);
      await waitUntil(async () => (await readOutputRequestIds(uri)).length === 2, 'the second output request was sent');
      const [, freshRequestId] = await readOutputRequestIds(uri);
      await inject(uri, { type: 'bodyOutputResponse', requestId: staleRequestId, text: STALE_RESPONSE_TEXT });

      await waitUntil(async () => await readFileText(uri) === EDITED_AGAIN_TEXT, 'the second save fell back to its own retained copy');
      assert.notStrictEqual(freshRequestId, staleRequestId);
    } finally {
      await control(uri, 'resumeOutputResponses');
    }
  });
});
