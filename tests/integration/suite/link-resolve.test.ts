import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { customTabMatchesSource, waitForEditorEntryToClose } from '../helpers/editor-tabs';
import { LinkTargetFileSystem } from '../helpers/link-target-file-system';
import type { LinkTargetEntry } from '../helpers/link-target-file-system';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';

// The WYSIWYG tab opens only with the same spelling as the declaration in package.json.
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

// Changes to tabs, sessions, and views give no completion signal, so waits have an upper bound.
const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

// Spellings of the reasons a link was not opened. They begin each diagnostic log line, so the reason stays traceable
// even when the wording changes.
const OUTSIDE_SCOPE_MARK = '[outsideScope]';
const UNRESOLVABLE_MARK = '[unresolvable]';
const NOT_FILE_MARK = '[notFile]';
const OPEN_FAILED_MARK = '[openFailed]';

// A custom-scheme document. It lies outside the workspace folder, so its scope root is the base directory `/docs`.
const LINK_TEST_SCHEME = 'ahve-link-test';

// A target in an in-scope subdirectory. The fixture files do not include it, so these tests create and delete it.
const SUB_DIRECTORY = 'link-resolve-sub';
const SUB_TARGET = 'target.html';
// A document in the subdirectory, for links written from the workspace folder.
const SUB_DOCUMENT = 'document.html';

// A target that is not `.html`. It confirms that no editor type is specified.
const TEXT_TARGET = 'link-resolve-note.txt';

// A file that is never created. Creating it would stop requests from taking the path for a nonexistent target.
const MISSING_TARGET = 'link-resolve-missing.html';

const TARGET_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>target</p>\n</body>\n</html>\n';

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

// The extension path passed to the development host is the repository root.
function fixtureUri(...segments: string[]): vscode.Uri {
  return vscode.Uri.joinPath(findExtension().extensionUri, 'tests', 'integration', 'fixtures', ...segments);
}

function outsideWorkspaceUri(fileName: string): vscode.Uri {
  return vscode.Uri.joinPath(findExtension().extensionUri, 'tests', 'integration', 'outside-workspace', fileName);
}

function openTabs(): readonly vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

function isTextTabOf(tab: vscode.Tab, uri: vscode.Uri): boolean {
  return tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString();
}

function countTextTabsOf(uri: vscode.Uri): number {
  return openTabs().filter((tab) => isTextTabOf(tab, uri)).length;
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

// Wait for initialization. Without it, the late-opening actual editor tab and the initialization read overlap later
// operations.
async function openWysiwyg(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
  await waitForEditorEntryToClose(uri);
  await waitForViewInitialized(uri);
}

async function requestLink(uri: vscode.Uri, href: string): Promise<void> {
  assert.ok(
    await (await api()).injectViewMessage(uri.toString(), { type: 'relativeLinkRequested', href }),
    'The request could not be injected because there is no session',
  );
}

async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitUntil(() => openTabs().length === 0, 'every tab closed');
}

function countWysiwygTabsOf(uri: vscode.Uri): number {
  return openTabs().filter((tab) => customTabMatchesSource(tab, uri)).length;
}

// Clears the records made up to opening. Opening a document can also write records, so this is needed to see only
// those from the request.
async function clearInspection(): Promise<void> {
  (await api()).clearDiagnosticInspection();
}

// The notification appears only after the existence and type query finishes, so wait for it before reading records.
async function waitForNotification(): Promise<ReturnType<ExtensionApi['readDiagnosticInspection']>> {
  await waitUntil(
    async () => (await api()).readDiagnosticInspection().notifications.length > 0,
    'a notification appeared',
  );
  return (await api()).readDiagnosticInspection();
}

async function message(key: string): Promise<string> {
  return (await api()).getMessage(key);
}

// Rewrites the user's default editor setting. `undefined` restores the default.
async function updateEditorAssociations(associations: Record<string, string> | undefined): Promise<void> {
  await vscode.workspace
    .getConfiguration('workbench')
    .update('editorAssociations', associations, vscode.ConfigurationTarget.Global);
}

describe('relative link resolution', () => {
  const workspaceDocument = (): vscode.Uri => fixtureUri('sample.html');
  const sameDirectoryTarget = (): vscode.Uri => fixtureUri('crlf.html');
  const anotherTarget = (): vscode.Uri => fixtureUri('empty.html');

  before(async () => {
    await vscode.workspace.fs.createDirectory(fixtureUri(SUB_DIRECTORY));
    await vscode.workspace.fs.writeFile(
      fixtureUri(SUB_DIRECTORY, SUB_TARGET),
      new TextEncoder().encode(TARGET_TEXT),
    );
    await vscode.workspace.fs.writeFile(
      fixtureUri(SUB_DIRECTORY, SUB_DOCUMENT),
      new TextEncoder().encode(TARGET_TEXT),
    );
    await vscode.workspace.fs.writeFile(
      fixtureUri(TEXT_TARGET),
      new TextEncoder().encode('relative link target\n'),
    );
  });

  beforeEach(async () => {
    await closeAllEditors();
    // Records accumulate while the extension runs. Clear them after closing the tabs so each test sees only its own.
    (await api()).clearDiagnosticInspection();
  });

  after(async () => {
    await closeAllEditors();
    await vscode.workspace.fs.delete(fixtureUri(SUB_DIRECTORY), { recursive: true })
      .then(undefined, () => undefined);
    await vscode.workspace.fs.delete(fixtureUri(TEXT_TARGET)).then(undefined, () => undefined);
  });

  describe('request acceptance', () => {
    it('opens a tab for the target when a request points to a file in the same directory', async () => {
      const uri = workspaceDocument();
      const target = sameDirectoryTarget();
      await openWysiwyg(uri);

      await requestLink(uri, 'crlf.html');

      await waitUntil(() => countTextTabsOf(target) === 1, 'the target tab opened');
    });

    it('opens both targets when two requests for different targets are injected in succession', async () => {
      const uri = workspaceDocument();
      await openWysiwyg(uri);

      // Send without waiting for the previous request to finish. Requests are independent and do not wait for each other.
      await Promise.all([
        requestLink(uri, 'crlf.html'),
        requestLink(uri, 'empty.html'),
      ]);

      await waitUntil(
        () => countTextTabsOf(sameDirectoryTarget()) === 1 && countTextTabsOf(anotherTarget()) === 1,
        'the tabs for both targets opened',
      );
    });

    it('keeps the WYSIWYG tab without an unsaved mark after a request is handled', async () => {
      const uri = workspaceDocument();
      await openWysiwyg(uri);

      await requestLink(uri, 'crlf.html');
      await waitUntil(() => countTextTabsOf(sameDirectoryTarget()) === 1, 'the target tab opened');

      const wysiwygTabs = openTabs().filter((tab) => customTabMatchesSource(tab, uri));
      assert.deepStrictEqual(
        wysiwygTabs.map((tab) => tab.isDirty),
        [false],
      );
    });
  });

  describe('link target URI resolution', () => {
    it('gives the opened target tab a URI with the same scheme and authority as the base document', async () => {
      const uri = workspaceDocument();
      const target = sameDirectoryTarget();
      await openWysiwyg(uri);

      await requestLink(uri, 'crlf.html');
      await waitUntil(() => countTextTabsOf(target) === 1, 'the target tab opened');

      const opened = openTabs().find((tab) => isTextTabOf(tab, target))?.input;
      assert.ok(opened instanceof vscode.TabInputText, 'The target did not open as a text tab');
      assert.deepStrictEqual(
        { scheme: opened.uri.scheme, authority: opened.uri.authority },
        { scheme: uri.scheme, authority: uri.authority },
      );
    });
  });

  describe('scope check', () => {
    it('opens a tab for a subdirectory target requested from a document in the workspace folder', async () => {
      const uri = workspaceDocument();
      const target = fixtureUri(SUB_DIRECTORY, SUB_TARGET);
      await openWysiwyg(uri);

      await requestLink(uri, `${SUB_DIRECTORY}/${SUB_TARGET}`);

      await waitUntil(() => countTextTabsOf(target) === 1, 'the subdirectory target tab opened');
    });

    it('adds no tab and records outside scope for a request that leaves the workspace folder', async () => {
      const uri = workspaceDocument();
      await openWysiwyg(uri);
      const tabCount = openTabs().length;

      await requestLink(uri, '../outside-workspace/sample.html');
      await waitUntil(
        async () => (await api()).readDiagnosticInspection().logLines
          .some((line) => line.startsWith(OUTSIDE_SCOPE_MARK)),
        'the request was recorded as outside scope',
      );

      assert.deepStrictEqual(
        { tabs: openTabs().length, outsideTabs: countTextTabsOf(outsideWorkspaceUri('sample.html')) },
        { tabs: tabCount, outsideTabs: 0 },
      );
    });

    it('adds no tab for a request above the base directory from a document outside the workspace folder', async () => {
      const uri = outsideWorkspaceUri('sample.html');
      await openWysiwyg(uri);
      const tabCount = openTabs().length;

      await requestLink(uri, '../fixtures/sample.html');
      await waitUntil(
        async () => (await api()).readDiagnosticInspection().logLines
          .some((line) => line.startsWith(OUTSIDE_SCOPE_MARK)),
        'the request was recorded as outside scope',
      );

      assert.deepStrictEqual(
        { tabs: openTabs().length, targetTabs: countTextTabsOf(workspaceDocument()) },
        { tabs: tabCount, targetTabs: 0 },
      );
    });

    it('adds no tab and shows one outside-scope notification for a request that leaves the workspace folder through encoded separators', async () => {
      const uri = workspaceDocument();
      await openWysiwyg(uri);
      const tabCount = openTabs().length;
      await clearInspection();

      await requestLink(uri, '..%2Foutside-workspace%2Fsample.html');
      const inspection = await waitForNotification();

      assert.deepStrictEqual(
        { tabs: openTabs().length, notifications: inspection.notifications },
        { tabs: tabCount, notifications: [await message('relativeLink.outsideScope.message')] },
      );
    });
  });

  describe('opening in a tab', () => {
    it('keeps the first target tab when another target opens next', async () => {
      const uri = workspaceDocument();
      await openWysiwyg(uri);

      await requestLink(uri, 'crlf.html');
      await waitUntil(() => countTextTabsOf(sameDirectoryTarget()) === 1, 'the first target tab opened');
      await requestLink(uri, 'empty.html');
      await waitUntil(() => countTextTabsOf(anotherTarget()) === 1, 'the second target tab opened');

      assert.strictEqual(countTextTabsOf(sameDirectoryTarget()), 1);
    });

    it('keeps one tab for the target after two consecutive requests for it', async () => {
      const uri = workspaceDocument();
      const target = sameDirectoryTarget();
      await openWysiwyg(uri);

      await requestLink(uri, 'crlf.html');
      await waitUntil(() => countTextTabsOf(target) === 1, 'the target tab opened');
      await requestLink(uri, 'crlf.html');
      // The second request only brings the same tab to the front and gives no change signal. Wait a fixed time to
      // confirm that no tab is added.
      await delay(POLLING_INTERVAL_MS * 5);

      assert.strictEqual(countTextTabsOf(target), 1);
    });

    it('opens a target read from the workspace folder when the backslash-separated href does not resolve from the document directory', async () => {
      // The document is in the subdirectory, and the href names that subdirectory again, as written from the root.
      const uri = fixtureUri(SUB_DIRECTORY, SUB_DOCUMENT);
      const target = fixtureUri(SUB_DIRECTORY, SUB_TARGET);
      await openWysiwyg(uri);

      await requestLink(uri, `${SUB_DIRECTORY}\\${SUB_TARGET}`);

      await waitUntil(() => countTextTabsOf(target) === 1, 'the target read from the workspace folder opened');
    });

    it('opens the file directly in the workspace folder for a root-relative href requested from a document in a subdirectory', async () => {
      const uri = fixtureUri(SUB_DIRECTORY, SUB_DOCUMENT);
      const target = sameDirectoryTarget();
      await openWysiwyg(uri);

      await requestLink(uri, '/crlf.html');

      await waitUntil(() => countTextTabsOf(target) === 1, 'the target in the workspace folder opened');
    });

    it('adds no tab and shows one no-workspace-folder notification for a root-relative href requested from a document outside the workspace folder', async () => {
      const uri = outsideWorkspaceUri('sample.html');
      await openWysiwyg(uri);
      const tabCount = openTabs().length;
      await clearInspection();

      await requestLink(uri, '/sample.html');
      const inspection = await waitForNotification();

      assert.deepStrictEqual(
        { tabs: openTabs().length, notifications: inspection.notifications },
        { tabs: tabCount, notifications: [await message('relativeLink.noWorkspaceFolder.message')] },
      );
    });

    it('adds no tab and shows one not-found notification for a request to a nonexistent file within scope', async () => {
      const uri = workspaceDocument();
      await openWysiwyg(uri);
      const tabCount = openTabs().length;
      await clearInspection();

      await requestLink(uri, MISSING_TARGET);
      const inspection = await waitForNotification();

      assert.deepStrictEqual(
        { tabs: openTabs().length, notifications: inspection.notifications },
        { tabs: tabCount, notifications: [await message('relativeLink.notFound.message')] },
      );
    });

    it('opens a target that is not `.html` in the VS Code default editor', async () => {
      const uri = workspaceDocument();
      const target = fixtureUri(TEXT_TARGET);
      await openWysiwyg(uri);

      await requestLink(uri, TEXT_TARGET);

      await waitUntil(() => countTextTabsOf(target) === 1, 'the target opened in the default editor');
    });
  });

  describe('request validation and notification', () => {
    it('adds no tab, shows one unresolvable notification, and records one unresolvable line for a request with an encoded NUL character', async () => {
      const uri = workspaceDocument();
      await openWysiwyg(uri);
      const tabCount = openTabs().length;
      await clearInspection();

      // If the NUL character were stripped, this would point to the existing `crlf.html` and open its tab.
      await requestLink(uri, 'crlf%00.html');
      const inspection = await waitForNotification();

      assert.deepStrictEqual(
        {
          tabs: openTabs().length,
          notifications: inspection.notifications,
          logLines: inspection.logLines.map((line) => line.startsWith(UNRESOLVABLE_MARK)),
        },
        {
          tabs: tabCount,
          notifications: [await message('relativeLink.unresolvable.message')],
          logLines: [true],
        },
      );
    });

    it('adds no tab, shows one not-a-file notification, and records directory as the cause for a request to a directory within scope', async () => {
      const uri = workspaceDocument();
      await openWysiwyg(uri);
      const tabCount = openTabs().length;
      await clearInspection();

      await requestLink(uri, SUB_DIRECTORY);
      const inspection = await waitForNotification();

      assert.deepStrictEqual(
        {
          tabs: openTabs().length,
          notifications: inspection.notifications,
          logLines: inspection.logLines.map((line) => line.startsWith(NOT_FILE_MARK) && line.endsWith('("directory")')),
        },
        {
          tabs: tabCount,
          notifications: [await message('relativeLink.notFile.message')],
          logLines: [true],
        },
      );
    });

    it('shows a not-a-file notification, not outside scope, for a `./` request from a document directly in the workspace folder', async () => {
      // The base document is directly in the workspace folder, so `./` points to the scope root itself.
      const uri = workspaceDocument();
      await openWysiwyg(uri);
      await clearInspection();

      await requestLink(uri, './');
      const inspection = await waitForNotification();

      assert.deepStrictEqual(inspection.notifications, [await message('relativeLink.notFile.message')]);
    });

    it('omits the href from the notification message of a request that was not opened, while the log line for the same request contains it', async () => {
      const uri = workspaceDocument();
      await openWysiwyg(uri);
      await clearInspection();

      await requestLink(uri, MISSING_TARGET);
      const inspection = await waitForNotification();

      assert.deepStrictEqual(
        {
          notifications: inspection.notifications.map((notification) => notification.includes(MISSING_TARGET)),
          logLines: inspection.logLines.map((line) => line.includes(MISSING_TARGET)),
        },
        { notifications: [false], logLines: [true] },
      );
    });
  });

  describe('editor type used for opening', () => {
    it('opens a `.html` target in a standard text editor tab, not a WYSIWYG tab, with the default settings', async () => {
      const uri = workspaceDocument();
      const target = sameDirectoryTarget();
      await openWysiwyg(uri);

      await requestLink(uri, 'crlf.html');
      await waitUntil(() => countTextTabsOf(target) === 1, 'the target text tab opened');

      assert.strictEqual(countWysiwygTabsOf(target), 0);
    });

    it('opens a `.html` target in a WYSIWYG tab, not a text tab, when `*.html` is associated with this extension editor', async () => {
      const uri = workspaceDocument();
      const target = sameDirectoryTarget();
      await updateEditorAssociations({ '*.html': HTML_EDITOR_VIEW_TYPE });
      try {
        await openWysiwyg(uri);

        await requestLink(uri, 'crlf.html');
        await waitUntil(() => countWysiwygTabsOf(target) === 1, 'the target WYSIWYG tab opened');
        await waitForEditorEntryToClose(target);

        assert.strictEqual(countTextTabsOf(target), 0);
      } finally {
        // Later tests assume `.html` opens as text with the default settings, so restore them even on failure.
        await updateEditorAssociations(undefined);
      }
    });
  });

  describe('link target check from a custom-scheme document', () => {
    const documentUri = vscode.Uri.from({ scheme: LINK_TEST_SCHEME, authority: 'workspace', path: '/docs/base.html' });
    // Assign each path a type or failure that cannot be created on disk.
    const fileSystem = new LinkTargetFileSystem(documentUri.path, TARGET_TEXT, new Map<string, LinkTargetEntry>([
      ['/docs', vscode.FileType.Directory],
      ['/docs/unknown-entry', vscode.FileType.Unknown],
      ['/docs/dangling-link', vscode.FileType.SymbolicLink],
      ['/docs/linked.html', vscode.FileType.File | vscode.FileType.SymbolicLink],
      ['/docs/denied.html', 'noPermissions'],
      ['/docs/base.html/section.html', 'notADirectory'],
    ]));
    let registration: vscode.Disposable | undefined;

    before(() => {
      registration = vscode.workspace.registerFileSystemProvider(LINK_TEST_SCHEME, fileSystem, { isCaseSensitive: true });
    });

    after(async () => {
      await closeAllEditors();
      registration?.dispose();
      fileSystem.dispose();
    });

    it('adds no tab, shows a not-a-file notification, and records unknown as the cause for a request to an unknown entry', async () => {
      await openWysiwyg(documentUri);
      const tabCount = openTabs().length;
      await clearInspection();

      await requestLink(documentUri, 'unknown-entry');
      const inspection = await waitForNotification();

      assert.deepStrictEqual(
        {
          tabs: openTabs().length,
          notifications: inspection.notifications,
          logLines: inspection.logLines.map((line) => line.startsWith(NOT_FILE_MARK) && line.endsWith('("unknown")')),
        },
        {
          tabs: tabCount,
          notifications: [await message('relativeLink.notFile.message')],
          logLines: [true],
        },
      );
    });

    it('shows a not-a-file notification for a request to an entry whose type is only SymbolicLink', async () => {
      await openWysiwyg(documentUri);
      await clearInspection();

      // A dangling link has only SymbolicLink in its type.
      await requestLink(documentUri, 'dangling-link');
      const inspection = await waitForNotification();

      assert.deepStrictEqual(inspection.notifications, [await message('relativeLink.notFile.message')]);
    });

    it('opens the same-scheme target in a tab for a request to an entry whose type is File and SymbolicLink', async () => {
      const target = documentUri.with({ path: '/docs/linked.html' });
      await openWysiwyg(documentUri);

      await requestLink(documentUri, 'linked.html');

      await waitUntil(() => countTextTabsOf(target) === 1, 'the same-scheme target tab opened');
    });

    it('adds no tab, shows an open-failed notification, and records the query failure as the cause for a request to an entry whose query fails with no permissions', async () => {
      await openWysiwyg(documentUri);
      const tabCount = openTabs().length;
      await clearInspection();

      await requestLink(documentUri, 'denied.html');
      const inspection = await waitForNotification();

      // Handling never reaches the opening operation, so a cause indicating no permissions came from the failed query.
      assert.deepStrictEqual(
        {
          tabs: openTabs().length,
          notifications: inspection.notifications,
          logLines: inspection.logLines.map((line) => line.startsWith(OPEN_FAILED_MARK) && line.includes('NoPermissions')),
        },
        {
          tabs: tabCount,
          notifications: [await message('relativeLink.openFailed.message')],
          logLines: [true],
        },
      );
    });

    it('adds no tab and shows a not-found notification for a request to a path whose query fails because an intermediate segment is a file', async () => {
      await openWysiwyg(documentUri);
      const tabCount = openTabs().length;
      await clearInspection();

      // Traverses the base document as a directory. On Linux and macOS disks, this query fails the same way.
      await requestLink(documentUri, 'base.html/section.html');
      const inspection = await waitForNotification();

      assert.deepStrictEqual(
        { tabs: openTabs().length, notifications: inspection.notifications },
        { tabs: tabCount, notifications: [await message('relativeLink.notFound.message')] },
      );
    });
  });
});
