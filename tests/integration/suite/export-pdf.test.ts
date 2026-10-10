import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { waitForEditorEntryToClose } from '../helpers/editor-tabs';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';

// Unless spelled the same as the declaration in package.json, the command cannot be run from the palette or a key.
const EXPORT_AS_PDF = 'ahve.exportAsPdf';
const COPY_AS_HTML = 'ahve.copyAsHtml';

// Upper bound and polling interval for waiting on the view to load.
const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

interface RecordedMessage {
  readonly direction: 'fromView' | 'toView';
  readonly message: unknown;
}

interface ExtensionApi {
  getMessage(key: string): string;
  readWebviewInspection(documentUri: string): { readonly messages: readonly RecordedMessage[] } | undefined;
  readDiagnosticInspection(): {
    readonly notifications: readonly string[];
    readonly logLines: readonly string[];
  };
  clearDiagnosticInspection(): void;
  exportPdfForTest(documentUri: string, destinationUri: string): Promise<boolean>;
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

// Wait until initialize has been sent. The view handles messages in order, so a request sent after it reaches a view
// that has mounted the body.
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

describe('declaring "Export as PDF"', () => {
  it('uses the same palette condition string for "Export as PDF" as for "Copy as HTML"', () => {
    const exportWhen = findMenuItem('commandPalette', EXPORT_AS_PDF)?.['when'];
    const copyWhen = findMenuItem('commandPalette', COPY_AS_HTML)?.['when'];

    // If neither declaration exists, both are undefined and match, so also check that it is a string.
    assert.deepStrictEqual([typeof exportWhen, exportWhen], ['string', copyWhen]);
  });

  it('resolves the title and category to Export as PDF and Visual Editor rather than leaving placeholders', () => {
    const declaration = findCommand(EXPORT_AS_PDF);

    assert.deepStrictEqual([declaration['title'], declaration['category']], ['Export as PDF', 'Visual Editor']);
  });
});

describe('running "Export as PDF"', () => {
  const destination = vscode.Uri.file(path.join(os.tmpdir(), 'ahve-export-pdf-test.pdf'));

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllGroups');
    await vscode.workspace.fs.delete(destination).then(undefined, () => undefined);
    (await api()).clearDiagnosticInspection();
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllGroups');
    await vscode.workspace.fs.delete(destination).then(undefined, () => undefined);
  });

  it('shows one no-target notification when the command runs with a standard text editor in front', async () => {
    const extensionApi = await api();
    await vscode.window.showTextDocument(fixtureUri('sample.html'), { preview: false });
    // Clear right before running so that late log lines from closing tabs do not get mixed in.
    extensionApi.clearDiagnosticInspection();

    await vscode.commands.executeCommand(EXPORT_AS_PDF);

    assert.deepStrictEqual(
      extensionApi.readDiagnosticInspection().notifications,
      [extensionApi.getMessage('exportPdf.noTarget.message')],
    );
  });

  it('shows one change-mark notification without asking where to save when the document in front has a change mark', async () => {
    const extensionApi = await api();
    await openWysiwyg(fixtureUri('pdf-export-change-marks.html'));
    extensionApi.clearDiagnosticInspection();

    // The command resolves only once the export has ended, so a save dialog it opened would keep it waiting.
    await vscode.commands.executeCommand(EXPORT_AS_PDF);

    assert.deepStrictEqual(
      extensionApi.readDiagnosticInspection().notifications,
      [extensionApi.getMessage('exportPdf.changeMarks.message')],
    );
  });

  it('writes a file that starts with the PDF header to the chosen location, drawn by the view of a document with an image next to it', async () => {
    const uri = fixtureUri('pdf-export.html');
    await openWysiwyg(uri);

    const written = await (await api()).exportPdfForTest(uri.toString(), destination.toString());
    const header = new TextDecoder('latin1').decode((await vscode.workspace.fs.readFile(destination)).subarray(0, 5));

    assert.deepStrictEqual(
      [written, header, (await api()).readDiagnosticInspection().notifications],
      [true, '%PDF-', []],
    );
  });
});

describe('the links of an exported PDF', () => {
  // A folder below the workspace folder, so the links have to climb out of it to reach the document's neighbours.
  const folder = fixtureUri('pdf-export-out');
  const destination = vscode.Uri.joinPath(folder, 'links.pdf');
  let uris: string[] = [];

  before(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllGroups');
    await vscode.workspace.fs.createDirectory(folder);
    const uri = fixtureUri('pdf-export-links.html');
    await openWysiwyg(uri);
    assert.ok(await (await api()).exportPdfForTest(uri.toString(), destination.toString()), 'the PDF is written');
    const pdf = new TextDecoder('latin1').decode(await vscode.workspace.fs.readFile(destination));
    uris = [...pdf.matchAll(/\/URI \(([^)]*)\)/gu)].map((match) => match[1]);
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllGroups');
    await vscode.workspace.fs.delete(folder, { recursive: true }).then(undefined, () => undefined);
  });

  it('writes a relative link as the path from the folder of the PDF, keeping its fragment', () => {
    assert.ok(uris.includes('../sample.html#relative'), JSON.stringify(uris));
  });

  it('writes a root-relative link as the path from the folder of the PDF to the file in the workspace folder', () => {
    assert.ok(uris.includes('../sample.html#root'), JSON.stringify(uris));
  });

  it('leaves out a link to a file that does not exist', () => {
    assert.deepStrictEqual(uris.filter((uri) => uri.includes('missing')), []);
  });
});
