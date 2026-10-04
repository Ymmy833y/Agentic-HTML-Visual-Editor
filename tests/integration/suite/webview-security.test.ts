import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';

// This must match the declaration in package.json; otherwise the WYSIWYG editor cannot be opened.
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

// This must match the default id in common. The integration layer does not include common in its
// compilation unit, so repeat the value here instead of importing it.
const MESSAGE_CATALOG_ELEMENT_ID = 'ahve-message-catalog';

// These must match the meta names and the message type in common, repeated for the same reason as the catalog id.
const SIDEBAR_LAYOUT_META_NAME = { open: 'ahve-sidebar-open', width: 'ahve-sidebar-width' } as const;
const SIDEBAR_LAYOUT_CHANGED = 'sidebarLayoutChanged';

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
  injectViewMessage(documentUri: string, message: unknown): Promise<boolean>;
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

function readMetaContent(html: string, name: string): string {
  const matched = new RegExp(`<meta name="${name}" content="([^"]*)">`).exec(html);
  assert.ok(matched, `The document does not declare ${name}`);
  return matched[1];
}

// Delivers a message to the host as though the view of the document sent it, waiting for the view's session to be
// registered first. Only messages that may be delivered more than once are passed here.
async function deliverViewMessage(uri: vscode.Uri, message: unknown): Promise<void> {
  const api = await findExtension().activate();
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  while (!await api.injectViewMessage(uri.toString(), message)) {
    assert.ok(Date.now() < deadline, `No session is registered for ${uri.toString()}`);
    await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));
  }
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

  it('keeps the sidebar layout changes a view sends, each over the other, and declares the result in the document of the next view', async () => {
    const first = insideWorkspaceUri('sample.html');
    const next = insideWorkspaceUri('empty.html');
    await openInWysiwyg(first);
    await deliverViewMessage(first, { type: SIDEBAR_LAYOUT_CHANGED, width: 321 });
    await deliverViewMessage(first, { type: SIDEBAR_LAYOUT_CHANGED, open: true });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    try {
      const html = (await openInWysiwyg(next)).html;

      assert.deepStrictEqual(
        [readMetaContent(html, SIDEBAR_LAYOUT_META_NAME.open), readMetaContent(html, SIDEBAR_LAYOUT_META_NAME.width)],
        ['true', '321'],
      );
    } finally {
      // The layout is kept for every file across the run, so the suites after this one start closed again.
      await deliverViewMessage(next, { type: SIDEBAR_LAYOUT_CHANGED, open: false });
    }
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
