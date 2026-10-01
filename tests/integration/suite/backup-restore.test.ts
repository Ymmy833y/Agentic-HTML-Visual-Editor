import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { customTabMatchesSource } from '../helpers/editor-tabs';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;
const CLOSE_REVERT_SETTLE_MS = 3000;
const CLOSE_ATTEMPTS = 3;

// The cause logged when the Revert on close did not run because the text side has unsaved edits.
const REVERT_SKIPPED_CAUSE = 'Skipped reverting because the text buffer has unsaved edits';

const INITIAL_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>ab</p>\n</body>\n</html>\n';
const EDITED_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>abXY</p>\n</body>\n</html>\n';
const EDITED_AGAIN_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>abXYZ</p>\n</body>\n</html>\n';

interface RecordedMessage {
  readonly direction: 'fromView' | 'toView';
  readonly message: unknown;
}

interface BackupInspection {
  readonly trackedBackupUri: string | undefined;
  readonly protectionStatus: string | undefined;
  readonly protectionBackupUri: string | undefined;
}

interface RestoreInspection {
  readonly progress: string;
  readonly adoptedBackupUris: readonly string[];
}

interface ExtensionApi {
  readWebviewInspection(documentUri: string): { readonly messages: readonly RecordedMessage[] } | undefined;
  readDiagnosticInspection(): { readonly notifications: readonly string[]; readonly logLines: readonly string[] };
  clearDiagnosticInspection(): void;
  injectViewMessage(documentUri: string, message: unknown): Promise<boolean>;
  replaceViewContentForTest(documentUri: string, text: string): Promise<boolean>;
  runHistoryTransitionForTest(documentUri: string, direction: 'undo' | 'redo'): Promise<boolean | undefined>;
  readBackupInspection(documentUri: string): BackupInspection | undefined;
  readRestoreInspection(documentUri: string): RestoreInspection | undefined;
  requestBackupForTest(documentUri: string, destinationUri: string): Promise<{ readonly id: string }>;
}

function findExtension(): vscode.Extension<ExtensionApi> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} is not loaded in VS Code`);
  return extension;
}

async function api(): Promise<ExtensionApi> {
  return findExtension().activate();
}

// A source file closed with a protection backup left behind is restored when reopened, so each case uses a
// different source file.
const scratchNames = new Set<string>();

function scratchUri(caseName: string): vscode.Uri {
  const name = `backup-restore-${caseName}.html`;
  scratchNames.add(name);
  return vscode.Uri.joinPath(findExtension().extensionUri, 'tests', 'integration', 'fixtures', name);
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

/** Writes to disk and waits for a still-open buffer to catch up with the content. */
async function resetScratch(caseName: string, text: string = INITIAL_TEXT): Promise<vscode.Uri> {
  const uri = scratchUri(caseName);
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

/** Returns the full texts sent to the view as history applications, in send order. */
async function readHistoryApplications(uri: vscode.Uri): Promise<readonly unknown[]> {
  return (await readRecordedMessages(uri))
    .filter((recorded) => recorded.direction === 'toView'
      && readField(recorded.message, 'type') === 'replaceDocument'
      && readField(recorded.message, 'kind') === 'editHistory')
    .map((recorded) => readField(recorded.message, 'text'));
}

/** Returns the initialize messages sent from the host to the view, in send order. */
async function readInitializations(uri: vscode.Uri): Promise<readonly unknown[]> {
  return (await readRecordedMessages(uri))
    .filter((recorded) => recorded.direction === 'toView' && readField(recorded.message, 'type') === 'initialize')
    .map((recorded) => recorded.message);
}

async function openWysiwyg(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
  await waitUntil(async () => (await readRecordedMessages(uri)).length >= 2, 'the view exchanged its startup messages');
}

async function closeAllEditors(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitUntil(() => findCustomTab(uri) === undefined, 'the WYSIWYG tab closed');
}

async function inject(uri: vscode.Uri, message: unknown): Promise<void> {
  assert.ok(await (await api()).injectViewMessage(uri.toString(), message), 'no session is registered');
}

let injectedUnits = 0;

/**
 * Injects the signals and unsaved content a real view sends for one edit, and makes the view tree the same full
 * text.
 */
async function injectEdit(uri: vscode.Uri, beforeText: string, afterText: string): Promise<void> {
  assert.ok(await (await api()).replaceViewContentForTest(uri.toString(), afterText), 'the view did not accept the content');
  injectedUnits += 1;
  const unitId = `backup-restore-${injectedUnits}`;
  const before = { text: beforeText, selection: null };
  const after = { text: afterText, selection: null };
  await inject(uri, { type: 'viewEdited' });
  await inject(uri, { type: 'editUnitStart', unitId, start: before });
  await inject(uri, { type: 'editTransaction', transaction: { unitId, before, after } });
  await inject(uri, { type: 'unsavedContent', text: afterText });
  await waitUntil(() => findCustomTab(uri)?.isDirty === true, 'the WYSIWYG tab became dirty');
}

async function readBackupInspection(uri: vscode.Uri): Promise<BackupInspection | undefined> {
  return (await api()).readBackupInspection(uri.toString());
}

async function readRestoreInspection(uri: vscode.Uri): Promise<RestoreInspection | undefined> {
  return (await api()).readRestoreInspection(uri.toString());
}

/**
 * Closes a source file while leaving a protection backup behind.
 *
 * Actually enters protection through a missing endpoint. Don't Save when closing a tab requests a Revert, so
 * closing as is would discard the adopted backups. The text side is made dirty so that the Revert fails at source
 * resolution, and the tab is closed along the path that keeps the backup.
 *
 * @param uri The source URI.
 * @returns The location of the protection backup left behind.
 */
async function closeWithProtectionBackup(uri: vscode.Uri): Promise<vscode.Uri> {
  await openWysiwyg(uri);
  await injectEdit(uri, INITIAL_TEXT, EDITED_TEXT);
  await inject(uri, { type: 'editUnitStart', unitId: 'never-settled', start: { text: EDITED_TEXT, selection: null } });
  await (await api()).runHistoryTransitionForTest(uri.toString(), 'undo');
  await waitUntil(
    async () => (await readBackupInspection(uri))?.protectionStatus === 'verified',
    'the protection backup was verified',
  );
  const backupUri = vscode.Uri.parse((await readBackupInspection(uri))?.protectionBackupUri ?? '');
  const skipped = await countSkippedReverts();
  await makeTextBufferDirty(uri);
  await closeAllEditors(uri);
  await settleSkippedRevert(skipped);
  // Return the text side to clean so the reopen can read the source, then clean up the tabs too.
  await revertDirtyTextEditors();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  return backupUri;
}

/**
 * Repeats closing with a protection backup left behind until the backup survives.
 *
 * If the view disappears before the Revert on close reaches source resolution, the abandonment is treated as a
 * Don't Save completion and the backup is discarded. The order along the closing path is decided by VS Code, so
 * the setup is recreated until the backup survives.
 *
 * @param uri The source URI.
 * @returns The location of the protection backup left behind.
 */
async function leaveProtectionBackup(uri: vscode.Uri): Promise<vscode.Uri> {
  for (let attempt = 1; ; attempt += 1) {
    const backupUri = await closeWithProtectionBackup(uri);
    if (await exists(backupUri)) {
      return backupUri;
    }
    assert.ok(attempt < CLOSE_ATTEMPTS, 'the protection backup did not survive closing the tab');
  }
}

/**
 * Waits for the restore to settle. If it does not settle, fails with the actual progress and the adopted backups.
 */
async function waitForRestoreProgress(uri: vscode.Uri, progress: string): Promise<void> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  for (;;) {
    const inspection = await readRestoreInspection(uri);
    if (inspection?.progress === progress) {
      return;
    }
    assert.ok(
      Date.now() < deadline,
      `Timed out before restore reached ${progress}: `
        + `progress=${inspection?.progress ?? 'none'} adopted=[${inspection?.adoptedBackupUris.join(', ') ?? ''}]`,
    );
    await delay(POLLING_INTERVAL_MS);
  }
}

/** The number of Reverts that did not run because unsaved edits on the text side prevented source resolution. */
async function countSkippedReverts(): Promise<number> {
  return (await api()).readDiagnosticInspection()
    .logLines.filter((line) => line.includes(REVERT_SKIPPED_CAUSE)).length;
}

/**
 * Waits until one more Revert fails to resolve the source.
 *
 * Settles it before returning the text side to clean. If resolution happened after the text side became clean,
 * the Revert would proceed, be abandoned when the view disappears, and the backup would be discarded. In case the
 * Revert request never arrives, stops waiting at the limit.
 *
 * @param before The count before starting to wait.
 */
async function settleSkippedRevert(before: number): Promise<void> {
  const deadline = Date.now() + CLOSE_REVERT_SETTLE_MS;
  while (Date.now() < deadline) {
    if (await countSkippedReverts() > before) {
      return;
    }
    await delay(POLLING_INTERVAL_MS);
  }
}

/** Makes the text-side buffer dirty. */
async function makeTextBufferDirty(uri: vscode.Uri): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(0, 0), '<!-- text side -->\n');
  assert.ok(await vscode.workspace.applyEdit(edit), 'the text buffer did not accept the edit');
  await waitUntil(() => document.isDirty, 'the text buffer became dirty');
}

/** Reverts dirty text editors. */
async function revertDirtyTextEditors(): Promise<void> {
  for (const document of vscode.workspace.textDocuments) {
    if (!document.isDirty) {
      continue;
    }
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
}

describe('restore from backup', () => {
  beforeEach(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    (await api()).clearDiagnosticInspection();
  });

  after(async () => {
    await revertDirtyTextEditors();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const name of scratchNames) {
      const uri = vscode.Uri.joinPath(findExtension().extensionUri, 'tests', 'integration', 'fixtures', name);
      await vscode.workspace.fs.delete(uri).then(undefined, () => undefined);
    }
  });

  it('displays the restored full text and marks the tab dirty without changing the file when reopening a source file closed with a protection backup', async () => {
    const uri = await resetScratch('reopen');
    await leaveProtectionBackup(uri);

    await openWysiwyg(uri);

    await waitForRestoreProgress(uri, 'restored');
    // The dirty mark appears after the restore entry registration reaches VS Code, so not at the same time as the
    // progress settles.
    await waitUntil(() => findCustomTab(uri)?.isDirty === true, 'the dirty mark appeared');
    const restoring = (await readInitializations(uri)).filter((message) => readField(message, 'restoring') === true);
    assert.deepStrictEqual(restoring.map((message) => readField(message, 'text')), [EDITED_TEXT]);
    assert.strictEqual(await readFileText(uri), INITIAL_TEXT);
  });

  it('follows the restoring display with a dirty state, delivering a dirty state of true, for a document opened by a restore with a difference', async () => {
    const uri = await resetScratch('restore-dirty-state');
    await leaveProtectionBackup(uri);

    await openWysiwyg(uri);

    await waitForRestoreProgress(uri, 'restored');
    await waitUntil(() => findCustomTab(uri)?.isDirty === true, 'the dirty mark appeared');
    // The tab's dirty mark is already set when it opens, so no tab change notice follows. Only the
    // send right after the initialize message delivers the value.
    const types = (await readRecordedMessages(uri))
      .filter((recorded) => recorded.direction === 'toView')
      .map((recorded) => readField(recorded.message, 'type'));
    const restoringIndex = (await readRecordedMessages(uri))
      .filter((recorded) => recorded.direction === 'toView')
      .findIndex((recorded) => readField(recorded.message, 'restoring') === true);
    assert.strictEqual(types[restoringIndex + 1], 'dirtyState');
    await waitUntil(
      async () => (await readRecordedMessages(uri)).some((recorded) => recorded.direction === 'toView'
        && readField(recorded.message, 'type') === 'dirtyState'
        && readField(recorded.message, 'dirty') === true),
      'a dirty state of true reaches the view',
    );
  });

  it('deletes the protection backup without marking the tab dirty when the backup content is already saved to the source', async () => {
    const uri = await resetScratch('no-diff');
    const backupUri = await leaveProtectionBackup(uri);
    // Put the source in a state where the same content as the backup has been saved.
    await resetScratch('no-diff', EDITED_TEXT);

    await openWysiwyg(uri);

    await waitForRestoreProgress(uri, 'normal');
    await waitUntil(async () => !(await exists(backupUri)), 'the protection backup was deleted');
    assert.strictEqual(findCustomTab(uri)?.isDirty, false);
  });

  it('writes the merge result on a save after the restore, deletes the protection backup, and does not restore on reopen', async () => {
    const uri = await resetScratch('save');
    const backupUri = await leaveProtectionBackup(uri);
    await openWysiwyg(uri);
    await waitForRestoreProgress(uri, 'restored');

    await vscode.commands.executeCommand('workbench.action.files.save');

    await waitUntil(async () => await readFileText(uri) === EDITED_TEXT, 'the merged full text was written');
    await waitUntil(async () => !(await exists(backupUri)), 'the protection backup was deleted');
    await closeAllEditors(uri);
    await openWysiwyg(uri);
    await waitForRestoreProgress(uri, 'normal');
    assert.strictEqual(findCustomTab(uri)?.isDirty, false);
  });

  it('deletes the protection backup when a restored tab is closed with Don\'t Save', async () => {
    const uri = await resetScratch('dont-save');
    const backupUri = await leaveProtectionBackup(uri);
    await openWysiwyg(uri);
    await waitForRestoreProgress(uri, 'restored');

    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');

    await waitUntil(async () => !(await exists(backupUri)), 'the protection backup was deleted');
    assert.strictEqual(await readFileText(uri), INITIAL_TEXT);
  });

  it('keeps the backup when closing a tab whose Revert failed because the text side is dirty', async () => {
    const uri = await resetScratch('revert-failed');
    await leaveProtectionBackup(uri);
    await openWysiwyg(uri);
    await waitForRestoreProgress(uri, 'restored');
    await makeTextBufferDirty(uri);

    await vscode.commands.executeCommand('workbench.action.files.revert')
      .then(undefined, () => undefined);

    // The failed Revert is handed to protection, and the backup remains as a new protection backup.
    await waitUntil(
      async () => (await readBackupInspection(uri))?.protectionStatus === 'verified',
      'the content was preserved in a protection backup',
    );
    const remaining = vscode.Uri.parse((await readBackupInspection(uri))?.protectionBackupUri ?? '');
    // Don't Save on close also fails because of the unsaved edits on the text side, so the backup remains. The
    // file is not rewritten either.
    const skipped = await countSkippedReverts();
    await closeAllEditors(uri);
    await settleSkippedRevert(skipped);
    assert.ok(await exists(remaining), 'no backup remains for the failed revert');
    assert.strictEqual(await readFileText(uri), INITIAL_TEXT);
  });

  it('clears the dirty state and deletes the protection backup when undoing the restore entry returns to the save point', async () => {
    const uri = await resetScratch('undo-restore');
    const backupUri = await leaveProtectionBackup(uri);
    await openWysiwyg(uri);
    await waitForRestoreProgress(uri, 'restored');

    // VS Code decides the dirty mark by whether the current point matches the save point, so the undo moves
    // VS Code's history along with it.
    await vscode.commands.executeCommand('ahve.undo');

    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the dirty mark disappeared');
    await waitUntil(async () => !(await exists(backupUri)), 'the protection backup was deleted');
  });

  it('keeps the dirty state and the restored full text when undoing a new edit made after the restore', async () => {
    const uri = await resetScratch('undo-new-edit');
    await leaveProtectionBackup(uri);
    await openWysiwyg(uri);
    await waitForRestoreProgress(uri, 'restored');
    await injectEdit(uri, EDITED_TEXT, EDITED_AGAIN_TEXT);

    // As long as the restore entry remains, the save point is not reached, so the dirty mark stays even when
    // undoing along with VS Code's history.
    await vscode.commands.executeCommand('ahve.undo');

    await waitUntil(
      async () => (await readHistoryApplications(uri)).length >= 1,
      'the history transition reached the view',
    );
    assert.strictEqual(findCustomTab(uri)?.isDirty, true);
    assert.deepStrictEqual(await readHistoryApplications(uri), [EDITED_TEXT]);
  });

  it('shows the failure without restoring and keeps the protection backup when the text side is dirty on open', async () => {
    const uri = await resetScratch('dirty-source');
    const backupUri = await leaveProtectionBackup(uri);
    await makeTextBufferDirty(uri);

    await openWysiwyg(uri);

    await waitForRestoreProgress(uri, 'failed');
    const failures = (await readRecordedMessages(uri))
      .filter((recorded) => recorded.direction === 'toView' && readField(recorded.message, 'type') === 'restoreFailed');
    assert.deepStrictEqual(failures.map((recorded) => readField(recorded.message, 'cause')), ['sourceUnavailable']);
    assert.ok(await exists(backupUri), 'the protection backup was deleted');
  });

  it('rejects a backup request while the restore has failed and creates no new backup', async () => {
    const uri = await resetScratch('reject-backup');
    await leaveProtectionBackup(uri);
    await makeTextBufferDirty(uri);
    await openWysiwyg(uri);
    await waitForRestoreProgress(uri, 'failed');

    const destination = vscode.Uri.joinPath(findExtension().extensionUri, 'tests', 'integration', 'fixtures', 'backup-restore-rejected');
    const requested = await api();
    await assert.rejects(() => requested.requestBackupForTest(uri.toString(), destination.toString()));

    assert.strictEqual((await readBackupInspection(uri))?.trackedBackupUri, undefined);
  });

  it('completes the restore when retry is chosen after making the text side clean', async () => {
    const uri = await resetScratch('retry');
    await leaveProtectionBackup(uri);
    await makeTextBufferDirty(uri);
    await openWysiwyg(uri);
    await waitForRestoreProgress(uri, 'failed');

    await revertDirtyTextEditors();
    await inject(uri, { type: 'restoreActionSelected', action: 'retry' });

    await waitForRestoreProgress(uri, 'restored');
    await waitUntil(() => findCustomTab(uri)?.isDirty === true, 'the dirty mark appeared');
  });

  it('reopens with the source and deletes the protection backup when discard is chosen while failed', async () => {
    const uri = await resetScratch('discard');
    const backupUri = await leaveProtectionBackup(uri);
    await makeTextBufferDirty(uri);
    await openWysiwyg(uri);
    await waitForRestoreProgress(uri, 'failed');

    await inject(uri, { type: 'restoreActionSelected', action: 'discard' });

    await waitForRestoreProgress(uri, 'normal');
    await waitUntil(async () => !(await exists(backupUri)), 'the protection backup was deleted');
  });

  it('redisplays the retained copy on view recreation after the restore without adding another restore entry', async () => {
    const uri = await resetScratch('regenerate');
    await leaveProtectionBackup(uri);
    await openWysiwyg(uri);
    await waitForRestoreProgress(uri, 'restored');

    // When the view is recreated, the view ready message arrives again.
    await inject(uri, { type: 'viewReady' });

    await waitUntil(async () => (await readInitializations(uri)).length >= 2, 'the view was initialized again');
    const initializations = await readInitializations(uri);
    const last = initializations[initializations.length - 1];
    assert.deepStrictEqual([readField(last, 'text'), readField(last, 'restoring')], [EDITED_TEXT, undefined]);
    // If the restore entry were registered twice, the save point would not be reached until two undos.
    await vscode.commands.executeCommand('ahve.undo');
    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'the dirty mark disappeared');
    assert.strictEqual(await (await api()).runHistoryTransitionForTest(uri.toString(), 'undo'), false);
  });
});
