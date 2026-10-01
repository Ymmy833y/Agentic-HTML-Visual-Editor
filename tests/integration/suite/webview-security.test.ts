import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';

// This must match the declaration in package.json; otherwise the WYSIWYG editor cannot be opened.
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

// This must match the default id in common. The integration layer does not include common in its
// compilation unit, so repeat the value here instead of importing it.
const MESSAGE_CATALOG_ELEMENT_ID = 'ahve-message-catalog';

const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 50;

interface TabIconInspection {
  readonly light: string;
  readonly dark: string;
}

interface WebviewInspection {
  readonly html: string;
  readonly enableScripts: boolean;
  readonly enableCommandUris: boolean;
  readonly enableForms: boolean;
  readonly localResourceRoots: readonly string[];
  readonly iconPath: TabIconInspection | undefined;
}

interface ExtensionApi {
  readWebviewInspection(documentUri: string): WebviewInspection | undefined;
}

function findExtension(): vscode.Extension<ExtensionApi> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} is not loaded in VS Code`);
  return extension;
}

// The extension path passed to the Extension Development Host is the repository root.
function repositoryUri(...segments: string[]): vscode.Uri {
  return vscode.Uri.joinPath(findExtension().extensionUri, ...segments);
}

function insideWorkspaceUri(fileName: string): vscode.Uri {
  return repositoryUri('tests', 'integration', 'fixtures', fileName);
}

function outsideWorkspaceUri(fileName: string): vscode.Uri {
  return repositoryUri('tests', 'integration', 'outside-workspace', fileName);
}

async function openInWysiwyg(uri: vscode.Uri): Promise<WebviewInspection> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);

  const api = await findExtension().activate();
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  for (;;) {
    const inspection = api.readWebviewInspection(uri.toString());
    if (inspection !== undefined) {
      return inspection;
    }
    assert.ok(
      Date.now() < deadline,
      `No settings were recorded for the panel associated with ${uri.toString()}`,
    );
    await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));
  }
}

function readNonce(html: string): string {
  const matched = /content="[^"]*'nonce-([A-Za-z0-9]+)'/.exec(html);
  assert.ok(matched, 'The document does not contain a CSP with a nonce');
  return matched[1];
}

function readLanguage(html: string): string {
  const matched = /<html lang="([^"]*)"/.exec(html);
  assert.ok(matched, 'The document does not declare a language on its root element');
  return matched[1];
}

function readEmbeddedCatalogText(html: string): string {
  const matched = new RegExp(`<script[^>]*id="${MESSAGE_CATALOG_ELEMENT_ID}"[^>]*>([^<]*)</script>`).exec(html);
  assert.ok(matched, 'The document does not contain a message catalog element with the default id');
  return matched[1];
}

describe('Webview hosting and security', () => {
  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('grants the panel permission to run scripts when opened in the WYSIWYG editor', async () => {
    const inspection = await openInWysiwyg(insideWorkspaceUri('sample.html'));

    assert.strictEqual(inspection.enableScripts, true);
  });

  it('does not grant the panel permission to use command URIs', async () => {
    const inspection = await openInWysiwyg(insideWorkspaceUri('sample.html'));

    assert.strictEqual(inspection.enableCommandUris, false);
  });

  it('does not grant the panel permission to submit forms', async () => {
    const inspection = await openInWysiwyg(insideWorkspaceUri('sample.html'));

    assert.strictEqual(inspection.enableForms, false);
  });

  it('writes a document containing a CSP with a nonce', async () => {
    const inspection = await openInWysiwyg(insideWorkspaceUri('sample.html'));

    assert.ok(readNonce(inspection.html).length > 0);
  });

  it('uses a different document nonce after closing and reopening the same file', async () => {
    const uri = insideWorkspaceUri('sample.html');
    const first = readNonce((await openInWysiwyg(uri)).html);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const second = readNonce((await openInWysiwyg(uri)).html);

    assert.notStrictEqual(second, first);
  });

  it('sets exactly two local resource roots, including the extension bundle output', async () => {
    const inspection = await openInWysiwyg(insideWorkspaceUri('sample.html'));

    assert.strictEqual(inspection.localResourceRoots.length, 2);
    assert.ok(
      inspection.localResourceRoots.includes(repositoryUri('dist').toString()),
      `The local resource roots do not include the extension bundle output: ${inspection.localResourceRoots.join(', ')}`,
    );
  });

  it('uses the workspace folder as the other root for a file inside the workspace', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'The integration tests started without an open workspace folder');

    const inspection = await openInWysiwyg(insideWorkspaceUri('sample.html'));

    assert.ok(
      inspection.localResourceRoots.includes(workspaceFolder.uri.toString()),
      `The local resource roots do not include the workspace folder: ${inspection.localResourceRoots.join(', ')}`,
    );
  });

  it('uses the file directory as the other root for a file outside the workspace', async () => {
    const inspection = await openInWysiwyg(outsideWorkspaceUri('sample.html'));

    assert.ok(
      inspection.localResourceRoots.includes(repositoryUri('tests', 'integration', 'outside-workspace').toString()),
      `The local resource roots do not include the file directory: ${inspection.localResourceRoots.join(', ')}`,
    );
  });

  it('writes a document without throwing when an empty .html file is opened', async () => {
    const inspection = await openInWysiwyg(insideWorkspaceUri('empty.html'));

    assert.ok(inspection.html.length > 0);
  });

  it('reads the message catalog from the written document using the default id', async () => {
    const inspection = await openInWysiwyg(insideWorkspaceUri('sample.html'));

    const catalog: unknown = JSON.parse(readEmbeddedCatalogText(inspection.html));

    assert.ok(typeof catalog === 'object' && catalog !== null && !Array.isArray(catalog));
  });

  it('declares the locale of the bundled message resource on the written document', async () => {
    const inspection = await openInWysiwyg(insideWorkspaceUri('sample.html'));

    // The test VS Code has no language pack, so its display language is English and the English resource is chosen.
    assert.strictEqual(readLanguage(inspection.html), 'en');
  });

  it("gives the panel the extension's tab icons for light and dark themes", async () => {
    const inspection = await openInWysiwyg(insideWorkspaceUri('sample.html'));

    assert.deepStrictEqual(inspection.iconPath, {
      light: repositoryUri('icons', 'ahve-light.svg').toString(),
      dark: repositoryUri('icons', 'ahve-dark.svg').toString(),
    });
  });

  it('points the tab icons at files that exist', async () => {
    const inspection = await openInWysiwyg(insideWorkspaceUri('sample.html'));
    assert.ok(inspection.iconPath, 'The panel was given no tab icons');

    const light = await vscode.workspace.fs.stat(vscode.Uri.parse(inspection.iconPath.light));
    const dark = await vscode.workspace.fs.stat(vscode.Uri.parse(inspection.iconPath.dark));

    assert.deepStrictEqual([light.type, dark.type], [vscode.FileType.File, vscode.FileType.File]);
  });
});
