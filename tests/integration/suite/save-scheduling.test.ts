import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { customTabMatchesSource } from '../helpers/editor-tabs';

// A test that checks VS Code's own behavior. None of the three below is guaranteed by the API
// contract, and the WYSIWYG save depends on them, so this test is kept to catch them changing.
// 1. Whether auto save afterDelay fires for a custom editor too, and whether its timer restarts on a
//    change event.
// 2. How many times VS Code retries when a save entry point keeps returning a failure (confirming the
//    retries do not run away).
// 3. Whether a still-open text buffer follows a direct write to disk. It is because it follows that a
//    save can write straight to disk instead of going through the buffer.

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

// The sampling interval used when measuring how long the buffer takes to follow.
const FOLLOW_SAMPLING_INTERVAL_MS = 5;

// The auto save delay. It is shortened because the default of 1000ms makes each observation too slow.
const AUTO_SAVE_DELAY_MS = 300;

const SCRATCH_FILE_NAME = 'save-scheduling-scratch.html';
const INITIAL_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>a</p>\n</body>\n</html>\n';
const EXTERNAL_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>external</p>\n</body>\n</html>\n';

interface SaveEntryCall {
  readonly kind: 'save' | 'saveAs' | 'revert';
  readonly documentUri: string;
  readonly at: number;
}

interface ExtensionApi {
  injectViewMessage(documentUri: string, message: unknown): Promise<boolean>;
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

function scratchUri(): vscode.Uri {
  return vscode.Uri.joinPath(
    findExtension().extensionUri,
    'tests',
    'integration',
    'fixtures',
    SCRATCH_FILE_NAME,
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;

  for (;;) {
    if (condition()) {
      return;
    }
    assert.ok(Date.now() < deadline, `Timed out before ${description}`);
    await delay(POLLING_INTERVAL_MS);
  }
}

// Measures how long the buffer takes to follow. Only here is the sampling this fine, because at the
// general polling interval (100ms) the elapsed time would be buried in the interval itself and could
// not serve as the basis for choosing BUFFER_FOLLOW_TIMEOUT_MS.
async function measureFollow(document: vscode.TextDocument, expected: string): Promise<number> {
  const start = Date.now();

  for (;;) {
    if (document.getText() === expected) {
      return Date.now() - start;
    }
    assert.ok(Date.now() - start < STATE_TIMEOUT_MS, 'Timed out before the buffer followed the content on disk');
    await delay(FOLLOW_SAMPLING_INTERVAL_MS);
  }
}

async function updateSetting(section: string, key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
}

async function saveCalls(uri: vscode.Uri): Promise<readonly SaveEntryCall[]> {
  const inspection = (await api()).readSaveEntryInspection();
  return inspection.calls.filter((call) => call.documentUri === uri.toString());
}

// Writes back to disk and waits until the still-open buffer follows that content.
// Without the wait, the edit would land on a buffer still holding the previous test's content.
async function resetScratch(uri: vscode.Uri): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(INITIAL_TEXT));

  const document = await vscode.workspace.openTextDocument(uri);
  await waitUntil(() => document.getText() === INITIAL_TEXT, 'the buffer followed the initial content');
}

// Opens the view and waits until the response to the view ready message has finished.
async function openWysiwyg(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
  await delay(1000);
}

// Injects a view edited message to mark the tab dirty. Key input in the webview cannot be driven from
// the extension host.
// Edit events fire once per edit unit start, so inject a new unit for every additional change event.
let injectedEditUnits = 0;

async function makeViewDirty(uri: vscode.Uri): Promise<void> {
  injectedEditUnits += 1;
  for (const message of [
    { type: 'viewEdited' },
    {
      type: 'editUnitStart',
      unitId: `save-scheduling-${injectedEditUnits}`,
      start: { text: INITIAL_TEXT, selection: null },
    },
  ]) {
    const dispatched = await (await api()).injectViewMessage(uri.toString(), message);
    assert.ok(dispatched, 'the message was not delivered because no session is registered');
  }
}

describe('when saves fire and whether the buffer follows', () => {
  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await resetScratch(scratchUri());
    (await api()).clearSaveEntryInspection();
  });

  afterEach(async () => {
    await updateSetting('files', 'autoSave', undefined);
    await updateSetting('files', 'autoSaveDelay', undefined);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  after(async () => {
    await vscode.workspace.fs.delete(scratchUri());
  });

  it('fires auto save afterDelay for a custom editor too', async () => {
    await updateSetting('files', 'autoSave', 'afterDelay');
    await updateSetting('files', 'autoSaveDelay', AUTO_SAVE_DELAY_MS);

    const uri = scratchUri();
    await openWysiwyg(uri);
    (await api()).clearSaveEntryInspection();
    await makeViewDirty(uri);

    await waitUntil(
      () => findCustomTab(uri)?.isDirty === true,
      'the WYSIWYG tab became dirty',
    );
    const deadline = Date.now() + STATE_TIMEOUT_MS;
    for (;;) {
      if ((await saveCalls(uri)).length > 0) {
        break;
      }
      assert.ok(Date.now() < deadline, 'auto save did not call the save entry point');
      await delay(POLLING_INTERVAL_MS);
    }
  });

  it('is not retried while failures keep being returned, unless another change event is added', async () => {
    await updateSetting('files', 'autoSave', 'afterDelay');
    await updateSetting('files', 'autoSaveDelay', AUTO_SAVE_DELAY_MS);

    const uri = scratchUri();
    await openWysiwyg(uri);
    (await api()).clearSaveEntryInspection();
    await makeViewDirty(uri);

    // Wait for the first firing, then leave it alone for ten times the delay.
    const deadline = Date.now() + STATE_TIMEOUT_MS;
    for (;;) {
      if ((await saveCalls(uri)).length > 0) {
        break;
      }
      assert.ok(Date.now() < deadline, 'auto save did not call the save entry point');
      await delay(POLLING_INTERVAL_MS);
    }
    await delay(AUTO_SAVE_DELAY_MS * 10);

    const calls = await saveCalls(uri);
    assert.ok(
      calls.length <= 2,
      `it is being retried on every failure: ${calls.length} calls in ${AUTO_SAVE_DELAY_MS * 10}ms`,
    );
  });

  it('restarts the delay and postpones the save when change events are fired repeatedly', async () => {
    await updateSetting('files', 'autoSave', 'afterDelay');
    await updateSetting('files', 'autoSaveDelay', AUTO_SAVE_DELAY_MS);

    const uri = scratchUri();
    await openWysiwyg(uri);
    (await api()).clearSaveEntryInspection();

    // Keep firing change events at an interval shorter than the delay. If the delay restarts, no save
    // runs while this lasts.
    const start = Date.now();
    const burstEnd = start + AUTO_SAVE_DELAY_MS * 6;
    while (Date.now() < burstEnd) {
      await makeViewDirty(uri);
      await delay(AUTO_SAVE_DELAY_MS / 3);
    }

    const duringBurst = await saveCalls(uri);
    assert.ok(
      duringBurst.length <= 1,
      `a save ran in the middle of the burst of change events: ${duringBurst.length} calls`,
    );
  });

  it('makes a buffer that is not dirty follow a direct write to disk', async () => {
    const uri = scratchUri();
    const document = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(document.getText(), INITIAL_TEXT, 'the buffer was not opened with the initial content');

    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(EXTERNAL_TEXT));

    const elapsed = await measureFollow(document, EXTERNAL_TEXT);
    // Following happens asynchronously through the file watcher. This duration is the basis for
    // BUFFER_FOLLOW_TIMEOUT_MS, so the measured value is put in the failure message, where it can be
    // read off whenever the value shifts.
    assert.ok(elapsed < STATE_TIMEOUT_MS, `following did not finish in time: ${elapsed} ms`);
  });

  it('does not make a dirty buffer follow a direct write to disk', async () => {
    const uri = scratchUri();
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(3, 0), 'Z');
    assert.ok(await vscode.workspace.applyEdit(edit), 'the edit to the text buffer was not applied');
    await waitUntil(() => document.isDirty, 'the text tab became dirty');

    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(EXTERNAL_TEXT));
    await delay(2000);

    assert.notStrictEqual(document.getText(), EXTERNAL_TEXT, 'the dirty buffer followed');
    assert.ok(document.isDirty, 'the dirty state was cleared');

    // Discard the edit so that the next test's cleanup is not blocked by a confirmation dialog.
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });
});
