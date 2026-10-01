import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { customTabMatchesSource } from '../helpers/editor-tabs';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

// Recovery rewrites the disk, so the fixtures in the repository are not used.
// A source file closed with a protection backup left behind is restored when reopened, so each case uses a
// different source file.
const scratchNames = new Set<string>();

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

interface ExtensionApi {
  readWebviewInspection(documentUri: string): { readonly messages: readonly RecordedMessage[] } | undefined;
  readDiagnosticInspection(): { readonly notifications: readonly string[]; readonly logLines: readonly string[] };
  clearDiagnosticInspection(): void;
  injectViewMessage(documentUri: string, message: unknown): Promise<boolean>;
  replaceViewContentForTest(documentUri: string, text: string): Promise<boolean>;
  runHistoryTransitionForTest(documentUri: string, direction: 'undo' | 'redo'): Promise<boolean | undefined>;
  readBackupInspection(documentUri: string): BackupInspection | undefined;
  readRestoreInspection(documentUri: string): { readonly progress: string } | undefined;
}

function findExtension(): vscode.Extension<ExtensionApi> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} is not loaded in VS Code`);
  return extension;
}

async function api(): Promise<ExtensionApi> {
  return findExtension().activate();
}

function scratchUri(caseName: string): vscode.Uri {
  const name = `backup-recovery-${caseName}.html`;
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

async function resetScratch(caseName: string): Promise<vscode.Uri> {
  const uri = scratchUri(caseName);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(INITIAL_TEXT));
  const document = await vscode.workspace.openTextDocument(uri);
  await waitUntil(() => document.getText() === INITIAL_TEXT, 'the buffer followed the initial content');
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

/** Injects the signals and unsaved content a real view sends for one edit, and sets the view's tree to the same full text. */
async function injectEdit(uri: vscode.Uri, beforeText: string, afterText: string): Promise<void> {
  assert.ok(await (await api()).replaceViewContentForTest(uri.toString(), afterText), 'the view did not accept the content');
  injectedUnits += 1;
  const unitId = `backup-recovery-${injectedUnits}`;
  const before = { text: beforeText, selection: null };
  const after = { text: afterText, selection: null };
  await inject(uri, { type: 'viewEdited' });
  await inject(uri, { type: 'editUnitStart', unitId, start: before });
  await inject(uri, { type: 'editTransaction', transaction: { unitId, before, after } });
  await inject(uri, { type: 'unsavedContent', text: afterText });
  await waitUntil(() => findCustomTab(uri)?.isDirty === true, 'the WYSIWYG tab became dirty');
}

async function readInspection(uri: vscode.Uri): Promise<BackupInspection | undefined> {
  return (await api()).readBackupInspection(uri.toString());
}

/**
 * Drives undo while leaving an edit unit whose terminator never arrives, entering protection from an actual missing
 * endpoint.
 *
 * @returns The history application result. Resolves after the protection backup has been verified.
 */
async function enterProtection(uri: vscode.Uri): Promise<boolean | undefined> {
  await injectEdit(uri, INITIAL_TEXT, EDITED_TEXT);
  await inject(uri, { type: 'editUnitStart', unitId: 'never-settled', start: { text: EDITED_TEXT, selection: null } });
  return (await api()).runHistoryTransitionForTest(uri.toString(), 'undo');
}

async function readHistoryCandidates(uri: vscode.Uri): Promise<string[]> {
  return (await readRecordedMessages(uri))
    .filter((recorded) => recorded.direction === 'toView'
      && readField(recorded.message, 'type') === 'replaceDocument'
      && readField(recorded.message, 'kind') === 'editHistory')
    .map((recorded) => String(readField(recorded.message, 'text')));
}

describe('protection backup and recovery', () => {
  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    (await api()).clearDiagnosticInspection();
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const name of scratchNames) {
      const uri = vscode.Uri.joinPath(findExtension().extensionUri, 'tests', 'integration', 'fixtures', name);
      await vscode.workspace.fs.delete(uri).then(undefined, () => undefined);
    }
  });

  it('on a history failure from an actual missing endpoint, preserves the retained old full text in a verified independent backup before responding', async () => {
    const uri = await resetScratch('preserve');
    await openWysiwyg(uri);

    const applied = await enterProtection(uri);
    // By the time the response returns, a verified backup must already exist.
    const inspection = await readInspection(uri);

    assert.deepStrictEqual([applied, inspection?.protectionStatus], [false, 'verified']);
    const backupUri = vscode.Uri.parse(inspection?.protectionBackupUri ?? '');
    const stored: unknown = JSON.parse(await readFileText(vscode.Uri.joinPath(backupUri, '1.json')));
    assert.deepStrictEqual(stored, {
      version: 1,
      documentUri: uri.toString(),
      fullText: EDITED_TEXT,
      mergeBase: INITIAL_TEXT,
    });
  });

  it('disposes the old document without a prompt after a verified write on recovery, and shows a different document in the same group', async () => {
    const uri = await resetScratch('reopen');
    await openWysiwyg(uri);
    await enterProtection(uri);
    const protectionBackup = vscode.Uri.parse((await readInspection(uri))?.protectionBackupUri ?? '');
    const groupBefore = vscode.window.tabGroups.activeTabGroup.viewColumn;

    await vscode.commands.executeCommand('ahve.recover');

    await waitUntil(async () => await readFileText(uri) === EDITED_TEXT, 'the recovered text was written');
    await waitUntil(async () => !(await exists(protectionBackup)), 'the protection backup was discarded after the new document was shown');
    const tab = findCustomTab(uri);
    assert.deepStrictEqual([tab?.isDirty, tab?.group.viewColumn, groupBefore], [false, groupBefore, groupBefore]);
    assert.strictEqual((await readInspection(uri))?.protectionStatus, undefined);
    // The record is recreated with the new panel, so the initialization results here belong to the new view.
    assert.ok(
      (await readRecordedMessages(uri)).some(
        (recorded) => readField(recorded.message, 'type') === 'documentInitialized'
          && readField(recorded.message, 'success') === true,
      ),
      'the new view did not report a successful mount',
    );
  });

  it('gives the new document after recovery no old history, and undo of a new edit returns to the saved baseline', async () => {
    const uri = await resetScratch('history');
    await openWysiwyg(uri);
    await enterProtection(uri);
    await vscode.commands.executeCommand('ahve.recover');
    await waitUntil(async () => (await readInspection(uri))?.protectionStatus === undefined
      && findCustomTab(uri)?.isDirty === false, 'recovery completed');
    await waitUntil(
      async () => (await readRecordedMessages(uri)).some((recorded) => readField(recorded.message, 'type') === 'documentInitialized'),
      'the recovered view was initialized',
    );

    // Edit only after the text buffer has followed the recovery write, so the undo target does not change around the
    // follow.
    const buffer = await vscode.workspace.openTextDocument(uri);
    await waitUntil(() => buffer.getText() === EDITED_TEXT, 'the buffer followed the recovery write');
    await delay(500);

    await injectEdit(uri, EDITED_TEXT, EDITED_AGAIN_TEXT);
    await vscode.commands.executeCommand('ahve.undo');
    await waitUntil(() => findCustomTab(uri)?.isDirty === false, 'undo returned to the saved content');

    // The new document's history has nowhere further to go back to. If the old document's history had carried over,
    // undo could reach edits from before protection.
    assert.strictEqual(await (await api()).runHistoryTransitionForTest(uri.toString(), 'undo'), false);
    assert.deepStrictEqual(await readHistoryCandidates(uri), [EDITED_TEXT]);
  });

  it('does not restore from the protection backup when the same source file is reopened after recovery completes', async () => {
    const uri = await resetScratch('reopen-after-recovery');
    await openWysiwyg(uri);
    await enterProtection(uri);
    const protectionBackup = vscode.Uri.parse((await readInspection(uri))?.protectionBackupUri ?? '');

    await vscode.commands.executeCommand('ahve.recover');
    await waitUntil(async () => !(await exists(protectionBackup)), 'the protection backup was discarded');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitUntil(() => findCustomTab(uri) === undefined, 'the recovered tab closed');
    await openWysiwyg(uri);

    // Recovery released the reference, so reopening does not start a restore.
    await waitUntil(
      async () => (await api()).readRestoreInspection(uri.toString())?.progress === 'normal',
      'the reopened document started normally',
    );
    assert.strictEqual(findCustomTab(uri)?.isDirty, false);
    assert.strictEqual(await readFileText(uri), EDITED_TEXT);
  });
});
