// A representative test that only confirms the bundled extension is loaded when VS Code is really launched.
// The integration layer verifies the bundle (D-04), so it does not import product sources.
import * as assert from 'node:assert';
import * as vscode from 'vscode';

// The <publisher>.<name> pair from package.json. The extension loaded into the development
// host is given the same id.
const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';

// packageJSON is exposed as an untyped value, so check and read out only the fields we need.
function readPackageField(extension: vscode.Extension<unknown>, field: string): string | undefined {
  const packageJson: unknown = extension.packageJSON;
  if (typeof packageJson !== 'object' || packageJson === null) {
    return undefined;
  }
  // The typeof check just above established that this is an object, so the index access is safely typed.
  const value = (packageJson as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function findExtension(): vscode.Extension<unknown> {
  // Without the type argument the exports would fall back to any, so unknown is spelled out.
  const extension = vscode.extensions.getExtension<unknown>(EXTENSION_ID);
  assert.ok(extension, `extension ${EXTENSION_ID} is not loaded in VS Code`);
  return extension;
}

describe('integration layer startup path', () => {
  it('has the extension loaded in VS Code', () => {
    assert.ok(findExtension());
  });

  it('completes an explicit activation without throwing even though activationEvents is empty', async () => {
    const extension = findExtension();
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
  });

  it('has dist/extension.js as its entry point, so what is verified is the bundle', () => {
    const main = readPackageField(findExtension(), 'main');
    // VS Code can drop the leading ./, so match on the trailing part.
    assert.ok(main !== undefined && main.endsWith('dist/extension.js'), `main differs from what was expected: ${main}`);
  });
});
