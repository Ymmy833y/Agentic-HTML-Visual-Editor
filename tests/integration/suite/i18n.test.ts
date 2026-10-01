import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';

interface ExtensionApi {
  getMessage(key: string): string;
}

function findExtension(): vscode.Extension<ExtensionApi> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} is not loaded in VS Code`);
  return extension;
}

function readPackageField(extension: vscode.Extension<ExtensionApi>, field: string): string | undefined {
  const packageJson: unknown = extension.packageJSON;
  if (typeof packageJson !== 'object' || packageJson === null) {
    return undefined;
  }

  // The preceding type check established that this is an object, so read only the
  // required property safely.
  const value = (packageJson as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

describe('UI message resources', () => {
  it('exposes a localizer through the public API after activation', async () => {
    const api = await findExtension().activate();

    assert.strictEqual(typeof api.getMessage, 'function');
  });

  it('returns an unbundled key without throwing', async () => {
    const api = await findExtension().activate();

    assert.strictEqual(api.getMessage('missing.message'), 'missing.message');
  });

  it('reads the bundled English resource as an object from the extension directory', async () => {
    const extension = findExtension();
    const resourceUri = vscode.Uri.joinPath(extension.extensionUri, 'messages', 'messages.en.json');
    const bytes = await vscode.workspace.fs.readFile(resourceUri);
    const resource: unknown = JSON.parse(new TextDecoder().decode(bytes));

    assert.ok(typeof resource === 'object' && resource !== null && !Array.isArray(resource));
  });

  it('resolves the declared display name instead of leaving the key placeholder', () => {
    const displayName = readPackageField(findExtension(), 'displayName');

    assert.ok(displayName !== undefined && !displayName.startsWith('%'), `Display name was not resolved: ${displayName}`);
  });
});
