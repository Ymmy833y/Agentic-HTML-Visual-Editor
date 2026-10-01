import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { readEditorSource, waitForEditorEntryToClose } from '../helpers/editor-tabs';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';

// This must match the declaration in package.json. The explicit-open case fails if the declaration
// and registration diverge.
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

const activationIt = process.platform === 'darwin' ? it.skip : it;

// Evaluated before any test case. Whether the extension code remains dormant until an editor opens
// can only be verified from this value.
const wasActiveBeforeAnyCase = vscode.extensions.getExtension<unknown>(EXTENSION_ID)?.isActive;

function findExtension(): vscode.Extension<unknown> {
  // Omitting the type argument makes exports any, so use unknown explicitly.
  const extension = vscode.extensions.getExtension<unknown>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} is not loaded by VS Code`);
  return extension;
}

function fixtureUri(fileName: string): vscode.Uri {
  // The extension path supplied to the Extension Development Host is the repository root.
  return vscode.Uri.joinPath(findExtension().extensionUri, 'tests', 'integration', 'fixtures', fileName);
}

// packageJSON is exposed as an untyped value, so validate its shape immediately before reading it.
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    assert.fail(`${label} is not an object`);
  }
  // Index access is safe because the preceding check established that this is an object.
  return value as Record<string, unknown>;
}

function readPackageJson(): Record<string, unknown> {
  return asRecord(findExtension().packageJSON, 'package.json');
}

function readCustomEditorDeclaration(): Record<string, unknown> {
  const contributes = asRecord(readPackageJson()['contributes'], 'contributes');
  const customEditors = contributes['customEditors'];
  assert.ok(Array.isArray(customEditors), 'contributes.customEditors is not an array');
  assert.strictEqual(customEditors.length, 2, 'declarations for both the entry and the actual editor are required');
  return asRecord(customEditors[0], 'contributes.customEditors[0]');
}

function openTabs(): readonly vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

function activeTabInput(): unknown {
  return vscode.window.tabGroups.activeTabGroup.activeTab?.input;
}

// The extension is activated only once, so the transition cannot be observed if a case in another
// test file activates it first. Root hooks run before cases in every file, making this the only place
// where the states before and after opening can be captured.
let wasActiveBeforeOpeningEditor: boolean | undefined;
let wasActiveAfterOpeningEditor: boolean | undefined;

before(async () => {
  const extension = findExtension();
  wasActiveBeforeOpeningEditor = extension.isActive;

  await vscode.commands.executeCommand('vscode.openWith', fixtureUri('sample.html'), HTML_EDITOR_VIEW_TYPE);

  wasActiveAfterOpeningEditor = extension.isActive;
  // On the macOS CI runner, vscode.openWith can return without firing the custom-editor activation path.
  // Record that platform behavior for the dedicated activation case, then activate explicitly so the remaining
  // registration tests still exercise the real providers instead of aborting the whole suite in the root hook.
  if (!extension.isActive) {
    await extension.activate();
  }
});

describe('Custom editor registration', () => {
  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('is not activated before any test case runs', () => {
    assert.strictEqual(wasActiveBeforeAnyCase, false);
  });

  activationIt('activates the extension when opened in the WYSIWYG editor', () => {
    assert.strictEqual(wasActiveBeforeOpeningEditor, false, 'Extension was activated before the editor opened');
    assert.strictEqual(wasActiveAfterOpeningEditor, true);
  });

  it("opens in VS Code's text editor by default", async () => {
    await vscode.commands.executeCommand('vscode.open', fixtureUri('sample.html'));

    assert.ok(activeTabInput() instanceof vscode.TabInputText, 'The default tab is not a text editor');
  });

  it("opens in this extension's custom editor when the view type is specified", async () => {
    await vscode.commands.executeCommand('vscode.openWith', fixtureUri('sample.html'), HTML_EDITOR_VIEW_TYPE);

    const input = activeTabInput();
    assert.ok(
      input instanceof vscode.TabInputCustom && input.viewType === 'ahve.documentEditor',
      "The opened tab is not this extension's custom editor",
    );
    assert.notStrictEqual(input.uri.toString(), fixtureUri('sample.html').toString());
    assert.strictEqual(readEditorSource(input.uri).toString(), fixtureUri('sample.html').toString());
    assert.strictEqual(input.uri.path, fixtureUri('sample.html').path);
  });

  it('can open the same file in the text editor and WYSIWYG editor simultaneously', async () => {
    const uri = fixtureUri('sample.html');
    await vscode.commands.executeCommand('vscode.open', uri);
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
    await waitForEditorEntryToClose(uri);

    assert.strictEqual(openTabs().length, 2);
  });

  it('reuses the tab when the same file is opened twice in the WYSIWYG editor', async () => {
    const uri = fixtureUri('sample.html');
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
    await waitForEditorEntryToClose(uri);

    assert.strictEqual(openTabs().length, 1);
  });

  // Reopening within the same group always reuses the tab, so the preceding case passes regardless
  // of the registration option. The option that disallows multiple editors for one document takes
  // effect only when opening it in another editor group.
  it('keeps a single tab when the same file is opened in another editor group', async () => {
    const uri = fixtureUri('sample.html');
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE, vscode.ViewColumn.Beside);
    await waitForEditorEntryToClose(uri);

    assert.strictEqual(openTabs().length, 1);
  });

  it('opens an empty .html file in the WYSIWYG editor without throwing', async () => {
    await vscode.commands.executeCommand('vscode.openWith', fixtureUri('empty.html'), HTML_EDITOR_VIEW_TYPE);

    assert.ok(activeTabInput() instanceof vscode.TabInputCustom, 'The empty file did not open in a custom editor tab');
  });

  it('can reopen a file in the WYSIWYG editor after closing its tab', async () => {
    const uri = fixtureUri('sample.html');
    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);

    assert.ok(activeTabInput() instanceof vscode.TabInputCustom, 'The file did not reopen after its tab was closed');
  });

  it('does not open a tab when the extension is activated explicitly', async () => {
    await findExtension().activate();

    assert.strictEqual(openTabs().length, 0);
  });

  it('declares no explicit activation events', () => {
    const activationEvents = readPackageJson()['activationEvents'];

    assert.ok(Array.isArray(activationEvents), 'activationEvents is not an array');
    assert.strictEqual(activationEvents.length, 0);
  });

  it('declares a priority that opens the editor only when explicitly selected', () => {
    assert.strictEqual(readCustomEditorDeclaration()['priority'], 'option');
  });

  it('declares unrestricted support for untrusted and virtual workspaces', () => {
    const capabilities = asRecord(readPackageJson()['capabilities'], 'capabilities');
    const untrustedWorkspaces = asRecord(capabilities['untrustedWorkspaces'], 'capabilities.untrustedWorkspaces');

    assert.strictEqual(untrustedWorkspaces['supported'], true);
    assert.strictEqual(capabilities['virtualWorkspaces'], true);
  });
});
