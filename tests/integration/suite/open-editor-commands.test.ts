import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { customTabMatchesSource, waitForEditorEntryToClose } from '../helpers/editor-tabs';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

// These must be spelled the same as the declarations in package.json. If they disagree, neither the buttons nor the
// palette can run the commands.
const OPEN_IN_WYSIWYG = 'ahve.openInWysiwygEditor';
const OPEN_IN_HTML = 'ahve.openInHtmlEditor';

// VS Code evaluates the display conditions from the declarations alone, without the extension's code. The
// declarations themselves are what is verified.
const OPEN_IN_WYSIWYG_WHEN =
  'activeEditor == workbench.editors.files.textFileEditor && resourceFilename =~ /\\.html$/i';
const OPEN_IN_HTML_WHEN =
  'activeCustomEditorId =~ /^ahve\\.(documentEditor|editor)$/ && resourceFilename =~ /\\.html$/i';

interface ExtensionApi {
  getMessage(key: string): string;
  readDiagnosticInspection(): {
    readonly notifications: readonly string[];
    readonly logLines: readonly string[];
  };
  clearDiagnosticInspection(): void;
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

function openTabs(): readonly vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

function activeTab(): vscode.Tab | undefined {
  return vscode.window.tabGroups.activeTabGroup.activeTab;
}

function isTextTabOf(tab: vscode.Tab | undefined, uri: vscode.Uri): boolean {
  return tab?.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString();
}

async function openWysiwyg(uri: vscode.Uri, viewColumn?: vscode.ViewColumn): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE, viewColumn);
  // If the next step runs before the entry closes, the actual editor that the entry opens late takes the front.
  await waitForEditorEntryToClose(uri);
}

async function openText(uri: vscode.Uri, viewColumn?: vscode.ViewColumn): Promise<void> {
  await vscode.window.showTextDocument(uri, { viewColumn, preview: false });
}

async function logLinesOf(command: string): Promise<readonly string[]> {
  return (await api()).readDiagnosticInspection().logLines.filter((line) => line.includes(command));
}

describe('display conditions of "Open in WYSIWYG" and "Open in HTML"', () => {
  it('shows the "Open in WYSIWYG" button when the active editor is the standard text editor and the file name ends with .html', () => {
    const item = findMenuItem('editor/title', OPEN_IN_WYSIWYG);

    assert.deepStrictEqual(item, { command: OPEN_IN_WYSIWYG, group: 'navigation', when: OPEN_IN_WYSIWYG_WHEN });
  });

  it('shows the "Open in HTML" button when the active editor is this extension\'s actual editor or entry and the file name ends with .html', () => {
    const item = findMenuItem('editor/title', OPEN_IN_HTML);

    assert.deepStrictEqual(item, { command: OPEN_IN_HTML, group: 'navigation', when: OPEN_IN_HTML_WHEN });
  });

  it('gives both commands the same palette conditions as their buttons', () => {
    const palette = [OPEN_IN_WYSIWYG, OPEN_IN_HTML].map((command) => findMenuItem('commandPalette', command)?.['when']);

    // Both would match as undefined if both declarations were missing, so compare directly with the same expected
    // values the buttons use.
    assert.deepStrictEqual(palette, [OPEN_IN_WYSIWYG_WHEN, OPEN_IN_HTML_WHEN]);
  });

  it('keeps save, undo, and redo hidden from the palette and off the title bar', () => {
    const commands = ['ahve.save', 'ahve.undo', 'ahve.redo'];

    assert.deepStrictEqual(
      {
        palette: commands.map((command) => findMenuItem('commandPalette', command)?.['when']),
        title: commands.map((command) => findMenuItem('editor/title', command)),
      },
      { palette: ['false', 'false', 'false'], title: [undefined, undefined, undefined] },
    );
  });

  it('resolves both commands\' titles and categories from the message resources instead of leaving them as keys', () => {
    const labels = [OPEN_IN_WYSIWYG, OPEN_IN_HTML].flatMap((command) => {
      const declaration = findCommand(command);
      return [declaration['title'], declaration['category']];
    });

    assert.deepStrictEqual(labels, ['Open in WYSIWYG', 'Visual Editor', 'Open in HTML', 'Visual Editor']);
  });
});

describe('running "Open in WYSIWYG" and "Open in HTML"', () => {
  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllGroups');
    (await api()).clearDiagnosticInspection();
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllGroups');
  });

  describe('determining the target', () => {
    it('opens WYSIWYG for the same file when "Open in WYSIWYG" runs without an argument while an .html text tab is active', async () => {
      const uri = fixtureUri('sample.html');
      await openText(uri);

      await vscode.commands.executeCommand(OPEN_IN_WYSIWYG);

      assert.ok(customTabMatchesSource(activeTab() ?? assert.fail('There is no active tab'), uri));
    });

    it('opens a text tab for the same file when "Open in HTML" runs without an argument while WYSIWYG is active', async () => {
      const uri = fixtureUri('sample.html');
      await openWysiwyg(uri);

      await vscode.commands.executeCommand(OPEN_IN_HTML);

      assert.ok(isTextTabOf(activeTab(), uri));
    });

    it('opens a text tab with the source URI when "Open in HTML" runs with the WYSIWYG tab\'s editor resource URI', async () => {
      const uri = fixtureUri('sample.html');
      await openWysiwyg(uri);
      const input = activeTab()?.input;
      assert.ok(input instanceof vscode.TabInputCustom);

      await vscode.commands.executeCommand(OPEN_IN_HTML, input.uri);

      assert.ok(isTextTabOf(activeTab(), uri));
    });

    it('opens the file passed as the argument from another group, not the active tab of the active group', async () => {
      const argumentUri = fixtureUri('sample.html');
      await openText(argumentUri, vscode.ViewColumn.One);
      await openText(fixtureUri('crlf.html'), vscode.ViewColumn.Two);

      await vscode.commands.executeCommand(OPEN_IN_WYSIWYG, argumentUri);

      assert.ok(customTabMatchesSource(activeTab() ?? assert.fail('There is no active tab'), argumentUri));
    });

    it('opens a text tab with "Open in HTML" even while WYSIWYG for an unopenable document (an empty .html) is active', async () => {
      const uri = fixtureUri('empty.html');
      await openWysiwyg(uri);

      await vscode.commands.executeCommand(OPEN_IN_HTML);

      assert.ok(isTextTabOf(activeTab(), uri));
    });

    it('opens nothing, writes one line to the diagnostic log, and shows no notification when given a non-.html URI', async () => {
      await vscode.commands.executeCommand(OPEN_IN_WYSIWYG, fixtureUri('sample.htm'));

      assert.deepStrictEqual(
        {
          tabs: openTabs().length,
          logLines: (await logLinesOf(OPEN_IN_WYSIWYG)).length,
          notifications: (await api()).readDiagnosticInspection().notifications,
        },
        { tabs: 0, logLines: 1, notifications: [] },
      );
    });

    it('opens nothing and writes one line to the diagnostic log when given a value that is not a URI', async () => {
      await vscode.commands.executeCommand(OPEN_IN_WYSIWYG, fixtureUri('sample.html').toString());

      assert.deepStrictEqual(
        { tabs: openTabs().length, logLines: (await logLinesOf(OPEN_IN_WYSIWYG)).length },
        { tabs: 0, logLines: 1 },
      );
    });

    it('opens nothing and writes one line to the diagnostic log when "Open in WYSIWYG" runs without an argument while WYSIWYG is active', async () => {
      await openWysiwyg(fixtureUri('sample.html'));

      await vscode.commands.executeCommand(OPEN_IN_WYSIWYG);

      assert.deepStrictEqual(
        { tabs: openTabs().length, logLines: (await logLinesOf(OPEN_IN_WYSIWYG)).length },
        { tabs: 1, logLines: 1 },
      );
    });
  });

  describe('opening in the other editor', () => {
    it('replaces the original text tab in the active group with WYSIWYG on "Open in WYSIWYG"', async () => {
      const uri = fixtureUri('sample.html');
      await openText(uri);

      await vscode.commands.executeCommand(OPEN_IN_WYSIWYG);

      assert.deepStrictEqual(
        vscode.window.tabGroups.all.map((group) => group.tabs.map((tab) => ({
          text: isTextTabOf(tab, uri),
          wysiwyg: customTabMatchesSource(tab, uri),
        }))),
        [[{ text: false, wysiwyg: true }]],
      );
    });

    it('replaces WYSIWYG in the active group with a standard text editor tab on "Open in HTML"', async () => {
      const uri = fixtureUri('sample.html');
      await openWysiwyg(uri);

      await vscode.commands.executeCommand(OPEN_IN_HTML);

      assert.deepStrictEqual(
        vscode.window.tabGroups.all.map((group) => group.tabs.map((tab) => ({
          text: isTextTabOf(tab, uri),
          wysiwyg: customTabMatchesSource(tab, uri),
        }))),
        [[{ text: true, wysiwyg: false }]],
      );
    });

    it('opens a non-preview tab with "Open in WYSIWYG"', async () => {
      await openText(fixtureUri('sample.html'));

      await vscode.commands.executeCommand(OPEN_IN_WYSIWYG);

      assert.strictEqual(activeTab()?.isPreview, false);
    });

    it('opens a non-preview tab with "Open in HTML"', async () => {
      await openWysiwyg(fixtureUri('sample.html'));

      await vscode.commands.executeCommand(OPEN_IN_HTML);

      assert.strictEqual(activeTab()?.isPreview, false);
    });

    it('brings the existing WYSIWYG to the front without adding a tab when WYSIWYG for the same file is in another group', async () => {
      const uri = fixtureUri('sample.html');
      await openText(uri, vscode.ViewColumn.One);
      await openWysiwyg(uri, vscode.ViewColumn.Two);
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');

      await vscode.commands.executeCommand(OPEN_IN_WYSIWYG);

      assert.deepStrictEqual(
        {
          wysiwygTabs: openTabs().filter((tab) => customTabMatchesSource(tab, uri)).length,
          activeIsWysiwyg: customTabMatchesSource(activeTab() ?? assert.fail('There is no active tab'), uri),
        },
        { wysiwygTabs: 1, activeIsWysiwyg: true },
      );
    });

    it('adds no tab and leaves a notification and a logged cause when "Open in HTML" targets a missing .html', async () => {
      const missing = fixtureUri('missing-open-target.html');
      const extensionApi = await api();

      await vscode.commands.executeCommand(OPEN_IN_HTML, missing);

      const inspection = extensionApi.readDiagnosticInspection();
      assert.deepStrictEqual(
        {
          tabs: openTabs().length,
          notifications: inspection.notifications,
          causeLogged: inspection.logLines.some((line) => line.includes('missing-open-target.html')),
        },
        {
          tabs: 0,
          notifications: [extensionApi.getMessage('openInHtml.failed.message')],
          causeLogged: true,
        },
      );
    });
  });
});
