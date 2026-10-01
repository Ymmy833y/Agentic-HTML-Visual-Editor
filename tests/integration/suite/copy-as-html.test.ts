import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { customTabMatchesSource, waitForEditorEntryToClose } from '../helpers/editor-tabs';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

// Unless spelled the same as the declaration in package.json, the command cannot be run from the palette or a key.
const COPY_AS_HTML = 'ahve.copyAsHtml';
const OPEN_IN_HTML = 'ahve.openInHtmlEditor';

// Upper bound and polling interval for waiting on the view to load, the copy round trip, and tab state changes.
const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

// String put on the clipboard before running. If it is still there, the clipboard has not changed.
const SENTINEL = 'ahve-copy-as-html-sentinel';

interface RecordedMessage {
  readonly direction: 'fromView' | 'toView';
  readonly message: unknown;
}

interface ExtensionApi {
  getMessage(key: string): string;
  readWebviewInspection(documentUri: string): { readonly messages: readonly RecordedMessage[] } | undefined;
  readSessionInspection(): { readonly activeDocumentUri: string | undefined };
  readDiagnosticInspection(): {
    readonly notifications: readonly string[];
    readonly logLines: readonly string[];
  };
  clearDiagnosticInspection(): void;
  injectViewMessage(documentUri: string, message: unknown): Promise<boolean>;
}

function findExtension(): vscode.Extension<ExtensionApi> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `extension ${EXTENSION_ID} is not loaded in VS Code`);
  return extension;
}

async function api(): Promise<ExtensionApi> {
  return findExtension().activate();
}

function fixtureUri(fileName: string): vscode.Uri {
  return vscode.Uri.joinPath(findExtension().extensionUri, 'tests', 'integration', 'fixtures', fileName);
}

// packageJSON is passed as an untyped value, so check its shape right before reading it.
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    assert.fail(`${label} is not an object`);
  }
  // The check just above established that it is an object, so reading it by key is fine.
  return value as Record<string, unknown>;
}

function readContributes(): Record<string, unknown> {
  return asRecord(asRecord(findExtension().packageJSON, 'package.json')['contributes'], 'contributes');
}

function readArray(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} is not an array`);
  return value;
}

function findMenuItem(menuId: string, command: string): Record<string, unknown> | undefined {
  return readArray(asRecord(readContributes()['menus'], 'contributes.menus')[menuId], `contributes.menus.${menuId}`)
    .map((item) => asRecord(item, `contributes.menus.${menuId}[]`))
    .find((item) => item['command'] === command);
}

function findCommand(command: string): Record<string, unknown> {
  const found = readArray(readContributes()['commands'], 'contributes.commands')
    .find((entry) => asRecord(entry, 'command')['command'] === command);
  return asRecord(found, command);
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
    assert.ok(Date.now() < deadline, `timed out waiting until ${description}`);
    await delay(POLLING_INTERVAL_MS);
  }
}

// Wait until initialize has been sent. Running without waiting could deliver the copy HTML request to a view that
// has not mounted yet.
async function openWysiwyg(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
  await waitForEditorEntryToClose(uri);
  await waitUntil(
    async () => ((await api()).readWebviewInspection(uri.toString())?.messages ?? []).some(
      (recorded) => recorded.direction === 'toView'
        && typeof recorded.message === 'object'
        && recorded.message !== null
        && Reflect.get(recorded.message, 'type') === 'initialize',
    ),
    'the view receives initialize',
  );
}

// The command copies the session active at the time of execution, so wait until the panel becomes active.
async function waitForActiveSession(uri: vscode.Uri): Promise<void> {
  await waitUntil(
    async () => (await api()).readSessionInspection().activeDocumentUri === uri.toString(),
    'the WYSIWYG session becomes active',
  );
}

async function openText(uri: vscode.Uri, viewColumn?: vscode.ViewColumn): Promise<void> {
  await vscode.window.showTextDocument(uri, { viewColumn, preview: false });
}

// The messages of the type sent to the panel of the document, in the order sent.
async function readMessagesToView(uri: vscode.Uri, type: string): Promise<unknown[]> {
  return ((await api()).readWebviewInspection(uri.toString())?.messages ?? [])
    .filter((recorded) => recorded.direction === 'toView'
      && typeof recorded.message === 'object'
      && recorded.message !== null
      && Reflect.get(recorded.message, 'type') === type)
    .map((recorded) => recorded.message);
}

// The copy succeeded messages sent to the panel of the document, in the order sent.
async function readCopySucceededMessages(uri: vscode.Uri): Promise<unknown[]> {
  return readMessagesToView(uri, 'copySucceeded');
}

describe('declaring "Copy as HTML"', () => {
  it('uses the same palette condition string for "Copy as HTML" as for "Open in HTML"', () => {
    const copyWhen = findMenuItem('commandPalette', COPY_AS_HTML)?.['when'];
    const openWhen = findMenuItem('commandPalette', OPEN_IN_HTML)?.['when'];

    // If neither declaration exists, both are undefined and match, so also check that it is a string.
    assert.deepStrictEqual([typeof copyWhen, copyWhen], ['string', openWhen]);
  });

  it('does not declare "Copy as HTML" in the title bar or in keybindings', () => {
    const keybindings = readArray(readContributes()['keybindings'], 'contributes.keybindings')
      .filter((entry) => asRecord(entry, 'keybinding')['command'] === COPY_AS_HTML);

    assert.deepStrictEqual([findMenuItem('editor/title', COPY_AS_HTML), keybindings], [undefined, []]);
  });

  it('resolves the title and category to Copy as HTML and Visual Editor rather than leaving placeholders', () => {
    const declaration = findCommand(COPY_AS_HTML);

    assert.deepStrictEqual([declaration['title'], declaration['category']], ['Copy as HTML', 'Visual Editor']);
  });
});

describe('running "Copy as HTML"', () => {
  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllGroups');
    await vscode.env.clipboard.writeText(SENTINEL);
    (await api()).clearDiagnosticInspection();
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllGroups');
  });

  it('sets the clipboard to <p>sample</p> when the command runs with the sample.html WYSIWYG in front', async () => {
    const uri = fixtureUri('sample.html');
    await openWysiwyg(uri);
    await waitForActiveSession(uri);

    await vscode.commands.executeCommand(COPY_AS_HTML);

    assert.strictEqual(await vscode.env.clipboard.readText(), '<p>sample</p>');
  });

  it('shows one no-target notification, logs nothing about the copy, and leaves the clipboard unchanged when the command runs with a standard text editor in front', async () => {
    const extensionApi = await api();
    await openText(fixtureUri('sample.html'));
    // Clear right before running so that late log lines from closing tabs do not get mixed in.
    extensionApi.clearDiagnosticInspection();

    await vscode.commands.executeCommand(COPY_AS_HTML);

    assert.deepStrictEqual(
      {
        notifications: extensionApi.readDiagnosticInspection().notifications,
        logLines: extensionApi.readDiagnosticInspection().logLines,
        clipboard: await vscode.env.clipboard.readText(),
      },
      {
        notifications: [extensionApi.getMessage('copyAsHtml.noTarget.message')],
        logLines: [],
        clipboard: SENTINEL,
      },
    );
  });

  it('writes the HTML of the active session\'s body even when run with another file\'s URI as an argument', async () => {
    const uri = fixtureUri('sample.html');
    await openWysiwyg(uri);
    await waitForActiveSession(uri);

    await vscode.commands.executeCommand(COPY_AS_HTML, fixtureUri('crlf.html'));

    assert.strictEqual(await vscode.env.clipboard.readText(), '<p>sample</p>');
  });

  it('writes the HTML of the sender\'s body when a copy request is injected into a WYSIWYG session while a standard text editor stays in front', async () => {
    const uri = fixtureUri('sample.html');
    await openWysiwyg(uri);
    await openText(fixtureUri('crlf.html'), vscode.ViewColumn.Two);
    await waitUntil(
      async () => (await api()).readSessionInspection().activeDocumentUri === undefined,
      'the standard text editor comes to the front',
    );

    assert.ok(
      await (await api()).injectViewMessage(uri.toString(), { type: 'copyRequested' }),
      'could not deliver the copy request because there is no session',
    );

    await waitUntil(
      async () => await vscode.env.clipboard.readText() === '<p>sample</p>',
      'the HTML of the sender\'s body is on the clipboard',
    );
  });

  it('shows one failure notification, logs the cause, and leaves the clipboard unchanged when run with the WYSIWYG of an unopenable document (an empty .html) in front', async () => {
    const extensionApi = await api();
    const uri = fixtureUri('empty.html');
    await openWysiwyg(uri);
    await waitForActiveSession(uri);
    extensionApi.clearDiagnosticInspection();

    await vscode.commands.executeCommand(COPY_AS_HTML);

    assert.deepStrictEqual(
      {
        notifications: extensionApi.readDiagnosticInspection().notifications,
        logLines: extensionApi.readDiagnosticInspection().logLines.length,
        clipboard: await vscode.env.clipboard.readText(),
      },
      {
        notifications: [extensionApi.getMessage('copyAsHtml.failed.message')],
        logLines: 1,
        clipboard: SENTINEL,
      },
    );
  });

  it('does not make the WYSIWYG tab dirty after the command writes', async () => {
    const uri = fixtureUri('sample.html');
    await openWysiwyg(uri);
    await waitForActiveSession(uri);

    await vscode.commands.executeCommand(COPY_AS_HTML);

    assert.deepStrictEqual(
      [await vscode.env.clipboard.readText(), findCustomTab(uri)?.isDirty],
      ['<p>sample</p>', false],
    );
  });

  it('sends exactly one copy succeeded message to the view after writing when a copy request is injected into a WYSIWYG session', async () => {
    const uri = fixtureUri('sample.html');
    await openWysiwyg(uri);

    assert.ok(
      await (await api()).injectViewMessage(uri.toString(), { type: 'copyRequested' }),
      'could not deliver the copy request because there is no session',
    );
    await waitUntil(
      async () => (await readCopySucceededMessages(uri)).length > 0,
      'the view receives a copy succeeded message',
    );

    assert.deepStrictEqual(
      [await vscode.env.clipboard.readText(), await readCopySucceededMessages(uri)],
      ['<p>sample</p>', [{ type: 'copySucceeded' }]],
    );
  });

  it('writes the clipboard but sends no copy succeeded message to the view when the command runs with the WYSIWYG in front', async () => {
    const uri = fixtureUri('sample.html');
    await openWysiwyg(uri);
    await waitForActiveSession(uri);

    await vscode.commands.executeCommand(COPY_AS_HTML);

    assert.deepStrictEqual(
      [await vscode.env.clipboard.readText(), await readCopySucceededMessages(uri)],
      ['<p>sample</p>', []],
    );
  });
});

describe('copying the code of a code block', () => {
  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllGroups');
    await vscode.env.clipboard.writeText(SENTINEL);
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllGroups');
  });

  it('puts the text on the clipboard and sends exactly one code block copy succeeded message to the view when a code block copy request is injected into a WYSIWYG session', async () => {
    const uri = fixtureUri('sample.html');
    await openWysiwyg(uri);

    assert.ok(
      await (await api()).injectViewMessage(uri.toString(), { type: 'codeBlockCopyRequested', text: 'line 1\n  line 2' }),
      'could not deliver the code block copy request because there is no session',
    );
    await waitUntil(
      async () => (await readMessagesToView(uri, 'codeBlockCopySucceeded')).length > 0,
      'the view receives a code block copy succeeded message',
    );

    assert.deepStrictEqual(
      [await vscode.env.clipboard.readText(), await readMessagesToView(uri, 'codeBlockCopySucceeded')],
      ['line 1\n  line 2', [{ type: 'codeBlockCopySucceeded' }]],
    );
  });
});
