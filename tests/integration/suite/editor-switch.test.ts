import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { customTabMatchesSource, waitForEditorEntryToClose } from '../helpers/editor-tabs';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

// Commands cannot be run unless spelled the same as the declaration in package.json.
const OPEN_IN_WYSIWYG = 'ahve.openInWysiwygEditor';
const OPEN_IN_HTML = 'ahve.openInHtmlEditor';

// Changes to tabs, sessions, and views do not signal completion, so wait up to a fixed limit.
const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

// Cases that compare content and modification time, or that make a file dirty, do not use the fixed files kept in the
// repository.
const ROUND_TRIP_SCRATCH = 'editor-switch-round-trip-scratch.html';
const DIRTY_SCRATCH = 'editor-switch-dirty-scratch.html';
const SCRATCH_NAMES = [ROUND_TRIP_SCRATCH, DIRTY_SCRATCH];
const SCRATCH_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>switch</p>\n</body>\n</html>\n';

// A file that is never created. WYSIWYG can open it, but neither the initialization read nor the text editor can.
// Deleting it from disk after opening is not enough: the text model loaded by initialization remains, and VS Code can
// open the standard text editor with it.
const MISSING_FILE = 'editor-switch-missing.html';

interface RecordedMessage {
  readonly direction: 'fromView' | 'toView';
  readonly message: unknown;
}

interface ExtensionApi {
  getMessage(key: string): string;
  readDiagnosticInspection(): {
    readonly notifications: readonly string[];
    readonly logLines: readonly string[];
  };
  clearDiagnosticInspection(): void;
  readSessionInspection(): {
    readonly documentUris: readonly string[];
    readonly activeDocumentUri: string | undefined;
  };
  readWebviewInspection(documentUri: string): { readonly messages: readonly RecordedMessage[] } | undefined;
  injectViewMessage(documentUri: string, message: unknown): Promise<boolean>;
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
  return vscode.Uri.joinPath(findExtension().extensionUri, 'tests', 'integration', 'fixtures', fileName);
}

function openTabs(): readonly vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

function activeTab(): vscode.Tab {
  return vscode.window.tabGroups.activeTabGroup.activeTab ?? assert.fail('There is no active tab');
}

function isTextTabOf(tab: vscode.Tab, uri: vscode.Uri): boolean {
  return tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString();
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

async function openText(uri: vscode.Uri, viewColumn?: vscode.ViewColumn): Promise<void> {
  await vscode.window.showTextDocument(uri, { viewColumn, preview: false });
}

async function waitForViewInitialized(uri: vscode.Uri): Promise<void> {
  await waitUntil(
    async () => ((await api()).readWebviewInspection(uri.toString())?.messages ?? []).some(
      (recorded) => recorded.direction === 'toView'
        && typeof recorded.message === 'object'
        && recorded.message !== null
        && Reflect.get(recorded.message, 'type') === 'initialize',
    ),
    'the view received the initialize message',
  );
}

// Wait until initialization has been sent. Moving on without waiting lets the late-opening actual editor or the
// initialization read overlap with later operations.
async function openWysiwyg(uri: vscode.Uri, viewColumn?: vscode.ViewColumn): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE, viewColumn);
  await waitForEditorEntryToClose(uri);
  await waitForViewInitialized(uri);
}

// "Open in HTML" without an argument takes its target from the active session, so wait until the panel is active.
async function waitForActiveSession(uri: vscode.Uri): Promise<void> {
  await waitUntil(
    async () => (await api()).readSessionInspection().activeDocumentUri === uri.toString(),
    'the WYSIWYG session became active',
  );
}

async function inject(uri: vscode.Uri, message: unknown): Promise<void> {
  assert.ok(await (await api()).injectViewMessage(uri.toString(), message), 'Could not inject because there is no session');
}

// If a text buffer is already open, wait until it catches up with the written content.
async function writeScratch(fileName: string): Promise<vscode.Uri> {
  const uri = fixtureUri(fileName);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(SCRATCH_TEXT));
  const document = await vscode.workspace.openTextDocument(uri);
  await waitUntil(() => document.getText() === SCRATCH_TEXT, 'the text buffer caught up with the written content');
  return uri;
}

async function readFileText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

// Closing does not finish when the command resolves. Without this wait, a case that opens into the second group
// joins a group the previous case left behind, and the group layout assertions pass or fail by timing.
async function closeAllGroups(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllGroups');
  await waitUntil(
    () => vscode.window.tabGroups.all.length === 1 && openTabs().length === 0,
    'every editor group closed',
  );
}

describe('editor switch', () => {
  beforeEach(async () => {
    await closeAllGroups();
    (await api()).clearDiagnosticInspection();
  });

  after(async () => {
    await closeAllGroups();
    for (const name of SCRATCH_NAMES) {
      await vscode.workspace.fs.delete(fixtureUri(name)).then(undefined, () => undefined);
    }
  });

  describe('resolving the caller group', () => {
    it('replaces the tab in the second group, leaving the first group unchanged, when "Open in WYSIWYG" runs with the URI of a text tab in the second group', async () => {
      const first = fixtureUri('crlf.html');
      const second = fixtureUri('sample.html');
      await openText(first, vscode.ViewColumn.One);
      await openText(second, vscode.ViewColumn.Two);
      // Make the first group active, to check that the replacement happens in the argument tab's group rather than the
      // active group.
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');

      await vscode.commands.executeCommand(OPEN_IN_WYSIWYG, second);

      assert.deepStrictEqual(
        vscode.window.tabGroups.all.map((group) => group.tabs.map((tab) => ({
          firstText: isTextTabOf(tab, first),
          secondWysiwyg: customTabMatchesSource(tab, second),
        }))),
        [[{ firstText: true, secondWysiwyg: false }], [{ firstText: false, secondWysiwyg: true }]],
      );
    });

    it('opens WYSIWYG and keeps both text tabs when run with an argument while text tabs of the same file are at the front of two groups', async () => {
      const uri = fixtureUri('sample.html');
      await openText(uri, vscode.ViewColumn.One);
      await openText(uri, vscode.ViewColumn.Two);

      await vscode.commands.executeCommand(OPEN_IN_WYSIWYG, uri);

      assert.deepStrictEqual(
        {
          textTabs: openTabs().filter((tab) => isTextTabOf(tab, uri)).length,
          wysiwygTabs: openTabs().filter((tab) => customTabMatchesSource(tab, uri)).length,
        },
        { textTabs: 2, wysiwygTabs: 1 },
      );
    });

    it('replaces only the second group with WYSIWYG, keeping the first text tab, when run without an argument while text tabs of the same file are at the front of two groups and the second group is active', async () => {
      const uri = fixtureUri('sample.html');
      await openText(uri, vscode.ViewColumn.One);
      // The second group, opened later, becomes active. There are two candidates, and only the reported view column
      // can decide between them.
      await openText(uri, vscode.ViewColumn.Two);

      await vscode.commands.executeCommand(OPEN_IN_WYSIWYG);

      assert.deepStrictEqual(
        vscode.window.tabGroups.all.map((group) => group.tabs.map((tab) => ({
          text: isTextTabOf(tab, uri),
          wysiwyg: customTabMatchesSource(tab, uri),
        }))),
        [[{ text: true, wysiwyg: false }], [{ text: false, wysiwyg: true }]],
      );
    });

    it('opens WYSIWYG without closing existing tabs when the argument file is not at the front of any group', async () => {
      const uri = fixtureUri('sample.html');
      const front = fixtureUri('crlf.html');
      await openText(uri);
      await openText(front);

      await vscode.commands.executeCommand(OPEN_IN_WYSIWYG, uri);

      assert.deepStrictEqual(
        {
          textTabs: openTabs().filter((tab) => isTextTabOf(tab, uri) || isTextTabOf(tab, front)).length,
          wysiwygTabs: openTabs().filter((tab) => customTabMatchesSource(tab, uri)).length,
        },
        { textTabs: 2, wysiwygTabs: 1 },
      );
    });

    it('replaces the tab in the auxiliary window\'s group, keeping the main window\'s tab, when "Open in WYSIWYG" runs without an argument after the text tab is moved into an auxiliary window', async () => {
      const moved = fixtureUri('sample.html');
      const kept = fixtureUri('crlf.html');
      await openText(kept, vscode.ViewColumn.One);
      await openText(moved, vscode.ViewColumn.One);
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      await waitUntil(
        () => vscode.window.tabGroups.all.length === 2
          && vscode.window.activeTextEditor?.document.uri.toString() === moved.toString(),
        'the text tab moved into the auxiliary window and became active',
      );

      await vscode.commands.executeCommand(OPEN_IN_WYSIWYG);

      assert.deepStrictEqual(
        vscode.window.tabGroups.all.map((group) => group.tabs.map((tab) => ({
          keptText: isTextTabOf(tab, kept),
          movedWysiwyg: customTabMatchesSource(tab, moved),
        }))),
        [[{ keptText: true, movedWysiwyg: false }], [{ keptText: false, movedWysiwyg: true }]],
      );
    });

    it('replaces WYSIWYG with a text tab in the same group when "Open in HTML" runs without an argument while WYSIWYG is at the front', async () => {
      const uri = fixtureUri('sample.html');
      const other = fixtureUri('crlf.html');
      await openText(other);
      await openWysiwyg(uri);
      await waitForActiveSession(uri);

      await vscode.commands.executeCommand(OPEN_IN_HTML);

      assert.deepStrictEqual(
        vscode.window.tabGroups.all.map((group) => group.tabs.map((tab) => ({
          otherText: isTextTabOf(tab, other),
          text: isTextTabOf(tab, uri),
        }))),
        [[{ otherText: true, text: false }, { otherText: false, text: true }]],
      );
    });
  });

  describe('revealing an existing target tab', () => {
    it('brings WYSIWYG of the same file in another group to the front, keeping the text tab, when "Open in WYSIWYG" runs from the text tab', async () => {
      const uri = fixtureUri('sample.html');
      await openText(uri, vscode.ViewColumn.One);
      await openWysiwyg(uri, vscode.ViewColumn.Two);
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');

      await vscode.commands.executeCommand(OPEN_IN_WYSIWYG);

      assert.deepStrictEqual(
        {
          groups: vscode.window.tabGroups.all.map((group) => group.tabs.map((tab) => ({
            text: isTextTabOf(tab, uri),
            wysiwyg: customTabMatchesSource(tab, uri),
          }))),
          activeIsWysiwyg: customTabMatchesSource(activeTab(), uri),
        },
        {
          groups: [[{ text: true, wysiwyg: false }], [{ text: false, wysiwyg: true }]],
          activeIsWysiwyg: true,
        },
      );
    });

    it('brings a text tab of the same file in another group to the front, keeping WYSIWYG, when "Open in HTML" runs from WYSIWYG', async () => {
      const uri = fixtureUri('sample.html');
      await openWysiwyg(uri, vscode.ViewColumn.One);
      await openText(uri, vscode.ViewColumn.Two);
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
      await waitForActiveSession(uri);

      await vscode.commands.executeCommand(OPEN_IN_HTML);

      assert.deepStrictEqual(
        {
          groups: vscode.window.tabGroups.all.map((group) => group.tabs.map((tab) => ({
            text: isTextTabOf(tab, uri),
            wysiwyg: customTabMatchesSource(tab, uri),
          }))),
          activeIsText: isTextTabOf(activeTab(), uri),
        },
        {
          groups: [[{ text: false, wysiwyg: true }], [{ text: true, wysiwyg: false }]],
          activeIsText: true,
        },
      );
    });

    it('brings a target tab behind it in the same group to the front without adding a tab, keeping the source tab', async () => {
      const uri = fixtureUri('sample.html');
      await openWysiwyg(uri);
      await openText(uri);

      await vscode.commands.executeCommand(OPEN_IN_WYSIWYG);

      assert.deepStrictEqual(
        {
          tabs: vscode.window.tabGroups.all.map((group) => group.tabs.map((tab) => ({
            text: isTextTabOf(tab, uri),
            wysiwyg: customTabMatchesSource(tab, uri),
          }))),
          activeIsWysiwyg: customTabMatchesSource(activeTab(), uri),
        },
        {
          tabs: [[{ text: false, wysiwyg: true }, { text: true, wysiwyg: false }]],
          activeIsWysiwyg: true,
        },
      );
    });
  });

  describe('opening the target in the caller group', () => {
    it('keeps the number of groups unchanged and makes the target the group\'s only tab when switching from the only tab in the second group', async () => {
      const uri = fixtureUri('sample.html');
      await openText(fixtureUri('crlf.html'), vscode.ViewColumn.One);
      await openText(uri, vscode.ViewColumn.Two);

      await vscode.commands.executeCommand(OPEN_IN_WYSIWYG);

      assert.deepStrictEqual(
        vscode.window.tabGroups.all.map((group) => group.tabs.map((tab) => customTabMatchesSource(tab, uri))),
        [[false], [true]],
      );
    });

    it('leaves the file content and modification time unchanged after a round trip from text to WYSIWYG and back to text', async () => {
      const uri = await writeScratch(ROUND_TRIP_SCRATCH);
      const before = await vscode.workspace.fs.stat(uri);
      await openText(uri);

      await vscode.commands.executeCommand(OPEN_IN_WYSIWYG);
      // Go back only after initialization. Going back before initialization would make a round trip that skips the
      // WYSIWYG side's read and sync.
      await waitForViewInitialized(uri);
      await waitForActiveSession(uri);
      await vscode.commands.executeCommand(OPEN_IN_HTML);

      assert.deepStrictEqual(
        { text: await readFileText(uri), mtime: (await vscode.workspace.fs.stat(uri)).mtime },
        { text: SCRATCH_TEXT, mtime: before.mtime },
      );
    });

    it('shows a notification and keeps the WYSIWYG tab when "Open in HTML" runs after opening a nonexistent .html in WYSIWYG', async () => {
      const uri = fixtureUri(MISSING_FILE);
      const extensionApi = await api();
      await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
      await waitForEditorEntryToClose(uri);
      // Initialization fails to read and ends with a notification. Clear the records after that notification appears,
      // so only the notifications from the switch are counted.
      await waitUntil(
        () => extensionApi.readDiagnosticInspection().notifications
          .includes(extensionApi.getMessage('documentUnreadable.message')),
        'the view initialization ended without reading the file',
      );
      await waitForActiveSession(uri);
      extensionApi.clearDiagnosticInspection();

      await vscode.commands.executeCommand(OPEN_IN_HTML);

      assert.deepStrictEqual(
        {
          notifications: extensionApi.readDiagnosticInspection().notifications,
          wysiwygTabs: openTabs().filter((tab) => customTabMatchesSource(tab, uri)).length,
        },
        { notifications: [extensionApi.getMessage('openInHtml.failed.message')], wysiwygTabs: 1 },
      );
    });
  });

  describe('closing the source tab', () => {
    it('closes the WYSIWYG tab and unregisters its session when switching from WYSIWYG to text', async () => {
      const uri = fixtureUri('sample.html');
      await openWysiwyg(uri);
      await waitForActiveSession(uri);

      await vscode.commands.executeCommand(OPEN_IN_HTML);
      // The registration is removed in response to the panel's disposal, so it is reflected some time after the tab
      // closes.
      await waitUntil(
        async () => !(await api()).readSessionInspection().documentUris.includes(uri.toString()),
        'the session was unregistered',
      );

      assert.strictEqual(openTabs().filter((tab) => customTabMatchesSource(tab, uri)).length, 0);
    });

    it('closes a dirty WYSIWYG with VS Code\'s standard close operation, with no notification from the extension, when switching from it', async () => {
      const uri = await writeScratch(DIRTY_SCRATCH);
      await openWysiwyg(uri);
      await waitForActiveSession(uri);
      // With edit events, the dirty mark is set by the edit unit start, not by the view edited message, which carries
      // no content. Send them in the same order as a real view.
      await inject(uri, { type: 'viewEdited' });
      await inject(uri, {
        type: 'editUnitStart',
        unitId: 'editor-switch-dirty',
        start: { text: SCRATCH_TEXT, selection: null },
      });
      await waitUntil(
        () => openTabs().some((tab) => customTabMatchesSource(tab, uri) && tab.isDirty),
        'the WYSIWYG tab became dirty',
      );

      await vscode.commands.executeCommand(OPEN_IN_HTML);

      assert.deepStrictEqual(
        {
          wysiwygTabs: openTabs().filter((tab) => customTabMatchesSource(tab, uri)).length,
          notifications: (await api()).readDiagnosticInspection().notifications,
        },
        { wysiwygTabs: 0, notifications: [] },
      );
    });
  });

  describe('accepting editor switch requests from the dialog', () => {
    it('replaces the WYSIWYG of an empty .html with a text tab in the same group when an editor switch request is injected', async () => {
      const uri = fixtureUri('empty.html');
      const other = fixtureUri('crlf.html');
      await openText(other, vscode.ViewColumn.One);
      await openWysiwyg(uri, vscode.ViewColumn.Two);
      // Make the first group active, to check that the replacement happens in the group of the panel that sent the
      // request.
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');

      await inject(uri, { type: 'textEditorSwitchRequested' });
      // The receiving side returns without waiting for the switch to finish, so wait until the tabs are swapped.
      await waitUntil(
        () => openTabs().some((tab) => isTextTabOf(tab, uri))
          && !openTabs().some((tab) => customTabMatchesSource(tab, uri)),
        'the WYSIWYG tab was replaced with a text tab',
      );

      assert.deepStrictEqual(
        vscode.window.tabGroups.all.map((group) => group.tabs.map((tab) => ({
          otherText: isTextTabOf(tab, other),
          text: isTextTabOf(tab, uri),
        }))),
        [[{ otherText: true, text: false }], [{ otherText: false, text: true }]],
      );
    });

    it('replaces the WYSIWYG of an openable document with a text tab by the same rule when an editor switch request is injected', async () => {
      const uri = fixtureUri('sample.html');
      await openWysiwyg(uri);

      await inject(uri, { type: 'textEditorSwitchRequested' });
      await waitUntil(
        () => openTabs().some((tab) => isTextTabOf(tab, uri))
          && !openTabs().some((tab) => customTabMatchesSource(tab, uri)),
        'the WYSIWYG tab was replaced with a text tab',
      );

      assert.deepStrictEqual(
        vscode.window.tabGroups.all.map((group) => group.tabs.map((tab) => ({
          text: isTextTabOf(tab, uri),
          wysiwyg: customTabMatchesSource(tab, uri),
        }))),
        [[{ text: true, wysiwyg: false }]],
      );
    });
  });

  describe('excluding concurrent switches of the same file', () => {
    it('opens only one WYSIWYG and leaves one tab in the group when "Open in WYSIWYG" runs twice from the same text tab without waiting', async () => {
      const uri = fixtureUri('sample.html');
      await openText(uri);

      await Promise.all([
        vscode.commands.executeCommand(OPEN_IN_WYSIWYG, uri),
        vscode.commands.executeCommand(OPEN_IN_WYSIWYG, uri),
      ]);

      assert.deepStrictEqual(
        vscode.window.tabGroups.all.map((group) => group.tabs.map((tab) => customTabMatchesSource(tab, uri))),
        [[true]],
      );
    });
  });
});
