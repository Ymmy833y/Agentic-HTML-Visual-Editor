// Checks that the extension is loaded and activated on the web extension host
// (VS Code in the browser). Activation is as far as this goes: what has to be proven
// here is that the bundle resolves and runs on a Web Worker. Editor behaviour is
// covered by the integration and e2e layers.
//
// Node.js types are kept out. The web extension host is a Web Worker and cannot
// resolve built-in modules such as node:assert, so assertions are written as throws.
// Nothing but vscode is imported, so the tsc output can be handed over as it is,
// without bundling.
import * as vscode from 'vscode';

// <publisher>.<name> from package.json. An extension loaded into the development host
// carries the same id.
const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';

function findExtension(): vscode.Extension<unknown> {
  // Omitting the type argument would make exports any, so unknown is spelled out.
  const extension = vscode.extensions.getExtension<unknown>(EXTENSION_ID);

  if (extension === undefined) {
    throw new Error(`Extension ${EXTENSION_ID} is not loaded in the web extension host`);
  }
  return extension;
}

// The entry point @vscode/test-web calls. Resolving counts as a pass, rejecting as a failure.
export async function run(): Promise<void> {
  const extension = findExtension();
  await extension.activate();

  if (!extension.isActive) {
    throw new Error(`Extension ${EXTENSION_ID} did not finish activating`);
  }
}
