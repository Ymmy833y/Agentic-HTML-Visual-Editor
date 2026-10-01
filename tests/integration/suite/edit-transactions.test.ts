import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';
const HTML_EDITOR_VIEW_TYPE = 'ahve.editor';
const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

interface RecordedMessage {
  readonly direction: 'fromView' | 'toView';
  readonly message: unknown;
}

interface ExtensionApi {
  readWebviewInspection(documentUri: string): { readonly messages: readonly RecordedMessage[] } | undefined;
  readDiagnosticInspection(): { readonly notifications: readonly string[]; readonly logLines: readonly string[] };
  clearDiagnosticInspection(): void;
  injectViewMessage(documentUri: string, message: unknown): Promise<boolean>;
  flushEditTransactionsForTest(documentUri: string): Promise<boolean | undefined>;
}

function findExtension(): vscode.Extension<ExtensionApi> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} is not loaded`);
  return extension;
}

async function api(): Promise<ExtensionApi> {
  return findExtension().activate();
}

function fixtureUri(): vscode.Uri {
  return vscode.Uri.joinPath(
    findExtension().extensionUri,
    'tests',
    'integration',
    'fixtures',
    'sample.html',
  );
}

async function waitUntil(condition: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  for (;;) {
    if (await condition()) {
      return;
    }
    assert.ok(Date.now() < deadline, description);
    await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));
  }
}

async function openWysiwyg(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, HTML_EDITOR_VIEW_TYPE);
  await waitUntil(
    async () => ((await api()).readWebviewInspection(uri.toString())?.messages.length ?? 0) >= 2,
    'The initial view message exchange did not complete',
  );
}

function messageType(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const type: unknown = Object.getOwnPropertyDescriptor(value, 'type')?.value;
  return typeof type === 'string' ? type : undefined;
}

function transactionMessage(selection: unknown, afterText = '<p>b</p>'): unknown {
  return {
    type: 'editTransaction',
    transaction: {
      unitId: 'integration-unit',
      before: { text: '<p>a</p>', selection },
      after: { text: afterText, selection },
    },
  };
}

describe('edit transaction integration', () => {
  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    (await api()).clearDiagnosticInspection();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('accepts a valid transaction injected through the real receive path without a diagnostic', async () => {
    const uri = fixtureUri();
    await openWysiwyg(uri);
    (await api()).clearDiagnosticInspection();

    assert.strictEqual(
      await (await api()).injectViewMessage(uri.toString(), transactionMessage(null)),
      true,
    );
    assert.deepStrictEqual((await api()).readDiagnosticInspection().logLines, []);
  });

  it('reports and discards transactions with an invalid selection or identical full document text', async () => {
    const uri = fixtureUri();
    await openWysiwyg(uri);
    (await api()).clearDiagnosticInspection();

    await (await api()).injectViewMessage(uri.toString(), transactionMessage({
      start: { line: 1, column: 0 },
      end: { line: 0, column: 0 },
    }));
    await (await api()).injectViewMessage(uri.toString(), transactionMessage(null, '<p>a</p>'));

    assert.strictEqual((await api()).readDiagnosticInspection().logLines.length, 2);
  });

  it('requests a flush from the real panel and completes with the matching successful result', async () => {
    const uri = fixtureUri();
    await openWysiwyg(uri);

    assert.strictEqual(await (await api()).flushEditTransactionsForTest(uri.toString()), true);
    const messages = (await api()).readWebviewInspection(uri.toString())?.messages ?? [];
    assert.ok(messages.some((recorded) => (
      recorded.direction === 'toView'
      && messageType(recorded.message) === 'requestEditTransactionFlush'
    )));
    assert.ok(messages.some((recorded) => (
      recorded.direction === 'fromView'
      && messageType(recorded.message) === 'editTransactionFlushResult'
    )));
  });
});
