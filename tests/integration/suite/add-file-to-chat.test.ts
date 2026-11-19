import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { waitForEditorEntryToClose } from '../helpers/editor-tabs';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

// These must be spelled the same as the declarations in package.json and the extension's registration. If they
// disagree, neither the button nor the palette can run the command.
const ADD_FILE_TO_CHAT = 'ahve.addFileToChat';
const CHAT_ATTACH_FILE = 'workbench.action.chat.attachFile';

// VS Code evaluates the display condition from the declaration and the context keys, without the extension's code.
// The declaration itself is what is verified.
const ADD_FILE_TO_CHAT_WHEN =
  'activeCustomEditorId == ahve.documentEditor && resourceFilename =~ /\\.html$/i'
  + ' && resourceScheme =~ /^(file|vscode-remote)$/ && chatIsEnabled && ahve.supportsChatFileAttach';

// Every line the command writes when it attaches nothing starts with this.
const NOT_ADDED_LOG_PREFIX = 'Did not add a file to chat';

interface ExtensionApi {
  readDiagnosticInspection(): {
    readonly notifications: readonly string[];
    readonly logLines: readonly string[];
  };
  clearDiagnosticInspection(): void;
  addFileToChatForTest(argument: unknown): Promise<readonly string[]>;
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

// packageJSON is exposed as an untyped value, so check its shape right before reading it.
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    assert.fail(`${label} is not an object`);
  }
  // The check just above established that this is an object, so reading it by key is safe.
  return value as Record<string, unknown>;
}

function readContributes(): Record<string, unknown> {
  return asRecord(asRecord(findExtension().packageJSON, 'package.json')['contributes'], 'contributes');
}

function findMenuItem(menuId: string, command: string): Record<string, unknown> | undefined {
  const menu = asRecord(readContributes()['menus'], 'contributes.menus')[menuId];
  assert.ok(Array.isArray(menu), `contributes.menus.${menuId} is not an array`);
  return menu
    .map((item: unknown) => asRecord(item, `contributes.menus.${menuId}[]`))
    .find((item) => item['command'] === command);
}

function findCommand(command: string): Record<string, unknown> {
  const commands = readContributes()['commands'];
  assert.ok(Array.isArray(commands), 'contributes.commands is not an array');
  const found: unknown = commands.find((entry: unknown) => asRecord(entry, 'command')['command'] === command);
  return asRecord(found, command);
}

async function notAddedLogLines(): Promise<readonly string[]> {
  return (await api()).readDiagnosticInspection().logLines.filter((line) => line.includes(NOT_ADDED_LOG_PREFIX));
}

async function openWysiwyg(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
  // If the next step runs before the entry closes, the actual editor that the entry opens late takes the front.
  await waitForEditorEntryToClose(uri);
}

describe('display conditions of "Add File to Chat"', () => {
  it('places the button right of "Open in HTML", shown for an .html file in the actual editor when chat can take it', () => {
    const item = findMenuItem('editor/title', ADD_FILE_TO_CHAT);

    assert.deepStrictEqual(item, { command: ADD_FILE_TO_CHAT, group: 'navigation@1', when: ADD_FILE_TO_CHAT_WHEN });
  });

  it('gives the palette item the same condition as the button', () => {
    assert.strictEqual(findMenuItem('commandPalette', ADD_FILE_TO_CHAT)?.['when'], ADD_FILE_TO_CHAT_WHEN);
  });

  it('resolves the title and the category from the message resources instead of leaving them as keys', () => {
    const declaration = findCommand(ADD_FILE_TO_CHAT);

    assert.deepStrictEqual([declaration['title'], declaration['category']], ['Add File to Chat', 'Visual Editor']);
  });
});

describe('running "Add File to Chat"', () => {
  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllGroups');
    (await api()).clearDiagnosticInspection();
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllGroups');
  });

  // Handing a file to the chat opens the chat view and moves focus there, so these two run the command's path with
  // only the attach port swapped for one that records what it is given.
  it('hands the source file of the active WYSIWYG to the chat when run without an argument', async () => {
    const uri = fixtureUri('sample.html');
    await openWysiwyg(uri);

    const attached = await (await api()).addFileToChatForTest(undefined);

    assert.deepStrictEqual(attached, [uri.toString()]);
  });

  it('hands the source file to the chat when run with the WYSIWYG tab\'s editor resource URI', async () => {
    const uri = fixtureUri('sample.html');
    await openWysiwyg(uri);
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputCustom);

    const attached = await (await api()).addFileToChatForTest(input.uri);

    assert.deepStrictEqual(attached, [uri.toString()]);
  });

  it('attaches nothing, writes one line to the diagnostic log, and shows no notification when given a value that is not a URI', async () => {
    await vscode.commands.executeCommand(ADD_FILE_TO_CHAT, fixtureUri('sample.html').toString());

    assert.deepStrictEqual(
      {
        logLines: (await notAddedLogLines()).length,
        notifications: (await api()).readDiagnosticInspection().notifications,
      },
      { logLines: 1, notifications: [] },
    );
  });

  it('attaches nothing, writes one line to the diagnostic log, and shows no notification when run without an argument while no WYSIWYG is active', async () => {
    await vscode.window.showTextDocument(fixtureUri('sample.html'), { preview: false });

    await vscode.commands.executeCommand(ADD_FILE_TO_CHAT);

    assert.deepStrictEqual(
      {
        logLines: (await notAddedLogLines()).length,
        notifications: (await api()).readDiagnosticInspection().notifications,
      },
      { logLines: 1, notifications: [] },
    );
  });
});

describe('the VS Code command that "Add File to Chat" hands the file to', () => {
  it('is registered in the VS Code under test', async () => {
    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes(CHAT_ATTACH_FILE), `${CHAT_ATTACH_FILE} is not registered in this VS Code`);
  });
});
